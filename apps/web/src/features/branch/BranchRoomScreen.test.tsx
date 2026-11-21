/** The branch room on the fixture world. */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { applyRealtimeEvent, queryKeys } from '@whombat/client/query';
import type { PullRequestDetail } from '@whombat/core';
import { prApproved } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { fixtureServices, renderApp } from '../../test/renderApp';

const PR_KEY = queryKeys.prs.get({ params: { burrow: 'burrow-hq', number: 482 } });

describe('branch room', () => {
  it('follows pr.updated live: the chip, checks and reviewers change and Merge turns on', async () => {
    const services = fixtureServices();
    renderApp('/pr/482', services);
    await screen.findByText('Open · changes requested');
    act(() => {
      applyRealtimeEvent(services.queryClient, { type: 'pr.updated', pr: prApproved });
    });
    expect(await screen.findByText('Open · ready')).toBeTruthy();
    const pane = screen.getByRole('complementary', { name: 'Pull request' });
    expect(within(pane).getByText('Approved')).toBeTruthy();
    expect(within(pane).getByRole('button', { name: 'Merge into main' }).getAttribute('aria-disabled')).toBe(
      'false',
    );
  });

  it('shows the server’s refusal when a merge is blocked (409), and merges once the PR is ready', async () => {
    const user = userEvent.setup();
    const services = fixtureServices();
    renderApp('/pr/482', services);
    await screen.findByText('Open · changes requested');
    // A stale view that thinks the PR can be merged: the server (fixtures) still refuses.
    act(() => {
      services.queryClient.setQueryData(PR_KEY, (d: PullRequestDetail | undefined) =>
        d ? { ...d, mergeBlock: null } : d,
      );
    });
    await user.click(screen.getByRole('button', { name: 'Merge into main' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Checks have to pass before this can be merged.',
    );

    // Approving the deploy fast-forwards the fixture storyline: checks green, Waffle approved.
    await services.client.approvals.decide({
      params: { burrow: 'burrow-hq', number: 12 },
      body: { decision: 'approve' },
    });
    await act(() => services.queryClient.invalidateQueries({ queryKey: queryKeys.scope('prs.get') }));
    const merge = await screen.findByRole('button', { name: 'Merge into main' });
    await waitFor(() => expect(merge.getAttribute('aria-disabled')).toBe('false'));
    await user.click(merge);
    expect(await screen.findByText('Merged PR #482. Nice digging, everyone.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Merged into main' })).toBeTruthy();
    expect(screen.getByText('Merged')).toBeTruthy();
  });
});

describe('branch room quiet states (TODO 16.4)', () => {
  it('shows a one-line error with Retry when the pull request fails to load', async () => {
    const user = userEvent.setup();
    renderApp('/pr/482', fixtureServices({ failing: ['prs.get'] }));
    expect(
      await screen.findByText('There’s no branch room for this pull request, or you’re not in it.'),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByText('There’s no branch room for this pull request, or you’re not in it.'),
    ).toBeTruthy();
  });
});
