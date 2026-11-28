# Sale Campaign Pack

[`buildPromoCampaign`](../../src/core/promo-campaign/engine.ts) takes a platform, the original bytes of one catalog CSV, and campaign options. The campaign uses the uploaded store's own price fields. An optional cost sheet supplies review data. Work stays in the browser.

Choose **Sale Campaign Pack > Retail Promo Pack** to use this workflow. The adjacent **Wholesale B2B Line-Sheet** builds separate tier prices and buyer documents. [Wholesale pricing and file contract](wholesale-pricelist.md)

## Scope and calculation

- With no filters, the campaign considers priced rows. A case-sensitive SKU prefix or exact SKU list narrows the scope. Shopify can also narrow by product handle and product tag. When several filters are supplied, a row must match all of them.
- `percent-off` applies the entered `1%` through `90%` to the starting price. `fixed-amount-off` subtracts a positive store-currency amount with up to two decimal places. Shopify uses the pre-sale variant price. WooCommerce and BigCommerce use an existing lower sale price when present and the regular price otherwise.
- Rounding uses the shared exact-decimal rules. Cent rounding uses half-up, `.95` and `.99` round up to the requested ending, and whole-unit rounding uses half-up. With `20%` off `25.00`, `.99` rounding turns `20.00` into `20.99`. That price passes a `20.99` floor and is held for a `21.00` floor. A nonpositive result, a price below the mandatory positive floor, or a rounded result at or above the starting price holds the pair until the row is skipped or the rule is corrected. The floor never raises the computed price.
- The optional cost check uses recorded baseline costs or exact SKU matches from a separate CSV or a single-sheet XLSX cost file. A final promo price below a known cost is a review warning. The minimum retail floor remains an export requirement.

## Native CSV scope

The baseline must contain the original compare-at or sale column. Both files limit writes to the fields below. The revert preserves the exact original cell text, including decimal precision and any supported explicit blanks.

| Platform | Required identity in the pair | Writable price fields and revert behavior |
| --- | --- | --- |
| Shopify base store | Original `Handle`, `Title`, option names and values, and `Variant SKU` for every row in each affected product group. Unchanged variants keep their original cells. | `Variant Price` and `Variant Compare At Price`. Launch sets compare-at to the original variant price, with an option to retain a strictly higher valid original compare-at. An included blank compare-at in the revert clears that field with matching-handle overwrite. |
| WooCommerce | Original `ID`, `Type`, `SKU`, and `Parent` for affected existing simple products and variations. Rows with an exported sale start or end date are held because the existing schedule can affect the promo price. | `Sale price`. The regular price stays in the store. An included blank sale price in the revert clears that field in the built-in update importer. |
| Legacy BigCommerce Bulk Edit | Original `Item Type`, `Product ID`, `Product Name`, and the exported `Product Code/SKU` or `Product SKU` heading and cells. Eligible rows are standalone `Product` rows. | `Sale Price`. The regular `Price` stays in the store. With **Ignore blank values during import** enabled, a blank would leave the imported sale in place, so a blank original sale holds the row. Both files use numeric sale values on affected rows. |

The pair omits stock, Shopify Markets prices, WooCommerce sale dates, and product content such as descriptions, tags, images, and metadata. Shopify keeps the exact required title and option fields for matching-handle imports. BigCommerce SKU and Rule rows and grouped products are outside the supported campaign scope. Keep **Ignore blank values during import** enabled for legacy BigCommerce. Disabling it can clear mapped fields with blank values. [Shopify overwrite rules](https://help.shopify.com/en/manual/products/import-export/using-csv#overwriting-product-details-using-an-import-csv-file) · [WooCommerce update importer](https://woocommerce.com/document/product-csv-importer-exporter/#update-existing-products) · [WooCommerce importer source](https://github.com/woocommerce/woocommerce/blob/trunk/plugins/woocommerce/includes/import/abstract-wc-product-importer.php) · [BigCommerce legacy updates](https://support.bigcommerce.com/s/article/Updating-via-Import?language=en_US) · [BigCommerce import options](https://support.bigcommerce.com/s/article/Importing-Your-First-Product?language=en_US)

## Replay and custody

The engine re-parses the actual `<store>-promo-launch.csv` and `<store>-promo-revert.csv` bytes, checks the permitted writes, and replays them against the original snapshot. The full catalog matrix must return to the original cells. The browser shows the SHA-256 of the source and verified native files and includes them in the JSON audit and `<store>-promo-sign-off.html`. The offline sign-off shows the average discount, total catalog price reduction, and floor or cost warnings. Its inline Content Security Policy blocks scripts and external connections.

In **Verify Update / Rollback CSV**, inspect the launch as the update and the revert as its rollback. Use **Load last generated pair** or supply the actual launch under **Check a rollback with its matching update**. A baseline-only candidate comparison covers the cells carried by that file. The matched-file replay checks that the revert reverses the actual launch and leaves zero residual differences across the baseline. Users schedule and perform both imports in the store's admin. A fresh catalog check before each import accounts for edits since the source export or the matched launch. [Inspector contract](shopify-price-diff.md#verify-before-import)
