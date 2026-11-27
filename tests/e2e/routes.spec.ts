import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { assertFits, test } from './browser';

const shopify = 'Shopify Products';
const quickbooks = 'QuickBooks Bank';
const stripe = 'Stripe / PayPal';
const pricePath = '/shopify-price-update-diff';
const launch = ['/', pricePath];
const routes = [
  ['/', shopify],
  ['/shopify-csv-fixer', shopify],
  ['/quickbooks-csv-fixer', quickbooks],
  ['/stripe-paypal-csv-fixer', stripe],
  ['/fix/shopify-csv-invalid-utf8', shopify],
  ['/fix/shopify-csv-missing-headers', shopify],
  ['/fix/shopify-csv-variant-price-sku', shopify],
  ['/fix/quickbooks-csv-date-format-error', quickbooks],
  ['/fix/quickbooks-csv-negative-parentheses', quickbooks],
  ['/fix/quickbooks-3-column-vs-4-column', quickbooks],
  ['/fix/stripe-payout-csv-to-quickbooks', stripe],
  ['/fix/paypal-balance-impact-csv', stripe],
];

test('all 12 direct URLs serve independent, complete static pages and hydrate the right workbench', async ({ page }) => {
  const titles = new Set<string>();
  const descriptions = new Set<string>();
  const canonicals: string[] = [];
  for (const [path, tab] of routes) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    const html = await response!.text();
    const ssr = await page.evaluate((text) => {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      return {
        route: doc.getElementById('root')?.dataset.route,
        heading: doc.querySelector('h1')?.textContent,
        title: doc.title,
        description: doc.querySelector<HTMLMetaElement>('meta[name=description]')?.content ?? '',
        canonical: doc.querySelector<HTMLLinkElement>('link[rel=canonical]')?.href ?? '',
        robots: doc.querySelector<HTMLMetaElement>('meta[name=robots]')?.content ?? null,
        selected: doc.querySelector('[role=tab][aria-selected=true]')?.textContent,
        examples: doc.querySelectorAll('table tbody code').length,
        faqCount: doc.querySelectorAll('.site-faq summary').length,
        schemas: [...doc.querySelectorAll('script[type="application/ld+json"]')].map((node) => JSON.parse(node.textContent!)),
      };
    }, html);
    expect(ssr.route, path).toBe(path);
    expect(ssr.selected).toBe(tab);
    expect(ssr.title).toMatch(/ImportMedic/);
    expect(ssr.description.length).toBeGreaterThan(0);
    expect(new URL(ssr.canonical).pathname).toBe(path);
    expect(ssr.robots, path).toBe(launch.includes(path) ? null : 'noindex,follow');
    expect(ssr.examples).toBeGreaterThanOrEqual(2);
    expect(ssr.faqCount).toBeGreaterThan(0);
    expect(ssr.schemas).toHaveLength(2);
    expect(ssr.schemas).toContainEqual(expect.objectContaining({ '@type': 'SoftwareApplication' }));
    const faq = ssr.schemas.find((schema) => schema['@type'] === 'FAQPage');
    expect(faq.mainEntity).toHaveLength(ssr.faqCount);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(ssr.heading!);
    await expect(page.getByRole('tab', { name: tab, selected: true })).toBeVisible();
    await assertFits(page);
    titles.add(ssr.title);
    descriptions.add(ssr.description);
    canonicals.push(ssr.canonical);
  }
  expect(titles.size).toBe(12);
  expect(descriptions.size).toBe(12);
  expect(new Set(canonicals).size).toBe(12);
  for (const suffix of ['?source=qa', '/?source=qa']) {
    const response = await page.goto('/quickbooks-csv-fixer' + suffix);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('tab', { name: quickbooks, selected: true })).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', canonicals[2]);
  }
  const sitemap = await page.request.get('/sitemap.xml');
  expect(sitemap.ok()).toBe(true);
  const urls = await page.evaluate((xml) => [...new DOMParser().parseFromString(xml, 'application/xml')
    .querySelectorAll('loc')].map((element) => element.textContent), await sitemap.text());
  expect(urls.sort()).toEqual(launch.map((path) => new URL(path, canonicals[0]).href).sort());
  const robots = await page.request.get('/robots.txt');
  expect(robots.ok()).toBe(true);
  expect(await robots.text()).toContain('Sitemap: ' + new URL('/sitemap.xml', canonicals[0]).href);
});

test('the launch price page serves its own HTML, metadata and production headers before hydration', async ({ page, browser }, info) => {
  expect(info.project.use.channel).toBe('msedge');
  const response = await page.goto(pricePath, { waitUntil: 'networkidle' });
  expect(response?.status()).toBe(200);
  expect(new URL(response!.url()).pathname).toBe(pricePath);
  const headers = response!.headers();
  const source = await readFile('public/_headers', 'utf8');
  expect(await readFile('dist/_headers', 'utf8')).toBe(source);
  const [pattern, ...rules] = source.trimEnd().split(/\r?\n/);
  expect(pattern).toBe('/*');
  for (const rule of rules) {
    const separator = rule.indexOf(':');
    expect(headers[rule.slice(0, separator).trim().toLowerCase()]).toBe(rule.slice(separator + 1).trim());
  }
  expect(headers['content-security-policy'].split('; ')).toContain("connect-src 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(await page.evaluate(() => navigator.userAgent)).toMatch(/Edg\/\d+/);
  info.annotations.push({ type: 'Microsoft Edge version', description: browser.version() });
  const raw = await page.evaluate((html) => {
    const document = new DOMParser().parseFromString(html, 'text/html');
    return {
      route: document.querySelector<HTMLElement>('#root')?.dataset.route,
      title: document.title,
      heading: document.querySelector('h1')?.textContent,
      description: document.querySelector('meta[name="description"]')?.getAttribute('content'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      robots: document.querySelector('meta[name=robots]')?.getAttribute('content') ?? null,
      fileInputs: document.querySelectorAll('input[type=file]').length,
      questions: [...document.querySelectorAll('.site-faq summary')].map((node) => node.textContent),
      schemas: [...document.querySelectorAll('script[type="application/ld+json"]')].map((node) => JSON.parse(node.textContent!)),
    };
  }, await response!.text());
  expect(raw).toMatchObject({
    route: pricePath, title: 'Shopify Supplier Price Update CSV Diff | ImportMedic',
    heading: 'Shopify price update diff', fileInputs: 2, robots: null,
  });
  expect(raw.description).toMatch(/supplier CSV or XLSX/);
  expect(new URL(raw.canonical!).pathname).toBe(pricePath);
  expect(raw.schemas).toHaveLength(2);
  expect(raw.schemas).toContainEqual(expect.objectContaining({ '@type': 'SoftwareApplication', url: raw.canonical }));
  expect(raw.questions.length).toBeGreaterThan(0);
  const faq = raw.schemas.find((schema) => schema['@type'] === 'FAQPage');
  expect(faq.mainEntity.map((entry: { name: string }) => entry.name)).toEqual(raw.questions);
  await expect(page.getByRole('navigation', { name: 'Workbench mode' }).getByRole('link', { name: 'Shopify Safe Price Update' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(raw.heading!);
});

