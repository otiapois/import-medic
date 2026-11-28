import { reconcilePayouts } from '../../../core/reconciliation/payout-matcher';
import type { ReconciliationResult } from '../../../core/reconciliation/payout-matcher';
import type { ReconciliationMessage, ReconciliationPreview, ReconciliationReply } from './reconciliationWorker';

const scope = self as unknown as {
  onmessage: (event: MessageEvent<ReconciliationMessage>) => void;
  postMessage: (reply: ReconciliationReply, transfer?: Transferable[]) => void;
};

let rows: Pick<ReconciliationResult, 'pairs' | 'exceptions'> | undefined;

async function readFile(file: File) {
  return { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

scope.onmessage = ({ data: { id, request } }) => {
  void (async () => {
    try {
      if (request.type === 'reconcile') {
        const { payouts, bank, ...settings } = request.job;
        const [payoutSource, bankSource] = await Promise.all([readFile(payouts), readFile(bank)]);
        const { pairs, exceptions, status, summary, artifacts } = await reconcilePayouts({
          ...settings, payouts: payoutSource, bank: bankSource,
        });
        rows = { pairs, exceptions };
        const value = { status, summary, artifacts } satisfies ReconciliationPreview;
        scope.postMessage({ id, value }, Object.values(artifacts).map(({ bytes }) => bytes.buffer));
        return;
      }
      if (!rows) throw new Error('Wait for the current reconciliation.');
      const { type, page, pageSize } = request;
      const start = page * pageSize;
      if (type === 'pairs') {
        scope.postMessage({ id, value: { rows: rows.pairs.slice(start, start + pageSize), total: rows.pairs.length, page } });
      } else {
        scope.postMessage({ id, value: { rows: rows.exceptions.slice(start, start + pageSize), total: rows.exceptions.length, page } });
      }
    } catch (error) {
      scope.postMessage({ id, error: error instanceof Error ? error.message : 'Local reconciliation could not finish.' });
    }
  })();
};
