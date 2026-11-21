/**
 * Chat after the UI refresh (docs/decisions/ui-refresh-chat.md): a question that waits says so on its row and opens at
 * the answer (chat-inbox-web.md), a room thread has one way out that names where it was opened from, the model's mark shows only where it
 * changed, and the composer's send fills only once there is something to send.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FIRMWARE_THREAD, PVE_THREAD, UPDATES_THREAD } from '../../app/chatChannelFixtures';
import { fixtureServices, renderApp } from '../../test/renderApp';

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const room = () => screen.findByRole('region', { name: 'Chat' });
/** A thread's row in the room's list (chat-inbox-web.md). */
const rootRow = async (id: string) =>
  waitFor(() => {
    const row = document.querySelector<HTMLElement>(`[data-root-id="${id}"]`);
    if (!row) throw new Error(`no row ${id}`);
    return row;
  });

describe('a question that waits for the person', () => {
  it('says “Waiting for you” once on each row that waits, and opening it goes to the answer', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat', fixtureServices({}));
    await room();
    const updates = await rootRow(UPDATES_THREAD);
    await waitFor(() => expect(within(updates).getAllByText('Waiting for you')).toHaveLength(1));
    expect(within(updates).getByRole('link').getAttribute('aria-label')).toMatch(/waiting for you$/);
    // pve-02's approval waits in its thread; the firmware question waits for nobody.
    expect(within(await rootRow(PVE_THREAD)).getByText('Waiting for you')).toBeTruthy();
    expect(within(await rootRow(FIRMWARE_THREAD)).queryByText('Waiting for you')).toBeNull();

    await user.click(within(updates).getByRole('link'));
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${UPDATES_THREAD}`));
    // The question is the words of a message, not a card: the reply box takes the answer.
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(pane).getByRole('textbox', { name: 'Reply to Neo…' })),
    );
  });

  it('opening a thread that waits on a card goes to the card’s first button', async () => {
    const user = userEvent.setup();
    renderApp('/chat', fixtureServices({}));
    await room();
    const pve = await rootRow(PVE_THREAD);
    await user.click(within(pve).getByRole('link'));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    await waitFor(() =>
      expect(document.activeElement?.closest('[data-thread-card]')).toBe(
        pane.querySelector('[data-thread-card]'),
      ),
    );
  });
});

describe('a room thread’s one way out', () => {
  it('names its room by default: no close button, the reply count in its head, Escape goes back', async () => {
    const user = userEvent.setup();
    const app = renderApp(`/chat?thread=${PVE_THREAD}`, fixtureServices({}));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    const back = await within(pane).findByRole('link', { name: 'Back to Chat' });
    expect(back.textContent).toBe('Chat');
    expect(back.getAttribute('href')).toBe('/chat');
    expect(within(pane).queryByRole('button', { name: 'Close thread' })).toBeNull();
    // The question is the head's title (shown once the first message scrolls away).
    expect(
      await within(pane).findByRole('heading', { name: 'Why is pve-02 using so much memory?' }),
    ).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(app.location()).toBe('/chat'));
  });

  it('goes back to the page it was opened from, by its link and by Escape', async () => {
    const user = userEvent.setup();
    const app = renderApp('/inbox', fixtureServices({}));
    await screen.findByRole('heading', { level: 1, name: 'Inbox' });
    act(() => app.history.push(`/chat?thread=${PVE_THREAD}`));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    const back = await within(pane).findByRole('link', { name: 'Back to Inbox' });
    expect(back.getAttribute('href')).toBe('/inbox');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(app.location()).toBe('/inbox'));

    act(() => app.history.push(`/chat?thread=${PVE_THREAD}`));
    await user.click(
      await within(await screen.findByRole('complementary', { name: 'Thread' })).findByRole('link', {
        name: 'Back to Inbox',
      }),
    );
    await waitFor(() => expect(app.location()).toBe('/inbox'));
  });
});

describe('what answered a reply', () => {
  it('shows the model’s mark only on the reply where it changed; every reply keeps the line on its time', async () => {
    const pane = async () => {
      renderApp('/chat?thread=msg_chat-zonneplan', fixtureServices({}));
      return screen.findByRole('complementary', { name: 'Thread' });
    };
    const thread = await pane();
    await within(thread).findByText('Will do.');
    const marks = [...thread.querySelectorAll('[data-ran-on]')];
    // The first reply ran on Opus, the second on ChatGPT: only the second carries a mark.
    expect(marks).toHaveLength(1);
    expect(marks[0]?.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe(
      'msg_chat-zonneplan-3',
    );
    const first = thread.querySelector('[data-message-id="msg_chat-zonneplan-1"] time');
    expect(first?.getAttribute('title')).toMatch(/^Claude · Opus/);
  });
});

describe('the one composer', () => {
  it('has a labelled File button and a send that fills once there is something to send', async () => {
    const user = userEvent.setup();
    renderApp('/chat?new=1', fixtureServices({}));
    const chat = await room();
    const file = within(chat).getByRole('button', { name: 'Attach a file' });
    expect(file.textContent).toBe('File');
    const send = within(chat).getByRole('button', { name: 'Send' });
    expect(send.hasAttribute('data-ready')).toBe(false);
    await user.type(within(chat).getByRole('textbox', { name: 'Ask Neo anything' }), 'Hello');
    expect(send.hasAttribute('data-ready')).toBe(true);
  });
});
