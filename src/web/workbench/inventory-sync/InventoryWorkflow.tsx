import { lazy, Suspense, useId, useState } from 'react';
import InventorySyncPanel from './InventorySyncPanel';

const PurchaseOrderPanel = lazy(() => import('../purchase-order/PurchaseOrderPanel'));

export default function InventoryWorkflow({ active, characterKeys }: { active: boolean; characterKeys: boolean }) {
  const id = useId();
  const [planning, setPlanning] = useState(false);
  const [plannerVisited, setPlannerVisited] = useState(false);

  return (
    <>
      <div className="price-section inventory-workflow" role="group" aria-label="Inventory workflow">
        <button type="button" className="button button-secondary button-small" aria-pressed={!planning}
          aria-controls={`${id}-update`} onClick={() => setPlanning(false)}>Inventory Update</button>
        <button type="button" className="button button-secondary button-small" aria-pressed={planning}
          aria-controls={`${id}-po`} onClick={() => { setPlannerVisited(true); setPlanning(true); }}>Reorder PO Pack</button>
      </div>
      <div id={`${id}-update`} hidden={planning}>
        <InventorySyncPanel characterKeys={characterKeys} />
      </div>
      <div id={`${id}-po`} hidden={!planning}>
        {plannerVisited ? (
          <Suspense fallback={<p className="price-section" role="status">Opening Reorder PO Pack…</p>}>
            <PurchaseOrderPanel active={active && planning} />
          </Suspense>
        ) : null}
      </div>
    </>
  );
}
