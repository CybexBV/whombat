import './app/strictCsp';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Fonts from this origin in every build (strict CSP, AP-23; no Google Fonts, WE-05).
import './app/fonts/fonts.css';
import './app/global.css';
import { App } from './app/App';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

/**
 * Which page this is (hermes-engine-app.md AP-5322): fixture mode's burrow app on the in-memory box; the box's own page
 * (`box`: its direct socket, no control); or the hosted app (`hosted`: the cloud account, then the box directly or
 * through the relay). Each loads only its own code.
 */
async function start(target: HTMLElement) {
  // A shared link's page (share-links.md): its own small page, before anything of the app or its session loads.
  if (
    /^\/s\/shr_/.test(window.location.pathname) &&
    (import.meta.env.VITE_FIXTURES || import.meta.env.VITE_WHOMBAT_TARGET === 'hosted')
  ) {
    const { startSharedPage } = await import('./share/mount');
    await startSharedPage(target, { fixtures: Boolean(import.meta.env.VITE_FIXTURES) });
    return;
  }
  if (import.meta.env.VITE_FIXTURES) {
    createRoot(target).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    return;
  }
  if (import.meta.env.VITE_WHOMBAT_TARGET === 'hosted') {
    const [{ ManagedApp }, { loadEnvironment }] = await Promise.all([
      import('./managed/ManagedRoot'),
      import('./managed/connect'),
    ]);
    const env = await loadEnvironment();
    createRoot(target).render(
      <StrictMode>
        <ManagedApp env={env} />
      </StrictMode>,
    );
    return;
  }
  const [{ BoxRoot }, { loadBoxEnvironment }] = await Promise.all([
    import('./managed/BoxRoot'),
    import('./managed/boxEnv'),
  ]);
  const env = await loadBoxEnvironment();
  createRoot(target).render(
    <StrictMode>
      <BoxRoot env={env} />
    </StrictMode>,
  );
}

void start(root);
