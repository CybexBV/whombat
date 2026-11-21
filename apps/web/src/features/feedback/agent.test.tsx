/**
 * The agent assesses every report and builds the fix once you say yes (Whombat one-agent.md OA-16; app
 * one-agent.md AP-4935): a new integration has nobody to pick, and Create sends the agent for both, never a channel.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { burrow } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { recordingWorld } from '../../test/recordingWorld';
import { mockedServices, renderApp } from '../../test/renderApp';

describe('the agent of a new integration', () => {
  it('assesses and builds fixes, and Create sends it for both', async () => {
    const user = userEvent.setup();
    const { fetch, calls } = recordingWorld({});
    renderApp('/settings/feedback/new', mockedServices(fetch));
    await user.type(await screen.findByLabelText('NAME'), 'Docs');
    await user.type(screen.getByLabelText('PRODUCT'), 'Docs');
    await user.type(screen.getByLabelText('ALLOWED ORIGINS'), 'https://docs.example.com');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const assessed = await screen.findByRole('group', { name: 'ASSESSED BY' });
    expect(within(assessed).getByText('Neo')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /ASSESS|BUILT/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Create integration' }));
    const path = `/burrows/${burrow.slug}/feedback/integrations`;
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === path)).toBe(true));
    const body = calls.find((c) => c.method === 'POST' && c.path === path)?.body as Record<string, unknown>;
    // One agent (one-agent.md AP-4935): no agent ids, the fix is on or off, never a channel.
    expect(body).toMatchObject({ handoff: 'on' });
    for (const gone of ['agentId', 'handoffAgentId', 'channelId']) expect(body).not.toHaveProperty(gone);
  });
});
