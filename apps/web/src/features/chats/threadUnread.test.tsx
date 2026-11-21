/**
 * Threads with something new in Chat (Whombat thread-unread.md, chat-inbox.md CIB-04), against the fixture world's Chat
 * with pve-02's thread holding two new answers from Neo: its row has the dot, a bold title and the count, read out as
 * “2 new messages”; gone once the thread is open and read, and still gone after it closes. The thread shows “New” above
 * the first new answer.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { newCountLabel } from '@whombat/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FIRMWARE_THREAD, PVE_THREAD } from '../../app/chatChannelFixtures';
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
const isNew = (id: string) => rowOf(id)?.hasAttribute('data-unread') ?? false;

describe('a thread with something new', () => {
  it('marks its row until it is opened and read, and the thread shows New above the first new answer', async () => {
    const user = userEvent.setup();
    const app = renderApp('/chat', fixtureServices({ newReplies: true }));
    await screen.findByRole('region', { name: 'Chat' });
    await waitFor(() => expect(isNew(PVE_THREAD)).toBe(true));
    const link = within(rowOf(PVE_THREAD) as HTMLElement).getByRole('link');
    expect(link.getAttribute('aria-label')).toContain(newCountLabel(2));
    expect(rowOf(PVE_THREAD)?.textContent).toContain('2');
    expect(isNew(FIRMWARE_THREAD)).toBe(false);
    expect(
      within(rowOf(FIRMWARE_THREAD) as HTMLElement)
        .getByRole('link')
        .getAttribute('aria-label'),
    ).not.toMatch(/new message/);

    await user.click(link);
    await waitFor(() => expect(app.location()).toBe(`/chat?thread=${PVE_THREAD}`));
    // The open thread is being read: not marked new beside it.
    expect(isNew(PVE_THREAD)).toBe(false);
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    await waitFor(() => expect(pane.querySelectorAll('article').length).toBeGreaterThan(1));
    // “New” above the first of Neo's two new answers (its first, about the ZFS cache).
    const line = await within(pane).findByRole('separator', { name: 'New' });
    expect(line.nextElementSibling?.textContent).toContain('38 GB of that is the ZFS cache');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(app.location()).toBe('/chat'));
    // Read while it was open, so it stays read.
    await waitFor(() => expect(rowOf(PVE_THREAD)).toBeTruthy());
    await waitFor(() => expect(isNew(PVE_THREAD)).toBe(false));
  });
});
