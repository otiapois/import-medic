import { createRoot, hydrateRoot } from 'react-dom/client';
import { App } from './App';
import { getPage } from './seo/routes';
import './styles.css';

const root = document.getElementById('root')!;

if (import.meta.env.DEV) {
  const page = getPage(window.location.pathname);
  document.title = page.title;
  createRoot(root).render(<App page={page} />);
} else {
  // Use the route that produced the HTML, including when a static host serves its root fallback.
  const page = getPage(root.dataset.route ?? window.location.pathname);
  hydrateRoot(root, <App page={page} />);
}
