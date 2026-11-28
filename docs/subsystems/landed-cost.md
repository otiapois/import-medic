# Landed Cost Calculator

Open **Inventory Sync > Landed Cost Calculator** in Price Update Studio. The [allocator](../../src/core/landed-cost/allocator.ts) takes one local shipment invoice, one set of charges, and a duty estimate basis. The browser and [CLI](cli-automation.md#landed-cost) use the same calculation.

## Shipment input

Supply a CSV or values-only XLSX with one header row and at least one shipment line. An XLSX with several visible worksheets requires a selection by exact visible sheet name. The audit keeps the selected worksheet and the SHA-256 hash of the original whole workbook. Source line references are physical CSV lines or worksheet row numbers.

| Column | Input |
| --- | --- |
| `SKU` | Required. Use unique, case-sensitive text and store leading-zero SKUs as text in XLSX. Surrounding whitespace, control characters, scientific notation, and formula-leading SKUs that would need escaping hold the calculation. |
| `Quantity` | Required positive whole number. |
| `FOB Unit Cost` | Required nonnegative decimal amount in the invoice currency with up to two fractional digits, excluding extra trailing zeros. |
| `Unit Weight Kg` | Positive decimal weight per unit on every row for weight allocation. |
| `Unit Volume CBM` | Positive decimal volume per unit on every row for CBM allocation. |
| `Duty Rate %` | Optional percentage from `0` to `200` inclusive, in increments of 0.01 percentage points. Use `7.50` or `7.50%` for 7.50 percent. A percentage-formatted XLSX cell can store the fraction `0.075`. A blank or omitted rate uses zero. |
| `HS Code`, `Description` | Optional reference text. The calculator uses the duty rate you supply for each row. |
| `Currency` or `FOB Currency` | Optional invoice currency evidence. Use at most one of these columns and match the selected FOB invoice currency. Recognized XLSX currency formats must agree too. |

Use supported two-decimal currency codes. FOB amounts across the invoice must use one source currency. Enter freight, insurance, port or brokerage charges, and any other shared charges in the target currency. Convert separate charge invoices into that currency before entering the totals. Each shared charge must be a nonnegative whole number of target-currency cents after conversion. Enter zero for an unused charge. The calculator accepts up to 64 input digits for a quantity or whole cent amount, and up to 64 digits on each side of the decimal point for decimal inputs, subject to the currency and percentage precision rules above.

When the invoice and target currencies differ, explicitly supply a positive FX rate in target currency per unit of source currency. In the browser, confirm the rate for the current calculation. Leave the rate blank when the currencies match. The engine multiplies quantity by source FOB unit cost, converts the extended line amount at the stated rate, and rounds once to target cents using half-to-even. Value allocation uses source extended FOB so FX rounding cannot change the allocation weights.

## Allocation and duty

| Method | Line weight |
| --- | --- |
| Value (`by-value`) | Quantity × source FOB unit cost. Requires a positive combined FOB value. |
| Weight (`by-weight`) | Quantity × unit weight in kg |
| CBM (`by-cbm`) | Quantity × unit volume in m³ |
| Units (`by-units`) | Quantity |

Each of the four shared charge totals is apportioned independently using integer arithmetic. The engine takes the floor of each line's proportional share and assigns leftover cents in descending order of fractional remainder. Ties go to the earlier physical source line. The audit compares the sum allocated with the amount entered for each bucket.

The **FOB** estimate basis uses converted extended FOB. The **CIF** estimate basis adds the line's allocated freight and insurance. Handling and other charges enter landed cost separately. Apply the selected basis and the duty percentage you have verified for the shipment. The engine computes each line's duty from that basis and its supplied rate and rounds to cents using half-to-even.

Landed extended cost adds FOB, freight, insurance, handling, other charges, and duty. The audit keeps the exact landed unit ratio as extended landed cents divided by quantity and records the remainder of that integer division. The workbench rounds the ratio to two currency decimals and `Landed Unit Cost` in the CSV rounds it to four, both half-to-even. Compare shipment totals against the extended cents. Multiplying a rounded unit figure by its quantity can produce a different amount.

## Review files and pricing handoff

| File | Use |
| --- | --- |
| `shipment-landed-cost.csv` | Exact SKU text, quantity, unit and extended costs, itemized allocated charges, duty, and optional reference fields. `FOB Unit Cost` uses `FOB Currency`. The allocations, duty, and landed costs use the target `Currency`. The CSV uses standard quoting and guards text that spreadsheets could execute as formulas. Import SKU columns as text when opening the file in a spreadsheet. |
| `landed-cost-audit.json` | Source and worksheet evidence, selected options, physical line diagnostics, exact cent proofs and per-line division, and SHA-256 of the original input and available CSV and HTML. |
| `landed-cost-sheet.html` | Printable Landed-Cost Sheet with Agency Sign-Off Branding, shipment totals, line breakdown and cost information. Open the downloaded file offline. The report's content security policy blocks scripts and external requests. |

A hold retains the audit with the source evidence and withholds the CSV and HTML. The CLI also writes a custody manifest for the exact emitted bytes. Compare hashes on the original and downloaded files before resaving them.

- In **Build Update**, provide the CSV as a supplier input. Confirm the `SKU` and `Landed Unit Cost` columns and the currency settings. Use a cost-based pricing rule to use the four-decimal amount for retail and margin review. [Price Diff cost input](shopify-price-diff.md#use-costs-from-a-shipment)
- In **Wholesale B2B Line-Sheet**, give the same CSV as the optional **Cost and MAP** sheet alongside the native catalog. Its `Cost` column takes the ceiling of the exact unit ratio in whole cents for the wholesale cost floor. Review any different cost supplied by the catalog and add applicable MAP separately. Keep the cost sheet and catalog in the same batch currency. [Wholesale input rules](wholesale-pricelist.md)
