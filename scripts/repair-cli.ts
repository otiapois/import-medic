import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { sha256, type RepairCustody } from '../src/core/audit/custody';
import { PLATFORM_IDS, repairCsvWithBytes } from '../src/core/index';

const usage = `Usage: npm run repair-cli -- --platform <${PLATFORM_IDS.join('|')}> <input.csv>
  --output <repaired.csv>              Write CSV to a new file (default: stdout)
  --audit <audit.json>                 Write JSON audit to a new file
  --date-order <auto|MDY|DMY>           Source date order
  --qbo-layout <3col|4col>               QuickBooks output layout
  --qbo-credit-debit <auto|bank|intuit>  Source Credit/Debit convention
  --stripe-paypal-output <accounting|quickbooks-3col>
  --stripe-paypal-fee-convention <auto|deduction|signed-movement>
  --exclude-paypal-memo                 Exclude PayPal rows without balance impact`;

const cliOptions = z.object({
  platform: z.enum(PLATFORM_IDS),
  dateOrder: z.enum(['auto', 'MDY', 'DMY']).optional(),
  qboLayout: z.enum(['3col', '4col']).optional(),
  qboCreditDebit: z.enum(['auto', 'bank', 'intuit']).optional(),
  stripePayPalOutput: z.enum(['accounting', 'quickbooks-3col']).optional(),
  stripePayPalFeeConvention: z.enum(['auto', 'deduction', 'signed-movement']).optional(),
  excludePayPalMemo: z.boolean().optional(),
});

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      platform: { type: 'string' },
      output: { type: 'string' },
      audit: { type: 'string' },
      'date-order': { type: 'string' },
      'qbo-layout': { type: 'string' },
      'qbo-credit-debit': { type: 'string' },
      'stripe-paypal-output': { type: 'string' },
      'stripe-paypal-fee-convention': { type: 'string' },
      'exclude-paypal-memo': { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (positionals.length !== 1) throw new Error('Provide exactly one CSV input path. Run with --help for available options.');

  const { platform, ...options } = cliOptions.parse({
    platform: values.platform,
    dateOrder: values['date-order'],
    qboLayout: values['qbo-layout'],
    qboCreditDebit: values['qbo-credit-debit'],
    stripePayPalOutput: values['stripe-paypal-output'],
    stripePayPalFeeConvention: values['stripe-paypal-fee-convention'],
    excludePayPalMemo: values['exclude-paypal-memo'],
  });
  const input = positionals[0];
  const sourceBytes = readFileSync(input);
  const { result, verifiedBytes } = repairCsvWithBytes(sourceBytes, basename(input), platform, options, []);
  if (values.audit) {
    const [sourceSha256, repairedCsvSha256] = await Promise.all([
      sha256(sourceBytes),
      verifiedBytes ? sha256(verifiedBytes) : undefined,
    ]);
    const custody: RepairCustody = { sourceSha256, repairedCsvSha256 };
    const { repairedCsv, rows, ...audit } = result;
    writeFileSync(values.audit, `${JSON.stringify({ ...audit, rowCount: rows.length, custody }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  if (verifiedBytes) {
    if (values.output) writeFileSync(values.output, verifiedBytes, { flag: 'wx' });
    else process.stdout.write(verifiedBytes);
  }
  process.stderr.write(`${result.rows.length} data rows, ${result.removedRows.length} removed, ${result.needsManualReviewCount} review items. ${result.canDownload ? 'CSV export validated.' : 'CSV export blocked.'}\n`);
  if (result.needsManualReviewCount > 0) process.exitCode = 2;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
