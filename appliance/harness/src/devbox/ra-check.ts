/**
 * `dev/devbox ra-check` — the box's agent, resourceful, as a person uses it (Whombat
 * docs/decisions/resourceful-agents.md RA-60), through the real client over the relay, as the box's person, in their
 * Chat with the Whombat's one agent (Whombat one-agent.md OA-01, OA-04; every top-level message there starts a thread
 * and reaches the agent):
 *
 *   learn       the person tells the agent a lasting preference in one thread (“answer me in Dutch”); what the agent
 *               remembers about them (`memory.mine`: Hermes's USER.md and MEMORY.md of the profile, Whombat HE-39)
 *               gains it, and a question in another thread is answered in Dutch;
 *   schedule    the agent is asked to remind the person in 5 minutes in this thread; `schedules.list` shows the
 *               schedule active in that thread, and the reminder posts there when it is due;
 *   notify      the agent starts a background job that sleeps a minute, then `whombat notify`s, and ends its turn; the
 *               job's words come back in the Chat and wake it for a turn of its own;
 *   lan         the agent fetches a page from a server on this machine's Incus bridge address (the box's LAN, RA-41);
 *   ocr         the agent reads the invoice number and total from a scanned invoice attached in the Chat;
 *   correction  a corrected language preference replaces the earlier one in the person's memory, and a new thread is
 *               answered in English;
 *   recovery    the agent diagnoses a failed command and produces the requested file.
 *
 * Everything runs in the box's one burrow (IN-395) with its agent on Codex (the person's ChatGPT sign-in, as
 * deploy-check leaves it) and its default keys (contracts `AGENT_DEFAULT_KEYS`: the six risk rows at Ask, everything
 * else on; the shipped skills, Whombat HE-41). A scenario's approvals are
 * approved as a person would and counted as help, and a question that stops the work gets one “go ahead” (help too).
 * Per scenario: ok, seconds, without help, the questions asked, the agent's replies, its turns and what they did
 * (activity), and the tokens its turns reported (`spend.overview`) — with the prompt cache's reads and writes, the
 * uncached rest and the resumed turns' cache results once the box's runtime reports them (Whombat
 * prompt-efficiency.md PE-04, PE-12; contracts 0.44.1).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename } from 'node:path';
import { AGENT_DEFAULT_KEYS } from '@whombat/core/keys';
import { sleep } from '../lib/proc.ts';
import { type ApplianceSession, sessionOps } from '../scenario-kit/app-client.ts';
import {
  type Agent,
  api,
  type Collected,
  collect,
  ensureWorkspace,
  eventType,
} from '../scenario-kit/work.ts';
import {
  dutchScore,
  invoiceFigures,
  questionsIn,
  type RaScenarioName,
  type SpendCache,
  type SpendSnapshot,
  scenarioMinutes,
  selectedScenarios,
  short,
  spendCache,
  spendDelta,
} from './ra-rules.ts';
import { personSession, type Step } from './session-kit.ts';
import type { DevboxState } from './state.ts';

const LAN_HOST = process.env.WB_RA_LAN_HOST ?? '10.62.52.1';
const INVOICE = process.env.WB_RA_INVOICE ?? '';
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const STATE_RANK: Record<string, number> = {
  queued: 0,
  claimed: 1,
  running: 2,
  done: 3,
  failed: 3,
  cancelled: 3,
};
const NUDGE = 'Yes, please go ahead — your call.';

/** The six risk rows (named by their first key) and every key they set (RA-01, RA-DC01). */
const RISK_ROWS = [
  'deploy',
  'merge',
  'branch.main.push',
  'commands.destructive',
  'messages.external',
  'refunds.issue',
];
const RISK_KEYS = new Set([
  ...RISK_ROWS,
  'deploy.staging',
  'deploy.production',
  'merge.main',
  'billing.write',
]);

type St = DevboxState;

interface Card {
  kind: string;
  text?: string;
  [k: string]: unknown;
}
interface Msg {
  id: string;
  conversationId: string;
  authorId: string;
  createdAt: string;
  text: string;
  card: Card | null;
  threadRootId: string | null;
  replyCount: number;
  lastReplyAt?: string | null;
  clientId: string | null;
}
interface Dispatch {
  id: string;
  agentId: string;
  conversationId: string;
  threadRootId: string | null;
  trigger: string;
  state: string;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  reason: string | null;
  failure?: { code: string; reason: string } | null;
}
interface Grant {
  keyId: string;
  tier: string;
}
interface Schedule {
  id: string;
  conversationId: string;
  threadRootId: string | null;
  prompt: string | null;
  when: unknown;
  status: string;
  endedReason: string | null;
  nextAt: string | null;
  runs: number;
  lastRunAt: string | null;
  createdAt: string;
}
/** What the agent remembers about the person (`memory.mine`): Hermes's USER.md and MEMORY.md, the fields read. */
interface Remembered {
  user: { text: string };
  memory: { text: string };
}

export interface RaScenarioResult {
  name: RaScenarioName;
  title: string;
  ok: boolean;
  startedAt: string;
  seconds: number;
  /** No approval had to be given and no question answered. */
  withoutHelp: boolean;
  /** What a person did for it: approvals given, “go ahead” answers. */
  help: string[];
  /** The questions the agent asked (judged afterwards: needed or not). */
  questions: string[];
  /** What the agent posted, in order (cards in brackets). */
  replies: string[];
  /** The agent's turns: trigger, state, seconds. */
  turns: string[];
  /** What the turns did (activity rows). */
  did: string[];
  /** Tokens the burrow's turns reported meanwhile (`spend.overview`, the week's window before and after). */
  tokens: ReturnType<typeof spendDelta> | null;
  checks: { name: string; ok: boolean; detail?: unknown }[];
  notes: Record<string, unknown>;
  error?: string;
}

export interface RaCheckResult {
  ok: boolean;
  at: string;
  burrow: string | null;
  setup: Step[];
  /** The agent: its name, runtime, keys and skills. */
  agent: Record<string, unknown>;
  scenarios: RaScenarioResult[];
  /** After the scenarios: what the agent remembers about the person, the notes and the schedules. */
  final?: Record<string, unknown>;
}

interface World {
  slug: string;
  burrowId: string;
  meId: string;
  /** The person's Chat with the agent. */
  chatId: string;
  agent: Agent;
}

/** One scenario's clock and records. */
interface Run {
  readonly name: RaScenarioName;
  readonly started: number;
  readonly deadline: number;
  readonly checks: RaScenarioResult['checks'];
  readonly help: string[];
  readonly notes: Record<string, unknown>;
  nudged: boolean;
}

interface Sent {
  id: string;
  at: number;
  dispatchIds: string[];
}

const hex = (n: number) => randomBytes(n).toString('hex');

function grantSummary(grants: Grant[]) {
  const risk: Record<string, string> = {};
  for (const g of grants) if (RISK_KEYS.has(g.keyId)) risk[g.keyId] = g.tier;
  const can = grants.filter((g) => g.tier === 'can' && !RISK_KEYS.has(g.keyId)).map((g) => g.keyId);
  return {
    risk,
    on: can.length,
    defaultsMissing: AGENT_DEFAULT_KEYS.can.filter((k) => !can.includes(k)),
    ask: grants.filter((g) => g.tier === 'ask' && !RISK_KEYS.has(g.keyId)).map((g) => g.keyId),
    off: grants.filter((g) => g.tier === 'cannot').map((g) => g.keyId),
  };
}

/** A tiny HTTP server on this machine (the box's LAN): answers every request with `body` and records who asked. */
async function lanServer(host: string, body: string) {
  const hits: { at: string; from: string; path: string; agent: string }[] = [];
  const server = createServer((req, res) => {
    hits.push({
      at: new Date().toISOString(),
      from: req.socket.remoteAddress ?? '',
      path: req.url ?? '',
      agent: String(req.headers['user-agent'] ?? ''),
    });
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${body}\n`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function raCheck(st: St, progress?: (r: RaCheckResult) => void): Promise<RaCheckResult> {
  const result: RaCheckResult = {
    ok: false,
    at: new Date().toISOString(),
    burrow: null,
    setup: [],
    agent: {},
    scenarios: [],
  };
  const names = selectedScenarios(process.env.WB_RA_ONLY);
  const minutes = scenarioMinutes();
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    const t = Date.now();
    try {
      const detail = await fn();
      result.setup.push({ name, ok: true, ms: Date.now() - t, detail });
      return detail;
    } catch (err) {
      result.setup.push({
        name,
        ok: false,
        ms: Date.now() - t,
        detail: (err as Error).message.slice(0, 1500),
      });
      return null;
    }
  };

  let opened: Awaited<ReturnType<typeof personSession>> | null = null;
  await step('your app session through the relay', async () => {
    opened = await personSession(st);
    return { protocol: opened.info.protocol, account: opened.info.account?.id ?? null };
  });
  if (!opened) return result;
  const s: ApplianceSession = (opened as Awaited<ReturnType<typeof personSession>>).s;
  try {
    const w = await step('the burrow and its agent on Codex', () => setUp(s, result));
    if (!w) return result;
    result.burrow = w.slug;
    const b = { burrow: w.slug };
    const agent = w.agent;
    const nameOf = new Map<string, string>([
      [w.meId, 'You'],
      [agent.id, agent.name],
    ]);
    const events: Collected = collect(s, [`burrow:${w.burrowId}`, `conv:${w.chatId}`]);

    /* What the session saw and what the API says -------------------------------------------------------------- */

    const dispatches = (): Map<string, Dispatch> => {
      const m = new Map<string, Dispatch>();
      for (const e of events.events) {
        if (eventType(e) !== 'dispatch.updated') continue;
        const d = (e.event as { dispatch: Dispatch }).dispatch;
        const had = m.get(d.id);
        if (!had || (STATE_RANK[d.state] ?? 0) >= (STATE_RANK[had.state] ?? 0)) m.set(d.id, d);
      }
      return m;
    };

    const busy = async (since: number): Promise<boolean> => {
      for (const d of dispatches().values())
        if (d.agentId === agent.id && Date.parse(d.createdAt) >= since - 60_000 && !TERMINAL.has(d.state))
          return true;
      const ov = await api<{
        sections: { section: string; items: { kind: string; agentId: string | null }[] }[];
      }>(s, 'work.overview', 'GET', { params: b }).catch(() => null);
      if (
        ov?.sections.some(
          (x) =>
            (x.section === 'running' || x.section === 'queued') &&
            x.items.some((i) => i.kind === 'dispatch' && i.agentId === agent.id),
        )
      )
        return true;
      const p = await api<{ agent: { status: string } }>(s, 'agent.get', 'GET', { params: b }).catch(
        () => null,
      );
      return p?.agent.status === 'working';
    };

    const approvePending = async (r: Run) => {
      const pending = await api<{
        approvals: { number: number; requesterId: string; action: { type: string }; title: string }[];
      }>(s, 'approvals.list', 'GET', { params: b, query: { state: 'pending', limit: 20 } }).catch(() => ({
        approvals: [],
      }));
      for (const a of pending.approvals) {
        if (a.requesterId !== agent.id) continue;
        const scoped = a.action.type === 'run_command';
        const d = await s.call(
          { id: 'approvals.decide', method: 'POST' },
          {
            params: { ...b, number: a.number },
            query: {},
            body: { decision: 'approve', ...(scoped ? { scope: 'task' } : {}) },
          },
        );
        r.help.push(
          `approved #${a.number} for ${nameOf.get(a.requesterId)} (${a.action.type}): ${a.title} → ${d.status}`,
        );
      }
    };

    /** Waits until the agent's turns are over and nothing of its is queued, approving what it asks on the way. */
    const settle = async (r: Run, o: { quietMs?: number; maxMs?: number } = {}): Promise<boolean> => {
      const quiet = o.quietMs ?? 20_000;
      const until = Math.min(r.deadline, Date.now() + (o.maxMs ?? Number.POSITIVE_INFINITY));
      let calm: number | null = null;
      while (Date.now() < until) {
        await approvePending(r);
        if (await busy(r.started)) calm = null;
        else {
          calm ??= Date.now();
          if (Date.now() - calm >= quiet) return true;
        }
        await sleep(5000);
      }
      return false;
    };

    const waitFor = async <T>(
      r: Run,
      ms: number,
      every: number,
      probe: () => Promise<T | null | undefined | false>,
    ): Promise<T | null> => {
      const until = Math.min(r.deadline, Date.now() + ms);
      for (;;) {
        try {
          const v = await probe();
          if (v) return v;
        } catch {
          // read again
        }
        if (Date.now() >= until) return null;
        await sleep(Math.min(every, Math.max(500, until - Date.now())));
      }
    };

    /** A message in the person's Chat: top-level (a new thread) or a reply in `threadRootId`. */
    const send = async (
      r: Run,
      text: string,
      o: { threadRootId?: string; attachmentIds?: string[] } = {},
    ): Promise<Sent> => {
      const sent = await api<{
        message: { id: string; createdAt: string };
        dispatches: { dispatchId: string }[];
      }>(s, 'messages.send', 'POST', {
        params: { ...b, conversationId: w.chatId },
        body: {
          text,
          clientId: `ra-${r.name}-${hex(4)}`,
          ...(o.threadRootId ? { threadRootId: o.threadRootId } : {}),
          ...(o.attachmentIds ? { attachmentIds: o.attachmentIds } : {}),
        },
      });
      return {
        id: sent.message.id,
        at: Date.parse(sent.message.createdAt),
        dispatchIds: sent.dispatches.map((d) => d.dispatchId),
      };
    };

    /** Top-level messages and thread replies of the person's Chat since `since`, oldest first. */
    const transcript = async (since: number): Promise<Msg[]> => {
      const page = await api<{ messages: Msg[] }>(s, 'messages.list', 'GET', {
        params: { ...b, conversationId: w.chatId },
        query: { limit: 50 },
      });
      const out: Msg[] = [];
      for (const m of page.messages) {
        if (Date.parse(m.createdAt) >= since - 1000) out.push(m);
        if (m.replyCount && Date.parse(m.lastReplyAt ?? m.createdAt) >= since - 1000) {
          const th = await api<{ replies: Msg[] }>(s, 'messages.thread', 'GET', {
            params: { ...b, messageId: m.id },
          }).catch(() => ({ replies: [] as Msg[] }));
          out.push(...th.replies.filter((x) => Date.parse(x.createdAt) >= since - 1000));
        }
      }
      return out.sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
    };

    /** What the agent remembers about the person (`memory.mine`, contracts 0.125 CT-1202): the profile's two files. */
    const memory = () => api<Remembered>(s, 'memory.mine', 'GET', { params: b });
    const remembered = (m: Remembered) => `${m.user.text}\n${m.memory.text}`.trim();

    /** What the agent posted in the Chat since `since` (in `threadRootId`'s thread only, when given). */
    const said = async (since: number, threadRootId?: string) =>
      (await transcript(since)).filter(
        (m) =>
          m.authorId === agent.id &&
          (!threadRootId || m.threadRootId === threadRootId || m.id === threadRootId),
      );

    const textOf = (msgs: Msg[]) => msgs.map((m) => m.text).join('\n');

    /** One “go ahead” in the thread when the agent's last word was a question and the work isn't done (help). */
    const nudge = async (r: Run, threadRootId: string): Promise<boolean> => {
      if (r.nudged || Date.now() > r.deadline - 60_000) return false;
      const last = (await said(r.started, threadRootId)).filter((m) => !m.card).at(-1);
      if (!last || !questionsIn(last.text).length) return false;
      r.nudged = true;
      await send(r, NUDGE, { threadRootId });
      r.help.push(
        `answered ${agent.name}’s question (“${short(questionsIn(last.text).at(-1) ?? '', 160)}”) with “${NUDGE}”`,
      );
      return true;
    };

    /**
     * Asks (a new thread, or in `threadRootId`'s), waits for the turn(s), and gives one “go ahead” when the agent
     * stopped at a question before `done`.
     */
    const ask = async <T>(
      r: Run,
      text: string,
      done: () => Promise<T | null | undefined | false>,
      o: { threadRootId?: string; attachmentIds?: string[] } = {},
    ): Promise<{ sent: Sent; value: T | null }> => {
      const sent = await send(r, text, o);
      await settle(r);
      let value = (await done().catch(() => null)) || null;
      if (!value && (await nudge(r, o.threadRootId ?? sent.id))) {
        await settle(r);
        value = (await done().catch(() => null)) || null;
      }
      return { sent, value };
    };

    const check = (r: Run, name: string, ok: boolean, detail?: unknown) => {
      r.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
      return ok;
    };

    const spend = async (): Promise<SpendSnapshot | null> => {
      type Totals = {
        turns: number;
        inputTokens: number;
        outputTokens: number;
        costUsd: number | null;
      } & SpendCache;
      const o = await api<{ totals: { week: Totals } }>(s, 'spend.overview', 'GET', { params: b }).catch(
        () => null,
      );
      if (!o) return null;
      return {
        turns: o.totals.week.turns,
        inputTokens: o.totals.week.inputTokens,
        outputTokens: o.totals.week.outputTokens,
        ...spendCache(o.totals.week),
        costUsd: o.totals.week.costUsd,
      };
    };

    const activity = async (ids: string[]): Promise<string[]> => {
      const lines: string[] = [];
      for (const id of ids) {
        const a = await api<{
          activities: {
            agentId: string;
            tool: string;
            title: string;
            object: string | null;
            detail: string | null;
            status: string;
          }[];
        }>(s, 'activity.list', 'GET', { params: b, query: { dispatchId: id, limit: 200 } }).catch(() => null);
        for (const x of a?.activities ?? [])
          lines.push(
            short(
              `${nameOf.get(x.agentId) ?? x.agentId} ${id.slice(-6)} · ${x.title}${x.object ? ` · ${x.object}` : ''}${x.detail ? ` (${x.detail})` : ''}${x.status === 'failed' ? ' [failed]' : ''}`,
              260,
            ),
          );
      }
      return lines.slice(0, 120);
    };

    const upload = async (file: string, type: string): Promise<string> => {
      const bytes = new Uint8Array(readFileSync(file));
      const reserved = await api<{
        attachment: { id: string };
        uploadUrl: string;
        headers: Record<string, string>;
      }>(s, 'uploads.create', 'POST', {
        params: b,
        body: { conversationId: w.chatId, name: basename(file), contentType: type, size: bytes.byteLength },
      });
      const up = s as unknown as {
        upload(
          target: {
            burrow: string;
            attachmentId: string;
            http: { uploadUrl: string; headers: Record<string, string> };
          },
          source: {
            name: string;
            type: string;
            size: number;
            read(o: number, n: number): Promise<Uint8Array>;
          },
        ): Promise<unknown>;
      };
      const done = (await up.upload(
        {
          burrow: w.slug,
          attachmentId: reserved.attachment.id,
          http: { uploadUrl: reserved.uploadUrl, headers: reserved.headers },
        },
        { name: basename(file), type, size: bytes.byteLength, read: async (o, n) => bytes.slice(o, o + n) },
      )) as { attachment?: { id: string; state?: string } };
      return done.attachment?.id ?? reserved.attachment.id;
    };

    /* The scenarios -------------------------------------------------------------------------------------------- */

    const SCENARIOS: Record<RaScenarioName, { title: string; run: (r: Run) => Promise<void> }> = {
      learn: {
        title: 'Learns a preference in one thread and uses it in another',
        run: async (r) => {
          // What an earlier run taught is forgotten first, so the learning shows.
          const before = await memory();
          if (remembered(before)) await api(s, 'memory.clear', 'DELETE', { params: b });
          r.notes.memoryBefore = { user: short(before.user.text), memory: short(before.memory.text) };
          // Hermes writes memory in the turn or in its review after it: what counts is that it is there.
          const told = await ask(r, 'From now on answer me in Dutch, please.', async () => {
            const m = await memory();
            return /dutch|nederlands/i.test(remembered(m)) ? m : null;
          });
          const m = told.value ?? (await memory());
          check(r, 'the agent remembers something about you', remembered(m).length > 0, {
            user: m.user.text,
            memory: m.memory.text,
          });
          check(r, '… saying Dutch', /dutch|nederlands/i.test(remembered(m)));
          const q = await ask(r, 'Which port does SSH use by default? One sentence.', async () => {
            const m = await said(r.started);
            return m.length ? m : null;
          });
          const answer = textOf(await said(q.sent.at, q.sent.id));
          const score = dutchScore(answer);
          check(r, 'the agent answers in the new thread', answer.length > 0, short(answer));
          check(r, '… in Dutch', score.isDutch, { ...score, answer: short(answer) });
        },
      },

      schedule: {
        title: 'Schedules a reminder that fires in the thread',
        run: async (r) => {
          const asked = await ask(
            r,
            'Stretch break ☕ Please remind me here in this thread in 5 minutes to stretch my legs.',
            async () => {
              const list = await api<{ schedules: Schedule[] }>(s, 'schedules.list', 'GET', { params: b });
              return list.schedules.find((x) => Date.parse(x.createdAt) >= r.started - 5000) ?? null;
            },
          );
          const root = asked.sent;
          const sch = asked.value;
          check(r, 'schedules.list shows a new schedule, active', sch?.status === 'active', sch);
          if (!sch?.nextAt) return;
          check(r, '… in this thread', sch.conversationId === w.chatId && sch.threadRootId === root.id, {
            conversationId: sch.conversationId,
            threadRootId: sch.threadRootId,
            root: root.id,
          });
          const inMin = (Date.parse(sch.nextAt) - root.at) / 60_000;
          check(
            r,
            '… due in about 5 minutes',
            inMin >= 3.5 && inMin <= 7,
            `${inMin.toFixed(1)} min after the ask`,
          );
          const card = (await said(r.started)).find((m) => m.card?.kind === 'schedule');
          r.notes.card = card ? short(card.text) : null;
          const due = Date.parse(sch.nextAt);
          const fired = await waitFor(r, Math.max(0, due - Date.now()) + 5 * 60_000, 15_000, async () =>
            (await said(r.started)).find(
              (m) =>
                m.threadRootId === root.id &&
                Date.parse(m.createdAt) >= due - 1000 &&
                m.card?.kind !== 'schedule',
            ),
          );
          check(
            r,
            'the reminder posted in the thread when due',
            !!fired,
            fired && { at: fired.createdAt, text: short(fired.text) },
          );
          if (fired) r.notes.lateSeconds = Math.round((Date.parse(fired.createdAt) - due) / 1000);
          const turn = [...dispatches().values()].find(
            (d) => d.agentId === agent.id && d.trigger === 'schedule' && Date.parse(d.createdAt) >= r.started,
          );
          r.notes.scheduleTurn = turn ? `${turn.state} (${turn.id})` : 'not seen in the events';
          const ended = await waitFor(r, 60_000, 10_000, async () => {
            const list = await api<{ schedules: Schedule[] }>(s, 'schedules.list', 'GET', { params: b });
            const x = list.schedules.find((y) => y.id === sch.id);
            return x?.status === 'ended' ? x : null;
          });
          check(
            r,
            'the one-off schedule ended as done after its run',
            ended?.endedReason === 'done',
            ended && {
              status: ended.status,
              endedReason: ended.endedReason,
              runs: ended.runs,
            },
          );
        },
      },

      notify: {
        title: 'A background job wakes the agent',
        run: async (r) => {
          const marker = `job-${hex(3)}`;
          const pillOf = async (since: number) =>
            (await said(since)).find((m) => m.card?.kind === 'pill' && m.text.includes(marker));
          const asked = await ask(
            r,
            `Start a background job that waits 60 seconds and then runs: whombat notify "Background job ${marker} finished". Start it and end your turn; don't wait for it.`,
            async () => (await pillOf(r.started)) ?? (await said(r.started)).length > 0,
          );
          const first = asked.sent.dispatchIds.map((id) => dispatches().get(id)).find(Boolean);
          const pill = await waitFor(r, 6 * 60_000, 10_000, () => pillOf(r.started));
          check(
            r,
            'the job’s words came back in the Chat',
            !!pill,
            pill && { at: pill.createdAt, text: short(pill.text), card: pill.card?.text },
          );
          if (first?.finishedAt && pill)
            check(
              r,
              'the agent’s turn ended before the job did (it didn’t wait)',
              Date.parse(first.finishedAt) < Date.parse(pill.createdAt),
              { turnEnded: first.finishedAt, jobPosted: pill.createdAt },
            );
          else r.notes.firstTurn = first ?? 'not seen in the events';
          if (!pill) return;
          const woke = await waitFor(r, 5 * 60_000, 5000, async () => {
            const d = [...dispatches().values()].find(
              (x) =>
                x.agentId === agent.id &&
                x.trigger === 'notify' &&
                Date.parse(x.createdAt) >= Date.parse(pill.createdAt) - 2000 &&
                TERMINAL.has(x.state),
            );
            const reply = (await said(Date.parse(pill.createdAt) + 1)).find((m) => m.id !== pill.id);
            return d || reply ? { turn: d ?? null, reply: reply ?? null } : null;
          });
          check(
            r,
            'the job woke the agent for a turn of its own (trigger notify)',
            woke?.turn?.state === 'done' || (!woke?.turn && !!woke?.reply),
            woke && {
              turn: woke.turn && `${woke.turn.state} ${woke.turn.id}`,
              reply: woke.reply && short(woke.reply.text),
            },
          );
        },
      },

      lan: {
        title: 'Reaches an address on the LAN',
        run: async (r) => {
          const marker = `lan-${hex(3)}`;
          const server = await lanServer(LAN_HOST, `Hello from the LAN, ${marker}`);
          try {
            const burrow = await api<{ burrow: { agentsReachLan?: boolean } }>(s, 'burrows.get', 'GET', {
              params: b,
            });
            r.notes.agentsReachLan = burrow.burrow.agentsReachLan ?? '(absent: on)';
            const url = `http://${LAN_HOST}:${server.port}/`;
            const asked = await ask(
              r,
              `Fetch ${url} and tell me the HTTP status code and the body.`,
              async () => {
                const t = textOf(await said(r.started));
                return t.includes(marker) ? t : null;
              },
            );
            const reply = asked.value ?? textOf(await said(r.started));
            check(
              r,
              'the server on this machine was reached from the box',
              server.hits.length > 0,
              server.hits.slice(0, 5),
            );
            check(r, 'the agent reports status 200', /\b200\b/.test(reply), short(reply));
            check(r, '… and the body', reply.includes(marker), short(reply));
          } finally {
            await server.close();
          }
        },
      },

      ocr: {
        title: 'Reads a scanned invoice',
        run: async (r) => {
          if (!INVOICE) throw new Error('no invoice image (WB_RA_INVOICE; dev/devbox ra-check makes it)');
          const attachment = await upload(INVOICE, 'image/jpeg');
          const asked = await ask(
            r,
            'What are the invoice number and the total on this scan?',
            async () => {
              const t = textOf(await said(r.started));
              const f = invoiceFigures(t);
              return f.number && f.total ? t : null;
            },
            { attachmentIds: [attachment] },
          );
          const reply = asked.value ?? textOf(await said(r.started));
          const f = invoiceFigures(reply);
          check(r, 'the reply has the invoice number 4711', f.number, short(reply));
          check(r, '… and the total € 99,50', f.total, short(reply));
        },
      },

      correction: {
        title: 'A corrected preference replaces the earlier language preference',
        run: async (r) => {
          // Seed this scenario independently, including when WB_RA_ONLY=correction.
          await ask(
            r,
            'For this evaluation, please remember that I prefer replies in Dutch. Save this as my reply-language preference.',
            async () => {
              const current = await memory();
              return /dutch|nederlands/i.test(remembered(current)) ? current : null;
            },
          );
          await ask(
            r,
            'Correction: answer me in English from now on, replacing my earlier Dutch preference. Please remember this.',
            async () => {
              const current = remembered(await memory());
              return /english|engels/i.test(current) &&
                !/prefers dutch|in het nederlands|in dutch/i.test(current)
                ? current
                : null;
            },
          );
          const current = await memory();
          check(r, 'the corrected language is stored', /english|engels/i.test(remembered(current)), {
            user: current.user.text,
            memory: current.memory.text,
          });
          const answer = await ask(r, 'Which port does SSH use by default? One sentence.', async () => {
            const replies = await said(r.started);
            return replies.length ? replies : null;
          });
          const words = textOf(await said(answer.sent.at, answer.sent.id));
          check(
            r,
            'a new thread is answered in English after the correction',
            /\b(port|default|uses)\b/i.test(words) && !dutchScore(words).isDutch,
            words,
          );
        },
      },
      recovery: {
        title: 'The agent diagnoses a failed command and produces the requested artifact',
        run: async (r) => {
          const marker = `AO-${hex(5)}`;
          const answer = await ask(
            r,
            `In a new folder under ~/work, create result.txt containing exactly ${marker}. First try copying it from missing-input.txt, which deliberately does not exist; inspect that failure and complete the task another way. Read result.txt back and report its contents.`,
            async () => {
              const replies = await said(r.started);
              return replies.some((m) => m.text.includes(marker)) ? replies : null;
            },
          );
          const turns = [...dispatches().values()].filter(
            (d) => d.agentId === agent.id && Date.parse(d.createdAt) >= r.started - 1000,
          );
          const observed = await activity(turns.map((d) => d.id));
          check(r, 'the requested marker was returned', textOf(answer.value ?? []).includes(marker));
          check(
            r,
            'a failed command is visible before recovery',
            observed.some((line) => /failed|exit 1|no such file/i.test(line)),
            observed,
          );
          const evidence = (
            await Promise.all(
              turns.map((d) =>
                api<{
                  activities: {
                    kind: string;
                    status: string;
                    exitCode: number | null;
                    object: string | null;
                    title: string;
                    detail: string | null;
                  }[];
                }>(s, 'activity.list', 'GET', { params: b, query: { dispatchId: d.id, limit: 200 } }),
              ),
            )
          ).flatMap((page) => page.activities);
          check(
            r,
            'the artifact has a successful observed read',
            evidence.some(
              (item) =>
                item.status === 'done' &&
                (item.exitCode === null || item.exitCode === 0) &&
                (item.kind === 'read' || /\bcat\b/.test(item.title)) &&
                /result\.txt/.test(`${item.object ?? ''} ${item.title}`),
            ),
            evidence,
          );
        },
      },
    };

    /* Running them --------------------------------------------------------------------------------------------- */

    try {
      for (const name of names) {
        const def = SCENARIOS[name];
        const started = Date.now();
        const r: Run = {
          name,
          started,
          deadline: started + minutes * 60_000,
          checks: [],
          help: [],
          notes: {},
          nudged: false,
        };
        const before = await spend();
        let error: string | undefined;
        process.stderr.write(`ra-check: ${name} — ${def.title}\n`);
        try {
          await def.run(r);
        } catch (err) {
          error = (err as Error).message.slice(0, 1500);
        }
        // The last turns post before the read-back (a minute at most).
        await settle(r, { quietMs: 10_000, maxMs: 60_000 }).catch(() => false);
        const after = await spend();
        const mine = await said(started).catch(() => [] as Msg[]);
        const turns = [...dispatches().values()]
          .filter((d) => d.agentId === agent.id && Date.parse(d.createdAt) >= started - 1000)
          .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
        const sc: RaScenarioResult = {
          name,
          title: def.title,
          ok: !error && r.checks.length > 0 && r.checks.every((c) => c.ok),
          startedAt: new Date(started).toISOString(),
          seconds: Math.round((Date.now() - started) / 1000),
          withoutHelp: r.help.length === 0,
          help: r.help,
          questions: mine.flatMap((m) =>
            questionsIn(m.text).map((q) => `${nameOf.get(m.authorId)}: ${short(q, 200)}`),
          ),
          replies: mine.map(
            (m) =>
              `${nameOf.get(m.authorId)}${m.threadRootId ? ' (thread)' : ''}: ${m.card ? `[${m.card.kind}${m.card.text ? ` · ${m.card.text}` : ''}] ` : ''}${short(m.text, 500)}`,
          ),
          turns: turns.map(
            (d) =>
              `${nameOf.get(d.agentId)} ${d.trigger} ${d.state}${d.finishedAt && d.claimedAt ? ` ${Math.round((Date.parse(d.finishedAt) - Date.parse(d.claimedAt)) / 1000)} s` : ''}${d.failure ? ` · ${d.failure.code}: ${d.failure.reason}` : d.reason ? ` · ${d.reason}` : ''}`,
          ),
          did: await activity(turns.map((d) => d.id)),
          tokens: before && after ? spendDelta(before, after) : null,
          checks: r.checks,
          notes: r.notes,
          ...(error ? { error } : {}),
        };
        result.scenarios.push(sc);
        process.stderr.write(`ra-check: ${sc.ok ? 'ok' : 'FAIL'} ${name} (${sc.seconds} s)\n`);
        progress?.(result);
      }
      // What the run left behind: what the agent keeps about the person, the notes (RA-21) and its schedules.
      const p = { params: b };
      const notes = await api<{ text: string }>(s, 'memory.notes', 'GET', p).catch(() => null);
      const sch = await api<{ schedules: Schedule[] }>(s, 'schedules.list', 'GET', p).catch(() => null);
      const mine = await memory().catch(() => null);
      result.final = {
        memory: mine && { user: mine.user.text, memory: mine.memory.text },
        agent: {
          name: agent.name,
          notes: notes?.text ?? null,
          schedules:
            sch?.schedules.map(
              (x) => `${x.status}${x.endedReason ? ` (${x.endedReason})` : ''} · runs ${x.runs}`,
            ) ?? null,
        },
      };
      progress?.(result);
    } finally {
      events.close();
    }
  } finally {
    s.close('closed');
  }
  result.ok =
    result.setup.every((x) => x.ok) &&
    result.scenarios.length === names.length &&
    result.scenarios.every((x) => x.ok);
  return result;
}

/** The box's one burrow (IN-395), its agent on Codex, and the person's Chat with it. */
async function setUp(s: ApplianceSession, result: RaCheckResult): Promise<World> {
  const ops = sessionOps as unknown as {
    providersList(s: ApplianceSession): Promise<{ signIns: { provider: string }[] }>;
  };
  if (!(await ops.providersList(s)).signIns.some((x) => x.provider === 'codex'))
    throw new Error('nobody signed in to Codex on the box: dev/devbox deploy-check signs you in once');
  // The agent runs on Codex, the way deploy-check sets it (`agent.update`).
  const w = await ensureWorkspace(s, 'Dev box', { provider: 'codex' });
  const b = { burrow: w.slug };
  const profile = await api<{
    agent: { runtime?: { provider?: string; model?: string } };
    grants: Grant[];
  }>(s, 'agent.get', 'GET', { params: b }).catch(() => null);
  // Its skills (`skills.library`, contracts 0.125 CT-1210): how many it has, which are off, which aren't shipped (added
  // or learned).
  const library = await api<{ items: { name: string; source: string; status: string }[] }>(
    s,
    'skills.library',
    'GET',
    { params: b },
  ).catch(() => null);
  result.agent = {
    name: w.agent.name,
    handle: w.agent.handle,
    runtime: profile?.agent.runtime ?? null,
    keys: profile ? grantSummary(profile.grants) : null,
    skills: library
      ? {
          count: library.items.length,
          off: library.items.filter((x) => x.status === 'off').map((x) => x.name),
          own: library.items.filter((x) => x.source !== 'shipped').map((x) => `${x.name} (${x.source})`),
        }
      : null,
  };
  return {
    slug: w.slug,
    burrowId: w.burrowId,
    meId: w.mePrincipalId,
    chatId: w.conversationId,
    agent: w.agent,
  };
}
