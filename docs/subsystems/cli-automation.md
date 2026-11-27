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
| `0` | The run completed and passed its local checks. `verify` reports `PASS`. A price diff with no changes can pass without a native pair. | Available mode outputs and `custody-manifest.json` |
| `2` | The run completed with a hold or unsafe result. `verify` reports `FAIL_UNSAFE`. | Diagnostic JSON, `custody-manifest.json`, and a review HTML report where the mode provides one for held runs. CSV outputs are withheld. |
| `1` | Usage, filesystem, or execution error. | Read stderr and treat the run as failed. A completed batch receipt is unavailable. |

A completed explicit batch with exit `0` or `2` writes one JSON line to stdout with `mode`, `status`, `exitCode`, and `outputs`, an array of the output filenames including the manifest. Use `npm run --silent repair-cli -- …` to suppress npm's script banner. `verify` uses `PASS` or `FAIL_UNSAFE`. The other modes use `ready` or `blocked`, with `no-changes` for a valid price diff that would leave the catalog unchanged. A help invocation prints usage text.

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

## verify

Use `--platform <shopify|woocommerce|bigcommerce>`, `--baseline <csv>`, and `--candidate <csv>`. To check a rollback against the update it is meant to reverse, give the rollback as `--candidate` and the update as `--matched-update <csv>`. It writes `verify-report.json` with `PASS` or `FAIL_UNSAFE`, and the batch manifest. [Verify Before Import contract](shopify-price-diff.md#verify-before-import)

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

## Legacy single-file repair

Keep `--mode` absent for the original single-file interface.

```sh
npm run --silent repair-cli -- --platform quickbooks-bank fixtures/quickbooks/amount-parentheses.csv --output repaired.csv --audit repair-audit.json
```

The legacy command uses `--platform`, a positional input, and the original repair options through `--exclude-paypal-memo`. The original `--help` / `-h`, stderr summary, CSV stdout bytes, optional `--output` file, and `--audit` JSON remain compatible. Omitting `--output` streams the verified CSV when available. Pass `--output` when your shell's redirection would re-encode stdout. The `--output` and `--audit` files must be new. The legacy command may write a reviewable CSV and return exit `2` in the same run. Use explicit `--mode repair` to enforce a fail-closed batch and get the custody manifest and sign-off.
