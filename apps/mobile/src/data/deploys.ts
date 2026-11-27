/**
 * Deploys on the phone (contracts 0.55, CT-296, CT-297; mobile-parity.md MQ-07, work-removal-android.md AP-858): what is
 * live where — each environment's services with the deploy that runs now, a newer attempt that failed and the one
 * before (where a rollback goes) — and the history, newest first. Core holds the words (`deployLine`,
 * `DEPLOYMENT_STATUS_PILLS`, `DEPLOYMENT_HOW_LABELS`, `shortSha`); the rest is ours (not in the mocks). Pure.
 */
import {
  type DeployEnvironment,
  type Deployment,
  type DeployServiceState,
  deployLine,
  deploymentHowLabels,
  deploymentStatusPills,
  formatAgo,
  shortSha,
  type Tone,
} from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import type { ViewContext } from './people';

type DeployContext = Pick<ViewContext, 'people' | 'now' | 'timeZone' | 'locale'>;

export function deploysText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    environments: t('data.deploys.environments'),
    history: t('data.deploys.history'),
    empty: t('data.deploys.empty'),
    loadFailed: t('data.deploys.loadFailed'),
    loadMore: t('data.deploys.loadMore'),
    now: t('data.deploys.now'),
    failedAttempt: t('data.deploys.failedAttempt'),
    before: t('data.deploys.before'),
    nothingLive: t('data.deploys.nothingLive'),
    openSite: t('data.deploys.openSite'),
    openConversation: t('data.deploys.openConversation'),
    summary: t('data.deploys.summary'),
  };
}

export const DEPLOYS_TEXT = deploysText();

/** The pill's tone: deployed ok, failed bad. */
export function deployTone(status: Deployment['status']): Tone {
  return status === 'succeeded' ? 'ok' : 'bad';
}

/** “Banjo · 2 h ago · GitHub Actions · 9b1e4c”: who, when, how and the commit. */
export function deployMeta(d: Deployment, ctx: DeployContext): string {
  return [
    ctx.people.name(d.byId) ?? mobileTranslator(ctx.locale).t('data.approval.someone'),
    formatAgo(d.createdAt, ctx.now, ctx.timeZone, ctx.locale),
    deploymentHowLabels(ctx.locale)[d.how],
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

function lineOf(d: Deployment, ctx: DeployContext): DeployLineModel {
  return {
    id: d.id,
    pill: deploymentStatusPills(ctx.locale)[d.status],
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
  ctx: DeployContext,
): DeployEnvironmentModel[] {
  const { t } = mobileTranslator(ctx.locale);
  const text = deploysText(ctx.locale);
  return environments.map((env) => ({
    environment: env.environment,
    label: `${env.environment.toUpperCase()} · ${formatAgo(env.lastAt, ctx.now, ctx.timeZone, ctx.locale)}`,
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
          t('data.deploys.serviceIn', { service: s.service, environment: env.environment }),
          current ? `${text.now}: ${current.meta}` : text.nothingLive,
          failed ? `${text.failedAttempt}: ${failed.meta}` : null,
          previous ? `${text.before}: ${previous.meta}` : null,
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
export function deployHistory(deployments: readonly Deployment[], ctx: DeployContext): DeployHistoryRow[] {
  return deployments.map((d) => {
    const line = lineOf(d, ctx);
    const title = deployLine(d, ctx.locale);
    return { ...line, title, accessibilityLabel: `${title}. ${line.meta}` };
  });
}

/** A deploy opened: its facts, its summary (burrow-visible), and where it leads. */
export function deployDetail(
  d: Deployment,
  ctx: DeployContext,
): {
  title: string;
  pill: string;
  tone: Tone;
  facts: { label: string; value: string }[];
  summary: string;
  url: string | null;
  conversationId: string | null;
} {
  const { t } = mobileTranslator(ctx.locale);
  return {
    title: deployLine(d, ctx.locale),
    pill: deploymentStatusPills(ctx.locale)[d.status],
    tone: deployTone(d.status),
    facts: [
      { label: t('data.deploys.fact.environment'), value: d.environment },
      { label: t('data.deploys.fact.service'), value: d.service },
      { label: t('data.deploys.fact.how'), value: deploymentHowLabels(ctx.locale)[d.how] },
      ...(d.repo ? [{ label: t('data.deploys.fact.repo'), value: d.repo }] : []),
      ...(d.ref ? [{ label: t('data.deploys.fact.ref'), value: d.ref }] : []),
      ...(d.sha ? [{ label: t('data.deploys.fact.commit'), value: shortSha(d.sha) }] : []),
      { label: t('data.deploys.fact.by'), value: ctx.people.name(d.byId) ?? t('data.approval.someone') },
      {
        label: t('data.deploys.fact.when'),
        value: formatAgo(d.createdAt, ctx.now, ctx.timeZone, ctx.locale),
      },
    ],
    summary: d.summary,
    url: d.url,
    conversationId: d.conversationId,
  };
}
