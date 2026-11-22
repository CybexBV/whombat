/**
 * `createFixtureFetch()`: a fetch-compatible function that serves the mock world over the real REST
 * contract (`@whombat/core/contracts`). Reads are served straight from the fixtures; a handful of writes
 * (send message, approve/decline/undo, run pause/resume/take over, the agent's name, face, keys and workspace) mutate
 * an in-memory copy of the world that lives in this factory's closure, so every call to `createFixtureFetch()` gets
 * its own isolated state.
 *
 * Routing walks `API_ENDPOINTS` and matches each one with `matchPath()` — the same primitive the real
 * client uses to build URLs — so a new endpoint only needs a case added to `handle()` below, not a new
 * router. Endpoints with no case here 404; that is deliberate (see `docs/decisions/fixtures.md` for the
 * endpoints intentionally out of scope, e.g. `notifications.inbox`).
 */
import type { AuditPrincipalInfo, ChainHead } from '@whombat/core/audit';
import {
  type AuditFilter,
  appendEvent,
  auditCsv,
  countAuditKinds,
  filterAuditEvents,
} from '@whombat/core/audit';
import {
  type AnyEndpoint,
  API_ENDPOINTS,
  type HostInfo,
  matchPath,
  pageThreadReplies,
  UpdateAgentBody,
} from '@whombat/core/contracts';
import type {
  Agent,
  Approval,
  AuditApprovalState,
  AuditEvent,
  Conversation,
  Grant,
  GrantInput,
  Message,
  PrFileView,
  PullRequest,
  Run,
  SearchAnswer,
  SignedEvent,
} from '@whombat/core/domain';
import {
  conversationLabel,
  countSearchResults,
  fileViewLines,
  groupCommentThreads,
  mergeBlock,
  prStatus,
  resolveAgentModelRuntime,
  searchFilterOf,
  shortNameOf,
} from '@whombat/core/domain';
import { newId } from '@whombat/core/ids';
import { describeGrantChange, diffGrants } from '@whombat/core/keys';
import { burrowAddress, isValidBurrowSlug, resolveMentions, slugify } from '@whombat/core/text';
import type { VaultEntryDetail } from '@whombat/core/vault';
import { AUDIT_CHAIN } from './audit.js';
import { BURROW_ID, burrow } from './burrow.js';
import { CANVAS_COMMENTS, CANVAS_MARKDOWN, CANVASES, canvas } from './canvas.js';
import { CONVERSATIONS, cnv_pr482, conversation } from './conversations.js';
import { DEPLOYMENT_ENDPOINT_IDS, deploymentEnvironments, deploymentsPage } from './deployments.js';
import { createFeedbackWorld, FEEDBACK_ENDPOINT_IDS, handleFeedback } from './feedbackFetch.js';
import { RUN_LOG_LINES } from './live.js';
import { createMemoryWorld, handleMemory, MEMORY_ENDPOINT_IDS } from './memoryFetch.js';
import { MESSAGES_BY_CONVERSATION, message, threadReplies } from './messages.js';
import { onboarding } from './onboarding.js';
import { AGENT, grantsFor, mara, PRINCIPALS, principal, secretKeyOf } from './principals.js';
import { SEARCH_QUERY, SEARCH_RESULTS, searchAnswer } from './search.js';
import { createServicesWorld, SERVICES_ENDPOINT_IDS } from './services.js';
import { createSkillsWorld, handleSkills, SKILLS_ENDPOINT_IDS } from './skillsFetch.js';
import { SPEND_ENDPOINT_IDS, spendOverview, spendWeek } from './spend.js';
import {
  agentKeysSummary,
  bootstrap,
  conversationSummary,
  currentRunFor,
  enrichAuditEvent,
  isAgent,
  sidebar,
} from './store.js';
import { at, SEED_NOW } from './time.js';
import { USAGE_ENDPOINT_IDS, usageList, usageRefresh } from './usage.js';
import { createVaultWorld, handleVault, VAULT_ENDPOINT_IDS, type VaultWorld } from './vaultFetch.js';
import {
  approval as deployApprovalFixture,
  plan,
  pr,
  prApproved,
  prFileVersions,
  run,
  runFinished,
} from './work.js';

export { handleServicePagesRequest } from './servicePagesFetch.js';

/** The scripted stand-in's canned reply (Whombat's scripted ACP agent for Hermes, HE-33; the mock's `sendDraft()`). */
export const CANNED_REPLY = 'On it. I’ll post back here when I have something worth reading.';

/** `matchPath` needs paths relative to `base`; every endpoint here uses the default `/api/v1` base. */
function stripBase(pathname: string, base: string): string | null {
  if (!pathname.startsWith(base)) return null;
  const rest = pathname.slice(base.length);
  return rest === '' ? '/' : rest;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function notFound(message = 'Not found'): Response {
  return jsonResponse({ error: { code: 'not_found', message } }, 404);
}

/** Reads a matched route param. `matchPath` guarantees it's present for the routes that use it. */
function param(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (value === undefined) throw new Error(`Missing route param ${name}`);
  return value;
}

/** The mock box (`host.info`): no deploy workflow, and the agent's services can run. */
export const FIXTURE_HOST: HostInfo = {
  deployWorkflow: false,
  services: { available: true, reason: null },
};

/** One in-memory copy of the mock world. A fresh one is built per `createFixtureFetch()` call. */
function createWorld() {
  const conversations = new Map<string, Conversation>(CONVERSATIONS.map((c) => [c.id, c]));
  const messagesByConversation = new Map<string, Message[]>(
    Object.entries(MESSAGES_BY_CONVERSATION).map(([id, msgs]) => [id, [...msgs]]),
  );
  const allMessages = new Map<string, Message>();
  for (const msgs of messagesByConversation.values()) for (const m of msgs) allMessages.set(m.id, m);

  let currentRun: Run = run;
  let currentPr: PullRequest = pr;
  let currentApproval: Approval = deployApprovalFixture;
  /** Event id of the approval's most recent decision (decide / undo), or null before any decision. */
  let lastDecisionEventId: string | null = null;

  /** The one agent, as Settings → Agent last changed it (`agent.update`). */
  let currentAgent: Agent = AGENT;
  /** Keys mutates the agent's grants here; `agent.get` reads from this instead of the static `grantsFor()` so a save
   * is visible right away. See `docs/decisions/archive/agents.md`. */
  let agentGrants: Grant[] = grantsFor(AGENT.id);

  const events: SignedEvent[] = [...AUDIT_CHAIN];
  const lastEvent = events.at(-1);
  if (!lastEvent) throw new Error('AUDIT_CHAIN must not be empty');
  let chainHead: ChainHead = { seq: lastEvent.seq, hash: lastEvent.hash };

  function appendWorldEvent(input: {
    id: string;
    actorId: string;
    type: string;
    kind: SignedEvent['kind'];
    text: string;
    where: string | null;
    aboutId?: string;
    approvalId?: string;
    ref?: SignedEvent['ref'];
  }): SignedEvent {
    // Fixture-only signing key: the actor's own deterministic seed key (`principals.ts#secretKeyOf`).
    // `fetch.ts` never models real request auth — this is a mock world, not a server.
    const signed = appendEvent(
      chainHead,
      {
        id: input.id,
        burrowId: BURROW_ID,
        actorId: input.actorId,
        type: input.type,
        kind: input.kind,
        text: input.text,
        where: input.where,
        ...(input.aboutId ? { aboutId: input.aboutId } : {}),
        ...(input.approvalId ? { approvalId: input.approvalId as never } : {}),
        ...(input.ref ? { ref: input.ref } : {}),
        payload: {},
        createdAt: SEED_NOW.toISOString(),
      },
      secretKeyOf(input.actorId),
    );
    events.push(signed);
    chainHead = { seq: signed.seq, hash: signed.hash };
    return signed;
  }

  function approvalByEventId(): Map<string, AuditApprovalState> {
    const map = new Map<string, AuditApprovalState>();
    if (currentApproval.eventId) {
      map.set(currentApproval.eventId, {
        number: currentApproval.number,
        state: currentApproval.state,
        decidedById: currentApproval.decidedById,
        decidedAt: currentApproval.decidedAt,
        executedAt: currentApproval.executedAt,
      });
    }
    return map;
  }

  /** A thread reply updates its root's count, last reply time and stacked heads (last 3 repliers). */
  function bumpThread(rootId: string, replies: Message[]) {
    const root = allMessages.get(rootId);
    if (!root) return;
    let heads = [...root.threadParticipantIds];
    for (const r of replies) heads = [...heads.filter((id) => id !== r.authorId), r.authorId].slice(-3);
    const last = replies.at(-1);
    const updated: Message = {
      ...root,
      replyCount: root.replyCount + replies.length,
      lastReplyAt: last ? last.createdAt : root.lastReplyAt,
      threadParticipantIds: heads,
    };
    allMessages.set(rootId, updated);
    const list = messagesByConversation.get(root.conversationId);
    if (list)
      messagesByConversation.set(
        root.conversationId,
        list.map((m) => (m.id === rootId ? updated : m)),
      );
  }

  /** One signed Keys event about the agent, by Mara (she owns the burrow), as `{id, text}`. */
  function agentKeysEvent(type: string, text: string): { id: string; text: string } {
    const signed = appendWorldEvent({
      id: newId('event'),
      actorId: mara.id,
      type,
      kind: 'Keys',
      text,
      where: `Agent · ${currentAgent.name}`,
      aboutId: currentAgent.id,
      ref: { type: 'agent' },
    });
    return { id: signed.id, text: signed.text ?? '' };
  }

  return {
    conversations,
    messagesByConversation,
    allMessages,
    get run() {
      return currentRun;
    },
    get pr() {
      return currentPr;
    },
    get approval() {
      return currentApproval;
    },
    get lastDecisionEventId() {
      return lastDecisionEventId;
    },
    get agent() {
      return currentAgent;
    },
    get grants() {
      return agentGrants;
    },
    events,
    appendWorldEvent,
    approvalByEventId,
    /** Keys: replaces the agent's grants wholesale; one Keys event per changed key. */
    setKeys(grants: GrantInput[]) {
      const agentId = currentAgent.id;
      const after: Grant[] = grants.map((g) => ({ ...g, agentId }));
      const events = diffGrants(agentGrants, after).map((change) =>
        agentKeysEvent('keys.changed', describeGrantChange(currentAgent.name, change)),
      );
      agentGrants = after;
      return { grants: after, events };
    },
    /** `agent.update` (owners): the name, the face or the model; one Keys event when anything changed. */
    update(body: UpdateAgentBody) {
      const before = currentAgent;
      const nextRuntime: Agent['runtime'] | undefined = body.runtime
        ? resolveAgentModelRuntime(body.runtime, before.runtime)
        : undefined;
      const updated: Agent = {
        ...before,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.face !== undefined ? { face: body.face } : {}),
        ...(nextRuntime ? { runtime: nextRuntime } : {}),
      };
      const changed =
        updated.name !== before.name ||
        updated.face !== before.face ||
        JSON.stringify(updated.runtime) !== JSON.stringify(before.runtime);
      currentAgent = updated;
      if (changed)
        agentKeysEvent(
          'agent.updated',
          updated.name !== before.name
            ? `Renamed ${before.name} to ${updated.name}`
            : `Changed ${updated.name}`,
        );
      return { agent: updated };
    },
    /** Approve: fast-forwards the storyline to its finished state (see `docs/decisions/fixtures.md`). */
    approve(actorId: string) {
      if (currentApproval.state !== 'pending') return { approval: currentApproval, eventId: null };
      currentRun = runFinished;
      currentPr = prApproved;
      const decidedAt = SEED_NOW.toISOString();
      const executedAt = at('11:38');
      currentApproval = {
        ...currentApproval,
        state: 'approved',
        decidedById: actorId,
        decidedAt,
        conditions: currentApproval.conditions.map((c) => {
          if (c.kind === 'checks_pass')
            return { ...c, met: true, state: 'passed', passed: 41, total: 41, fixing: false };
          if (c.kind === 'review_approved')
            return { ...c, met: true, reviewState: 'approved', reviewedAt: executedAt };
          if (c.kind === 'person_approves') return { ...c, met: true };
          return c;
        }),
        execution: {
          state: 'succeeded',
          startedAt: at('11:36'),
          finishedAt: executedAt,
          durationMs: 120_000,
          resultUrl: 'https://staging.burrowhq.example/billing-api',
          error: null,
        },
        executedAt,
      };
      const approved = appendWorldEvent({
        id: newId('event'),
        actorId,
        type: 'approval.approved',
        kind: 'Asks',
        text: `Approved: ${currentApproval.title}`,
        where: 'feat/invoice-pdf',
        approvalId: currentApproval.id,
        ref: { type: 'approval', number: currentApproval.number },
      });
      appendWorldEvent({
        id: newId('event'),
        actorId: currentApproval.requesterId,
        type: 'approval.executed',
        kind: 'Code',
        text: `Deployed feat/invoice-pdf to staging`,
        where: 'feat/invoice-pdf',
        approvalId: currentApproval.id,
        ref: { type: 'approval', number: currentApproval.number },
      });
      lastDecisionEventId = approved.id;
      return { approval: currentApproval, eventId: approved.id };
    },
    decline(actorId: string, note: string | undefined) {
      if (currentApproval.state !== 'pending') return { approval: currentApproval, eventId: null };
      currentApproval = {
        ...currentApproval,
        state: 'declined',
        decidedById: actorId,
        decidedAt: SEED_NOW.toISOString(),
      };
      const declined = appendWorldEvent({
        id: newId('event'),
        actorId,
        type: 'approval.declined',
        kind: 'Asks',
        text: note ? `Declined: ${currentApproval.title} — ${note}` : `Declined: ${currentApproval.title}`,
        where: 'feat/invoice-pdf',
        approvalId: currentApproval.id,
        ref: { type: 'approval', number: currentApproval.number },
      });
      lastDecisionEventId = declined.id;
      return { approval: currentApproval, eventId: declined.id };
    },
    undo(actorId: string) {
      if (currentApproval.state === 'pending') return { approval: currentApproval, eventId: null };
      if (currentApproval.executedAt !== null) return { approval: currentApproval, eventId: null };
      currentApproval = { ...currentApproval, state: 'pending', decidedById: null, decidedAt: null };
      const undone = appendWorldEvent({
        id: newId('event'),
        actorId,
        type: 'approval.undone',
        kind: 'Asks',
        text: `Undid the decision on: ${currentApproval.title}`,
        where: 'feat/invoice-pdf',
        approvalId: currentApproval.id,
        ref: { type: 'approval', number: currentApproval.number },
      });
      lastDecisionEventId = undone.id;
      return { approval: currentApproval, eventId: undone.id };
    },
    /**
     * Merge into main (people only): refused with the server's 409 while `mergeBlock()` says why,
     * else the PR is merged and a signed Code event appended.
     */
    merge(actorId: string): { ok: true } | { ok: false; block: NonNullable<ReturnType<typeof mergeBlock>> } {
      const block = mergeBlock(currentPr, 'person');
      if (block) return { ok: false, block };
      const mergedAt = SEED_NOW.toISOString();
      currentPr = { ...currentPr, state: 'merged', mergedAt, mergedById: actorId };
      appendWorldEvent({
        id: newId('event'),
        actorId,
        type: 'pr.merged',
        kind: 'Code',
        text: `Merged PR #${currentPr.number} into ${currentPr.baseBranch}`,
        where: `${currentPr.repoFullName} · PR #${currentPr.number}`,
        ref: { type: 'pr', number: currentPr.number },
      });
      return { ok: true };
    },
    /**
     * Run page controls (Pause / Resume / Try again / Take over), mirroring `apps/server/src/commands/runs.ts`: the
     * same status rules and signed event texts. Null when the run is not in a state that allows it.
     */
    controlRun(action: 'pause' | 'resume' | 'retry' | 'take_over', actorId: string, actorShortName: string) {
      const r = currentRun;
      const agentName = r.agentId === currentAgent.id ? currentAgent.name : 'the agent';
      if (action === 'pause' && r.status !== 'live') return null;
      if (action === 'resume' && r.status !== 'paused') return null;
      if (action === 'retry' && r.status !== 'failed') return null;
      if (action === 'take_over' && r.status !== 'live' && r.status !== 'paused') return null;
      currentRun =
        action === 'pause'
          ? { ...r, status: 'paused', pausedById: actorId }
          : action === 'resume'
            ? { ...r, status: 'live', pausedById: null, attention: null }
            : action === 'retry'
              ? { ...r, status: 'live', finishedAt: null, summary: null, attention: null }
              : {
                  ...r,
                  status: 'taken_over',
                  takenOverById: actorId,
                  summary: `${actorShortName} took over ${r.branch}.`,
                };
      const verb = { pause: 'Paused', resume: 'Resumed', retry: 'Tried', take_over: 'Took over' }[action];
      appendWorldEvent({
        id: newId('event'),
        actorId,
        type: {
          pause: 'run.paused',
          resume: 'run.resumed',
          retry: 'run.retried',
          take_over: 'run.taken_over',
        }[action],
        kind: 'Code',
        text:
          action === 'retry'
            ? `Tried ${agentName}’s run #${r.number} again`
            : `${verb} ${agentName}’s run #${r.number}${action === 'take_over' ? ` on ${r.branch}` : ''}`,
        where: `Run #${r.number}`,
        aboutId: r.agentId,
        ref: { type: 'run', number: r.number },
      });
      return currentRun;
    },
    sendMessage(
      conversationId: string,
      body: { text: string; threadRootId?: string; clientId?: string },
      actorId: string,
    ) {
      const id = newId('message');
      const msg: Message = {
        id,
        conversationId,
        authorId: actorId,
        createdAt: SEED_NOW.toISOString(),
        editedAt: null,
        text: body.text,
        mentions: resolveMentions(body.text, [
          ...PRINCIPALS.filter((p) => p.kind === 'person'),
          currentAgent,
        ]),
        card: null,
        suggestions: [],
        more: null,
        attachments: [],
        reactions: [],
        threadRootId: body.threadRootId ?? null,
        replyCount: 0,
        lastReplyAt: null,
        threadParticipantIds: [],
        clientId: body.clientId ?? null,
      };
      allMessages.set(id, msg);
      const list = messagesByConversation.get(conversationId) ?? [];
      list.push(msg);
      messagesByConversation.set(conversationId, list);
      const dispatches: { dispatchId: string }[] = [];
      const conv = conversations.get(conversationId);
      // Like the mock's `sendDraft()`: a person's message in their own room, or one mentioning the agent, wakes it, and it
      // replies in place.
      const wakes =
        actorId !== currentAgent.id && (conv?.kind === 'dm' || msg.mentions.includes(currentAgent.id));
      const agentTarget = wakes ? currentAgent : undefined;
      const replies: Message[] = [msg];
      if (agentTarget) {
        const replyId = newId('message');
        const reply: Message = {
          id: replyId,
          conversationId,
          authorId: agentTarget.id,
          createdAt: SEED_NOW.toISOString(),
          editedAt: null,
          text: CANNED_REPLY,
          mentions: [],
          card: null,
          suggestions: [],
          more: null,
          attachments: [],
          reactions: [],
          threadRootId: body.threadRootId ?? null,
          replyCount: 0,
          lastReplyAt: null,
          threadParticipantIds: [],
          clientId: null,
        };
        allMessages.set(replyId, reply);
        list.push(reply);
        replies.push(reply);
        dispatches.push({ dispatchId: newId('dispatch') });
      }
      if (body.threadRootId) bumpThread(body.threadRootId, replies);
      return { message: msg, dispatches };
    },
  };
}

type World = ReturnType<typeof createWorld>;

function handleBootstrap(): Response {
  return jsonResponse(bootstrap(), 200);
}

function handleConversationDetail(world: World, conversationId: string): Response {
  const c = world.conversations.get(conversationId);
  if (!c) return notFound(`No conversation ${conversationId}`);
  return jsonResponse(
    {
      conversation: c,
      summary: conversationSummary(c),
      pr: c.kind === 'branch' ? world.pr : null,
      lastReadMessageId: null,
    },
    200,
  );
}

function handleMessages(world: World, conversationId: string, url: URL): Response {
  const msgs = (world.messagesByConversation.get(conversationId) ?? []).filter(
    (m) => m.threadRootId === null,
  );
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Number(limitRaw) : 50;
  return jsonResponse({ messages: msgs.slice(-limit), before: null, hasMore: false }, 200);
}

function handleThread(world: World, messageId: string, url: URL): Response {
  const root = world.allMessages.get(messageId) ?? message(messageId);
  if (!root) return notFound(`No message ${messageId}`);
  // Seeded replies (kept out of the conversation lists) plus the ones sent in this world.
  const sent = (world.messagesByConversation.get(root.conversationId) ?? []).filter(
    (m) => m.threadRootId === root.id,
  );
  const seeded = threadReplies(root.id);
  const allReplies = [...seeded, ...sent.filter((m) => !seeded.some((s) => s.id === m.id))];
  const conv = world.conversations.get(root.conversationId) ?? conversation(root.conversationId);
  const where = conv ? conversationLabel(conv) : '';
  // Thread paging (contracts 0.55, CT-299): `limit` and `before`, else every reply.
  const limit = url.searchParams.get('limit');
  const page = pageThreadReplies(allReplies, {
    before: url.searchParams.get('before') ?? undefined,
    limit: limit ? Number(limit) : undefined,
  });
  return jsonResponse(
    {
      root,
      replies: page.replies,
      conversationId: root.conversationId,
      where,
      topic: threadTopic(root),
      more: page.more,
    },
    200,
  );
}

/** Second half of the thread pane's context line, as the server derives it (`read/views.ts#threadView`). */
function threadTopic(root: Message): string | null {
  const card = root.card;
  if (!card) return null;
  if (card.kind === 'research') return card.topic;
  if (card.kind === 'plan') return card.plan.title;
  if (card.kind === 'run') return card.run.title;
  if (card.kind === 'approval') return card.approval.title;
  return null;
}

function handlePrList(world: World): Response {
  return jsonResponse({ prs: [world.pr] }, 200);
}

function handlePrGet(world: World): Response {
  const status = prStatus(world.pr);
  return jsonResponse(
    { pr: world.pr, status, mergeBlock: mergeBlock(world.pr, 'person'), staging: world.approval },
    200,
  );
}

/** `prs.file` (CT-241): one of the PR's files, made up to match its `+add −del` (`prFileVersions`). */
function handlePrFile(world: World, path: string): Response {
  const file = world.pr.files.find((f) => f.path === path);
  if (!file) return notFound(`PR #${world.pr.number} doesn’t change ${path}.`);
  const { base, head } = prFileVersions(file);
  const lines = fileViewLines(base, head);
  const view: PrFileView = {
    path,
    status: base === null ? 'added' : 'modified',
    shown: 'text',
    add: lines.filter((l) => l.kind === 'add').length,
    del: lines.filter((l) => l.kind === 'del').length,
    lines,
    baseSha: base === null ? null : '7c41d2',
    headSha: world.pr.headSha,
  };
  return jsonResponse(view, 200);
}

const MERGE_BLOCK_MESSAGES = {
  agent: 'Merging is for people. The agent doesn’t hold a merge key here.',
  not_open: 'This pull request is not open.',
  checks: 'Checks have to pass before this can be merged.',
  review: 'It needs an approving review (and no changes requested) before it can be merged.',
} as const;

/** `prs.merge`, as the server answers it: 409 `conflict` while blocked, else the merged detail. */
function handlePrMerge(world: World): Response {
  const result = world.merge(mara.id);
  if (!result.ok) {
    return jsonResponse(
      {
        error: {
          code: 'conflict',
          message: MERGE_BLOCK_MESSAGES[result.block],
          details: { mergeBlock: result.block },
        },
      },
      409,
    );
  }
  return handlePrGet(world);
}

function handleRunGet(world: World): Response {
  const conv = world.conversations.get(world.run.conversationId);
  return jsonResponse(
    {
      run: world.run,
      log: RUN_LOG_LINES.slice(0, world.run.logCount),
      grants: world.run.agentId === world.agent.id ? world.grants : [],
      conversation: conversationSummary(conv ?? cnv_pr482),
    },
    200,
  );
}

function handleRunControl(world: World, action: 'pause' | 'resume' | 'retry' | 'take_over'): Response {
  const next = world.controlRun(action, mara.id, mara.shortName ?? mara.name);
  if (!next) {
    const message = {
      pause: 'Only a live run can be paused.',
      resume: 'Only a paused run can be resumed.',
      retry: 'Only a failed run can be tried again.',
      take_over: 'This run has already finished.',
    }[action];
    return jsonResponse({ error: { code: 'conflict', message } }, 409);
  }
  if (action !== 'take_over') return jsonResponse({ run: next }, 200);
  return jsonResponse(
    {
      run: next,
      branch: next.branch,
      instructions: `git fetch origin ${next.branch} && git switch ${next.branch}`,
    },
    200,
  );
}

function handleApprovalGet(world: World): Response {
  return jsonResponse({ approval: world.approval, eventId: world.lastDecisionEventId }, 200);
}

async function handleApprovalDecide(world: World, req: Request): Promise<Response> {
  const body = (await req.json()) as { decision: 'approve' | 'decline'; note?: string };
  const result = body.decision === 'approve' ? world.approve(mara.id) : world.decline(mara.id, body.note);
  return jsonResponse(result, 200);
}

function handleApprovalUndo(world: World): Response {
  return jsonResponse(world.undo(mara.id), 200);
}

/** Matches `apps/server/src/read/work-views.ts#agentProfile()`: actor-authored, texted events only — not
 * events merely *about* the agent (key grants/changes). See `docs/decisions/seed-wiring.md` SW-01. */
function recentActivity(world: World) {
  const map = world.approvalByEventId();
  return world.events
    .filter((e) => e.actorId === world.agent.id && e.text !== null)
    .slice()
    .reverse()
    .slice(0, 3)
    .map((e) => {
      const enriched = enrichAuditEvent(e, map);
      return {
        eventId: enriched.id,
        text: enriched.text ?? '',
        at: enriched.createdAt,
        link: enriched.ref ?? null,
      };
    });
}

/** Settings → Agent (`agent.get`): the agent, its keys, what it did lately and the run it is on. */
function handleAgentGet(world: World): Response {
  return jsonResponse(
    {
      agent: world.agent,
      grants: world.grants,
      keys: agentKeysSummary(world.grants),
      recent: recentActivity(world),
      currentRun: currentRunFor(world.run),
      modelFallback: null,
    },
    200,
  );
}

function validationFailed(field: string, message: string): Response {
  return jsonResponse({ error: { code: 'validation_failed', message, fields: { [field]: [message] } } }, 400);
}

/** `agent.update` (owners): the name, the face or the model. A malformed or reserved name is `validation_failed`. */
async function handleAgentUpdate(world: World, req: Request): Promise<Response> {
  // `Request.json()` is typed `Promise<unknown>` under Node/undici (`@types/node`), unlike DOM lib's
  // `Promise<any>`. See `docs/decisions/seed-wiring.md` SW-13.
  const parsed = UpdateAgentBody.safeParse(await req.json());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return validationFailed(String(issue?.path[0] ?? 'name'), issue?.message ?? 'Some fields are not valid.');
  }
  return jsonResponse(world.update(parsed.data), 200);
}

/** Keys (owners): see `docs/decisions/archive/agents.md`. */
async function handleAgentSetKeys(world: World, req: Request): Promise<Response> {
  const body = (await req.json()) as { grants: GrantInput[] };
  return jsonResponse(world.setKeys(body.grants), 200);
}

function resolvePrincipalIdByHandle(handle: string): string | null {
  const p = PRINCIPALS.find((x) => x.handle === handle);
  return p?.id ?? null;
}

/** Mara owns every fixture Vault entry, so her log carries the owner's detail on Vault events (VT-52). */
function withVaultDetail(vault: VaultWorld, event: AuditEvent): AuditEvent {
  const detail = vault.details.get(event.id);
  return detail ? { ...event, vault: detail } : event;
}

function handleAuditList(world: World, vault: VaultWorld, url: URL): Response {
  const actor = (url.searchParams.get('actor') ?? 'everyone') as AuditFilter['actor'];
  const kind = (url.searchParams.get('kind') ?? 'all') as never;
  const whoHandle = url.searchParams.get('who');
  const whoId = whoHandle ? resolvePrincipalIdByHandle(whoHandle) : null;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Number(limitRaw) : 100;
  const map = world.approvalByEventId();
  const enriched = world.events.map((e) => withVaultDetail(vault, enrichAuditEvent(e, map))).reverse();
  const filter = { actor, kind, whoId } as AuditFilter;
  const filtered = filterAuditEvents(enriched, filter, isAgent);
  const counts = countAuditKinds(enriched, filter, isAgent);
  return jsonResponse({ events: filtered.slice(0, limit), counts, before: null, hasMore: false }, 200);
}

function handleAuditGet(world: World, vault: VaultWorld, eventId: string): Response {
  const map = world.approvalByEventId();
  const found = world.events.find((e) => e.id === eventId);
  if (!found) return notFound(`No event ${eventId}`);
  return jsonResponse({ event: withVaultDetail(vault, enrichAuditEvent(found, map)) }, 200);
}

/** `AuditDisplayContext.principal()` over the fixture world (audit-search workstream, FX-12). */
function auditPrincipalInfo(id: string): AuditPrincipalInfo | undefined {
  const p = principal(id);
  if (!p) return undefined;
  return { kind: p.kind, name: p.name, shortName: shortNameOf(p) };
}

/** CSV of every event matching the current filter (`auditEndpoints.export`, FX-12). */
function handleAuditExport(world: World, vault: VaultWorld, url: URL): Response {
  const actor = (url.searchParams.get('actor') ?? 'everyone') as AuditFilter['actor'];
  const kind = (url.searchParams.get('kind') ?? 'all') as never;
  const whoHandle = url.searchParams.get('who');
  const whoId = whoHandle ? resolvePrincipalIdByHandle(whoHandle) : null;
  const map = world.approvalByEventId();
  const enriched = world.events.map((e) => withVaultDetail(vault, enrichAuditEvent(e, map))).reverse();
  const filtered = filterAuditEvents(enriched, { actor, kind, whoId } as AuditFilter, isAgent);
  const csv = auditCsv(filtered, { principal: auditPrincipalInfo, now: SEED_NOW, timeZone: burrow.timeZone });
  return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } });
}

/**
 * `search.ask`: the mock only answers the seeded VAT-rounding query deterministically
 * (ARCHITECTURE "Search"); any other query gets a `status: 'none'` answer (no card, FX-12).
 */
async function handleSearchAsk(req: Request): Promise<Response> {
  const body = (await req.json()) as { q: string };
  const q = body.q.trim();
  if (q === SEARCH_QUERY) return jsonResponse({ answer: searchAnswer }, 202);
  const none: SearchAnswer = {
    id: newId('answer'),
    burrowId: BURROW_ID,
    query: q,
    agentId: searchAnswer.agentId,
    status: 'none',
    text: '',
    citations: [],
    durationMs: null,
    actions: [],
    createdAt: SEED_NOW.toISOString(),
  };
  return jsonResponse({ answer: none }, 202);
}

function handleSearchGetAnswer(answerId: string): Response {
  if (answerId !== searchAnswer.id) return notFound(`No answer ${answerId}`);
  return jsonResponse({ answer: searchAnswer }, 200);
}

/** "Post to the branch room": posts the fixture answer's text, signed by Dusty, to the given conversation. */
async function handleSearchPostAnswer(world: World, answerId: string, req: Request): Promise<Response> {
  if (answerId !== searchAnswer.id) return notFound(`No answer ${answerId}`);
  const body = (await req.json()) as { conversationId: string };
  const { message: posted } = world.sendMessage(
    body.conversationId,
    { text: searchAnswer.text },
    searchAnswer.agentId,
  );
  return jsonResponse({ message: posted }, 201);
}

function handleSearchQuery(url: URL): Response {
  const q = url.searchParams.get('q') ?? '';
  const type = (url.searchParams.get('type') ?? 'all') as never;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Number(limitRaw) : 30;
  const results = SEARCH_RESULTS.filter((r) => type === 'all' || searchFilterOf(r.type) === type).slice(
    0,
    limit,
  );
  return jsonResponse(
    {
      query: q,
      results,
      counts: countSearchResults(SEARCH_RESULTS),
      answer: q === SEARCH_QUERY ? searchAnswer : null,
    },
    200,
  );
}

/**
 * Only the plan canvas (`canvas`) has a bound `Plan` and seeded comments in the fixture world; the
 * other 3 canvases (added so "Canvases · 4" is real, see `canvas.ts`) come back with an empty body so
 * `CanvasesScreen` can link to all four without 404s.
 */
function handleCanvasGet(world: World, slug: string): Response {
  const found = CANVASES.find((c) => c.slug === slug);
  if (!found) return notFound(`No canvas ${slug}`);
  const conv = world.conversations.get(found.conversationId ?? '');
  const isPlanCanvas = found.id === canvas.id;
  return jsonResponse(
    {
      canvas: found,
      conversationTitle: conv ? conversationLabel(conv) : null,
      plan: isPlanCanvas ? plan : null,
      comments: isPlanCanvas ? groupCommentThreads(CANVAS_COMMENTS) : [],
      presentIds: isPlanCanvas ? [mara.id, AGENT.id] : [],
      documentName: `canvas:${found.id}`,
    },
    200,
  );
}

function handleOnboardingGet(): Response {
  return jsonResponse(onboarding, 200);
}

function handleCanvasesList(world: World): Response {
  const canvases = CANVASES.map((c) => {
    const conv = world.conversations.get(c.conversationId ?? '');
    return { ...c, conversationTitle: conv ? conversationLabel(conv) : null };
  });
  return jsonResponse({ canvases }, 200);
}

/** Only `burrow` (Burrow HQ) exists in the fixture world, so any other slug is free. */
function handleSlugCheck(url: URL): Response {
  const name = url.searchParams.get('name') ?? '';
  const slug = slugify(name);
  const host = burrowAddress(slug);
  if (!isValidBurrowSlug(slug)) {
    return jsonResponse({ name, slug, host, available: false, reason: 'invalid' }, 200);
  }
  if (slug === burrow.slug) {
    return jsonResponse({ name, slug, host, available: false, reason: 'taken' }, 200);
  }
  return jsonResponse({ name, slug, host, available: true, reason: null }, 200);
}

/**
 * Forces quiet loading/error states (TODO 16.4) through the same fixture fetch used everywhere else,
 * so stories and tests can drive a screen's skeleton and error copy without a second mock.
 */
export interface FixtureFetchOptions {
  /** Delay before every response, in ms — enough for a loading skeleton to be observed in a test. */
  latencyMs?: number;
  /**
   * Endpoint ids (`AnyEndpoint['id']`, e.g. `'agent.get'`) that should 500 instead of serving fixture
   * data, for exercising a screen's error-with-retry state. A retried request after `failing` no longer
   * includes that id still fails (this is a fixed set, not a one-shot).
   */
  failing?: ReadonlySet<string> | readonly string[];
  /** Opt-in Vault entries the fixture world holds besides Mara's four (`vaultShopLogin`, `vaultSshDeployKey`). */
  vaultEntries?: readonly VaultEntryDetail[];
}

function serverError(message = 'Something went wrong on our end.'): Response {
  return jsonResponse({ error: { code: 'server_error', message } }, 500);
}

/** Builds a fetch-compatible function serving the mock world over `@whombat/core/contracts`. */
export function createFixtureFetch(options: FixtureFetchOptions = {}): typeof fetch {
  const world = createWorld();
  const feedback = createFeedbackWorld();
  const vault = createVaultWorld(options.vaultEntries);
  const memory = createMemoryWorld();
  const services = createServicesWorld();
  const skills = createSkillsWorld();
  const vaultContext = {
    append: (input: Parameters<World['appendWorldEvent']>[0]) => world.appendWorldEvent(input),
    agent: () => world.agent,
  };
  const failing = options.failing instanceof Set ? options.failing : new Set(options.failing ?? []);
  const latencyMs = options.latencyMs ?? 0;

  // `string | URL | Request`, not the DOM-only `RequestInfo | URL` alias (`RequestInfo` is itself just
  // `Request | string`): this file is imported directly (no compiled `.d.ts`, see the package's `exports`
  // map) by `apps/server`'s Node-only-`lib` `tsc` program via the `/fetch` subpath, which has `Request`/
  // `Response`/`RequestInit`/`fetch` as Node/undici globals (`@types/node`) but not the DOM-only
  // `RequestInfo` alias. Equivalent to `typeof fetch`'s own parameter type under either `lib`, so this
  // costs nothing under `packages/fixtures`' own DOM-lib tsconfig. See `docs/decisions/seed-wiring.md` SW-13.
  return async function fixtureFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));

    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url, 'http://fixtures.local');
    const path = stripBase(url.pathname, '/api/v1');
    if (path === null) return notFound(`No route for ${url.pathname}`);

    const matched = findMatch(path, req.method);
    if (!matched) return notFound(`No route for ${req.method} ${url.pathname}`);
    const { endpoint: ep, params } = matched;
    if (failing.has(ep.id)) return serverError();
    // One run (#1907) and one approval (#12) are fixtured; any other number is not found.
    if (
      ep.id.startsWith('runs.') &&
      params.number !== undefined &&
      Number(params.number) !== world.run.number
    ) {
      return notFound(`No run #${params.number}`);
    }
    if (
      ep.id.startsWith('approvals.') &&
      params.number !== undefined &&
      Number(params.number) !== world.approval.number
    ) {
      return notFound(`No approval #${params.number}`);
    }

    switch (ep.id) {
      case 'conversations.bootstrap':
        return handleBootstrap();
      case 'conversations.get':
        return handleConversationDetail(world, param(params, 'conversationId'));
      case 'conversations.list': {
        const kind = url.searchParams.get('kind');
        const list = CONVERSATIONS.filter((c) => !kind || c.kind === kind);
        return jsonResponse({ conversations: list.map(conversationSummary) }, 200);
      }
      case 'messages.list':
        return handleMessages(world, param(params, 'conversationId'), url);
      case 'messages.send': {
        // See the cast comment on `handleAgentUpdate` above re: `Request.json()`'s `Promise<unknown>` type
        // under Node/undici.
        const body = (await req.json()) as {
          text: string;
          threadRootId?: string;
          clientId?: string;
        };
        return jsonResponse(world.sendMessage(param(params, 'conversationId'), body, mara.id), 201);
      }
      case 'messages.get': {
        const messageId = param(params, 'messageId');
        const m = world.allMessages.get(messageId) ?? message(messageId);
        return m ? jsonResponse({ message: m }, 200) : notFound(`No message ${messageId}`);
      }
      case 'messages.thread':
        return handleThread(world, param(params, 'messageId'), url);
      case 'prs.list':
        return handlePrList(world);
      case 'prs.get':
        return handlePrGet(world);
      case 'prs.file':
        return handlePrFile(world, url.searchParams.get('path') ?? '');
      case 'prs.merge':
        return handlePrMerge(world);
      case 'runs.get':
        return handleRunGet(world);
      case 'runs.pause':
        return handleRunControl(world, 'pause');
      case 'runs.resume':
        return handleRunControl(world, 'resume');
      case 'runs.retry':
        return handleRunControl(world, 'retry');
      case 'runs.takeOver':
        return handleRunControl(world, 'take_over');
      case 'approvals.get':
        return handleApprovalGet(world);
      case 'approvals.decide':
        return handleApprovalDecide(world, req);
      case 'approvals.undo':
        return handleApprovalUndo(world);
      case 'agent.get':
        return handleAgentGet(world);
      case 'agent.update':
        return handleAgentUpdate(world, req);
      case 'agent.setKeys':
        return handleAgentSetKeys(world, req);
      // Commands always allowed (AC-42): none in the mock world.
      case 'agent.commandAllowances':
        return jsonResponse({ allowances: [] }, 200);
      case 'host.info':
        return jsonResponse(FIXTURE_HOST, 200);
      case 'spend.overview':
        return jsonResponse(spendOverview(), 200);
      case 'spend.week':
        return jsonResponse(spendWeek(), 200);
      case 'usage.list':
        return jsonResponse(usageList(), 200);
      case 'usage.refresh': {
        const { provider } = (await req.json()) as { provider: string };
        const usage = usageRefresh(provider);
        return usage ? jsonResponse({ usage }, 200) : notFound(`No ${provider} sign-in`);
      }
      case 'audit.list':
        return handleAuditList(world, vault, url);
      case 'audit.get':
        return handleAuditGet(world, vault, param(params, 'eventId'));
      case 'audit.export':
        return handleAuditExport(world, vault, url);
      case 'search.query':
        return handleSearchQuery(url);
      case 'search.ask':
        return handleSearchAsk(req);
      case 'search.getAnswer':
        return handleSearchGetAnswer(param(params, 'answerId'));
      case 'search.postAnswer':
        return handleSearchPostAnswer(world, param(params, 'answerId'), req);
      case 'canvases.get':
        return handleCanvasGet(world, param(params, 'slug'));
      // A canvas as Markdown (contracts 0.55, CT-303): the seeded text, as `canvas_read` reads it.
      case 'canvases.content': {
        const found = CANVASES.find((c) => c.slug === param(params, 'slug'));
        if (!found) return notFound(`No canvas ${param(params, 'slug')}`);
        return jsonResponse(
          { canvas: found, markdown: CANVAS_MARKDOWN[found.id] ?? '', updatedAt: found.updatedAt },
          200,
        );
      }
      // The needs-you count alone (CT-302): bootstrap's number.
      case 'work.needsYou':
        return jsonResponse({ count: sidebar().counts.needsYou }, 200);
      // Recorded deploys (CT-296): `deployments.ts`.
      case 'deployments.list':
        return jsonResponse(
          deploymentsPage({
            environment: url.searchParams.get('environment'),
            service: url.searchParams.get('service'),
            limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : null,
          }),
          200,
        );
      case 'deployments.environments':
        return jsonResponse(deploymentEnvironments(), 200);
      case 'onboarding.get':
        return handleOnboardingGet();
      case 'canvases.list':
        return handleCanvasesList(world);
      case 'burrows.slugCheck':
        return handleSlugCheck(url);
      // The agent's services (3.0, CT-1533): `services.ts`.
      case 'services.list':
        return jsonResponse(services.list(), 200);
      case 'services.stop': {
        const body = (await req.json()) as { id: string };
        const stopped = services.stop(body.id);
        return stopped ? jsonResponse(stopped, 200) : notFound(`No service ${body.id}`);
      }
      // The agent's schedules (RA-30): none in the mock world.
      case 'schedules.list':
        return jsonResponse({ schedules: [] }, 200);
      default: {
        return (
          (await handleMemory(memory, ep.id, params, url, req)) ??
          (await handleSkills(skills, ep.id, params, url, req)) ??
          (await handleVault(vault, vaultContext, ep.id, params, url, req)) ??
          (await handleFeedback(feedback, ep.id, params, req)) ??
          notFound(`${ep.id} is not implemented by createFixtureFetch()`)
        );
      }
    }
  };
}

const IMPLEMENTED = new Set([
  'conversations.bootstrap',
  'conversations.get',
  'conversations.list',
  'messages.list',
  'messages.send',
  'messages.get',
  'messages.thread',
  'prs.list',
  'prs.get',
  'prs.file',
  'prs.merge',
  'runs.get',
  'runs.pause',
  'runs.resume',
  'runs.retry',
  'runs.takeOver',
  'approvals.get',
  'approvals.decide',
  'approvals.undo',
  'agent.get',
  'agent.update',
  'agent.setKeys',
  'agent.commandAllowances',
  'host.info',
  'audit.list',
  'audit.get',
  'audit.export',
  'search.query',
  'search.ask',
  'search.getAnswer',
  'search.postAnswer',
  'canvases.get',
  'onboarding.get',
  'canvases.list',
  'burrows.slugCheck',
  // 3.0 (CT-1533): the agent's services (`services.ts`).
  ...SERVICES_ENDPOINT_IDS,
  // 0.125 (CT-1200…CT-1206): Mara's memory and the agent's notes (`memory.ts`).
  ...MEMORY_ENDPOINT_IDS,
  // 0.44 (RA-30): no schedules.
  'schedules.list',
  // 0.125 (CT-1210…CT-1216): Settings → Skills (`skills.ts`).
  ...SKILLS_ENDPOINT_IDS,
  // Whombat Feedback (docs/decisions/feedback.md): one integration, five reports (`feedback.ts`).
  ...FEEDBACK_ENDPOINT_IDS,
  // The Vault (docs/decisions/vault.md): Mara's four entries and the home network list (`vault.ts`).
  ...VAULT_ENDPOINT_IDS,
  // Spend (Whombat spend.md): 30 days of Dusty's turns (`spend.ts`).
  ...SPEND_ENDPOINT_IDS,
  // Subscription usage (contracts CT-153, CT-154): Mara's two sign-ins (`usage.ts`).
  ...USAGE_ENDPOINT_IDS,
  // Contracts 0.55: canvas content, the needs-you count and recorded deploys (`deployments.ts`).
  'canvases.content',
  'work.needsYou',
  ...DEPLOYMENT_ENDPOINT_IDS,
]);

/**
 * Prefers the match with fewer `:param` segments (e.g. the literal `/audit/export` over
 * `/audit/:eventId`) so static routes registered after a param route of the same shape and length
 * still win — `matchPath()` alone can't tell them apart. Audit-search workstream, needed once
 * `audit.export` joined `audit.get` in `IMPLEMENTED` (docs/decisions/audit-search.md).
 */
function findMatch(
  path: string,
  method: string,
): { endpoint: AnyEndpoint; params: Record<string, string> } | null {
  let best: { endpoint: AnyEndpoint; params: Record<string, string> } | null = null;
  let bestParamCount = Number.POSITIVE_INFINITY;
  for (const ep of API_ENDPOINTS) {
    if (!IMPLEMENTED.has(ep.id)) continue;
    if (ep.method !== method) continue;
    const params = matchPath(ep.path, path);
    if (!params) continue;
    const paramCount = ep.path.split('/').filter((seg) => seg.startsWith(':')).length;
    if (paramCount < bestParamCount) {
      best = { endpoint: ep, params };
      bestParamCount = paramCount;
      if (paramCount === 0) break;
    }
  }
  return best;
}
