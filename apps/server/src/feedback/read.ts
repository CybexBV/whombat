/**
 * Reading Whombat Feedback (docs/decisions/feedback.md FB-16, FB-17): the full `FeedbackReport` (the burrow's; the
 * caller checks), an integration's installation snippets and its live health.
 */
import {
  basicSnippet,
  cspAdvice,
  customLauncherSnippet,
  FEEDBACK_DROP_TEXT,
  FEEDBACK_MAX_ASSESSMENT_ATTEMPTS,
  FeedbackContext,
  type FeedbackDropDelivery,
  type FeedbackHealthWarning,
  type FeedbackIntegrationHealth,
  type FeedbackReport,
  type FeedbackSnippets,
  feedbackDropExpiredText,
  feedbackDropNotFiledText,
} from '@whombat/core';
import { and, asc, count, eq, gt, gte, inArray, max, sum } from 'drizzle-orm';
import { managedAppOrigin, managedEmbedOrigin } from '../config';
import type { Db } from '../db/client';
import {
  approvals,
  attachments,
  feedbackAssessments,
  feedbackDropExpired,
  feedbackDropOutcomes,
  feedbackDropSites,
  feedbackIntegrations,
  feedbackReports,
} from '../db/schema/index';
import { toAttachment } from '../files/service';
import { iso, isoOrNull } from '../lib/time';
import { linkOf } from '../managed/link/service';
import { COMMUNITY_FEEDBACK_TEXT } from '../managed/policy';
import { loadAgentRow } from '../read/principals';
import type { Services } from '../services';
import { destinationOf } from './chat';
import { DropKeys } from './drop/keys';
import type { IntegrationRow } from './integrations';
import { agentProblem, agentProblemText, personHere, repoEnabled } from './rules';

export type ReportRow = typeof feedbackReports.$inferSelect;

const EMPTY_CONTEXT: FeedbackContext = FeedbackContext.parse({});

/**
 * The stored context as a report answer carries it (feedback-reporters FR-04, contracts CT-161): the trail lifted out
 * of `context` into `submitted.trail`, since a client of contracts ≤ 0.24 parses `FeedbackContext` strictly and would
 * refuse the whole report with `context.trail` in it.
 */
export function splitTrail(stored: FeedbackContext | null): {
  context: FeedbackContext;
  trail: NonNullable<FeedbackContext['trail']>;
} {
  if (!stored) return { context: EMPTY_CONTEXT, trail: [] };
  const { trail, ...context } = stored;
  return { context, trail: trail ?? [] };
}

/** The report row, if it is in this burrow. */
export async function loadReportRow(db: Db, burrowId: string, reportId: string): Promise<ReportRow | null> {
  const [row] = await db.select().from(feedbackReports).where(eq(feedbackReports.id, reportId));
  return row && row.burrowId === burrowId ? row : null;
}

/** Builds the `FeedbackReport` contract object of a row (no authorization: the caller decides who may see it). */
export async function toFeedbackReport(db: Db, row: ReportRow): Promise<FeedbackReport> {
  const [integration] = await db
    .select({ settings: feedbackIntegrations.settings })
    .from(feedbackIntegrations)
    .where(eq(feedbackIntegrations.id, row.integrationId));
  const files = row.attachmentIds.length
    ? await db.select().from(attachments).where(inArray(attachments.id, row.attachmentIds))
    : [];
  const byId = new Map(files.filter((f) => f.state === 'ready').map((f) => [f.id, f]));
  const attempts = await db
    .select()
    .from(feedbackAssessments)
    .where(eq(feedbackAssessments.reportId, row.id))
    .orderBy(asc(feedbackAssessments.attempt));
  const latest = attempts[attempts.length - 1];
  let handoff: FeedbackReport['handoff'] = null;
  if (row.handoffApprovalId) {
    const [approval] = await db
      .select({ id: approvals.id, number: approvals.number, state: approvals.state })
      .from(approvals)
      .where(eq(approvals.id, row.handoffApprovalId));
    if (approval)
      handoff = { approvalId: approval.id, approvalNumber: approval.number, state: approval.state };
  }
  return {
    id: row.id,
    integrationId: row.integrationId,
    reference: row.reference,
    productLabel: integration?.settings.productLabel ?? '',
    type: row.type,
    status: row.status,
    receivedAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    submitted: {
      description: row.description,
      expected: row.expected,
      steps: row.steps,
      reporter: { name: row.reporterName, email: row.reporterEmail, verified: row.reporterVerified },
      ...splitTrail(row.context),
      attachments: row.attachmentIds.flatMap((id) => {
        const f = byId.get(id);
        return f ? [toAttachment(f)] : [];
      }),
    },
    contentRemovedAt: isoOrNull(row.contentRemovedAt),
    intake: row.intake,
    conversationId: row.conversationId,
    rootMessageId: row.rootMessageId,
    assessment: {
      state: row.assessmentState,
      reason: row.assessmentReason,
      attempts: row.assessmentAttempts,
      dispatchId: row.assessmentDispatchId,
      updatedAt: iso(row.assessmentUpdatedAt),
      result: row.assessment ?? null,
      workspace: latest?.workspace ?? null,
      conclusion: row.assessmentState === 'done' ? (row.conclusion ?? null) : null,
      decided: row.decided ?? null,
    },
    attempts: attempts.map((a) => ({
      id: a.id,
      attempt: a.attempt,
      state: a.state,
      agentId: a.agentId,
      dispatchId: a.dispatchId,
      error: a.error,
      requestedById: a.requestedById,
      startedAt: iso(a.startedAt),
      finishedAt: isoOrNull(a.finishedAt),
    })),
    handoff,
  };
}

/** What a viewer (already known to be of the report's burrow) may do with it. */
export async function reportPermissions(
  db: Db,
  row: ReportRow,
  viewer: { id: string; kind: 'person' | 'agent' },
) {
  const [integration] = await db
    .select({ settings: feedbackIntegrations.settings, assessment: feedbackIntegrations.assessment })
    .from(feedbackIntegrations)
    .where(eq(feedbackIntegrations.id, row.integrationId));
  const person = viewer.kind === 'person';
  const removed = row.contentRemovedAt !== null;
  // A declined handoff can be asked for again; a pending or approved one can't (FB-24).
  const [handoff] = row.handoffApprovalId
    ? await db
        .select({ state: approvals.state })
        .from(approvals)
        .where(eq(approvals.id, row.handoffApprovalId))
    : [];
  return {
    setStatus: person,
    // Same rules as `feedback.retry_assessment` (FB-23).
    retry:
      person &&
      !removed &&
      (row.assessmentState === 'failed' ||
        row.assessmentState === 'blocked' ||
        (row.assessmentState === 'paused' && integration?.assessment === 'active')) &&
      row.assessmentAttempts < FEEDBACK_MAX_ASSESSMENT_ATTEMPTS,
    handoff:
      person &&
      !removed &&
      row.assessmentState === 'done' &&
      (!handoff || handoff.state === 'declined') &&
      integration?.settings.handoff === 'on',
    redact: person && !removed,
    // The assessor's decision, not picked yet (FB-32); a `hand_off` option still meets the handoff's own rules then.
    decide: person && row.assessmentState === 'done' && !!row.conclusion?.decision && !row.decided,
  };
}

/**
 * The snippets the person pastes into the website (FB-02, FB-26; feedback-drop FD-26, FD-31, FD-37): the widget comes
 * from the embed origin (`WHOMBAT_EMBED_URL`, else the hosted app's origin) and the tag pins the site signing key with
 * `data-key`, made here if it doesn't exist yet.
 */
export async function snippetsFor(services: Services, row: IntegrationRow): Promise<FeedbackSnippets> {
  const base = {
    siteId: row.siteId,
    theme: row.settings.theme,
    position: row.settings.position,
    launcher: row.settings.launcher,
    launcherLabel: row.settings.launcherLabel,
  };
  const keys = services.feedback.drop?.keys ?? new DropKeys(services);
  // A read-only start can't make the key: the snippet then lacks `data-key` until a read-write one does.
  const signing = await keys.signingKey({ create: true }).catch((err) => {
    services.log.warn({ err: String(err).slice(0, 200) }, 'feedback drop: no site signing key yet');
    return null;
  });
  const input = {
    ...base,
    publicUrl: managedAppOrigin(services.config),
    embedUrl: managedEmbedOrigin(services.config),
    siteKey: signing?.fingerprint ?? null,
  };
  return { basic: basicSnippet(input), custom: customLauncherSnippet(input), csp: cspAdvice(input) };
}

type WarningCode = FeedbackHealthWarning['code'];

const WARNING_TEXT: Record<WarningCode, string> = {
  intake_disabled: 'Intake is off: the widget tells visitors feedback isn’t available.',
  assessment_paused: 'Automatic assessment is paused: new reports wait until you resume it.',
  // Contracts 0.125.0 still lists it; every agent runs guarded now, so it never shows (hermes-engine.md HE-48).
  agent_not_guarded: 'The agent must run guarded to assess reports.',
  agent_unsupported_provider: agentProblemText('agent_unsupported_provider'),
  owner_not_member: 'Reports go to a Feedback room that isn’t yours any more: save the settings again.',
  repo_disabled: 'The repository is switched off: the assessor can’t read the code.',
  public_url_missing: 'PUBLIC_URL isn’t set: the snippet points at a development address.',
  public_url_not_https: 'PUBLIC_URL isn’t https: browsers won’t load the widget on https websites.',
  widget_not_built:
    'The widget isn’t built on this server: build it (pnpm build:widget) or set WHOMBAT_WIDGET_DIST.',
  module_off:
    'Whombat Feedback is off on this server (WHOMBAT_FEEDBACK=off): the widget takes no reports. Stored reports are still removed on schedule.',
  drop_unsupported: FEEDBACK_DROP_TEXT.unsupported,
  drop_not_published: FEEDBACK_DROP_TEXT.notPublished,
  // Counted texts (`feedbackDropNotFiledText`, `feedbackDropExpiredText`) replace these.
  drop_not_filed: '',
  drop_expired: '',
};

const WEEK_MS = 7 * 86_400_000;

/** How reports reach a managed Whombat (FD-26): the site's card at control, collections, refusals, expiries. */
async function deliveryOf(services: Services, row: IntegrationRow): Promise<FeedbackDropDelivery> {
  const db = services.db;
  const now = services.clock();
  const since = new Date(now.getTime() - WEEK_MS);
  const [site] = await db
    .select({ publishedAt: feedbackDropSites.publishedAt })
    .from(feedbackDropSites)
    .where(eq(feedbackDropSites.siteId, row.siteId));
  const [collected] = await db
    .select({ at: max(feedbackDropOutcomes.at) })
    .from(feedbackDropOutcomes)
    .where(eq(feedbackDropOutcomes.siteId, row.siteId));
  const [refused] = await db
    .select({ n: count() })
    .from(feedbackDropOutcomes)
    .where(
      and(
        eq(feedbackDropOutcomes.siteId, row.siteId),
        eq(feedbackDropOutcomes.outcome, 'refused'),
        gt(feedbackDropOutcomes.at, since),
      ),
    );
  const [expired] = await db
    .select({ n: sum(feedbackDropExpired.count) })
    .from(feedbackDropExpired)
    .where(
      and(
        eq(feedbackDropExpired.siteId, row.siteId),
        gte(feedbackDropExpired.day, since.toISOString().slice(0, 10)),
      ),
    );
  return {
    mode: 'drop',
    publishedAt: isoOrNull(site?.publishedAt ?? null),
    lastCollectedAt: isoOrNull(collected?.at ?? null),
    notFiled7d: refused?.n ?? 0,
    expired7d: Number(expired?.n ?? 0),
  };
}

/** Live health of an integration: recent reports, assessment counts and what needs attention. */
export async function integrationHealth(
  services: Services,
  row: IntegrationRow,
): Promise<FeedbackIntegrationHealth> {
  const db = services.db;
  const config = services.config;
  const since = new Date(services.clock().getTime() - 24 * 3_600_000);
  const [recent] = await db
    .select({ n: count() })
    .from(feedbackReports)
    .where(and(eq(feedbackReports.integrationId, row.id), gt(feedbackReports.createdAt, since)));
  const [last] = await db
    .select({ at: max(feedbackReports.createdAt) })
    .from(feedbackReports)
    .where(eq(feedbackReports.integrationId, row.id));
  const states = await db
    .select({ state: feedbackReports.assessmentState, n: count() })
    .from(feedbackReports)
    .where(eq(feedbackReports.integrationId, row.id))
    .groupBy(feedbackReports.assessmentState);
  const n = (state: string) => states.find((s) => s.state === state)?.n ?? 0;

  const codes: WarningCode[] = [];
  if (config.WHOMBAT_FEEDBACK === 'off') codes.push('module_off');
  if (row.intake === 'disabled') codes.push('intake_disabled');
  if (row.assessment === 'paused') codes.push('assessment_paused');
  const s = row.settings;
  // The person's Feedback room (less-is-more.md LM-01): its person still in it, the agent fit to assess (OA-16).
  const room = await destinationOf(db, row.burrowId, row.channelId, row.id);
  if (!room || !(await personHere(db, row.burrowId, row.updatedById))) codes.push('owner_not_member');
  const agent = await loadAgentRow(db, row.burrowId);
  if (agent && room) {
    const problem = await agentProblem(db, row.burrowId, agent.id, { assessor: true });
    if (problem === 'agent_unsupported_provider') codes.push(problem);
  }
  if (s.repoId && !(await repoEnabled(db, row.burrowId, s.repoId))) codes.push('repo_disabled');
  const textOf = (code: WarningCode): string => WARNING_TEXT[code];

  const base = {
    reportsLast24h: recent?.n ?? 0,
    lastReportAt: last?.at ? iso(last.at) : null,
    assessments: { queued: n('queued'), running: n('running'), failed: n('failed'), blocked: n('blocked') },
  };

  // The widget is served from the embed origin, reports come through the drop (FD-26, FD-37).
  const delivery = await deliveryOf(services, row);
  const drop = services.feedback.drop;
  const warnings: FeedbackHealthWarning[] = codes.map((code) => ({ code, message: textOf(code) }));
  if (config.WHOMBAT_FEEDBACK === 'on') {
    // Without Whombat Link running the box has no drop (HE-S203, LNK-05): no cloud to wait for (HE-S224).
    const link = linkOf(services);
    if (link && !link.active()) warnings.push({ code: 'drop_unsupported', message: COMMUNITY_FEEDBACK_TEXT });
    else if (drop?.support === 'unsupported')
      warnings.push({ code: 'drop_unsupported', message: WARNING_TEXT.drop_unsupported });
    else if (row.intake === 'enabled' && !delivery.publishedAt)
      warnings.push({ code: 'drop_not_published', message: WARNING_TEXT.drop_not_published });
  }
  if (delivery.notFiled7d > 0)
    warnings.push({ code: 'drop_not_filed', message: feedbackDropNotFiledText(delivery.notFiled7d) });
  if (delivery.expired7d > 0)
    warnings.push({ code: 'drop_expired', message: feedbackDropExpiredText(delivery.expired7d) });
  // FD-57: with the module off there is no drop to install against; the app keeps its notice (delivery null).
  if (config.WHOMBAT_FEEDBACK === 'off')
    return { publicUrl: managedEmbedOrigin(config), ...base, warnings, delivery: null };
  return { publicUrl: managedEmbedOrigin(config), ...base, warnings, delivery };
}
