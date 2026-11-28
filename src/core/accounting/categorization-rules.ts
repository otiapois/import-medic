import { z } from 'zod';
import { sha256 } from '../audit/custody';
import type { SignoffBrand } from '../branding/signoff-brand';
import { parseCsv, serializeCsv } from '../csv';
import { guardSpreadsheetCell, guardSpreadsheetRow, type FormulaGuardCell } from '../formula-guard';
import { hasDuplicateKeys, profileText } from '../shopify-price-diff/settings-validation';
import { parseWorkspaceProfile } from '../shopify-price-diff/workspace-profile';
import type { DetectedEncoding } from '../types';
import { formatMinorUnits } from '../values';
import { renderCategorizationSignoff } from './categorization-signoff';
import { appendedHeaders, readCategorizationSource } from './categorization-source';

export { hasCategorizationHeaders } from './categorization-source';

export const maxRulePackBytes = 512 * 1024;
const defaultConflictPolicy = 'fail-on-ambiguous-match';
const conflictPolicySchema = z.enum([defaultConflictPolicy, 'first-match-wins']);
const nonnegativeInteger = z.number().int().nonnegative();
const ruleText = (max: number) => profileText(max).transform(value => value.trim());
const bookkeeperRuleSchema = z.strictObject({
  id: ruleText(120), label: ruleText(120), matchType: z.enum(['contains', 'starts-with', 'exact']), pattern: ruleText(256),
  direction: z.enum(['any', 'debit', 'credit']), minAmountCents: nonnegativeInteger.optional(), maxAmountCents: nonnegativeInteger.optional(),
  accountCode: ruleText(120), accountName: ruleText(120), taxCode: ruleText(120), inclusiveTaxRateBps: nonnegativeInteger.optional(),
});

export const bookkeeperRulePackSchema = z.strictObject({
  schemaVersion: z.literal(1), rules: z.array(bookkeeperRuleSchema).max(250),
  conflictPolicy: conflictPolicySchema.optional(), unmappedReviewThresholdCents: nonnegativeInteger.optional(),
}).superRefine(({ rules }, context) => {
  const ids = new Set<string>();
  for (const [index, { id, minAmountCents, maxAmountCents }] of rules.entries()) {
    if (ids.has(id)) context.addIssue({ code: 'custom', path: ['rules', index, 'id'], message: 'Use a unique rule ID.' });
    ids.add(id);
    if (minAmountCents !== undefined && maxAmountCents !== undefined && minAmountCents > maxAmountCents) {
      context.addIssue({ code: 'custom', path: ['rules', index, 'maxAmountCents'], message: 'The maximum cannot be below the minimum.' });
    }
  }
});

export type BookkeeperRule = z.infer<typeof bookkeeperRuleSchema>;
export type BookkeeperRulePack = z.infer<typeof bookkeeperRulePackSchema>;
export const creditDebitConventions = ['bank', 'intuit'] as const;
export type CreditDebitConvention = typeof creditDebitConventions[number];
type InputFile = { filename: string; bytes: Uint8Array };

export interface CategorizationInput {
  csv: InputFile;
  rulePack: InputFile;
  branding?: SignoffBrand;
  workspaceProfile?: InputFile;
  sourceCurrency?: string;
  creditDebitConvention?: CreditDebitConvention;
}

export interface CategorizationIssue {
  code: string;
  message: string;
  line?: number;
  column?: string;
  raw?: string;
  value?: string;
  matchingRuleIds?: string[];
  path?: string;
}

type RowAmounts<T> = { grossCents: T; netCents: T; taxCents: T };
type CurrencyGroup<T> = RowAmounts<T> & { currency: string | null; rowCount: number };
type AccountIdentity = { accountCode: string | null; accountName: string | null; taxCode: string | null };
type AccountGroup<T> = CurrencyGroup<T> & AccountIdentity;
type Fingerprint = { filename: string; byteLength: number; sha256: string };

export interface CategorizationRow extends AccountIdentity, RowAmounts<string | null> {
  line: number;
  raw: string;
  cells: string[];
  matchText: string[];
  status: 'categorized' | 'uncategorized' | 'ambiguous' | 'not-evaluated';
  currency: string | null;
  matchedRuleId: string | null;
  matchingRuleIds: string[];
  inclusiveTaxRateBps: number | null;
}

export interface CategorizationResult {
  status: 'ready' | 'blocked';
  encoding: DetectedEncoding;
  issues: CategorizationIssue[];
  metrics: { totalRows: number; categorizedRows: number; uncategorizedRows: number; ambiguousConflicts: number };
  accountSummary: AccountGroup<string>[];
  currencyTotals: CurrencyGroup<string>[];
  rows: CategorizationRow[];
  custody: { source: Fingerprint; rulePack: Fingerprint; workspaceProfile?: Fingerprint; outputs?: Fingerprint[] };
  artifacts: { categorizedCsv: Uint8Array | null; accountSummaryCsv: Uint8Array | null; auditJson: string; signoffHtml: string | null };
}

export const categorizationFilenames = {
  categorizedCsv: 'categorized-transactions.csv', accountSummaryCsv: 'account-summary.csv',
  auditJson: 'categorization-audit.json', signoffHtml: 'bookkeeper-categorization-sign-off.html',
} as const;

type PackValidation = { ok: true; value: BookkeeperRulePack } | { ok: false; issues: CategorizationIssue[] };
const utf8 = new TextEncoder();
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

export function validateRulePack(bytes: Uint8Array): PackValidation {
  const invalid = (message: string): PackValidation => ({ ok: false, issues: [{ code: 'invalid-rule-pack', message }] });
  if (bytes.byteLength > maxRulePackBytes) return invalid('Use a rule pack no larger than 512 KiB.');
  let input: unknown;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    input = JSON.parse(decoded);
    if (hasDuplicateKeys(decoded)) return invalid('Remove duplicate JSON members before using the rule pack.');
  } catch {
    return invalid('Supply a valid UTF-8 JSON rule pack.');
  }
  const validated = bookkeeperRulePackSchema.safeParse(input);
  if (validated.success) return { ok: true, value: validated.data };
  return { ok: false, issues: validated.error.issues.map(issue => ({ code: 'invalid-rule-pack', message: issue.message, path: issue.path.join('.') })) };
}

export function serializeRulePack(value: BookkeeperRulePack): string {
  return json(bookkeeperRulePackSchema.parse(value));
}

const magnitude = (value: bigint) => value < 0n ? -value : value;
const splitScale = 10_000n;

export function splitInclusiveTax(grossCents: bigint, rateBps: number): Pick<RowAmounts<bigint>, 'netCents' | 'taxCents'> {
  const denominator = splitScale + BigInt(rateBps);
  const numerator = magnitude(grossCents) * splitScale;
  const quotient = numerator / denominator;
  const twiceRemainder = 2n * (numerator % denominator);
  const roundUp = twiceRemainder > denominator || (twiceRemainder === denominator && quotient % 2n !== 0n);
  const absoluteNet = roundUp ? quotient + 1n : quotient;
  const netCents = grossCents < 0n ? -absoluteNet : absoluteNet;
  return { netCents, taxCents: grossCents - netCents };
}

// NFC preserves literal characters and punctuation. Normalize final Greek sigma so
// matching a word suffix is independent of how JavaScript lowercases its context.
const matchKey = (text: string) => text.trim().normalize('NFC').toLowerCase().replaceAll('ς', 'σ').normalize('NFC');

function literalContains(pattern: string): (text: string) => boolean {
  // Knuth–Morris–Pratt: a long, repetitive input and a repeated literal stay linear.
  const prefix = new Uint16Array(pattern.length);
  for (let i = 1, length = 0; i < pattern.length; i++) {
    while (length > 0 && pattern[i] !== pattern[length]) length = prefix[length - 1];
    if (pattern[i] === pattern[length]) length++;
    prefix[i] = length;
  }
  return text => {
    for (let i = 0, matched = 0; i < text.length; i++) {
      while (matched > 0 && text[i] !== pattern[matched]) matched = prefix[matched - 1];
      if (text[i] === pattern[matched] && ++matched === pattern.length) return true;
    }
    return false;
  };
}

function compileRule(rule: BookkeeperRule) {
  const pattern = matchKey(rule.pattern);
  const matchesText = rule.matchType === 'contains' ? literalContains(pattern) : rule.matchType === 'starts-with'
    ? (text: string) => text.startsWith(pattern) : (text: string) => text === pattern;
  const minimum = rule.minAmountCents === undefined ? 0n : BigInt(rule.minAmountCents);
  const maximum = rule.maxAmountCents === undefined ? null : BigInt(rule.maxAmountCents);
  return { rule, matches: (texts: readonly string[], gross: bigint, absolute: bigint) =>
    (rule.direction === 'any' || (rule.direction === 'debit' ? gross < 0n : gross > 0n)) &&
    absolute >= minimum && (maximum === null || absolute <= maximum) && texts.some(matchesText) };
}

const cents = (integer: string) => formatMinorUnits(BigInt(integer), 2);
const unsetAccount = { accountCode: null, accountName: null, taxCode: null };

function rollup(rows: readonly CategorizationRow[]) {
  const groups = new Map<string, AccountGroup<bigint>>();
  const currencies = new Map<string | null, CurrencyGroup<bigint>>();
  for (const row of rows) {
    const { currency, accountCode, accountName, taxCode } = row;
    const key = JSON.stringify([currency, accountCode, taxCode]);
    const currencyTotal = currencies.get(currency) ?? { currency, rowCount: 0, grossCents: 0n, netCents: 0n, taxCents: 0n };
    const group = groups.get(key) ?? { currency, accountCode, accountName, taxCode, rowCount: 0, grossCents: 0n, netCents: 0n, taxCents: 0n };
    for (const total of [currencyTotal, group]) {
      total.rowCount++;
      total.grossCents += BigInt(row.grossCents!);
      total.netCents += BigInt(row.netCents!);
      total.taxCents += BigInt(row.taxCents!);
    }
    currencies.set(currency, currencyTotal);
    groups.set(key, group);
  }
  const display = <T extends CurrencyGroup<bigint>>(entry: T): Omit<T, keyof RowAmounts<bigint>> & RowAmounts<string> => {
    const { grossCents, netCents, taxCents, ...details } = entry;
    return { ...details, grossCents: grossCents.toString(), netCents: netCents.toString(), taxCents: taxCents.toString() };
  };
  return { accountSummary: [...groups.values()].map(display), currencyTotals: [...currencies.values()].map(display) };
}

function verifiedCsv(headers: string[], rows: string[][]): Uint8Array | null {
  const bytes = utf8.encode(serializeCsv(headers, rows, 'categorize'));
  const expected = [headers, ...rows];
  const { records } = parseCsv(new TextDecoder().decode(bytes));
  return records.length === expected.length && records.every(({ cells, parseError }, index) =>
    !parseError && cells.length === headers.length && cells.every((value, column) => value === expected[index][column])) ? bytes : null;
}

const summaryHeaders = ['Currency', 'Account Code', 'Account Name', 'Tax Code', 'Transaction Count', 'Gross', 'Calculated Net', 'Calculated Tax'];

export async function categorizeTransactions(input: CategorizationInput): Promise<CategorizationResult> {
  const { csv, rulePack, workspaceProfile } = input;
  const fingerprint = async ({ filename, bytes }: InputFile): Promise<Fingerprint> => ({ filename, byteLength: bytes.byteLength, sha256: await sha256(bytes) });
  const parsed = readCategorizationSource(input);
  const pack = validateRulePack(rulePack.bytes);
  const profile = workspaceProfile && parseWorkspaceProfile(workspaceProfile.bytes);
  const [source, rulesFile, profileFile] = await Promise.all([fingerprint(csv), fingerprint(rulePack), workspaceProfile && fingerprint(workspaceProfile)]);
  const custody: CategorizationResult['custody'] = { source, rulePack: rulesFile, ...(profileFile && { workspaceProfile: profileFile }) };
  const branding = profile?.ok ? profile.value.branding : input.branding;
  const issues = [...parsed.issues, ...(pack.ok ? [] : pack.issues)];
  if (profile && !profile.ok) for (const { message } of profile.diagnostics) issues.push({ code: 'invalid-workspace-profile', message });
  const rules = pack.ok ? pack.value.rules.map(compileRule) : [];
  const conflictPolicy = pack.ok ? pack.value.conflictPolicy ?? defaultConflictPolicy : null;
  const unmappedReviewThresholdCents = pack.ok ? pack.value.unmappedReviewThresholdCents ?? null : null;
  const metrics = { totalRows: parsed.rows.length, categorizedRows: 0, uncategorizedRows: 0, ambiguousConflicts: 0 };
  const rows = parsed.rows.map(({ record: { line, raw, cells }, amount }): CategorizationRow => {
    const matchText = parsed.textIndexes.flatMap(index => cells[index] === undefined ? [] : [cells[index]]);
    const base = { line, raw, cells, matchText, currency: amount?.currency ?? null, grossCents: amount?.grossCents.toString() ?? null,
      netCents: null, taxCents: null, ...unsetAccount, matchedRuleId: null, matchingRuleIds: [], inclusiveTaxRateBps: null };
    if (!amount || !pack.ok) return { ...base, status: 'not-evaluated' };
    const { grossCents } = amount;
    const absolute = magnitude(grossCents);
    const normalized = matchText.map(matchKey);
    const matches = rules.filter(entry => entry.matches(normalized, grossCents, absolute)).map(entry => entry.rule);
    const [chosen] = matches;
    const matchingRuleIds = matches.map(rule => rule.id);
    if (conflictPolicy === 'fail-on-ambiguous-match' && matches.some(rule => rule.accountCode !== chosen.accountCode || rule.taxCode !== chosen.taxCode)) {
      metrics.ambiguousConflicts++;
      issues.push({ code: 'ambiguous-rule-match', message: 'Matching rules assign different account or tax codes.',
        line, column: parsed.columns!.textColumns.join(' / '), raw, matchingRuleIds });
      return { ...base, status: 'ambiguous', matchingRuleIds };
    }
    if (!chosen) {
      metrics.uncategorizedRows++;
      if (unmappedReviewThresholdCents !== null && absolute > BigInt(unmappedReviewThresholdCents)) {
        issues.push({ code: 'unmapped-high-value', message: 'This uncategorized transaction exceeds the configured absolute-gross threshold.', line, raw });
      }
      return { ...base, status: 'uncategorized', netCents: base.grossCents, taxCents: '0' };
    }
    metrics.categorizedRows++;
    const { id: matchedRuleId, accountCode, accountName, taxCode, inclusiveTaxRateBps = 0 } = chosen;
    const { netCents, taxCents } = splitInclusiveTax(grossCents, inclusiveTaxRateBps);
    return { ...base, status: 'categorized', matchedRuleId, matchingRuleIds, accountCode, accountName, taxCode, inclusiveTaxRateBps,
      netCents: netCents.toString(), taxCents: taxCents.toString() };
  });

  const formulaGuard = { categorizedCsv: [] as FormulaGuardCell[], accountSummaryCsv: [] as FormulaGuardCell[] };
  const artifacts: CategorizationResult['artifacts'] = { categorizedCsv: null, accountSummaryCsv: null, signoffHtml: null, auditJson: '' };
  let accountSummary: CategorizationResult['accountSummary'] = [];
  let currencyTotals: CategorizationResult['currencyTotals'] = [];
  if (!issues.length) {
    const groups = rollup(rows);
    const sourceHeaders = parsed.header!.cells;
    const allHeaders = [...sourceHeaders, ...appendedHeaders];
    const guardedHeaders = guardSpreadsheetRow(allHeaders, allHeaders, parsed.header!.line, formulaGuard.categorizedCsv);
    if (new Set(guardedHeaders.map(value => value.trim().toLowerCase())).size !== allHeaders.length) {
      issues.push({ code: 'guarded-header-collision', message: 'Spreadsheet protection would produce duplicate column names.', line: parsed.header!.line, raw: parsed.header!.raw });
    }
    const identities = new Map<string, string>();
    const matchedIds = new Map<string, string>();
    const categorized = rows.map(row => {
      const { line, raw, cells, currency, accountCode, accountName, taxCode, matchedRuleId, netCents, taxCents } = row;
      const protectedIdentity = JSON.stringify([currency, guardSpreadsheetCell(accountCode ?? ''), guardSpreadsheetCell(taxCode ?? '')]);
      const originalIdentity = JSON.stringify([accountCode, taxCode]);
      if (identities.has(protectedIdentity) && identities.get(protectedIdentity) !== originalIdentity) {
        issues.push({ code: 'guarded-account-collision', message: 'Spreadsheet protection would merge different account and tax code pairs.', line, raw });
      }
      identities.set(protectedIdentity, originalIdentity);
      if (matchedRuleId !== null) {
        const protectedId = guardSpreadsheetCell(matchedRuleId);
        if (matchedIds.has(protectedId) && matchedIds.get(protectedId) !== matchedRuleId) {
          issues.push({ code: 'guarded-rule-id-collision', message: 'Spreadsheet protection would merge different matched rule IDs.', line, raw });
        }
        matchedIds.set(protectedId, matchedRuleId);
      }
      return guardSpreadsheetRow([...cells, accountCode ?? '', accountName ?? '', taxCode ?? '', cents(netCents!), cents(taxCents!), matchedRuleId ?? ''],
        allHeaders, line, formulaGuard.categorizedCsv);
    });
    const summaryRows = groups.accountSummary.map(({ currency, accountCode, accountName, taxCode, rowCount, grossCents, netCents, taxCents }, index) =>
      guardSpreadsheetRow([currency ?? '', accountCode ?? '', accountName ?? '', taxCode ?? '', String(rowCount), cents(grossCents), cents(netCents), cents(taxCents)],
        summaryHeaders, index + 2, formulaGuard.accountSummaryCsv));
    if (!issues.length) {
      const categorizedCsv = verifiedCsv(guardedHeaders, categorized);
      const accountSummaryCsv = verifiedCsv(summaryHeaders, summaryRows);
      if (categorizedCsv === null || accountSummaryCsv === null) {
        issues.push({ code: 'csv-roundtrip-mismatch', message: 'The guarded CSVs did not preserve the expected cells when re-parsed.' });
      } else {
        ({ accountSummary, currencyTotals } = groups);
        const csvDigests = await Promise.all([
          fingerprint({ filename: categorizationFilenames.categorizedCsv, bytes: categorizedCsv }),
          fingerprint({ filename: categorizationFilenames.accountSummaryCsv, bytes: accountSummaryCsv }),
        ]);
        const signoffHtml = renderCategorizationSignoff({ metrics, rows, accountSummary, currencyTotals, custody }, csvDigests, conflictPolicy!, branding);
        custody.outputs = [...csvDigests, await fingerprint({ filename: categorizationFilenames.signoffHtml, bytes: utf8.encode(signoffHtml) })];
        Object.assign(artifacts, { categorizedCsv, accountSummaryCsv, signoffHtml });
      }
    }
  }
  const status: CategorizationResult['status'] = issues.length ? 'blocked' : 'ready';
  const { encoding, blankLines, columns: sourceColumns } = parsed;
  const report = { status, encoding, issues, metrics, accountSummary, currencyTotals, rows, custody } as const;
  artifacts.auditJson = json({ version: 1, ...report, sourceHeader: parsed.header ?? null, sourceColumns, conflictPolicy, unmappedReviewThresholdCents, blankLines, formulaGuard });
  return { ...report, artifacts };
}
