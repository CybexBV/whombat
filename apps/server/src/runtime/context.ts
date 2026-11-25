/**
 * Builds the `DispatchContext` a runner receives on claim: the agent's persona and keys, the conversation
 * window (or thread), names for every principal, the run being controlled, answer-mode search results,
 * the workspace for coding work, a few burrow facts and a fresh per-dispatch agent token for `/mcp`.
 */
import {
  BrowserSite,
  DispatchContext,
  type DispatchContext as DispatchContextType,
  type GatewayDispatchContext,
  type Grant,
  type KEY_CATALOG,
  keyRows,
  MCP_PATH,
  type Message,
  PLAN_MAX_STEPS,
  type Plan,
  type PrincipalLite,
} from '@whombat/core';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { commandsContextFor, commandsTurn } from '../agent-commands/context';
import { grantedResultOf } from '../approvals/granted-result';
import { issueDispatchToken } from '../auth/agent-tokens';
import { approvedPushFor, dispatchInstructions, dispatchWorkspace } from '../automations/workspace';
import { browserContextFor, turnLoginsFor } from '../browser/context';
import { changeWindowOf } from '../care/window';
import { turnTopic } from '../chats/read';
import { readsRoom, threadedRoom } from '../chats/rooms';
import { turnRuntimeOf } from '../chats/runtime-rules';
import { loadBurrowRow } from '../commit/pipeline';
import { connectionsContextFor } from '../connections/context';
import { councilOfTurn } from '../council/context';
import {
  approvals,
  connections,
  dispatches,
  pullRequests,
  repos,
  runs,
  searchAnswers,
} from '../db/schema/index';
import { delegationOfTurn } from '../delegate/context';
import { deskContextPart } from '../desk/talk-mark';
import { agentBriefOf, withBrief } from '../domain/agent-brief';
import { linkOfConversation } from '../domain/links';
import { assessorBrowser } from '../feedback/browser';
import { type FeedbackDispatchParts, feedbackDispatchParts, feedbackHandoffPart } from '../feedback/dispatch';
import { outsidersFileIds } from '../files/access';
import { dispatchAttachments, dispatchFiles } from '../files/dispatch';
import { ghContextFor } from '../github/agent-gh-context';
import { undoRequestOf } from '../home/reports';
import { taskFinishedOf } from '../hosts/followed';
import { atMost } from '../lib/side-by-side';
import { iso, isoOrNull } from '../lib/time';
import { localModelDispatch } from '../local-model/check';
import { localModelKeyOf } from '../local-model/store';
import { lookContextOf } from '../looks/research';
import { aheadContextOf } from '../looks-ahead/turn';
import { agentNotesText } from '../memory/notes';
import { loadConversationRow } from '../read/conversations';
import { hydrateMessageCandidates, loadMessage, type MessageCandidate } from '../read/messages';
import {
  loadGrants,
  loadPrincipalRow,
  loadPrincipalRows,
  type PrincipalRow,
  toAgent,
} from '../read/principals';
import { searchResults } from '../read/search';
import { loadPlan, loadRun, toApproval } from '../read/work';
import { scheduleContextOf } from '../schedules/ticker';
import type { Services } from '../services';
import { personWordsFor, t3ThreadsOf } from '../t3code/follow';
import { t3HandoffsOf } from '../t3code/handoffs';
import { trackerDispatchContext } from '../trackers/access';
import { vaultContextFor } from '../vault/context';
import { webSearchDispatch } from '../web-search/store';
import { contextThreadCandidates, contextWindowCandidates } from './context-selection';
import { notifyContextOf } from './job-notify';
import { forOutsiders, forPersonTurn, hasOutsidersMessages } from './outsiders-view';
import { dispatchPerson, outsidersTurn } from './person';
import { sessionSince, turnSession } from './sessions';

export type DispatchRow = typeof dispatches.$inferSelect;

/**
 * How many recent top-level messages a new Hermes session's window carries (HE-40); a resumed session gets only what is
 * new since its last turn. Attachment access for a dispatch (runner fetch, `read_attachment`) is bounded by the same
 * limit, so every attachment the context lists can be fetched and nothing older can.
 */
export const WINDOW_SIZE = 30;
/** The most replies of a thread a new session sees (the latest; the thread's first message always). */
export const THREAD_REPLIES = 60;

/**
 * Whether a person approved the `start_run` that created this run (the agent's branch key asked; bp-automations.md
 * BP-C29, BP-C37): an approved `start_run` of the same agent, from the turn that started the run (`runs.dispatch_id`),
 * for the same repository and branch, whose execution ran. The approval covers exactly that run's branch.
 */
export async function runStartApproved(db: Services['db'], runId: string, repo: string): Promise<boolean> {
  const [r] = await db
    .select({
      burrowId: runs.burrowId,
      agentId: runs.agentId,
      dispatchId: runs.dispatchId,
      branch: runs.branch,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  if (!r?.dispatchId) return false;
  const [approved] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.burrowId, r.burrowId),
        eq(approvals.requesterId, r.agentId),
        eq(approvals.state, 'approved'),
        sql`${approvals.command}->>'name' = 'start_run'`,
        sql`${approvals.command}->'input'->>'dispatchId' = ${r.dispatchId}`,
        sql`${approvals.command}->'input'->>'repo' = ${repo}`,
        sql`${approvals.command}->'input'->>'branch' = ${r.branch}`,
        sql`${approvals.execution}->>'state' in ('running', 'succeeded')`,
      ),
    )
    .limit(1);
  return !!approved;
}

/** Search results offered to an answer-mode dispatch. */
export const ANSWER_RESULTS = 20;

export function toDispatch(row: DispatchRow): DispatchContextType['dispatch'] {
  return {
    id: row.id,
    burrowId: row.burrowId,
    agentId: row.agentId,
    trigger: row.trigger,
    mode: row.mode,
    conversationId: row.conversationId,
    messageId: row.messageId,
    threadRootId: row.threadRootId,
    runId: row.runId,
    state: row.state,
    providerSessionId: row.providerSessionId,
    runnerId: row.runnerId,
    attempts: row.attempts,
    error: row.error,
    createdAt: iso(row.createdAt),
    claimedAt: isoOrNull(row.claimedAt),
    finishedAt: isoOrNull(row.finishedAt),
    postedAt: isoOrNull(row.postedAt),
  };
}

/** How many of a claim's reads run at once: the pool holds ten connections, and commits need some of them meanwhile. */
const CLAIM_READS_AT_ONCE = 4;

export async function buildDispatchContext(
  services: Services,
  row: DispatchRow,
  /** The AI gateway this turn goes through (ai-gateway.md AIG-07), decided at claim; null: its own sign-in. */
  route: { gateway?: GatewayDispatchContext | null } = {},
): Promise<DispatchContextType> {
  const db = services.db;
  const outside = outsidersTurn(row);
  const now = services.clock();
  // The reads of a turn's claim go side by side on the pool (each its own query on its own connection; nothing here
  // runs in a transaction): only those that need another's answer wait for it, and what writes keeps its place. A few
  // at a time, so one claim never takes the whole pool and the commits behind it wait.
  const side = atMost(CLAIM_READS_AT_ONCE);
  const [agentRow, principalRows, burrowRow, grants, conversation, person, localOriginRows] =
    await Promise.all([
      side(() => loadPrincipalRow(db, row.agentId)),
      side(() => loadPrincipalRows(db, row.burrowId)),
      side(() => loadBurrowRow(db, row.burrowId)),
      side(() => loadGrants(db, row.agentId)),
      side(() => loadConversationRow(db, row.conversationId)),
      // Who the turn is for: the person, or nobody in an outsiders' turn.
      side(() => dispatchPerson(db, row)),
      // A repo created on the Whombat is fetched from and pushed to its origin on this machine.
      side(async () =>
        db
          .select({ fullName: repos.fullName, originPath: repos.originPath })
          .from(repos)
          .where(and(eq(repos.burrowId, row.burrowId), eq(repos.source, 'local'))),
      ),
    ]);
  if (agentRow?.kind !== 'agent') throw new Error(`Dispatch ${row.id}: ${row.agentId} is not an agent`);
  const agent = toAgent(agentRow);
  if (!burrowRow) throw new Error(`Dispatch ${row.id}: unknown burrow`);

  // Persona: keys by tier with their labels.
  const keys = { can: [] as KeyRef[], ask: [] as KeyRef[], cannot: [] as KeyRef[] };
  for (const r of keyRows(grants)) keys[r.tier].push({ id: r.keyId, label: r.label });

  if (!conversation) throw new Error(`Dispatch ${row.id}: unknown conversation`);
  const localOrigins = new Map(
    localOriginRows.flatMap((r) => (r.originPath ? [[r.fullName, r.originPath] as const] : [])),
  );
  const cloneUrl = (fullName: string) =>
    localOrigins.get(fullName) ??
    services.github.adapter?.remoteUrl(fullName) ??
    `https://github.com/${fullName}.git`;

  // A Whombat Feedback assessment (feedback.md FB-21): only the report's thread, the report as data, a read-only
  // checkout or none, no memory, skills or personal context. Not the report's current assessment: no context. It starts
  // the assessment's clock, so it goes first, alone.
  const assessing: FeedbackDispatchParts | null =
    row.trigger === 'feedback' ? await feedbackDispatchParts(services, row, cloneUrl) : null;

  // An outsiders' turn (OP-17, OP-S72) reads its request and its thread, never the rest of the room it works in,
  // whatever kind of room that is: what strangers sent mustn't pull the room's other messages into its answer. In the
  // person's Chat and Feedback every thread is a conversation of its own, so a turn there doesn't read the room either:
  // a new thread starts fresh (docs/decisions/chat-channel.md).
  const roomWindow = person !== null && readsRoom(conversation, person) && !threadedRoom(conversation);
  let trigger: DispatchContextType['trigger'];
  let window: DispatchContextType['window'];
  let thread: DispatchContextType['thread'];
  let session: DispatchContextType['session'] = null;
  let runnerRow = row;
  if (assessing) {
    trigger = assessing.trigger;
    window = [];
    thread = assessing.thread;
  } else {
    const [message, candidates, fullThread] = await Promise.all([
      row.messageId ? loadMessage(db, row.messageId, agent.id) : undefined,
      roomWindow
        ? contextWindowCandidates(db, conversation.id, WINDOW_SIZE, conversation.roomClearedAt)
        : ([] as MessageCandidate[]),
      // A Looks ahead check works in a thread that is there only once it found something (looks-ahead.md).
      row.threadRootId && row.trigger !== 'ahead'
        ? contextThreadCandidates(db, agent.id, row.threadRootId, THREAD_REPLIES)
        : null,
    ]);
    trigger = message ?? null;
    // The thread's Hermes session (HE-18, HE-40): a resumed one has the conversation already and gets only what is new
    // since its last turn — the request always — a new one the window.
    const fresh =
      !outside &&
      (row.threadRootId || roomWindow) &&
      (await hasOutsidersMessages(db, row.conversationId, row.threadRootId));
    if (fresh) runnerRow = { ...row, providerSessionId: null };
    const since = await sessionSince(db, runnerRow, trigger ? new Date(trigger.createdAt) : null);
    const shown = (m: MessageCandidate) =>
      m.id === trigger?.id ||
      !since ||
      (m.source.createdAt > since.before &&
        !(m.source.authorId === agent.id && since.ownUntil && m.source.createdAt <= since.ownUntil));
    const rootId = fullThread?.root.id ?? null;
    // The thread's first message is the thread's (its root), unless it is the request (a thread's opening turn).
    const selectedWindow = candidates.filter((m) => m.id === trigger?.id || (m.id !== rootId && shown(m)));
    const selectedReplies = fullThread ? fullThread.replies.filter(shown) : [];
    // Only now resolve the selected messages' live cards, reactions and files, through the same viewer-specific reader
    // as public reads.
    const selected = await hydrateMessageCandidates(db, [...selectedWindow, ...selectedReplies], agent.id);
    window = selected.slice(0, selectedWindow.length);
    thread = fullThread ? { root: fullThread.root, replies: selected.slice(selectedWindow.length) } : null;
    session = turnSession(runnerRow, since);
  }

  // An automation's request reads one line in the conversation; the agent gets its step's instructions (CNR-08) —
  // wherever it sees that message: the request, and the thread or window the request may point to (PE-08).
  if (trigger && row.trigger === 'automation' && trigger.id === row.messageId) {
    const instructions = await dispatchInstructions(db, row.id);
    if (instructions) {
      const full = `@${agent.name} ${instructions}`;
      const id = trigger.id;
      const withFull = <M extends { id: string; text: string }>(m: M): M =>
        m.id === id ? { ...m, text: full } : m;
      trigger = withFull(trigger);
      window = window.map(withFull);
      if (thread) thread = { ...thread, root: withFull(thread.root), replies: thread.replies.map(withFull) };
    }
  } else if (trigger && trigger.id === row.messageId) {
    // A message Whombat posted to wake the agent reads as one plain line in the chat; the details are the agent's
    // (docs/decisions/concise-replies.md), wherever its turn sees that message.
    const brief = await agentBriefOf(db, row.burrowId, trigger.id, agent.id);
    if (brief) {
      const full = withBrief(trigger.text, brief);
      const id = trigger.id;
      const withFull = <M extends { id: string; text: string }>(m: M): M =>
        m.id === id ? { ...m, text: full } : m;
      trigger = withFull(trigger);
      window = window.map(withFull);
      if (thread) thread = { ...thread, root: withFull(thread.root), replies: thread.replies.map(withFull) };
    }
  }

  // Use the same view as read_conversation, including what the turn may learn about the messages’ files.
  const shown = [
    ...(trigger ? [trigger] : []),
    ...window,
    ...(thread ? [thread.root, ...thread.replies] : []),
  ];
  const projected = outside
    ? await forOutsiders(db, shown, {
        files: await outsidersFileIds(db, row),
        reportRootId: assessing ? row.threadRootId : null,
      })
    : await forPersonTurn(db, shown);
  let at = 0;
  if (trigger) trigger = projected[at++] as Message;
  window = projected.slice(at, at + window.length);
  at += window.length;
  if (thread) thread = { root: projected[at++] as Message, replies: projected.slice(at) };

  // Whombat's own signers are `system` (one-agent.md OA-17).
  const shownAuthors = new Set([
    row.agentId,
    trigger?.authorId,
    ...window.map((m) => m.authorId),
    ...(thread ? [thread.root.authorId, ...thread.replies.map((m) => m.authorId)] : []),
  ]);
  const principals: PrincipalLite[] = principalRows
    .filter((p) => !outside || shownAuthors.has(p.id))
    .map((p) => ({
      id: p.id,
      kind: p.kind === 'agent' && p.system ? 'system' : p.kind,
      name: p.name,
      handle: outside ? '' : p.handle,
      title: outside ? null : (p.title ?? null),
    }));

  const runPart = side(async () => {
    const run = !outside && row.runId ? ((await loadRun(db, row.runId)) ?? null) : null;
    // Whombat woke the agent because its last turn left the run live with nothing to wait on.
    const [stall] =
      run && row.trigger === 'run_control'
        ? await db.select({ at: runs.stalledAt }).from(runs).where(eq(runs.id, run.id))
        : [];
    return { run, stalledRun: Boolean(stall?.at && row.createdAt >= stall.at) };
  });
  const approvalPart = side(async () => {
    // The approval this turn carries on after.
    const grantedApproval = outside ? null : await grantedApprovalOf(db, row);
    // What the approved call returned, for the agent to tell in its own words.
    const grantedResult =
      grantedApproval && row.approvalId ? await grantedResultOf(db, services.custody, row.approvalId) : null;
    return { grantedApproval, grantedResult };
  });
  // Coding work: an assessment's read-only checkout (or none), else `turnWorkspace`; the agent's gh goes through
  // Whombat: its repositories and the one a command names by default.
  const workspacePart = (async () => {
    if (assessing) return { workspace: assessing.workspace, gh: null };
    // Waits for those two outside the gate: holding a place while it waits could stop it.
    const [{ run }, { grantedApproval }] = await Promise.all([runPart, approvalPart]);
    return side(async () => {
      const workspace = await turnWorkspace(db, row, { conversation, run, grantedApproval, cloneUrl });
      return { workspace, gh: await ghContextFor(services, row, workspace) };
    });
  })();
  // The browser: an assessor's only on the reported website, never with a login (an outsider's report starts that
  // turn); else the agent's, with the logins it holds keys to.
  const browserPart = side(async () => {
    if (assessing) {
      const access = await assessorBrowser(services, row);
      // The sites an assessment's browser may open: domains only (an address or a bare name isn't one it keeps to).
      const sites = (access?.sites ?? []).filter((x) => BrowserSite.safeParse(x).success);
      return { browser: sites.length ? { sites } : null, logins: [] };
    }
    const browser = await browserContextFor(services, agentRow, row, grants);
    return { browser, logins: await turnLoginsFor(services, agentRow, row, browser, person) };
  });
  // The turn's runtime: its Chat thread's choice, else the agent's.
  const turnRuntime = turnRuntimeOf(agent.runtime, row.runtime);

  const connectionsPartOfTurn = side(() => connectionsPart(db, agentRow, grants, row, assessing !== null));
  // A tracker report can follow its own hand-offs on the T3 Code connections it may use.
  const t3HandoffsPart = (async () => {
    if (
      outside &&
      !(await connectionsPartOfTurn).connections?.some(
        (c) => c.catalogId === 't3code' && c.status === 'active',
      )
    )
      return null;
    return side(() => t3HandoffsOf(db, row, outside));
  })();

  const [
    { run, stalledRun },
    { grantedApproval, grantedResult },
    { workspace, gh },
    { browser, logins },
    feedbackHandoff,
    planStep,
    searchCtx,
    retry,
    taskFinished,
    t3Threads,
    t3Handoffs,
    council,
    delegation,
    undoRequest,
    look,
    ahead,
    facts,
    topic,
    link,
    onBehalfOf,
    attachments,
    files,
    notes,
    vault,
    connectionsOfTurn,
    commands,
    localModel,
    schedule,
  ] = await Promise.all([
    runPart,
    approvalPart,
    workspacePart,
    browserPart,
    // The developer agent asked by an approved Feedback handoff: the report and the assessment as
    // data next to Whombat's fixed handoff message.
    outside ? null : side(async () => feedbackHandoffPart(db, row, trigger)),
    outside ? null : side(async () => planStepContext(db, row)),
    outside ? null : side(async () => searchContext(services, row, burrowRow, now)),
    // The failed turn a retry tries again.
    outside ? null : side(async () => retryOriginOf(db, row)),
    // The server tasks it started that ended, for it to tell the person how they went.
    outside ? null : side(async () => taskFinishedOf(db, row)),
    // The T3 Code threads it handed work to that finished or ask something.
    outside ? null : side(async () => t3ThreadsOf(db, row)),
    // The T3 Code threads this thread already handed work to: where a follow-up goes.
    t3HandoffsPart,
    outside ? null : side(async () => councilOfTurn(db, row)),
    // Tasks it handed to T3 Code that ended, or the delegation card of the thread the person writes in (delegate.md).
    outside ? null : side(async () => delegationOfTurn(db, row, now)),
    // A person's Undo of a change this agent reported, with its own note.
    outside ? null : side(async () => undoRequestOf(db, services, row, trigger)),
    // What needs a look, or the step the person let it take on one.
    outside ? null : side(async () => lookContextOf(db, row)),
    // Something on the person's calendar or inbox to check ahead, or what such a check told them (looks-ahead.md).
    outside ? null : side(async () => aheadContextOf(services, db, row)),
    outside ? [] : side(async () => burrowFacts(services, row.burrowId, principalRows)),
    // A task chat tells the turn its title and what it is about (“This chat is about the server pve-02.”), a person's
    // Chat whose it is and what the thread is about; for the agent only.
    outside ? null : side(async () => turnTopic(db, conversation, row.threadRootId)),
    outside
      ? ({ type: 'chat', id: conversation.id } as const)
      : side(async () => linkOfConversation(db, conversation)),
    outside ? null : side(async () => onBehalfOfContext(db, person, principals)),
    side(async () =>
      dispatchAttachments(db, row, WINDOW_SIZE, [
        ...(trigger ? [trigger] : []),
        ...window,
        ...(thread ? [thread.root, ...thread.replies] : []),
      ]),
    ),
    // The Files of this conversation only; none in an assessment or a search answer.
    assessing ? null : side(async () => dispatchFiles(db, row)),
    // The person's notes for the agent: never in an outsiders' turn.
    assessing || !person ? null : side(async () => agentNotesText(db, row.burrowId)),
    // The Vault entries it holds keys to, as this turn may use them; never a secret.
    assessing
      ? null
      : side(async () => vaultContextFor(db, agentRow.id, row, { commands: commandsTurn(agentRow, row) })),
    // The connected services it can use in this turn, one line each; none in an
    // assessment, a search answer or a reflection, and absent when there are none (older runners read it as none).
    connectionsPartOfTurn,
    // The guard's and the commands' network facts: production servers, home networks, the local network switch. Null in
    // turns that run no commands, outsiders' among them.
    side(async () => commandsContextFor(services, agentRow, row)),
    // The model on the person's network with its key, exactly when the turn runs on `local`: the model the thread or
    // the agent names, else the burrow's own.
    turnRuntime.provider === 'local'
      ? side(async () =>
          localModelDispatch(
            services,
            burrowRow.localModel,
            localModelKeyOf(services.custody, burrowRow),
            turnRuntime.model,
          ),
        )
      : null,
    // A turn the agent scheduled for itself: its prompt, when, runs and next run.
    outside ? null : side(async () => scheduleContextOf(db, row)),
  ]);
  // What a background job of the agent said, from its post (resourceful-agents.md RA-31).
  const notify = outside ? null : notifyContextOf(row, trigger);
  // Whether this turn's messages to T3 Code get what the person wrote, so the preface can say the brief needn't.
  const t3PersonWords =
    !outside && connectionsOfTurn.connections?.some((c) => c.catalogId === 't3code')
      ? (await personWordsFor(db, { agentId: agentRow.id, dispatch: row, reportTurn: false })) !== null
      : false;
  // The turn's token, and a run's tracker report: which report, and for a step that
  // asks, the organization access the tracker granted now (or why not). Both write, so they come after the reads.
  const token = await issueDispatchToken(services, row.id);
  const tracker = await trackerPart(services, row);
  const context: DispatchContextType = {
    dispatch: toDispatch(runnerRow),
    burrow: { id: burrowRow.id, slug: burrowRow.slug, name: burrowRow.name, timeZone: burrowRow.timeZone },
    agent: {
      id: agent.id,
      name: agent.name,
      face: agent.face,
      handle: agent.handle,
      // A turn in a Chat thread with a choice runs on it: provider, model, effort and fast (chat-runtime.md CR-02,
      // chat-runtime-server.md CR-S03); everything else stays the agent's.
      runtime: turnRuntime,
      keys,
    },
    conversation: {
      id: conversation.id,
      kind: conversation.kind,
      title: outside ? '' : conversation.title,
      topic: outside ? '' : (topic ?? conversation.topic),
      link,
    },
    trigger,
    window,
    thread,
    principals,
    run,
    ...(stalledRun ? { stalledRun } : {}),
    planStep,
    search: searchCtx,
    workspace,
    facts,
    // An outsiders' turn (one-person.md OP-17): the runner gives it a profile of its own, without the person's things.
    outside,
    onBehalfOf,
    attachments,
    files,
    // The thread's Hermes session (HE-40).
    session,
    notes,
    vault,
    ...connectionsOfTurn,
    commands,
    gh,
    // The AI gateway this turn's Claude Code or Codex traffic goes through (ai-gateway.md AIG-07); null: its own sign-in.
    gateway: route.gateway ?? null,
    localModel,
    // The person's Brave Search key for Hermes's `web_search`: their own turns only, never an assessment's or an
    // outsiders' turn.
    // A Looks ahead check gets it too, as any of the person's turns (its policy blocks Hermes's `web_search`, and in the
    // person's pod a turn without the key would take it from the turns beside it).
    webSearch: webSearchDispatch(services.custody, burrowRow, !assessing && !outsidersTurn(row)),
    browser,
    logins,
    ...(assessing ? { feedback: assessing.feedback } : {}),
    ...(feedbackHandoff ? { feedbackHandoff } : {}),
    ...tracker,
    ...(grantedApproval ? { grantedApproval } : {}),
    ...(grantedResult ? { grantedResult } : {}),
    ...(retry ? { retry } : {}),
    ...(notify ? { notify } : {}),
    ...(taskFinished ? { taskFinished } : {}),
    ...(t3Threads ? { t3Threads } : {}),
    ...(t3Handoffs ? { t3Handoffs } : {}),
    ...(t3PersonWords ? { t3PersonWords } : {}),
    ...(council ? { council } : {}),
    ...(delegation ? { delegation } : {}),
    ...(undoRequest ? { undoRequest } : {}),
    ...(look ? { look } : {}),
    ...(ahead ? { ahead } : {}),
    // The quiet hours for changes (care-plan.md): when the person's changes that can wait happen. Not in outsiders' turns.
    ...(person ? { changeWindow: changeWindowOf(burrowRow) } : {}),
    // A question asked at the desk screen, spoken or typed there (desk-display-talk.md DK-T05): the runner asks for an
    // answer that reads well aloud; asked from a server's own screen, it also names that server (DK-85, DK-S89).
    ...(outside ? {} : deskContextPart(row, trigger, services)),
    schedule,
    agentToken: { token: token.token, expiresAt: iso(token.expiresAt) },
    mcpPath: MCP_PATH,
    now: iso(now),
  };
  return services.config.NODE_ENV === 'production' ? context : DispatchContext.parse(context);
}

/** An answer-mode turn's search results, as the person who asked may see them: every receipt must be openable by them. */
async function searchContext(
  services: Services,
  row: DispatchRow,
  burrowRow: NonNullable<Awaited<ReturnType<typeof loadBurrowRow>>>,
  now: Date,
): Promise<DispatchContextType['search']> {
  if (!row.search) return null;
  const db = services.db;
  const [answer] = await db.select().from(searchAnswers).where(eq(searchAnswers.id, row.search.answerId));
  const asker = answer ? await loadPrincipalRow(db, answer.askedById) : undefined;
  const results = asker
    ? await searchResults(
        db,
        asker,
        burrowRow,
        { q: row.search.query, type: 'all', limit: ANSWER_RESULTS, log: services.log },
        now,
      )
    : [];
  return { query: row.search.query, answerId: row.search.answerId, results };
}

/** `DispatchContext.tracker` of an automation's turn on a tracker report (TA-09, TA-10); nothing for any other turn. */
async function trackerPart(
  services: Services,
  row: DispatchRow,
): Promise<Pick<DispatchContextType, 'tracker'>> {
  if (row.trigger !== 'automation') return {};
  const tracker = await trackerDispatchContext(services, row.id);
  return tracker ? { tracker } : {};
}

/**
 * The checkout a turn works in (`DispatchContext.workspace`): the run's branch, else an automation step's checkout, else
 * the branch a person just allowed this agent to push, else the branch of the branch room the agent was asked in. Only
 * repos switched on for agents get one. `start_run` asks it too: a run started in a turn without a checkout
 * of its branch goes on in a run turn that has one (docs/decisions/run-checkout.md RC-01).
 */
export async function turnWorkspace(
  db: Services['db'],
  row: DispatchRow,
  parts: {
    conversation: Pick<
      NonNullable<Awaited<ReturnType<typeof loadConversationRow>>>,
      'id' | 'kind' | 'repoId'
    >;
    run: Pick<
      NonNullable<Awaited<ReturnType<typeof loadRun>>>,
      'id' | 'repoId' | 'branch' | 'prNumber'
    > | null;
    grantedApproval: DispatchContextType['grantedApproval'];
    cloneUrl: (fullName: string) => string;
  },
): Promise<DispatchContextType['workspace']> {
  const { conversation, run, grantedApproval, cloneUrl } = parts;
  let workspace: DispatchContextType['workspace'] = null;
  if (grantedApproval?.action.type === 'push_shared_branch') {
    // A push approval grants exactly its saved commit, including when the continuation belongs to a run.
    // Its checkout and keys take precedence over the run's earlier permission to write the branch.
    const push = grantedApproval.action.params;
    const [repo] = await db
      .select()
      .from(repos)
      .where(and(eq(repos.burrowId, row.burrowId), eq(repos.fullName, push.repo)));
    if (repo?.enabled) {
      const [pr] = await db
        .select({ base: pullRequests.baseBranch, headSha: pullRequests.headSha })
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repoId, repo.id),
            eq(pullRequests.branch, push.branch),
            eq(pullRequests.state, 'open'),
          ),
        );
      workspace = {
        repo: repo.fullName,
        branch: push.branch,
        baseBranch: pr?.base ?? repo.defaultBranch,
        defaultBranch: repo.defaultBranch,
        cloneUrl: cloneUrl(repo.fullName),
        access: 'write',
        writeApproved: false,
        headSha: knownHead(pr?.headSha),
      };
    }
  } else if (run?.repoId) {
    const [repo] = await db.select().from(repos).where(eq(repos.id, run.repoId));
    if (repo?.enabled) {
      const [pr] = run.prNumber
        ? await db
            .select({
              base: pullRequests.baseBranch,
              headSha: pullRequests.headSha,
              branch: pullRequests.branch,
            })
            .from(pullRequests)
            .where(and(eq(pullRequests.repoId, repo.id), eq(pullRequests.number, run.prNumber)))
        : [];
      workspace = {
        repo: repo.fullName,
        branch: run.branch,
        baseBranch: pr?.base ?? repo.defaultBranch,
        defaultBranch: repo.defaultBranch,
        cloneUrl: cloneUrl(repo.fullName),
        access: 'write',
        // A person approved starting this run on its branch (its key asked, BP-C29): its turns may write there.
        writeApproved: await runStartApproved(db, run.id, repo.fullName),
        headSha: pr?.branch === run.branch ? knownHead(pr.headSha) : null,
      };
    }
  } else if (row.trigger === 'automation') {
    // An automation's coding step (bp-automations.md BP-C26): the checkout its step rendered, while the repo is
    // still switched on for agents. `read` keeps the turn read-only whatever the agent's keys say.
    const ws = await dispatchWorkspace(db, row.id);
    if (ws) {
      const [repo] = await db
        .select()
        .from(repos)
        .where(and(eq(repos.burrowId, row.burrowId), eq(repos.fullName, ws.repo)));
      if (repo?.enabled)
        workspace = {
          repo: repo.fullName,
          branch: ws.branch,
          baseBranch: ws.baseBranch,
          defaultBranch: repo.defaultBranch,
          cloneUrl: cloneUrl(repo.fullName),
          access: ws.access,
          // A person approved this step's work on the branch (its key asked): the same approval its push runs under.
          writeApproved:
            ws.access === 'write' && (await approvedPushFor(db, row.id, repo.fullName, ws.branch)) !== null,
        };
    }
  } else if (conversation.kind === 'branch' && conversation.repoId) {
    const [room] = await db
      .select({ pr: pullRequests, repo: repos })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(and(eq(pullRequests.conversationId, conversation.id), eq(pullRequests.state, 'open')));
    if (room?.repo.enabled)
      workspace = {
        repo: room.repo.fullName,
        branch: room.pr.branch,
        baseBranch: room.pr.baseBranch,
        defaultBranch: room.repo.defaultBranch,
        cloneUrl: cloneUrl(room.repo.fullName),
        access: 'write',
        writeApproved: false,
        headSha: knownHead(room.pr.headSha),
      };
  }

  return workspace;
}

/**
 * The head the server knows for a checkout's branch (`DispatchContext.workspace.headSha`, turn-efficiency.md TE-10): its
 * pull request's head as the poller last read it, when it is a full sha. The runner skips fetching from GitHub when its
 * copy of the branch is already there.
 */
function knownHead(sha: string | null | undefined): string | null {
  return sha && /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(sha) ? sha.toLowerCase() : null;
}

/**
 * The checkout a live dispatch's context gives it (`turnWorkspace`), for what is decided outside the context: its `gh`
 * (AGH-12) and the tools its turn is served (prompt-efficiency.md PE-05). A Feedback assessment's read-only checkout is
 * its own, never this.
 */
export async function dispatchCheckout(
  db: Services['db'],
  row: DispatchRow,
): Promise<DispatchContextType['workspace']> {
  if (row.trigger === 'feedback') return null;
  const conversation = await loadConversationRow(db, row.conversationId);
  if (!conversation) return null;
  const run = row.runId ? ((await loadRun(db, row.runId)) ?? null) : null;
  return turnWorkspace(db, row, {
    conversation,
    run,
    grantedApproval: await grantedApprovalOf(db, row),
    // Only the repo, branch and access matter here.
    cloneUrl: () => '',
  });
}

/**
 * The approval a turn carries on after (EA-07): the agent's own request, approved (running or done). A declined or
 * undone one is not handed over.
 */
export async function grantedApprovalOf(
  db: Services['db'],
  row: DispatchRow,
): Promise<DispatchContextType['grantedApproval']> {
  if (!row.approvalId) return null;
  const [approval] = await db.select().from(approvals).where(eq(approvals.id, row.approvalId));
  if (!approval || approval.requesterId !== row.agentId || approval.state !== 'approved') return null;
  return toApproval(approval);
}

/** A retry's failed turn and why it failed (EA-09): the agent knows it is trying again. */
async function retryOriginOf(db: Services['db'], row: DispatchRow): Promise<DispatchContextType['retry']> {
  if (!row.retryOfId) return null;
  const [failed] = await db
    .select({ id: dispatches.id, failure: dispatches.failure })
    .from(dispatches)
    .where(eq(dispatches.id, row.retryOfId));
  if (!failed?.failure) return null;
  return { dispatchId: failed.id, code: failed.failure.code, reason: failed.failure.reason };
}

/**
 * The plan step this turn was handed (work-supervision WS-04): the plan's title, the step and the other steps as
 * “n. title · state”, while the plan is still in the turn's room.
 */
async function planStepContext(
  db: Services['db'],
  row: DispatchRow,
): Promise<DispatchContextType['planStep']> {
  if (!row.planId || !row.planStepId) return null;
  const plan = await loadPlan(db, row.planId);
  if (!plan || plan.conversationId !== row.conversationId) return null;
  const index = plan.steps.findIndex((s) => s.id === row.planStepId);
  const step = plan.steps[index];
  if (!step) return null;
  return {
    planId: plan.id,
    stepId: step.id,
    planTitle: plan.title,
    position: index + 1,
    title: step.title,
    outline: planOutline(plan),
  };
}

/** The plan's steps as “n. title · state” (a plan is the agent's own work: no owners, one-agent.md OA-14). */
function planOutline(plan: Pick<Plan, 'steps'>): string[] {
  return plan.steps.slice(0, PLAN_MAX_STEPS).map((s, i) => `${i + 1}. ${s.title} · ${s.stateLabel}`);
}

/** `DispatchContext.connections` when the agent can see any (CX-35). */
async function connectionsPart(
  db: Services['db'],
  agentRow: PrincipalRow,
  grants: readonly Grant[],
  row: DispatchRow,
  assessing: boolean,
): Promise<Pick<DispatchContextType, 'connections'>> {
  if (assessing) return {};
  const connections = await connectionsContextFor(db, agentRow.id, row, { agentRow, grants });
  return connections.length ? { connections } : {};
}

/**
 * The person and the accounts of theirs the turn may use (one-person.md OP-S51): their active connections, with their
 * address and services. Addresses only; tokens never leave the server. Null for an outsiders' turn.
 */
async function onBehalfOfContext(
  db: Services['db'],
  person: PrincipalRow | null,
  principals: readonly PrincipalLite[],
): Promise<DispatchContextType['onBehalfOf']> {
  const lite = person ? principals.find((p) => p.id === person.id) : undefined;
  if (!person || !lite || !person.accountId) return null;
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.accountId, person.accountId), eq(connections.status, 'active')))
    .orderBy(asc(connections.createdAt));
  return {
    person: lite,
    connections: rows.map((c) => ({ provider: c.provider, email: c.email, services: [...c.services] })),
  };
}

interface KeyRef {
  id: keyof typeof KEY_CATALOG;
  label: string;
}

/** The burrow's facts name at most this many repositories, the most recently pushed; the rest are counted. */
const REPOS_NAMED_MAX = 20;

/** Short facts for the system prompt: who is who (the burrow's people; one agent, OA-01) and which repos it may touch. */
async function burrowFacts(
  services: Services,
  burrowId: string,
  principals: Awaited<ReturnType<typeof loadPrincipalRows>>,
): Promise<string[]> {
  const facts: string[] = [];
  // Who is here: the person (one-person.md OP-S02). Person rows without an account are history for the signed events.
  const people = principals.filter((p) => p.kind === 'person' && p.accountId !== null);
  if (people.length) {
    facts.push(`People: ${people.map((p) => `${p.name}${p.title ? ` (${p.title})` : ''}`).join('; ')}.`);
  }
  // Every repository the GitHub account owns is here (agent-repos.md AGR-08), so only the most recently pushed are named.
  const on = await services.db
    .select({ fullName: repos.fullName, source: repos.source })
    .from(repos)
    .where(and(eq(repos.burrowId, burrowId), eq(repos.enabled, true)))
    .orderBy(sql`${repos.pushedAt} desc nulls last`, asc(repos.position));
  const more = on.length - REPOS_NAMED_MAX;
  facts.push(
    on.length
      ? `Repositories you work in: ${on
          .slice(0, REPOS_NAMED_MAX)
          .map((r) => r.fullName)
          .join(', ')}${more > 0 ? ` and ${more} more` : ''}.`
      : 'No repositories yet.',
  );
  // Repos created on the Whombat (repositories.md RP-05): no GitHub behind them; their pull requests are Whombat's and
  // merge in the origin (runs-approvals.md MDS-D05).
  const local = on.filter((r) => r.source === 'local').map((r) => r.fullName);
  if (local.length)
    facts.push(
      `${local.join(', ')} ${local.length === 1 ? 'is a repository' : 'are repositories'} kept on this Whombat, not on GitHub: start a run on a branch to work on it, and your pushes go to this Whombat. Pull requests work as on GitHub (open_pull_request, review_pull_request, merge_pull_request); Whombat merges them in its own copy.`,
    );
  return facts;
}

/**
 * The provider session to resume a run on (after a pause): the latest session of earlier dispatches that
 * worked on it — run-control dispatches for the run, or the turn that started it (`runs.dispatch_id`). Never one a turn
 * still runs in: the run's turn may be claimed while the turn
 * that started it is at work (health-run-start.md HRS-03). Null: none.
 */
export async function previousSessionForRun(
  services: Services,
  runId: string,
  exceptId: string,
): Promise<{ providerSessionId: string } | null> {
  const rows = await services.db
    .select({ id: dispatches.id, state: dispatches.state, session: dispatches.providerSessionId })
    .from(dispatches)
    .where(
      or(
        eq(dispatches.runId, runId),
        sql`${dispatches.id} = (select ${runs.dispatchId} from ${runs} where ${runs.id} = ${runId})`,
      ),
    )
    .orderBy(desc(dispatches.createdAt));
  const found = rows.find(
    (r) => r.id !== exceptId && r.session && r.state !== 'claimed' && r.state !== 'running',
  );
  return found?.session ? { providerSessionId: found.session } : null;
}
