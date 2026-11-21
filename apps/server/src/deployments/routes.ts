/**
 * The Deploys screen's reads (docs/decisions/review-features.md): the history and the
 * environments board, each deploy with the conversation and message of its card. Deploys are recorded by agents
 * (`record_deploy`) and Whombat's deploy jobs, never through REST.
 */
import { api } from '@whombat/core';
import { route } from '../routes/define';
import { deployEnvironments, deploymentsPage } from './store';

export const deploymentRoutes = [
  route(api.deployments.list, async ({ access, query, services }) =>
    deploymentsPage(services.db, access.burrow.id, query),
  ),

  route(api.deployments.environments, async ({ access, services }) =>
    deployEnvironments(services.db, access.burrow.id),
  ),
];
