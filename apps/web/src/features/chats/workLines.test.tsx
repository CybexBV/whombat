/**
 * Software work in Chat, against the fixture world's threads with a council, a checklist and T3 Code's jobs
 * (`codeFixtures.ts`): every one stays in Chat, Working on its row while work goes on and what goes on in its thread's
 * head, and the old Code
 * addresses open the same thread or Settled in Chat.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { INBOX_WORDS, SETTLE_WORDS } from '@whombat/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { T3_THREAD } from '../../app/chatChannelFixtures';
import {
  CODE_CHECKS_THREAD,
  CODE_COUNCIL_THREAD,
  CODE_HANDOFF_THREAD,
  CODE_SETTLED_THREAD,
  CODE_TASKS_THREAD,
} from '../../app/codeFixtures';
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

const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-root-id="${id}"]`);

describe('software work in Chat', () => {
  it('keeps every thread with work in Chat; a row says Working while it goes on, its thread says what', async () => {
    const user = userEvent.setup();
    renderApp('/chat', fixtureServices({ code: true, handoff: 'working' }));
    await screen.findByRole('region', { name: 'Chat' });
    await waitFor(() => expect(rowOf(CODE_HANDOFF_THREAD)).toBeTruthy());
    for (const id of [
      CODE_COUNCIL_THREAD,
      CODE_TASKS_THREAD,
      CODE_CHECKS_THREAD,
      CODE_HANDOFF_THREAD,
      T3_THREAD,
    ])
      expect(rowOf(id), id).toBeTruthy();
    // Work that goes on from a thread (T3 Code, a council at work) shows on its row's icon as the turning ring, and in
    // its name, nothing more.
    for (const id of [T3_THREAD, CODE_COUNCIL_THREAD, CODE_HANDOFF_THREAD]) {
      expect(rowOf(id)?.querySelector('[data-thread-working]'), id).toBeTruthy();
      expect(
        within(rowOf(id) as HTMLElement)
          .getByRole('link')
          .getAttribute('aria-label'),
        id,
      ).toContain(INBOX_WORDS.working.toLowerCase());
    }
    expect(rowOf(T3_THREAD)?.textContent).not.toContain('Handed over');
    // A settled one is under Settled, as every settled thread is.
    expect(rowOf(CODE_SETTLED_THREAD)).toBeNull();
    expect(screen.queryByRole('link', { name: /^Code\b/ })).toBeNull();
    // What goes on is said in the thread's head: T3 Code's line, in place of “Handed over”.
    await user.click(within(rowOf(T3_THREAD) as HTMLElement).getByRole('link'));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    await waitFor(() => expect(pane.textContent).toMatch(/T3 Code · running the tests/));
  });

  it('opens Code’s old addresses in Chat: a thread, and the settled ones', async () => {
    const app = renderApp(`/code?thread=${CODE_HANDOFF_THREAD}`, fixtureServices({ code: true }));
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${CODE_HANDOFF_THREAD}`));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    expect((await within(pane).findAllByText(/The backup page has been empty/)).length).toBeGreaterThan(0);

    app.history.push('/code?settled=1');
    await waitFor(() => expect(app.location()).toBe('/chat?settled=1'));
    const settled = await screen.findByRole('complementary', { name: SETTLE_WORDS.settled });
    const shelf = await within(settled).findByRole('list', { name: `${SETTLE_WORDS.settled} in Chat` });
    await waitFor(() =>
      expect(shelf.querySelector(`[data-thread-row="${CODE_SETTLED_THREAD}"]`)).toBeTruthy(),
    );
  });
});
