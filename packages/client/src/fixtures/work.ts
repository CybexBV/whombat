/**
 * `@whombat/client/work-fixtures` — work supervision (contracts 0.12) for the fixture worlds of the web app and the
 * Android app, which `@whombat/fixtures`' `createFixtureFetch()` doesn't cover: plans (`plans.*`), observed activity
 * (`activity.list`) and the Work view (`work.overview`), over the real REST contract. The world is the mock's at
 * 11:22: the “Invoice PDF export” plan (its card is Dusty's 09:13 message in Mara's Chat), Dusty's live Run #1907
 * with an activity feed, the staging approval, a queued turn, a failed automation run and a finished run. One agent
 * does all of it (one-agent.md AP-4909).
 *
 * In memory and deterministic (ids count up, times come from `now`); plan changes follow the server's rules
 * (`planStepRemovable`, `startStep`), so the plan pane, the Work view and the create flow can be used for
 * real in fixture mode, tests and screenshots. Not a server: no permissions, no realtime.
 */
import {
  type Activity,
  type AnyEndpoint,
  API_ENDPOINTS,
  matchPath,
  PLAN_STEP_LABELS,
  type Plan,
  type PlanStep,
  type PlanStepState,
  planProgress,
  planStepRemovable,
  WORK_SECTIONS,
  type WorkItem,
  type WorkOverview,
  workHealth,
} from '@whombat/core';
import { at, BURROW_ID, burrow, canvas, dusty, mara, plan as seedPlan } from '@whombat/fixtures';

const API_BASE = '/api/v1';

const ENDPOINTS = API_ENDPOINTS.filter(
  (e) => e.id.startsWith('plans.') || e.id === 'activity.list' || e.id === 'work.overview',
);

/** Mara's Chat with the agent, where the plan and the runs are talked about. */
const CHAT = 'cnv_dm-dusty';
const IN_CHAT = { type: 'dm', room: 'chat' } as const;

export interface WorkFixtureOptions {
  /** The world's clock (the fixture world is 23 September 2026, 11:22 in Amsterdam). */
  now?: () => Date;
}

export interface WorkFixtures {
  /** Answers a request this world covers; null for anything else (the caller's own fixture fetch then answers). */
  handle(req: Request): Promise<Response | null>;
  /** Current plans (tests). */
  plans(): Plan[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function error(status: number, code: string, message: string, details?: unknown): Response {
  return json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}

function step(over: Partial<PlanStep> & Pick<PlanStep, 'id' | 'title'>): PlanStep {
  return {
    state: 'queued',
    stateLabel: PLAN_STEP_LABELS.queued,
    runId: null,
    approvalId: null,
    automationRunId: null,
    dispatchId: null,
    note: null,
    updatedAt: null,
    refs: { runNumber: null, approvalNumber: null, automationRunNumber: null },
    ...over,
  };
}

/** The seeded plan, as the server returns it since 0.12: made by the agent from Mara's request, its card at 09:13. */
function seedPlans(): Plan[] {
  return [
    {
      ...seedPlan,
      createdById: dusty.id,
      createdAt: at('09:13'),
      messageId: 'msg_chat-dusty-0913',
      source: { messageId: 'msg_chat-dusty-0913', threadRootId: null },
      steps: seedPlan.steps.map((s) => ({ ...s })),
    },
  ];
}

const DISPATCH = 'dsp_dusty-1907';

function activityRow(n: number, over: Partial<Activity>): Activity {
  const startedAt = over.startedAt ?? at('11:22');
  return {
    id: `act_1907-${n}`,
    burrowId: BURROW_ID,
    dispatchId: DISPATCH,
    runId: 'run_1907',
    agentId: dusty.id,
    conversationId: CHAT,
    threadRootId: null,
    key: `1:toolu_${n}`,
    attempt: 1,
    seq: n,
    kind: 'read',
    tool: 'Read',
    status: 'done',
    title: '',
    object: null,
    detail: null,
    important: false,
    approvalId: null,
    link: null,
    evidence: null,
    updatedAt: startedAt,
    finishedAt: over.status === 'running' ? null : startedAt,
    ...over,
    startedAt,
  };
}

/** The agent's turn on Run #1907 at 11:22: reads collapse, the failing test run and the edit stay loud. */
function seedActivity(): Activity[] {
  return [
    activityRow(1, {
      title: 'Read the conversation',
      kind: 'whombat',
      tool: 'whombat.read_conversation',
      important: true,
      startedAt: at('11:22'),
    }),
    activityRow(2, { title: 'Read format.ts', object: 'billing/pdf/format.ts', startedAt: at('11:22') }),
    activityRow(3, { title: 'Read invoice.ts', object: 'billing/pdf/invoice.ts', startedAt: at('11:22') }),
    activityRow(4, {
      title: 'Searched for roundVat',
      kind: 'search',
      tool: 'Grep',
      object: 'roundVat',
      startedAt: at('11:22'),
    }),
    activityRow(5, { title: 'Read vat.ts', object: 'billing/vat.ts', startedAt: at('11:22') }),
    activityRow(6, {
      title: 'Edited format.ts',
      kind: 'edit',
      tool: 'Edit',
      object: 'billing/pdf/format.ts',
      important: true,
      startedAt: at('11:22'),
    }),
    activityRow(7, {
      title: 'Command failed',
      kind: 'command',
      tool: 'Bash',
      object: 'pnpm test billing/pdf',
      status: 'failed',
      detail: 'exit 1',
      important: true,
      startedAt: at('11:22'),
      evidence: {
        input: 'pnpm test billing/pdf',
        output:
          ' FAIL  billing/pdf/format.test.ts > formats VAT on the total\n   expected "€ 1.234,57" received "€ 1.234,56"\n\n Test Files  1 failed | 11 passed (12)\n      Tests  3 failed | 38 passed (41)',
        truncated: true,
      },
    }),
    activityRow(8, {
      title: 'Edited vat.ts',
      kind: 'edit',
      tool: 'Edit',
      object: 'billing/vat.ts',
      important: true,
      startedAt: at('11:22'),
    }),
    activityRow(9, {
      title: 'Running pnpm test billing/pdf',
      kind: 'command',
      tool: 'Bash',
      object: 'pnpm test billing/pdf',
      status: 'running',
      important: true,
      startedAt: at('11:22'),
      evidence: { input: 'pnpm test billing/pdf', output: null, truncated: false },
    }),
  ];
}

interface Store {
  plans: Plan[];
  activity: Activity[];
  seq: number;
}

export function createWorkFixtures(options: WorkFixtureOptions = {}): WorkFixtures {
  const now = options.now ?? (() => new Date(at('11:22')));
  const store: Store = {
    plans: seedPlans(),
    activity: seedActivity(),
    seq: 0,
  };
  const nextId = (prefix: string) => `${prefix}_fx${(++store.seq).toString().padStart(4, '0')}`;
  const nowIso = () => now().toISOString();

  const find = (planId: string) => store.plans.find((p) => p.id === planId);
  const save = (plan: Plan): Plan => {
    const next = { ...plan, updatedAt: nowIso() };
    store.plans = store.plans.map((p) => (p.id === plan.id ? next : p));
    return next;
  };
  const withStep = (plan: Plan, stepId: string, fn: (s: PlanStep) => PlanStep): Plan => ({
    ...plan,
    steps: plan.steps.map((s) => (s.id === stepId ? { ...fn(s), updatedAt: nowIso() } : s)),
  });

  function workOverview(): WorkOverview {
    const items: WorkItem[] = [];
    const refs = (over: Partial<WorkItem['refs']>): WorkItem['refs'] => ({
      conversationId: CHAT,
      messageId: null,
      runNumber: null,
      runId: null,
      approvalNumber: null,
      approvalId: null,
      planId: null,
      stepId: null,
      automationRunNumber: null,
      automationRunId: null,
      dispatchId: null,
      ...over,
    });
    items.push({
      id: 'approval:apr_staging-482',
      kind: 'approval',
      section: 'needs_you',
      title: 'Deploy feat/invoice-pdf to staging',
      where: 'Chat',
      agentId: dusty.id,
      ownerId: mara.id,
      status: { text: 'NEEDS A PERSON', tone: 'warn' },
      detail: 'Waiting on checks for 7be20f and on you.',
      since: at('11:20'),
      health: null,
      activity: null,
      link: { type: 'approval', number: 12, in: IN_CHAT },
      actions: ['approve', 'decline', 'open'],
      refs: refs({ approvalNumber: 12, approvalId: 'apr_staging-482' }),
    });
    for (const plan of store.plans) {
      for (const s of plan.steps) {
        if (s.state !== 'gate' && s.state !== 'blocked') continue;
        // The staging step is carried by the approval above (one item per decision).
        if (s.approvalId === 'apr_staging-482' && s.state === 'gate') continue;
        items.push({
          id: `plan_step:${s.id}`,
          kind: 'plan_step',
          section: s.state === 'gate' ? 'needs_you' : 'blocked',
          title: s.title,
          where: `Chat · ${plan.title}`,
          agentId: dusty.id,
          ownerId: mara.id,
          status: { text: s.stateLabel.toUpperCase(), tone: s.state === 'gate' ? 'warn' : 'bad' },
          detail: s.note,
          since: s.updatedAt ?? plan.updatedAt,
          health: null,
          activity: null,
          link: {
            type: 'plan',
            planId: plan.id,
            stepId: s.id,
            in: IN_CHAT,
          },
          actions: s.state === 'gate' ? ['mark_step_done', 'open'] : ['retry_step', 'open'],
          refs: refs({ planId: plan.id, stepId: s.id, runNumber: s.refs.runNumber }),
        });
      }
    }
    const latest = [...store.activity].reverse().find((a) => a.important) ?? null;
    items.push({
      id: 'run:run_1907',
      kind: 'run',
      section: 'running',
      title: 'Run #1907 · Address review on PR #482',
      where: 'feat/invoice-pdf',
      agentId: dusty.id,
      ownerId: mara.id,
      status: { text: 'LIVE', tone: 'ok' },
      detail: 'Round VAT before formatting',
      since: at('11:22'),
      health: workHealth({
        now: now(),
        heartbeatAt: new Date(now().getTime() - 10_000).toISOString(),
        lastProgressAt: new Date(now().getTime() - 60_000).toISOString(),
        leaseMs: 90_000,
      }),
      activity: latest,
      link: { type: 'run', number: 1907 },
      actions: ['pause', 'take_over', 'open'],
      refs: refs({ runNumber: 1907, runId: 'run_1907', dispatchId: DISPATCH }),
    });
    items.push({
      id: 'dispatch:dsp_dusty-vat',
      kind: 'dispatch',
      section: 'queued',
      title: 'Dusty · summarise the VAT rounding thread',
      where: 'Chat',
      agentId: dusty.id,
      ownerId: mara.id,
      status: { text: 'QUEUED · WAITING FOR A RUNNER', tone: 'neutral' },
      detail: 'Asked by you at 11:19.',
      since: at('11:19'),
      health: null,
      activity: null,
      link: IN_CHAT,
      actions: ['open'],
      refs: refs({ dispatchId: 'dsp_dusty-vat' }),
    });
    items.push({
      id: 'automation_run:arn_ledger-41',
      kind: 'automation_run',
      section: 'failed',
      title: 'Nightly ledger check · run #41',
      where: 'Chat',
      agentId: dusty.id,
      ownerId: mara.id,
      status: { text: 'FAILED', tone: 'bad' },
      detail: 'Step 2 of 3 failed: the ledger export timed out.',
      since: at('06:02'),
      health: null,
      activity: null,
      link: { type: 'automation_run', number: 41 },
      actions: ['open'],
      refs: refs({ automationRunNumber: 41, automationRunId: 'arn_ledger-41' }),
    });
    items.push({
      id: 'run:run_1882',
      kind: 'run',
      section: 'done',
      title: 'Run #1882 · ledger reconciliation',
      where: 'Chat',
      agentId: dusty.id,
      ownerId: mara.id,
      status: { text: 'DONE', tone: 'ok' },
      detail: 'Reconciled 1,204 ledger lines. 18 of 18 tests passed.',
      since: at('08:40'),
      health: null,
      activity: null,
      link: { type: 'run', number: 1882 },
      actions: ['open'],
      refs: refs({ runNumber: 1882 }),
    });
    const sections = WORK_SECTIONS.map(({ section, title }) => ({
      section,
      title,
      items: items.filter((i) => i.section === section),
    }));
    const count = (s: string) => items.filter((i) => i.section === s).length;
    return {
      sections,
      counts: {
        needs_you: count('needs_you'),
        running: count('running'),
        queued: count('queued'),
        blocked: count('blocked'),
        failed: count('failed'),
        done: count('done'),
      },
      generatedAt: nowIso(),
    };
  }

  type Body = Record<string, unknown>;
  const routes: Record<
    string,
    (p: Record<string, string>, q: URLSearchParams, body: Body) => Response | null | Promise<Response | null>
  > = {
    'plans.list': (_p, q) => {
      const conversationId = q.get('conversationId');
      const all = q.get('status') === 'all';
      const plans = store.plans
        .filter((p) => !conversationId || p.conversationId === conversationId)
        .filter((p) => all || planProgress(p).done < planProgress(p).total || p.steps.length === 0)
        .slice()
        .reverse();
      return json({ plans });
    },
    'plans.get': (p) => {
      const plan = find(p.planId ?? '');
      return plan ? json({ plan }) : error(404, 'not_found', 'This plan isn’t here any more.');
    },
    'plans.create': (_p, _q, body) => {
      const steps = (body.steps as { title: string }[] | undefined) ?? [];
      const source = typeof body.sourceMessageId === 'string' ? body.sourceMessageId : null;
      const plan: Plan = {
        id: nextId('pln'),
        burrowId: BURROW_ID,
        title: String(body.title ?? '').trim(),
        due: typeof body.due === 'string' ? body.due : null,
        conversationId: String(body.conversationId),
        canvasId: body.canvas ? canvas.id : null,
        canvasSlug: body.canvas ? canvas.slug : null,
        steps: steps.map((s) => step({ id: nextId('stp'), title: s.title.trim() })),
        updatedAt: nowIso(),
        createdById: mara.id,
        createdAt: nowIso(),
        source: source ? { messageId: source, threadRootId: source } : null,
        messageId: nextId('msg'),
      };
      store.plans.push(plan);
      return json({ plan }, 201);
    },
    'plans.update': (p, _q, body) => {
      const plan = find(p.planId ?? '');
      if (!plan) return error(404, 'not_found', 'This plan isn’t here any more.');
      let next = { ...plan };
      if (typeof body.title === 'string') next.title = body.title.trim();
      if (body.due !== undefined) next.due = (body.due as string | null) ?? null;
      if (Array.isArray(body.order)) {
        const order = body.order as string[];
        if (order.length !== plan.steps.length || !plan.steps.every((s) => order.includes(s.id)))
          return error(400, 'bad_request', 'Order must name every step once.');
        next = { ...next, steps: order.map((id) => plan.steps.find((s) => s.id === id) as PlanStep) };
      }
      return json({ plan: save(next) });
    },
    'plans.addStep': (p, _q, body) => {
      const plan = find(p.planId ?? '');
      if (!plan) return error(404, 'not_found', 'This plan isn’t here any more.');
      const s = step({
        id: nextId('stp'),
        title: String(body.title ?? '').trim(),
        updatedAt: nowIso(),
      });
      const steps = [...plan.steps];
      const after = typeof body.after === 'string' ? steps.findIndex((x) => x.id === body.after) : -1;
      steps.splice(after >= 0 ? after + 1 : steps.length, 0, s);
      return json({ plan: save({ ...plan, steps }) }, 201);
    },
    'plans.updateStep': (p, _q, body) => {
      const plan = find(p.planId ?? '');
      const current = plan?.steps.find((s) => s.id === p.stepId);
      if (!plan || !current) return error(404, 'not_found', 'This step isn’t here any more.');
      const next = withStep(plan, current.id, (s) => {
        let out = { ...s };
        if (typeof body.title === 'string') out.title = body.title.trim();
        if (typeof body.state === 'string') {
          const state = body.state as PlanStepState;
          out = { ...out, state, stateLabel: PLAN_STEP_LABELS[state], note: null };
        }
        if (body.note !== undefined) out.note = (body.note as string | null) ?? null;
        return out;
      });
      return json({ plan: save(next) });
    },
    'plans.removeStep': (p) => {
      const plan = find(p.planId ?? '');
      const current = plan?.steps.find((s) => s.id === p.stepId);
      if (!plan || !current) return error(404, 'not_found', 'This step isn’t here any more.');
      if (!planStepRemovable(current))
        return error(409, 'conflict', 'This step has started. Cancel it instead.', {
          reason: 'step_started',
        });
      return json({ plan: save({ ...plan, steps: plan.steps.filter((s) => s.id !== current.id) }) });
    },
    'plans.startStep': (p) => {
      const plan = find(p.planId ?? '');
      const current = plan?.steps.find((s) => s.id === p.stepId);
      if (!plan || !current) return error(404, 'not_found', 'This step isn’t here any more.');
      // The agent does every step (AP-4952): starting one asks it.
      const dispatchId = nextId('dsp');
      const next = withStep(plan, current.id, (s) => ({
        ...s,
        state: 'active',
        stateLabel: 'Asked',
        dispatchId,
        note: null,
      }));
      return json({
        plan: save(next),
        dispatchId,
        messageId: nextId('msg'),
        automationRunNumber: null,
      });
    },
    'plans.createCanvas': (p) => {
      const plan = find(p.planId ?? '');
      if (!plan) return error(404, 'not_found', 'This plan isn’t here any more.');
      const next = save({ ...plan, canvasId: canvas.id, canvasSlug: canvas.slug });
      return json({ plan: next, canvas }, 201);
    },
    'activity.list': (_p, q) => {
      const run = q.get('runNumber');
      const dispatch = q.get('dispatchId');
      const conversation = q.get('conversationId');
      const rows = store.activity.filter(
        (a) =>
          (run === null || (run === '1907' && a.runId === 'run_1907')) &&
          (dispatch === null || a.dispatchId === dispatch) &&
          (conversation === null || a.conversationId === conversation),
      );
      return json({
        activities: rows,
        cursor: rows.length ? (rows[rows.length - 1] as Activity).id : null,
        hasMore: false,
      });
    },
    'work.overview': () => json(workOverview()),
  };

  return {
    plans: () => store.plans,
    async handle(req) {
      const url = new URL(req.url, 'http://fixtures.local');
      const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
      for (const ep of ENDPOINTS as readonly AnyEndpoint[]) {
        if (ep.method !== req.method) continue;
        const params = matchPath(ep.path, path);
        if (!params || params.burrow !== burrow.slug) continue;
        const route = routes[ep.id];
        if (!route) return null;
        const text = req.method === 'GET' || req.method === 'DELETE' ? '' : await req.text();
        const answer = await route(params, url.searchParams, text ? (JSON.parse(text) as Body) : {});
        if (answer) return answer;
      }
      return null;
    },
  };
}
