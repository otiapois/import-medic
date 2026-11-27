# Supplier Delta

The **2-Sheet Delta** view of **Supplier Delta** compares a previous and a new supplier pricebook without a store catalog. Use it to review supplier changes before building a store update. The analysis files are for supplier review. Use **Build Update** with a fresh catalog export to prepare native store update and rollback files. For two to six chronological pricebooks with cumulative cost and SKU lifecycle reporting, choose **Multi-Period Cost Creep (2–6 sheets)**. [Multi-period cost-creep contract](cost-creep.md)

## Inputs and comparison

- Each input is an original CSV or XLSX file. XLSX offers visible worksheets in workbook order, starting on the first visible tab. Select the intended tab for each input. The comparison records the chosen worksheet and uses the original CSV starting line or XLSX row number for its source evidence.
- Choose the SKU and cost or price columns for each input. Inventory mapping is optional. The workbench suggests columns and allows manual selection. Match SKUs as exact text and keep leading-zero SKUs in Excel text cells. Use comparable amounts in the same currency because the comparator applies no exchange rate.
- Each matched SKU is classified as **cost-increased**, **cost-decreased**, or **unchanged**. A SKU present only in the new sheet is **added-sku**. A SKU present only in the previous sheet is **removed-sku**. Cost comparisons use exact scaled integer arithmetic, preserving source precision down to fractions of a cent. Percentage changes with a valid denominator display to two decimal places.
- Duplicate keys or invalid mapped values hold both the delta CSV and the sign-off. Review the blocking category and physical source rows, correct the files or mapping, and rerun the comparison. The JSON audit retains diagnostics for held runs.

## Downloads and custody

- `supplier-delta-report.csv` is a review CSV with RFC 4180 quoting, guarded formula-like text, and leading-zero SKU text preserved in the file. Use a text editor or import SKU columns as text when inspecting it in a spreadsheet.
- `supplier-delta-audit.json` records the inputs, mappings, results, and source rows. Its `custody` object records `previousSha256` and `newSha256` from the original uploaded files. An XLSX digest covers the whole workbook. A released run also includes `deltaCsvSha256` and `signOffHtmlSha256` for the exact downloadable CSV and HTML bytes. Held outputs have no digest.
- `supplier-delta-sign-off.html` is an offline executive report with summary counts, maximum hike percentage, and a filterable top-cost-hikes table. It escapes report values and uses CSS-only filters under its content security policy, without external resources. The footer fingerprints both original inputs and the delta CSV. Verify the HTML itself against the digest in the separate JSON audit.
