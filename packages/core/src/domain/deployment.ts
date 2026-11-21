/**
 * Deployments (Whombat improvement-review feature 5, RF-02; contracts 0.55.0, CT-296): a record of each deploy of a
 * service to an environment — by an agent (`record_deploy`) or by a deploy job Whombat ran (the GitHub Actions deploy
 * executor) — so people see what runs where (Work · Deploys: the environments board and the history) and the room
 * gets a `deploy` card. Pure: the record, its limits, the card and the copy.
 *
 * A deployment is never edited: a redeploy is a new record whose `previousId` points at the deployment of the same
 * service and environment that succeeded before it. The summary is the deployer's own words.
 */
import { z } from 'zod';
import { ConversationId, DeploymentId, MessageId, PrincipalId, RunId } from '../ids.js';
import { shortSha } from '../text/format.js';
import { RepoFullName, Timestamp } from './common.js';

/** An environment's name, in characters (“production”, “staging”, “preview-482”). */
export const DEPLOY_ENVIRONMENT_MAX = 60;
/** A service's name, in characters (“api”, “web”, “whombat.com”). */
export const DEPLOY_SERVICE_MAX = 80;
/** A deployment's summary, in characters. Everyone in the burrow reads it. */
export const DEPLOY_SUMMARY_MAX = 500;
/** A ref (“main”, “v1.4.2”, “refs/tags/v1.4.2”), in characters. */
export const DEPLOY_REF_MAX = 255;
/** At most this many environments on the board (`deployments.environments`), the most recently deployed first. */
export const DEPLOY_ENVIRONMENTS_MAX = 50;
/** At most this many services in one environment on the board. */
export const DEPLOY_SERVICES_MAX = 200;

/** No control characters; the server trims and collapses whitespace (`normalizeDeployName`). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const NO_CONTROL = /^[^\u0000-\u001f\u007f]+$/;

/** Where a deploy went: the name the team uses (“production”, “staging”). Grouped case-insensitively. */
export const DeployEnvironmentName = z.string().trim().min(1).max(DEPLOY_ENVIRONMENT_MAX).regex(NO_CONTROL);
/** What was deployed: an app or service (“api”, “web”). Grouped case-insensitively. */
export const DeployServiceName = z.string().trim().min(1).max(DEPLOY_SERVICE_MAX).regex(NO_CONTROL);
/** A commit id, full or abbreviated (7–64 hex characters). */
export const DeploySha = z
  .string()
  .regex(/^[0-9a-fA-F]{7,64}$/, 'Expected a commit id (7–64 hex characters)');
/** Where the deployed thing can be seen: an http(s) URL. */
export const DeployUrl = z.url({ protocol: /^https?$/ }).max(2048);
/** A branch, tag or ref. */
export const DeployRef = z.string().trim().min(1).max(DEPLOY_REF_MAX).regex(NO_CONTROL);

/** How a deploy ended. Only finished deploys are recorded. */
export const DeploymentStatus = z.enum(['succeeded', 'failed']);
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;

/**
 * How it was done: a GitHub Actions workflow (an agent's dispatch or Whombat's deploy executor), over SSH (`ssh`, `scp`,
 * `rsync` from the agent's commands), with another command-line tool (`cli`: `wrangler`, `fly`, `vercel`; `computer`
 * until 3.0, CT-1539), or anything else.
 */
export const DeploymentHow = z.enum(['github_actions', 'ssh', 'cli', 'other']);
export type DeploymentHow = z.infer<typeof DeploymentHow>;

/** Mono pills on the board and the card. */
export const DEPLOYMENT_STATUS_PILLS: Readonly<Record<DeploymentStatus, string>> = {
  succeeded: 'DEPLOYED',
  failed: 'FAILED',
};

export const DEPLOYMENT_HOW_LABELS: Readonly<Record<DeploymentHow, string>> = {
  github_actions: 'GitHub Actions',
  ssh: 'SSH',
  cli: 'Command line',
  other: 'Other',
};

/**
 * One recorded deploy. Optional facts are null when the deployer didn't say.
 */
export const Deployment = z.object({
  id: DeploymentId,
  environment: DeployEnvironmentName,
  service: DeployServiceName,
  status: DeploymentStatus,
  how: DeploymentHow,
  /** The repository the deployed code came from (`owner/name`). */
  repo: RepoFullName.nullable().default(null),
  ref: DeployRef.nullable().default(null),
  sha: DeploySha.nullable().default(null),
  url: DeployUrl.nullable().default(null),
  /** The deployer's words: what changed, anything to watch. Everyone in the burrow reads it. */
  summary: z.string().max(DEPLOY_SUMMARY_MAX),
  /** Who deployed: the agent that recorded it, or the person whose approval ran the deploy job. */
  byId: PrincipalId,
  /** The run it was part of. */
  runId: RunId.nullable().default(null),
  /** Where its `deploy` card was posted; null when it wasn't. */
  conversationId: ConversationId.nullable().default(null),
  messageId: MessageId.nullable().default(null),
  /** The deployment of the same service and environment that succeeded before this one (null: the first). */
  previousId: DeploymentId.nullable().default(null),
  createdAt: Timestamp,
});
export type Deployment = z.infer<typeof Deployment>;

/**
 * The `deploy` card (CT-297): posted by the server, as the deployer, in the thread of the turn that recorded the
 * deploy (or the conversation of the deploy job's approval). Server-made only: never `PostableCard`. The same shape is
 * stored. A settled one-line card (card-settle): `deployLine(card)` says it, linking to the deployment
 * (`/work/deploys`) and `url`.
 */
export const DeployCard = z.object({
  kind: z.literal('deploy'),
  deploymentId: DeploymentId,
  environment: DeployEnvironmentName,
  service: DeployServiceName,
  status: DeploymentStatus,
  sha: DeploySha.nullable().default(null),
  url: DeployUrl.nullable().default(null),
  /**
   * The run it was part of (as CT-261's `skill` and `schedule` cards): a chat shows it inside that run's line. Null or
   * absent: on its own.
   */
  runId: RunId.nullable().optional(),
});
export type DeployCard = z.infer<typeof DeployCard>;

/** Trimmed, whitespace collapsed: how an environment or service name is stored. */
export function normalizeDeployName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** The key the board groups environments and services by: names that differ only in case are one. */
export function deployGroupKey(name: string): string {
  return normalizeDeployName(name).toLowerCase();
}

/**
 * The one line a deploy says (the settled card, the board's history, notifications): “Deployed api to production ·
 * 3f9c2a”, “Deploy of api to production failed · 3f9c2a”.
 */
export function deployLine(d: Pick<DeployCard, 'service' | 'environment' | 'status' | 'sha'>): string {
  const what =
    d.status === 'succeeded'
      ? `Deployed ${d.service} to ${d.environment}`
      : `Deploy of ${d.service} to ${d.environment} failed`;
  return d.sha ? `${what} · ${shortSha(d.sha.toLowerCase())}` : what;
}

/** The card as text (inbox, search, other agents' windows): `[deploy: api to production, succeeded]`. */
export function deployCardText(card: Pick<DeployCard, 'service' | 'environment' | 'status'>): string {
  return `[deploy: ${card.service} to ${card.environment}, ${card.status}]`;
}
