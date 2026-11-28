/**
 * Chat as an inbox (Whombat chat-inbox.md CIB-01…CIB-11; app chat-inbox-web.md), against the fixture world's Chat: Neo's
 * question about tonight's updates and pve-02's approval wait for Mara, Neo works on the firmware question, and last
 * night's backups is a finished thread from Neo. With `newReplies` pve-02's thread has two new answers, the backups one
 * and Mara's link to a pull request one.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { INBOX_WORDS, newCountLabel } from '@whombat/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FIRMWARE_THREAD, LINK_THREAD, PVE_THREAD, UPDATES_THREAD } from '../../app/chatChannelFixtures';
import { fixtureServices, renderApp } from '../../test/renderApp';
import { INBOX_SPLIT_MEDIA } from './inboxNav';

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

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'matchMedia');
});

const BACKUPS = 'msg_chat-backups';
const room = () => screen.findByRole('region', { name: 'Chat' });
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-root-id="${id}"]`);
const rowLink = (id: string) => rowOf(id)?.querySelector<HTMLElement>('[data-inbox-row]') ?? null;
const shownRows = () =>
  [...document.querySelectorAll<HTMLElement>('[data-root-id]')].map((r) => r.dataset.rootId);
const rowsIn = async () => waitFor(() => expect(rowOf(BACKUPS)).toBeTruthy());

/** A window wide enough for the list beside the open thread. */
function wide() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === INBOX_SPLIT_MEDIA,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }),
  });
}

describe('the rows (CIB-01…CIB-04)', () => {
  it('are an icon and words: the title and time, then who wrote last and what, links as plain words', async () => {
    renderApp('/chat', fixtureServices({ newReplies: true }));
    await room();
    await waitFor(() => expect(rowOf(LINK_THREAD)).toBeTruthy());
    const link = rowOf(LINK_THREAD) as HTMLElement;
    expect(link.textContent).toContain('github.com/acme/shop/pull/412');
    expect(link.textContent).not.toContain('https://');
    // The assistant's own reply goes without its name for the eye (its face is the row's icon); a screen reader hears it.
    expect(within(link).getByText('Neo:').className).toMatch(/srOnly/);
    expect(link.querySelector('[data-thread-icon="agent"]')).toBeTruthy();
    expect(link.textContent).toContain('Looks good.');
    // A thread Neo started, with no reply yet, says who it is from.
    expect(rowOf(BACKUPS)?.textContent).toContain('From Neo');
    // Beside the icon nothing but words: no link preview, file or card in a row.
    expect(link.querySelector('[data-message-card], [data-link-preview]')).toBeNull();
  });

  it('marks what is new — the dot, the count and its words — and says what waits, in the row’s name', async () => {
    renderApp('/chat', fixtureServices({ newReplies: true }));
    await room();
    await waitFor(() => expect(rowOf(PVE_THREAD)?.hasAttribute('data-unread')).toBe(true));
    const pve = rowLink(PVE_THREAD) as HTMLElement;
    expect(pve.getAttribute('aria-label')).toBe(
      `Why is pve-02 using so much memory?, ${newCountLabel(2)}, waiting for you`,
    );
    expect(within(rowOf(PVE_THREAD) as HTMLElement).getByText('2')).toBeTruthy();
    expect(rowOf(FIRMWARE_THREAD)?.hasAttribute('data-unread')).toBe(false);
    expect(rowLink(FIRMWARE_THREAD)?.getAttribute('aria-label')).toBe(
      'Is there new firmware for the access points?, Neo is working',
    );
    // The state sits on the icon: the blue dot for new, the turning ring for work.
    expect(rowOf(PVE_THREAD)?.querySelector('[data-thread-new]')).toBeTruthy();
    expect(rowOf(FIRMWARE_THREAD)?.querySelector('[data-thread-working]')).toBeTruthy();
    expect(rowOf(FIRMWARE_THREAD)?.querySelector('[data-thread-new]')).toBeNull();
  });
});

describe('the filters (CIB-05)', () => {
  it('show all, only what is new or only what waits, with their numbers, and say so when nothing is there', async () => {
    const user = userEvent.setup();
    renderApp('/chat', fixtureServices({ newReplies: true }));
    const chat = await room();
    await waitFor(() => expect(rowOf(LINK_THREAD)).toBeTruthy());
    const filters = within(chat).getByRole('group', { name: INBOX_WORDS.show });
    const all = within(filters).getByRole('button', { name: INBOX_WORDS.all });
    const unread = within(filters).getByRole('button', { name: /^Unread/ });
    const waiting = within(filters).getByRole('button', { name: /^Waiting/ });
    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(unread.textContent).toBe('Unread3');
    expect(waiting.textContent).toBe('Waiting2');

    await user.click(unread);
    expect(unread.getAttribute('aria-pressed')).toBe('true');
    expect(new Set(shownRows())).toEqual(new Set([PVE_THREAD, BACKUPS, LINK_THREAD]));
    await user.click(waiting);
    expect(new Set(shownRows())).toEqual(new Set([PVE_THREAD, UPDATES_THREAD]));
    await user.click(all);
    expect(shownRows()).toContain(FIRMWARE_THREAD);
  });

  it('says there is nothing new when nothing is', async () => {
    const user = userEvent.setup();
    renderApp('/chat', fixtureServices({}));
    const chat = await room();
    await rowsIn();
    await user.click(within(chat).getByRole('button', { name: /^Unread/ }));
    expect(within(chat).getByText(INBOX_WORDS.nothingNew)).toBeTruthy();
    expect(shownRows()).toHaveLength(0);
  });
});

describe('the list’s foot', () => {
  it('has no Settle everything read and no key hint', async () => {
    renderApp('/chat', fixtureServices({}));
    const chat = await room();
    await rowsIn();
    expect(within(chat).queryByRole('button', { name: /^Settle everything read/ })).toBeNull();
    expect(within(chat).queryByText('J K · E · U')).toBeNull();
  });
});

describe('Mark as unread (CIB-06)', () => {
  it('marks a read thread unread from its row, says so, and Mark as read takes it back', async () => {
    const user = userEvent.setup();
    renderApp('/chat', fixtureServices({}));
    await room();
    await rowsIn();
    const backups = rowOf(BACKUPS) as HTMLElement;
    // A question of Mara's that nobody answered yet has nothing to mark.
    expect(
      within(rowOf(FIRMWARE_THREAD) as HTMLElement).queryByRole('button', { name: INBOX_WORDS.markUnread }),
    ).toBeNull();
    await user.click(within(backups).getByRole('button', { name: INBOX_WORDS.markUnread }));
    expect(await screen.findByText(INBOX_WORDS.markedUnread)).toBeTruthy();
    await waitFor(() => expect(rowOf(BACKUPS)?.hasAttribute('data-unread')).toBe(true));
    expect(rowLink(BACKUPS)?.getAttribute('aria-label')).toContain(newCountLabel(1));

    await user.click(
      within(rowOf(BACKUPS) as HTMLElement).getByRole('button', { name: INBOX_WORDS.markRead }),
    );
    await waitFor(() => expect(rowOf(BACKUPS)?.hasAttribute('data-unread')).toBe(false));
  });

  it('closes the open thread it marks, so it doesn’t read itself again', async () => {
    const user = userEvent.setup();
    const app = renderApp(`/chat?thread=${BACKUPS}`, fixtureServices({}));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    await user.click(await within(pane).findByRole('button', { name: INBOX_WORDS.markUnread }));
    await waitFor(() => expect(app.location()).toBe('/chat'));
    await waitFor(() => expect(rowOf(BACKUPS)?.hasAttribute('data-unread')).toBe(true));
  });
});

describe('the keys: J and K move, E settles, U marks as unread', () => {
  it('moves the focus through the rows, marks and settles the one it is on', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat', fixtureServices({}));
    await room();
    await rowsIn();
    const order = shownRows();
    await user.keyboard('j');
    await waitFor(() => expect(document.activeElement).toBe(rowLink(order[0] as string)));
    await user.keyboard('j');
    await waitFor(() => expect(document.activeElement).toBe(rowLink(order[1] as string)));
    await user.keyboard('k');
    await waitFor(() => expect(document.activeElement).toBe(rowLink(order[0] as string)));
    // Narrower than the list beside a thread, a move only moves the focus.
    expect(app.location()).toBe('/chat');

    rowLink(BACKUPS)?.focus();
    await user.keyboard('u');
    await waitFor(() => expect(rowOf(BACKUPS)?.hasAttribute('data-unread')).toBe(true));
    await user.keyboard('u');
    await waitFor(() => expect(rowOf(BACKUPS)?.hasAttribute('data-unread')).toBe(false));
    const after = order[order.indexOf(BACKUPS) + 1] ?? order[order.indexOf(BACKUPS) - 1];
    await user.keyboard('e');
    expect(await screen.findByText('Settled.')).toBeTruthy();
    await waitFor(() => expect(rowOf(BACKUPS)).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(rowLink(after as string)));
    // E on what waits does nothing.
    rowLink(UPDATES_THREAD)?.focus();
    await user.keyboard('e');
    expect(rowOf(UPDATES_THREAD)).toBeTruthy();
  });

  it('leaves the keys to a text field', async () => {
    wide();
    const user = userEvent.setup();
    renderApp('/chat', fixtureServices({}));
    const chat = await room();
    await rowsIn();
    const ask = within(chat).getByRole('textbox', { name: 'Ask Neo anything' });
    await user.click(ask);
    await user.keyboard('jjeun');
    expect((ask as HTMLTextAreaElement).value).toBe('jjeun');
    expect(rowOf(BACKUPS)).toBeTruthy();
  });
});

describe('beside the open thread, on a wide screen', () => {
  it('shows the list and the new chat, J opens the next thread beside it and E settles it and opens the next', async () => {
    wide();
    const user = userEvent.setup();
    const app = renderApp('/chat', fixtureServices({}));
    const chat = await room();
    await rowsIn();
    // No thread open: the new chat shows beside the list, and the list keeps the keys.
    const fresh = chat.querySelector('[data-new-chat]') as HTMLElement;
    expect(within(fresh).getByRole('heading', { name: 'New chat' })).toBeTruthy();
    expect(document.activeElement).not.toBe(within(fresh).getByRole('textbox', { name: 'Ask Neo anything' }));
    expect(within(chat).getByRole('button', { name: 'New chat' }).getAttribute('aria-pressed')).toBe('true');
    const order = shownRows();
    await user.keyboard('j');
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${order[0]}`));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    expect(pane.hasAttribute('data-beside')).toBe(true);
    // The list stays in view, with the open row marked, and keeps the focus.
    expect(document.querySelector('main')?.hidden).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(rowLink(order[0] as string)));
    expect(rowLink(order[0] as string)?.getAttribute('aria-current')).toBe('true');

    rowLink(BACKUPS)?.click();
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${BACKUPS}`));
    rowLink(BACKUPS)?.focus();
    const next = order[order.indexOf(BACKUPS) + 1];
    await user.keyboard('e');
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${next}`));
    expect(await screen.findByText('Settled.')).toBeTruthy();
  });

  it('the thread’s own Settle opens the one under it', async () => {
    wide();
    const user = userEvent.setup();
    const app = renderApp(`/chat?thread=${BACKUPS}`, fixtureServices({}));
    await room();
    await rowsIn();
    const order = shownRows();
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    await user.click(await within(pane).findByRole('button', { name: 'Settle' }));
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${order[order.indexOf(BACKUPS) + 1]}`));
  });
});

describe('New chat', () => {
  const box = () => screen.findByRole('textbox', { name: 'Ask Neo anything' });

  it('takes the list’s place with the cursor in its box; Back returns to the list and the draft stays', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat', fixtureServices({}));
    const chat = await room();
    await rowsIn();
    await user.click(within(chat).getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(app.location()).toBe('/chat?new=1'));
    const ask = await box();
    await waitFor(() => expect(document.activeElement).toBe(ask));
    expect(within(chat).getByRole('heading', { name: 'New chat' })).toBeTruthy();
    expect(chat.querySelector('[data-inbox-scroll]')?.closest('[hidden]')).toBeTruthy();
    await user.type(ask, 'Half a question');
    await user.click(within(chat).getByRole('link', { name: 'Back to Chat' }));
    await waitFor(() => expect(app.location()).toBe('/chat'));
    expect(screen.queryByRole('textbox', { name: 'Ask Neo anything' })).toBeNull();
    expect(chat.querySelector('[data-inbox-scroll]')?.closest('[hidden]')).toBeNull();
    // N does what the button does, and what was typed is still there.
    await user.keyboard('n');
    await waitFor(() => expect(app.location()).toBe('/chat?new=1'));
    expect(((await box()) as HTMLTextAreaElement).value).toBe('Half a question');
  });

  it('gives its place to the thread once the question is sent, so Back goes to the list', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat', fixtureServices({}));
    const chat = await room();
    await rowsIn();
    await user.click(within(chat).getByRole('button', { name: 'New chat' }));
    await user.type(await box(), 'Is the NAS backed up?{Enter}');
    await waitFor(() => expect(app.location()).toMatch(/^\/chat\?thread=/));
    app.history.back();
    await waitFor(() => expect(app.location()).toBe('/chat'));
  });

  it('beside the list closes the open thread and puts the cursor in the box', async () => {
    wide();
    const user = userEvent.setup();
    const app = renderApp(`/chat?thread=${BACKUPS}`, fixtureServices({}));
    const chat = await room();
    await rowsIn();
    const button = within(chat).getByRole('button', { name: 'New chat' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(chat.querySelector('[data-new-chat]')).toBeNull();
    await user.click(button);
    await waitFor(() => expect(app.location()).toBe('/chat?new=1'));
    await waitFor(async () => expect(document.activeElement).toBe(await box()));
    expect(button.getAttribute('aria-pressed')).toBe('true');
    // The list stays beside it.
    expect(chat.querySelector('[data-inbox-scroll]')?.closest('[hidden]')).toBeNull();
  });

  it('is New thread in Feedback', async () => {
    const user = userEvent.setup();
    const app = renderApp('/feedback', fixtureServices({ feedbackSources: true }));
    const feedback = await screen.findByRole('region', { name: 'Feedback' });
    await user.click(await within(feedback).findByRole('button', { name: 'New thread' }));
    await waitFor(() => expect(app.location()).toBe('/feedback?new=1'));
    expect(within(feedback).getByRole('heading', { name: 'New thread' })).toBeTruthy();
  });

  it('moves its buttons under the text once the draft runs past one line, and back when it is empty', async () => {
    const user = userEvent.setup();
    renderApp('/chat?new=1', fixtureServices({}));
    const chat = await room();
    const ask = within(chat).getByRole('textbox', { name: 'Ask Neo anything' });
    const row = () => ask.closest('[data-composer]')?.querySelector('[data-stacked]') ?? null;
    await user.type(ask, 'One line');
    expect(row()).toBeNull();
    await user.type(ask, '{Shift>}{Enter}{/Shift}and another');
    await waitFor(() => expect(row()).toBeTruthy());
    expect(within(row() as HTMLElement).getByRole('button', { name: 'Send' })).toBeTruthy();
    await user.clear(ask);
    await waitFor(() => expect(row()).toBeNull());
  });
});
