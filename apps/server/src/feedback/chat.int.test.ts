/**
 * Website feedback in the person's Feedback room with the agent (docs/decisions/less-is-more.md LM-01, LM-F01…;
 * chat-channel.md CHT-03; contracts CT-383; one-agent.md OA-16): every integration posts in the person's one
 * Feedback room (“Feedback”, never retitled), each with the agent's line saying where reports come from; reports
 * bump the room and mark it unread; the assessment starts in the report's thread in plain words; a second integration
 * posts in the same room.
 */
import type { FeedbackIntegration } from '@whombat/core';
import { and, asc, desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { archiveChat, renameChat } from '../chats/commands';
import { listChats } from '../chats/read';
import { FEEDBACK_ROOM_KEY } from '../chats/rooms';
import {
  conversations,
  dispatches,
  events,
  feedbackIntegrations,
  feedbackReports,
  messages,
  principals,
} from '../db/schema/index';
import { unreadCounts } from '../read/conversations';
import { IDS, integrationSettings, submitReport } from '../test/feedback';
import { useTestServer } from '../test/harness';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { createFeedbackIntegration, updateFeedbackIntegration } from './integrations';
import { integrationHealth } from './read';

const t = useTestServer({ seed: true, listen: true });
let dusty: PersonalSetup;

beforeAll(async () => {
  dusty = await addPersonalAgent(t.services, t.burrowId, IDS.mara, { services: null });
});

/** The settings the form sends: no room, the agent assesses (OA-16). */
function chatSettings(over: Parameters<typeof integrationSettings>[0] = {}) {
  return integrationSettings({
    // Each report's assessment starts at once (the worker may already run an earlier one).
    limits: {
      reportsPerHour: 1000,
      reportsPerDay: 10_000,
      perSourcePerHour: 100,
      maxConcurrentAssessments: 5,
    },
    ...over,
  });
}

async function create(by: string, input: unknown): Promise<FeedbackIntegration> {
  const res = await t.commit(by, createFeedbackIntegration, input as never);
  if (res.status !== 'ok') throw new Error(res.status);
  return res.result;
}

async function conversation(id: string) {
  const [row] = await t.services.db.select().from(conversations).where(eq(conversations.id, id));
  if (!row) throw new Error(`no conversation ${id}`);
  return row;
}

async function messagesIn(conversationId: string) {
  return t.services.db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId)))
    .orderBy(asc(messages.ord));
}

async function person(id: string) {
  const [row] = await t.services.db.select().from(principals).where(eq(principals.id, id));
  if (!row) throw new Error(`no ${id}`);
  return row;
}

async function lastEvent(type: string) {
  const [e] = await t.services.db
    .select()
    .from(events)
    .where(eq(events.type, type))
    .orderBy(desc(events.seq))
    .limit(1);
  return e;
}

describe('website feedback in the Feedback room (less-is-more.md LM-01, one-agent.md OA-16)', () => {
  let integration: FeedbackIntegration;

  it('makes the person’s Feedback room with the agent', async () => {
    integration = await create(IDS.mara, chatSettings());
    const roomId = integration.conversationId;
    expect(integration.chat).toEqual({ id: roomId });
    const row = await conversation(roomId);
    expect(row).toMatchObject({
      kind: 'dm',
      dmAgentId: dusty.agentId,
      dmPersonId: IDS.mara,
      taskKey: FEEDBACK_ROOM_KEY,
      chatTitle: 'Feedback',
    });
    // Named for good: nobody retitles it.
    expect(row.chatRetitledAt).not.toBeNull();
    // The agent says where the reports come from, naming the integration, at the top of the room.
    const [intro, ...more] = await messagesIn(roomId);
    expect(more).toEqual([]);
    expect(intro).toMatchObject({ authorId: dusty.agentId, mentions: [], threadRootId: null });
    expect(intro?.text).toContain('“Lumio website”');
    // In Mara's rooms as Feedback.
    const chats = await listChats(t.services.db, await person(IDS.mara), { rooms: true });
    expect(chats.find((c) => c.id === roomId)).toMatchObject({
      title: 'Feedback',
      room: 'feedback',
      default: false,
    });
    const created = await lastEvent('feedback.integration_created');
    expect(created?.text).toContain('Feedback');
    expect(created?.where).toBe('Feedback');
    // Nothing for her to fix: the agent is in its room.
    const [stored] = await t.services.db
      .select()
      .from(feedbackIntegrations)
      .where(eq(feedbackIntegrations.id, integration.id));
    if (!stored) throw new Error('no integration');
    const health = await integrationHealth(t.services, stored);
    expect(health.warnings.map((w) => w.code)).not.toEqual(
      expect.arrayContaining(['channel_missing', 'owner_not_member', 'agent_missing']),
    );
  });

  it('keeps the same room when she saves again', async () => {
    const res = await t.commit(IDS.mara, updateFeedbackIntegration, {
      integrationId: integration.id,
      revision: integration.revision,
      settings: chatSettings({ projectContext: 'Lumio bills small businesses.' }),
    });
    if (res.status !== 'ok') throw new Error(res.status);
    expect(res.result.conversationId).toBe(integration.conversationId);
    expect(res.result.chat?.id).toBe(integration.conversationId);
    expect(await messagesIn(integration.conversationId)).toHaveLength(1);
    integration = res.result;
  });

  it('posts each report as a thread in the room, bumps it and marks it unread; the room isn’t renamed or archived', async () => {
    const roomId = integration.conversationId;
    await expect(t.commit(IDS.mara, archiveChat, { conversationId: roomId })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      t.commit(IDS.mara, renameChat, { conversationId: roomId, title: 'Bugs' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const report = await submitReport(t, integration.siteId);
    expect(report.conversationId).toBe(roomId);
    expect(report.intake.conversationId).toBe(roomId);
    const root = (await messagesIn(roomId)).find((m) => m.id === report.rootMessageId);
    expect(root?.threadRootId).toBeNull();
    expect(root?.text).toContain(report.reference);
    expect((await unreadCounts(t.services.db, IDS.mara, [roomId])).get(roomId)?.unread).toBeGreaterThan(0);
    const rooms = await listChats(t.services.db, await person(IDS.mara), { rooms: true });
    expect(rooms.find((c) => c.id === roomId)?.lastText).toContain(report.reference);
  });

  it('starts the assessment in the report’s thread in plain words', async () => {
    const report = await submitReport(t, integration.siteId, { description: 'The PDF button does nothing.' });
    expect(report.assessmentState).toBe('queued');
    await t.services.feedback.runPending();
    const [started] = await t.services.db
      .select()
      .from(feedbackReports)
      .where(eq(feedbackReports.id, report.id));
    expect(started?.assessmentState).toBe('running');
    const [dispatch] = await t.services.db
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, started?.assessmentDispatchId ?? ''));
    expect(dispatch).toMatchObject({
      trigger: 'feedback',
      agentId: dusty.agentId,
      conversationId: integration.conversationId,
      threadRootId: report.rootMessageId,
    });
    const [kickoff] = await t.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, dispatch?.messageId ?? ''));
    expect(kickoff).toMatchObject({ mentions: [], threadRootId: report.rootMessageId });
    expect(kickoff?.text).toContain('Dusty');
  });
});

describe('a second integration', () => {
  it('posts in the same room, with its own line; the room stays “Feedback” whatever it is called', async () => {
    const before = (await messagesIn(dusty.dmId)).length;
    const first = await create(IDS.mara, chatSettings({ name: 'Shop' }));
    const room = first.conversationId;
    const lines = (await messagesIn(room)).filter(
      (m) => m.authorId === dusty.agentId && m.text.includes('“Shop”'),
    );
    expect(lines).toHaveLength(1);
    const renamed = await t.commit(IDS.mara, updateFeedbackIntegration, {
      integrationId: first.id,
      revision: first.revision,
      settings: chatSettings({ name: 'Lumio shop' }),
    });
    if (renamed.status !== 'ok') throw new Error(renamed.status);
    expect(renamed.result.conversationId).toBe(room);
    expect((await conversation(room)).chatTitle).toBe('Feedback');
    // Nothing of it lands in her Chat.
    expect(await messagesIn(dusty.dmId)).toHaveLength(before);
  });
});

/** The pre-Chat feedback chat the boot step moved an integration from, and the report root it holds. */
const _legacy: { chatId: string; reportRootId: string } | null = null;
