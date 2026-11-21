import { type QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react';
import type { WhombatClient } from '../http/client';
import { connectRealtimeToQueryClient } from '../query/connect';
import { createQueries, type WhombatQueries } from '../query/options';
import type { Realtime } from '../realtime/realtime';
import type { CommandTracker } from '../session/commands';
import { wentThrough } from '../session/types';

export interface WhombatContextValue {
  client: WhombatClient;
  /** Null when the app runs without a socket (tests, logged-out screens). */
  realtime: Realtime | null;
  queries: WhombatQueries;
  /** Durable command states of mutations started here (managed sessions, AP-14); null when not tracked. */
  commands: CommandTracker | null;
}

const WhombatContext = createContext<WhombatContextValue | null>(null);

export interface WhombatClientProviderProps {
  client: WhombatClient;
  realtime?: Realtime | null;
  /** Renders a `QueryClientProvider` too; omit when one is already above. */
  queryClient?: QueryClient;
  /** Open the socket while mounted (default true). */
  connect?: boolean;
  /** Track durable command states (sends show Sending… / Not confirmed yet). */
  commands?: CommandTracker | null;
  children?: ReactNode;
}

/**
 * Provides the HTTP client, realtime client and query factories, and pipes realtime events into the
 * TanStack Query cache while mounted.
 */
export function WhombatClientProvider({
  client,
  realtime = null,
  queryClient,
  connect = true,
  commands = null,
  children,
}: WhombatClientProviderProps) {
  const value = useMemo(
    () => ({ client, realtime, queries: createQueries(client), commands }),
    [client, realtime, commands],
  );
  const inner = (
    <WhombatContext.Provider value={value}>
      <RealtimeBridge realtime={realtime} connect={connect} />
      <WentThroughRefresh />
      {children}
    </WhombatContext.Provider>
  );
  return queryClient ? <QueryClientProvider client={queryClient}>{inner}</QueryClientProvider> : inner;
}

function RealtimeBridge({ realtime, connect }: { realtime: Realtime | null; connect: boolean }) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!realtime) return;
    const off = connectRealtimeToQueryClient(realtime, qc);
    if (connect) realtime.connect();
    return () => {
      off();
      if (connect) realtime.disconnect();
    };
  }, [realtime, qc, connect]);
  return null;
}

/** Answers lost together (after a reconnect) arrive within this window: they make one refetch. */
const WENT_THROUGH_REFRESH_MS = 50;

/**
 * A mutation that went through but whose answer isn't kept (`wentThrough`, CT-195) changed something nobody saw:
 * refetch what is on screen (active queries; the rest are marked stale), AP-580 — once for a burst, not per mutation.
 */
function WentThroughRefresh() {
  const qc = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = qc.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error' || !wentThrough(event.action.error))
        return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void qc.invalidateQueries();
      }, WENT_THROUGH_REFRESH_MS);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [qc]);
  return null;
}

/** The Whombat client, realtime client and query factories. */
export function useWhombat(): WhombatContextValue {
  const value = useContext(WhombatContext);
  if (!value) throw new Error('useWhombat() must be used inside <WhombatClientProvider>');
  return value;
}
