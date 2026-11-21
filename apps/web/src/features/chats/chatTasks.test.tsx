/**
 * Server tasks in a Chat thread (docs/decisions/task-feedback.md AP-4300, AP-4304), against the fixture world's
 * tonight's-work thread (`chatChannelFixtures.ts`, option `tasks`): the running one is a live card, the ended ones are
 * lines, and the words the runtime writes for an older app don't show beside the cards.
 */
import { screen, within } from '@testing-library/react';
import { TASK_CARD_WORDS } from '@whombat/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TASKS_THREAD } from '../../app/chatChannelFixtures';
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

describe('tonight’s server work in Chat (AP-4304)', () => {
  it('shows the running task live and the ended ones as lines in their thread', async () => {
    renderApp(`/chat?thread=${TASKS_THREAD}`, fixtureServices({ tasks: true }));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    const running = await within(pane).findByRole('region', { name: /^Task on the-falcon:/ });
    expect(running.dataset.variant).toBe('live');
    expect(within(running).getByRole('img', { name: TASK_CARD_WORDS.states.running })).toBeTruthy();
    for (const server of ['thetitan', 'pve-01', 'pve-02'])
      expect(
        within(pane).getByRole('region', { name: new RegExp(`^Task on ${server}:`) }).dataset.variant,
      ).toBe('line');
    expect(within(pane).getByRole('region', { name: /^Task on pve-02:/ }).textContent).toContain(
      'the storage is full',
    );
    // The card's line as the message's text (CT-884) folds into the card.
    expect(pane.textContent?.match(/Installing 4 updates on the-falcon/g)).toHaveLength(1);
  });
});
