/**
 * Recorded deploys in the mock world (contracts 0.55, CT-296): Dusty shipped the invoice PDF work to staging and then
 * production, one production deploy of the API failed after it, and Dusty deployed the web app over SSH. Work · Deploys
 * (WE-17, MQ-07) shows them; the API deploys were asked for in the PR #482 branch room, where Mara is, so their
 * conversation is filled.
 */
import {
  type DeployEnvironmentsResponse,
  type DeploymentsPage,
  deployEnvironmentsFrom,
} from '@whombat/core/contracts';
import { type Deployment, deployGroupKey } from '@whombat/core/domain';
import { cnv_pr482 } from './conversations.js';
import { dusty } from './principals.js';
import { at } from './time.js';

const base = {
  repo: 'lumio/billing',
  ref: 'main',
  url: null,
  runId: null,
  conversationId: null,
  messageId: null,
  previousId: null,
} as const;

/** Newest first. */
export const DEPLOYMENTS: readonly Deployment[] = [
  {
    ...base,
    id: 'dpl_api-prod-3',
    environment: 'production',
    service: 'api',
    status: 'failed',
    how: 'github_actions',
    sha: '9b1e4c7d2a5f8e3b6c9d0a1f4e7b2c5d8a3f6e9b',
    summary: 'The migration step timed out on the invoices table; production still runs 7be20f.',
    byId: dusty.id,
    conversationId: cnv_pr482.id,
    previousId: 'dpl_api-prod-2',
    createdAt: at('11:05'),
  },
  {
    ...base,
    id: 'dpl_api-prod-2',
    environment: 'production',
    service: 'api',
    status: 'succeeded',
    how: 'github_actions',
    sha: '7be20f3a9c1d4e8b2f6a0c5d9e3b7f1a4c8d2e6b',
    url: 'https://api.lumio.example',
    summary: 'Invoice PDFs render on the server now; the old export endpoint stays for a week.',
    byId: dusty.id,
    conversationId: cnv_pr482.id,
    previousId: 'dpl_api-prod-1',
    createdAt: at('10:40'),
  },
  {
    ...base,
    id: 'dpl_api-staging-1',
    environment: 'staging',
    service: 'api',
    status: 'succeeded',
    how: 'github_actions',
    sha: '7be20f3a9c1d4e8b2f6a0c5d9e3b7f1a4c8d2e6b',
    url: 'https://staging.api.lumio.example',
    summary: 'Invoice PDF export for review.',
    byId: dusty.id,
    conversationId: cnv_pr482.id,
    createdAt: at('09:15'),
  },
  {
    ...base,
    id: 'dpl_web-prod-1',
    environment: 'production',
    service: 'web',
    status: 'succeeded',
    how: 'ssh',
    repo: 'lumio/web',
    sha: 'c4d8e2f6a0b3c7d1e5f9a2b6c0d4e8f2a6b0c3d7',
    url: 'https://lumio.example',
    summary: 'New pricing page copied to the web server.',
    byId: dusty.id,
    createdAt: at('16:30', -1),
  },
  {
    ...base,
    id: 'dpl_api-prod-1',
    environment: 'production',
    service: 'api',
    status: 'succeeded',
    how: 'github_actions',
    sha: '2a6e0c4f8b1d5a9e3c7f0b4d8a2e6c0f4b8d1a5e',
    url: 'https://api.lumio.example',
    summary: 'Weekly release: faster invoice search.',
    byId: dusty.id,
    createdAt: at('14:00', -2),
  },
];

/** `deployments.list` over the fixtures: an environment or service (case-insensitive), `limit`, no further pages. */
export function deploymentsPage(
  query: { environment?: string | null; service?: string | null; limit?: number | null } = {},
  deployments: readonly Deployment[] = DEPLOYMENTS,
): DeploymentsPage {
  const env = query.environment ? deployGroupKey(query.environment) : null;
  const service = query.service ? deployGroupKey(query.service) : null;
  const matching = deployments.filter(
    (d) =>
      (!env || deployGroupKey(d.environment) === env) && (!service || deployGroupKey(d.service) === service),
  );
  return { deployments: matching.slice(0, query.limit ?? 50), before: null };
}

/** `deployments.environments` over the fixtures. */
export function deploymentEnvironments(
  deployments: readonly Deployment[] = DEPLOYMENTS,
): DeployEnvironmentsResponse {
  return deployEnvironmentsFrom(deployments);
}

export const DEPLOYMENT_ENDPOINT_IDS = ['deployments.list', 'deployments.environments'] as const;
