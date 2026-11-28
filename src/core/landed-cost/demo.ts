import type { LandedCostOptions } from './types';

export const containerDemoCsv = [
  'SKU,Quantity,FOB Unit Cost,Unit Weight Kg,Unit Volume CBM,Duty Rate %,HS Code,Description',
  '00042,3,11.11,0.50,0.04,5.25,6912.00,Stoneware set',
  '00007,7,3.99,1.25,0.09,7.50,6302.60,Cotton towels',
  '00901,11,2.47,0.20,0.015,0,3924.90,Storage tray',
].join('\n') + '\n';

export const containerDemoOptions = {
  currency: 'USD',
  method: 'by-value',
  dutyBase: 'CIF',
  freightCents: '10103',
  insuranceCents: '211',
  handlingCents: '307',
  otherChargesCents: '19',
} as const satisfies LandedCostOptions;
