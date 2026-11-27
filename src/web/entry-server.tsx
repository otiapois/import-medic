import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { RECOGNIZED_RULE_IDS } from '../core/index';
import { App } from './App';
import { catalogErrors } from './seo/catalog';
import { validateRoutes } from './seo/routes';
import type { Page } from './seo/routes';

export { LAUNCH_ROUTES, pages, SHOPIFY_PRICE_UPDATE_PATH } from './seo/routes';

export function validateContent() {
  validateRoutes();
  const entries = new Set<string>();
  for (const { code, platform } of catalogErrors) {
    const key = `${platform}:${code}`;
    if (!RECOGNIZED_RULE_IDS.has(code)) throw new Error(`Unrecognized catalog rule ID: ${key}`);
    if (entries.has(key)) throw new Error(`Duplicate catalog rule: ${key}`);
    entries.add(key);
  }
}

function JsonLd({ data }: { data: object }) {
  // Escaping '<' prevents catalog text from closing an inline script element.
  const json = JSON.stringify(data).replaceAll('<', '\\u003c');
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

export function renderPage(page: Page, canonical: string, indexable: boolean) {
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: page.faq.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  };
  const software = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'ImportMedic',
    description: page.description,
    url: canonical,
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'Any',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  };
  return {
    head: renderToStaticMarkup(
      <>
        <title>{page.title}</title>
        <meta name="description" content={page.description} />
        <link rel="canonical" href={canonical} />
        {!indexable && <meta name="robots" content="noindex,follow" />}
        <JsonLd data={faq} />
        <JsonLd data={software} />
      </>,
    ),
    app: renderToString(<App page={page} />),
  };
}
