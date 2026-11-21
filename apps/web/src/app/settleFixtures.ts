/**
 * Cards that settle into a line, in fixture mode (`VITE_FIXTURE_SETTLE=1`, or `settle: true` in
 * `createWebFixtureFetch`; docs/decisions/card-settle.md AP-730…AP-735). Modelled on John's #reports thread (report
 * FB-3B50-6X0Q): in the branch room of PR #482 (the conversation with people's messages that stays with one agent,
 * one-agent.md AP-4949), a report whose thread holds
 *
 * - the assessment, decided (a line);
 * - two done runs with a pull request and a diff (lines with `PR #n` and `+12 −8`), the second followed by a schedule
 *   it made (`runId`: a sub-line inside the run; active: Cancel shows);
 * - a decided approval (a line);
 * - a live run that changed something (the compact live card) and one that needs a person (the full card);
 *
 * and the agent thinking in it, with what it does (`agentNow`, seeded by `seedSettleLive`). A second root, Mara's ask, has
 * a live run in its thread (the reply row's “Neo is working · 62%”), and the agent thinks in a third (“Neo is thinking”).
 * A feature request without a thread sits above the report, so the room shows two report rows (report-rows.md RR-02).
 * Every run and message of the agent's is the one agent's (`WHOMBAT_ID`, Neo).
 *
 * Always, also when not seeded: `runs.list` (the burrow's runs, which the shared world doesn't serve), so the reply
 * rows' read of live runs doesn't miss. Times are relative to when the world is made, so the live run's clock and the
 * day divider (“Today”) read as they would.
 */
import type { QueryClient } from '@tanstack/react-query';
import { type AgentNowEntry, queryKeys, type TypingEntry } from '@whombat/client/query';
import { API_ENDPOINTS, type MessagePage, matchPath, type ThreadView } from '@whombat/core/contracts';
import type {
  AgentScheduleView,
  Approval,
  AssessmentCard,
  Message,
  MessageCard,
  Run,
} from '@whombat/core/domain';
import {
  assessmentCardOf,
  burrow,
  deployApproval,
  run as fixtureRun,
  mara,
  reportCardOf,
  reportFeature,
  reportLikelyBug,
} from '@whombat/fixtures';
import { ASSISTANT_NAME, WHOMBAT_HANDLE, WHOMBAT_ID } from './oneFixtures';

const API_BASE = '/api/v1';
const ROOM = 'cnv_pr482';
const WHERE = 'feat/invoice-pdf';
/** The one agent (`oneFixtures.ts`): every run and message of an agent here is its. */
const agent = { id: WHOMBAT_ID as Run['agentId'], name: ASSISTANT_NAME, handle: WHOMBAT_HANDLE };

/** The report's thread, and Mara's ask whose thread has a live run. */
export const SETTLE_ROOT = 'msg_settle-report';
export const SETTLE_ASK_ROOT = 'msg_settle-ask';
/** A feature request above the report, without a thread: two report rows one after the other (RR-02). */
export const SETTLE_FEATURE_ROOT = 'msg_settle-feature';
/** A root of the branch room where the agent is thinking. */
export const SETTLE_THINKING_ROOT = 'msg_pr482-mara-1130';
export const SETTLE_SCHEDULE = 'sch_settle-recheck';

const ENDPOINTS = API_ENDPOINTS.filter((e) =>
  ['runs.list', 'messages.thread', 'schedules.remove'].includes(e.id),
);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The seeded world: built once per fetch, relative to `base`. */
function seedWorld(base: number) {
  const ago = (minutes: number) => new Date(base - minutes * 60_000).toISOString();

  const runOf = (
    n: number,
    over: Partial<Run> & Pick<Run, 'title' | 'status' | 'startedAt'>,
    threadRootId: string,
  ): Run => ({
    ...fixtureRun,
    id: `run_settle-${n}`,
    number: n,
    agentId: agent.id,
    branch: 'fix/vat-rounding',
    prNumber: null,
    conversationId: ROOM,
    messageId: `msg_settle-run-${n}`,
    threadRootId,
    askedById: mara.id,
    finishedAt: null,
    progress: 100,
    activity: '',
    summary: null,
    steps: [],
    tests: null,
    files: [],
    diff: { add: 0, del: 0, files: 0 },
    attention: null,
    ...over,
  });

  const runs: Run[] = [
    runOf(
      31,
      {
        title: 'Round VAT once, on the total',
        status: 'done',
        startedAt: ago(46),
        finishedAt: ago(39.8),
        prNumber: 3,
        summary: 'The PDF and the page now round the VAT total the same way. 42 of 42 tests passed.',
        files: [
          { path: 'billing/pdf/format.ts', add: 9, del: 6 },
          { path: 'billing/pdf/format.test.ts', add: 3, del: 2 },
        ],
        diff: { add: 12, del: 8, files: 2 },
      },
      SETTLE_ROOT,
    ),
    runOf(
      32,
      {
        title: 'Deploy the fix to staging',
        status: 'done',
        startedAt: ago(30),
        finishedAt: ago(26.5),
        prNumber: 4,
        summary: 'Staging shows €121,00 on the PDF and on the page.',
        files: [{ path: 'deploy/staging.yml', add: 3, del: 1 }],
        diff: { add: 3, del: 1, files: 1 },
      },
      SETTLE_ROOT,
    ),
    runOf(
      33,
      {
        title: 'Verify and deploy',
        status: 'live',
        startedAt: new Date(base - 192_000).toISOString(),
        progress: 38,
        activity: 'Running pnpm test',
        prNumber: 5,
        files: [{ path: 'billing/pdf/footer.ts', add: 5, del: 2 }],
        diff: { add: 5, del: 2, files: 1 },
      },
      SETTLE_ROOT,
    ),
    runOf(
      34,
      {
        agentId: agent.id,
        title: 'Deploy the fix to production',
        status: 'live',
        startedAt: ago(8),
        progress: 64,
        activity: 'Waiting for the production key',
        attention: 'The deploy to web-1 needs the Deploy key, and it isn’t in the Vault yet.',
        prNumber: 4,
        files: [{ path: 'deploy/production.yml', add: 2, del: 1 }],
        diff: { add: 2, del: 1, files: 1 },
      },
      SETTLE_ROOT,
    ),
    runOf(
      35,
      {
        title: 'Add the VAT note to the invoice footer',
        status: 'live',
        startedAt: ago(4),
        progress: 62,
        activity: 'Editing billing/pdf/footer.ts',
        prNumber: 6,
        files: [{ path: 'billing/pdf/footer.ts', add: 8, del: 0 }],
        diff: { add: 8, del: 0, files: 1 },
      },
      SETTLE_ASK_ROOT,
    ),
  ];
  const run = (n: number) => runs.find((r) => r.number === n) as Run;

  const assessment = assessmentCardOf(reportLikelyBug) as AssessmentCard;
  const decidedAssessment: AssessmentCard = {
    ...assessment,
    decided: {
      option: 0,
      label: `Hand to ${ASSISTANT_NAME}`,
      action: 'hand_off',
      decidedById: mara.id,
      decidedAt: ago(47),
    },
  };

  const approval: Approval = deployApproval({
    id: 'apr_settle-staging',
    number: 27,
    requesterId: agent.id,
    action: {
      type: 'deploy',
      params: {
        environment: 'staging',
        service: 'billing-api',
        ref: 'fix/vat-rounding',
        sha: null,
        prNumber: 4,
      },
    },
    title: 'Deploy fix/vat-rounding to staging',
    question: 'Deploy fix/vat-rounding to staging?',
    state: 'approved',
    decidedById: mara.id,
    decidedAt: ago(31),
    execution: {
      state: 'succeeded',
      startedAt: ago(30.5),
      finishedAt: ago(26.5),
      durationMs: 210_000,
      resultUrl: null,
      error: null,
    },
    createdAt: ago(32),
  } as Partial<Approval>);

  const schedule: AgentScheduleView = {
    id: SETTLE_SCHEDULE,
    agentId: agent.id,
    conversationId: ROOM,
    threadRootId: SETTLE_ROOT,
    when: { kind: 'at', at: new Date(base + 22 * 3_600_000).toISOString() },
    prompt: 'Check that invoice 2026-000142 shows the same VAT total on the PDF and the page.',
    status: 'active',
    endedReason: null,
    nextAt: new Date(base + 22 * 3_600_000).toISOString(),
    endsAt: null,
    runs: 0,
    lastRunAt: null,
    createdAt: ago(25),
  };

  const message = (
    id: string,
    minutesAgo: number,
    authorId: string,
    text: string,
    card: MessageCard | null,
    threadRootId: string | null = SETTLE_ROOT,
  ): Message => ({
    id,
    conversationId: ROOM,
    authorId,
    createdAt: ago(minutesAgo),
    editedAt: null,
    text,
    mentions: [],
    card,
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
  });

  const replies = (): Message[] => [
    message(
      'msg_settle-assessment',
      48,
      agent.id,
      'I looked at it: the PDF rounds VAT per line, the page rounds the total. A real bug.',
      decidedAssessment,
    ),
    message('msg_settle-run-31', 46, agent.id, 'I’ll round once, on the total, and open a pull request.', {
      kind: 'run',
      run: run(31),
    }),
    message('msg_settle-approval', 32, agent.id, 'Deploying the fix to staging needs a yes.', {
      kind: 'approval',
      approval,
    }),
    message('msg_settle-run-32', 30, agent.id, 'Deploying to staging.', { kind: 'run', run: run(32) }),
    message('msg_settle-schedule', 25, agent.id, 'I’ll check the invoice again tomorrow.', {
      kind: 'schedule',
      scheduleId: schedule.id,
      schedule,
      runId: run(32).id,
    }),
    message('msg_settle-run-33', 12, agent.id, 'Adding the footer note and deploying it.', {
      kind: 'run',
      run: run(33),
    }),
    message('msg_settle-run-34', 8, agent.id, 'Deploying the fix to production.', {
      kind: 'run',
      run: run(34),
    }),
  ];

  const root = (all: Message[]): Message => ({
    ...message(
      SETTLE_ROOT,
      50,
      agent.id,
      // The header the server posts a report with (docs/decisions/report-rows.md RR-04).
      'Bug report FB-7K3Q-9M2X · Burrow Billing',
      reportCardOf(reportLikelyBug),
      null,
    ),
    replyCount: all.length,
    lastReplyAt: all.at(-1)?.createdAt ?? null,
    threadParticipantIds: [agent.id, agent.id, agent.id],
  });

  const askReplies = (): Message[] => [
    message('msg_settle-run-35', 4, agent.id, 'On it.', { kind: 'run', run: run(35) }, SETTLE_ASK_ROOT),
  ];
  const askRoot = (all: Message[]): Message => ({
    ...message(
      SETTLE_ASK_ROOT,
      5,
      mara.id,
      `@${ASSISTANT_NAME} can you add a note about VAT rounding to the invoice footer?`,
      null,
      null,
    ),
    mentions: [agent.id],
    replyCount: all.length,
    lastReplyAt: all.at(-1)?.createdAt ?? null,
    threadParticipantIds: [agent.id],
  });

  const featureRoot = (): Message =>
    message(
      SETTLE_FEATURE_ROOT,
      70,
      agent.id,
      'Feature request FB-H8XM-5VKT · Burrow Billing',
      reportCardOf(reportFeature),
      null,
    );

  return { runs, schedule, replies, root, askReplies, askRoot, featureRoot };
}

export interface SettleFixtures {
  handle(req: Request): Promise<Response | null>;
  decorate(req: Request, response: Response): Promise<Response>;
}

export function createSettleFixtures(options: { seed?: boolean } = {}): SettleFixtures {
  const world = options.seed ? seedWorld(Date.now()) : null;
  let scheduleState = world?.schedule ?? null;

  const withSchedule = (messages: Message[]): Message[] =>
    messages.map((m) =>
      m.card?.kind === 'schedule' && scheduleState && m.card.scheduleId === scheduleState.id
        ? { ...m, card: { ...m.card, schedule: scheduleState } }
        : m,
    );

  const threadOf = (rootId: string): ThreadView | null => {
    if (!world) return null;
    if (rootId === SETTLE_ROOT) {
      const replies = withSchedule(world.replies());
      return {
        root: world.root(replies),
        replies,
        conversationId: ROOM,
        where: WHERE,
        topic: null,
        more: null,
      };
    }
    if (rootId === SETTLE_ASK_ROOT) {
      const replies = world.askReplies();
      return {
        root: world.askRoot(replies),
        replies,
        conversationId: ROOM,
        where: WHERE,
        topic: null,
        more: null,
      };
    }
    return null;
  };

  return {
    async handle(req) {
      const url = new URL(req.url, 'http://fixtures.local');
      const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
      for (const ep of ENDPOINTS) {
        if (ep.method !== req.method) continue;
        const params = matchPath(ep.path, path);
        if (!params || params.burrow !== burrow.slug) continue;
        if (ep.id === 'runs.list') {
          const status = url.searchParams.get('status');
          const agent = url.searchParams.get('agent');
          const agentId = agent === WHOMBAT_HANDLE ? WHOMBAT_ID : undefined;
          const runs = (world?.runs ?? []).filter(
            (r) => (!status || r.status === status) && (!agent || r.agentId === agentId),
          );
          return json({ runs: [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) });
        }
        if (ep.id === 'messages.thread') {
          const thread = threadOf(params.messageId ?? '');
          return thread ? json(thread) : null;
        }
        if (ep.id === 'schedules.remove' && scheduleState && params.scheduleId === scheduleState.id) {
          scheduleState = { ...scheduleState, status: 'ended', endedReason: 'cancelled', nextAt: null };
          return json({ schedule: scheduleState, eventId: null });
        }
      }
      return null;
    },
    async decorate(req, response) {
      if (!world || req.method !== 'GET' || !response.ok) return response;
      const url = new URL(req.url, 'http://fixtures.local');
      const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
      if (path !== `/burrows/${burrow.slug}/conversations/${ROOM}/messages` || url.searchParams.has('before'))
        return response;
      const page = (await response.json()) as MessagePage;
      const replies = world.replies();
      const ask = world.askReplies();
      const own = [world.featureRoot(), world.root(replies), world.askRoot(ask)];
      return json({
        ...page,
        messages: [...page.messages.filter((m) => !own.some((o) => o.id === m.id)), ...own],
      });
    },
  };
}

/**
 * The agent thinking in the report's thread with what it does (`Neo · Editing Layout.astro · 1m 12s`, AP-734), and in
 * another thread of the room (its reply row's “Neo is thinking”, AP-735). Fixture mode has no
 * socket to bring them, so they go straight into the cache, until a day from now.
 */
export function seedSettleLive(qc: QueryClient, base = Date.now()): void {
  const expiresAt = base + 24 * 3_600_000;
  const typing: TypingEntry[] = [
    { principalId: agent.id, threadRootId: SETTLE_ROOT, expiresAt },
    { principalId: agent.id, threadRootId: SETTLE_THINKING_ROOT, expiresAt },
  ];
  const now: AgentNowEntry[] = [
    {
      principalId: agent.id,
      threadRootId: SETTLE_ROOT,
      dispatchId: 'dsp_settle-agent',
      title: 'Editing Layout.astro',
      status: 'running',
      seq: 4,
      since: base - 72_000,
      // The newest action stays “now” for as long as the fixture lives.
      at: expiresAt,
    },
  ];
  qc.setQueryData(queryKeys.typing(ROOM), typing);
  qc.setQueryData(queryKeys.agentNow(ROOM), now);
}
