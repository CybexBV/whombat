/**
 * The `deploy` card as a settled line (docs/decisions/web-messages.md WX-12; contracts CT-297), and Pause on a working
 * run's line (WX-10).
 */
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import type { MessageCard as MessageCardData } from '@whombat/core';
import { run as fixtureRun } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { Providers } from '../../app/providers';
import { fixtureServices } from '../../test/renderApp';
import { deployHost, MessageCard } from './MessageCard';

function renderCard(card: MessageCardData) {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <MessageCard burrow="burrow-hq" card={card} messageId="msg_card" conversationId="cnv_billing-v2" />
      ),
    }),
    history: createMemoryHistory({ initialEntries: ['/c/billing-v2'] }),
  });
  render(
    <Providers services={fixtureServices()}>
      <RouterProvider router={router} />
    </Providers>,
  );
}

describe('the deploy line (WX-12)', () => {
  it('says what went where with its sha, and links the deployed address and the Deploys board', async () => {
    renderCard({
      kind: 'deploy',
      deploymentId: 'dpl_1',
      environment: 'production',
      service: 'api',
      status: 'succeeded',
      sha: '3f9c2a1b0d',
      url: 'https://api.example.com/health',
      runId: null,
    });
    const line = await screen.findByRole('region', { name: 'Deploy: api to production' });
    expect(line.dataset.variant).toBe('line');
    expect(line.textContent).toContain('Deployed api to production');
    expect(line.textContent).toContain('3f9c2a');
    const site = within(line).getByRole('link', { name: 'api.example.com (opens in a new tab)' });
    expect(site.getAttribute('href')).toBe('https://api.example.com/health');
    expect(site.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(line).getByRole('link', { name: 'Deploys' }).getAttribute('href')).toBe('/deploys');
    expect(within(line).queryByRole('button', { name: 'Show card' })).toBeNull();
  });

  it('says a failed deploy in the bad tone, without an address it doesn’t have', async () => {
    renderCard({
      kind: 'deploy',
      deploymentId: 'dpl_2',
      environment: 'staging',
      service: 'web',
      status: 'failed',
      sha: null,
      url: null,
      runId: null,
    });
    const line = await screen.findByRole('region', { name: 'Deploy: web to staging' });
    expect(line.textContent).toContain('Deploy of web to staging failed');
    expect(
      within(line)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Deploys']);
    expect(deployHost('ftp://example.com')).toBeNull();
  });
});

describe('Pause on a working run’s line (WX-10)', () => {
  it('offers Pause while it works', async () => {
    renderCard({
      kind: 'run',
      run: {
        ...fixtureRun,
        status: 'live',
        diff: { add: 0, del: 0, files: 0 },
        prNumber: null,
        attention: null,
      },
    });
    expect(await screen.findByRole('button', { name: `Pause run #${fixtureRun.number}` })).toBeTruthy();
  });
});
