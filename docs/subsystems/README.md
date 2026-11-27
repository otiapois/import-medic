# Subsystem Design References

Read the owning subsystem contract before changing code, and update it in the same commit whenever responsibilities, schemas, error codes, or verification commands change.

| Subsystem | Scope | Contract |
| --- | --- | --- |
| Core CSV Repair Engine | Byte decoding, Papa Parse, cell-level diffs, fail-closed review, formula guard, CSV roundtrip, running-balance checks, file fingerprints, and offline bookkeeper sign-off | [csv-engine.md](csv-engine.md) |
| Platform Profiles | Import rules, diagnostics, auto-fixes, and review conditions for Shopify Products, QuickBooks Online Bank, Stripe/PayPal, Xero Bank, and FreshBooks Expenses | [platform-rules.md](platform-rules.md) |
| Shopify Price Diff and shared pricing | Baseline and supplier parsing, variant joins and supplier conflict provenance, base and Markets pricing, optional base inventory, portable recipes, price and margin analytics, paired native CSV replay, file fingerprints, audits, and offline sign-off | [shopify-price-diff.md](shopify-price-diff.md) |
| WooCommerce Price Diff | Exact SKU matching, existing product and variation identity, optional sale price and tracked stock, and scoped native CSV replay | [woocommerce-price-diff.md](woocommerce-price-diff.md) |
| BigCommerce Price and Stock Diff | Legacy Bulk Edit format, exact product and SKU identity, standalone product price and sale price, eligible tracked stock, and scoped native CSV replay | [bigcommerce-price-diff.md](bigcommerce-price-diff.md) |
| Cross-Platform Catalog Migrator | Creation CSVs between Shopify, WooCommerce, and BigCommerce, exact price and variant mapping, unmapped-field disclosure, and local migration audit and sign-off | [catalog-migrator.md](catalog-migrator.md) |
| Supplier Delta | Previous and new supplier pricebooks, visible worksheet selection, cost and SKU delta review, and audited CSV and offline HTML reports | [supplier-delta.md](supplier-delta.md) |
| Sale Campaign Pack | One catalog baseline, discount and minimum retail rules, price-only native launch and revert, local replay, and offline sign-off | [promo-campaign.md](promo-campaign.md) |
| Verify Before Import | Cross-platform candidate inspection, native column and group validation, file fingerprints, exact cell differences, and optional matched rollback replay | [shopify-price-diff.md](shopify-price-diff.md#verify-before-import) |
| Web Workbench & SEO Pages | Local Web Worker, supplier stack and mapping, paged review and downloads, keyboard shortcuts, mobile layout, pre-rendered routes, launch indexing, and static response headers | [web-ui-seo.md](web-ui-seo.md) |

## Review Checklist (DOER != CHECKER)
1. Identify affected subsystem(s) and verify every contract link still matches actual file paths and symbols.
2. Replay every dirty-CSV fixture using its original bytes. Re-validate the actual output bytes when export is available, and assert that unsafe inputs produce the expected review issues and no CSV download.
3. Verify `npm run typecheck`, `npm test`, `npm run test:fuzz`, `npm run build`, and `npm run test:e2e` (desktop + mobile) all pass on the reviewed HEAD.
4. Confirm zero outbound network requests occur during file upload, diagnosis, repair, and download.
5. Recompute SHA-256 from the original files and actual CSV downloads. Compare the values with the workbench, JSON audit, and offline sign-off. Check that a held export has no output checksum.
6. Inspect the actual native update and rollback against their original baseline. Confirm that the inspector rejects a forbidden column and a changed SKU. Check scope agreement with the baseline alone and full catalog recovery with the matched update available.
7. Export the committed public source to a new directory, check that it excludes `docs/research`, and run `tsc --noEmit` using the exported project configuration and the locked release dependencies.
8. Replay a valid and broken running-balance file. Match the verified link counts, physical lines, balances, and held status across screen, JSON audit, and offline Bookkeeper Sign-Off. Check that a FreshBooks mixed-currency file holds and a single-currency expense file passes local byte validation.
