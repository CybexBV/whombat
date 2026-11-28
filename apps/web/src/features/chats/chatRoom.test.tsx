/**
 * Chat, Feedback, Settled and the Dashboard (Whombat chat-channel.md CHT-01…CHT-11, CHT-20, CHT-21; app chat-channel.md
 * AP-2401…AP-2411), against the fixture world's assistant shell with Chat (`chatChannelFixtures.ts`).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CHAT_WORDS } from '@whombat/client';
import { feedbackIntegration } from '@whombat/fixtures';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FIRMWARE_THREAD, PVE_THREAD } from '../../app/chatChannelFixtures';
import { FEEDBACK_CHAT_ID } from '../../app/feedbackChatFixtures';
import { fixtureServices, renderApp } from '../../test/renderApp';
import { THREAD_COLLAPSE_LABEL } from '../messaging/ThreadView';

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

const chatShell = (o: { feedbackSources?: boolean } = {}) => fixtureServices({ ...o });
const sidebar = () => screen.findByRole('complementary', { name: 'Sidebar' });
const room = () => screen.findByRole('region', { name: 'Chat' });

describe('the Chat shell’s sidebar and routes (AP-2401, AP-2403)', () => {
  it('opens Chat at /, with Chat · Inbox · Connections · Automations and no conversations or Ask button', async () => {
    const app = renderApp('/', chatShell());
    await waitFor(() => expect(app.location()).toBe('/chat'));
    const side = await sidebar();
    expect(within(side).getByRole('link', { name: 'Chat' }).getAttribute('aria-current')).toBe('page');
    expect(within(side).queryByRole('link', { name: 'Overview' })).toBeNull();
    expect(
      within(side)
        .getByRole('link', { name: /^Connections/ })
        .getAttribute('href'),
    ).toBe('/connected');
    expect(within(side).queryByRole('link', { name: /^Feedback/ })).toBeNull();
    expect(within(side).queryByRole('heading', { name: 'Conversations' })).toBeNull();
    expect(within(side).queryByRole('link', { name: 'Ask Neo' })).toBeNull();
    expect(await room()).toBeTruthy();
  });

  it('sends the old chat addresses to the room they are in now', async () => {
    const task = renderApp('/chats/cnv_chat-pve-02', chatShell());
    await waitFor(() => expect(task.location()).toBe('/chat'));
    task.unmount();
    const fresh = renderApp('/chats/new', chatShell());
    await waitFor(() => expect(fresh.location()).toBe('/chat'));
    fresh.unmount();
    const feedback = renderApp(`/chats/${FEEDBACK_CHAT_ID}`, chatShell({ feedbackSources: true }));
    await waitFor(() => expect(feedback.location()).toBe('/feedback'));
  });

  it('opens Connections at the Overview’s old addresses, Connections selected', async () => {
    const app = renderApp('/dashboard', chatShell());
    await waitFor(() => expect(app.location()).toBe('/connected'));
    expect(await screen.findByRole('heading', { name: 'Connections', level: 1 })).toBeTruthy();
    const side = await sidebar();
    expect(
      within(side)
        .getByRole('link', { name: /^Connections/ })
        .getAttribute('aria-current'),
    ).toBe('page');
  });
});

describe('Chat (AP-2404…AP-2406; chat-inbox-web.md)', () => {
  const row = (chat: HTMLElement, title: RegExp) => within(chat).findByRole('link', { name: title });

  it('lists each question as a row: who answered last, what waits and the one Neo is working on', async () => {
    renderApp('/chat', chatShell());
    const chat = await room();
    const pve = await row(chat, /^Why is pve-02 using so much memory\?/);
    expect(pve.getAttribute('href')).toBe(`/chat?thread=${PVE_THREAD}`);
    expect(within(pve).getByText('Waiting for you')).toBeTruthy();
    expect(within(pve).getByText(/^Neo/)).toBeTruthy();
    // No subject chip, card or button in a row: they are in the thread.
    expect(pve.querySelector('[data-subject-chip], [data-message-card], button')).toBeNull();
    const firmware = await row(chat, /^Is there new firmware for the access points\?/);
    // Working is the turning ring on its icon, and a word in its name.
    expect(firmware.querySelector('[data-thread-working]')).toBeTruthy();
    expect(firmware.getAttribute('aria-label')).toMatch(/, Neo is working$/);
    // The list has no message box: New chat opens it.
    expect(within(chat).getByRole('button', { name: 'New chat' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Ask Neo anything' })).toBeNull();
  });

  it('opens a thread full width over Chat, with its subject, its replies and Yes, tonight (at 03:00) on its card', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat', chatShell());
    const chat = await room();
    await user.click(await row(chat, /^Why is pve-02 using so much memory\?/));
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${PVE_THREAD}`));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    expect(await within(pane).findByText('Can you cap the cache at 16 GB?')).toBeTruthy();
    expect(within(pane).getByText('pve-02').closest('[data-subject-chip]')).toBeTruthy();
    expect(pane.querySelector('[data-replies-line]')?.textContent).toBe('3 replies');
    expect(within(pane).getByRole('textbox', { name: 'Reply to Neo…' })).toBeTruthy();
    expect(within(pane).getByRole('button', { name: 'Yes, tonight' }).getAttribute('title')).toContain(
      '03:00',
    );
    // Its row is marked as the open one (the list waits hidden under the thread).
    expect(chat.querySelector(`[data-root-id="${PVE_THREAD}"] a`)?.getAttribute('aria-current')).toBe('true');
    // Narrower than the list beside a thread: full width, the back link and Esc go back to Chat.
    expect(pane.hasAttribute('data-focus')).toBe(true);
    expect(within(pane).queryByRole('button', { name: THREAD_COLLAPSE_LABEL })).toBeNull();
    const back = within(pane).getByRole('link', { name: /Back to/ });
    expect(back.getAttribute('href')).toBe('/chat');
    await user.click(back);
    await waitFor(() => expect(app.location()).toBe('/chat'));
    await user.click(await row(await room(), /^Why is pve-02/));
    await screen.findByRole('complementary', { name: 'Thread' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(app.location()).toBe('/chat'));
  });

  it('opens a thread from its row with the keyboard too', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat', chatShell());
    const firmware = await row(await room(), /^Is there new firmware/);
    firmware.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${FIRMWARE_THREAD}`));
  });

  it('opens a new question’s thread as soon as it is sent', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat', chatShell());
    const chat = await room();
    await user.click(within(chat).getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(app.location()).toBe('/chat?new=1'));
    await user.type(
      await screen.findByRole('textbox', { name: 'Ask Neo anything' }),
      'Is the NAS backed up?{Enter}',
    );
    await waitFor(() => expect(app.location()).toMatch(/^\/chat\?thread=msg_chat-\d+$/));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    expect(await within(pane).findByText('On it. I’ll answer here.')).toBeTruthy();
  });

  it('opens Settled beside the room from its head, and Esc closes it as it does every pane', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat', chatShell());
    await room();
    await user.click(screen.getByRole('button', { name: 'Settled' }));
    await waitFor(() => expect(app.location()).toBe('/chat?settled=1'));
    await screen.findByRole('complementary', { name: 'Settled' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(app.location()).toBe('/chat'));
  });

  it('has no way to what the assistant did in its head (that is in its settings)', async () => {
    renderApp('/chat', chatShell());
    await room();
    expect(screen.queryByRole('link', { name: /did$/ })).toBeNull();
  });
});

describe('Feedback (AP-2410)', () => {
  it('shows the Feedback room once reports come there, with its unread count, each report a thread', async () => {
    renderApp('/chat', chatShell({ feedbackSources: true }));
    // Feedback opens from Chat's head with its unread count; the sidebar's Chat counts it, Feedback has no row.
    const link = await screen.findByRole('link', { name: CHAT_WORDS.feedbackUnread(1) });
    expect(link.getAttribute('href')).toBe('/feedback');
    const side = await sidebar();
    expect(within(side).queryByRole('link', { name: /^Feedback/ })).toBeNull();
    expect(within(side).getByRole('link', { name: /^Chat, 1 unread/ })).toBeTruthy();
    renderApp('/feedback', chatShell({ feedbackSources: true }));
    const feedback = await screen.findByRole('region', { name: 'Feedback' });
    expect(await within(feedback).findAllByText(/^Bug report|^Feature request/)).toBeTruthy();
  });
});

describe('website feedback in the Chat shell (AP-2410)', () => {
  it('says its reports go to Feedback, and links there', async () => {
    renderApp(`/settings/feedback/${feedbackIntegration.id}`, chatShell({ feedbackSources: true }));
    const link = await screen.findByRole('link', { name: 'Feedback' });
    expect(link.getAttribute('href')).toBe('/feedback');
    expect(screen.getAllByRole('link', { name: 'Open Feedback' })[0]?.getAttribute('href')).toBe('/feedback');
    renderApp('/connections?connection=feedback', chatShell({ feedbackSources: true }));
    expect(await screen.findByText('Burrow Billing · reports go to Feedback')).toBeTruthy();
  });
});

describe('a thing page’s Ask pane in the Chat shell (AP-2412)', () => {
  it('shows the newest thread about the thing, and its box starts a new one about it', async () => {
    const user = userEvent.setup();
    const app = renderApp('/things/server%3Apve-02?ask=1', fixtureServices({ hosts: true }));
    const pane = await screen.findByRole('complementary', { name: 'Ask about pve-02' });
    expect(await within(pane).findByText('Why is pve-02 using so much memory?')).toBeTruthy();
    expect(within(pane).getByRole('textbox', { name: 'Reply to Neo…' })).toBeTruthy();
    await user.click(within(pane).getByRole('button', { name: 'New thread' }));
    await waitFor(() => expect(app.location()).toContain('chat=new'));
    await user.type(
      await within(pane).findByRole('textbox', { name: 'Ask about pve-02' }),
      'Can it take another guest?{Enter}',
    );
    await waitFor(() => expect(app.location()).toMatch(/chat=msg_chat-\d+/));
    expect(await within(pane).findByText(/I’m looking at pve-02 now/)).toBeTruthy();
  });
});
