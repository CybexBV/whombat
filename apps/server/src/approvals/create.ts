/**
 * Creating approvals: the keys engine's `ask` outcome (generic, from any command) and `request_approval`
 * (an agent asking with its own copy and conditions). Both write the approval, the requester's approval
 * card message and the signed `Asks` event in the commit's transaction, and notify the person after it: the person
 * decides every approval (docs/decisions/one-person.md OP-03, OP-S62), where it was asked.
 */
import {
  type ActionBinding,
  type Approval,
  type ApprovalAction,
  type ApprovalCondition,
  actionCopy,
  actionHash,
  approvalInboxText,
  askEventFields,
  conversationLabel,
  type Decision,
  defaultConditionLabel,
  IDLE_EXECUTION,
  isPersonalAction,
  KEY_CATALOG,
  type KeyId,
  newId,
  topics,
} from '@whombat/core';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { applyContext, toJsonObject } from '../commit/pipeline';
import type { ApplyContext, BurrowRow, KeyRequirement, TxSession } from '../commit/types';
import {
  approvals,
  conversations,
  type DeferredCommand,
  dispatches,
  principals,
  runs,
} from '../db/schema/index';
import { linkOfConversation } from '../domain/links';
import { postMessage } from '../domain/messages';
import { clearDecidedApproval, type NotificationDraft, notify } from '../domain/notify';
import { approvalPushGroup } from '../domain/push-preview';
import { indexApproval } from '../domain/search-index';
import { thePerson, thePersonAccountId } from '../domain/the-person';
import { publishApprovalChanged } from '../home/notify';
import { badRequest, conflict, notFound } from '../lib/errors';
import { type ConversationRow, loadConversationRow } from '../read/conversations';
import { type ActorInfo, loadPrincipalRow, nameInfo } from '../read/principals';
import { toApproval } from '../read/work';
import { currentDispatchScope, turnThread } from '../runtime/dispatch-scope';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface NewApproval {
  /** The catalog key that asked; null only for a `vault_use` approval (CT-102). */
  keyId: KeyId | null;
  action: ApprovalAction;
  decision: Decision | null;
  /**
   * Title, question and target of a `custom` action (written by the server from the command that asked).
   * Every other action gets its copy from the action itself (`actionCopy`), whatever is passed here.
   */
  title: string;
  question: string;
  target: string;
  /** Extra WHAT HAPPENS lines; the first line is always what actually runs, written from the action. */
  whatHappens: string[];
  explainer: string;
  /** Mobile summary; it follows the "what actually runs" sentence. */
  summary: string;
  /** Conditions besides "A person says yes" (added last). */
  conditions: ApprovalCondition[];
  involvedIds: string[];
  conversation: ConversationRow;
  /** Post the approval card in this thread of `conversation` instead of top level (a feedback report's thread). */
  threadRootId?: string | null;
  cardText: string;
  /** Asks event text; defaults to `askEventFields` ("Asked to deploy …"). */
  askText?: string;
  /** Asks event KEY USED note; defaults to `askEventFields` ("asks a person first"). */
  keyNote?: string;
  where?: string | null;
  command: DeferredCommand | null;
  /**
   * What the approval is bound to besides its action and input (an automation step: automation, version, step,
   * run and the commit it is about). Part of the signed action hash (bp-automations BP-C09).
   */
  binding?: ActionBinding;
  /**
   * Whether the request is the person's (SUB-28): their account, or null for an outsiders' turn's (OP-17); absent: as
   * the requesting agent's dispatch scope says, else the person's.
   */
  onBehalfOfAccountId?: string | null;
  /** The card is posted by a run outsiders' input started (`messages.outsiders_run`). */
  outsidersRun?: boolean;
}

/**
 * Whether a new approval is the person's (SUB-28), recorded when it is created so that what runs once it is approved
 * stays the person's work, or apart when an outsiders' turn asked (OP-17).
 */
async function requestingPerson(
  ctx: ApplyContext,
  explicit: string | null | undefined,
): Promise<string | null> {
  if (explicit !== undefined) return explicit;
  const scope = currentDispatchScope();
  if (scope && scope.agentId === ctx.actor.id && !scope.onBehalfOfAccountId) return null;
  return thePersonAccountId(ctx.tx, ctx.burrow.id);
}

/** The hash an approval's execution must reproduce (core `actionHash`). */
/** A title as the approval's question: one question mark, however the title ended (“Post the note?” stays). */
export function asQuestion(title: string): string {
  return `${title.replace(/[\s?]+$/u, '')}?`;
}

export function approvalActionHash(
  action: ApprovalAction,
  command: DeferredCommand | null,
  binding: ActionBinding | null | undefined,
): string {
  return actionHash({ action, input: command?.input ?? null, ...(binding ? { binding } : {}) });
}

/**
 * Involved principals are named by the requester (an agent's `request_approval`): each must be a principal of this
 * burrow, or the approval would mention principals of another burrow with the requester's copy.
 */
async function checkPrincipals(
  ctx: Pick<ApplyContext, 'tx' | 'burrow'>,
  ids: readonly string[],
  message: string,
): Promise<void> {
  if (ids.length === 0) return;
  const unique = [...new Set(ids)];
  const rows = await ctx.tx
    .select({ id: principals.id })
    .from(principals)
    .where(and(eq(principals.burrowId, ctx.burrow.id), inArray(principals.id, unique)));
  const ok = new Set(rows.map((r) => r.id));
  if (unique.some((id) => !ok.has(id))) throw badRequest(message);
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * The copy stored with a new approval. Title, question, target and the first WHAT HAPPENS line are written
 * from the action (environment, ref or commit, repo, service), never from the requester's wording, so the
 * card and modal say what the executor will run; the requester's own lines follow as detail.
 */
async function copyFor(
  ctx: Pick<ApplyContext, 'tx' | 'actor'>,
  a: NewApproval,
): Promise<Pick<Approval, 'title' | 'question' | 'target' | 'whatHappens' | 'summary'>> {
  // The agent asking for a key (“Give Tinker “Browse the web””) or to run one of its commands.
  const namedIds = a.action.type === 'grant_key' || a.action.type === 'run_command' ? [ctx.actor.id] : [];
  const named = namedIds.length
    ? await ctx.tx.select().from(principals).where(inArray(principals.id, namedIds))
    : [];
  const byId = new Map(named.map((m) => [m.id, nameInfo(m)]));
  // `custom` actions carry only a name: their copy is the server's, written from the command that asked.
  if (a.action.type === 'custom')
    return {
      title: a.title,
      question: a.question,
      target: a.target,
      whatHappens: a.whatHappens,
      summary: a.summary,
    };
  const derived = actionCopy(a.action, (pid) => byId.get(pid), ctx.actor.id);
  const extra = a.whatHappens.map((line) => line.trim()).filter((line) => line && line !== derived.runs);
  return {
    title: derived.title,
    question: derived.question,
    target: derived.target,
    whatHappens: [derived.runs, ...extra].map((line) => clip(line, 280)),
    summary: clip([`${derived.runs}.`, a.summary.trim()].filter(Boolean).join(' '), 600),
  };
}

/** Creates an approval requested by `ctx.actor` (the agent asking). */
export async function createApproval(
  ctx: ApplyContext,
  input: NewApproval,
): Promise<{ approval: Approval; eventId: string; messageId: string }> {
  const a = input;
  const { tx, burrow, actor } = ctx;
  // The person decides (OP-S62): the card stays where it was asked, which only they read.
  const person = await thePerson(tx, burrow.id);
  if (!person) throw conflict('There is nobody who could approve this.');
  const approverIds = [person.id];
  await checkPrincipals(ctx, a.involvedIds, 'Everyone involved must be on this Whombat.');
  const forAccountId = await requestingPerson(ctx, a.onBehalfOfAccountId);
  // The agent's ask in the person's turn: what it would do stays out of the signed log (PA-09).
  const own = forAccountId !== null && (await loadPrincipalRow(tx, actor.id))?.kind === 'agent';
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`coalesce(max(${approvals.number}), 0)::int + 1` })
    .from(approvals)
    .where(eq(approvals.burrowId, burrow.id));
  const id = newId('approval');
  const eventId = newId('event');
  const scope = currentDispatchScope();
  const [origin] =
    scope?.dispatchId && scope.agentId === actor.id
      ? await tx
          .select()
          .from(dispatches)
          .where(
            and(
              eq(dispatches.id, scope.dispatchId),
              eq(dispatches.burrowId, burrow.id),
              eq(dispatches.agentId, actor.id),
            ),
          )
      : [];
  const started =
    origin && !origin.runId
      ? await tx
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.dispatchId, origin.id), eq(runs.agentId, actor.id)))
          .limit(2)
      : [];
  const copy = await copyFor(ctx, a);
  const hash = approvalActionHash(a.action, a.command, a.binding);
  const conditions: ApprovalCondition[] = [
    ...a.conditions,
    {
      id: 'person',
      kind: 'person_approves',
      label: defaultConditionLabel({ kind: 'person_approves' }),
      met: false,
      approverIds,
    },
  ];
  await tx.insert(approvals).values({
    id,
    burrowId: burrow.id,
    number: next,
    requesterId: actor.id,
    createdByDispatchId: origin?.id ?? null,
    runId: origin?.runId ?? (started.length === 1 ? (started[0]?.id ?? null) : null),
    keyId: a.keyId,
    action: a.action,
    title: copy.title,
    question: copy.question,
    target: copy.target,
    whatHappens: copy.whatHappens,
    explainer: a.explainer,
    summary: copy.summary,
    conditions,
    state: 'pending',
    execution: IDLE_EXECUTION,
    conversationId: a.conversation.id,
    involvedIds: a.involvedIds,
    eventId,
    command: a.command,
    actionHash: hash,
    actionBinding: a.binding ?? null,
    onBehalfOfAccountId: forAccountId,
    createdAt: ctx.now,
  });

  // The card is the requester's own message.
  const posted = await postMessage(ctx, {
    conversation: a.conversation,
    text: a.cardText,
    card: { kind: 'approval', approvalId: id },
    // An agent's ask goes into the thread its turn was asked in, unless the caller says where (RC-14).
    threadRootId:
      a.threadRootId !== undefined
        ? a.threadRootId
        : ctx.actor.kind === 'agent'
          ? await turnThread(tx, { agentId: ctx.actor.id, conversationId: a.conversation.id })
          : null,
    // The card's text describes the action (an event title, a file name): an `@Name` in it mentions no one.
    mentions: [],
    dispatch: false,
    ...(a.outsidersRun !== undefined ? { outsidersRun: a.outsidersRun } : {}),
  });
  await tx.update(approvals).set({ messageId: posted.id }).where(eq(approvals.id, id));

  const keyId = a.keyId;
  // An ask without a catalog key (a command, a connection call) says it asked.
  const fields = keyId
    ? askEventFields(
        a.decision ?? {
          outcome: 'ask' as const,
          tier: 'ask' as const,
          keyId,
          reason: 'asks_first' as const,
          clamped: false,
        },
        actor.shortName,
        a.action,
      )
    : { kind: 'Asks' as const, type: 'approval.requested', text: `${actor.shortName} asked for approval` };
  const conversationLink = await linkOfConversation(tx, a.conversation);
  await ctx.emit({
    ...fields,
    id: eventId,
    text: a.askText ?? fields.text,
    ...(a.keyNote ? { keyNote: a.keyNote } : {}),
    where: a.where ?? conversationLabel(a.conversation),
    approvalId: id,
    ref: { type: 'approval', number: next, in: conversationLink },
    payload: {
      approvalId: id,
      number: next,
      // The agent's own ask and a personal action keep recipients, subjects, file names and a re-run command's input
      // out of the signed log (PA-09); only the action's type.
      action: own || isPersonalAction(a.action) ? { type: a.action.type } : toJsonObject(a.action),
      // A Vault ask: the entry by id only (VT-51); its name is the owner's detail.
      messageId: posted.id,
      // The exact action + input + binding this approval covers; execution recomputes it (BP-C09). A hash
      // reveals nothing of a private approval's content (BP-06).
      actionHash: hash,
      ...(a.binding ? { binding: toJsonObject(a.binding) } : {}),
    },
    approvalState: { number: next, state: 'pending', decidedById: null, decidedAt: null, executedAt: null },
  });

  const [row] = await tx.select().from(approvals).where(eq(approvals.id, id));
  if (!row) throw notFound('Approval');
  const approval = toApproval(row);
  // Found as a DECISION from the start, in this commit (WS-24); on Home's Needs you and its chat (HR-43).
  await indexApproval(tx, id);
  await publishApprovalChanged(ctx, approval);
  ctx.publish(topics.burrow(burrow.id), { type: 'approval.updated', approval }, { eventId });

  const services = ctx.services;
  // Push delivery doesn't hold the response; one approval's updates go in order (server-efficiency.md SV-02).
  ctx.background(
    'approval live activity',
    async () => {
      await services.liveActivity.onApprovalChanged(approval, burrow.slug);
      await clearDecidedApproval(services, approval, burrow.slug);
    },
    `live:approval:${approval.id}`,
  );
  ctx.after(async () => {
    const names = await services.db
      .select()
      .from(principals)
      .where(
        inArray(principals.id, [
          ...approverIds,
          actor.id,
          ...approval.involvedIds,
          ...approval.conditions.flatMap((c) => (c.kind === 'review_approved' ? [c.reviewerId] : [])),
        ]),
      );
    const byId = new Map(names.map((n) => [n.id, nameInfo(n)]));
    const text = approvalInboxText(approval, { names: (pid) => byId.get(pid) });
    const drafts: NotificationDraft[] = approverIds.map((principalId) => ({
      burrowId: burrow.id,
      burrowSlug: burrow.slug,
      principalId,
      kind: 'needs_you',
      actorId: actor.id,
      where: conversationLabel(a.conversation),
      text,
      link: { type: 'approval', number: next, in: conversationLink },
      approvalId: id,
      createdAt: ctx.now,
      // One notification per approval on the phone; cleared once it's decided (NT-15, NT-16).
      group: approvalPushGroup(id),
    }));
    await notify(services, drafts);
  });
  return { approval, eventId, messageId: posted.id };
}

/** The keys engine said `ask`: turn the command into a pending approval that re-runs it once approved. */
export async function createAskApproval(
  session: TxSession,
  args: {
    burrow: BurrowRow;
    actor: ActorInfo;
    decision: Decision;
    requirement: KeyRequirement;
    command: DeferredCommand;
    at: string;
    onBehalfOf: { text?: string; principalId?: string };
  },
): Promise<{ approval: Approval; eventId: string }> {
  const { burrow, actor, decision, requirement } = args;
  const ctx = applyContext(session, {
    burrow,
    actor,
    now: new Date(args.at),
    at: args.at,
    decision,
    requirement,
    approvalId: null,
    onBehalfOf: args.onBehalfOf,
  });
  // The card goes where the command says (an agent's input for perform_action / start_run): any conversation of this
  // burrow, all of them the person's. Without one it goes to the Chat of the person the work is for (one-agent.md
  // OA-04: there are no channels).
  let conversation: ConversationRow | undefined;
  if (requirement.conversationId) {
    conversation = await loadConversationRow(session.tx, requirement.conversationId);
    if (!conversation || conversation.burrowId !== burrow.id) throw notFound('Conversation');
  }
  if (!conversation && args.onBehalfOf.principalId) {
    const [chat] = await session.tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.burrowId, burrow.id),
          eq(conversations.kind, 'dm'),
          eq(conversations.dmAgentId, actor.id),
          eq(conversations.dmPersonId, args.onBehalfOf.principalId),
          isNull(conversations.taskKey),
        ),
      );
    conversation = chat;
  }
  if (!conversation) throw conflict('There is nobody to ask here.');
  const attempt = requirement.attempt;
  const label = KEY_CATALOG[requirement.keyId].label;
  const draft = requirement.approval ?? {};
  const title = draft.title ?? cap(attempt);
  const action: ApprovalAction = requirement.action ?? {
    type: 'custom',
    // Named by what it does (“create a file”), never the internal command (`connector.files_create`): the
    // name is what decision and failure texts say (IN-21). The command's input is not copied here: the action
    // is signed into the burrow-wide `approval.requested` event, and the input stays with the deferred command
    // (`approvals.command`), bound by the signed action hash (security review SEC-PACK-ARGS, BP-06).
    params: { name: attempt.slice(0, 80), keyId: requirement.keyId, data: {} },
  };
  const { approval, eventId } = await createApproval(ctx, {
    keyId: requirement.keyId,
    action,
    decision,
    title,
    question: draft.question ?? asQuestion(title),
    target: draft.target ?? '',
    whatHappens: draft.whatHappens ?? (requirement.action ? [] : [cap(attempt)]),
    explainer:
      draft.explainer ??
      `${actor.shortName} holds “${label}”, a key that only turns when a person approves. If you approve, it goes ahead right away.`,
    summary: draft.summary ?? (requirement.action ? '' : `${actor.shortName} wants to ${attempt}.`),
    conditions: draft.conditions ?? [],
    involvedIds: draft.involvedIds ?? [],
    conversation,
    cardText: draft.cardText ?? `I need a person to say yes before I ${attempt}.`,
    askText: `Asked to ${attempt}`,
    where: requirement.where ?? null,
    // A yes runs the action's executor (EA-02) rather than the command again, when the command says so.
    command: requirement.approvalRunsAction && requirement.action ? null : args.command,
  });
  return { approval, eventId };
}
