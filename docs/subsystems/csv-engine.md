# Subsystem: Core CSV Repair Engine (`src/core/`)

`repairCsv(bytes, filename, platform, options?)` runs in the browser and Node with no file, storage, or network access. `applyManualCellEdits(bytes, filename, platform, options, edits)` runs the same pipeline on the original bytes with the supplied changes. The caller keeps the accumulated edit list. Edits use the original 1-based physical CSV line and either the original or canonical header. `getSourceColumn(platform, sourceHeaders, column)` resolves a canonical issue column to its original header.

## Repair result

- `sourceHeaders` and each row's `before` contain the decoded original cell strings. `headers` and each row's `after` describe the selected output schema. Removed records have a separate audit entry with their physical line, raw text, reason, and rule code.
- `issues` contains stable IDs, severity, code, physical line, column, raw value, replacement where applicable, editability, and a local rule page path. A multi-line record uses the physical line on which it starts. `RECOGNIZED_RULE_IDS` lets the SEO catalog check its diagnostic codes against the engine.
- `changes` records normalized headers, manual edits, changed cells, and projected columns. Structural issues such as malformed quoting, duplicate headers, and excess cells have `editable: false`. These require a change to the source file or selected options.
- `needsManualReviewCount` counts unresolved errors. `canDownload` allows errors that are still represented in the output and blocks structural errors or unresolved decisions that make conversion unsafe. Blocked results have an empty `repairedCsv`. The issue and change records remain available for an audit.
- `roundtripCheck` reports whether a candidate export was checked, how many auto-fixes the checked bytes would still need, and how many review items remain in those bytes. The check compares the exact output cells and unresolved rule codes after UTF-8 encoding, parsing, and validation as the target schema. QuickBooks's generated date format and credit/debit convention and the payment source's fee convention are fixed for this validation pass. Any mismatch blocks export.
- Stripe or PayPal `reconciliation-mismatch` holds the CSV and records the physical source line, Gross, Fee, Net, expected Net, and the applicable fee convention. A mixed-currency bank projection adds `currencySplit` with the explicitly identified currencies and their physical source lines in first-seen currency order. The workbench and sign-off derive the counts from those lines.
- `options.formulaGuard` opts into spreadsheet formula protection for the repaired CSV. The engine prefixes risky text with an apostrophe, keeps plain signed decimals such as `-12.50`, and validates the guarded bytes with the same platform roundtrip. `formulaGuard.neutralized` lists each exported change using the original physical line, column, exact before, and exact after. If guarded output fails verification, the proposed changes appear under `formulaGuard.blocked` and no CSV is offered. Both audit formats record the distinction.

## Decoding and quoting

The engine decodes strict UTF-8 and BOM-marked UTF-8 or UTF-16LE with `TextDecoder`. It falls back to Windows-1252 when BOM-free, NUL-free bytes fail strict UTF-8 decoding. Unsupported UTF-16BE/UTF-32, malformed BOM-marked encodings, and decoded NUL bytes block export. Windows-1252 smart quotes, en/em dashes, and nonbreaking spaces are normalized with cell-level audit entries.

Papa Parse handles CSV quoting and supplies the record boundaries used to measure physical lines. The engine accepts mixed record separators and preserves the original newlines embedded in quoted cells. Export uses UTF-8 without a BOM, LF record separators for Shopify and CRLF for the accounting profiles, with Papa Parse quoting and doubling embedded quotes.

## Running-balance chain

QuickBooks and Xero bank repair checks `Balance` or `Running Balance` on the source before projecting to the target columns. A generic bank statement can use either profile when its date and amount columns match that profile's supported source schema. Each balance is interpreted as the balance after that row's transaction. The amount must be signed under the source's confirmed convention. The verifier uses exact integer minor units for the explicit supported currency, such as cents for USD, whole yen for JPY, and three decimal places for KWD and BHD. With no currency column, it uses two decimal places and reports an unspecified currency. Values requiring rounding at the applicable precision hold the chain.

The verifier determines ascending or descending order from distinct normalized dates. It checks older balance plus the newer row's signed amount against the newer balance for each adjacent pair. In a descending file the older row appears next. Equal dates use the physical order within the detected direction. A date reversal, an entirely same-day multi-row file, or an unresolved date, amount, balance, or currency can make the chain unverifiable. The reported `row` is the original physical starting line of the affected record, including when earlier records contain quoted newlines.

- `VERIFIED` means the supplied links agree. Opening balance is the oldest supplied post-transaction balance minus the oldest transaction amount. Net movement adds the supplied amounts, and closing balance is the newest supplied post-transaction balance. A one-row source has zero links to check.
- `FAIL_BALANCE_BREAK` records the physical row, expected and actual balances, and the signed difference (`actual − expected`). Even one minor unit holds the export.
- `UNVERIFIABLE` records physical lines and reasons when the inputs do not support the check. The CSV remains held until the source or settings resolve the reasons.

`balanceChain` is an optional additive JSON audit field. It includes `status`, `direction`, `currency`, `openingBalance`, `netMovement`, `closingBalance`, `verifiedLinks`, `totalLinks`, `breaks`, and `reasons`. Each break has `row`, `expected`, `actual`, and `delta`. Each unverifiable reason has `row`, `column`, and `message`. Summary values can be null when undetermined. A currency label requires one explicit supported source currency. A source without a balance column has no `balanceChain` field. A verified chain covers the supplied records and can miss omitted transactions outside the supplied range or groups of omitted transactions with zero net movement. Reconcile statement dates and totals against the bank separately.

FreshBooks runs add `freshBooksTaxes` when the source supplies tax details. Each entry records the physical `row` and original `name` and `amount` cells. The offline sign-off repeats these details for review.

## Tax and duplicate transaction checks

The [accounting auditor](../../src/core/accounting/tax-duplicate.ts) checks applicable source rows for QuickBooks Bank, Xero Bank, FreshBooks, and Stripe or PayPal before the repair projects them into the output layout.

- Tax reconciliation uses exact integer arithmetic for `Net/subtotal + Tax == Gross`. A one-cent difference at two-decimal precision is a mismatch. The optional `taxReconciliation` audit records `VERIFIED`, `FAIL_TAX_MISMATCH`, or `UNVERIFIABLE` with source line evidence where applicable. A mismatch or unusable values in a supplied tax trio hold the repaired CSV. When a payment report supplies settlement Net and sales tax without a pre-tax subtotal, the audit can report unverifiable tax coverage and the separate fee checks govern settlement Net. [PayPal monthly and custom statement fields](https://developer.paypal.com/reports/monthly-custom-statements)
- Exact duplicate keys use the normalized calendar date, exact signed amount under the source convention, and the applicable payee and description fields. The check accounts for currency evidence. Amounts of opposite signs and amounts in different explicitly identified currencies form separate keys. The optional `duplicateTransactions` audit maps matching records back to their original physical lines and identifies the pairs for review. The flagged records are retained. `FAIL_DUPLICATE_TRANSACTION` holds the repaired CSV until the source is reconciled.
- Both findings appear in Issues & Review, the JSON audit, and the offline Bookkeeper Sign-Off. Source lines refer to the original file and count physical newlines embedded in quoted records.

## Offline bookkeeper sign-off

The Bookkeeper Sign-Off HTML uses the current completed single-file repair and its audit ledger. It records the source filename, selected platform, generation time, download state, automatic fixes, manual edits, flagged lines, and excluded records. The total covers retained and excluded data records, the cell counts use distinct source cells, and the flagged and excluded counts use distinct physical lines. The audit table uses physical source line numbers, including when normalization changes the output columns. Available transaction amounts are kept in separate totals by validated source currency, including when the selected QuickBooks export layout omits currency. The report also carries reconciliation mismatch details, bank currency groups, and running-balance link counts, balances, breaks, and reasons where applicable. Amounts on unreconciled lines appear in the source line audit and are excluded from the currency totals. The standalone HTML escapes report values, carries print styles and its own content security policy, and can be opened offline for review even when a repaired CSV is held.

The report accepts the optional Workspace Profile branding used by the other offline sign-offs. [Agency Sign-Off Branding contract](web-ui-seo.md#agency-sign-off-branding)

## File fingerprints

The browser worker hashes the original source bytes before decoding and the exact UTF-8 bytes of the verified repaired CSV when available. The JSON audit adds `custody.sourceSha256` and, for an available output, `custody.repairedCsvSha256`. The same digests appear in the workbench and the Bookkeeper Sign-Off HTML footer. When a run holds the CSV, only the source digest appears. A manual edit can change the repaired CSV digest while the original source digest stays the same. SHA-256 runs locally without a new dependency. Compare the hex digest of each file against a retained audit or report to verify byte equality.

## Local browser worker

[`WorkbenchWorker`](../../src/core/worker/client.ts) starts Vite's same-origin module worker. It reads local files, checks platform suggestions, runs the engine and roundtrip, and serializes downloads. The worker keeps the full source and reports in memory. The UI receives file and run metadata, bounded pages of preview rows and issues, and a transferable `ArrayBuffer` per requested download. A worker instance assigns a distinct ID to each request and reports progress by phase. Cancel terminates that instance and rejects pending requests. A later run can start a new worker with the files still selected in the UI.

## Verification commands

```text
npm run typecheck
npm test
npm run test:fuzz
npm run repair-cli -- --platform quickbooks-bank fixtures/quickbooks/amount-parentheses.csv --output repaired.csv --audit repair-audit.json
```

The legacy CLI invocation shown here runs the same engine. Its JSON audit records the same source and verified output SHA-256 fingerprints. Pass `--stripe-paypal-fee-convention` with the confirmed source convention when reopening a generic accounting report. With no output path it writes the validated CSV to stdout and the summary to stderr. Output and audit paths create new files. A result with review items returns exit code 2, including when a reviewable CSV was written. Invalid arguments and filesystem failures return exit code 1.

Use `--mode repair` with `--out-dir` for a fail-closed batch. This entry point withholds the CSV when unresolved review items return exit code 2. It writes the JSON audit, offline Bookkeeper Sign-Off, and a batch manifest for completed runs, including held runs. [Explicit repair flags and custody contract](cli-automation.md#repair)
