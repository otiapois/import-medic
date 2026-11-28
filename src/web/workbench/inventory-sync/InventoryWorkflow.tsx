import { lazy, Suspense, useId, useState } from 'react';
import InventorySyncPanel from './InventorySyncPanel';

const PurchaseOrderPanel = lazy(() => import('../purchase-order/PurchaseOrderPanel'));
const LandedCostPanel = lazy(() => import('../landed-cost/LandedCostPanel'));

type InventoryView = 'update' | 'po' | 'landed-cost';

export default function InventoryWorkflow({ active, characterKeys }: { active: boolean; characterKeys: boolean }) {
  const id = useId();
  const [view, setView] = useState<InventoryView>('update');
  const [plannerVisited, setPlannerVisited] = useState(false);
  const [landedCostVisited, setLandedCostVisited] = useState(false);

  return (
    <>
      <div className="price-section inventory-workflow" role="group" aria-label="Inventory workflow">
        <button type="button" className="button button-secondary button-small" aria-pressed={view === 'update'}
          aria-controls={`${id}-update`} onClick={() => setView('update')}>Inventory Update</button>
        <button type="button" className="button button-secondary button-small" aria-pressed={view === 'po'}
          aria-controls={`${id}-po`} onClick={() => { setPlannerVisited(true); setView('po'); }}>Reorder PO Pack</button>
        <button type="button" className="button button-secondary button-small" aria-pressed={view === 'landed-cost'}
          aria-controls={`${id}-landed-cost`} onClick={() => { setLandedCostVisited(true); setView('landed-cost'); }}>Landed Cost Calculator</button>
      </div>
      <div id={`${id}-update`} hidden={view !== 'update'}>
        <InventorySyncPanel characterKeys={characterKeys} />
      </div>
      <div id={`${id}-po`} hidden={view !== 'po'}>
        {plannerVisited ? (
          <Suspense fallback={<p className="price-section" role="status">Opening Reorder PO Pack…</p>}>
            <PurchaseOrderPanel active={active && view === 'po'} />
          </Suspense>
        ) : null}
      </div>
      <div id={`${id}-landed-cost`} hidden={view !== 'landed-cost'}>
        {landedCostVisited ? (
          <Suspense fallback={<p className="price-section" role="status">Opening Landed Cost Calculator…</p>}>
            <LandedCostPanel active={active && view === 'landed-cost'} />
          </Suspense>
        ) : null}
      </div>
    </>
  );
}
