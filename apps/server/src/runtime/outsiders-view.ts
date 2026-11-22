/**
 * What an outsiders' turn sees of what Whombat posted for the person in its thread (docs/decisions/outsiders-turns.md):
 * a card only as one line that says what kind of card it was — an approval card as one that says the person was asked
 * and what they answered —, and what a `connection_actions` step posted — its “Done:” line, a notice about how its
 * calls went — only as one line that says Whombat told the person. Never what the server read from the person's
 * services and connections for them: the names of the ids an action names, paths with their account ids filled in,
 * labels, addresses or the services' answers, nor what a plan, run, job or other card the person asked for in that
 * thread says. The same rule holds for every way such a turn reads its thread: its context and `read_conversation`.
 */
import type { ApprovalState, Attachment, Message, MessageCard } from '@whombat/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { automationRunSteps, messages, principals } from '../db/schema/index';

/** What an outsiders' turn reads of an approval card, by its state. */
export const OUTSIDERS_CARD_LINE: Readonly<Record<ApprovalState, string>> = {
  pending: 'Whombat asked the person for a yes here. They haven’t answered yet.',
  approved: 'Whombat asked the person for a yes here. They said yes.',
  declined: 'Whombat asked the person for a yes here. They said no.',
};

/** What an outsiders' turn reads of what a `connection_actions` step told the person. */
export const OUTSIDERS_ACTIONS_LINE = 'Whombat told the person how the changes they were asked about went.';

/**
 * What each other card is, as an outsiders' turn reads it: one line with only its kind. Every kind is named here, so a
 * new card kind can't reach such a turn whole. A Feedback report's card is the outsider's own report (it starts the
 * assessment's thread, with their screenshots), so it is kept.
 */
const CARD_WORDS: Readonly<Record<Exclude<MessageCard['kind'], 'approval' | 'report'>, string>> = {
  plan: 'a plan',
  research: 'research',
  run: 'a run',
  review: 'a code review',
  commits: 'a list of commits',
  pill: 'a status',
  answer: 'an answer',
  digest: 'a digest',
  guide: 'a step of a guide',
  turn_failed: 'a note that a turn didn’t finish',
  assessment: 'an assessment',
  schedule: 'a scheduled turn',
  deploy: 'a deploy',
  device_skill: 'a device skill',
  task: 'a server task',
  automation_plan: 'a plan for an automation',
  look_plan: 'a plan for something that needs a look',
  feature_request: 'a feature request',
  council: 'a council',
  delegation: 'work handed to T3 Code',
};

/** What an outsiders' turn reads of a message with a card (or a job's result) of `kind`. */
export function outsidersCardLine(kind: keyof typeof CARD_WORDS | 'job_result'): string {
  return `Whombat showed the person a card here: ${kind === 'job_result' ? 'the result of work handed to T3 Code' : CARD_WORDS[kind]}.`;
}

/** An allowed attachment is shown only with its file metadata. */
function shownFile(file: Attachment): Attachment {
  const { id, name, contentType, size, url, kind, width, height } = file;
  return { id, name, contentType, size, url, kind, width, height };
}

/** The existing message contract also needs these empty fields. Never copy them from the source. */
function asLine(message: Message, text: string): Message {
  const { id, authorId, createdAt, conversationId, threadRootId } = message;
  return {
    id,
    authorId,
    createdAt,
    conversationId,
    threadRootId,
    text,
    editedAt: null,
    mentions: [],
    card: null,
    more: null,
    suggestions: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
  };
}

/** The ids of `ids` that a `connection_actions` step posted, or that were posted about how it went. */
async function actionsStepMessages(db: Db, ids: readonly string[]): Promise<ReadonlySet<string>> {
  if (!ids.length) return new Set();
  const rows = await db
    .select({ messageIds: automationRunSteps.messageIds })
    .from(automationRunSteps)
    .where(
      and(
        eq(automationRunSteps.kind, 'connection_actions'),
        sql`${automationRunSteps.messageIds} && ${sql.param([...ids])}::text[]`,
      ),
    );
  return new Set(rows.flatMap((r) => r.messageIds).filter((id) => ids.includes(id)));
}

interface OutsidersView {
  files?: ReadonlySet<string> | null;
  reportRootId?: string | null;
}

/** `shown` as an outsiders’ turn may read it, in the same order. */
export async function forOutsiders(
  db: Db,
  shown: readonly Message[],
  view: OutsidersView = {},
): Promise<Message[]> {
  const ids = [...new Set(shown.map((m) => m.id))];
  if (!ids.length) return [];
  const [told, sources] = await Promise.all([
    actionsStepMessages(db, ids),
    db
      .select({
        id: messages.id,
        outside: messages.outsidersRun,
        author: principals.kind,
      })
      .from(messages)
      .innerJoin(principals, eq(principals.id, messages.authorId))
      .where(inArray(messages.id, ids)),
  ]);
  const textIds = new Set(sources.filter((r) => r.outside || r.author === 'person').map((r) => r.id));
  return shown.map((m) =>
    outsidersMessage(m, {
      told: told.has(m.id),
      text: textIds.has(m.id) || m.provenance === 'feedback_assessment',
      report: m.id === view.reportRootId,
      files: view.files,
    }),
  );
}

/** Project a message onto the fields an outsiders’ turn is allowed to read. */
export function outsidersMessage(
  m: Message,
  access: {
    told?: boolean;
    text?: boolean;
    report?: boolean;
    files?: ReadonlySet<string> | null | undefined;
  },
): Message {
  if (access.told) return asLine(m, OUTSIDERS_ACTIONS_LINE);
  const card = m.card ?? m.earlierCard ?? null;
  if (card?.kind === 'approval') return asLine(m, OUTSIDERS_CARD_LINE[card.approval.state]);
  if (card?.kind === 'report') {
    if (!access.report) return asLine(m, 'Whombat showed the person a Feedback report here.');
    const { reportId, reference, product, type, summary, submittedAt, attachments, contentRemoved } = card;
    const report = {
      kind: 'report' as const,
      reportId,
      reference,
      product,
      type,
      summary,
      submittedAt,
      status: 'new' as const,
      assessment: { state: 'running' as const, outcome: null, summary: null },
      attachments,
      contentRemoved,
    };
    return { ...asLine(m, ''), card: report, attachments: m.attachments.map(shownFile) };
  }
  if (card) return asLine(m, outsidersCardLine(card.kind));
  if (m.movedCard) return asLine(m, outsidersCardLine(m.movedCard.kind));
  if (m.jobResult) return asLine(m, outsidersCardLine('job_result'));
  const line = asLine(m, access.text ? m.text : 'Whombat wrote privately to the person here.');
  line.attachments = m.attachments.filter((a) => access.files?.has(a.id)).map(shownFile);
  return line;
}
