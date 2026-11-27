# Multi-Period Supplier Cost Creep

Use **Supplier Delta** in Price Update Studio at `/shopify-price-update-diff` and choose **Multi-Period Cost Creep (2–6 sheets)**. The browser and the local CLI use the same [cost-creep engine](../../src/core/cost-creep/engine.ts). Its history and Vendor Negotiation Brief are supplier review files. For a native store update, use **Build Update** with a current catalog export. [CLI options](cli-automation.md#cost-creep)

## Inputs and holds

- Supply two to six original supplier CSV or XLSX files in oldest-to-newest order with a unique label for each period. The slot order establishes chronology. For each XLSX file choose its visible worksheet. Map the exact SKU and cost or price column independently for each period. Store XLSX SKUs as text to preserve leading zeros.
- Match exact SKU text across periods. The audit retains the period and physical CSV line or XLSX row for source evidence. Identical duplicate costs with compatible currency can be combined while retaining their original lines and raw cost cells. Conflicting duplicate costs and invalid mapped costs hold the history CSV and brief and leave a diagnostic audit.
- Compare supplier costs in a common unit. Explicit supplier currency evidence must agree across the files and with the supplied currency, if given. Bare costs can be compared in a shared unnamed unit. The analysis applies no exchange rate.
- For optional margin review, supply a **Store Baseline CSV** with the store SKU and retail price. Margin needs a positive retail price and independent evidence that supplier costs and the retail snapshot share the same known currency. Use **Cost currency** and **Baseline retail currency** to declare confirmed denominations. An explicit currency conflict holds the run. Missing currency evidence, a missing retail match, or a zero retail denominator leaves that margin unavailable. Both margins use the same supplied retail price, isolating the effect of the supplier cost changes at that price.

## Cumulative change and watchlist

All observed costs are compared as exact scaled integers. Zero costs are allowed and negative costs hold the run. The cumulative amount is the latest observed cost minus the first observed cost and retains the calculation's full decimal precision. With two or more observations and a positive first cost, the cumulative percentage is that change divided by the first observed cost, multiplied by 100. The exact ratio governs the inclusive threshold before the two-decimal display. The default is `10%`. A threshold of `0%` also includes flat costs with a defined percentage. Discontinued SKUs can qualify using their observed endpoints. The watchlist ranks by descending exact percentage, with ties in first-seen SKU order.

Hike and drop counts compare adjacent observed periods. A missing period cannot be used as one side of a comparison. **Consecutive hikes** is the longest run of strictly increasing adjacent changes. A gap, equal cost, or drop breaks the run.

| Lifecycle | Meaning |
| --- | --- |
| `active-all-periods` | The SKU appears in every period. |
| `added-later` | Its first observation is after the first period and it appears in every subsequent period. |
| `discontinued` | It appears earlier and is absent from the final period. |
| `reappeared` | It is present in the final period and returned after an internal gap. |

The optional first and latest gross margins are `(retail − observed cost) ÷ retail × 100`. Read the difference in percentage points. A SKU without comparable retail evidence still has a supplier cost history.

## Downloads and custody

| File | Contents |
| --- | --- |
| `supplier-cost-creep.csv` | RFC 4180 history, including source period costs and watchlist metrics. Formula-like text is guarded. Leading-zero SKUs remain in the bytes. Read the CSV in a text editor or import SKU cells as text. |
| `supplier-cost-creep-audit.json` | Run settings, source and mapping evidence, detailed SKU history, issues, and SHA-256 custody. |
| `vendor-negotiation-brief.html` | Printable offline report with the top 20 threshold rows, their inline SVG trends, and the current Agency Sign-Off Branding. The CSV and audit cover the full analysis. |

Each supplier input digest covers the exact original bytes, including the whole workbook for XLSX. The audit also fingerprints a supplied retail CSV. On a ready run, `custody.historyCsvSha256` and `custody.briefHtmlSha256` identify the exact emitted CSV and HTML. The HTML footer lists the input and history CSV hashes. Compare the HTML bytes against the digest in the separate JSON audit. A held run retains the source fingerprints and issues in the audit. Output digests are absent for withheld files.

The offline brief renders supplied text as text, with script and network access blocked by its content security policy. Styles and SVG are inline. Contact notes are plain text. The brief includes no external assets or links. [Shared branding contract](web-ui-seo.md#agency-sign-off-branding)
