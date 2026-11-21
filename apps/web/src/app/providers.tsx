import { WhombatClientProvider } from '@whombat/client/react';
import type { Edition } from '@whombat/protocol/session';
import { createContext, type ReactNode, useContext, useMemo, useSyncExternalStore } from 'react';
import { ToastProvider } from '../components/Toast';
import { AttachmentSourceProvider } from '../features/messaging/attachmentSource';
import type { AppServices } from './services';
import { ThemeProvider } from './theme';

const AppServicesContext = createContext<AppServices | null>(null);

/** The managed context when running over an appliance session, else null (works outside <Providers> too). */
export function useManaged(): AppServices['managed'] {
  return useContext(AppServicesContext)?.managed ?? null;
}

/**
 * The open box's edition (HE-58; AP-5429): what its page learnt before connecting, else what the session's welcome says
 * (`commercial` until one opened, and in fixture mode). A community box has no relay, control, remote help, licence or
 * phone push, so what needs them isn't shown.
 */
export function useEdition(): Edition {
  const services = useContext(AppServicesContext);
  const session = services?.managed ? services.session : null;
  const said = useSyncExternalStore(
    (change) => (session ? session.onState(change) : () => {}),
    () => {
      const s = session?.state();
      return s?.status === 'open' ? s.info.edition : null;
    },
  );
  return services?.managed?.edition ?? said ?? 'commercial';
}

/** Whether the open box is the community edition (`useEdition`). */
export function useCommunity(): boolean {
  return useEdition() === 'community';
}

/** The app's services, or null outside <Providers> (stories, isolated component tests). */
export function useOptionalAppServices(): AppServices | null {
  return useContext(AppServicesContext);
}

/** The app's services (client, realtime, query cache, fixture flag). */
export function useAppServices(): AppServices {
  const services = useContext(AppServicesContext);
  if (!services) throw new Error('useAppServices must be used inside <Providers>');
  return services;
}

/**
 * App-wide providers: data (`@whombat/client` + TanStack Query), theme and toasts. The socket is
 * opened by the burrow shell once it knows which burrow to connect to (`connect={false}` here).
 */
export function Providers({ services, children }: { services: AppServices; children: ReactNode }) {
  const attachmentSource = useMemo(
    () =>
      services.resources
        ? ({ mode: 'session', session: services.session, resources: services.resources } as const)
        : ({ mode: 'url' } as const),
    [services],
  );
  return (
    <AppServicesContext.Provider value={services}>
      <WhombatClientProvider
        client={services.client}
        realtime={services.realtime}
        queryClient={services.queryClient}
        connect={false}
        commands={services.managed ? services.commands : null}
      >
        <AttachmentSourceProvider value={attachmentSource}>
          <ThemeProvider>
            <ToastProvider>{children}</ToastProvider>
          </ThemeProvider>
        </AttachmentSourceProvider>
      </WhombatClientProvider>
    </AppServicesContext.Provider>
  );
}
