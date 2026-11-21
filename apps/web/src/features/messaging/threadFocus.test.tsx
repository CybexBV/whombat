/**
 * Thread focus mode (docs/decisions/ui-improvements.md AP-304, AP-305): the thread pane's expand button shows the
 * thread full width (`&focus=1`), the back link, the collapse button, Esc and the browser's Back return to the split
 * view, and the reply box keeps its draft across the switch.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { validateConversationSearch } from '../../app/routing/search';
import { resolveKeyAction } from '../../app/shell/keyboard';
import { fixtureServices, renderApp } from '../../test/renderApp';

/** The branch room's seeded thread (`essentials: true`): the conversation with people in it (one-agent.md AP-4949). */
const ROOM = '/pr/482';
const THREAD = `${ROOM}?thread=msg_billing-mara-1127`;
const seeded = () => fixtureServices({ essentials: true });

function main() {
  return document.querySelector('main') as HTMLElement;
}

describe('thread focus mode', () => {
  it('expands to full width and comes back with the collapse button, keeping the draft', async () => {
    const user = userEvent.setup();
    const app = renderApp(THREAD, seeded());
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    expect(main().hidden).toBe(false);
    await user.type(within(pane).getByRole('textbox', { name: 'Reply in thread' }), 'Half a thought');

    await user.click(within(pane).getByRole('button', { name: 'Open thread full width' }));
    await waitFor(() => expect(app.location()).toBe(`${THREAD}&focus=1`));
    expect(app.location()).toContain('thread=msg_billing-mara-1127');
    expect(main().hidden).toBe(true);
    const focused = screen.getByRole('complementary', { name: 'Thread' });
    expect(focused.dataset.focus).toBe('true');
    const back = within(focused).getByRole('link', { name: /^← Back to / });
    expect(back.getAttribute('href')).toBe(THREAD);
    // The conversation is only hidden: the draft is still there.
    expect(
      (within(focused).getByRole('textbox', { name: 'Reply in thread' }) as HTMLTextAreaElement).value,
    ).toBe('Half a thought');

    const collapse = within(focused).getByRole('button', { name: 'Show thread beside the conversation' });
    await user.click(collapse);
    await waitFor(() => expect(app.location()).toBe(THREAD));
    expect(main().hidden).toBe(false);
    // The same button, now “expand”, keeps keyboard focus.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Open thread full width');
    expect(
      (within(pane).getByRole('textbox', { name: 'Reply in thread' }) as HTMLTextAreaElement).value,
    ).toBe('Half a thought');
  });

  it('opens from a shared link and goes back with the back link, Esc and the browser’s Back', async () => {
    const user = userEvent.setup();
    const app = renderApp(`${THREAD}&focus=1`, seeded());
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    expect(main().hidden).toBe(true);
    await user.click(await within(pane).findByRole('link', { name: /^← Back to / }));
    await waitFor(() => expect(app.location()).toBe(THREAD));

    // Esc in focus mode collapses (even from the reply box) instead of closing the thread.
    await user.click(within(pane).getByRole('button', { name: 'Open thread full width' }));
    await waitFor(() => expect(main().hidden).toBe(true));
    await user.click(within(pane).getByRole('textbox', { name: 'Reply in thread' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(app.location()).toBe(THREAD));
    // A second Esc closes the pane, as before.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(app.location()).toBe(ROOM));

    // The browser's Back returns to the split view, then to the full width.
    app.history.back();
    await waitFor(() => expect(app.location()).toBe(THREAD));
    app.history.back();
    await waitFor(() => expect(main().hidden).toBe(true));
  });

  it('closes the thread from focus mode without leaving focus in the address', async () => {
    const user = userEvent.setup();
    const app = renderApp(`${THREAD}&focus=1`, seeded());
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    await user.click(within(pane).getByRole('button', { name: 'Close thread' }));
    await waitFor(() => expect(app.location()).toBe(ROOM));
    expect(main().hidden).toBe(false);
  });
});

describe('focus mode in the URL and on the keyboard', () => {
  it('keeps `focus` only with a thread', () => {
    expect(validateConversationSearch({ thread: 'msg_a', focus: '1' })).toEqual({
      thread: 'msg_a',
      focus: 1,
    });
    expect(validateConversationSearch({ focus: '1' })).toEqual({});
    expect(validateConversationSearch({ plan: 'pln_a', thread: 'msg_a', focus: '1' })).toEqual({
      plan: 'pln_a',
    });
  });

  it('Esc collapses focus mode before it closes the pane', () => {
    const esc = { key: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    const base = { modalOpen: false, dialogInDom: false, paneOpen: true, searchOpen: false };
    expect(resolveKeyAction(esc, { ...base, threadFocus: true })).toBe('collapseThread');
    expect(resolveKeyAction(esc, { ...base, threadFocus: false })).toBe('closePane');
    expect(resolveKeyAction(esc, { ...base, threadFocus: true, modalOpen: true })).toBe('closeModal');
  });
});
