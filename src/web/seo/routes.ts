import type { PlatformId } from '../../core/types';
import { catalogErrors } from './catalog';
import type { CatalogError, Faq } from './catalog';

export interface Page {
  path: string;
  platform: PlatformId;
  heading: string;
  title: string;
  description: string;
  examples: readonly CatalogError[];
  faq: readonly Faq[];
}

export const platformPages = [
  {
    path: '/shopify-csv-fixer',
    platform: 'shopify-products',
    label: 'Shopify',
    heading: 'Shopify product CSV fixer',
    description: 'Repair product CSV encoding and headers, normalize variant prices, and review missing titles and duplicate SKUs before importing to Shopify.',
  },
  {
    path: '/quickbooks-csv-fixer',
    platform: 'quickbooks-bank',
    label: 'QuickBooks',
    heading: 'QuickBooks bank CSV fixer',
    description: 'Prepare bank transactions for QuickBooks Online. Resolve date and amount errors and choose a three- or four-column export with a clear audit trail.',
  },
  {
    path: '/stripe-paypal-csv-fixer',
    platform: 'stripe-paypal',
    label: 'Stripe / PayPal',
    heading: 'Stripe and PayPal CSV fixer',
    description: 'Clean Stripe reconciliation and PayPal activity CSVs for accounting or QuickBooks. Review currencies, Net amounts, and PayPal Memo rows.',
  },
] as const satisfies ReadonlyArray<Pick<Page, 'path' | 'platform' | 'heading' | 'description'> & { label: string }>;

// The M1 slug contract is checked against the evidence catalog at build time.
const fixRoutes = {
  'shopify-csv-invalid-utf8': 'shopify-products',
  'shopify-csv-missing-headers': 'shopify-products',
  'shopify-csv-variant-price-sku': 'shopify-products',
  'quickbooks-csv-date-format-error': 'quickbooks-bank',
  'quickbooks-csv-negative-parentheses': 'quickbooks-bank',
  'quickbooks-3-column-vs-4-column': 'quickbooks-bank',
  'stripe-payout-csv-to-quickbooks': 'stripe-paypal',
  'paypal-balance-impact-csv': 'stripe-paypal',
} as const satisfies Record<string, PlatformId>;

const sluggedErrors = catalogErrors.filter((error) => error.slug !== null);
const fixPages = Object.entries(fixRoutes).map(([slug, platform]): Page => {
  const error = sluggedErrors.find((entry) => entry.slug === slug);
  if (!error || error.platform !== platform) {
    throw new Error(`Missing ${platform} catalog evidence for /fix/${slug}`);
  }
  return {
    path: `/fix/${slug}`,
    platform,
    title: `${error.title} | ImportMedic`,
    heading: error.title,
    description: error.symptom,
    examples: [error],
    faq: error.faq,
  };
});

const homeExamples = platformPages.map(({ platform }) => (
  fixPages.find((page) => page.platform === platform)!.examples[0]
));

const homePage: Page = {
  path: '/',
  platform: 'shopify-products',
  title: 'Shopify, QuickBooks, Stripe and PayPal CSV Import Fixer | ImportMedic',
  heading: 'Fix CSV import errors',
  description: 'Repair Shopify product, QuickBooks bank, and Stripe or PayPal CSVs locally. Review changes before you download.',
  examples: homeExamples,
  faq: homeExamples.map((error) => error.faq[0]),
};

export const SHOPIFY_PRICE_UPDATE_PATH = '/shopify-price-update-diff';
export const LAUNCH_ROUTES: readonly string[] = ['/', SHOPIFY_PRICE_UPDATE_PATH];

const priceUpdateExample: CatalogError = {
  code: 'supplier-price-update',
  platform: 'shopify-products',
  title: 'Match a supplier price to an existing Shopify variant',
  symptom: 'A supplier sheet contains a new price for an existing Shopify variant.',
  trigger: 'A synthetic supplier row changes the price for SKU 00123 from 24.00 to 26.00.',
  slug: null,
  before: 'Shopify SKU 00123: 24.00\nSupplier SKU 00123: 26.00',
  after: 'Shopify SKU 00123: 26.00\nOther variants keep their baseline prices.',
  fixMode: 'conditional',
  faq: [
    {
      question: 'How do I compare supplier prices with a Shopify export?',
      answer: 'Open a Shopify Products CSV and a supplier CSV or XLSX. Confirm the matching key and price columns, then review the changes and flagged rows before downloading an update.',
    },
    {
      question: 'Which fields go into the Shopify price update CSV?',
      answer: 'The CSV keeps the original title, handle, variant option names and values, and SKU for each affected product group. It includes the variant price. Compare-at is included when you map a supplier column or enable the automatic rule. Descriptions, tags and image columns are omitted.',
    },
    {
      question: 'Does ImportMedic upload my files or change my store?',
      answer: 'Both files stay in your browser. You download the update and audit files locally, then review and import the update in Shopify yourself.',
    },
  ],
  sources: [{
    title: 'Shopify product CSV columns and overwrite rules',
    url: 'https://help.shopify.com/en/manual/products/import-export/using-csv',
  }],
};

const priceUpdatePage: Page = {
  path: SHOPIFY_PRICE_UPDATE_PATH,
  platform: 'shopify-products',
  title: 'Shopify Supplier Price Update CSV Diff | ImportMedic',
  heading: 'Shopify price update diff',
  description: 'Compare a Shopify product export with a supplier CSV or XLSX. Review price changes and download a scoped variant update CSV and audit in your browser.',
  examples: [priceUpdateExample],
  faq: priceUpdateExample.faq,
};

export const pages: readonly Page[] = [
  homePage,
  ...platformPages.map(({ path, platform, heading, description }) => {
    const examples = catalogErrors.filter((error) => error.platform === platform);
    return {
      path,
      platform,
      heading,
      title: `${heading} | ImportMedic`,
      description,
      examples,
      faq: examples.map((error) => error.faq[0]),
    };
  }),
  ...fixPages,
  priceUpdatePage,
];

export function validateRoutes() {
  const paths = new Set(pages.map(({ path }) => path));
  if (sluggedErrors.length !== fixPages.length || paths.size !== pages.length || paths.size !== 13) {
    throw new Error('Expected 13 unique routes with exactly the eight M1 catalog slugs');
  }
  if (LAUNCH_ROUTES.length < 1 || LAUNCH_ROUTES.length > 5 || new Set(LAUNCH_ROUTES).size !== LAUNCH_ROUTES.length ||
      LAUNCH_ROUTES.some((path) => !paths.has(path))) {
    throw new Error('LAUNCH_ROUTES must contain one to five unique rendered page paths');
  }
  for (const field of ['title', 'description', 'heading'] as const) {
    if (new Set(pages.map((page) => page[field])).size !== pages.length) {
      throw new Error(`Each route must have a unique ${field}`);
    }
  }
  for (const page of pages) {
    if (!page.examples.length || !page.faq.length || new Set(page.faq.map(({ question }) => question)).size !== page.faq.length) {
      throw new Error(`Expected examples and distinct FAQ questions on ${page.path}`);
    }
  }
}

export function getPage(pathname: string): Page {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  return pages.find(({ path }) => path === normalized) ?? homePage;
}
