# Local Automation CLI

Run the CLI from an ImportMedic source checkout with the locked dependencies installed. Use Node.js 24 with its bundled npm. Check `node --version` and `npm --version`. On Windows, if an older global npm appears first on `PATH`, use the `npm.cmd` next to the Node.js 24 installation's `node.exe`.

```sh
npm ci --ignore-scripts --cache .vite/npm-cache
npm run --silent repair-cli -- --mode repair --platform xero-bank fixtures/xero-bank/balance-verified.csv --out-dir ./batches/xero-demo
```

The [Node entry point](../../scripts/repair-cli.ts) reads local files and writes the batch outputs. The [CLI dispatcher](../../src/core/cli/) calls the same core engines as the browser. A run needs no browser, store credentials, or network connection. Installing the locked dependencies is a separate step.

## Run and check a batch

Every explicit mode needs `--mode <mode>` and `--out-dir <dir>`. Choose a new or empty output directory for each run. Use regular local paths without symlink or junction components, parent traversals, or network shares. Quote paths containing spaces. Run `npm run repair-cli -- --mode <mode> --help` to list the options for a mode.

| Exit | Meaning | Files |
| --- | --- | --- |
| `0` | The run completed and passed its local checks. `verify` reports `PASS`. A price diff or inventory sync with no changes can pass without a native pair. | Available mode outputs and `custody-manifest.json` |
| `2` | The run completed with a hold or unsafe result. `verify` reports `FAIL_UNSAFE`. | Diagnostic JSON, `custody-manifest.json`, and any mode-specific review HTML or diagnostic CSV. Native and other work product CSVs are withheld. |
| `1` | Usage, filesystem, or execution error. | Read stderr and treat the run as failed. A completed batch receipt is unavailable. |

A completed explicit batch with exit `0` or `2` writes one JSON line to stdout with `mode`, `status`, `exitCode`, and `outputs`, an array of the output filenames including the manifest. Use `npm run --silent repair-cli -- …` to suppress npm's script banner. `verify` uses `PASS` or `FAIL_UNSAFE`. The other modes use `ready` or `blocked`, with `no-changes` for a valid price diff or inventory sync that would leave the relevant quantities or catalog cells unchanged. A help invocation prints usage text.

Options ending in `-b64` accept canonical unpadded base64url of UTF-8 text. They can carry values with shell metacharacters. For example, use `node -p "Buffer.from('Q4 Prices').toString('base64url')"` to encode a worksheet name. For a single value, choose one spelling of the option.

## File custody

`custody-manifest.json` has `version: 1`, `mode`, `exitCode`, `inputs`, and `outputs`. Each file entry has `role`, `filename`, `byteLength`, and `sha256`. The input digest covers the original raw bytes, including an entire XLSX workbook even when only one worksheet is read. It also covers auxiliary files supplied to the run, such as recipes and a BOM. The output digest covers the exact bytes of each file emitted in the batch. The manifest lists filenames without local directory paths and omits its own digest. Held CSVs have no output entries or digests.

Use this unsigned manifest with a trusted copy of the original inputs and outputs to check byte equality. Authenticating who produced or approved the batch requires a separate signature or trusted record. The hashes cover file bytes. The mode audit explains options, field decisions, and local checks. Review that audit and use the store or accounting app for any actual import.

## repair

```sh
npm run --silent repair-cli -- --mode repair --platform xero-bank fixtures/xero-bank/balance-verified.csv --out-dir ./batches/xero-demo
```

Provide one positional CSV path and `--platform <shopify-products|quickbooks-bank|stripe-paypal|xero-bank|freshbooks-expenses>`.

| Flag | Value or use |
| --- | --- |
| `--date-order` | `auto`, `MDY`, or `DMY` |
| `--qbo-layout` | `3col` or `4col` |
| `--qbo-credit-debit` | `auto`, `bank`, or `intuit` |
| `--stripe-paypal-output` | `accounting` or `quickbooks-3col` |
| `--stripe-paypal-fee-convention` | `auto`, `deduction`, or `signed-movement` |
| `--exclude-paypal-memo` | Exclude PayPal rows without balance impact |
| `--formula-guard` | Guard spreadsheet formula-leading cells and recheck the resulting CSV |
| `--generated-at` | Pin the Bookkeeper Sign-Off time to an ISO 8601 UTC timestamp such as `2026-11-28T00:00:00.000Z` |

Output files are `repaired.csv`, `repair-audit.json`, and `bookkeeper-sign-off.html`. Unresolved review items hold `repaired.csv` and retain the audit and sign-off. [Repair engine and running-balance checks](csv-engine.md)

## price-diff

```sh
npm run --silent repair-cli -- --mode price-diff --platform shopify --baseline fixtures/shopify-price-diff/baseline-agency.csv --supplier fixtures/shopify-price-diff/supplier-precision.csv --out-dir ./batches/price-demo
```

Use `--platform <shopify|woocommerce|bigcommerce>`, `--baseline <csv>`, and one to three `--supplier <csv|xlsx>` flags in the intended source order. Supply the options for a slot immediately after its `--supplier`.

| Per-supplier flag | Value or use |
| --- | --- |
| `--sheet` or `--sheet-b64` | Exact visible XLSX worksheet name. An XLSX input requires a name here or in its bound recipe. |
| `--recipe` | Supplier Recipe JSON from the workbench. Use the recipe for this slot and verify the current headers and worksheet. |
| `--label` or `--label-b64` | Supplier display label |

| Batch flag | Value or use |
| --- | --- |
| `--confirm-mapping`, `--confirm-currency`, `--confirm-fx` | Confirm the current mappings, same-currency settings, or saved manual FX rate for the batch after review. A mapping with more than one plausible choice needs a recipe that identifies the exact columns. |
| `--confirm-mapping-supplier`, `--confirm-currency-supplier`, `--confirm-fx-supplier` | Confirm only the specified supplier. Give a one-based slot number from `1` to `3` and repeat the flag for multiple slots. |
| `--conflict-policy` | `block-conflicts`, `prefer-first`, `prefer-last`, `prefer-lowest`, or `prefer-highest`. Preference policies need `--confirm-conflict-policy` for the current batch. |
| `--resolutions-b64` | Base64url-encoded JSON for batch row decisions, keyed by one-based supplier slot and physical supplier CSV line or XLSX row |
| `--bom` | Optional bill-of-materials CSV for base-store kit costs |
| `--bom-pricing-supplier` | With `--bom`, one-based slot whose reviewed pricing rule applies to the kits |
| `--market` or `--market-b64` | Exact Shopify market name |
| `--store-label` or `--store-label-b64` | Display label for the offline sign-off |

For example, `{"1":{"3":{"skip":true}}}` applies a skip to physical line 3 of the first supplier file. Each row decision can include `skip` or `confirm` as a boolean and `price`, `compareAtPrice`, or `inventoryQty` as strings. Check the current row before applying a decision from a prior run.

Saved recipes carry supported settings and mappings. Check a carried FX rate, confirm the current inputs, and resolve any row or supplier conflicts for this batch. Output files are `price-update.csv`, `price-rollback.csv`, `price-audit.json`, and `client-sign-off.html`. Held runs retain diagnostic JSON and the review HTML when available. A valid batch with no changes can complete without the pair. [Price Diff rules, recipes, and BOM](shopify-price-diff.md)

### Amazon price diff

Give `--platform amazon`, `--baseline <csv|tsv|txt>`, and exactly one `--supplier <csv|tsv|txt>` for the proposed changes. The proposal uses the canonical `sku`, `price`, and `quantity` fields. The Amazon path applies the supplied price limits and exact SKU matching directly from the files. Supplier recipes and pricing formulas are for the other catalog platforms. [Amazon flat-file scope](amazon-price-diff.md)

```sh
npm run --silent repair-cli -- --mode price-diff --platform amazon --baseline fixtures/amazon/price-quantity.tsv --supplier fixtures/amazon/proposed.csv --out-dir ./batches/amazon-demo
npm run --silent repair-cli -- --mode verify --platform amazon --baseline fixtures/amazon/price-quantity.tsv --candidate ./batches/amazon-demo/amazon-rollback.tsv --matched-update ./batches/amazon-demo/amazon-update.tsv --out-dir ./batches/amazon-verify
```

Check `price-audit.json` and the custody manifest beside `amazon-update.tsv` and `amazon-rollback.tsv`. The native pair uses the baseline's comma or tab delimiter. A held batch exits `2` and writes the audit and manifest with original source lines. A verified rollback check writes `verify-report.json` and its own manifest. Use fresh output directories for each run.

## verify

Use `--platform <shopify|woocommerce|bigcommerce>`, `--baseline <csv>`, and `--candidate <csv>`. To check a rollback against the update it is meant to reverse, give the rollback as `--candidate` and the update as `--matched-update <csv>`. It writes `verify-report.json` with `PASS` or `FAIL_UNSAFE`, and the batch manifest. [Verify Before Import contract](shopify-price-diff.md#verify-before-import)

For `--platform amazon`, the same flags accept flat files using the baseline's tab or comma delimiter. [Amazon matched rollback example](#amazon-price-diff)

## promo

Use `--platform <shopify|woocommerce|bigcommerce>`, `--baseline <csv>`, `--discount-mode <percent-off|fixed-amount-off>`, `--discount-amount <decimal>`, and `--minimum-retail <decimal>`.

| Flag | Value or use |
| --- | --- |
| `--rounding` | `none`, `ending-99`, `ending-95`, or `nearest-whole` |
| `--preserve-higher-compare-at` | Retain a higher valid original Shopify compare-at value |
| `--sku-prefix` or `--sku-prefix-b64` | Limit the campaign to an exact SKU prefix |
| `--sku` or `--sku-b64` | Limit the campaign to exact SKU text. Repeat for multiple SKUs. Use the prefix or the SKU list. |
| `--handle` or `--handle-b64` | Limit by exact Shopify handle |
| `--tag` or `--tag-b64` | Limit by exact Shopify tag |
| `--skip-line` | Skip a selected physical baseline line. Repeat for multiple lines. |
| `--cost-check` | Check final prices against available cost evidence |
| `--cost-sheet` | Optional separate cost CSV or XLSX with one visible worksheet |
| `--store-label` or `--store-label-b64` | Store display label |

The platform name supplies the default output prefix. A store label supplies a normalized filename prefix. Output filenames are `<store>-promo-launch.csv`, `<store>-promo-revert.csv`, `<store>-promo-audit.json`, and `<store>-promo-sign-off.html`. A hold retains the JSON audit and manifest. [Sale Campaign Pack contract](promo-campaign.md)

## supplier-delta

Use `--previous <csv|xlsx>` and `--next <csv|xlsx>`. For each workbook supply its exact visible worksheet. The remaining options select the worksheet and columns for each side.

| Option | Previous | New |
| --- | --- | --- |
| Worksheet | `--previous-sheet`, `--previous-sheet-b64` | `--next-sheet`, `--next-sheet-b64` |
| SKU column | `--previous-sku-column`, `--previous-sku-column-b64` | `--next-sku-column`, `--next-sku-column-b64` |
| Cost column | `--previous-cost-column`, `--previous-cost-column-b64` | `--next-cost-column`, `--next-cost-column-b64` |
| Inventory column | `--previous-inventory-column`, `--previous-inventory-column-b64` | `--next-inventory-column`, `--next-inventory-column-b64` |

Each column flag accepts an exact case-sensitive header name or a one-based column number. For inventory only, `none` leaves that column unmapped. Use the `-b64` form for a literal header named `none` or a numeric header as well as for other encoded text. Ambiguous column matches and out-of-range positions hold the run. Choose a column or `none` when optional inventory mapping is ambiguous.

Output files are `supplier-delta-report.csv`, `supplier-delta-audit.json`, and `supplier-delta-sign-off.html`. A hold retains the JSON audit and manifest. The report CSV is for supplier review. To prepare a store update, run `price-diff` with a current catalog export. [Supplier Delta contract](supplier-delta.md)

## migrate

Provide one positional CSV path, `--source-platform <shopify|woocommerce|bigcommerce>`, and `--target-platform <shopify|woocommerce|bigcommerce>`. Choose distinct platforms. Output files are `migrated-<source>-to-<target>.csv`, `migration-audit.json`, and `migration-sign-off.html`. Review the source fields that need separate handling in the destination. A hold retains the audit, sign-off, and manifest. [Catalog migration contract](catalog-migrator.md)

## inventory-sync

```sh
npm run --silent repair-cli -- --mode inventory-sync --baseline fixtures/inventory-sync/synthetic-shopify-baseline.csv --supplier fixtures/inventory-sync/synthetic-supplier.csv --sku-column "Supplier SKU" --quantity-column Stock --target-location "Warehouse A" --reserve-units 2 --zero-out-threshold 2 --out-dir ./batches/inventory-demo
```

Give `--baseline <csv>` for the Shopify **All states** export and one to three `--supplier <csv|xlsx>` flags. Provide each slot's worksheet and mapping directly after its `--supplier`. Use the exact case-sensitive worksheet name for XLSX. Each column flag accepts an exact unique header or a one-based index. Use a `-b64` flag for a literal numeric header.

| Per-supplier flag | Value or use |
| --- | --- |
| `--sheet`, `--sheet-b64` | Exact visible worksheet for XLSX |
| `--sku-column`, `--sku-column-b64` | Supplier SKU column |
| `--quantity-column`, `--quantity-column-b64` | Supplier whole-unit stock column |

| Batch flag | Value or use |
| --- | --- |
| `--target-location`, `--target-location-b64` | Exact Shopify location name. Required when the source has multiple locations. |
| `--reserve-units` | Nonnegative whole units to withhold. Defaults to `0`. |
| `--zero-out-threshold` | Supplier stock at or below this whole-unit threshold becomes zero. Defaults to `0`. |
| `--max-cap` | Optional nonnegative whole-unit cap on the final quantity. |
| `--approve-large-drop` | Approve proposed cuts greater than 80% for the current batch after review. |

A ready run writes `inventory-update.csv`, `inventory-rollback.csv`, `inventory-audit.json`, `inventory-sign-off.html`, and `custody-manifest.json`. A `no-changes` run exits `0`. A `blocked` run exits `2`. Both retain the audit, sign-off, and manifest without the native CSVs. [Inventory matching, quantity rules, and Shopify validation](inventory-sync.md)

## cost-creep

```sh
npm run --silent repair-cli -- --mode cost-creep --period fixtures/cost-creep/q1.csv --period-label Q1 --period fixtures/cost-creep/q2.csv --period-label Q2 --period fixtures/cost-creep/q3.csv --period-label Q3 --period fixtures/cost-creep/q4.csv --period-label Q4 --baseline fixtures/cost-creep/store-retail.csv --out-dir ./batches/cost-creep-demo
```

Repeat `--period <csv|xlsx>` two to six times in oldest-to-newest order. After each path supply its `--period-label <label>` and any worksheet or column overrides for that slot. Labels must be unique. Column names are literal headers. Omitting a mapping uses the unique recognized suggestion when available.

| Flag | Value or use |
| --- | --- |
| `--period-label`, `--period-label-b64` | Label shown in the audit and brief |
| `--period-sheet`, `--period-sheet-b64` | Exact visible worksheet name for an XLSX period |
| `--period-sku-column`, `--period-sku-column-b64` | Supplier SKU column |
| `--period-cost-column`, `--period-cost-column-b64` | Supplier cost column |
| `--creep-threshold-percent` | Nonnegative decimal percent. Defaults to `10`. Threshold comparison uses the exact ratio. |
| `--currency` | Three-letter uppercase supplier cost currency declaration |
| `--baseline` | Optional store retail CSV |
| `--baseline-sku-column`, `--baseline-sku-column-b64` | Store baseline SKU column |
| `--baseline-retail-column`, `--baseline-retail-column-b64` | Store baseline retail price column |
| `--baseline-currency` | Three-letter uppercase store retail currency declaration |
| `--workspace-profile` | Optional Workspace Profile JSON for the Vendor Negotiation Brief branding |

Exit `0` writes `supplier-cost-creep.csv`, `supplier-cost-creep-audit.json`, `vendor-negotiation-brief.html`, and `custody-manifest.json`. Exit `2` writes the audit and manifest with source diagnostics. The receipt uses `period-1` through `period-6` for the supplied period slots and records the optional baseline and Workspace Profile when supplied. The history CSV is a supplier review report. [Cost-creep inputs, calculation, and reports](cost-creep.md)

## purchase-order

Give `--baseline <inventory.csv>` and one to three `--supplier <csv|xlsx>` flags in catalog order. Put the optional label and worksheet flags immediately after the supplier they describe.

| Flag | Value or use |
| --- | --- |
| `--supplier-label` or `--supplier-label-b64` | Catalog label. Labels must be unique and default to the filename stem. |
| `--sheet` or `--sheet-b64` | Exact visible worksheet for this XLSX supplier. |
| `--target-location` or `--target-location-b64` | Exact location name. Required when the snapshot lists multiple locations. |
| `--reorder-point`, `--target-stock` | Nonnegative whole-unit defaults where the corresponding inventory row values are blank. |
| `--supplier-policy` | `lowest-landed-cost` (default), `block-ties`, or `prefer-first`. The first two compare exact extended subtotals after quantity rounding and hold lowest-subtotal ties. The last uses catalog order. |
| `--po-reference` or `--po-reference-b64` | Reference for the order pack. |
| `--workspace-profile <profile.json>` | Apply Agency Sign-Off Branding from a saved Workspace Profile. |

Run these synthetic examples in distinct, fresh output directories.

```sh
npm run --silent repair-cli -- --mode purchase-order --baseline fixtures/purchase-order/store-inventory.csv --supplier fixtures/purchase-order/harbor-supply.csv --supplier-label "Harbor Supply" --supplier fixtures/purchase-order/metro-wholesale.csv --supplier-label "Metro Wholesale" --target-location East --po-reference DEMO-22 --out-dir ./batches/po-demo
npm run --silent repair-cli -- --mode purchase-order --baseline fixtures/purchase-order/store-inventory.csv --supplier fixtures/purchase-order/harbor-supply.csv --supplier-label "Harbor Supply" --supplier fixtures/purchase-order/invalid-offers.csv --supplier-label "Metro Wholesale" --target-location East --out-dir ./batches/po-hold
```

The first command exits `0`. East has 3 units of SKU `00123` available, exactly at its reorder point. Harbor Supply wins at 12 units × 2.00 = 24.00 USD. Metro Wholesale's 1.50 unit cost requires an order of 20 units for 30.00 USD. SKU `00007` goes to Metro Wholesale at 8 units × 3.25 = 26.00 USD. Check both supplier CSVs, the consolidated rows, and the audit's 20 units and 5000 cents. Open `purchase-order-pack.html` locally and check `DEMO-22` and both supplier groups. Hash the actual output bytes and compare with the audit and manifest.

The second command exits `2`. Check physical line 2 of `invalid-offers.csv` for the invalid case pack. The directory contains `po-audit.json` and `custody-manifest.json` only. [Reorder calculation and file custody](purchase-order.md)

## categorize

Give one positional transaction CSV and a `--rules <rules.json>` rule pack. Use a fresh `--out-dir` for each batch.

| Flag | Value or use |
| --- | --- |
| `--rules <rules.json>` | Required version 1 rule pack. Rule order sets priority. |
| `--currency <ISO>` | Confirm the source's two-decimal currency when the input lacks a currency column. Plain amounts without a confirmed currency stay in a separate unspecified group. |
| `--credit-debit-convention` | Required only for split Debit and Credit columns. `bank` makes Debit negative. `intuit` makes Credit negative. |
| `--workspace-profile <profile.json>` | Apply saved Agency Sign-Off Branding in the offline HTML. |

```sh
npm run --silent repair-cli -- --mode categorize fixtures/m23/transactions.csv --rules fixtures/m23/rules.json --out-dir ./batches/categorize-demo
npm run --silent repair-cli -- --mode categorize fixtures/m23/transactions.csv --rules fixtures/m23/conflict-rules.json --out-dir ./batches/categorize-hold
```

The first command exits `0` and writes `categorized-transactions.csv`, `account-summary.csv`, `categorization-audit.json`, `bookkeeper-categorization-sign-off.html`, and `custody-manifest.json`. Check four categorized rows out of five. At physical lines 2 and 3, the synthetic 20% and 5% rules split gross −120.00 GBP and −105.00 AED into net −100.00 each and tax −20.00 GBP and −5.00 AED. The 12.00 GBP refund at line 4 splits into 10.00 net and 2.00 tax. Keep the currency totals separate.

The second command exits `2`. Check physical line 2 for the conflicting rule IDs `aws-uk` and `aws-overlap`. The directory contains only `categorization-audit.json` and `custody-manifest.json`. [Inputs, split arithmetic, and review files](categorization.md)

## wholesale-sheet

Give `--platform <shopify|woocommerce|bigcommerce>`, `--baseline <catalog.csv>`, and `--options <options.json>`. The options file sets the seller label, effective date, currency, tier definitions, exact existing Shopify catalog title, and selected Shopify tier. It can set a minimum gross margin and require MAP on every SKU.

| Flag | Value or use |
| --- | --- |
| `--cost-sheet <csv|xlsx>` | Additional cost, MAP, case pack, and MOQ values by SKU. |
| `--cost-sheet-tab` or `--cost-sheet-tab-b64` | Exact visible worksheet for the XLSX cost sheet. |
| `--workspace-profile <profile.json>` | Apply saved Agency Sign-Off Branding to the buyer HTML. |

Run these commands in distinct, fresh output directories.

```sh
npm run --silent repair-cli -- --mode wholesale-sheet --platform shopify --baseline fixtures/m24/wholesale-shopify.csv --options fixtures/m24/wholesale-options.json --cost-sheet fixtures/m24/wholesale-costs.csv --out-dir ./batches/wholesale-demo
npm run --silent repair-cli -- --mode wholesale-sheet --platform shopify --baseline fixtures/m24/wholesale-shopify.csv --options fixtures/m24/wholesale-options.json --cost-sheet fixtures/m24/wholesale-map-hold.csv --out-dir ./batches/wholesale-hold
```

The first command exits `0`. Check SKU `00007` for Bronze, Silver, and Gold unit prices of `39.96`, `34.97`, and `29.97` USD and minimum order quantities of `12`, `54`, and `102`. The Shopify CSV addresses `Northstar Wholesale Silver` and carries the Silver price `34.97` and quantity fields `6` and `54` for this SKU. Review the buyer files against the public field list. Compare the catalog, cost sheet, and four export hashes against the internal audit. Check the CLI manifest for every file, including the exact options JSON and audit hashes.

The second command exits `2`. The `35.00` MAP for `00007` holds Silver and Gold. Check the physical line 2 evidence and confirm the directory contains only `wholesale-margin-audit.json` and `custody-manifest.json`. [Tier rules, buyer fields, and Shopify review](wholesale-pricelist.md)

## catalog-hygiene

Give `--platform <shopify|woocommerce|bigcommerce>` and `--source <catalog.csv>`. For BigCommerce, supply a legacy Bulk Edit product CSV. Use a fresh `--out-dir` for each run.

| Flag | Value or use |
| --- | --- |
| `--second <catalog.csv>` | Optional second native catalog to include in the same collision check |
| `--second-platform <shopify|woocommerce|bigcommerce>` | Platform for `--second`. Defaults to the primary platform. This flag requires a second catalog. |
| `--trim-skus` | Trim outer SKU whitespace where the projected SKU remains safe |
| `--strip-zero-width` | Remove allowlisted U+200B and U+FEFF from eligible identifiers |
| `--workspace-profile <profile.json>` | Apply saved Agency Sign-Off Branding in the offline HTML |

```sh
npm run --silent repair-cli -- --mode catalog-hygiene --platform shopify --source fixtures/m25/shopify-ready.csv --trim-skus --strip-zero-width --out-dir ./batches/hygiene-demo
npm run --silent repair-cli -- --mode catalog-hygiene --platform shopify --source fixtures/m25/shopify-hold.csv --out-dir ./batches/hygiene-hold
npm run --silent repair-cli -- --mode catalog-hygiene --platform shopify --source fixtures/m25/shopify-ready.csv --second fixtures/m25/woocommerce-second.csv --second-platform woocommerce --trim-skus --strip-zero-width --out-dir ./batches/hygiene-cross-file
```

The first command exits `0`. In source 1's cleaned CSV, compare line 2's SKU `AURORA-01` and UPC-A `012345678905` with the source. Verify the source 1 rollback is byte-identical to the original CSV. The second command exits `2`. Line 2 carries `4006381333932`, with supplied check digit `2` and expected `1`. Compare the case-variant SKU at lines 2 and 5 and the barcode collision at lines 5 and 6. The third command exits `2`. Review the SKU collision at physical line 2 in each input.

Each completed run writes `catalog-hygiene-issues.csv`, `catalog-hygiene-audit.json`, `catalog-hygiene-report.html`, and `custody-manifest.json`. Ready runs add `catalog-hygiene-source-<N>-cleaned.csv` and `catalog-hygiene-source-<N>-rollback.csv` for the available sources. On exit `2`, confirm that both kinds of native catalog files are withheld for every source. Check the manifest's input roles `source`, `second` and `workspace-profile` for the files supplied, its diagnostic roles `issues-csv`, `audit-json`, and `report-html`, and its ready output roles `source-<N>-cleaned-csv` and `source-<N>-rollback-csv`. [Catalog checks and file contract](catalog-hygiene.md)

## Legacy single-file repair

Keep `--mode` absent for the original single-file interface.

```sh
npm run --silent repair-cli -- --platform quickbooks-bank fixtures/quickbooks/amount-parentheses.csv --output repaired.csv --audit repair-audit.json
```

The legacy command uses `--platform`, a positional input, and the original repair options through `--exclude-paypal-memo`. The original `--help` / `-h`, stderr summary, CSV stdout bytes, optional `--output` file, and `--audit` JSON remain compatible. Omitting `--output` streams the verified CSV when available. Pass `--output` when your shell's redirection would re-encode stdout. The `--output` and `--audit` files must be new. The legacy command may write a reviewable CSV and return exit `2` in the same run. Use explicit `--mode repair` to enforce a fail-closed batch and get the custody manifest and sign-off.
