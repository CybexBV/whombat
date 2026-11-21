/**
 * A server task's card on the web (contracts 0.116, CT-880; docs/decisions/task-feedback.md AP-4300, AP-4301): live
 * while it runs, one line once it ended that opens the runtime's full words, and the line as soon as the message's
 * card says it ended.
 */
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TASK_CARD_WORDS, type TaskCard } from '@whombat/core';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Providers } from '../../app/providers';
import { fixtureServices } from '../../test/renderApp';
import { MessageCard } from './MessageCard';

const NAME = 'Task on Home Assistant: Installing 23 updates on Home Assistant';

function task(over: Partial<TaskCard> = {}): TaskCard {
  return {
    kind: 'task',
    followedTaskId: 'ftk_ha0updates01' as TaskCard['followedTaskId'],
    serverId: 'home-assistant',
    server: 'Home Assistant',
    title: 'Installing 23 updates on Home Assistant',
    state: 'running',
    startedAt: new Date(Date.now() - 12_000).toISOString(),
    endedAt: null,
    result: null,
    ...over,
  };
}

const ended = (over: Partial<TaskCard> = {}): TaskCard =>
  task({
    state: 'ok',
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:04:12.000Z',
    result: 'Home Assistant is up to date: 23 updates installed. It needs a restart to finish.',
    ...over,
  });

let setCard: (card: TaskCard) => void = () => {};

function Harness({ first }: { first: TaskCard }) {
  const [card, set] = useState(first);
  setCard = set;
  return <MessageCard burrow="burrow-hq" card={card} messageId="msg_task" conversationId="cnv_chat" />;
}

function renderCard(card: TaskCard) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Harness first={card} /> }),
    history: createMemoryHistory({ initialEntries: ['/chat'] }),
  });
  render(
    <Providers services={fixtureServices()}>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('a running task (AP-4300)', () => {
  it('is a live card: what it does, how long so far, and the server it runs on', async () => {
    renderCard(task());
    const card = await screen.findByRole('region', { name: NAME });
    expect(card.dataset.variant).toBe('live');
    expect(card.textContent).toContain('Installing 23 updates on Home Assistant');
    expect(card.textContent).toMatch(/1\d s/);
    expect(within(card).getByRole('img', { name: TASK_CARD_WORDS.states.running })).toBeTruthy();
    const server = within(card).getByRole('link', { name: /Home Assistant/ });
    expect(server.getAttribute('href')).toBe('/things/server%3Ahome-assistant');
    expect(within(card).queryByRole('button', { name: 'Show card' })).toBeNull();
  });

  it('settles into its line when the message’s card says it ended', async () => {
    renderCard(task());
    await screen.findByRole('region', { name: NAME });
    act(() => setCard(ended()));
    const line = await screen.findByRole('region', { name: NAME });
    expect(line.dataset.variant).toBe('line');
    expect(line.textContent).toContain('23 updates installed');
    expect(line.textContent).toContain('4 min');
    expect(line.textContent).not.toContain('restart');
  });
});

describe('a task that ended (AP-4301)', () => {
  it('opens its line to the full words, the time it took and how it went', async () => {
    renderCard(ended());
    const line = await screen.findByRole('region', { name: NAME });
    await userEvent.click(within(line).getByRole('button', { name: 'Show card' }));
    const card = within(line).getByRole('region', { name: NAME });
    expect(card.dataset.variant).toBe('full');
    expect(card.textContent).toContain('It needs a restart to finish.');
    expect(card.textContent).toContain('4 min');
    expect(card.textContent).toContain(TASK_CARD_WORDS.states.ok);
    expect(within(line).getByRole('button', { name: 'Hide card' })).toBeTruthy();
  });

  it('says a task that didn’t work, and one Whombat lost track of without a time', async () => {
    renderCard(
      ended({
        state: 'error',
        result: 'Installing updates on Home Assistant didn’t work: the disk is full.',
      }),
    );
    const line = await screen.findByRole('region', { name: NAME });
    expect(line.textContent).toContain('the disk is full');
    await userEvent.click(within(line).getByRole('button', { name: 'Show card' }));
    expect(line.textContent).toContain(TASK_CARD_WORDS.states.error);
    act(() => setCard(ended({ state: 'lost', result: 'Whombat lost track of this task.' })));
    // Still opened: the line and its card, the line first.
    const [lost] = await screen.findAllByRole('region', { name: NAME });
    if (!lost) throw new Error('no line');
    expect(lost.dataset.variant).toBe('line');
    expect(lost.textContent).toContain(TASK_CARD_WORDS.lostLine);
    expect(lost.textContent).not.toContain('min');
  });
});
