import { expect } from '@playwright/test';
import { downloadText, loadFile, test } from './browser';

interface ReviewCase {
  file: string;
  tab: string;
  blocked: boolean;
  split?: boolean;
  issues: [line: number, column: string, code: string, raw: string][];
}

const cases: ReviewCase[] = [
  {
    file: 'shopify/legacy-compare-at-price', tab: 'Shopify Products', blocked: false,
    issues: [[2, 'Variant Compare At Price', 'invalid-price', 'ask first']],
  },
  {
    file: 'shopify/tracked-blank-inventory', tab: 'Shopify Products', blocked: false,
    issues: [[2, 'Variant Inventory Qty', 'invalid-inventory-qty', '']],
  },
  {
    file: 'quickbooks/mixed-currency-bank', tab: 'QuickBooks Bank', blocked: true,
    issues: [[3, 'Currency', 'multi-currency', 'EUR']],
  },
  {
    file: 'quickbooks/mixed-currency-symbols', tab: 'QuickBooks Bank', blocked: true,
    issues: [[3, 'Amount', 'multi-currency', '€20.00']],
  },
  {
    file: 'quickbooks/ambiguous-currency-grouping', tab: 'QuickBooks Bank', blocked: false,
    issues: [[2, 'Amount', 'invalid-amount', '€1,234']],
  },
  {
    file: 'quickbooks/explicit-currency-symbol-conflict', tab: 'QuickBooks Bank', blocked: true,
    issues: [[2, 'Amount', 'invalid-amount', '€10.00']],
  },
  {
    file: 'stripe-paypal/stripe-currency-symbol-conflict', tab: 'Stripe / PayPal', blocked: true,
    issues: [[2, 'Net', 'invalid-amount', '€9.00']],
  },
  {
    file: 'stripe-paypal/paypal-bank-impact-conflict', tab: 'Stripe / PayPal', blocked: true,
    issues: [[2, 'Net', 'balance-impact-conflict', '10.00'], [3, 'Balance Impact', 'invalid-balance-impact', 'Unknown']],
  },
  {
    file: 'quickbooks/split-mixed-currency-symbols', tab: 'QuickBooks Bank', blocked: true, split: true,
    issues: [[3, 'Debit', 'multi-currency', '€20.00']],
  },
];

test('unresolved financial and catalog values survive upload, fail-closed review and audit export', async ({ page, beginProcessing }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  beginProcessing();
  for (const { file, tab, blocked, split, issues } of cases) {
    await test.step(file, async () => {
      await page.getByRole('tab', { name: tab }).click();
      if (tab === 'Stripe / PayPal') await page.getByLabel('Export format').selectOption('quickbooks-3col');
      if (split) {
        await page.getByLabel('QuickBooks output layout').selectOption('4col');
        await page.getByLabel('Credit / Debit convention').selectOption('intuit');
      }
      await loadFile(page, file + '.csv');
      await expect(page.getByTestId('manual-review-count')).toHaveText(String(issues.length));
      const button = page.getByRole('button', { name: 'Download Repaired CSV' });
      if (blocked) await expect(button).toBeDisabled();
      else {
        await expect(button).toBeEnabled();
        await expect(button).toHaveAccessibleDescription(/Draft CSV/);
      }
      const basename = file.split('/')[1];
      const audit = JSON.parse(await downloadText(page, 'Download Audit Report (.json)', basename + '.audit.json'));
      expect(audit.canDownload).toBe(!blocked);
      for (const [row, column, code, rawValue] of issues) {
        expect(audit.issues).toContainEqual(expect.objectContaining({ row, column, code, rawValue, autoFixed: false }));
      }
    });
  }
});

