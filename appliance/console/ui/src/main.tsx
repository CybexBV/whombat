import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type AppProps } from './App';
import { httpClient } from './lib/client';
import { outputsFromHash } from './lib/outputs';
import { followPointer } from './lib/pointer';
import { tokenFromHash } from './lib/token';
import './styles.css';

async function boot() {
  followPointer(document.documentElement, window);
  const root = createRoot(document.getElementById('root') as HTMLElement);
  let props: AppProps | null = null;
  // Fixture mode: dev server only. `import.meta.env.DEV` is false in `vite build`, so this block and the demo
  // module are not in the production bundle.
  if (import.meta.env.DEV) {
    const name = new URLSearchParams(location.search).get('demo');
    if (name !== null) {
      const demo = await import('./demo/demo');
      const f = demo.FIXTURES[name];
      if (!f) {
        root.render(
          <StrictMode>
            <demo.DemoIndex />
          </StrictMode>,
        );
        return;
      }
      props = {
        client: demo.demoClient(f),
        wizard: f.wizard,
        idleMs: f.idleMs,
        desk: f.desk,
        wifi: f.wifiSheet,
        bluetooth: f.bluetoothSheet,
        remoteHelp: f.remoteHelpSheet,
        outputs: outputsFromHash(location.hash) ?? f.outputs ?? null,
      };
    }
  }
  props ??= { client: httpClient(tokenFromHash(location.hash)), outputs: outputsFromHash(location.hash) };
  root.render(
    <StrictMode>
      <App {...props} />
    </StrictMode>,
  );
}

void boot();
