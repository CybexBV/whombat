import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Message, MessagePage } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { createWebFixtureFetch, FIXTURE_BASE_URL } from '../../app/fixtureFetch';
import { DEFAULT_CHAT_ID } from '../../app/oneFixtures';
import { pinMockDate } from '../../test/clock';
import { mockedServices, renderApp } from '../../test/renderApp';

pinMockDate();

/** The agent's backups note in Chat (`chatChannelFixtures.ts`). */
const SHORT = 'msg_chat-backups';
const hint = { hint: 'what the run changes', requestedById: null, requestedAt: null };

/** The fixture world, with the agent's backups note in Chat offering more and `messages.more` answered. */
function worldWithOffer() {
  const world = createWebFixtureFetch();
  const asked: string[] = [];
  let message: Message | null = null;
  const fetch: typeof globalThis.fetch = async (raw, init) => {
    // The real client calls relative paths; the fixture world wants a whole URL.
    const input = raw instanceof Request ? raw : new URL(String(raw), FIXTURE_BASE_URL).href;
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    if (req.method === 'POST' && path.endsWith(`/messages/${SHORT}/more`)) {
      asked.push(SHORT);
      const more = { ...hint, requestedById: 'prn_mara', requestedAt: '2026-09-23T09:30:00.000Z' };
      return Response.json({ message: { ...(message as Message), more } });
    }
    const res = await world(input, init);
    // Its thread, where Chat shows it (chat-inbox-web.md).
    if (req.method === 'GET' && path.endsWith(`/messages/${SHORT}/thread`)) {
      const thread = (await res.json()) as { root: Message };
      message = { ...thread.root, more: hint };
      return Response.json({ ...thread, root: message });
    }
    if (req.method !== 'GET' || !path.endsWith(`/conversations/${DEFAULT_CHAT_ID}/messages`)) return res;
    const page = (await res.json()) as MessagePage;
    const messages = page.messages.map((m) => {
      if (m.id !== SHORT) return m;
      message = { ...m, more: hint };
      return message;
    });
    return Response.json({ ...page, messages });
  };
  return { fetch, asked };
}

describe('More detail', () => {
  it('shows under an agent’s short reply that offers it, asks once and goes', async () => {
    const { fetch, asked } = worldWithOffer();
    renderApp('/chat', mockedServices(fetch));
    await userEvent.setup().click(await screen.findByRole('link', { name: /^Last night’s backups ran/ }));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    // The message itself (the head says its first line too).
    const row = (await within(pane).findAllByText(/^Last night’s backups ran/))
      .map((el) => el.closest('article'))
      .find(Boolean);
    if (!row) throw new Error('no row');
    const more = within(row as HTMLElement).getByRole('button', { name: 'More detail' });
    // Only the message that offered it.
    expect(screen.getAllByRole('button', { name: 'More detail' })).toHaveLength(1);

    await userEvent.setup().click(more);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'More detail' })).toBeNull());
    expect(asked).toEqual([SHORT]);
  });
});
