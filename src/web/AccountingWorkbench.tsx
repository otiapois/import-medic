import { lazy, Suspense, useId, useState } from 'react';
import type { PlatformId } from '../core/types';
import { Workbench } from './Workbench';
import { ModeNavigation } from './workbench/ModeNavigation';

const PayoutReconciler = lazy(() => import('./workbench/payout-reconciliation/PayoutReconciler'));

export function AccountingWorkbench({ initialPlatform }: { initialPlatform: PlatformId }) {
  const id = useId();
  const [reconcile, setReconcile] = useState(false);
  const [reconcilerVisited, setReconcilerVisited] = useState(false);

  return (
    <section className="workbench accounting-workbench" aria-label="Accounting Workbench">
      <div className="workbench-input accounting-switcher" data-open={reconcile}>
        <ModeNavigation current="repair" />
        <div className="accounting-workflow" role="group" aria-label="Accounting workflow">
          <button type="button" className="button button-secondary" aria-pressed={!reconcile}
            aria-controls={`${id}-single-file`} onClick={() => setReconcile(false)}>Single-File Bank Repair</button>
          <button type="button" className="button button-secondary" aria-pressed={reconcile}
            aria-controls={`${id}-payouts`} onClick={() => { setReconcilerVisited(true); setReconcile(true); }}>Payout vs Bank Reconciler</button>
        </div>
        <div id={`${id}-payouts`} hidden={!reconcile}>
          {reconcilerVisited ? (
            <Suspense fallback={<p className="price-section" role="status">Opening the payout reconciler…</p>}>
              <PayoutReconciler />
            </Suspense>
          ) : null}
        </div>
      </div>
      <div id={`${id}-single-file`} className="accounting-single-file" hidden={reconcile}>
        <Workbench initialPlatform={initialPlatform} accountingHome />
      </div>
    </section>
  );
}
