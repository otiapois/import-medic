import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Workbench } from './Workbench';
import { PriceDiffWorkbench } from './workbench/PriceDiffWorkbench';
import { platformPages, SHOPIFY_PRICE_UPDATE_PATH } from './seo/routes';
import type { Page } from './seo/routes';

const ShortcutsDialog = lazy(() => import('./ShortcutsDialog'));

const reviewLabels = {
  auto: 'Automatic formatting',
  conditional: 'Check the input and settings',
  manual: 'Manual review',
};

export function App({ page }: { page: Page }) {
  const priceStudio = page.path === SHOPIFY_PRICE_UPDATE_PATH;
  const shortcutsButton = useRef<HTMLButtonElement>(null);
  const [shortcutOrigin, setShortcutOrigin] = useState<HTMLElement>();
  const [characterKeys, setCharacterKeys] = useState(true);
  useEffect(() => {
    if (!characterKeys || shortcutOrigin) return;
    function handleShortcut(event: KeyboardEvent) {
      if ((event.key !== '?' && event.key !== '/') || event.defaultPrevented || event.isComposing || event.repeat ||
        event.altKey || event.ctrlKey || event.metaKey || document.designMode === 'on' || document.querySelector('dialog[open]')) return;
      const { target } = event;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, select, textarea, [role="textbox"], [role="combobox"]'))) return;
      if (event.key === '?') {
        const focused = document.activeElement;
        const origin = focused instanceof HTMLElement && focused !== document.body ? focused : shortcutsButton.current;
        if (!origin) return;
        event.preventDefault();
        setShortcutOrigin(origin);
      } else {
        const search = document.querySelector<HTMLInputElement>('[data-price-row-search]');
        if (!search || search.closest('[hidden]')) return;
        event.preventDefault();
        search.focus();
      }
    }
    document.addEventListener('keydown', handleShortcut);
    return () => document.removeEventListener('keydown', handleShortcut);
  }, [characterKeys, shortcutOrigin]);
  const sources = new Map(page.examples.flatMap((example) => (
    example.sources.map(({ url, title }) => [url, title] as const)
  )));

  return (
    <>
      <header className="site-header">
        <div className="site-header-inner">
          <a className="site-brand" href="/" aria-label="ImportMedic">ImportMedic</a>
          <nav className="site-nav" aria-label="CSV fixers">
            {platformPages.map(({ path, label }) => (
              <a href={path} key={path} aria-current={page.path === path ? 'page' : undefined}>{label}</a>
            ))}
          </nav>
        </div>
      </header>
      <main className="site-content">
        <div className="site-intro">
          <h1>{page.heading}</h1>
          <p>{page.description}</p>
        </div>
        {priceStudio ? <PriceDiffWorkbench characterKeys={characterKeys} /> : <Workbench initialPlatform={page.platform} />}
        <div className="site-guidance">
          <section aria-labelledby="examples-heading">
            <h2 id="examples-heading">CSV repair examples</h2>
            <table className="site-example-table" aria-labelledby="examples-heading">
              <thead>
                <tr><th scope="col">Before</th><th scope="col">After or action</th></tr>
              </thead>
              {page.examples.map((example) => {
                const path = `/fix/${example.slug}`;
                return (
                  <tbody key={`${example.platform}:${example.code}`}>
                    <tr>
                      <th scope="rowgroup" colSpan={2}>
                        {example.slug && path !== page.path ? <a href={path}>{example.title}</a> : example.title}
                        <p>{example.trigger}</p>
                        <p>{reviewLabels[example.fixMode]}</p>
                      </th>
                    </tr>
                    <tr><td><code>{example.before}</code></td><td><code>{example.after}</code></td></tr>
                  </tbody>
                );
              })}
            </table>
          </section>
          <section className="site-faq" aria-labelledby="faq-heading">
            <h2 id="faq-heading">Frequently asked questions</h2>
            {page.faq.map(({ question, answer }) => (
              <details key={question}>
                <summary>{question}</summary>
                <p>{answer}</p>
              </details>
            ))}
          </section>
          <section aria-labelledby="references-heading">
            <h2 id="references-heading">Import documentation and reports</h2>
            <ul>
              {[...sources].map(([url, title]) => <li key={url}><a href={url}>{title}</a></li>)}
            </ul>
          </section>
        </div>
      </main>
      <footer className="site-footer">
        <span>ImportMedic · Local CSV repair</span>
        <button ref={shortcutsButton} type="button" className="text-button" data-testid="shortcuts-open"
          aria-haspopup="dialog" aria-keyshortcuts={characterKeys ? '?' : undefined}
          onClick={(event) => setShortcutOrigin(event.currentTarget)}>Shortcuts (?)</button>
      </footer>
      {shortcutOrigin ? (
        <Suspense>
          <ShortcutsDialog priceStudio={priceStudio} characterKeys={characterKeys} onChangeCharacterKeys={setCharacterKeys}
            onClose={() => {
              flushSync(() => setShortcutOrigin(undefined));
              const origin = shortcutOrigin.isConnected && !shortcutOrigin.closest('[hidden]') ? shortcutOrigin : shortcutsButton.current;
              origin?.focus({ preventScroll: true });
            }} />
        </Suspense>
      ) : null}
    </>
  );
}
