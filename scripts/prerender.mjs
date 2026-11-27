import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = new URL('../dist/', import.meta.url);
const ssr = new URL('../.vite/prerender/entry-server.mjs', import.meta.url);
const siteUrl = new URL(process.env.SITE_URL ?? 'https://importmedic.example');

assert(
  ['http:', 'https:'].includes(siteUrl.protocol) && siteUrl.href === `${siteUrl.origin}/`,
  'SITE_URL must be an HTTP(S) origin without credentials, a path, a query, or a fragment',
);

await build({
  root,
  build: {
    ssr: 'src/web/entry-server.tsx',
    outDir: '.vite/prerender',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'entry-server.mjs' } },
  },
});

const { LAUNCH_ROUTES, pages, renderPage, SHOPIFY_PRICE_UPDATE_PATH, validateContent } = await import(ssr.href);
validateContent();

const template = await readFile(new URL('index.html', dist), 'utf8');
const headSlot = '<!--page-head-->';
const appSlot = '<div id="root"><!--app--></div>';
for (const slot of [headSlot, appSlot]) {
  assert.equal(template.split(slot).length, 2, `Expected one template slot: ${slot}`);
}

const output = pages.map((page) => {
  const canonical = new URL(page.path, siteUrl).href;
  const indexable = LAUNCH_ROUTES.includes(page.path);
  const { head, app } = renderPage(page, canonical, indexable);
  const html = template
    .replace(headSlot, () => head)
    .replace(appSlot, () => `<div id="root" data-route="${page.path}">${app}</div>`);
  verifyPage(html, page, canonical, indexable);
  return { path: page.path, canonical, html, indexable };
});

await Promise.all(output.map(async ({ path, html }) => {
  const directory = path === '/' ? dist : new URL(`.${path}/`, dist);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('index.html', directory), html);
}));

const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...output.filter(({ indexable }) => indexable).map(({ canonical }) => `  <url><loc>${canonical}</loc></url>`),
  '</urlset>',
  '',
].join('\n');
await Promise.all([
  writeFile(new URL('sitemap.xml', dist), sitemap),
  writeFile(new URL('robots.txt', dist), `User-agent: *\nAllow: /\nSitemap: ${new URL('/sitemap.xml', siteUrl).href}\n`),
  copyFile(new URL('../LICENSE', import.meta.url), new URL('LICENSE.txt', dist)),
  copyFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), new URL('THIRD_PARTY_NOTICES.txt', dist)),
]);

console.log(`Prerendered and verified ${output.length} routes for ${siteUrl.origin} (${LAUNCH_ROUTES.length} in sitemap)`);

function verifyPage(html, page, canonical, indexable) {
  const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';
  const body = html.match(/<body>([\s\S]*?)<\/body>/)?.[1] ?? '';
  assert.equal(decodeText(head.match(/<title>([^<]*)<\/title>/)?.[1]), page.title, `${page.path} title`);
  assert.equal(decodeText(head.match(/<meta name="description" content="([^"]*)"/)?.[1]), page.description, `${page.path} description`);
  assert.equal(head.match(/<link rel="canonical" href="([^"]*)"/)?.[1], canonical, `${page.path} canonical`);
  assert.equal(head.match(/<meta name="robots" content="([^"]*)"/)?.[1], indexable ? undefined : 'noindex,follow', `${page.path} robots meta`);
  assert.deepEqual(
    [...body.matchAll(/<h1>([^<]*)<\/h1>/g)].map((match) => decodeText(match[1])),
    [page.heading],
    `${page.path} H1`,
  );
  assert(body.includes(`id="root" data-route="${page.path}"`), `${page.path} hydration route`);
  const fileInputs = [...body.matchAll(/<input\b[^>]*\btype="file"/g)];
  if (page.path === SHOPIFY_PRICE_UPDATE_PATH) {
    assert.equal(fileInputs.length, 2, `${page.path} baseline and supplier file inputs`);
    assert(body.includes('aria-label="Shopify Safe Price Update workbench"'), `${page.path} selected workbench`);
  } else {
    assert.equal(fileInputs.length, 1, `${page.path} static workbench`);
    const activeTabs = [...body.matchAll(/<button\b[^>]*\brole="tab"[^>]*\baria-selected="true"[^>]*>/g)];
    assert(activeTabs.length === 1 && activeTabs[0][0].includes(`-${page.platform}-tab"`), `${page.path} selected platform`);
  }

  const table = body.match(/<table class="site-example-table"[\s\S]*?<\/table>/)?.[0] ?? '';
  assert.deepEqual(
    [...table.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((match) => decodeText(match[1])),
    page.examples.flatMap(({ before, after }) => [before, after]),
    `${page.path} before and after examples`,
  );

  const faq = body.match(/<section class="site-faq"[\s\S]*?<\/section>/)?.[0] ?? '';
  const questions = [...faq.matchAll(/<details><summary>([^<]*)<\/summary><p>([^<]*)<\/p><\/details>/g)]
    .map((match) => ({ question: decodeText(match[1]), answer: decodeText(match[2]) }));
  assert.deepEqual(questions, page.faq, `${page.path} visible FAQ`);

  const schemas = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  assert.equal(schemas.length, 2, `${page.path} JSON-LD count`);
  const byType = new Map(schemas.map((schema) => [schema['@type'], schema]));
  assert.deepEqual(
    byType.get('FAQPage')?.mainEntity,
    questions.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
    `${page.path} FAQPage agrees with visible FAQ`,
  );
  const software = byType.get('SoftwareApplication');
  assert(software?.name === 'ImportMedic' && software.url === canonical && software.description === page.description,
    `${page.path} SoftwareApplication`);
  assert(schemas.every((schema) => schema['@context'] === 'https://schema.org'), `${page.path} JSON-LD context`);
}

function decodeText(text) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'" };
  return text?.replace(/&(amp|lt|gt|quot|#x27);/g, (_, name) => entities[name]);
}
