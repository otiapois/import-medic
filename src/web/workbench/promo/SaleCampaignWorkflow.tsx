import { lazy, Suspense, useId, useState } from 'react';
import type { ComponentProps } from 'react';
import PromoCampaignPanel from './PromoCampaignPanel';

const WholesalePanel = lazy(() => import('../wholesale/WholesalePanel'));

export default function SaleCampaignWorkflow({ active, ...promo }: ComponentProps<typeof PromoCampaignPanel> & { active: boolean }) {
  const id = useId();
  const [wholesale, setWholesale] = useState(false);
  const [wholesaleVisited, setWholesaleVisited] = useState(false);

  return (
    <>
      <div className="price-section campaign-workflow">
        <div className="price-platform-toggle" role="group" aria-label="Sale campaign workflow">
          <button type="button" aria-pressed={!wholesale} aria-controls={`${id}-retail`}
            onClick={() => setWholesale(false)}>Retail Promo Pack</button>
          <button type="button" aria-pressed={wholesale} aria-controls={`${id}-wholesale`}
            onClick={() => { setWholesaleVisited(true); setWholesale(true); }}>Wholesale B2B Line-Sheet</button>
        </div>
      </div>
      <div id={`${id}-retail`} hidden={wholesale}><PromoCampaignPanel {...promo} /></div>
      <div id={`${id}-wholesale`} hidden={!wholesale}>
        {wholesaleVisited ? (
          <Suspense fallback={<p className="price-section" role="status">Opening Wholesale B2B Line-Sheet…</p>}>
            <WholesalePanel active={active && wholesale} initialPlatform={promo.initialPlatform} />
          </Suspense>
        ) : null}
      </div>
    </>
  );
}
