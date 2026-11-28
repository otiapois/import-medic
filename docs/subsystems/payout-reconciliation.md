# Payout vs Bank Reconciliation

Open **Payout vs Bank Reconciler** in the Accounting Workbench on `/`. Use **Choose Platform Payout CSV** and **Choose Bank Statement CSV** or load the synthetic month-end Shopify demo. The browser processes both files locally. The CLI reads and writes local files using the same matching rules. The resulting CSVs and sign-off are for bookkeeping review. Compare exceptions with the platform payout details and bank statement before closing the period.

## Prepare both inputs

| Source | Required fields | Optional fields |
| --- | --- | --- |
| Platform payout summary | `Payout ID` or `Payout Reference`, `Payout Date`, `Net Payout Amount` | `Gross`, `Fees`, `Currency` |
| Bank statement | `Bank Date`, `Description`, `Amount` | `Currency`, `Reference` |

The matcher trims header spacing and compares names case-insensitively. The payout file also accepts `Payout ID/Reference` or `Reference` for the ID, `Date` for the date, and `Net Payout`, `Net Amount`, or `Net` for the amount. Optional fields also accept `Gross Amount` and `Fee`. The bank file also accepts `Date`, `*Date`, `Transaction Date`, or `Posting Date` for the date, `*Description`, `Payee`, or `Memo` for the description, and `*Amount` for the signed amount. Supply only one header for each field.

Use one row per completed payout and currency. If the platform supplies transaction-level payout detail, prepare a payout summary from the provider's completed payout totals. For example, Shopify's Payout ID can be shared by the transactions included in that payout. Repeated payout IDs within the same currency hold the run and retain the source lines. Use one bank movement per row, with positive amounts for deposits and negative amounts for withdrawals. Bank zero and negative amounts remain in the audit outside the inflow totals. [Shopify payout and transaction details](https://help.shopify.com/en/manual/payments/shopify-payments/payouts/view-details)

Use unambiguous dates such as `2026-11-30` and exact amounts with at most two decimal places. A date such as `03/04/2026` requires correction in the source. When the payout row includes both Gross and Fees, the matcher checks Net against Gross less the absolute Fees in exact cents. A discrepancy of even one cent requires review.

Use a supported two-decimal currency code in each source. When a source has no Currency header, confirm its actual single currency and enter it using **Payout default currency** or **Bank default currency**. When both files lack the header and are in the same verified currency, set that currency on both. Defaults apply to their respective files, and an empty cell in an existing Currency column requires source correction. Amounts in different currencies stay in separate groups, without FX conversion.

## Match and account for each row

1. Choose an integer for **Settlement lag window (days)** between 0 and 10. The default is 5. The bank posting date must be on or after the payout date and at most that many calendar days later, including weekends and the last day of the window. A zero-day window compares only same-day rows.
2. For each payout, consider positive bank deposits in the same currency with the same exact integer-cent amount and a date in that window. When a row on either side has more than one exact candidate, the matcher marks every row connected through those candidates as `AMBIGUOUS_TIE`. The review group lists the physical lines from both files. Descriptions and references carry source evidence and have no effect on tie resolution.
3. Review unmatched payouts and deposits. A same-currency amount within the settlement window can carry an `UNMATCHED_NEAR_AMOUNT` clue when the exact difference is at most 25.00 currency units or 2% of the payout. Rows on either side with the same date, currency, and amount share the finding and retain their physical lines. The signed delta is bank amount minus payout Net. A one-cent difference remains an exception. Confirm the cause against the original records.
4. For clean sources, a partial run includes only pairs that independently satisfy the exact one-to-one rule. Invalid source data, including repeated payout IDs, holds all pair rows because the missing evidence can conceal another candidate.

Compare the totals in the audit separately by currency and source. Exact known payout amounts partition into matched, unmatched, and ambiguous cents. Positive bank inflows partition into the same three buckets. Matched payout and bank amounts agree to the cent in each currency. A near-amount clue leaves both source amounts in their existing buckets. A row with a known amount and currency can still contribute to the unmatched bucket on a source hold. Unparseable amounts and unknown currencies remain visible for review outside the totals. Physical lines count the original CSV's line breaks, including those inside quoted values.

The audit uses `INVALID_SOURCE` or `INVALID_ROW` for unusable inputs and `DUPLICATE_PAYOUT_ID` for repeated IDs. A `PAYOUT_TOTAL_MISMATCH` includes the expected Net, actual Net, and actual-minus-expected delta in cents. `UNMATCHED_PAYOUT` and `UNMATCHED_BANK_DEPOSIT` identify the remaining source rows. All exact amounts in the JSON are strings of integer cents.

## Review files and local API

| File | Contents |
| --- | --- |
| `payout-reconciled-pairs.csv` | One row per independently proven pair, with the payout ID, original physical lines, exact cents, currency, and lag. With no provable pairs the CSV has only its header. |
| `payout-exceptions.csv` | Missing payouts or deposits, competing candidates, near-amount differences, and source diagnostics with available physical lines. |
| `payout-reconciliation-audit.json` | Source evidence, matching options, pairs, exceptions, currency totals, and SHA-256 of the original input bytes and emitted CSVs and HTML. |
| `payout-reconciliation-sign-off.html` | Standalone Month-End Payout Reconciliation Sign-Off with the current Agency Sign-Off Branding and a restrictive content security policy. Open it locally to review the results. It contains no scripts or external assets. |
| `custody-manifest.json` | CLI batch receipt with the SHA-256 of each input and emitted file, including the audit. |

Completed runs with exceptions keep the review files. Both CSVs use RFC 4180 quoting and guard formula-like text. Use **Agency Sign-Off Branding** to set the agency name, client, contact note, and accent, or load a saved Workspace Profile. Compare the input and output fingerprints with the audit before resaving any file. Exit `0` means the local run completed with zero exceptions. Exit `2` keeps the artifacts for review. [CLI options and example runs](cli-automation.md#reconcile-payouts)

The audit's `custody.inputs` contains `payouts` and `bank`. Its `custody.outputs` contains `pairsCsv`, `exceptionsCsv`, and `signoffHtml`. Each entry includes the filename, byte length, and SHA-256. The `sources` entries retain the original header, record cells, physical lines, row dispositions, and applied per-file default currency.

The pure TypeScript entry point [`reconcilePayouts`](../../src/core/reconciliation/payout-matcher.ts) accepts `{ payouts: { filename, bytes }, bank: { filename, bytes }, maxLagDays?, payoutCurrency?, bankCurrency?, branding? }`. Pass the original `Uint8Array` bytes for each file so the audit records the exact originals. The asynchronous result exposes the matching evidence and artifact bytes used by the browser and CLI.
