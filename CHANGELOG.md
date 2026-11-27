# Changelog

## v1.2.0 (M12)

- Open **Sale Campaign Pack** in the price workbench and use one catalog CSV to preview a percentage or fixed-amount discount. Scope the campaign by SKU, review optional cost warnings, and resolve or skip any row whose final rounded price falls below the minimum retail floor.
- Download a matched Promo Launch and Promo End Revert pair with a JSON audit and an offline Campaign Sign-Off report. Shopify preserves the original product groups and updates base prices and compare-at prices. WooCommerce and eligible legacy BigCommerce rows carry a sale price while preserving regular prices. Legacy BigCommerce campaigns require a numeric original sale price that the revert can restore.
- Check the actual launch and revert bytes, SHA-256 fingerprints, and recovery of the uploaded catalog in **Verify Update / Rollback CSV**. Schedule and perform both store imports manually.

## v1.1.0 (M11)

- Choose a single Shopify Markets price column from a product export. Use the existing pricing formulas, cost brackets, rounding, and a confirmed manual FX rate to calculate prices in the target market currency. The paired files carry the target market price, its compare-at column when enabled, and the original Shopify identity and variant group fields.
- Review pricing and tracked stock changes for existing products in BigCommerce's legacy Bulk Edit format. Product pricing uses `Price` and optional `Sale Price`. Legacy SKU rows can carry eligible stock changes under their original identities. Keep the paired CSVs with their audits, SHA-256 fingerprints, and offline Client Sign-Off report.
- Inspect a Shopify Markets or BigCommerce candidate using **Verify Update / Rollback CSV**. Use the actual matched pair to replay recovery of the uploaded snapshot. Try the BigCommerce workflow with the labeled synthetic demo.

## v1.0.0 (M10)

- Check a Shopify or WooCommerce update or rollback CSV against an original catalog export. Verify Before Import computes SHA-256 for both files, reports exact price and stock cell changes, and flags unsafe columns, SKU or identity changes, and invalid product groups.
- Verify either file from the current workbench batch with **Load last generated pair**. The matched rollback can be replayed after its update to verify exact recovery of the uploaded catalog data. With only a baseline and a candidate, the inspector reports agreement for the scoped rows and fields in that candidate.
- Open the keyboard shortcuts dialog with `?` or its button, and return focus with `Escape`. Use `/` to reach available workbench search. Turn off single-character shortcuts from the dialog.
- Typecheck the public source export from its own directory in CI. The update builder remains the default on the existing price workbench URL.

## v0.9.0 (M9)

- Compare SHA-256 fingerprints for the original catalog and supplier files and the verified update and rollback CSVs. The single-file repair shows fingerprints for the source and available repaired CSV. JSON audits and the standalone Client and Bookkeeper Sign-Off reports carry the corresponding checksums.
- Hold Stripe and PayPal exports when Gross, Fee, and Net do not reconcile in exact cents. Review the stated amounts and expected Net on the original source line, including refund and reversal cases.
- Hold single-currency QuickBooks bank CSVs when multiple explicit currencies are present. Review counts and physical source lines by currency in the repair workbench and Bookkeeper Sign-Off report.

## v0.8.0 (M8)

- Review price movement, gross margins where landed cost is available, and mapped inventory changes for Shopify and WooCommerce batches. Filter the diff to zero- or negative-margin SKUs and include the batch summary in the offline Client Sign-Off HTML.
- Download printable Bookkeeper Sign-Off HTML from the single-file repair workbench. It records automatic fixes, manual edits, flagged and excluded source lines, and transaction amounts grouped by confirmed currency.
- Keep tracked production modules with names such as `local-settings.ts` in the public source export. Internal research, tasks, and scratch files remain outside the public export.

## v0.7.0 (M7)

- Set two to six wholesale cost brackets with separate markups. Each finite upper limit includes the exact store-currency cost after manual FX. The matched bracket appears in the comparison, audits, and Client Sign-Off HTML. Version 5 supplier recipes save tiered rules, and versions 1–4 still load.
- Switch the price update workbench to WooCommerce to compare an existing product export with supplier prices and optional stock. Download a scoped update and its matched rollback after local replay. Both preserve the original product IDs and variation relationships.
- Save and load store defaults as a workspace profile JSON file. A workspace profile carries the store name, platform, currency, price guardrails, and default brackets between sessions.
- Show signed price changes with up to two decimal places in the diff while keeping six-place audit values. Keep the desktop Review column usable when supplier and quantity columns are visible.

## v0.6.0 (M6)

- Compare one Shopify product export with up to three local CSV or XLSX supplier sheets. Conflicting offers require a decision, with the selected supplier and the competing source rows recorded for review.
- Opt into inventory quantity changes for single-location Shopify stores. Invalid quantities and large stock drops require review. Both native files carry quantity only when mapped, and the matched rollback restores original price and quantity cells in the local replay.
- Save optional quantity mapping and supplier conflict settings in v4 recipes. Versions 1–3 still load.
- Download a standalone Client Sign-Off HTML report for offline review of the comparison, including supplier provenance and inventory changes.

## v0.5.0 (M5)

- Added manual currency conversion before the retail formula and rounding. The audit records the entered rate, and v3 recipes require rate confirmation on each batch.
- Added optional automatic compare-at pricing. Mapped or generated compare-at prices must exceed the final variant price before export.
- Added a source snapshot export for the public repository.

## v0.4.0 (M4)

- Added multipliers with optional fixed fees, percentage markups, target margins, rounding, and minimum retail prices using exact decimal arithmetic.
- Added paired Shopify update and rollback CSVs with local readback against the original baseline. Version 2 recipes save the pricing rule.

## v0.3.0 (M3)

- Added reusable JSON supplier recipes and local workers with progress and cancellation. The browser suite verified a synthetic 20,000-variant batch.
- Added optional spreadsheet formula protection with audit entries and preserved signed decimal values.

## v0.2.0 (M2)

- Added Shopify baseline comparison against supplier CSV or XLSX, scoped price updates, and CSV and JSON diff audits.
- Added duplicate-key and price-change review, inline overrides, and explicit skips.

## v0.1.0 (M1)

- Added browser-local CSV repair for Shopify Products, QuickBooks Online Bank, and Stripe or PayPal, with before-and-after review, manual corrections, and downloadable audits.
