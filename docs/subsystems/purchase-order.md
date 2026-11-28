# Reorder PO Pack

Open **Inventory Sync > Reorder PO Pack** in Price Update Studio at `/shopify-price-update-diff`. Review the resulting orders before sharing them with suppliers. To prepare a native Shopify on-hand change, use **Inventory Update** in the same tab. [Planning engine](../../src/core/purchase-order/engine.ts) · [CLI options and runnable examples](cli-automation.md#purchase-order)

## Input files and location

- The inventory CSV needs `SKU` and a quantity column. The planner checks `Available`, `Available (not editable)`, `On hand (current)`, and `On hand` in that order and uses one column for the entire snapshot. It also accepts `Current Qty` and `Current Quantity` after those names. Current quantity accepts signed whole units. Optional columns are `Location`, `Reorder Point`, and `Target Stock`. Select the exact **Target Location** when the file lists multiple locations. The calculation uses only the selected location's inventory.
- Add one to three supplier catalogs in the intended order. Each CSV or XLSX needs `SKU` and `Unit Cost`. Optional fields include `MOQ`, `Case Pack`, `Lead Time Days`, `Supplier SKU`, and `Currency`. For each XLSX catalog, choose its exact visible worksheet. Keep SKUs in XLSX text cells. The join uses the inventory SKU and the supplier catalog's `SKU` as exact text. The supplier's own SKU travels in its order as a separate identifier.
- Row-level reorder points and targets take precedence over defaults for their respective fields. Use nonnegative whole units. Supply a reorder point for each scoped row and a target for each row at or below its point. The separate **PO Reference** is included in the pack when supplied.

## Reorder calculation and supplier policy

1. A row qualifies when `currentQty <= reorderPoint`. The raw deficit is `max(0, targetStock - currentQty)`. The planner uses whole units.
2. For each matching offer, raise the deficit to at least the supplier's minimum order quantity, then round up to a multiple of that supplier's case pack. Blank MOQ and case-pack cells mean 0 and 1, respectively. For example, a deficit of 7, a minimum of 9, and a pack of 6 produce an order for 12.
3. Multiply the rounded units by the supplier's unit cost in integer cents. Unit cost must be nonnegative and representable in exact cents. Enter zero explicitly for a free item. Sum line totals to supplier subtotals and sum those subtotals to the plan total. The subtotal uses only the rounded units and unit cost, with freight, tax, and duty left to the supplier's order terms.

All applicable offers must share compatible currency evidence. The planner reads currency from cost values, the cost header, workbook formatting, or currency columns. Bare costs use the common denomination when compatible evidence identifies one. A batch of bare costs uses a shared unnamed unit. Conflicting currency evidence holds the plan. There is no currency conversion.

| Browser policy | CLI value | How an eligible SKU is assigned |
| --- | --- | --- |
| Lowest PO subtotal | `lowest-landed-cost` (default) | Select the unique lowest extended subtotal after MOQ and pack rounding. Hold an exact tie at the lowest subtotal. |
| Hold on lowest-cost ties | `block-ties` | Select the unique lowest extended subtotal and explicitly hold an exact lowest-subtotal tie. |
| Prefer first listed supplier | `prefer-first` | Use the first matching catalog in the supplied order. |

An unsafe matching offer holds the plan even when a competing offer is valid. Examples include a missing or invalid cost, a zero or negative case pack, and a noninteger MOQ. Duplicate inventory SKUs in scope, multiple matching offers for the same SKU in one catalog, missing offers, and unresolved ties also hold the batch. Review the catalog label and physical CSV line or XLSX row in the audit. Use corrected sources to resolve unsafe offers and review the intended policy before resolving ties.

## Downloads and custody

| File | Contents |
| --- | --- |
| `po-<supplier-slug>.csv` | One purchase order CSV per chosen supplier, with only its assigned lines. |
| `po-consolidated-summary.csv` | SKU, current quantity, reorder point, order quantity, chosen supplier, unit cost, and line total across the plan. |
| `po-audit.json` | Location, quantity basis, settings, summary, supplier groups, source issues, and SHA-256 custody. Use `summary.totalCents` for the exact integer-cent total. |
| `purchase-order-pack.html` | Branded offline printable report with supplier groups and print page breaks between suppliers. |

The CSVs use RFC 4180 quoting, neutralize formula-like text, and pass a local parse against the intended records before export. Read SKU fields as text to preserve their leading zeros. A ready plan with zero order lines still supplies a summary with its header, an audit, and an empty printable pack. The browser uses the current Workspace Profile branding. The printable HTML escapes supplied text, applies a restrictive content security policy, and uses no external resources or scripts. [Shared branding contract](web-ui-seo.md#agency-sign-off-branding)

Hash the exact source and output bytes before resaving. Compare with `custody.inventory`, `custody.suppliers`, and `custody.outputs` in the audit. A workbook fingerprint covers its entire original file. The selected worksheet is recorded separately. The HTML footer lists the input and CSV hashes. Use the separate audit for the exact HTML digest. A hold retains the audit and input fingerprints and withholds the order files and their digests. The CLI writes an additional unsigned batch manifest that also fingerprints the audit and any supplied Workspace Profile. [CLI file custody](cli-automation.md#file-custody)
