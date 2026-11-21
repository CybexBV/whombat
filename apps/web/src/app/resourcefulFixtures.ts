/**
 * Resourceful agents in fixture mode (contracts 0.44.0; Whombat resourceful-agents.md RA-06, RA-30, RA-41…RA-44; AP-686).
 * The shared fixture world reads no schedules and writes none; this layer makes them work in every fixture world — the
 * agent's schedules with Pause, Resume and Remove, “Agents may reach your local network” and “Always allow” on a
 * risk-row card — and with `VITE_FIXTURE_RESOURCEFUL=1` (`resourceful: true`) seeds them. What the agent remembers and its notes are the shared world's since contracts 0.125
 * (Mara's memory and the notes, CT-1200…CT-1205; AP-5227):
 *
 * - the agent's schedules: weekdays at 08:30 (active, made in Mara's Chat with its card there), tomorrow at 09:00 (active),
 *   every 30 minutes (paused), the weekly summary (ran its 90 days).
 *
 * State lives in the closure (one world per fetch); every answer is built to the contracts' schemas.
 */
import {
  type AgentScheduleView,
  type Approval,
  alwaysAllowRow,
  type Burrow,
  type ChatThread,
  type ChatThreadsResponse,
  type MessagePage,
  scheduleActions,
  scheduleEndsAt,
} from '@whombat/core';
import { type AnyEndpoint, API_ENDPOINTS, matchPath } from '@whombat/core/contracts';
import type { Message } from '@whombat/core/domain';
import { burrow } from '@whombat/fixtures';
import { DEFAULT_CHAT_ID, WHOMBAT_HANDLE, WHOMBAT_ID } from './oneFixtures';

const API_BASE = '/api/v1';
/** The seed clock: 11:22 in Amsterdam on Wednesday 23 September 2026 (as `commandFixtures.ts`). */
const T = (hhmm: string, day = '2026-09-23') => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(
    Date.UTC(
      Number(day.slice(0, 4)),
      Number(day.slice(5, 7)) - 1,
      Number(day.slice(8, 10)),
      (h ?? 0) - 2,
      m ?? 0,
    ),
  ).toISOString();
};

/** The message in Mara's Chat that carries the weekday schedule's card. */
export const SCHEDULE_MESSAGE = 'msg_neo_schedule';
const CHAT = DEFAULT_CHAT_ID;

const ENDPOINTS = API_ENDPOINTS.filter((e) =>
  [
    'schedules.list',
    'schedules.pause',
    'schedules.resume',
    'schedules.remove',
    'burrows.setAgentsReachLan',
  ].includes(e.id),
) as readonly AnyEndpoint[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function problem(code: string, message: string, status: number, details?: unknown): Response {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, status);
}

function schedule(
  view: Partial<AgentScheduleView> & Pick<AgentScheduleView, 'id' | 'when'>,
): AgentScheduleView {
  const createdAt = view.createdAt ?? T('11:20');
  return {
    agentId: WHOMBAT_ID,
    conversationId: CHAT,
    threadRootId: null,
    prompt: '',
    status: 'active',
    endedReason: null,
    nextAt: null,
    endsAt: scheduleEndsAt(view.when, createdAt),
    runs: 0,
    lastRunAt: null,
    createdAt,
    ...view,
  };
}

function seedSchedules(): Map<string, AgentScheduleView[]> {
  return new Map([
    [
      WHOMBAT_HANDLE,
      [
        schedule({
          id: 'sch_backups',
          when: { kind: 'cron', expr: '30 8 * * 1-5', zone: 'Europe/Amsterdam' },
          prompt: 'Check last night’s backups on the NAS and post one line here: fine, or what failed.',
          nextAt: T('08:30', '2026-09-24'),
          runs: 12,
          lastRunAt: T('08:30'),
          createdAt: T('08:12', '2026-09-07'),
        }),
        schedule({
          id: 'sch_deploycheck',
          when: { kind: 'at', at: T('09:00', '2026-09-24') },
          conversationId: CHAT,
          prompt: 'Check that the billing-v2 deploy finished and the invoice PDFs render; report here.',
          nextAt: T('09:00', '2026-09-24'),
          createdAt: T('11:18'),
        }),
        schedule({
          id: 'sch_statuspage',
          when: { kind: 'every', minutes: 30 },
          prompt: 'Look at the status page and say so here when something is down.',
          status: 'paused',
          runs: 31,
          lastRunAt: T('17:30', '2026-09-22'),
          createdAt: T('09:00', '2026-09-22'),
        }),
        schedule({
          id: 'sch_weekly',
          when: { kind: 'cron', expr: '0 16 * * 5', zone: 'Europe/Amsterdam' },
          prompt: 'Write the weekly incident summary: what broke, how long, what we changed.',
          status: 'ended',
          endedReason: 'expired',
          runs: 13,
          lastRunAt: T('16:00', '2026-09-18'),
          endsAt: T('16:00', '2026-09-19'),
          createdAt: T('16:00', '2026-06-21'),
        }),
      ],
    ],
  ]);
}

function scheduleMessage(view: AgentScheduleView): Message {
  return {
    id: SCHEDULE_MESSAGE,
    conversationId: CHAT,
    authorId: WHOMBAT_ID,
    createdAt: T('11:21'),
    editedAt: null,
    text: 'I’ll check last night’s backups every weekday at 08:30 and post a line here.',
    mentions: [],
    card: { kind: 'schedule', scheduleId: view.id, schedule: view },
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
  };
}

export interface ResourcefulFixtures {
  /** Answers this layer's routes (`inner` reads the rest of the world), or null. */
  handle(req: Request, inner: (req: Request) => Promise<Response>): Promise<Response | null>;
  /** Adds what this layer changes to the world's answers. */
  decorate(req: Request, response: Response): Promise<Response>;
}

export function createResourcefulFixtures(options: { seed?: boolean } = {}): ResourcefulFixtures {
  const seed = options.seed ?? false;
  const schedules = seed ? seedSchedules() : new Map<string, AgentScheduleView[]>();
  let reachLan = true;
  /** Risk-row approvals decided with “Always allow” (RA-06): their scope reads `agent`. */
  const alwaysAllowed = new Set<number>();
  let seq = 0;

  // The agent (one-agent.md AP-4921): its paths carry no handle any more (OA-19).
  const agentOf = (handle: string) => (handle === WHOMBAT_HANDLE ? { id: WHOMBAT_ID, handle } : undefined);
  const isAgent = (handle: string) => !!agentOf(handle);

  const changeSchedule = (handle: string, id: string, next: (s: AgentScheduleView) => AgentScheduleView) => {
    const list = schedules.get(handle) ?? [];
    const s = list.find((x) => x.id === id);
    if (!s) return problem('not_found', 'No such schedule.', 404);
    const changed = next(s);
    schedules.set(
      handle,
      list.map((x) => (x.id === id ? changed : x)),
    );
    return json({ schedule: changed, eventId: `evt_schedule_${id}_${++seq}` });
  };

  type Route = (
    params: Record<string, string>,
    body: Record<string, unknown>,
    req: Request,
    inner: (req: Request) => Promise<Response>,
  ) => Response | null | Promise<Response | null>;

  const routes: Record<string, Route> = {
    'schedules.list': (p) =>
      isAgent(p.agent ?? WHOMBAT_HANDLE)
        ? json({ schedules: schedules.get(p.agent ?? WHOMBAT_HANDLE) ?? [] })
        : null,
    'schedules.pause': (p) =>
      changeSchedule(p.agent ?? WHOMBAT_HANDLE, p.scheduleId ?? '', (s) =>
        scheduleActions(s).pause ? { ...s, status: 'paused', nextAt: null } : s,
      ),
    'schedules.resume': (p) =>
      changeSchedule(p.agent ?? WHOMBAT_HANDLE, p.scheduleId ?? '', (s) =>
        scheduleActions(s).resume
          ? {
              ...s,
              status: 'active',
              endedReason: null,
              nextAt: new Date(Date.now() + 30 * 60_000).toISOString(),
              endsAt: s.endedReason === 'expired' ? scheduleEndsAt(s.when, new Date()) : s.endsAt,
            }
          : s,
      ),
    'schedules.remove': (p) =>
      changeSchedule(p.agent ?? WHOMBAT_HANDLE, p.scheduleId ?? '', (s) => ({
        ...s,
        status: 'ended',
        endedReason: 'cancelled',
        nextAt: null,
      })),
    'burrows.setAgentsReachLan': async (_p, body, req, inner) => {
      reachLan = body.agentsReachLan === true;
      const url = new URL(req.url, 'http://fixtures.local');
      // The shared world serves the burrow with the bootstrap (it has no `burrows.get`).
      const res = await inner(
        new Request(new URL(`${API_BASE}/burrows/${burrow.slug}/bootstrap`, url.origin)),
      );
      const data = (await res.json()) as { burrow: Burrow };
      return json({ burrow: { ...data.burrow, agentsReachLan: reachLan }, eventId: `evt_lan_${++seq}` });
    },
  };

  const match = (req: Request) => {
    const url = new URL(req.url, 'http://fixtures.local');
    const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
    for (const ep of ENDPOINTS) {
      if (ep.method !== req.method) continue;
      const params = matchPath(ep.path, path);
      if (params && params.burrow === burrow.slug) return { ep, params };
    }
    return null;
  };

  /** The approval as this layer knows it: “Always allow” reads `scope: 'agent'`. */
  const withScope = (approval: Approval): Approval =>
    alwaysAllowed.has(approval.number) && approval.state !== 'pending'
      ? { ...approval, scope: 'agent' }
      : approval;

  return {
    async handle(req, inner) {
      const url = new URL(req.url, 'http://fixtures.local');
      const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
      // “Always allow” on a risk-row card (RA-06): the world approves; the decision reads `agent` from here on.
      const decide = /^\/burrows\/[^/]+\/approvals\/(\d+)\/decide$/.exec(path);
      if (decide && req.method === 'POST') {
        const body = (await req.clone().json()) as { decision?: string; scope?: string };
        const res = await inner(req);
        if (!res.ok || body.decision !== 'approve' || body.scope !== 'agent') return res;
        const data = (await res.json()) as { approval: Approval };
        if (alwaysAllowRow(data.approval.action)) alwaysAllowed.add(data.approval.number);
        return json({ ...data, approval: withScope(data.approval) });
      }
      // The schedule's message is a thread of Chat's (chat-inbox-web.md): it opens like any other.
      const scheduled = seed
        ? (schedules.get(WHOMBAT_HANDLE) ?? []).find((s) => s.id === 'sch_backups')
        : undefined;
      if (
        scheduled &&
        req.method === 'GET' &&
        path === `/burrows/${burrow.slug}/messages/${SCHEDULE_MESSAGE}/thread`
      )
        return json({
          root: scheduleMessage(scheduled),
          replies: [],
          conversationId: CHAT,
          where: 'Chat',
          topic: null,
          more: null,
        });
      const m = match(req);
      if (!m) return null;
      const route = routes[m.ep.id];
      if (!route) return null;
      const text = req.method === 'GET' || req.method === 'DELETE' ? '' : await req.clone().text();
      return route(m.params, text ? (JSON.parse(text) as Record<string, unknown>) : {}, req, inner);
    },
    async decorate(req, response) {
      if (req.method !== 'GET' || !response.ok) return response;
      const url = new URL(req.url, 'http://fixtures.local');
      const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
      if (path === `/burrows/${burrow.slug}/bootstrap` || path === `/burrows/${burrow.slug}`) {
        const data = (await response.json()) as { burrow: Burrow };
        return json({ ...data, burrow: { ...data.burrow, agentsReachLan: reachLan } });
      }
      if (/^\/burrows\/[^/]+\/approvals\/\d+$/.test(path)) {
        const data = (await response.json()) as { approval: Approval };
        return json({ ...data, approval: withScope(data.approval) });
      }
      const dusties = seed ? (schedules.get(WHOMBAT_HANDLE) ?? []) : [];
      const backups = dusties.find((s) => s.id === 'sch_backups');
      // Chat's list of open threads has the schedule's message as a thread of its own (chat-inbox-web.md).
      if (
        backups &&
        path === `/burrows/${burrow.slug}/chats/threads` &&
        (url.searchParams.get('room') ?? 'chat') === 'chat' &&
        url.searchParams.get('state') !== 'settled' &&
        !url.searchParams.has('before') &&
        !url.searchParams.has('subjectKind')
      ) {
        const page = (await response.json()) as ChatThreadsResponse;
        if (page.threads.some((t) => t.rootId === SCHEDULE_MESSAGE)) return json(page);
        const root = scheduleMessage(backups);
        const thread: ChatThread = {
          conversationId: CHAT as ChatThread['conversationId'],
          room: 'chat',
          rootId: root.id,
          authorId: root.authorId,
          text: root.text,
          subject: null,
          createdAt: root.createdAt,
          replyCount: 0,
          lastAt: root.createdAt,
          working: false,
          waiting: false,
          settled: null,
        };
        const threads = [...page.threads, thread].sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
        return json({ ...page, threads });
      }
      if (
        backups &&
        path === `/burrows/${burrow.slug}/conversations/${CHAT}/messages` &&
        !url.searchParams.has('before')
      ) {
        const page = (await response.json()) as MessagePage;
        if (page.messages.some((m) => m.id === SCHEDULE_MESSAGE)) return json(page);
        return json({ ...page, messages: [...page.messages, scheduleMessage(backups)] });
      }
      return response;
    },
  };
}
