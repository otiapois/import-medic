# Cross-Platform Catalog Migrator

**Migrate Catalog** in `/shopify-price-update-diff` prepares creation CSVs in each of the six directions between Shopify, WooCommerce, and BigCommerce. Choose distinct platforms and load one product export. It reads the CSV and produces downloads locally in the browser. The labeled demo uses synthetic data. Store import and post-import inspection happen separately in the destination admin.

## Supported catalogs and pricing

| Platform | Source grouping | Target grouping and price fields |
| --- | --- | --- |
| Shopify | `Handle` with `Option1`, `Option2`, and `Option3` name/value pairs | Grouped handles with `Variant SKU`, `Variant Price`, and `Variant Compare At Price` |
| WooCommerce | `simple`, `variable`, and `variation` rows with `Parent` and numbered `Attribute` columns | Parent above its variations. Blank creation `ID` values, `Parent` set to the exact parent SKU, and `Regular price` plus `Sale price` |
| BigCommerce | Modern `Product` and `Variant` rows, or legacy Bulk Edit `Product`, `SKU`, and `Rule` rows | Modern `Product` and `Variant` rows with blank creation `ID` values, `Options`, `Price`, and `Sale Price` |

A Shopify variant with an empty compare-at field carries its selling price as the regular price. A higher compare-at amount is the regular price and the Shopify selling price is the sale price. For the reverse conversion, the lower sale price becomes Shopify `Variant Price` and the regular price becomes `Variant Compare At Price`. The converter preserves exact decimal amounts. Invalid money text, inverted prices, and a sale equal to its regular price hold the CSV. Amounts carry across in the source currency. Verify the currency in both stores before import.

Modern BigCommerce has native variant price and sale fields. The legacy SKU-row `Price` is a reference value. Legacy variant price overrides are in `Rule` rows. The converter can resolve a SKU-linked fixed or flat adjustment with the required base and a consistent reference amount. Ambiguous pricing, conflicting rules, and legacy variant sale values hold the run. The migration target uses the modern importer to carry independent variant prices. [Modern variants](https://support.bigcommerce.com/s/article/Importing-Complex-Attributes?language=en_US) · [Legacy SKU and Rule price handling](https://support.bigcommerce.com/s/article/Updating-via-Import?language=en_US)

## Field and row limits

- Product titles, option combinations, and purchasable SKU text carry across when the destination can represent them. A WooCommerce variable product can need a disclosed parent SKU derived for linking its variations. WooCommerce has no native creation slug field. If the source has no native handle and the target requires one, the converter derives one from the source SKU or title and checks for collisions. Invalid or colliding identities, orphan variants, and unrepresentable option combinations hold the CSV. Shopify accepts up to three option dimensions per product.
- The converter preserves representable whole-number tracked quantities. Shared parent stock that would need to be duplicated across Shopify variants holds the export. BigCommerce requires a consistent product-level or variant-level tracking model. Untracked displayed values can be omitted with a disclosure. Visibility and lifecycle status can have different meanings between stores. Review the disclosed draft or hidden states and any status differences. A separately disabled variation that the destination cannot represent holds the file.
- Physical BigCommerce creation requires an explicit physical or digital type and source weights for physical products and variants. The emitted weight number uses the original unit. Use the same unit in the destination store. WooCommerce weight headers can carry a unit, and Shopify `Variant Grams` carries grams. A BigCommerce source CSV does not declare the store's weight unit. Shopify-bound migration discloses a nonzero weight it cannot convert to exact whole grams.

## Review and downloads

- The field mapping lists every original source column, its destination field where available, and relevant notes. Review `unmappedColumns` before proceeding. A listed field needs separate handling even when the supported fields pass local checks. Examples include custom metadata, images, market-specific pricing, and destination-specific settings when those columns have no mapping.
- Diagnostics record a reason code, the relevant column, and the one-based physical starting line of the original CSV record where applicable. For example, an image-only row can be omitted with a disclosure, whereas a blocking issue holds the target CSV for the whole file. Resolve blocking diagnostics in the source and rerun. The audit and HTML capture the hold and its reasons.
- `migrated-<source>-to-<target>.csv` uses RFC 4180 quoting. The converter holds cells that would require a meaning-changing formula escape, re-parses the target bytes, and checks product and variant parity. Inspect the file in a text editor or open SKU columns as text to preserve leading zeros in spreadsheet software.
- `migration-audit.json` records the source and destination formats, column mapping, unmapped columns, physical-line diagnostics, product/variant counts and parity. Its `custody` records SHA-256 of the exact original CSV, the target CSV when present, and the offline HTML bytes.
- `migration-sign-off.html` is a standalone review copy with escaped data, a restrictive content security policy, and no external resources. Its footer shows the source and available target SHA-256. Verify the HTML bytes against the HTML digest in the separate JSON audit. A held target has no target file or target digest.

## Destination import settings

Review the unmapped columns, destination currency and tax settings, existing SKUs and URLs, and how the destination handles inventory and visibility. Keep the source CSV, generated files, and audit together. Test a small creation batch in a staging store and verify products, options, prices, quantities, and visibility before using the whole file.

| Destination | Creation import settings |
| --- | --- |
| Shopify | Use **Products → Import** with a UTF-8 CSV. Leave the matching-handle overwrite setting off for creation. Verify handles, options, inventory location, and publication choices in the import preview. [Shopify product imports](https://help.shopify.com/en/manual/products/import-export/import-products) |
| WooCommerce | Use the built-in product CSV importer with **Update existing products** off and confirm column mapping. New IDs are assigned by WooCommerce. The blank-ID file can be inspected in **Build Update**. To produce native existing-product update and rollback files, load a fresh export with assigned IDs after creation. [WooCommerce product CSV importer](https://woocommerce.com/document/product-csv-importer-exporter/) |
| BigCommerce | Use **Products → Import** with the modern Product Import/Export experience. Check that the `ID` cells are blank, the store's weight unit matches the source data, and the files contain the required `Type` and physical product `Weight`. BigCommerce recommends creating the base products first and re-exporting before adding variants when staging the import. [Modern creation checklist](https://support.bigcommerce.com/s/article/Importing-Your-Catalog-from-Scratch?language=en_US) · [Modern variant import](https://support.bigcommerce.com/s/article/Importing-Complex-Attributes?language=en_US) |
