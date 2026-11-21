/**
 * Cards harness (dev only, served by Vite at `/visual/cards.html`). Renders `<MessageCard>` inside the
 * app's providers and a router, in the geometry of a conversation's message column (the card column
 * is 762px wide at 1440px, so cards sit at their 640px max-width; the thread pane column is 308px).
 *
 *   /visual/cards.html?theme=dark                         every card state from `cardStates.ts` (fixtures)
 *   /visual/cards.html?states=plan,run                    only those states
 *   /visual/cards.html?live=chat                          your Chat's cards, live over the socket
 *   /visual/cards.html?live=pr/482                        a branch room's cards
 *   /visual/cards.html?states=guide-welcome&width=358     a narrower column (a phone's message column)
 *
 * Live mode needs a signed-in session on the same origin (sign in at `/login` first) and a server.
 */
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { useBootstrap, useMessagesInfinite, usePullRequest, useSubscription } from '@whombat/client/react';
import type { MessageCard as MessageCardData } from '@whombat/core';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/app/global.css';
import { Providers } from '../src/app/providers';
import { createAppServices } from '../src/app/services';
import { useBurrowRealtime } from '../src/app/shell/hooks';
import { applyTheme, writeStoredTheme } from '../src/app/theme';
import { MessageCard } from '../src/features/cards';
import { CARD_STATES, type CardStateName } from '../src/features/cards/cardStates';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const live = params.get('live');
const burrow = params.get('burrow') ?? 'burrow-hq';
writeStoredTheme(theme);
applyTheme(theme);

const width = Number(params.get('width')) || 762;
const column = { width, display: 'flex', flexDirection: 'column', gap: 9 } as const;
const threadColumn = { ...column, width: 308, gap: 6 } as const;

function Gallery() {
  const wanted = params.get('states')?.split(',') as CardStateName[] | undefined;
  const names = wanted ?? (Object.keys(CARD_STATES) as CardStateName[]);
  // The shell has loaded the bootstrap before any screen renders; do the same here.
  const boot = useBootstrap({ params: { burrow } });
  if (!boot.data) return null;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
        padding: width < 500 ? '20px 16px' : '28px 32px',
      }}
    >
      {names.map((name) => (
        <div key={name} data-state={name} style={name === 'answer-thread' ? threadColumn : column}>
          <MessageCard
            burrow={burrow}
            card={CARD_STATES[name] as MessageCardData}
            messageId={`msg_${name}`}
            conversationId="cnv_dm-dusty"
            variant={name === 'answer-thread' ? 'thread' : 'message'}
          />
        </div>
      ))}
    </div>
  );
}

function LiveCards({ target }: { target: string }) {
  const boot = useBootstrap({ params: { burrow } });
  useBurrowRealtime(burrow, boot.data?.realtime.topics);
  const pr = target.startsWith('pr/') ? Number(target.slice(3)) : null;
  const room = usePullRequest(pr !== null ? { params: { burrow, number: pr } } : null);
  // Not a branch room: the person's own room of that name (`chat` or `feedback`).
  const own = boot.data?.sidebar.dms.find((s) => s.link.type === 'dm' && (s.link.room ?? 'chat') === target);
  const conversationId = pr === null ? (own?.id ?? null) : (room.data?.pr.conversationId ?? null);
  useSubscription(conversationId ? `conv:${conversationId}` : undefined);
  const history = useMessagesInfinite(conversationId ? { params: { burrow, conversationId } } : null);
  const messages = [...(history.data?.pages ?? [])].reverse().flatMap((p) => p.messages);
  if (!boot.data) return <p style={{ padding: 32 }}>Loading… (sign in at /login first)</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28, padding: '28px 32px' }}>
      {messages.map(
        (m) =>
          m.card && (
            <div key={m.id} data-message={m.id} data-state={m.card.kind} style={column}>
              <MessageCard burrow={burrow} card={m.card} messageId={m.id} conversationId={m.conversationId} />
            </div>
          ),
      )}
    </div>
  );
}

function Harness() {
  const [services] = useState(() => createAppServices({ fixtures: live === null }));
  const [router] = useState(() => {
    const rootRoute = createRootRoute({
      component: () => (live === null ? <Gallery /> : <LiveCards target={live} />),
    });
    return createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ['/'] }),
      notFoundMode: 'root',
    });
  });
  if (import.meta.env.DEV) {
    (window as unknown as { __CARDS__: unknown }).__CARDS__ = { services, router };
  }
  return (
    <Providers services={services}>
      <RouterProvider router={router} />
    </Providers>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
