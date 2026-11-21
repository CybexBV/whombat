/**
 * Mara's Chat's cards, each a `<MessageCard>` read from the cached message list, inside the app's providers (the room's
 * seam). Chat itself lists threads, so a test of a card wired to the client renders the cards this way.
 */
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { useApproval, useBootstrap, useMessagesInfinite } from '@whombat/client/react';
import type { MessageCard as MessageCardData } from '@whombat/core';
import { burrow } from '@whombat/fixtures';
import { DEFAULT_CHAT_ID } from '../app/oneFixtures';
import { Providers } from '../app/providers';
import type { AppServices } from '../app/services';
import { MessageCard } from '../features/cards/MessageCard';

function ChatCards() {
  const boot = useBootstrap({ params: { burrow: burrow.slug } });
  const history = useMessagesInfinite({ params: { burrow: burrow.slug, conversationId: DEFAULT_CHAT_ID } });
  if (!boot.data || !history.data) return null;
  const messages = [...history.data.pages].reverse().flatMap((p) => p.messages);
  return (
    <>
      {messages.map(
        (m) =>
          m.card && (
            <MessageCard
              key={m.id}
              burrow={burrow.slug}
              card={m.card}
              messageId={m.id}
              conversationId={m.conversationId}
            />
          ),
      )}
    </>
  );
}

export function renderChatCards(services: AppServices) {
  const router = createRouter({
    routeTree: createRootRoute({ component: ChatCards }),
    history: createMemoryHistory({ initialEntries: ['/chat'] }),
    notFoundMode: 'root',
  });
  return render(
    <Providers services={services}>
      <RouterProvider router={router} />
    </Providers>,
  );
}

/** One approval as its card in Mara's Chat (a test of the card without the thread it sits in). */
function ApprovalCard({ number }: { number: number }) {
  const { data } = useApproval({ params: { burrow: burrow.slug, number } });
  if (!data) return null;
  return (
    <MessageCard
      burrow={burrow.slug}
      card={{ kind: 'approval', approval: data.approval } as MessageCardData}
      messageId={`msg_approval-${number}`}
      conversationId={DEFAULT_CHAT_ID}
    />
  );
}

export function renderApprovalCard(services: AppServices, number: number) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <ApprovalCard number={number} /> }),
    history: createMemoryHistory({ initialEntries: ['/chat'] }),
    notFoundMode: 'root',
  });
  return render(
    <Providers services={services}>
      <RouterProvider router={router} />
    </Providers>,
  );
}
