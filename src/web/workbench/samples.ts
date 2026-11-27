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
} satisfies Record<PlatformId, { filename: string; lines: string[] }>;

export function getSample(platform: PlatformId) {
  const { filename, lines } = SAMPLES[platform];
  return { filename, bytes: new TextEncoder().encode(`${lines.join('\r\n')}\r\n`) };
}
