# Wholesale B2B Line-Sheet

[`buildWholesalePriceList`](../../src/core/wholesale-pricelist/engine.ts) reads one Shopify, WooCommerce, or legacy BigCommerce product CSV. The optional cost and MAP CSV or XLSX joins on exact `SKU` and needs at least one of `Cost`, `MAP`, `Case Pack`, or `MOQ`. Keep leading-zero workbook SKUs as text and use the intended visible worksheet. Price and quantity settings, previews, and downloads stay local.

To use a shipment calculation, attach `shipment-landed-cost.csv` as the optional cost and MAP sheet along with the catalog. The `Cost` column uses the ceiling of the exact per-unit landed cost in whole cents. It provides a conservative cost input in the batch currency. Add MAP values separately where needed. If the catalog supplies a different cost for the same SKU, review the discrepancy before proceeding. [Shipment calculation and CSV handoff](landed-cost.md)

## Tier calculation

- Use one currency for catalog prices, landed costs, and MAP amounts. ImportMedic checks supplied currency evidence against the batch currency. The catalog and cost sheet may supply these per-SKU values. Disagreement between sources holds the batch.
- Configure one to five tiers with distinct names and strictly increasing positive whole-unit minimums. Use `percent-off-retail` to discount the base or regular catalog price, or `cost-plus-percent` to add a markup to landed cost. Select `none` for half-up cent rounding, `ending-99` or `ending-95` to round up to the price ending, or `nearest-whole` for half-up whole-unit rounding.
- For each SKU and tier, take the larger of the tier minimum and SKU minimum and round it up to a full case-pack multiple. Keep an exact multiple as entered. A missing case pack or SKU minimum defaults to one. Several tiers can share the same effective minimum after this adjustment.
- The final price must cover any known landed cost and MAP. Require landed cost for cost-plus pricing and for a configured minimum gross margin. Gross margin is the selling price minus landed cost, divided by the selling price. Enable **Require MAP for every SKU** to hold on missing MAP as well. A floor allows equality. No price may increase from one tier to the next.
- A pricing hold identifies the SKU, tier, and source lines where applicable. Correct the supplied data or settings and run the batch again. The audit stays available on hold, while the buyer matrix, line sheet, Shopify CSV, and internal margin matrix are withheld.

## Shopify B2B catalog

For every source platform, choose one tier and give the exact title of the existing Shopify B2B catalog to update. Both settings are required for a ready batch. The case pack sets the quantity increment and the rounded effective minimum sets the minimum order quantity. The file writes fixed prices and these two quantity fields for one tier and catalog. Shopify uses the SKU to match existing products and variants. Compare-at prices, publishing flags, maximum quantities, and volume break columns are outside this export. [Shopify catalog CSV field reference](https://help.shopify.com/en/manual/b2b/catalogs/creating-catalogs#description-of-the-catalog-csv-file)

Export or inspect the destination catalog in Shopify admin before use. Confirm that its title matches exactly, the catalog currency agrees with the batch currency, and every SKU identifies the intended variant. Open the existing catalog in **Markets > Catalogs**, choose **Adjust prices > Import CSV**, and check **Preview Import** for the fixed prices, quantity increments, and minimum quantities. Keep a current destination export for comparison and review existing quantity rules and price breaks before applying any changes. ImportMedic validates the local bytes. Shopify performs the actual import after your review in its admin. [Shopify single-catalog update instructions](https://help.shopify.com/en/manual/b2b/catalogs/creating-catalogs#update-a-single-catalog)

## Buyer file fields

| File | Allowed content |
| --- | --- |
| `<brand>-wholesale-buyer-sheet.csv` | `SKU`, `Product`, `Case Pack`, and two columns per tier such as `Bronze MOQ` and `Bronze Unit Price`. |
| `<brand>-wholesale-line-sheet.html` | The same product, pack, minimum-order, and unit-price fields, plus the seller name, effective date, currency, and optional Workspace Profile branding. Open locally to print. |
| `<brand>-shopify-b2b-catalog.csv` | `Catalog Title`, `SKU`, `Option1 Name`, `Option1 Value`, `Fixed Price`, `Quantity Increment`, and `Minimum Order Quantity`. The option cells are blank because this export matches by SKU. This file is for the merchant's Shopify import. |

Each artifact is built from the listed fields. Unit cost, landed cost, MAP, gross margin, and profit stay in internal review. Enter buyer-approved text in the published product titles, tier names, catalog title, and branding fields. The buyer CSV neutralizes spreadsheet formulas and retains leading-zero SKUs in the CSV bytes. Import SKU cells as text in spreadsheets. Exact Shopify SKUs and the destination title must be safe to write unchanged. The buyer HTML escapes public strings, blocks external resources and scripts with its content security policy, and includes print styles.

## Internal files and custody

Keep `wholesale-margin-audit.json` and `<brand>-wholesale-margin-matrix.csv` with the merchant or agency. These include source lines, retail and landed costs, MAP, and per-tier gross margin and profit where available. The audit fingerprints the catalog and cost sheet bytes and the four available exports. The CLI also creates `custody-manifest.json` for the actual input and emitted file bytes, including the options JSON and the audit. Keep that receipt internally with the batch. A held CLI run writes its audit and custody manifest without the withheld files or their digests. Use the original files and download bytes to verify SHA-256 before resaving. [CLI options and synthetic replays](cli-automation.md#wholesale-sheet)
