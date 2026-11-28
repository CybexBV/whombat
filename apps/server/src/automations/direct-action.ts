/**
 * What a `run_action` step does (docs/decisions/direct-automations.md): one action from the allowlist, through the
 * person's own connection as their assistant would call it (`executeConnectionCall`: the same limits, settings, signed
 * lines and Done recently), with no AI turn. A server's power goes through the Servers connection (`server_power`,
 * `guest_power`), Home Assistant through its `request` tool (`POST /api/services/<domain>/<service>`). Turning the
 * automation on was the person's yes for exactly this; a call the person's own rules make ask (a server set to “Ask
 * me first”, the server this Whombat runs on, a tool set to ask) asks on the approval card. A thing already so is a
 * quiet no-op with its own line.
 */
import {
  type AutomationStep,
  type CatalogEntry,
  catalogEntry,
  type DirectOutcome,
  directActionProblem,
  directActionText,
  directDoneLine,
  directTargetKind,
  entityDomain,
  lookOnlyText,
  REQUEST_TOOL_NAME,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import { callTier, executeConnectionCall, needsReauthText } from '../connections/call';
import { callTarget } from '../connections/call-target';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db, Tx } from '../db/client';
import { burrows, catalogConnections, connectionTools } from '../db/schema/index';
import { thePerson } from '../domain/the-person';
import { callServerOf, SERVERS_CATALOG } from '../hosts/asks';
import { hostsFor } from '../hosts/service';
import type { Services } from '../services';
import { clock } from '../things/words';
import { automationAgent, publisherCheck } from './authority';
import type { LeasedRun } from './engine/step-ops';
import type { AutomationStepRow } from './store';

type RunActionStep = Extract<AutomationStep, { kind: 'run_action' }>;
type ToolRow = typeof connectionTools.$inferSelect;

/** How a step would run now, or why it can't (`fatal`: never, whatever `otherwise` says). */
export type DirectPlan =
  | { ok: false; reason: string; fatal: boolean; gone?: true }
  | {
      ok: true;
      conn: CatalogConnectionRow;
      entry: CatalogEntry;
      tool: ToolRow;
      args: Record<string, unknown>;
      /** The person's own rules ask for a fresh yes on this call. */
      asks: boolean;
      /** A server the call names that runs this Whombat, or a server Whombat hasn't seen: the card says so. */
      server: { id: string; name: string } | null;
    };

const POWER: Record<string, string> = {
  restart: 'reboot',
  shut_down: 'shutdown',
  start: 'start',
  stop: 'stop',
};

/** The call a step makes: its tool and arguments (pure). */
export function directCall(step: RunActionStep): { tool: string; args: Record<string, unknown> } | null {
  const kind = directTargetKind(step);
  if (kind === 'server')
    return { tool: 'server_power', args: { server: idOf(step.thing), action: POWER[step.action] } };
  if (kind === 'machine')
    return {
      tool: 'guest_power',
      args: { server: idOf(step.thing), guest: step.target, action: POWER[step.action] },
    };
  if (kind === 'home')
    return {
      tool: REQUEST_TOOL_NAME,
      args: { method: 'POST', path: '/api/services/homeassistant/restart', body: {} },
    };
  if (kind === 'entity' && step.target)
    return {
      tool: REQUEST_TOOL_NAME,
      args: {
        method: 'POST',
        path: `/api/services/${entityDomain(step.target)}/${step.action}`,
        body: { entity_id: step.target },
      },
    };
  return null;
}

const idOf = (thing: string) => thing.slice(thing.indexOf(':') + 1);

/** How the step would run now: the connection, the tool, the call, and whether the person's rules ask. */
export async function planDirectAction(
  db: Db | Tx,
  services: Services,
  burrowId: string,
  step: RunActionStep,
): Promise<DirectPlan> {
  const problem = directActionProblem(step);
  if (problem) return { ok: false, reason: problem, fatal: true };
  const call = directCall(step);
  if (!call) return { ok: false, reason: 'This can’t be done directly.', fatal: true };
  const onServer = step.thing.startsWith('server:');
  const [conn] = await db
    .select()
    .from(catalogConnections)
    .where(
      onServer
        ? and(eq(catalogConnections.burrowId, burrowId), eq(catalogConnections.catalogId, SERVERS_CATALOG))
        : and(eq(catalogConnections.burrowId, burrowId), eq(catalogConnections.id, idOf(step.thing))),
    );
  if (!conn)
    return {
      ok: false,
      reason: onServer
        ? `Whombat can’t reach ${step.thingName}: no servers are connected.`
        : `${step.thingName} isn’t connected any more.`,
      fatal: false,
      gone: true,
    };
  if (!onServer && conn.catalogId !== 'homeassistant')
    return { ok: false, reason: 'Only Home Assistant can be acted on directly this way.', fatal: true };
  if (conn.status !== 'active')
    return {
      ok: false,
      reason: onServer ? `Whombat can’t reach your servers just now.` : needsReauthText(conn),
      fatal: false,
    };
  const entry = catalogEntry(conn.catalogId);
  if (!entry)
    return { ok: false, reason: `${conn.label} isn’t connected any more.`, fatal: false, gone: true };
  const [tool] = await db
    .select()
    .from(connectionTools)
    .where(and(eq(connectionTools.connectionId, conn.id), eq(connectionTools.name, call.tool)));
  if (!tool) return { ok: false, reason: `${conn.label} can’t do that.`, fatal: false, gone: true };
  const server = await callServerOf(db, services, burrowId, conn.catalogId, call.args);
  // The plan's yes is the key: what still asks is what the person set to ask, and the catalog's own rules.
  const decided = callTier(entry, tool, call.args, 'can', conn.access, server);
  if (decided.lookOnly) return { ok: false, reason: lookOnlyText(conn.label), fatal: false };
  if (decided.toolTier === 'off' || decided.tier === 'off')
    return { ok: false, reason: `${conn.label} is set not to do this.`, fatal: false };
  return {
    ok: true,
    conn,
    entry,
    tool,
    args: call.args,
    asks: decided.tier === 'ask',
    server: server ? { id: server.id, name: server.name } : null,
  };
}

/* Already so ------------------------------------------------------------------------------------------------------------ */

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Whether the thing is already as the step would leave it (a server off, a light on), read just before: the quiet
 * no-op. Null when it isn't, or Whombat can't tell (then the action runs; doing it twice does no harm).
 */
async function alreadySo(
  services: Services,
  plan: Extract<DirectPlan, { ok: true }>,
  step: RunActionStep,
): Promise<DirectOutcome | null> {
  const kind = directTargetKind(step);
  try {
    if (kind === 'server' && step.action === 'shut_down') {
      const fleet = rec(await hostsFor(services).fleetRaw());
      const id = idOf(step.thing).toLowerCase();
      const server = (Array.isArray(fleet.servers) ? fleet.servers : [])
        .map(rec)
        .find((s) => String(s.id ?? '').toLowerCase() === id);
      return server?.status === 'offline' ? { kind: 'noop', already: 'off' } : null;
    }
    if (kind === 'entity' && step.target && (step.action === 'turn_on' || step.action === 'turn_off')) {
      const domain = entityDomain(step.target);
      if (domain === 'scene' || domain === 'script') return null;
      // Loaded here, as `steps.ts` is below: the connection modules reach this one through the automation commands.
      const { getJson } = await import('../things/kinds/read');
      const state = rec(
        await getJson(services, plan.conn, plan.conn.label, `/api/states/${step.target}`),
      ).state;
      const want = step.action === 'turn_on' ? 'on' : 'off';
      return state === want ? { kind: 'noop', already: want } : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** A machine the hosts service found already in the state asked for (`guest_power`'s note). */
function machineNoop(step: RunActionStep, structured: unknown, content: string): DirectOutcome | null {
  let out = rec(structured);
  if (!Object.keys(out).length)
    try {
      out = rec(JSON.parse(content));
    } catch {
      out = {};
    }
  if (typeof out.note !== 'string') return null;
  return { kind: 'noop', already: step.action === 'start' ? 'running' : 'stopped' };
}

const RESULT: Partial<Record<RunActionStep['action'], 'switching_off' | 'restarting' | 'starting'>> = {
  shut_down: 'switching_off',
  restart: 'restarting',
  start: 'starting',
};

/* The effect -------------------------------------------------------------------------------------------------------------- */

/** The step's settle when it can't run: skipped (the run goes on) or blocked, as `otherwise` says. */
function cannot(
  lease: LeasedRun,
  row: AutomationStepRow,
  step: RunActionStep,
  reason: string,
  fatal: boolean,
) {
  return lease.commit({
    op: 'settle',
    idx: row.idx,
    state: fatal || step.otherwise === 'fail' ? 'blocked' : 'skipped',
    error: reason.slice(0, 1000),
    output: { ran: false, text: reason.slice(0, 500), summary: reason.slice(0, 500) },
    from: ['running'],
  });
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * A `run_action` step marked `running` (outside any transaction): its plan checked again, the quiet no-op when the
 * thing is already so, then the call, and the step settled with its one line (“Shut down nas-01 at 21:14 — it’s
 * switching off.”). A failure skips the step when `otherwise` says so (one server that can't be reached mustn't keep
 * the others on), else fails it; a restart that didn't answer in time may have happened, so a person checks.
 */
export async function runDirectAction(
  lease: LeasedRun,
  row: AutomationStepRow,
  step: RunActionStep,
): Promise<void> {
  const { services, run } = lease;
  const db = services.db;
  const who = await publisherCheck(db, run.burrowId, run.publishedById);
  if (!who.ok) return void (await cannot(lease, row, step, who.reason, true));
  // Loaded here: `steps.ts` reaches this module through its step handlers, so a static import would be a cycle.
  const { stepRoomsCheck } = await import('./steps');
  const rooms = await stepRoomsCheck(db, run, row.idx, who.publisher);
  if (!rooms.ok) return void (await cannot(lease, row, step, rooms.reason, true));
  const out = row.output as { approvalId?: string; callId?: string; target?: string };
  const plan = await planDirectAction(db, services, run.burrowId, step);
  if (!plan.ok) return void (await cannot(lease, row, step, plan.reason, plan.fatal));
  // A call the person's rules ask for runs only with the yes this attempt got.
  if (plan.asks && !out.approvalId)
    return void (await lease.commit({ op: 'settle', idx: row.idx, state: 'pending', from: ['running'] }));
  const agent = await automationAgent(db, run.burrowId);
  if (!agent) return void (await cannot(lease, row, step, 'The assistant isn’t available.', false));
  const [burrow] = await db
    .select({ timeZone: burrows.timeZone })
    .from(burrows)
    .where(eq(burrows.id, run.burrowId));
  const at = () => clock(services.clock(), burrow?.timeZone ?? 'UTC');

  const already = await alreadySo(services, plan, step);
  if (already) {
    const line = directDoneLine(step, already, at());
    await lease.commit({
      op: 'settle',
      idx: row.idx,
      state: 'succeeded',
      output: { ran: false, noop: true, text: line, summary: line },
      from: ['running'],
    });
    return;
  }

  const person = await thePerson(db, run.burrowId);
  const res = await executeConnectionCall(services, {
    burrowId: run.burrowId,
    agentId: agent.id,
    connectionId: plan.conn.id,
    tool: plan.tool.name,
    handle: plan.conn.handle,
    callId: out.callId ?? `${run.id}:${step.id}:${row.attempt}`,
    args: plan.args,
    where: null,
    conversationId: run.conversationId,
    personId: person?.id ?? null,
    threadRootId: run.threadRootId,
    change: directActionText(step),
    approvalId: out.approvalId ?? null,
    target: out.target ?? callTarget(plan.conn),
  });
  const status = res.kind === 'ok' ? res.output.httpStatus : undefined;
  const failed =
    res.kind === 'failed' || res.output.isError || (status !== undefined && (status < 200 || status >= 300));
  if (failed) {
    const timedOut = res.kind === 'failed' && res.reason === 'timeout';
    const reason =
      res.kind === 'failed'
        ? res.message
        : status
          ? `${plan.conn.label} answered with an error (HTTP ${status}).`
          : `${plan.conn.label} said it couldn’t do it.`;
    const line = `Couldn’t ${lowerFirst(directActionText(step))}: ${reason}`;
    await lease.commit({
      op: 'settle',
      idx: row.idx,
      // A restart that didn't answer in time may have happened: doing it again would restart twice.
      state:
        timedOut && step.action === 'restart'
          ? 'uncertain'
          : step.otherwise === 'skip'
            ? 'skipped'
            : 'failed',
      error: (timedOut && step.action === 'restart'
        ? `${reason} It may or may not have restarted. Check, then say what happened.`
        : line
      ).slice(0, 1000),
      output: { ran: false, text: line.slice(0, 500), summary: line.slice(0, 500) },
      from: ['running'],
    });
    return;
  }
  const outcome: DirectOutcome = (directTargetKind(step) === 'machine' && res.kind === 'ok'
    ? machineNoop(step, res.output.structured, res.output.content)
    : null) ?? { kind: 'done', result: RESULT[step.action] ?? null };
  const line = directDoneLine(step, outcome, at());
  await lease.commit({
    op: 'settle',
    idx: row.idx,
    state: 'succeeded',
    output: {
      ran: outcome.kind === 'done',
      ...(outcome.kind === 'noop' ? { noop: true } : {}),
      text: line,
      summary: line,
    },
    from: ['running'],
  });
}
