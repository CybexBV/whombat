/**
 * `api.feedback.*` for `createFixtureFetch()` (docs/decisions/feedback.md): the fixture integration and reports
 * of `feedback.ts`, with the writes a server would commit (create, update with the revision check, intake,
 * assessment, report status, retry, handoff request, decision, content removal) applied to an in-memory copy. Answers
 * follow the contracts: writes answer the commit outcome (`{status: 'ok', …}`), `validation_failed` with field
 * paths, 404 for unknown ids, 409 for a stale revision.
 */

import type { FeedbackIntegrationHealth } from '@whombat/core/contracts';
import {
  FEEDBACK_DECISION_STATUS,
  type FeedbackIntegration,
  FeedbackIntegrationSettings,
  type FeedbackIntegrationSettings as FeedbackIntegrationSettingsType,
  type FeedbackReport,
  FeedbackReportStatus,
} from '@whombat/core/domain';
import { newFeedbackSiteId } from '@whombat/core/feedback';
import { newId } from '@whombat/core/ids';
import { cnv_feedback_mara } from './conversations.js';
import {
  FEEDBACK_REPORTS,
  feedbackHealth,
  feedbackIntegration,
  feedbackIntegrationDetail,
} from './feedback.js';
import { mara } from './principals.js';
import { SEED_NOW } from './time.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function error(code: string, message: string, status: number, fields?: Record<string, string[]>): Response {
  return json({ error: { code, message, ...(fields ? { fields } : {}) } }, status);
}

function fieldsOf(issues: readonly { path: readonly PropertyKey[]; message: string }[], prefix = '') {
  const fields: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = prefix + issue.path.map(String).join('.');
    fields[key] = [...(fields[key] ?? []), issue.message];
  }
  return fields;
}

const now = () => SEED_NOW.toISOString();

export function createFeedbackWorld() {
  const integrations = new Map<string, FeedbackIntegration>([[feedbackIntegration.id, feedbackIntegration]]);
  const reports = new Map<string, FeedbackReport>(FEEDBACK_REPORTS.map((r) => [r.id, r]));
  return { integrations, reports };
}

export type FeedbackWorld = ReturnType<typeof createFeedbackWorld>;

function healthOf(integration: FeedbackIntegration): FeedbackIntegrationHealth {
  const known = integration.id === feedbackIntegration.id;
  const warnings: FeedbackIntegrationHealth['warnings'] = [];
  if (integration.intake === 'disabled')
    warnings.push({
      code: 'intake_disabled',
      message: 'Intake is off: the widget tells visitors feedback isn’t available.',
    });
  if (integration.assessment === 'paused')
    warnings.push({
      code: 'assessment_paused',
      message: 'Automatic assessment is paused: new reports wait until you resume it.',
    });
  return known
    ? { ...feedbackHealth, warnings }
    : {
        ...feedbackHealth,
        reportsLast24h: 0,
        lastReportAt: null,
        assessments: { queued: 0, running: 0, failed: 0, blocked: 0 },
        warnings,
      };
}

/** Whether the report's integration offers to build the fix (`handoff: 'on'`, FB-24, OA-16). */
function handoffOn(world: FeedbackWorld, report: FeedbackReport): boolean {
  return world.integrations.get(report.integrationId)?.handoff === 'on';
}

function reportAnswer(world: FeedbackWorld, report: FeedbackReport) {
  return {
    report,
    can: {
      setStatus: true,
      retry: report.assessment.state === 'failed' || report.assessment.state === 'blocked',
      handoff: handoffOn(world, report) && report.assessment.state === 'done' && report.handoff === null,
      redact: true,
      decide: !!report.assessment.conclusion?.decision && !report.assessment.decided,
    },
  };
}

/** Answers a `feedback.*` endpoint, or null when `id` is not one. */
export async function handleFeedback(
  world: FeedbackWorld,
  id: string,
  params: Record<string, string>,
  req: Request,
): Promise<Response | null> {
  const integration = params.id ? world.integrations.get(params.id) : undefined;
  const report = params.id ? world.reports.get(params.id) : undefined;
  const body = async () =>
    req.method === 'GET' ? undefined : ((await req.json()) as Record<string, unknown>);

  const saveIntegration = (next: FeedbackIntegration) => {
    world.integrations.set(next.id, next);
    return json({ status: 'ok', integration: next });
  };
  const saveReport = (next: FeedbackReport) => {
    world.reports.set(next.id, next);
    return json({ status: 'ok', report: next });
  };
  const bump = (i: FeedbackIntegration, patch: Partial<FeedbackIntegration>): FeedbackIntegration => ({
    ...i,
    ...patch,
    revision: i.revision + 1,
    updatedById: mara.id,
    updatedAt: now(),
  });

  switch (id) {
    case 'feedback.listIntegrations':
      return json({
        integrations: [...world.integrations.values()].map((i) => ({ integration: i, health: healthOf(i) })),
        can: { manage: true },
      });
    case 'feedback.getIntegration':
      if (!integration) return error('not_found', 'No such integration.', 404);
      return json(feedbackIntegrationDetail(integration, healthOf(integration)));
    case 'feedback.createIntegration': {
      const parsed = FeedbackIntegrationSettings.safeParse(await body());
      if (!parsed.success)
        return error(
          'validation_failed',
          'Check the highlighted fields.',
          400,
          fieldsOf(parsed.error.issues),
        );
      // Reports land in the Feedback room of the person who set it up: Mara's (CT-383, CHT-03).
      const created: FeedbackIntegration = {
        ...parsed.data,
        conversationId: cnv_feedback_mara.id,
        id: newId('feedbackIntegration'),
        siteId: newFeedbackSiteId(),
        intake: 'enabled',
        assessment: 'active',
        revision: 1,
        configHash: '0'.repeat(64),
        createdById: mara.id,
        createdAt: now(),
        updatedById: mara.id,
        updatedAt: now(),
        chat: { id: cnv_feedback_mara.id },
      };
      world.integrations.set(created.id, created);
      return json({ status: 'ok', integration: created }, 201);
    }
    case 'feedback.updateIntegration': {
      if (!integration) return error('not_found', 'No such integration.', 404);
      const input = (await body()) as { revision?: number; settings?: unknown };
      const parsed = FeedbackIntegrationSettings.safeParse(input.settings);
      if (!parsed.success)
        return error(
          'validation_failed',
          'Check the highlighted fields.',
          400,
          fieldsOf(parsed.error.issues, 'settings.'),
        );
      if (input.revision !== integration.revision)
        return error('conflict', 'Someone changed this integration since you opened it.', 409);
      const settings: FeedbackIntegrationSettingsType = parsed.data;
      return saveIntegration(bump(integration, settings));
    }
    case 'feedback.setIntake': {
      if (!integration) return error('not_found', 'No such integration.', 404);
      const { enabled } = (await body()) as { enabled: boolean };
      return saveIntegration(bump(integration, { intake: enabled ? 'enabled' : 'disabled' }));
    }
    case 'feedback.setAssessment': {
      if (!integration) return error('not_found', 'No such integration.', 404);
      const { active } = (await body()) as { active: boolean };
      return saveIntegration(bump(integration, { assessment: active ? 'active' : 'paused' }));
    }
    case 'feedback.getReport':
      if (!report) return error('not_found', 'No such report.', 404);
      return json(reportAnswer(world, report));
    case 'feedback.setReportStatus': {
      if (!report) return error('not_found', 'No such report.', 404);
      const status = FeedbackReportStatus.safeParse(((await body()) as { status?: unknown }).status);
      if (!status.success)
        return error('validation_failed', 'Choose a status.', 400, { status: ['Choose a status.'] });
      return saveReport({ ...report, status: status.data, updatedAt: now() });
    }
    case 'feedback.retryAssessment': {
      if (!report) return error('not_found', 'No such report.', 404);
      if (report.assessment.state !== 'failed' && report.assessment.state !== 'blocked')
        return error('conflict', 'Only a failed or blocked assessment can be retried.', 409);
      return saveReport({
        ...report,
        updatedAt: now(),
        assessment: { ...report.assessment, state: 'queued', reason: null, updatedAt: now() },
      });
    }
    case 'feedback.requestHandoff': {
      if (!report) return error('not_found', 'No such report.', 404);
      if (!handoffOn(world, report))
        return error('conflict', 'Building fixes is switched off for this site.', 409);
      if (report.assessment.state !== 'done')
        return error('conflict', 'Only an assessed report can be fixed.', 409);
      return saveReport({
        ...report,
        updatedAt: now(),
        handoff: { approvalId: 'apr_fb-handoff', approvalNumber: 13, state: 'pending' },
      });
    }
    case 'feedback.decide': {
      if (!report) return error('not_found', 'No such report.', 404);
      const { option } = (await body()) as { option?: number };
      const decision = report.assessment.conclusion?.decision;
      if (!decision) return error('conflict', 'This assessment asks nothing to decide.', 409);
      if (report.assessment.decided) return error('conflict', 'This was already decided.', 409);
      const picked = typeof option === 'number' ? decision.options[option] : undefined;
      if (!picked || option === undefined)
        return error('validation_failed', 'Choose an option.', 400, { option: ['Choose an option.'] });
      const decided = {
        option,
        label: picked.label,
        action: picked.action,
        decidedById: mara.id,
        decidedAt: now(),
      };
      return saveReport({
        ...report,
        updatedAt: now(),
        ...(picked.action === 'hand_off'
          ? { handoff: { approvalId: 'apr_fb-handoff', approvalNumber: 13, state: 'pending' } }
          : { status: FEEDBACK_DECISION_STATUS[picked.action] }),
        assessment: { ...report.assessment, decided },
      });
    }
    case 'feedback.redactReport': {
      if (!report) return error('not_found', 'No such report.', 404);
      return saveReport({
        ...report,
        updatedAt: now(),
        contentRemovedAt: now(),
        submitted: {
          description: '',
          expected: '',
          steps: '',
          reporter: { name: null, email: null, verified: false },
          context: { page: null, browser: null, app: null, custom: {}, references: [], sentAt: null },
          trail: [],
          attachments: [],
        },
      });
    }
    default:
      return null;
  }
}

/** Endpoint ids `handleFeedback` serves. */
export const FEEDBACK_ENDPOINT_IDS = [
  'feedback.listIntegrations',
  'feedback.getIntegration',
  'feedback.createIntegration',
  'feedback.updateIntegration',
  'feedback.setIntake',
  'feedback.setAssessment',
  'feedback.getReport',
  'feedback.setReportStatus',
  'feedback.retryAssessment',
  'feedback.requestHandoff',
  'feedback.decide',
  'feedback.redactReport',
] as const;
