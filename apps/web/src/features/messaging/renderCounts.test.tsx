/**
 * The room doesn't re-render while an agent thinks (docs/decisions/web-messages.md WX-01): the “is thinking” line's
 * 1-second clock lives in the line itself, and the message rows are memoized. Measured by counting the rows' text
 * renders (`RichText`, one per row with words) and the React Profiler's commit time over ten ticks of the clock. Chat
 * keeps its rows and the sidebar as they are on realtime events that don't change them.
 */

import { createMemoryHistory } from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import { applyRealtimeEvent, queryKeys, type TypingEntry } from '@whombat/client/query';
import type { RealtimeEvent } from '@whombat/core';
import { Profiler } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { FIRMWARE_THREAD } from '../../app/chatChannelFixtures';
import { ASSISTANT_NAME, DEFAULT_CHAT_ID, WHOMBAT_ID } from '../../app/oneFixtures';
import { fixtureServices, renderApp } from '../../test/renderApp';

const counts = vi.hoisted(() => ({ text: 0, rows: 0, sidebar: 0 }));

// Chat's rows (chat-inbox-web.md): a render of the wrapper is a row drawn again with new props.
vi.mock('../chats/InboxRow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chats/InboxRow')>();
  const { createElement, memo } = await import('react');
  return {
    ...actual,
    InboxRow: memo((props: Parameters<typeof actual.InboxRow>[0]) => {
      counts.rows += 1;
      return createElement(actual.InboxRow, props);
    }),
  };
});

// Only the sidebar picks its open list: a call is a render of the sidebar.
vi.mock('../../app/shell/useSidebarList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../app/shell/useSidebarList')>();
  return {
    ...actual,
    useSidebarList: () => {
      counts.sidebar += 1;
      return actual.useSidebarList();
    },
  };
});

vi.mock('./RichText', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./RichText')>();
  return {
    ...actual,
    RichText: (props: Parameters<typeof actual.RichText>[0]) => {
      counts.text += 1;
      return actual.RichText(props);
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the agent thinking in the branch room (WX-01)', () => {
  it('re-renders only its own line, once a second', async () => {
    const services = fixtureServices();
    const history = createMemoryHistory({ initialEntries: ['/pr/482'] });
    let commits = 0;
    let rendering = 0;
    render(
      <Profiler
        id="app"
        onRender={(_id, _phase, actual) => {
          commits += 1;
          rendering += actual;
        }}
      >
        <App services={services} history={history} />
      </Profiler>,
    );
    await screen.findByText(/merge once it looks right/);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const thinking: TypingEntry = {
      principalId: WHOMBAT_ID,
      threadRootId: null,
      expiresAt: Date.now() + 120_000,
    };
    act(() => services.queryClient.setQueryData(queryKeys.typing('cnv_pr482'), [thinking]));
    await screen.findByText(`${ASSISTANT_NAME} is thinking`);

    counts.text = 0;
    commits = 0;
    rendering = 0;
    for (let i = 0; i < 10; i++) act(() => vi.advanceTimersByTime(1000));
    // The measurement the decision quotes (WX-01).
    console.info(
      `WX-01 ten ticks: ${counts.text} row text renders, ${commits} commits, ${rendering.toFixed(1)} ms rendering`,
    );
    expect(counts.text).toBe(0);
  });
});

describe('Chat on realtime events', () => {
  it('draws neither its rows nor the sidebar again for a thinking line or an unread count', async () => {
    const services = fixtureServices();
    const qc = services.queryClient;
    renderApp('/chat', services);
    await screen.findByText('Why is pve-02 using so much memory?');
    // Neo thinks in the firmware thread, which already says Working.
    const thinking = (active: boolean): RealtimeEvent => ({
      type: 'typing',
      conversationId: DEFAULT_CHAT_ID,
      threadRootId: FIRMWARE_THREAD,
      principalId: WHOMBAT_ID,
      active,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      dispatchId: null,
    });
    await waitFor(() => expect(counts.rows).toBeGreaterThan(0));
    expect(counts.sidebar).toBeGreaterThan(0);

    counts.text = 0;
    counts.rows = 0;
    counts.sidebar = 0;
    act(() => {
      applyRealtimeEvent(qc, thinking(true));
    });
    act(() => {
      applyRealtimeEvent(qc, thinking(true));
      applyRealtimeEvent(qc, {
        type: 'conversation.unread',
        conversationId: DEFAULT_CHAT_ID,
        unread: 2,
        mentions: 0,
      });
      applyRealtimeEvent(qc, thinking(false));
    });
    expect(counts).toEqual({ text: 0, rows: 0, sidebar: 0 });
  });
});
