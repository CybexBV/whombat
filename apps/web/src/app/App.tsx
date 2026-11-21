import { type RouterHistory, RouterProvider } from '@tanstack/react-router';
import { bindBrowserLifecycle } from '@whombat/client/web';
import { useEffect, useState } from 'react';
import { Providers } from './providers';
import { type AppRouter, createAppRouter } from './router';
import { type AppServices, createAppServices } from './services';

export interface AppProps {
  /** Defaults to fixture mode's (`VITE_FIXTURES=1`); a box's session comes from the managed root. */
  services?: AppServices;
  /** Memory history in tests and Storybook. */
  history?: RouterHistory;
}

declare global {
  interface Window {
    /** Dev only: the running app's services and router (visual tests, debugging). */
    __WHOMBAT__?: { services: AppServices; router: AppRouter };
  }
}

export function App({ services: given, history }: AppProps) {
  const [services] = useState(() => given ?? createAppServices());
  const [router] = useState(() => createAppRouter({ services, history }));

  useEffect(() => (services.realtime ? bindBrowserLifecycle(services.realtime) : undefined), [services]);

  useEffect(() => {
    if (import.meta.env.DEV && typeof window !== 'undefined') window.__WHOMBAT__ = { services, router };
  }, [services, router]);

  return (
    <Providers services={services}>
      <RouterProvider router={router} />
    </Providers>
  );
}
