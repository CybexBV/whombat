/**
 * The agent's schedules (Whombat resourceful-agents.md RA-30; AP-684): the card in its Chat thread with Cancel, where the runtime
 * has `agents.schedules`. The list with Pause and Remove is in Automations (automationChat.test.tsx).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';

const B = `/burrows/${burrow.slug}`;

describe('the schedule card in the room (RA-30; AP-684)', () => {
  it('says what Neo scheduled and when it runs next, and cancels it', async () => {
    const { fetch, calls } = recordingWorld({ resourceful: true });
    const user = userEvent.setup();
    renderApp('/chat', mockedServices(fetch));
    // Its message is a thread of Chat's (chat-inbox-web.md): the card shows in the thread.
    await user.click(await screen.findByRole('link', { name: /^I’ll check last night’s backups/ }));
    const pane = await screen.findByRole('complementary', { name: 'Thread' });
    // A schedule is a line (card-settle AP-731): when, what, and Cancel while it is to come; it opens the card.
    const line = await within(pane).findByRole('region', { name: /^Neo scheduled: Check last night/ });
    expect(line.dataset.variant).toBe('line');
    expect(line.textContent).toMatch(/^Every weekday at 08:30 · Check last night’s backups/);
    await user.click(within(line).getByRole('button', { name: 'Show card' }));
    const card = within(line).getByRole('region', { name: /^Neo scheduled: Check last night/ });
    expect(within(card).getByText('SCHEDULE · ACTIVE')).toBeTruthy();
    expect(within(card).getByText(/^Every weekday at 08:30 · next /)).toBeTruthy();

    await user.click(within(line).getAllByRole('button', { name: 'Cancel' })[0] as HTMLElement);
    expect(await screen.findByText('Cancelled. Neo won’t run it again.')).toBeTruthy();
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: `${B}/agent/schedules/sch_backups` });
    await waitFor(() => expect(within(card).getByText('SCHEDULE · ENDED')).toBeTruthy());
    expect(within(card).getByText(/· Ended · Cancelled$/)).toBeTruthy();
    expect(line.textContent).toMatch(/^Cancelled/);
    expect(within(line).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
