# ImportMedic

ImportMedic compares a Shopify, WooCommerce, or legacy BigCommerce product export with one to three supplier CSV or XLSX files in your browser. Use supplier prices directly or calculate retail prices from wholesale costs, with optional manual currency conversion, cost brackets, and stock updates where supported. Attach a bundle bill of materials to recalculate kit costs when component prices change. Review proposed changes and competing offers before downloading matched update and rollback CSVs, audits, or a standalone Client Sign-Off HTML report. Save supplier mappings and store defaults as separate JSON files. A separate workbench repairs Shopify Products, QuickBooks Online Bank, Stripe or PayPal, Xero bank statement, and FreshBooks expense CSVs and offers a printable Bookkeeper Sign-Off HTML report.

**Verify Before Import** inspects an existing update or rollback CSV against the original Shopify, WooCommerce, or legacy BigCommerce export. It checks product identity and grouping, shows exact changes in the allowed price or stock cells, and fingerprints both files in the browser. Store checks and imports take place in the store's admin.

**Sale Campaign Pack** prepares a discount and its matched revert from one product export. It previews the final sale prices against a required minimum retail floor and packages the pair with a JSON audit and offline Campaign Sign-Off report.

**Supplier Delta** compares two supplier pricebooks or tracks cost creep across two to six periods. Review hikes, drops, and SKU availability. In the multi-period view, add store retail data to check gross margin changes and download a Vendor Negotiation Brief for offline review.

**Migrate Catalog** converts a supported product CSV between Shopify, WooCommerce, and BigCommerce. Review parent and variant rows, pricing, source fields that need separate handling, and the file fingerprints before downloading a creation CSV for the destination platform.

**Inventory Sync** prepares an on-hand update for one Shopify location from an **All states** inventory export and supplier stock sheets. Review the reserve, low-stock threshold, and optional cap before downloading the update, matched rollback, and offline sign-off.

## Run locally

Use Node.js 24 and its bundled npm.

Run `node --version` and `npm --version` first. If your shell finds an older npm on `PATH`, use the npm from your Node.js 24 installation.

```sh
npm ci --ignore-scripts --cache .vite/npm-cache
npm run build
npm run preview -- --port 4173 --strictPort
```

Open the price update workbench and choose **Load Synthetic Agency Demo** for a Shopify direct-price example. To compare your own files, choose the platform and select a fresh product export and a supplier CSV or XLSX. Use **+ Add another supplier sheet** for a second or third file. **Build Update** and single-file repair run in local Web Workers with progress and **Cancel**. [Local price update workbench](http://127.0.0.1:4173/shopify-price-update-diff)

### Verify an update or rollback before import

1. Open **Verify Update / Rollback CSV** in the price workbench, choose the matching catalog platform, then add the original export and the candidate CSV. You can inspect files someone else prepared without rebuilding the batch.
2. Read **PASS** or **FAIL_UNSAFE**, compare both SHA-256 fingerprints with the files you received, and review each changed SKU and its exact before-and-after values. Check the allowed native columns, product or variation identities, and group rules. A change from `20.00` to `20.000` still changes the cell text.
3. If you generated the pair in the current workbench batch, choose **Load last generated pair** and verify the update and rollback in their respective tabs. For a saved pair, choose the rollback as the candidate and add the update under **Check a rollback with its matching update**. ImportMedic applies the actual update, applies the rollback, and compares the full result with the original catalog data.

With a baseline and candidate alone, zero residual differences means the supplied scoped cells agree with the original values. To verify that a rollback covers and reverses a particular update, use the actual matched update. Check the intended values and the current catalog before importing either file. Store login and live changes happen in the store's admin.

Open **Shortcuts (?)** or press `?` outside text entry. Press `/` to focus workbench search when available. Use `Escape` to close the dialog or cancel an active edit and return to its trigger. The dialog has a switch to turn off single-character shortcuts.

### Prepare a sale and its revert

1. Open **Sale Campaign Pack**, choose the catalog platform, and select a fresh product CSV or **Load Synthetic Promo Demo**. Use all priced rows or scope the campaign by SKU prefix or exact SKU list. Shopify also supports product handle and tag filters.
2. Set a **Percent off** from `1` to `90` or a **Fixed amount off** in store currency, then select rounding and enter a positive **Minimum retail floor**. Shopify starts with the current variant price. WooCommerce and BigCommerce start with a lower existing sale price when present, or the regular price otherwise. ImportMedic applies the discount and rounds before checking the floor. A result below the floor, at or under zero, or at or above the starting price holds the pair. Change the settings or skip the affected row. The optional cost check flags a promo price below recorded cost for review.
3. Review the before, promo, and revert cells. Shopify updates base variant price and compare-at price while preserving original titles, handles, options, SKUs, and sibling rows. WooCommerce updates `Sale price` while leaving `Regular price` in place. Legacy BigCommerce updates `Sale Price` on standalone `Product` rows with an original numeric sale price. The legacy **Ignore blank values during import** setting prevents an empty sale cell from clearing a price during revert, so a row with a blank original sale is held. [Native fields and exact clear behavior](docs/subsystems/promo-campaign.md#native-csv-scope)
4. Keep the Promo Launch and Promo End Revert downloads with the original CSV, JSON audit, and Campaign Sign-Off HTML. Compare SHA-256 values against the actual downloaded files. In **Verify Update / Rollback CSV**, replay the actual launch followed by its matched revert to check that every original catalog cell is recovered locally.

Schedule and import the files manually in the store's admin. Confirm the current prices and identities against the baseline before launch and against the matched launch before reverting. [Sale Campaign Pack contract](docs/subsystems/promo-campaign.md)

### Prepare a Shopify inventory update for one location

1. Open **Inventory Sync** in Price Update Studio and choose **Load Synthetic Multi-Location Demo**, or export a fresh **All states** inventory CSV in Shopify under **Products > Inventory**. Add up to three supplier CSV or XLSX stock sheets. For each workbook choose the intended visible worksheet, then select the SKU and quantity columns. [Shopify inventory export and import](https://help.shopify.com/en/manual/inventory-and-locations/setup/inventory-csv)
2. Choose **Target Location**. Set **Safety reserve units** and **Zero-out threshold**, and optionally set **Max cap (optional)**. A supplier quantity at or below the threshold becomes zero. Otherwise the reserve is subtracted, with zero as the floor, then the cap limits the result. Review each SKU's on-hand change, withheld units, and status. Resolve any holds before downloading the pair.
3. Download **Inventory Update CSV**, **Inventory Rollback CSV**, **Inventory Audit JSON**, and **Inventory Sign-Off (.html)**. The native files cover changed variants at the selected location. The update expects the original on-hand quantity and sets the proposed quantity. The rollback expects that proposed quantity and restores the original quantity text. Keep the pair with the source export and compare the SHA-256 values before resaving the files. [Inventory Sync contract](docs/subsystems/inventory-sync.md)
4. Use **Products > Inventory > Import** for an approved update. ImportMedic prepares and checks files against the uploaded snapshot. Shopify compares the expected quantity with current stock during import and rejects affected rows when they differ. Review Shopify's import result before using a matched rollback, and use a fresh export to reconcile any intervening stock movement. [Shopify import validation](https://help.shopify.com/en/manual/inventory-and-locations/setup/inventory-csv)

### Review Shopify prices and download the matched files

1. Check the join key and price mapping. For wholesale input, open **Pricing formula & rounding** and choose a multiplier, percentage markup, or target gross margin. You can add a minimum retail price. For a cross-currency batch, enable **Convert supplier currency (manual rate)** and enter the source code, store code, and exact positive decimal rate as store currency per unit of source currency. ImportMedic applies that rate before the retail formula and rounding, entirely in the browser. Conflicting currency evidence prevents export until resolved.
2. To update compare-at prices, map a supplier compare-at column or leave it unmapped and choose **Calculate compare-at price automatically**. Mapped amounts use the manual rate and round half up to cents when currency conversion is on. The automatic rule multiplies the final retail price and uses the same rounding setting. In a synthetic example, `10.00 EUR` at `1.0850` USD per EUR with a `2.2` retail multiplier and `.99` rounding yields `23.99 USD`. A `1.25` compare-at multiplier yields `29.99 USD`.
3. Confirm the columns and pricing settings, including the rate or store currency when prompted. Search by SKU or handle and review the supplier amount, computed retail price, and flagged rows. Enter manual overrides as final store-currency amounts. An opted-in compare-at amount must be strictly higher than the final retail price after rounding. Resolve the row or skip it before downloading. Shopify specifies a higher compare-at price for displaying a sale. [Shopify sale pricing](https://help.shopify.com/en/manual/products/details/product-pricing/sale-pricing)
4. Select **Download Safe Shopify Update CSV** and **Download Shopify Rollback CSV**, then download the CSV or JSON audit and the offline **Download Client Sign-Off (.html)** report as needed. The audit records any applied currency pair and exact rate. Keep the matched files with the source export. Both carry the original title, handle, options, and SKUs for complete affected product groups. The rollback preserves original price text and any included compare-at and inventory cells, including explicit blanks. To update compare-at, use a baseline with that column. Unrelated columns such as description, tags, and images are omitted. [Shopify product CSV requirements and overwrite rules](https://help.shopify.com/en/manual/products/import-export/using-csv#overwriting-product-details-using-an-import-csv-file)

ImportMedic re-parses both downloads and replays the update followed by its matched rollback against the uploaded snapshot in the browser. For a Shopify admin import, check the destination store, current titles, handles, option names and values, prices, and any included quantities against the relevant snapshot. Pause if anything has changed. Use the rollback only for its matched update after checking for later catalog edits and stock movement. The Shopify import and overwrite confirmation are manual steps.

Each XLSX supplier slot starts with the workbook's first visible worksheet. If there are multiple visible tabs, open **Supplier worksheet** beside that supplier's filename and select the intended tab. Check the new headers and suggested mapping before confirming. An explicit selection binds that slot to the exact worksheet name independently of the other slots. Store XLSX SKUs as text to preserve leading zeros. Numeric and scientific-notation SKU cells, formulas in mapped key, price or quantity cells, and duplicate keys within a sheet require review. ImportMedic warns about formulas with missing cached values and never evaluates workbook formulas.

### Reprice bundles and kits

1. In **Build Update**, choose a platform, load a fresh catalog export and supplier cost sheet, and attach a **Bundle BOM sheet** for base store pricing. Use CSV or an XLSX file with one visible worksheet. Include `Bundle SKU`, `Component SKU`, `Quantity`, and optional `Assembly Cost`. Use exact SKUs and keep leading-zero Excel SKUs as text. Quantities must be positive whole numbers. Enter the assembly cost once per kit or repeat the same value across its component rows.
2. Confirm the supplier cost mapping and a cost-based retail rule, such as a multiplier. The rollup uses validated supplier costs and shows any fallback to an explicit baseline cost. A component found only in the supplier sheet can contribute its verified cost and remains unmatched for the native update. Each kit needs its own eligible catalog row. The BOM assembly costs and baseline component costs are in store currency. Any supplier conversion uses the existing confirmed manual FX settings.
3. Review **Bundle Cost Rollup** for each kit's old cost, new cost, components, and projected margin. Circular references, missing or unpriced components, invalid inputs, and nesting beyond five kit levels hold the native pair. Correct the source using the reported lines and rebuild. A proposed price below the rolled-up cost also holds the pair. Review the confirmed pricing rule and any sale price.
4. Download the verified native update and rollback for the selected platform, then check both in **Verify Update / Rollback CSV**. Keep the JSON audit and offline Client Sign-Off with the catalog, supplier, BOM, and CSV files. Compare the BOM and available file digests with the original and downloaded bytes. The replay checks exact recovery of the uploaded catalog cells. [Bundle BOM contract](docs/subsystems/shopify-price-diff.md#bundle-and-kit-cost-rollup)

Choose **Load Synthetic Kit BOM Demo** to try a nested example. Leaving the BOM field empty uses the regular supplier comparison.

### Compare two supplier pricebooks

1. Open **Supplier Delta** and choose **2-Sheet Delta** in the price workbench. Add the previous and new CSV or XLSX pricebooks, or choose **Load Synthetic Supplier Delta Demo**. For multi-tab Excel files, set **Previous worksheet** and **New worksheet** as needed.
2. Check each SKU and cost or price mapping. Map inventory on either side if needed. Compare amounts in the same currency. Review the signed changes and use **Cost Hikes**, **Cost Drops**, **Added**, **Removed**, and **Blocked** to inspect matching rows and source lines.
3. If duplicate SKUs or invalid mapped cells hold the CSV and sign-off, inspect the issue rows and download the JSON audit for review. Correct the files or mapping and compare again.
4. Keep **Supplier Delta CSV**, **JSON Audit**, and **Delta Sign-Off (.html)** with the original pricebooks. The HTML shows the top hikes and includes filters that work offline. Its footer records the source and CSV SHA-256 digests. The JSON audit records those digests and the SHA-256 of the actual downloaded HTML bytes. An XLSX input digest covers the whole original workbook. [Supplier Delta contract](docs/subsystems/supplier-delta.md)

### Track supplier cost creep across periods

1. In **Supplier Delta**, choose **Multi-Period Cost Creep (2–6 sheets)** and **Load Synthetic 4-Quarter Cost-Creep Demo**, or add two to six supplier CSV or XLSX files in oldest-to-newest order. Enter a unique label per slot and check each worksheet, SKU column, and cost column. Keep SKUs with leading zeros in Excel text cells.
2. Set **Cumulative creep threshold (%)**, which starts at `10`. The watchlist applies the inclusive threshold before rounding percentages for display. Review missing periods and consecutive hikes alongside the first and latest observed costs. For a margin comparison, add **Store Baseline CSV** with an exact SKU and a positive retail price in the same known currency as the supplier costs. Use **Cost currency** and **Baseline retail currency** for confirmed denominations. Both margins use the same supplied retail price.
3. Keep **Cost-Creep CSV**, **Audit JSON**, and **Vendor Negotiation Brief (.html)** with the original files. Open the brief locally to review the ranked hikes and charts. It uses the current Agency Sign-Off Branding and displays input and history CSV hashes. Verify the exact HTML bytes against the separate JSON audit. A held comparison retains the audit with the affected period and source row. The history CSV is for supplier review. Use **Build Update** with a fresh catalog export to prepare a store update. [Cost-creep contract and file custody](docs/subsystems/cost-creep.md)

### Prepare a catalog migration

1. Open **Migrate Catalog** in the price update workbench. Set **Source platform** and **Target platform**, then use **Choose source catalog CSV** or **Load Synthetic Multi-Variant Demo**. Check the **Target catalog preview**. Keep leading-zero SKUs as text when inspecting the files.
2. Read **Field Mapping & Unmapped Disclosure** and resolve blocking issues using their physical CSV lines. A Shopify variant priced at `20.00` with a compare-at price of `28.00` becomes a regular price of `28.00` and a sale price of `20.00` in WooCommerce or modern BigCommerce. BigCommerce creation files use modern `Product` and `Variant` rows. WooCommerce creation files leave IDs blank for the destination to assign.
3. Keep the original CSV with **Target Import CSV**, **Migration Audit JSON**, and **Migration Sign-Off (.html)**. Compare SHA-256 for the original and both generated files with **Migration file custody** and the JSON audit. The HTML footer records the source and target CSV hashes. Check the HTML itself against the separate JSON audit. For a held run, use the JSON audit and HTML to review the issues.
4. Review the destination's creation import settings and test a small batch in a staging store before authorizing a live import. Compare the resulting products, variants, prices, stock, and visibility with the reviewed file. The browser check covers the uploaded and generated bytes. [Supported formats, held runs, and destination settings](docs/subsystems/catalog-migrator.md)

### Update prices for one Shopify market

Use a Shopify product export containing `Price / <Market>`. In **Target price list**, choose that exact market. Enter final prices in the market's currency. If converting supplier currency, enter and confirm your own rate in market-currency units per one supplier-currency unit. The browser applies it before formulas, cost brackets, and rounding. Check the selected scope and applied rate in the review and audit. [Shopify international CSV columns](https://help.shopify.com/en/manual/products/import-export/using-csv#international-csv-columns)

The matched files carry the selected `Price / <Market>`, the same market's `Compare At Price / <Market>` if enabled, and the original identity fields and variant siblings for affected products. The base price, other markets, market inclusion, stock, and product content are omitted. Any retained or proposed fixed compare-at price must be above the final market price. Rows that need to turn a blank market value into a fixed amount require review. The rollback carries the exact original cell text. The paired replay checks the uploaded snapshot. Before either manual import, verify the exact market, currency, and affected groups in Shopify. Check current values against the matched update before applying its rollback. [Shopify overwrite rules](https://help.shopify.com/en/manual/products/import-export/using-csv#overwriting-product-details-using-an-import-csv-file)

### Price by cost bracket

Select **Tiered cost brackets** in **Pricing formula & rounding**. Add two to six tiers with strictly increasing positive upper limits and a final open-ended tier. Each tier uses a multiplier or percentage markup and can add a fixed fee in store currency. The rule matches on the exact cost after manual FX, before markup, floor, or rounding. A cost of `20.00` matches an upper limit of `20.00`, while `20.01` uses the next tier. With `2.5×` and `2.0×` in those tiers, **End in .99** gives `50.99` and `40.99` respectively. Check the matched tier in the diff, CSV and JSON audits, and Client Sign-Off HTML.

### Update existing WooCommerce products

Choose **WooCommerce** and try **Load Synthetic WooCommerce Demo**, or use a fresh export from the destination store. Match by exact SKU text. The native files carry changed simple products and variations with their original `ID`, `Type`, `SKU`, and `Parent`, plus `Regular price` and any enabled `Sale price` or `Stock` fields. The baseline needs a `Sale price` column when lowering regular prices and numeric tracked stock for rows included in a stock update. Attributes, descriptions, categories, tags, images, and metadata are omitted. Download both files together and inspect the variation IDs and parent references, prices, and included stock. [WooCommerce product CSV schema](https://woocommerce.com/document/product-csv-importer-exporter/#product-csv-import-schema)

The browser verifies both files against the uploaded snapshot. Use the pair with WooCommerce's built-in **Update existing products** importer in the same store after checking the current product identities and affected values. For rollback, compare the current values with the matched update and check for later price edits or stock movements first. [WooCommerce update instructions](https://woocommerce.com/document/product-csv-importer-exporter/#update-existing-products)

### Update existing BigCommerce products

Choose **BigCommerce** and **Load Synthetic BigCommerce Demo**, or use a fresh legacy Bulk Edit product export. Match by exact SKU text. The native files preserve `Item Type`, `Product ID`, `Product Name`, and the original `Product Code/SKU` or `Product SKU` heading. Standalone `Product` rows can carry `Price` and optional `Sale Price`. Eligible `Product` or `SKU` rows can carry mapped stock when the export confirms the corresponding tracking mode. The workbench holds grouped parent pricing because a change could flow through to variants. The legacy import treats SKU-row `Price` as read-only. [BigCommerce legacy product updates](https://support.bigcommerce.com/s/article/Updating-via-Import?language=en_US) · [Legacy export field names](https://support.bigcommerce.com/s/article/Legacy-to-Modern-Product-Transfer?language=en_US)

Download the matched files and inspect both in **Verify Update / Rollback CSV**. Read the original IDs and relationships with the proposed price and stock values. The files omit product descriptions, categories, images, and metadata. Review the current catalog values and the legacy importer mapping in your store before each manual import. Compare the current catalog with the matched update and check for later price edits or stock movement before rollback. [BigCommerce native CSV scope](docs/subsystems/bigcommerce-price-diff.md)

### Review batch impact and margins

After a catalog comparison, check **Batch Impact & Margin Summary** for price moves, average and range of gross margins, and the change in comparable stock when quantity is mapped. Margin uses a known landed supplier cost and the effective retail price, including a WooCommerce sale price when present. Select **Zero / Negative Margin Alert** to show affected SKUs in the diff. The offline Client Sign-Off HTML includes the batch summary for review before import.

The onscreen price-change column shows a sign and up to two decimal places. Calculations and the six-decimal audit values keep their existing precision.

Expand **Interactive Margin What-If** in the completed **Build Update** review. Compare **Current Rule** with **+5% Markup**, **FX +3% Buffer**, **.95 Rounding**, or a custom scenario. FX scenarios use the rate confirmed for the batch. Review the average margin, negative-margin SKU count, and total retail impact. Use **Apply Scenario** for an eligible result, then review the updated comparison and download the verified pair. The retail impact sums price changes across the affected catalog rows. [Scenario calculations and review rules](docs/subsystems/shopify-price-diff.md#margin-what-if-simulator)

### Resolve competing supplier offers

Check the mapping for each sheet and use the supplier label to identify each source in review. **Block conflicts** is the default. The comparison shows competing suppliers, their original row numbers, and raw values for an affected SKU while it holds the native pair. To resolve competing prices, select and confirm **Prefer lowest price**, **Prefer highest price**, **Prefer first supplier**, or **Prefer last supplier**. First and last follow the visible supplier order. Low and high compare supplier prices in the same currency before pricing adjustments. Review the selected source in the diff, the CSV or JSON audit, and the Client Sign-Off report. Correct unresolved inputs or skip the affected row before exporting.

### Update inventory quantity

**Inventory qty column (optional)** starts at **Leave unchanged**. For a single-location store, map a supplier stock column and use a fresh product CSV with **Inventory quantity** or **Variant Inventory Qty** as the baseline. Enter a nonnegative whole number. Blank, fractional, negative, or formula-derived quantities require correction or an explicit skip. A drop greater than **Maximum stock drop (%)**, 80% by default, or a drop from positive stock to zero needs review. Confirm a valid proposed quantity, override it, or skip the row. [Shopify product CSV reference](https://help.shopify.com/en/manual/products/import-export/using-csv)

When any supplier has stock mapped, both native CSVs include **Variant Inventory Qty** for complete affected product groups. The rollback keeps the original quantity text. The update preserves original values for unchanged siblings and variants whose selected supplier has no stock mapping. For stores with multiple locations, use [Inventory Sync](#prepare-a-shopify-inventory-update-for-one-location) with a Shopify inventory CSV.

### Reuse a supplier mapping

Once the columns are confirmed, enter a supplier label and select **Save Supplier Recipe (.json)**. A recipe holds the supplier's column names, price thresholds, and formula guard setting. Explicitly choosing a worksheet saves its exact name in a v6 recipe. Versions 1–5 still load. They support direct pricing, other pricing adjustments, manual FX or automatic compare-at, optional inventory or supplier conflict settings, and tiered pricing according to their version.

For the next batch, choose fresh files, select **Load Supplier Recipe (.json)** for the supplier, and verify the mapped fields before selecting **Confirm columns**. Remap any missing header or worksheet. Verify or replace a carried FX rate and confirm it again. Confirm a carried preference or store currency when prompted. Row overrides, skips, and confirmations apply to one batch.

### Carry store defaults to another session

Open **Workspace profile** and set the store name and currency. Select **Save Workspace Profile (.json)** to carry those settings, the platform, and the first supplier's guardrails and tiered pricing defaults. To reuse them, select the matching platform and choose **Load Workspace Profile (.json)**. Review the defaults before confirming the new batch. Keep a separate supplier recipe when you also need to reuse a mapping. Workspace settings stay in memory during the session and the downloaded JSON is the portable copy.

### Brand an offline sign-off

Open **Workspace profile** and expand **Agency Sign-Off Branding**. Enter **Agency name** and choose Forest, Navy, Slate, or Burgundy. Use **Prepared for** and **Contact email or note** if needed. Check the preview before downloading a Client, Campaign, Supplier Delta, Migration, or Inventory Sign-Off or a Vendor Negotiation Brief from the price workbench. The report includes the supplied branding as text and opens offline.

Save the Workspace Profile JSON to reuse the branding after navigating away. In the home workbench, complete a repair and open **Agency Sign-Off Branding** by the Bookkeeper export. Set the branding there or use **Load Workspace Profile (.json)** to bring in the same branding before downloading the Bookkeeper Sign-Off. [Branding and Workspace Profile contract](docs/subsystems/web-ui-seo.md#agency-sign-off-branding)

### Guard spreadsheet formulas

**Guard spreadsheet formulas (=, +, -, @)** is optional in most single-file repairs and always applied for Xero bank CSVs. The guard prefixes an apostrophe to formula-like text in the exported cells, preserves signed decimal values such as `-12.50`, and records each changed cell in the audit. The Shopify price workbench blocks the native pair if guarding would change a value carried into it. The audit remains available.

### Prepare Xero bank statements and FreshBooks expenses

On the home workbench, choose **Xero Bank CSV** for a single bank account's statement. Confirm the source **Date format** if a date such as `04/05/2026` could mean two different days. ImportMedic writes `YYYY/MM/DD` in `*Date` and puts incoming and outgoing transactions in the signed `*Amount` column. Use Xero's bank statement import screen to review the mapping, optional details, and date format. Source running balances are used in the local check and left out of the import CSV. [Xero bank statement CSV guidance](https://central.xero.com/0/article/Import-a-CSV-bank-statement)

Choose **FreshBooks CSV** for an expense file with one explicit currency and amounts of the same sign. Check that all rows describe expenses. FreshBooks' expense importer can omit positive amounts in a mixed-sign file, so ImportMedic holds that file for review. In FreshBooks, map `Vendor` to Merchant, `Notes` to Description, and match Date, Category, and Amount directly. Select the file's currency and year-first date format. The file retains the recorded tax fields for review. Apply taxes using the FreshBooks expense editor where needed. Signed transactions for Bank Reconciliation use a separate FreshBooks import flow. [FreshBooks expense imports](https://support.freshbooks.com/hc/en-us/articles/360001651111-How-do-I-import-expenses-from-a-file) · [FreshBooks Bank Reconciliation](https://support.freshbooks.com/hc/en-us/articles/6787282269325-How-do-I-add-edit-or-delete-manual-transactions-in-bank-reconciliation)

### Check a running bank balance

When a QuickBooks or Xero bank source has `Balance` or `Running Balance`, open **Running-Balance Chain Audit**. ImportMedic checks adjacent rows in exact minor units, such as cents for USD, and interprets same-day rows in the detected statement direction. Confirm the source date order and amount directions before relying on the check. A balance break or a chain the workbench cannot verify holds the CSV. Review the physical source lines and re-export the original statement or correct a confirmed transcription error. A line break inside a quoted description counts toward the file's physical line numbers.

The check measures consistency between the rows supplied. The opening balance is derived from the first transaction in time. Confirm the statement period and account balances against the bank, since omitted transactions outside the supplied range or gaps that cancel to zero can pass the arithmetic check. [Running-balance contract](docs/subsystems/csv-engine.md#running-balance-chain)

### Prepare a bookkeeper sign-off

Open the home workbench, select the platform, and repair the CSV. For a Stripe or PayPal reconciliation mismatch, review Gross, Fee, Net, and the expected Net on the original source line. Correct the source or re-export it from the provider before retrying. If you reopen a generic accounting CSV with confirmed PayPal signed fees, select the PayPal option under **Fee convention**. If multiple currencies prevent a QuickBooks bank export, use the counts and physical lines in **Mixed currencies block QuickBooks export** to locate transactions in the source. Prepare a separate input for each currency and check it again before using the bank layout.

Use **Download Bookkeeper Sign-Off (.html)** to open or print the standalone report locally, including for a held CSV. It records the current repair state, source and platform, automatic and manual edit counts, physical CSV lines, exclusions, and totals by verified currency where available. Reconciliation mismatches, currency groups, and running-balance results appear when applicable. Keep the current report with its source file and JSON audit. When the CSV is held, the report carries the original file fingerprint only.

### Verify file fingerprints

Use **SHA-256 file fingerprints** in the price workbench to compare the baseline, supplier files, optional BOM, and available update and rollback CSVs with the JSON audit or Client Sign-Off HTML. An explicit XLSX worksheet selection is recorded alongside the original whole-workbook fingerprint. The single-file repair shows the source and available repaired CSV fingerprints with the same values in its JSON audit and Bookkeeper Sign-Off HTML. Hash the original files and the downloads before resaving them in a spreadsheet editor. A digest match verifies that the file bytes match the recorded fingerprint. Keep the audit or report with the files it references.

## Run a local batch from the command line

From the source checkout with its locked dependencies installed, use `npm run --silent repair-cli` for a batch on your machine or in your own CI environment. The CLI reads and writes files on the filesystem and makes no network requests. Installation uses npm separately.

```sh
npm run --silent repair-cli -- --mode repair --platform xero-bank fixtures/xero-bank/balance-verified.csv --out-dir ./batches/xero-demo
```

Use a separate output directory for each run. All eight explicit modes write `custody-manifest.json` alongside their available results.

| Mode | Use it to prepare |
| --- | --- |
| `repair` | A repaired CSV, JSON audit, and offline Bookkeeper Sign-Off |
| `price-diff` | A matched catalog update and rollback, JSON audit, and offline Client Sign-Off |
| `verify` | A JSON inspection of a candidate CSV against its baseline, with optional matched rollback replay |
| `promo` | Matched sale launch and revert CSVs, JSON audit, and offline campaign sign-off |
| `supplier-delta` | A supplier review CSV, JSON audit, and offline delta sign-off |
| `migrate` | A creation CSV, JSON audit, and offline migration sign-off |
| `inventory-sync` | A Shopify inventory update and matched rollback for one location, JSON audit, and offline Inventory Sign-Off |
| `cost-creep` | A multi-period supplier history CSV, JSON audit, and offline Vendor Negotiation Brief |

Exit `0` means the local run passed. Exit `2` means the run held the CSV or rejected the candidate and left diagnostic files. Exit `1` means an argument, input/output, or execution error. The unsigned manifest lists the SHA-256 of the original input bytes and each emitted result. Keep it with the originals and outputs to check for byte changes.

Pass a saved Supplier Recipe JSON to `price-diff` with its supplier file. Review the current mapping, worksheet, and any currency or conflict settings before confirming them for this batch. For earlier single-file scripts, omitting `--mode` preserves `--platform`, the CSV stream on stdout or `--output`, and the optional `--audit` JSON. [CLI commands, options, and exit codes](docs/subsystems/cli-automation.md)

## Verify local processing

1. In the browser's Network panel, select the page document and check for `connect-src 'none'`, `worker-src 'self'`, and `form-action 'none'` in its Content Security Policy. Preview serves the policy from the same `_headers` file included in the release build.
2. Clear the Network panel and use the synthetic demo. Review the diff and download the update, rollback, audit, and Client Sign-Off report. A first run can load a bundled worker or other static asset from the site origin. Check that these are static asset requests and that no file data leaves the browser. Open the sign-off file locally for offline review.
3. Open both native CSVs in a text editor. Compare the affected variants and options with the baseline, final prices and any quantities with the audit, and the rollback's original cell text with the source export. For compare-at or inventory updates, inspect restored blanks where present. For a cross-currency run, check the applied rate and final currency in the audit.

## Screenshots

M2 screenshots of the price update workbench with a synthetic Shopify export and supplier workbook.

![Scoped Shopify price update on desktop](docs/reports/screenshots/m2/desktop-shopify-diff.png)

[Flagged 60% price drop](docs/reports/screenshots/m2/desktop-shopify-flagged.png) · [Mobile price diff](docs/reports/screenshots/m2/mobile-shopify-diff.png)

The single-file repair workbench in a local desktop browser run with synthetic data.

![Shopify CSV repair diff on desktop](docs/reports/screenshots/desktop-shopify-diff.png)

[Mobile repair screenshot](docs/reports/screenshots/mobile-diff.png)

## Architecture

```mermaid
flowchart LR
  A[Local catalog CSV, supplier sheets, and optional bundle BOM] --> B[React workbench]
  B --> C[Supplier merge and diff in local Web Worker]
  C --> D[Matched native CSV pair, audits, and offline sign-off]
  E[Local CSV] --> F[Repair workbench]
  F --> G[Repair engine in local Web Worker]
  G --> H[Repaired CSV, audits, and offline bookkeeper sign-off]
  I[Original catalog CSV and candidate CSV] --> J[Verify Before Import]
  J --> K[Safety checks, exact cell changes, and fingerprints]
  L[One local catalog CSV and campaign settings] --> M[Sale Campaign Pack]
  M --> N[Matched launch and revert, audit, and offline sign-off]
  O[One local catalog CSV] --> P[Migrate Catalog]
  P --> Q[Target creation CSV, migration audit, and offline sign-off]
```

Vite bundles and prerenders 13 pages. The browser reads file bytes and builds downloads in memory. React provides the workbench, Papa Parse handles CSV, and fflate with fast-xml-parser reads XLSX worksheet data. [Subsystem contracts](docs/subsystems/README.md)

## Build and checks

```sh
npm run typecheck
npm test
npm run test:fuzz
npm run build
npm run test:e2e
```

GitHub CI installs the locked dependencies and runs type checking, unit tests, seeded fuzz tests, and the build on pushes and pull requests. It also exports the committed public source and typechecks from that directory. The browser suite runs against the local production preview with installed Microsoft Edge. Use `npm run dev` for development.

For Cloudflare Pages, build into `dist/` with `SITE_URL` set to the approved HTTPS origin. The build default `https://importmedic.example` is for local use. [`LAUNCH_ROUTES`](src/web/seo/routes.ts) lists the two initial indexable URLs, `/` and `/shopify-price-update-diff`. The other 11 pages remain directly accessible with `noindex,follow`.

To prepare a source snapshot from a Git checkout, use `npm run export:public -- <targetDir>` with a new or empty destination. The exporter verifies committed `HEAD` files, including production source with names such as `local-settings.ts`. Its public path allowlist keeps research, internal tasks, logs, and scratch material out of the snapshot. Keep the exclusion tokens `local`, `draft`, `scratch`, `temp`, `tmp`, `backup`, `cache`, `research`, `internal`, `private`, `secret`, and `secrets` out of new public fixture filenames. Run `npm run typecheck` from the exported directory with the release dependencies. Release changes are listed in the [changelog](CHANGELOG.md).

## License

[MIT](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
