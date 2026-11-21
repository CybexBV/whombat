/**
 * Deploys (`/deploys`, docs/decisions/work-removal.md AP-850; was Work · Deploys, web-efficiency.md WE-17; feature 5,
 * contracts CT-296): what runs where — per environment, per service the live version, who deployed it and when, its
 * link, a newer failed attempt and the version before — and the history of every recorded deploy. Pure: the words.
 */
import {
  DEPLOYMENT_HOW_LABELS,
  DEPLOYMENT_STATUS_PILLS,
  type DeployEnvironment,
  type Deployment,
  type DeployServiceState,
  deployLine,
  shortSha,
} from '@whombat/core';

export const DEPLOYS_TEXT = {
  title: 'Deploys',
  subtitle: 'What runs where: every deploy your agent and deploy jobs recorded, the live version first.',
  environments: 'ENVIRONMENTS',
  history: 'HISTORY',
  empty: 'No deploys recorded yet. Your agent records every deploy it does, and it shows here.',
  emptyFilter: 'No deploys of this environment yet.',
  loadFailed: 'Couldn’t load the deploys. Try again in a moment.',
  loadMore: 'Load more',
  all: 'All',
  open: 'Open',
  noLive: 'Nothing live yet',
} as const;

/** “7be20f · main”, “7be20f”, “main”, or “—” when the deployer said neither. */
export function versionText(d: Pick<Deployment, 'sha' | 'ref'>): string {
  const parts = [d.sha ? shortSha(d.sha) : null, d.ref].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}

export interface ServiceRow {
  key: string;
  service: string;
  /** What runs there now (null: only failed attempts so far). */
  live: Deployment | null;
  /** A newer attempt that failed: production still runs `live`. */
  failed: Deployment | null;
  previous: Deployment | null;
  pill: { text: string; tone: 'ok' | 'bad' };
}

/** A board row: the live version, and the pill FAILED while a newer attempt failed (DEPLOYED otherwise). */
export function serviceRow(environment: string, s: DeployServiceState): ServiceRow {
  const failed = s.failed ?? null;
  return {
    key: `${environment}\u0000${s.service}`,
    service: s.service,
    live: s.current ?? null,
    failed,
    previous: s.previous ?? null,
    pill: failed
      ? { text: DEPLOYMENT_STATUS_PILLS.failed, tone: 'bad' }
      : { text: DEPLOYMENT_STATUS_PILLS.succeeded, tone: 'ok' },
  };
}

/** “Previous 2a6e0c”, or null without one. */
export function previousText(previous: Deployment | null): string | null {
  return previous ? `Previous ${versionText(previous)}` : null;
}

/** A history row's meta: “GitHub Actions · main”. */
export function howText(d: Pick<Deployment, 'how' | 'ref'>): string {
  return [DEPLOYMENT_HOW_LABELS[d.how], d.ref].filter(Boolean).join(' · ');
}

/** The history row's line (core's words): “Deployed api to production · 7be20f”. */
export function historyLine(d: Deployment): string {
  return deployLine(d);
}

/** The board's environment names, for the history's chips (the board's order: most recently deployed first). */
export function environmentNames(environments: readonly DeployEnvironment[]): string[] {
  return environments.map((e) => e.environment);
}
