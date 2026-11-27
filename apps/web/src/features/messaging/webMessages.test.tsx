/**
 * The conversations' web improvements on the fixture world (docs/decisions/web-messages.md), in the branch room and Chat
 * (the conversations that stay with one agent, one-agent.md AP-4949): the thread's reply box is the composer (WX-04),
 * drafts survive a reload (WX-05), “Copy link” (WX-06), the “New” divider (WX-07), `/ command` where something is
 * behind it (WX-08), thread paging (WX-11) and Stop (WX-10).
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { queryKeys } from '@whombat/client/query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PVE_THREAD } from '../../app/chatChannelFixtures';
import { ASSISTANT_NAME, WHOMBAT_ID } from '../../app/oneFixtures';
import { pinMockDate } from '../../test/clock';
import { fixtureServices, renderApp } from '../../test/renderApp';

pinMockDate();

afterEach(() => {
  vi.restoreAllMocks();
});

/** The branch room (the conversation with people in it) and its seeded thread (`essentials: true`). */
const ROOM = '/pr/482';
const THREAD = 'msg_billing-mara-1127';
const seeded = () => fixtureServices({ essentials: true });

describe('the thread’s reply box (WX-04)', () => {
  it('is the one composer: “File”, and a draft of its own per thread', async () => {
    const user = userEvent.setup();
    const app = renderApp(`${ROOM}?thread=${THREAD}`, seeded());
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    expect(within(pane).getByRole('button', { name: 'Attach a file' }).textContent).toBe('File');
    const box = await within(pane).findByRole('textbox', { name: 'Reply in thread' });
    await user.type(box, 'Half a thought');

    act(() => app.history.push(`${ROOM}?thread=msg_billing-mara-1126`));
    const other = await screen.findByRole('complementary', { name: 'Thread' });
    await waitFor(() =>
      expect(
        (within(other).getByRole('textbox', { name: 'Reply in thread' }) as HTMLTextAreaElement).value,
      ).toBe(''),
    );

    act(() => app.history.push(`${ROOM}?thread=${THREAD}`));
    const back = await screen.findByRole('complementary', { name: 'Thread' });
    await waitFor(() =>
      expect(
        (within(back).getByRole('textbox', { name: 'Reply in thread' }) as HTMLTextAreaElement).value,
      ).toBe('Half a thought'),
    );
  });
});

describe('drafts (WX-05)', () => {
  it('survive the room closing and opening again, and go when sent', async () => {
    const user = userEvent.setup();
    const first = renderApp(ROOM);
    await user.type(await screen.findByRole('textbox', { name: 'Comment on PR #482' }), 'Not sent yet');
    first.unmount();

    renderApp(ROOM);
    const input = (await screen.findByRole('textbox', {
      name: 'Comment on PR #482',
    })) as HTMLTextAreaElement;
    expect(input.value).toBe('Not sent yet');
    await user.click(input);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(input.value).toBe(''));
    expect(localStorage.getItem('whombat:draft:burrow-hq:cnv_pr482')).toBeNull();
  });
});

describe('Copy link (WX-06)', () => {
  it('copies the message’s address in this burrow', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp(ROOM);
    const row = await screen.findByRole('article', { name: 'Mara Okafor, 11:30' });
    await user.click(within(row).getByRole('button', { name: 'More actions for Mara Okafor’s message' }));
    const menu = await screen.findByRole('menu', { name: 'Message actions' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copied = new URL(String((writeText.mock.calls[0] as unknown[])[0]));
    expect(copied.pathname).toBe(ROOM);
    expect(copied.searchParams.get('burrow')).toBe('burrow-hq');
    expect(copied.hash).toBe('#msg_pr482-mara-1130');
    expect(await screen.findByText('Message link copied.')).toBeTruthy();
  });
});

describe('the “New” divider (WX-07)', () => {
  it('sits above the first message Mara hadn’t read and didn’t write', async () => {
    renderApp(ROOM, fixtureServices({ unread: true }));
    const divider = await screen.findByRole('separator', { name: 'New messages' });
    const next = divider.nextElementSibling?.querySelector('article');
    expect(next?.id).toBe('msg_pr482-dusty-1122');
  });

  it('isn’t there without a read marker', async () => {
    renderApp(ROOM);
    await screen.findByRole('article', { name: 'Mara Okafor, 11:30' });
    expect(screen.queryByRole('separator', { name: 'New messages' })).toBeNull();
  });
});

describe('`/ command` (WX-08)', () => {
  it('shows in the branch room, where commands work', async () => {
    renderApp(ROOM);
    await screen.findByRole('textbox', { name: 'Comment on PR #482' });
    expect(screen.getByRole('button', { name: '/ command' })).toBeTruthy();
  });
});

describe('thread paging (WX-11)', () => {
  it('opens at the newest replies and loads the earlier ones above them', async () => {
    const user = userEvent.setup();
    const services = fixtureServices();
    const session = services.client.session;
    const call = session.call.bind(session);
    const asked: unknown[] = [];
    // Chat's pve-02 thread has three replies: answer two per page, as a long thread would fifty.
    vi.spyOn(session, 'call').mockImplementation(async (ep, input, options) => {
      if (ep.id !== 'messages.thread') return call(ep, input, options);
      const query = (input as { query?: { before?: string; limit?: number } }).query ?? {};
      asked.push(query);
      const res = await call(ep, { ...(input as object), query: {} } as never, options);
      const all = res.body as { replies: { id: string }[] };
      const end = query.before ? all.replies.findIndex((r) => r.id === query.before) : all.replies.length;
      const start = Math.max(0, end - 2);
      const body = {
        ...all,
        replies: all.replies.slice(start, end),
        more: start > 0 ? { before: all.replies[start]?.id } : null,
      };
      return { ...res, body };
    });
    renderApp(`/chat?thread=${PVE_THREAD}`, services);
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    const earlier = await within(pane).findByRole('button', { name: 'Load earlier replies' });
    expect(within(pane).queryByText(/^It’s at 91%/)).toBeNull();
    expect(asked[0]).toEqual({ limit: 50 });
    await user.click(earlier);
    expect(await within(pane).findByText(/^It’s at 91%/)).toBeTruthy();
    await waitFor(() =>
      expect(within(pane).queryByRole('button', { name: 'Load earlier replies' })).toBeNull(),
    );
  });
});

describe('Stop on the thinking line (WX-10)', () => {
  const thinking = (services: ReturnType<typeof fixtureServices>, dispatchId?: string) =>
    act(() =>
      services.queryClient.setQueryData(queryKeys.typing('cnv_pr482'), [
        {
          principalId: WHOMBAT_ID,
          threadRootId: null,
          expiresAt: Date.now() + 120_000,
          ...(dispatchId ? { dispatchId } : {}),
        },
      ]),
    );

  it('starts with the agent’s face, thinking, then at work once its turn acts', async () => {
    const services = fixtureServices();
    renderApp(ROOM, services);
    await screen.findByRole('textbox', { name: 'Comment on PR #482' });
    thinking(services);
    const line = (await screen.findByText(`${ASSISTANT_NAME} is thinking`)).closest('[role="status"]');
    const face = () => line?.querySelector('[data-live-face]');
    expect(line?.hasAttribute('data-typing-face')).toBe(true);
    expect(face()?.getAttribute('data-face-state')).toBe('thinking');
    expect(face()?.getAttribute('aria-hidden')).toBe('true');
    const now = Date.now();
    act(() =>
      services.queryClient.setQueryData(queryKeys.agentNow('cnv_pr482'), [
        {
          principalId: WHOMBAT_ID,
          threadRootId: null,
          dispatchId: 'dsp_agent',
          title: 'Reading the conversation',
          status: 'running',
          seq: 1,
          since: now,
          at: now,
        },
      ]),
    );
    await waitFor(() => expect(face()?.getAttribute('data-face-state')).toBe('working'));
  });

  it('stops the agent’s turn: the line goes and the toast says so', async () => {
    const user = userEvent.setup();
    const services = fixtureServices();
    const session = services.client.session;
    const call = session.call.bind(session);
    const cancelled: unknown[] = [];
    vi.spyOn(session, 'call').mockImplementation(async (ep, input, options) => {
      if (ep.id !== 'dispatches.cancel') return call(ep, input, options);
      cancelled.push((input as { params: unknown }).params);
      const now = new Date().toISOString();
      return {
        status: 200,
        requestId: 'req_cancel',
        body: {
          dispatch: {
            id: 'dsp_agent',
            agentId: WHOMBAT_ID,
            conversationId: 'cnv_pr482',
            threadRootId: null,
            trigger: 'mention',
            state: 'cancelled',
            runId: null,
            createdAt: now,
            claimedAt: now,
            heartbeatAt: now,
            finishedAt: now,
            reason: 'Stopped by Mara',
          },
        },
      };
    });
    renderApp(ROOM, services);
    await screen.findByRole('textbox', { name: 'Comment on PR #482' });
    thinking(services, 'dsp_agent');
    await user.click(await screen.findByRole('button', { name: `Stop ${ASSISTANT_NAME}` }));
    expect(await screen.findByText(`Stopped ${ASSISTANT_NAME}.`)).toBeTruthy();
    expect(cancelled).toEqual([{ burrow: 'burrow-hq', dispatchId: 'dsp_agent' }]);
    await waitFor(() => expect(screen.queryByText(`${ASSISTANT_NAME} is thinking`)).toBeNull());
  });

  it('has no Stop for a line without its turn, and says the server’s refusal', async () => {
    const user = userEvent.setup();
    const services = fixtureServices();
    const session = services.client.session;
    const call = session.call.bind(session);
    vi.spyOn(session, 'call').mockImplementation(async (ep, input, options) =>
      ep.id === 'dispatches.cancel'
        ? {
            status: 409,
            requestId: 'req_cancel',
            body: { error: { code: 'conflict', message: 'Pause the run instead.' } },
          }
        : call(ep, input, options),
    );
    renderApp(ROOM, services);
    await screen.findByRole('textbox', { name: 'Comment on PR #482' });
    thinking(services);
    await screen.findByText(`${ASSISTANT_NAME} is thinking`);
    expect(screen.queryByRole('button', { name: `Stop ${ASSISTANT_NAME}` })).toBeNull();
    thinking(services, 'dsp_run');
    await user.click(await screen.findByRole('button', { name: `Stop ${ASSISTANT_NAME}` }));
    expect(await screen.findByText('Pause the run instead.')).toBeTruthy();
  });
});
