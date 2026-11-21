import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient } from '@tanstack/react-query';
import type { Realtime, RealtimeStatus, WhombatClient } from '@whombat/client';
import { WhombatClientProvider } from '@whombat/client/react';
import { useMemo, useState } from 'react';
import { ShellError, ShellLayout } from './ShellLayout';

/**
 * `ShellError` and the "Reconnecting…" pill (TODO 16.4), shown as units: they're reachable through
 * the full app only for a bootstrap *re*-fetch failing after an initial success (see
 * `docs/decisions/states.md` ST-09) — a first-load failure hits the router's own `ErrorPage` instead
 * (see `App/Shell`'s "Quiet states / Burrow bootstrap fails on first load" story).
 */
const meta = {
  title: 'App/Shell quiet states',
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const BurrowLoadErrorFrame: Story = {
  name: 'ShellError (burrow failed to (re)load)',
  render: () => (
    <div style={{ height: 480 }}>
      <ShellError onRetry={() => {}} />
    </div>
  ),
};

/** A realtime client whose status can be flipped from the story's own state, for `useRealtimeStatus()`. */
function fakeRealtime(initial: RealtimeStatus): Realtime & { setStatus: (s: RealtimeStatus) => void } {
  let status = initial;
  const listeners = new Set<(status: RealtimeStatus) => void>();
  return {
    connect() {},
    disconnect() {},
    reconnectNow() {},
    status: () => status,
    session: () => null,
    subscribe: () => () => {},
    topics: () => [],
    lastSeq: () => undefined,
    on: () => () => {},
    onEvent: () => () => {},
    onStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onResync: () => () => {},
    onError: () => () => {},
    setStatus(next) {
      status = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function ReconnectingDemo({ status }: { status: RealtimeStatus }) {
  const [queryClient] = useState(() => new QueryClient());
  const realtime = useMemo(() => fakeRealtime(status), [status]);
  return (
    <WhombatClientProvider
      client={{} as WhombatClient}
      realtime={realtime}
      queryClient={queryClient}
      connect={false}
    >
      <div style={{ height: 200 }}>
        <ShellLayout sidebar={<div />}>
          <div />
        </ShellLayout>
      </div>
    </WhombatClientProvider>
  );
}

export const RealtimeOpen: Story = {
  name: 'Reconnecting pill, socket open (hidden)',
  render: () => <ReconnectingDemo status="open" />,
};

export const RealtimeReconnecting: Story = {
  name: 'Reconnecting pill, socket reconnecting',
  render: () => <ReconnectingDemo status="reconnecting" />,
};

export const RealtimeClosed: Story = {
  name: 'Reconnecting pill, socket closed',
  render: () => <ReconnectingDemo status="closed" />,
};
