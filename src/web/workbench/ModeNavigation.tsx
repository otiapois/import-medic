import { SHOPIFY_PRICE_UPDATE_PATH } from '../seo/routes';

export function ModeNavigation({ current }: { current: 'repair' | 'price' }) {
  return (
    <nav className="mode-navigation" aria-label="Workbench mode">
      {current === 'repair' ? <span aria-current="page">CSV Repair</span> : <a href="/shopify-csv-fixer">CSV Repair</a>}
      <a href={SHOPIFY_PRICE_UPDATE_PATH} aria-current={current === 'price' ? 'page' : undefined}>Shopify Safe Price Update</a>
    </nav>
  );
}
