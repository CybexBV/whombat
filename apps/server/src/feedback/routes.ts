/**
 * REST adapters for `api.feedback.*` (docs/decisions/feedback.md FB-17, FB-18): integrations are the person's (an agent
 * sees none, and 404 for one), reports are the burrow's, every one in a room of the person's (404 for another
 * burrow's, so a report's existence isn't revealed). Writes are thin adapters over the feedback commands.
 */
import { api } from '@whombat/core';
import { asc, eq } from 'drizzle-orm';
import type { BurrowAccess } from '../auth/request';
import { feedbackIntegrations } from '../db/schema/index';
import { notFound } from '../lib/errors';
import { commitAs } from '../routes/burrows';
import { route } from '../routes/define';
import type { Services } from '../services';
import { retryAssessment } from './assessment';
import { requestHandoff } from './handoff';
import {
  createFeedbackIntegration,
  type IntegrationRow,
  integrationView,
  setFeedbackAssessment,
  setFeedbackIntake,
  updateFeedbackIntegration,
} from './integrations';
import { integrationHealth, loadReportRow, reportPermissions, snippetsFor, toFeedbackReport } from './read';
import { decideFeedbackReport, redactFeedbackReport, setFeedbackReportStatus } from './reports';

function isPerson(access: BurrowAccess): boolean {
  return access.principal.kind === 'person';
}

async function ownedIntegration(
  services: Services,
  access: BurrowAccess,
  id: string,
): Promise<IntegrationRow> {
  if (!isPerson(access)) throw notFound('Feedback integration');
  const [row] = await services.db.select().from(feedbackIntegrations).where(eq(feedbackIntegrations.id, id));
  if (!row || row.burrowId !== access.burrow.id) throw notFound('Feedback integration');
  return row;
}

async function detail(services: Services, row: IntegrationRow) {
  return {
    integration: await integrationView(services.db, row),
    snippets: await snippetsFor(services, row),
    health: await integrationHealth(services, row),
    can: { manage: true },
  };
}

async function reportView(services: Services, access: BurrowAccess, reportId: string) {
  const row = await loadReportRow(services.db, access.burrow.id, reportId);
  if (!row) throw notFound('Report');
  const report = await toFeedbackReport(services.db, row);
  // The project context is the person's own guidance for the assessor, like the integration's settings (FB-17):
  // an agent gets the snapshot without it (FB-F08).
  if (!isPerson(access)) report.intake = { ...report.intake, projectContext: '' };
  return { row, report };
}

export const feedbackRoutes = [
  route(api.feedback.listIntegrations, async ({ access, services }) => {
    if (!isPerson(access)) return { integrations: [], can: { manage: false } };
    const rows = await services.db
      .select()
      .from(feedbackIntegrations)
      .where(eq(feedbackIntegrations.burrowId, access.burrow.id))
      .orderBy(asc(feedbackIntegrations.createdAt));
    return {
      integrations: await Promise.all(
        rows.map(async (row) => ({
          integration: await integrationView(services.db, row),
          health: await integrationHealth(services, row),
        })),
      ),
      can: { manage: true },
    };
  }),

  route(api.feedback.getIntegration, async ({ access, services, params }) =>
    detail(services, await ownedIntegration(services, access, params.id)),
  ),

  route(api.feedback.createIntegration, async (ctx) => ({
    status: 'ok' as const,
    integration: await commitAs(ctx, createFeedbackIntegration, ctx.body),
  })),

  route(api.feedback.updateIntegration, async (ctx) => {
    await ownedIntegration(ctx.services, ctx.access, ctx.params.id);
    return {
      status: 'ok' as const,
      integration: await commitAs(ctx, updateFeedbackIntegration, {
        integrationId: ctx.params.id,
        revision: ctx.body.revision,
        settings: ctx.body.settings,
      }),
    };
  }),

  route(api.feedback.setIntake, async (ctx) => {
    await ownedIntegration(ctx.services, ctx.access, ctx.params.id);
    return {
      status: 'ok' as const,
      integration: await commitAs(ctx, setFeedbackIntake, {
        integrationId: ctx.params.id,
        enabled: ctx.body.enabled,
      }),
    };
  }),

  route(api.feedback.setAssessment, async (ctx) => {
    await ownedIntegration(ctx.services, ctx.access, ctx.params.id);
    return {
      status: 'ok' as const,
      integration: await commitAs(ctx, setFeedbackAssessment, {
        integrationId: ctx.params.id,
        active: ctx.body.active,
      }),
    };
  }),

  route(api.feedback.getReport, async ({ access, services, params }) => {
    const { row, report } = await reportView(services, access, params.id);
    return {
      report,
      can: await reportPermissions(services.db, row, {
        id: access.principal.id,
        kind: access.principal.kind === 'person' ? 'person' : 'agent',
      }),
    };
  }),

  route(api.feedback.setReportStatus, async (ctx) => {
    await commitAs(ctx, setFeedbackReportStatus, { reportId: ctx.params.id, status: ctx.body.status });
    const { report } = await reportView(ctx.services, ctx.access, ctx.params.id);
    return { status: 'ok' as const, report };
  }),

  route(api.feedback.redactReport, async (ctx) => {
    await commitAs(ctx, redactFeedbackReport, { reportId: ctx.params.id });
    const { report } = await reportView(ctx.services, ctx.access, ctx.params.id);
    return { status: 'ok' as const, report };
  }),

  // Retry (FB-23): the person; the worker revalidates at start.
  route(api.feedback.retryAssessment, async (ctx) => {
    await commitAs(ctx, retryAssessment, { reportId: ctx.params.id });
    const { report } = await reportView(ctx.services, ctx.access, ctx.params.id);
    return { status: 'ok' as const, report };
  }),

  // The assessor's decision (FB-32): a person picks an option; its action runs as them.
  route(api.feedback.decide, async (ctx) => {
    await commitAs(ctx, decideFeedbackReport, { reportId: ctx.params.id, option: ctx.body.option });
    const { report } = await reportView(ctx.services, ctx.access, ctx.params.id);
    return { status: 'ok' as const, report };
  }),

  // Development handoff (FB-24): an ordinary Approval the person decides.
  route(api.feedback.requestHandoff, async (ctx) => {
    await commitAs(ctx, requestHandoff, { reportId: ctx.params.id, note: ctx.body.note });
    const { report } = await reportView(ctx.services, ctx.access, ctx.params.id);
    return { status: 'ok' as const, report };
  }),
];
