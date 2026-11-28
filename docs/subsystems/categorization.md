# Bookkeeper Categorization and Inclusive Tax

The [categorization engine](../../src/core/accounting/categorization-rules.ts) applies a versioned rule pack to transaction rows using exact cents. The home workbench and local CLI use the same calculation. The outputs are for bookkeeping review before any accounting software import. Review the source separately for dates, duplicates, fees, balances, and any tax already recorded. [Accounting repair checks](csv-engine.md#tax-and-duplicate-transaction-checks)

## Transaction input

- Use a comma-delimited CSV with `Description` or `Payee`, or both, and one amount layout. A signed `Amount` or `Gross` column uses positive credits and negative debits. Xero's `*Amount` is also recognized. With `Debit` and `Credit` columns, confirm the Bank convention when Debit is money out, or the Intuit convention when Credit is money out. Use `Money In` and `Money Out`, or `Deposit` and `Withdrawal`, when the headers describe the direction. Each split row must have one positive side and an empty or zero other side. Dates and other source columns carry through without date conversion.
- Amounts must represent exact cents. For a source with a currency column, supply supported two-decimal currency codes per row. When the column is absent, supply a confirmed source currency or leave plain amounts in an **Unspecified currency** group. If an amount in a currency-less file carries a currency symbol, confirm the currency explicitly. Multiple currencies stay in separate summary groups. There is no currency conversion.
- In the home workbench, choose **Auto-Categorize Rules** and a local CSV. **Use Current Source CSV** takes the original bytes from an eligible, verified accounting repair with no manual edits or removed rows. The categorizer validates that source against its own input requirements and retains original physical line numbers. FreshBooks expense files with `Vendor` and `Notes` need a supported signed transaction layout before categorization. The browser processes the CSV and rules in a local worker and downloads reports to your device.

## Rule pack v1

Use **Load Rule Pack (.json)** and **Save Rule Pack (.json)** to carry the current rule order and settings across batches. The UTF-8 JSON accepts `schemaVersion: 1`, `rules`, and the optional `conflictPolicy` and `unmappedReviewThresholdCents` fields. A pack supports up to 250 rules and 512 KiB. Unknown keys, duplicate JSON members, and invalid values are rejected. [Synthetic rule pack](../../fixtures/m23/rules.json)

| Field | Effect |
| --- | --- |
| `id`, `label` | Unique rule ID and display label. Holds identify matching rules by ID. |
| `matchType`, `pattern` | `contains`, `starts-with`, or `exact` literal text. Match each available Description or Payee cell separately after trimming, Unicode NFC normalization, and lowercasing. |
| `direction` | `any`, `debit`, or `credit`. |
| `minAmountCents`, `maxAmountCents` | Optional inclusive nonnegative integer bounds applied to the absolute gross amount in cents. |
| `accountCode`, `accountName`, `taxCode` | User-supplied account and tax values. |
| `inclusiveTaxRateBps` | Optional nonnegative integer basis points. For example, `500` represents 5.00% and `2000` represents 20.00%. These are sample rates. Apply a rate only when it fits the actual transaction. |

The default `fail-on-ambiguous-match` holds a run when a row matches different account or tax codes. If the matching account and tax codes agree, the first matching rule supplies the result. Select `first-match-wins` to use rule order even when the codes differ. Review the first rule before using this policy with overlapping patterns. An optional `unmappedReviewThresholdCents` holds a run when an unmatched row's absolute gross exceeds the threshold. Other unmatched rows can be exported with empty account, tax code, and matched rule fields and are included in their currency's summary.

## Inclusive split and review files

For a configured positive rate, the engine calculates `netCents = roundHalfToEven(grossCents × 10000 / (10000 + rateBps))` and `taxCents = grossCents − netCents`. A half-cent tie rounds to the nearest even cent. Net and tax keep the transaction direction and sum to gross to the cent, including refunds. With a zero or omitted rate, or no matching rule, net equals gross and calculated tax is zero.

| File | Contents |
| --- | --- |
| `categorized-transactions.csv` | Original columns followed by `Account Code`, `Account Name`, `Tax Code`, `Calculated Net`, `Calculated Tax`, and `Matched Rule`. The CSV applies spreadsheet formula protection to text and preserves signed decimals. |
| `account-summary.csv` | Transaction counts and signed gross, net, and tax totals grouped by currency, account code, and tax code. Group totals reconcile within each currency. |
| `categorization-audit.json` | Source and rule pack fingerprints, coverage, settings, line-level findings, and SHA-256 of both CSVs and the HTML when issued. |
| `bookkeeper-categorization-sign-off.html` | Printable offline coverage, category totals, and a sample of up to 20 transactions with optional Agency Sign-Off Branding. |

A completed hold keeps the JSON audit and withholds both CSVs and the HTML. Check the findings against the original physical CSV lines, including newlines inside quoted cells. The audit's `custody` fingerprints the original `source` and loaded `rulePack` bytes, optional CLI `workspaceProfile`, and exact `outputs` when issued. After editing the loaded rules, compare the fingerprint with the saved current pack. The HTML footer carries the input and CSV hashes. Use the audit to check the HTML hash as well. Compare fingerprints before opening and resaving a CSV. The local CLI adds a separate manifest that also fingerprints the audit. [CLI options, replay, and custody](cli-automation.md#categorize)
