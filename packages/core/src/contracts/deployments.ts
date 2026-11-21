/**
 * Deployments (Whombat improvement-review feature 5, RF-02, WE-17, MQ-07; contracts 0.55.0, CT-296): the history and
 * the environments board of Work · Deploys. Reads only: deploys are recorded by agents (`record_deploy`) and by
 * Whombat's deploy jobs, never through REST. Feature `deployments`; session ops too (`deployments.*`).
 */
import { z } from 'zod';
import { Cursor, Timestamp } from '../domain/common.js';
import {
  DEPLOY_ENVIRONMENTS_MAX,
  DEPLOY_SERVICES_MAX,
  DeployEnvironmentName,
  Deployment,
  DeployServiceName,
  deployGroupKey,
} from '../domain/deployment.js';
import { BurrowParam, endpoint, limitQuery } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

/** `deployments.list`: newest first; one environment or service (case-insensitive) when asked. */
export const DeploymentsQuery = z.object({
  environment: DeployEnvironmentName.optional(),
  service: DeployServiceName.optional(),
  /** The page after this one (`DeploymentsPage.before`). */
  before: Cursor.optional(),
  limit: limitQuery(50),
});
export type DeploymentsQuery = z.infer<typeof DeploymentsQuery>;

export const DeploymentsPage = z.object({
  /** Newest first. */
  deployments: z.array(Deployment),
  /** Cursor for older deployments, or null at the first one. */
  before: Cursor.nullable(),
});
export type DeploymentsPage = z.infer<typeof DeploymentsPage>;

/**
 * One service in one environment on the board: what runs there now (`current`, the newest deploy that succeeded), the
 * newest attempt when it is newer than `current` and failed (`failed`: a red row that still names what runs), and the
 * deploy that succeeded before `current` (`previous`: what a rollback goes back to). `current` is null when no deploy
 * there succeeded yet (then `failed` is the newest attempt).
 */
export const DeployServiceState = z.object({
  /** The newest deployment's spelling of the name. */
  service: DeployServiceName,
  current: Deployment.nullable(),
  failed: Deployment.nullable(),
  previous: Deployment.nullable(),
});
export type DeployServiceState = z.infer<typeof DeployServiceState>;

export const DeployEnvironment = z.object({
  /** The newest deployment's spelling of the name. */
  environment: DeployEnvironmentName,
  /** By name (case-insensitive). */
  services: z.array(DeployServiceState).max(DEPLOY_SERVICES_MAX),
  /** The newest deploy in this environment. */
  lastAt: Timestamp,
});
export type DeployEnvironment = z.infer<typeof DeployEnvironment>;

export const DeployEnvironmentsResponse = z.object({
  /** The most recently deployed environment first. */
  environments: z.array(DeployEnvironment).max(DEPLOY_ENVIRONMENTS_MAX),
});
export type DeployEnvironmentsResponse = z.infer<typeof DeployEnvironmentsResponse>;

export const deploymentEndpoints = {
  list: endpoint({
    id: 'deployments.list',
    method: 'GET',
    path: '/burrows/:burrow/deployments',
    summary:
      'Work · Deploys history: recorded deploys, newest first, optionally of one environment or service (feature `deployments`).',
    params: B,
    query: DeploymentsQuery,
    response: DeploymentsPage,
  }),
  environments: endpoint({
    id: 'deployments.environments',
    method: 'GET',
    path: '/burrows/:burrow/deployments/environments',
    summary:
      'Work · Deploys board: per environment, per service, what runs now, the newer failed attempt and the deploy before it (feature `deployments`).',
    params: B,
    response: DeployEnvironmentsResponse,
  }),
};

/** Newest first: by `createdAt`, then by id. */
function newestFirst(a: Deployment, b: Deployment): number {
  return a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1;
}

/**
 * The board from recorded deployments (CT-296): per environment (case-insensitive, `deployGroupKey`), per service, the
 * newest succeeded (`current`), the newest attempt when it failed after that (`failed`) and the succeeded one before
 * `current` (`previous`). Environments most recently deployed first, services by name, within the limits. Pure: the
 * runtime may build it from each service's last few rows, the fixtures from their list.
 */
export function deployEnvironmentsFrom(deployments: readonly Deployment[]): DeployEnvironmentsResponse {
  const envs = new Map<string, Map<string, Deployment[]>>();
  for (const d of deployments) {
    const env = envs.get(deployGroupKey(d.environment)) ?? new Map<string, Deployment[]>();
    envs.set(deployGroupKey(d.environment), env);
    const list = env.get(deployGroupKey(d.service)) ?? [];
    env.set(deployGroupKey(d.service), list);
    list.push(d);
  }
  const environments: DeployEnvironment[] = [];
  for (const services of envs.values()) {
    const rows: DeployServiceState[] = [];
    let newestInEnv: Deployment | null = null;
    const byName = [...services.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [, list] of byName) {
      const sorted = [...list].sort(newestFirst);
      const newest = sorted[0] as Deployment;
      if (!newestInEnv || newestFirst(newest, newestInEnv) < 0) newestInEnv = newest;
      const succeeded = sorted.filter((d) => d.status === 'succeeded');
      rows.push({
        service: newest.service,
        current: succeeded[0] ?? null,
        failed: newest.status === 'failed' ? newest : null,
        previous: succeeded[1] ?? null,
      });
    }
    if (!newestInEnv) continue;
    environments.push({
      environment: newestInEnv.environment,
      services: rows.slice(0, DEPLOY_SERVICES_MAX),
      lastAt: newestInEnv.createdAt,
    });
  }
  environments.sort((a, b) => (a.lastAt === b.lastAt ? 0 : a.lastAt < b.lastAt ? 1 : -1));
  return { environments: environments.slice(0, DEPLOY_ENVIRONMENTS_MAX) };
}
