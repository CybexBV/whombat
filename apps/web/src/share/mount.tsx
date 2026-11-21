/**
 * Starting the page a shared link opens (`/s/<id>#<key>`, docs/decisions/share-links.md): only this page's code loads,
 * never the app's session or sign-in. The hosted app reads the copy from control; fixture mode seals a sample here so
 * the page can be looked at without one.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { controlFetcher, SharedView } from './SharedView';

export async function startSharedPage(target: HTMLElement, options: { fixtures: boolean }) {
  // Nothing about a shared copy belongs in a search engine or another site's logs.
  for (const [name, content] of [
    ['robots', 'noindex, nofollow'],
    ['referrer', 'no-referrer'],
  ] as const) {
    const meta = document.createElement('meta');
    meta.name = name;
    meta.content = content;
    document.head.append(meta);
  }
  const fetchBytes = options.fixtures
    ? (await import('./fixture')).fixtureSharedFetcher(window.location)
    : controlFetcher(import.meta.env.VITE_WHOMBAT_CONTROL_URL ?? 'https://api.whombat.com');
  createRoot(target).render(
    <StrictMode>
      <SharedView fetchBytes={fetchBytes} />
    </StrictMode>,
  );
}
