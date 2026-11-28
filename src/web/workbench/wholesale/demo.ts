import baseline from '../../../../fixtures/m24/wholesale-shopify.csv?raw';
import costs from '../../../../fixtures/m24/wholesale-costs.csv?raw';
import options from '../../../../fixtures/m24/wholesale-options.json';
import type { WholesaleSettings } from './wholesaleWorker';

export function wholesaleDemo() {
  return {
    baseline: { file: new File([baseline], 'wholesale-shopify.csv', { type: 'text/csv' }), synthetic: true },
    costSheet: { file: new File([costs], 'wholesale-costs.csv', { type: 'text/csv' }), synthetic: true },
    settings: options as WholesaleSettings,
  };
}
