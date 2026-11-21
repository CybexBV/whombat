/**
 * Feedback integration configuration through the commit pipeline (docs/decisions/feedback.md FB-18, FB-19): only
 * the person creates and changes integrations, only with a channel they are in, an agent that is already in that
 * channel (never added for them), a switched-on repo. Every change bumps the revision and is a signed `Keys` event
 * with the revision and the config hash (sha256 of the canonical settings); the settings themselves stay private.
 *
 * In the assistant shell (less-is-more.md LM-01, LM-F01…) the reports go to the person's Feedback room with the
 * agent instead (`chat.ts`): a channel sent with the settings is ignored, and the assessor and the developer
 * can only be that assistant, which is always in its chat.
 *
 * Assessment pause / resume (FB-19), as implemented: pausing moves this integration's `queued` reports to `paused`
 * in the same transaction (running assessments finish; new reports arrive `paused`); resuming moves its `paused`
 * reports back to `queued` and nudges the assessment worker.
 */
import {
  canonicalJson,
  type FeedbackIntegration,
  type FeedbackIntegrationChat,
  FeedbackIntegrationId,
  FeedbackIntegrationSettings,
  newFeedbackSiteId,
  newId,
  sha256Hex,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { feedbackIntegrations, feedbackReports } from '../db/schema/index';
import { ApiError, conflict, forbidden, notFound } from '../lib/errors';
import { iso } from '../lib/time';
import type { ConversationRow } from '../read/conversations';
import { loadPrincipalRow, type PrincipalRow } from '../read/principals';
import {
  destinationLabel,
  destinationOf,
  ensureFeedbackRoom,
  integrationChatOf,
  introduceChat,
  retitleFeedbackChat,
} from './chat';
import { reportChanged } from './reporters';
import { agentProblem, agentProblemText, repoEnabled } from './rules';
import { reporterSignInOn, trailOn } from './switches';

export type IntegrationRow = typeof feedbackIntegrations.$inferSelect;

/** The contract shape of an integration row; `chat` as `integrationChatOf` found it (`integrationView` reads it). */
export function toIntegration(
  row: IntegrationRow,
  chat: FeedbackIntegrationChat | null = null,
): FeedbackIntegration {
  return {
    ...row.settings,
    // Settings saved before contracts 0.25 have neither switch: both read as on (FR-03).
    trail: trailOn(row.settings) ? 'on' : 'off',
    reporterSignIn: reporterSignInOn(row.settings) ? 'on' : 'off',
    id: row.id,
    siteId: row.siteId,
    intake: row.intake,
    assessment: row.assessment,
    revision: row.revision,
    configHash: row.configHash,
    createdById: row.createdById,
    createdAt: iso(row.createdAt),
    updatedById: row.updatedById,
    updatedAt: iso(row.updatedAt),
    // The conversation reports go to (contracts 0.87, CT-383): the person's Feedback room.
    conversationId: row.channelId,
    chat: chat ?? { id: row.channelId },
  };
}

/** `toIntegration` with the integration's chat read (LM-01). */
export async function integrationView(db: Db | Tx, row: IntegrationRow): Promise<FeedbackIntegration> {
  return toIntegration(row, await integrationChatOf(db, row));
}

/** sha256 of the canonical JSON of validated settings. */
export function configHashOf(settings: FeedbackIntegrationSettings): string {
  return sha256Hex(canonicalJson(JSON.parse(JSON.stringify(settings))));
}

function fieldError(field: string, message: string): ApiError {
  return new ApiError('validation_failed', message, { fields: { [field]: [message] } });
}

function requireOwner(ctx: ApplyContext): void {
  if (ctx.actor.kind !== 'person') throw forbidden('Only you can set up feedback integrations.');
}

/** Where valid settings send reports: the actor's Feedback room with the agent. */
export interface Destination {
  conversation: ConversationRow;
  /** The room's agent. */
  assistant: PrincipalRow;
  /** The room was made by this save. */
  created: boolean;
}

/**
 * FB-18 checks of a whole settings object for this actor; throws naming the first field that fails. The destination is
 * the actor's Feedback room with the agent, made when missing (LM-01, chat-channel.md CHT-03). The agent assesses and,
 * with `handoff` on, builds the fix (one-agent.md OA-16).
 */
async function validateSettings(
  tx: Tx,
  ctx: ApplyContext,
  s: FeedbackIntegrationSettings,
  _integrationId: string,
): Promise<Destination> {
  const burrowId = ctx.burrow.id;
  const person = await loadPrincipalRow(tx, ctx.actor.id);
  if (!person) throw notFound('Person');
  const room = await ensureFeedbackRoom(ctx, person);
  const destination: Destination = {
    conversation: room.conversation,
    assistant: room.agent,
    created: room.created,
  };
  const agent = room.agent;
  if (s.repoId && !(await repoEnabled(tx, burrowId, s.repoId)))
    throw fieldError('repoId', 'Pick a repository that is switched on for this Whombat.');
  if (s.handoff === 'on') {
    const problem = await agentProblem(tx, burrowId, agent.id, { assessor: false });
    if (problem) throw fieldError('handoff', agentProblemText(problem, agent.name));
  }
  return destination;
}

/** The integration of this burrow, locked for the change. */
export async function lockIntegration(tx: Tx, burrowId: string, id: string): Promise<IntegrationRow> {
  const [row] = await tx
    .select()
    .from(feedbackIntegrations)
    .where(eq(feedbackIntegrations.id, id))
    .for('update');
  if (!row || row.burrowId !== burrowId) throw notFound('Feedback integration');
  return row;
}

export async function emitChange(
  ctx: ApplyContext,
  row: IntegrationRow,
  type: string,
  text: string,
  extra: Record<string, string | number | boolean | null> = {},
) {
  const destination = await destinationOf(ctx.tx, ctx.burrow.id, row.channelId, row.id);
  await ctx.emit({
    type,
    kind: 'Keys',
    text,
    where: destination ? destinationLabel(destination) : 'Feedback',
    payload: {
      integrationId: row.id,
      siteId: row.siteId,
      revision: row.revision,
      configHash: row.configHash,
      conversationId: row.channelId,
      repoId: row.settings.repoId,
      handoff: row.settings.handoff,
      intake: row.intake,
      assessment: row.assessment,
      ...extra,
    },
  });
  const feedback = ctx.services.feedback;
  // Created, changed or intake switched: a managed Whombat's card changes with it (FD-11); assessment doesn't.
  const cardChanged = type !== 'feedback.assessment_changed';
  ctx.after(async () => {
    if (cardChanged) feedback.configChanged();
  });
}

export const createFeedbackIntegration = defineCommand({
  name: 'feedback.create_integration',
  schema: FeedbackIntegrationSettings,
  async apply(tx, ctx, input) {
    requireOwner(ctx);
    const id = newId('feedbackIntegration');
    const checked = input;
    const destination = await validateSettings(tx, ctx, checked, id);
    // The settings name their conversation, the chat included (CT-383): the config hash covers where reports go.
    const settings = { ...checked, channelId: destination.conversation.id };
    let siteId = newFeedbackSiteId();
    for (let i = 0; i < 5; i++) {
      const [taken] = await tx
        .select({ id: feedbackIntegrations.id })
        .from(feedbackIntegrations)
        .where(eq(feedbackIntegrations.siteId, siteId));
      if (!taken) break;
      siteId = newFeedbackSiteId();
    }
    const [row] = await tx
      .insert(feedbackIntegrations)
      .values({
        id,
        burrowId: ctx.burrow.id,
        siteId,
        intake: 'enabled',
        assessment: 'active',
        channelId: destination.conversation.id,
        settings,
        revision: 1,
        configHash: configHashOf(settings),
        createdById: ctx.actor.id,
        createdAt: ctx.now,
        updatedById: ctx.actor.id,
        updatedAt: ctx.now,
      })
      .returning();
    if (!row) throw conflict('Could not create the integration.');
    await emitChange(
      ctx,
      row,
      'feedback.integration_created',
      `Set up feedback from ${settings.productLabel} (“${settings.name}”): reports go to Feedback, with ${destination.assistant.name}.`,
    );
    // The agent says in the room where these reports come from (LM-F05, CHT-03): every new integration posts there.
    await introduceChat(ctx, destination.conversation, destination.assistant, row, { notify: false });
    return integrationView(tx, row);
  },
});

export const updateFeedbackIntegration = defineCommand({
  name: 'feedback.update_integration',
  schema: z.object({
    integrationId: FeedbackIntegrationId,
    revision: z.number().int().positive(),
    settings: FeedbackIntegrationSettings,
  }),
  async apply(tx, ctx, input) {
    requireOwner(ctx);
    const current = await lockIntegration(tx, ctx.burrow.id, input.integrationId);
    if (current.revision !== input.revision)
      throw conflict('Someone changed this integration since you opened it. Reload it and try again.');
    const checked = input.settings;
    const destination = await validateSettings(tx, ctx, checked, current.id);
    const settings = { ...checked, channelId: destination.conversation.id };
    // A chat still titled after the integration follows its new name (LM-F11); a person's own title stays.
    if (!destination.created)
      await retitleFeedbackChat(ctx, destination.conversation, current.settings, settings);
    const [row] = await tx
      .update(feedbackIntegrations)
      .set({
        settings,
        channelId: destination.conversation.id,
        revision: current.revision + 1,
        configHash: configHashOf(settings),
        updatedById: ctx.actor.id,
        updatedAt: ctx.now,
      })
      .where(eq(feedbackIntegrations.id, current.id))
      .returning();
    if (!row) throw notFound('Feedback integration');
    await emitChange(
      ctx,
      row,
      'feedback.integration_updated',
      `Changed the feedback settings for ${row.settings.productLabel} (“${row.settings.name}”, revision ${row.revision}).`,
      {
        previousConfigHash: current.configHash,
        // Where reports went before, when this save moved them (LM-F03).
        ...(current.channelId !== row.channelId ? { movedFrom: current.channelId } : {}),
      },
    );
    // Moved to the person's room by this save (LM-F03): the agent says so there (LM-F05).
    if (current.channelId !== row.channelId)
      await introduceChat(ctx, destination.conversation, destination.assistant, row, { notify: false });
    return integrationView(tx, row);
  },
});

export const setFeedbackIntake = defineCommand({
  name: 'feedback.set_intake',
  schema: z.object({ integrationId: FeedbackIntegrationId, enabled: z.boolean() }),
  async apply(tx, ctx, input) {
    requireOwner(ctx);
    const current = await lockIntegration(tx, ctx.burrow.id, input.integrationId);
    const intake = input.enabled ? 'enabled' : 'disabled';
    if (current.intake === intake) return integrationView(tx, current);
    const [row] = await tx
      .update(feedbackIntegrations)
      // Only the revision: `updatedById` stays whoever saved the settings, the configuration's authority (FB-F06).
      .set({ intake, revision: current.revision + 1 })
      .where(eq(feedbackIntegrations.id, current.id))
      .returning();
    if (!row) throw notFound('Feedback integration');
    await emitChange(
      ctx,
      row,
      'feedback.intake_changed',
      input.enabled
        ? `Turned on feedback from ${row.settings.productLabel} (“${row.settings.name}”).`
        : `Turned off feedback from ${row.settings.productLabel} (“${row.settings.name}”): the widget no longer takes reports.`,
    );
    return integrationView(tx, row);
  },
});

export const setFeedbackAssessment = defineCommand({
  name: 'feedback.set_assessment',
  schema: z.object({ integrationId: FeedbackIntegrationId, active: z.boolean() }),
  async apply(tx, ctx, input) {
    requireOwner(ctx);
    const current = await lockIntegration(tx, ctx.burrow.id, input.integrationId);
    const mode = input.active ? 'active' : 'paused';
    if (current.assessment === mode) return integrationView(tx, current);
    const [row] = await tx
      .update(feedbackIntegrations)
      // Only the revision: `updatedById` stays whoever saved the settings, the configuration's authority (FB-F06).
      .set({ assessment: mode, revision: current.revision + 1 })
      .where(eq(feedbackIntegrations.id, current.id))
      .returning();
    if (!row) throw notFound('Feedback integration');
    const moved = await tx
      .update(feedbackReports)
      .set(
        input.active
          ? { assessmentState: 'queued', assessmentReason: null, assessmentUpdatedAt: ctx.now }
          : {
              assessmentState: 'paused',
              assessmentReason: 'Assessment is paused for this integration.',
              assessmentUpdatedAt: ctx.now,
            },
      )
      .where(
        and(
          eq(feedbackReports.integrationId, row.id),
          eq(feedbackReports.assessmentState, input.active ? 'paused' : 'queued'),
        ),
      )
      .returning({ id: feedbackReports.id, rootMessageId: feedbackReports.rootMessageId });
    await emitChange(
      ctx,
      row,
      'feedback.assessment_changed',
      input.active
        ? `Resumed automatic assessment of reports from ${row.settings.productLabel} (“${row.settings.name}”).`
        : `Paused automatic assessment of reports from ${row.settings.productLabel} (“${row.settings.name}”).`,
      { reportsMoved: moved.length },
    );
    await reportChanged(
      ctx,
      moved.map((m) => m.rootMessageId),
    );
    if (input.active && moved.length) {
      const feedback = ctx.services.feedback;
      ctx.after(async () => feedback.nudge());
    }
    return integrationView(tx, row);
  },
});

export const INTEGRATION_COMMANDS = [
  createFeedbackIntegration,
  updateFeedbackIntegration,
  setFeedbackIntake,
  setFeedbackAssessment,
];
