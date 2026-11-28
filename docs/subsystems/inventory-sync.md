# Shopify Inventory Sync

**Inventory Sync > Inventory Update** compares a Shopify inventory snapshot with supplier stock for one Shopify location. The browser opens it in Price Update Studio at `/shopify-price-update-diff`. The local CLI uses `--mode inventory-sync` and the same comparison engine. The **Reorder PO Pack** workflow in the same tab prepares supplier purchase orders from inventory and cost catalogs. [Inventory comparison engine](../../src/core/inventory-sync/engine.ts) · [CLI options and outputs](cli-automation.md#inventory-sync) · [Reorder PO Pack contract](purchase-order.md)

## Source and scope

- Use Shopify's **All states** inventory CSV with `Handle`, `SKU`, `Location`, `Option 1 Value` or `Option1 Value`, and `On hand (current)`. The baseline quantity comes from `On hand (current)`. A prefilled `On hand (new)` is a pending instruction and `Available` is a different inventory state. Export **All states** again if the source uses the **Available** layout with locations as column headers. [Shopify inventory CSV formats](https://help.shopify.com/en/manual/inventory-and-locations/setup/inventory-csv)
- Select the exact, case-sensitive target location when the snapshot lists more than one. Each update is scoped to one location. Match supplier SKUs as exact text, including leading zeros. Shopify identifies the variant by handle and option values and treats SKU as optional in its import format. ImportMedic needs an unambiguous SKU join to propose a supplier-driven change.
- Add one to three CSV or XLSX supplier sheets and map each SKU and stock column. For XLSX, select the exact visible worksheet and store SKUs as text. Supplier quantities are nonnegative whole numbers. Differing quantities for the same SKU across sources, duplicate keys in one supplier sheet, and ambiguous target matches hold the pair. Equal values across feeds can corroborate the quantity without adding the counts. The diagnostics identify source CSV lines or XLSX rows.
- A target row needs a valid signed whole-number current quantity before ImportMedic can prepare a guarded change and its inverse. Matched rows with an empty current cell or `Not stocked` require review. A supplier-only SKU cannot create a Shopify variant or location record.

## Safety reserve and drop approval

1. If the supplier quantity is at or below the zero-out threshold, set the proposal to `0`.
2. Above the threshold, subtract the reserve and floor the result at `0`.
3. If set, apply the cap to the result. The difference between supplier stock and the final proposal is the number of units withheld.

The reserve and threshold default to zero and the cap is optional. A drop greater than 80% from a positive current quantity requires explicit approval for the batch. A drop of exactly 80% passes this guard. Approval covers the large-drop check and other blocking diagnostics still hold the pair.

## Paired native files and local replay

Both files use the changed variant rows for the selected location. They preserve the uploaded identity cell text for `Handle`, `SKU`, `Location`, and the Shopify option fields. They carry `Title` and option name fields when present. The files omit separate inventory states and editable metadata such as bin, customs, or packed-dimension fields. A formula-like identity value or a file above Shopify's 15 MB import limit holds the pair.

| File | `On hand (current)` validates | `On hand (new)` writes |
| --- | --- | --- |
| `inventory-update.csv` | Original current quantity from the snapshot | Final proposed whole-unit quantity |
| `inventory-rollback.csv` | The quantity written by the matched update | Exact original current quantity text |

The comparison checks both serialized files against the snapshot, applies the update locally, then checks that the matched rollback restores the original on-hand text. Rows at every other location stay outside the pair and remain unchanged in the replay. For example, if the baseline cell is `0007` and the proposal is `9`, the update writes `0007,9` and the rollback writes `9,0007` in the respective quantity columns.

For an approved store-side change, use **Products > Inventory > Import**. Shopify compares `On hand (current)` with its quantity when applying `On hand (new)` and rejects affected rows on a mismatch. Keep both cells populated to retain that check. Review the import result and reconcile current stock against a fresh export if anything has changed before a rollback. The local check reads the supplied files, and Shopify performs the current-stock comparison at import. [Shopify inventory import validation](https://help.shopify.com/en/manual/inventory-and-locations/setup/inventory-csv)

## Audit and sign-off

The JSON audit records the location, settings, mappings, proposed quantities, holds, and local replay result. The offline Inventory Sign-Off shows summary counts, a preview of the changes and review items, and a fingerprint footer. The browser uses the current Workspace Profile branding for the HTML. Review added and removed units, stock set to zero, and the source evidence before import.

Recompute SHA-256 from the input and downloaded file bytes before resaving them. Compare with `custody.baseline.sha256`, the `custody.suppliers` entries, and the native CSV hashes at `custody.updateCsvSha256` and `custody.rollbackCsvSha256` in the JSON audit. The offline HTML lists the same file fingerprints. An XLSX fingerprint covers the whole workbook even when the comparison uses only one sheet.

A completed hold retains the JSON audit and offline report. The native files and their fingerprints are available only for a ready comparison with changes. The CLI also writes a custody manifest for all completed runs, with the exact hashes of the emitted files. [CLI file custody](cli-automation.md#file-custody)
