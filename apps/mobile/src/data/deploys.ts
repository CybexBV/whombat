/**
 * Deploys on the phone (contracts 0.55, CT-296, CT-297; mobile-parity.md MQ-07, work-removal-android.md AP-858): what is
 * live where — each environment's services with the deploy that runs now, a newer attempt that failed and the one
 * before (where a rollback goes) — and the history, newest first. Core holds the words (`deployLine`,
 * `DEPLOYMENT_STATUS_PILLS`, `DEPLOYMENT_HOW_LABELS`, `shortSha`); the rest is ours (not in the mocks). Pure.
 */
import {
  DEPLOYMENT_HOW_LABELS,
  DEPLOYMENT_STATUS_PILLS,
  type DeployEnvironment,
  type Deployment,
  type DeployServiceState,
  deployLine,
  formatAgo,
  shortSha,
  type Tone,
} from '@whombat/core';
import type { ViewContext } from './people';

export const DEPLOYS_TEXT = {
  environments: 'ENVIRONMENTS',
  history: 'HISTORY',
  empty: 'No deploys recorded yet. Agents record every deploy they do here, and post it where they work.',
  loadFailed: 'Deploys didn’t load.',
  loadMore: 'Load more',
  now: 'Live now',
  failedAttempt: 'Last attempt failed',
  before: 'Before',
  nothingLive: 'Nothing live yet',
  openSite: 'Open the deployed site',
  openConversation: 'Open where it was posted',
  summary: 'SUMMARY',
} as const;

/** The pill's tone: deployed ok, failed bad. */
export function deployTone(status: Deployment['status']): Tone {
  return status === 'succeeded' ? 'ok' : 'bad';
}

/** “Banjo · 2 h ago · GitHub Actions · 9b1e4c”: who, when, how and the commit. */
export function deployMeta(d: Deployment, ctx: Pick<ViewContext, 'people' | 'now' | 'timeZone'>): string {
  return [
    ctx.people.name(d.byId) ?? 'Someone',
    formatAgo(d.createdAt, ctx.now, ctx.timeZone),
    DEPLOYMENT_HOW_LABELS[d.how],
    d.sha ? shortSha(d.sha) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export interface DeployLineModel {
  id: string;
  /** “DEPLOYED”, “FAILED”. */
  pill: string;
  tone: Tone;
  meta: string;
  deployment: Deployment;
}

function lineOf(d: Deployment, ctx: Pick<ViewContext, 'people' | 'now' | 'timeZone'>): DeployLineModel {
  return {
    id: d.id,
    pill: DEPLOYMENT_STATUS_PILLS[d.status],
    tone: deployTone(d.status),
    meta: deployMeta(d, ctx),
    deployment: d,
  };
}

export interface DeployServiceRow {
  key: string;
  service: string;
  /** The deploy live now, or null when none succeeded yet. */
  current: DeployLineModel | null;
  /** A newer attempt that failed. */
  failed: DeployLineModel | null;
  /** The one before the live one: where a rollback goes. */
  previous: DeployLineModel | null;
  accessibilityLabel: string;
}

export interface DeployEnvironmentModel {
  environment: string;
  /** “PRODUCTION · 2 h ago”. */
  label: string;
  services: DeployServiceRow[];
}

/** The environments board, in the server's order (newest deployed first, services by name). */
export function deployBoard(
  environments: readonly DeployEnvironment[],
  ctx: Pick<ViewContext, 'people' | 'now' | 'timeZone'>,
): DeployEnvironmentModel[] {
  return environments.map((env) => ({
    environment: env.environment,
    label: `${env.environment.toUpperCase()} · ${formatAgo(env.lastAt, ctx.now, ctx.timeZone)}`,
    services: env.services.map((s: DeployServiceState) => {
      const current = s.current ? lineOf(s.current, ctx) : null;
      const failed = s.failed ? lineOf(s.failed, ctx) : null;
      const previous = s.previous ? lineOf(s.previous, ctx) : null;
      return {
        key: `${env.environment}/${s.service}`,
        service: s.service,
        current,
        failed,
        previous,
        accessibilityLabel: [
          `${s.service} in ${env.environment}`,
          current ? `${DEPLOYS_TEXT.now}: ${current.meta}` : DEPLOYS_TEXT.nothingLive,
          failed ? `${DEPLOYS_TEXT.failedAttempt}: ${failed.meta}` : null,
          previous ? `${DEPLOYS_TEXT.before}: ${previous.meta}` : null,
        ]
          .filter(Boolean)
          .join('. '),
      };
    }),
  }));
}

export interface DeployHistoryRow extends DeployLineModel {
  /** “Deployed api to production · 3f9c2a”. */
  title: string;
  accessibilityLabel: string;
}

/** The history, newest first: each deploy's line, its pill and who, when, how. */
export function deployHistory(
  deployments: readonly Deployment[],
  ctx: Pick<ViewContext, 'people' | 'now' | 'timeZone'>,
): DeployHistoryRow[] {
  return deployments.map((d) => {
    const line = lineOf(d, ctx);
    const title = deployLine(d);
    return { ...line, title, accessibilityLabel: `${title}. ${line.meta}` };
  });
}

/** A deploy opened: its facts, its summary (burrow-visible), and where it leads. */
export function deployDetail(
  d: Deployment,
  ctx: Pick<ViewContext, 'people' | 'now' | 'timeZone'>,
): {
  title: string;
  pill: string;
  tone: Tone;
  facts: { label: string; value: string }[];
  summary: string;
  url: string | null;
  conversationId: string | null;
} {
  return {
    title: deployLine(d),
    pill: DEPLOYMENT_STATUS_PILLS[d.status],
    tone: deployTone(d.status),
    facts: [
      { label: 'ENVIRONMENT', value: d.environment },
      { label: 'SERVICE', value: d.service },
      { label: 'HOW', value: DEPLOYMENT_HOW_LABELS[d.how] },
      ...(d.repo ? [{ label: 'REPO', value: d.repo }] : []),
      ...(d.ref ? [{ label: 'REF', value: d.ref }] : []),
      ...(d.sha ? [{ label: 'COMMIT', value: shortSha(d.sha) }] : []),
      { label: 'BY', value: ctx.people.name(d.byId) ?? 'Someone' },
      { label: 'WHEN', value: formatAgo(d.createdAt, ctx.now, ctx.timeZone) },
    ],
    summary: d.summary,
    url: d.url,
    conversationId: d.conversationId,
  };
}
