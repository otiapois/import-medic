import type { PlatformId } from '../../core/types';

const SAMPLES = {
  'shopify-products': {
    filename: 'shopify-products-sample.csv',
    lines: [
      'Handle,Title,Variant SKU,Variant Price',
      'Desk Lamp,Desk Lamp,LAMP-A,call for price',
      'reading-lamp,Reading Lamp,LAMP-B,$52.00',
    ],
  },
  'quickbooks-bank': {
    filename: 'quickbooks-bank-sample.csv',
    lines: [
      'Account Number,DEMO-0123',
      'Post Date,Memo,Amount',
      '03/04/2026,Studio rent,($400.00)',
      '06/07/2026,Wholesale deposit,$460.00',
      'Ending Balance,60.00',
    ],
  },
  'stripe-paypal': {
    filename: 'stripe-balance-sample.csv',
    lines: [
      'created_utc,description,gross,fee,net,currency,balance_transaction_id',
      '2026-11-24T18:31:53Z,Studio booking,105.00,3.35,pending,USD,txn_demo200',
      '2026-11-25T05:01:00Z,Workshop ticket,40.00,1.46,38.54,USD,txn_demo201',
    ],
  },
  'xero-bank': {
    filename: 'synthetic-xero-balance-break.csv',
    lines: [
      '*Date,*Amount,Payee,Description,Reference,Check Number,Running Balance,Currency',
      '2026-11-24,100.00,North Studio,Deposit,00021,,1100.00,USD',
      '2026-11-25,(45.20),Harbor Supply,Materials,00022,0009,1054.80,USD',
      '2026-11-27,-20.00,Cedar Transit,Delivery,00024,,1047.30,USD',
    ],
  },
  'freshbooks-expenses': {
    filename: 'synthetic-freshbooks-expenses.csv',
    lines: [
      'Date,Vendor,Category,Notes,Amount,Tax 1 Name,Tax 1 Amount,Currency',
      '04/05/2026,Harbor Supply,Materials,Studio materials,45.20,,,USD',
    ],
  },
} satisfies Record<PlatformId, { filename: string; lines: string[] }>;

export function getSample(platform: PlatformId) {
  const { filename, lines } = SAMPLES[platform];
  return { filename, bytes: new TextEncoder().encode(`${lines.join('\r\n')}\r\n`) };
}
