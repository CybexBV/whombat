/**
 * A one-time Find My watch in Chat (findmy-watch.md): the card says whom it watches for and until when, with Cancel
 * while it watches; once ended it is one line with nothing to press. The words are core's; this checks the facts.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { jsonAnswer, recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';

const B = `/burrows/${burrow.slug}`;

async function openThread(name: RegExp) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('link', { name }));
  const pane = await screen.findByRole('complementary', { name: 'Thread' });
  return { user, pane };
}

describe('the Find My watch card (findmy-watch.md)', () => {
  it('watches with Cancel, and cancelling turns it into one line', async () => {
    const { fetch, calls } = recordingWorld({ resourceful: true });
    renderApp('/chat', mockedServices(fetch));
    const { user, pane } = await openThread(/^I’ll tell you when Noor Visser leaves/);
    const card = await within(pane).findByRole('region', { name: /Noor Visser.*Keizersgracht/ });
    expect(card.dataset.watchStatus).toBe('watching');
    expect(within(card).getByText(/^Until /)).toBeTruthy();

    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: `${B}/find-my/watches/fmw_noor/cancel`,
      body: {},
    });
    await waitFor(() => {
      const line = within(pane).getByRole('region', { name: /Noor Visser/ });
      expect(line.dataset.variant).toBe('line');
      expect(within(line).queryByRole('button')).toBeNull();
    });
  });

  it('shows an ended watch as one line with what happened and when', async () => {
    const { fetch } = recordingWorld({ resourceful: true });
    renderApp('/chat', mockedServices(fetch));
    const { pane } = await openThread(/^I’ll tell you when Ruben Dekker arrives/);
    const line = await within(pane).findByRole('region', { name: /Ruben Dekker.*Home/ });
    expect(line.dataset.variant).toBe('line');
    expect(line.textContent).toMatch(/Ruben Dekker.*Home.*\d\d:\d\d/);
    expect(within(line).queryByRole('button')).toBeNull();
  });

  it('says why when the cancel is refused, and keeps Cancel', async () => {
    const { fetch } = recordingWorld({ resourceful: true }, (call, res) =>
      call.path.endsWith('/cancel')
        ? jsonAnswer({ error: { code: 'forbidden', message: 'Only Mara can stop this watch.' } }, 403)
        : res,
    );
    renderApp('/chat', mockedServices(fetch));
    const { user, pane } = await openThread(/^I’ll tell you when Noor Visser leaves/);
    const card = await within(pane).findByRole('region', { name: /Noor Visser.*Keizersgracht/ });
    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(await within(card).findByRole('alert')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});
