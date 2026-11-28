# Catalog & Barcode Hygiene

Open **Verify Update / Rollback CSV > Catalog & Barcode Hygiene** in Price Update Studio at `/shopify-price-update-diff`. Choose one native product CSV or add a second CSV to check for collisions across the two files. The files can use different supported platforms. The workbench audits them in the browser. The CLI reads and writes local files. Keep the resulting catalogs separate and review any import in the store's admin.

## Supported catalog fields

| Source | Required columns | Optional barcode column |
| --- | --- | --- |
| Shopify product CSV | `URL handle`, `Title`, `SKU`, `Price` or their corresponding legacy `Handle`, `Title`, `Variant SKU`, `Variant Price` headers | Current `Barcodes` or legacy `Barcode` or `Variant Barcode`. Use one barcode column. [Shopify product CSV fields](https://help.shopify.com/en/manual/products/import-export/using-csv) |
| WooCommerce built-in product CSV | `Type`, `SKU`, `Regular price` | `GTIN, UPC, EAN, or ISBN` or `Global Unique ID`. [WooCommerce product CSV importer and exporter](https://woocommerce.com/document/product-csv-importer-exporter/) |
| BigCommerce legacy Bulk Edit | `Item Type`, `Product ID`, `Product Name`, `Product Code/SKU` (or `Product SKU`), `Price` | `Product UPC/EAN`. BigCommerce support covers the legacy Product, SKU, and Rule layout. [BigCommerce legacy product updates](https://support.bigcommerce.com/s/article/Updating-via-Import?language=en_US) |

For Shopify `Barcodes`, the audit interprets up to 20 entries separated by semicolons, optional type prefixes such as `gtin:`, `ean:`, and `upc:`, and the native escapes for literal backslash, semicolon, and colon. Shopify treats untyped entries in the plural column as Custom. The audit also checks untyped entries made up of ASCII digits at supported GS1 lengths. It preserves alphanumeric custom codes and other out-of-scope types and reports the scope as a warning. [Shopify CSV barcode syntax](https://help.shopify.com/en/manual/products/import-export/using-csv) · [Shopify barcode types](https://help.shopify.com/en/manual/products/details/barcodes)

Shopify image-only continuations can have an empty price. WooCommerce variable and grouped parent rows can omit a price. A WooCommerce variation carries a parent SKU or `id:ID`. BigCommerce legacy SKU rows can carry a displayed price. The auditor keeps legacy Rule rows with their original Product group and treats the SKU on a Rule row as a reference. Review any price overrides in the store. [BigCommerce legacy SKU and Rule fields](https://support.bigcommerce.com/s/article/Updating-via-Import?language=en_US)

## Barcode and SKU checks

EAN-8 (GTIN-8), UPC-A (GTIN-12), EAN-13 (GTIN-13), and GTIN-14 are checked as exact ASCII digit strings. Starting at the rightmost payload digit, GS1 Mod 10 multiplies alternate digits by 3 and 1. The difference between the weighted sum and the next equal or higher multiple of ten is the expected check digit. The audit compares it with the supplied digit. Preserve leading zeros in text editors, spreadsheet import settings, and the native files. A checksum pass establishes the structure of the identifier. Check its assignment, licensee, and product identity separately with GS1. [GS1 General Specifications §7.9](https://ref.gs1.org/standards/genspecs/23.0.0/) · [Verified by GS1](https://support.gs1.org/support/solutions/articles/43000734070/)

Barcode checks apply to the supported numeric forms in the singular and native GTIN fields and the applicable Shopify list entries. UPC-E, ISBN-10, ASIN, and NS-PID remain outside the Mod 10 check. The audit checks valid GTINs shared by distinct SKUs, including equivalent strings with extra leading zeros. The original digits remain in the catalog and diagnostics. For SKUs it compares exact text and case variants, including collisions exposed by surrounding whitespace or allowlisted zero-width characters. These comparisons cover both sources even when cleanup is off.

**Trim outer SKU whitespace** and **Remove allowlisted zero-width characters** are off by default. An isolated outer Unicode space separator prompts a warning. U+200B and U+FEFF in identifiers hold until safely removed in eligible SKU or in-scope barcode text. Cleanup holds if it would affect a WooCommerce `Parent`, `Grouped products`, `Upsells`, or `Cross-sells` reference, or a BigCommerce legacy Rule SKU link. The audit checks references within the supplied catalogs of the same platform. Scientific notation requires recovery from the original catalog. Barcode digits, SKUs with unresolved collisions, and nonpositive retail prices require operator review. The audit preserves catalog records for that review.

## Finding codes

| Finding | Blocking codes |
| --- | --- |
| SKU conflicts and unsafe changes | `duplicate-sku-exact`, `duplicate-sku-case`, `duplicate-sku-cleanup`, `referenced-sku-cleanup`, `empty-sku` |
| Barcode format, check digit, or reuse | `invalid-barcode-list`, `invalid-gtin-format`, `invalid-gtin-check-digit`, `duplicate-gtin` |
| Damaged identifier or cell | `scientific-sku`, `scientific-barcode`, `embedded-control`, `spreadsheet-formula` |
| Retail price | `invalid-retail-price`, `zero-retail-price`, `negative-retail-price` |
| CSV and headers | `invalid-encoding`, `missing-header`, `invalid-header`, `duplicate-header`, `missing-column`, `ambiguous-barcode-column`, `invalid-csv`, `row-width`, `missing-products` |
| Native catalog grouping | `invalid-handle`, `noncontiguous-handle`, `missing-title`, `invalid-woo-type`, `missing-woo-parent`, `unexpected-woo-parent`, `invalid-woo-parent`, `missing-bigcommerce-name`, `invalid-bigcommerce-group`, `invalid-bigcommerce-type` |
| Cleaned catalog validation | `catalog-roundtrip-failed` |

`outer-sku-whitespace`, `barcode-outside-gs1-scope`, and `unverified-woo-parent` are warnings. `trim-sku` and `strip-zero-width` record applied changes on a ready run and proposed changes on a held run. A hold keeps those findings at warning level and suppresses every cleaned and rollback file.

## Evidence and files

The pure core entry point [`auditCatalogHygiene(sources, options)`](../../src/core/catalog-hygiene/engine.ts) takes an ordered array of one or two `{ platform, filename, bytes }` sources. `bytes` is a `Uint8Array`. Options include `trimSkus`, `stripZeroWidth`, `branding`, and the optional `workspaceProfile` file bytes for CLI custody. The asynchronous result provides `READY` or `HOLD`, counts, source fingerprints, issues, and artifact bytes. Issues carry `code`, `level` (`blocked`, `warning`, or `fixed`), `sourceIndex`, and the relevant physical line, column, and value. Lines are one-based record starts and count line breaks inside quoted cells. A related line can refer to either source. The primary source is `1` and the optional second source is `2`.

| File | When available | Contents |
| --- | --- | --- |
| `catalog-hygiene-issues.csv` | Ready or held | RFC 4180 issue rows with formula-like text guarded for spreadsheet review |
| `catalog-hygiene-audit.json` | Ready or held | Options, counts, issues, original source fingerprints, and SHA-256 for the other emitted artifacts |
| `catalog-hygiene-report.html` | Ready or held | Offline sign-off with issue evidence, file fingerprints, and the current Agency Sign-Off Branding. The HTML escapes values, has a restrictive content security policy, and carries no scripts or external assets. Compare its digest with the separate audit. |
| `catalog-hygiene-source-<N>-cleaned.csv` | Ready | One native catalog per input, with approved cleanup applied and other catalog cell values preserved |
| `catalog-hygiene-source-<N>-rollback.csv` | Ready | Exact original bytes for that input, including its encoding, original quoting, line endings, and leading zeros |
| `custody-manifest.json` | CLI ready or held | SHA-256 and byte size for each exact CLI input and emitted file, including the JSON audit |

A blocking issue withholds the cleaned CSV and rollback for every source. The audit retains the physical lines and the relevant supplied and expected check digits. When a source passes, compare the rollback with the original file before editing or resaving either one. Keep the rollback as a local copy of the source. Recovery of a live store depends on the platform's importer, current catalog identity, and import settings. [CLI options and examples](cli-automation.md#catalog-hygiene)
