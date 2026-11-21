/**
 * The essentials' message features on the fixture world with the seed (`essentials: true`; docs/decisions/
 * essentials-messages.md): the toolbar and menu, editing (and ↑ from the composer), deleting with its dialog and the
 * tombstone, pins with “Pinned · N” and the pane, reactions with the picker (in the thread too), “Reply in thread”,
 * link previews.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OutcomeRedactedError } from '@whombat/client';
import { describe, expect, it, vi } from 'vitest';
import { ASSISTANT_NAME } from '../../app/oneFixtures';
import { pinMockDate } from '../../test/clock';
import { fixtureServices, renderApp } from '../../test/renderApp';

pinMockDate();

const ROOM = '/pr/482';
const seeded = () => fixtureServices({ essentials: true });

async function maraRow() {
  return screen.findByRole('article', { name: 'Mara Okafor, 11:26' });
}

/** The agent's 11:25 in the room (it asks for Mara's yes). */
async function agentRow() {
  return screen.findByRole('article', { name: `${ASSISTANT_NAME}, 11:25` });
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, row: HTMLElement) {
  await user.click(within(row).getByRole('button', { name: 'More actions for Mara Okafor’s message' }));
  return screen.findByRole('menu', { name: 'Message actions' });
}

describe('editing', () => {
  it('edits your message in place: Enter saves and “(edited)” stays; Esc cancels', async () => {
    const user = userEvent.setup();
    renderApp(ROOM, seeded());
    const row = await maraRow();
    expect(within(row).getByText('(edited)')).toBeTruthy();

    await user.click(within(await openMenu(user, row)).getByRole('menuitem', { name: 'Edit message' }));
    const editor = within(row).getByRole('textbox', { name: 'Edit message' });
    expect(document.activeElement).toBe(editor);
    await user.clear(editor);
    await user.type(editor, 'The review is on Friday now.{Enter}');
    expect(await within(row).findByText('The review is on Friday now.')).toBeTruthy();
    expect(within(row).queryByRole('textbox', { name: 'Edit message' })).toBeNull();
    // Focus goes back to the composer.
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Comment on PR #482'),
    );

    // ↑ in the empty composer edits your newest message; Esc cancels and keeps the text.
    await user.keyboard('{ArrowUp}');
    const newest = await screen.findByRole('article', { name: 'Mara Okafor, 11:30' });
    const again = await within(newest).findByRole('textbox', { name: 'Edit message' });
    await user.type(again, ' Maybe.');
    await user.keyboard('{Escape}');
    expect(within(newest).queryByRole('textbox', { name: 'Edit message' })).toBeNull();
    expect(newest.textContent).not.toContain('Maybe.');
    expect(within(row).getByText('The review is on Friday now.')).toBeTruthy();
  });

  it('offers no edit on the agent’s message, but you may delete it', async () => {
    const user = userEvent.setup();
    renderApp(ROOM, seeded());
    const agent = await agentRow();
    await user.click(
      within(agent).getByRole('button', { name: `More actions for ${ASSISTANT_NAME}’s message` }),
    );
    const menu = await screen.findByRole('menu', { name: 'Message actions' });
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent);
    expect(items).toContain('Delete message');
    expect(items).not.toContain('Edit message');
  });
});

describe('deleting', () => {
  /** Counts the deletes sent to the Whombat. */
  function countDeletes(services: ReturnType<typeof seeded>) {
    const session = services.client.session;
    const call = session.call.bind(session);
    const sent: string[] = [];
    vi.spyOn(session, 'call').mockImplementation(async (ep, input, options) => {
      if (ep.id === 'messages.delete') sent.push(ep.id);
      return call(ep, input, options);
    });
    return sent;
  }

  it('removes your own message at once, with Undo in the toast; Undo brings it back and sends nothing (WX-09)', async () => {
    const user = userEvent.setup();
    const services = seeded();
    const sent = countDeletes(services);
    renderApp(ROOM, services);
    const row = await maraRow();
    await user.click(within(await openMenu(user, row)).getByRole('menuitem', { name: 'Delete message' }));
    expect(screen.queryByRole('dialog', { name: 'Delete this message?' })).toBeNull();
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Mara Okafor, 11:26' })).toBeNull());
    expect(await screen.findByText('Message deleted.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await maraRow()).toBeTruthy();
    expect(screen.queryByText('Message deleted.')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('sends the delete when you leave the conversation, and the message stays gone (WX-09)', async () => {
    const user = userEvent.setup();
    const services = seeded();
    const sent = countDeletes(services);
    const app = renderApp(ROOM, services);
    const row = await maraRow();
    await user.click(within(await openMenu(user, row)).getByRole('menuitem', { name: 'Delete message' }));
    expect(await screen.findByText('Message deleted.')).toBeTruthy();
    expect(sent).toEqual([]);
    act(() => app.history.push('/settings'));
    await waitFor(() => expect(sent).toEqual(['messages.delete']));
    // The Undo went with it.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull());
    act(() => app.history.push(ROOM));
    await screen.findByRole('article', { name: 'Mara Okafor, 11:30' });
    expect(screen.queryByRole('article', { name: 'Mara Okafor, 11:26' })).toBeNull();
  });

  it('asks first when you remove the agent’s message, then offers Undo too (WX-13)', async () => {
    const user = userEvent.setup();
    renderApp(ROOM, seeded());
    const agent = await agentRow();
    await user.click(
      within(agent).getByRole('button', { name: `More actions for ${ASSISTANT_NAME}’s message` }),
    );
    const menu = await screen.findByRole('menu', { name: 'Message actions' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete message' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this message?' });
    expect(within(dialog).getByText(new RegExp(`You’re removing ${ASSISTANT_NAME}’s message`))).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(screen.queryByRole('article', { name: `${ASSISTANT_NAME}, 11:25` })).toBeNull(),
    );
    expect(await screen.findByText('Message deleted.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('a delete that went through without its answer (CT-195) is said as done, and the message stays gone', async () => {
    const user = userEvent.setup();
    const services = seeded();
    const session = services.client.session;
    const call = session.call.bind(session);
    // Applied, but the answer isn't kept (a runtime whose process died after the commit).
    vi.spyOn(session, 'call').mockImplementation(async (ep, input, options) => {
      const res = await call(ep, input, options);
      if (ep.id === 'messages.delete')
        throw new OutcomeRedactedError(ep.id, 'req_del_0123456789', 'completed');
      return res;
    });
    const app = renderApp(ROOM, services);
    const row = await maraRow();
    await user.click(within(await openMenu(user, row)).getByRole('menuitem', { name: 'Delete message' }));
    expect(await screen.findByText('Message deleted.')).toBeTruthy();
    act(() => app.history.push('/settings'));
    act(() => app.history.push(ROOM));
    await screen.findByRole('article', { name: 'Mara Okafor, 11:30' });
    expect(screen.queryByText('Couldn’t delete that. Try again.')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Mara Okafor, 11:26' })).toBeNull());
  });

  it('deleting the open thread’s root closes the pane at once, as it goes with its thread', async () => {
    const user = userEvent.setup();
    const app = renderApp(`${ROOM}?thread=msg_billing-mara-1126`, seeded());
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    const root = await within(pane).findByRole('article', { name: 'Mara Okafor, 11:26' });
    await user.click(within(root).getByRole('button', { name: 'More actions for Mara Okafor’s message' }));
    const menu = await screen.findByRole('menu', { name: 'Message actions' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete message' }));
    expect(await screen.findByText('Message deleted.')).toBeTruthy();
    await waitFor(() => expect(app.location()).toBe(ROOM));
  });

  it('shows a deleted thread root as a tombstone with its replies', async () => {
    const user = userEvent.setup();
    const app = renderApp(ROOM, seeded());
    const tombstone = await screen.findByRole('article', { name: /^Deleted message/ });
    expect(within(tombstone).getByText('This message was deleted.')).toBeTruthy();
    expect(within(tombstone).queryByRole('button', { name: /More actions/ })).toBeNull();
    await user.click(within(tombstone).getByRole('link', { name: /2 replies/ }));
    await waitFor(() => expect(app.location()).toBe(`${ROOM}?thread=msg_billing-mara-1127&focus=1`));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    expect(await within(pane).findByText('Is Thursday the new staging date too?')).toBeTruthy();
    expect(within(pane).getByText('This message was deleted.')).toBeTruthy();
  });
});

describe('right-clicking a message (AP-615)', () => {
  it('offers Delete message, and Copy first when text in it is selected', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp(ROOM, seeded());
    const row = await maraRow();
    const words = within(row).getByText(/Heads-up: the template review moved to Thursday/);
    await user.pointer({ keys: '[MouseRight]', target: words });
    let menu = await screen.findByRole('menu', { name: 'Message actions' });
    let items = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent);
    expect(items).not.toContain('Copy');
    expect(items.at(-1)).toBe('Delete message');
    await user.keyboard('{Escape}');

    // Select “Heads-up” in the message, then right-click it.
    const text = words.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, text.data.indexOf('Heads-up'));
    range.setEnd(text, text.data.indexOf('Heads-up') + 'Heads-up'.length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    // A right-click inside a selection keeps it (user-event's press would move it, as a left press does).
    fireEvent.contextMenu(words, { clientX: 40, clientY: 40 });
    menu = await screen.findByRole('menu', { name: 'Message actions' });
    items = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent);
    expect(items[0]).toBe('Copy');
    expect(items).toContain('Delete message');
    await user.click(within(menu).getByRole('menuitem', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Heads-up'));
    window.getSelection()?.removeAllRanges();
  });
});

describe('pins', () => {
  it('pins from the menu, counts in the header and lists in the pane', async () => {
    const user = userEvent.setup();
    const app = renderApp(ROOM, seeded());
    const header = await screen.findByRole('link', { name: 'Pinned · 1' });
    const row = await maraRow();
    await user.click(
      within(await openMenu(user, row)).getByRole('menuitem', { name: 'Pin to this conversation' }),
    );
    expect(await within(row).findByRole('img', { name: 'Pinned by Mara Okafor' })).toBeTruthy();
    expect(await screen.findByText('Pinned to feat/invoice-pdf.')).toBeTruthy();
    await waitFor(() => expect(header.textContent).toContain('2'));

    await user.click(screen.getByRole('link', { name: 'Pinned · 2' }));
    await waitFor(() => expect(app.location()).toBe(`${ROOM}?pins=1`));
    const pane = await screen.findByRole('complementary', { name: 'Pinned messages' });
    expect(await within(pane).findByText('PINNED · 2')).toBeTruthy();
    const rows = within(pane)
      .getAllByRole('button')
      .filter((b) => b.textContent?.includes('Pinned by'));
    // Newest pin first.
    expect(rows[0]?.textContent).toContain('Heads-up');
    expect(rows[1]?.textContent).toContain('merge once it looks right');

    // Unpin from the menu: the pane follows.
    await user.click(within(await openMenu(user, row)).getByRole('menuitem', { name: 'Unpin' }));
    await waitFor(() => expect(within(pane).getByText('PINNED · 1')).toBeTruthy());
    await user.click(within(pane).getByRole('button', { name: 'Close pinned messages' }));
    await waitFor(() => expect(app.location()).toBe(ROOM));
  });

  it('jumps to a pinned message that isn’t loaded by opening it as a thread', async () => {
    const user = userEvent.setup();
    const app = renderApp(`${ROOM}?pins=1`, seeded());
    const pane = await screen.findByRole('complementary', { name: 'Pinned messages' });
    await user.click(await within(pane).findByRole('button', { name: /Mara Okafor/ }));
    // Mara's message is in the room: it is scrolled to and highlighted, and the pane stays.
    await waitFor(() =>
      expect(document.getElementById('msg_pr482-mara-1130')?.hasAttribute('data-flash')).toBe(true),
    );
    expect(app.location()).toBe(`${ROOM}?pins=1`);
  });
});

describe('reactions', () => {
  it('adds one from the picker by search, and toggles it from its pill', async () => {
    const user = userEvent.setup();
    renderApp(ROOM, seeded());
    const row = await maraRow();
    expect(within(row).getByRole('button', { name: '👍, 1 reaction' })).toBeTruthy();
    // Not on hover: only in the menu.
    expect(within(row).queryByRole('button', { name: 'Add reaction' })).toBeNull();
    await user.click(within(await openMenu(user, row)).getByRole('menuitem', { name: 'Add reaction' }));
    const picker = await screen.findByRole('dialog', { name: 'Add a reaction to Mara Okafor’s message' });
    const search = within(picker).getByRole('textbox', { name: 'Search emoji' });
    expect(document.activeElement).toBe(search);
    await user.type(search, 'thumbs up{Enter}');
    expect(screen.queryByRole('dialog', { name: /Add a reaction/ })).toBeNull();
    const pill = await within(row).findByRole('button', { name: '👍, 2 reactions, including yours' });
    await user.click(pill);
    expect(await within(row).findByRole('button', { name: '👍, 1 reaction' })).toBeTruthy();
    // The picker remembers it.
    await user.click(within(await openMenu(user, row)).getByRole('menuitem', { name: 'Add reaction' }));
    const again = await screen.findByRole('dialog', { name: /Add a reaction/ });
    expect(within(again).getByRole('region', { name: 'Recent' })).toBeTruthy();
  });

  it('moves through the grid with the arrows and closes with Esc, back where it opened', async () => {
    const user = userEvent.setup();
    renderApp(ROOM, seeded());
    const row = await maraRow();
    const opener = within(row).getByRole('button', { name: 'More actions for Mara Okafor’s message' });
    await user.click(within(await openMenu(user, row)).getByRole('menuitem', { name: 'Add reaction' }));
    const picker = await screen.findByRole('dialog', { name: /Add a reaction/ });
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('grinning face');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('grinning face with big eyes');
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Search emoji');
    await user.keyboard('{Escape}');
    expect(picker.isConnected).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('works in the thread pane too', async () => {
    const user = userEvent.setup();
    renderApp(`${ROOM}?thread=msg_billing-mara-1127`, seeded());
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    const reply = await within(pane).findByRole('article', { name: 'Mara Okafor, 11:29' });
    await user.click(within(await openMenu(user, reply)).getByRole('menuitem', { name: 'Add reaction' }));
    const picker = await screen.findByRole('dialog', { name: /Add a reaction/ });
    // The quick reactions come first.
    await user.click(within(picker).getAllByRole('button', { name: 'thumbs up' })[0] as HTMLElement);
    expect(
      await within(reply).findByRole('button', { name: '👍, 1 reaction, including yours' }),
    ).toBeTruthy();
  });
});

describe('reply in thread', () => {
  it('opens the thread pane on any message, even without replies, with the reply box focused', async () => {
    const user = userEvent.setup();
    const app = renderApp(ROOM, seeded());
    const row = await maraRow();
    await user.click(within(row).getByRole('button', { name: 'Reply in thread' }));
    await waitFor(() => expect(app.location()).toBe(`${ROOM}?thread=msg_billing-mara-1126&focus=1`));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    const box = within(pane).getByRole('textbox', { name: 'Reply in thread' });
    await waitFor(() => expect(document.activeElement).toBe(box));
  });
});

describe('link previews', () => {
  it('shows a compact card that opens in a new tab without the opener', async () => {
    renderApp(ROOM, seeded());
    const row = await maraRow();
    const link = within(row).getByRole('link', { name: 'Templates · Typeset docs' });
    expect(link.getAttribute('href')).toBe('https://typeset.dev/docs/templates');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(row).getByText('Typeset')).toBeTruthy();
  });
});
