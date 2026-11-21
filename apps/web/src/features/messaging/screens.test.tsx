/**
 * A conversation screen on the fixture world (the branch room: channels and DMs went with one agent, one-agent.md
 * AP-4949) (no socket: agent replies are simulated after a real
 * `setTimeout`, `FIXTURE_REPLY_DELAY_MS` = 1.6 s in production). The test that crosses that delay holds
 * the reply with `__holdFixtureRepliesForTests` and releases it once it has seen "{name} is thinking", so
 * it waits on state changes (`findByText`) rather than racing a wall-clock window — it runs the same on a
 * loaded machine (this was a source of CI flakiness, see docs/decisions/polish-ci.md and
 * docs/decisions/security-fixes.md). Fake timers were tried first but don't mix safely with the fixture
 * fetch/react-query stack used to render these screens (see docs/decisions/polish-ci.md).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { pinMockDate } from '../../test/clock';
import { fixtureServices, renderApp } from '../../test/renderApp';
import { __setFixtureReplyDelayForTests } from './useRoom';

afterEach(() => {
  __setFixtureReplyDelayForTests(null);
});

pinMockDate();

describe('a conversation with people (the branch room)', () => {
  it('opens the thread full width from the replies link and posts replies there (AP-670)', async () => {
    const user = userEvent.setup();
    const app = renderApp('/pr/482', fixtureServices({ essentials: true }));
    await user.click(await screen.findByRole('link', { name: /2 replies/ }));
    await waitFor(() => expect(app.location()).toBe('/pr/482?thread=msg_billing-mara-1127&focus=1'));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    expect(pane.dataset.focus).toBe('true');
    await user.type(
      await within(pane).findByRole('textbox', { name: 'Reply in thread' }),
      'Thanks, all.{Enter}',
    );
    expect(await within(pane).findByText('Thanks, all.')).toBeTruthy();
    await user.click(within(pane).getByRole('button', { name: 'Close thread' }));
    await waitFor(() => expect(app.location()).toBe('/pr/482'));
  });
});
