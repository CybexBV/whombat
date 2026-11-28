/**
 * What a `run_action` step does (docs/decisions/direct-automations.md): one action from the allowlist, through the
 * person's own connection as their assistant would call it (`executeConnectionCall`: the same limits, settings, signed
 * lines and Done recently), with no AI turn. A server's power goes through the Servers connection (`server_power`,
 * `guest_power`), Home Assistant through its `request` tool (`POST /api/services/<domain>/<service>`). Turning the
 * automation on was the person's yes for exactly this; a call the person's own rules make ask (a server set to “Ask
 * me first”, the server this Whombat runs on, a tool set to ask), a scene or a script saved before they were taken out,
 * and every action of a test run ask on the approval card. A thing already so is a quiet no-op with its own line; a
 * server Whombat can't reach is left alone and said so.
 */
import {
  type AutomationDefinition,
  type AutomationStep,
  type CatalogEntry,
  catalogEntry,
  type DirectOutcome,
  directActionAsksEachTime,
  directActionProblem,
  directActionRepeatable,
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
import { limitsProblem } from '../connections/limits';
import type { CatalogConnectionRow } from '../connections/types';
import type { Db, Tx } from '../db/client';
import { burrows, catalogConnections, connectionTools } from '../db/schema/index';
import { limitWordsFor } from '../devices/store';
import { thePerson } from '../domain/the-person';
import { callServerOf, SERVERS_CATALOG } from '../hosts/asks';
import { type HostsChange, type HostsService, hostsFor } from '../hosts/service';
import { isEnglish, tServer } from '../i18n/catalog';
import { burrowLocale } from '../i18n/locale';
import type { Services } from '../services';
import { clock } from '../things/words';
import { automationAgent, publisherCheck } from './authority';
import type { LeasedRun } from './engine/step-ops';
import type { AutomationRunRow, AutomationStepRow } from './store';

type RunActionStep = Extract<AutomationStep, { kind: 'run_action' }>;
type ToolRow = typeof connectionTools.$inferSelect;

/** What a step acts on, as Whombat names it now. */
export interface DirectNames {
  thingName: string;
  /** Absent: Whombat can't read the target's name just now, so its id stands in for it. */
  targetName?: string;
}

/** How a step would run now, or why it can't (`fatal`: never, whatever `otherwise` says). */
export type DirectPlan =
  | { ok: false; reason: string; fatal: boolean; gone?: true }
  | {
      ok: true;
      conn: CatalogConnectionRow;
      entry: CatalogEntry;
      tool: ToolRow;
      args: Record<string, unknown>;
      /** The person's own rules ask for a fresh yes on this call, or it starts a scene or a script. */
      asks: boolean;
      /** A server the call names that runs this Whombat, or a server Whombat hasn't seen: the card says so. */
      server: { id: string; name: string } | null;
      /** The names of what it acts on as Whombat knows them now: every card and line says these (`withNames`). */
      names: DirectNames;
    };

/** The step with the names Whombat knows now in place of the ones it was saved with, for its words. */
export function withNames(step: RunActionStep, names: DirectNames): RunActionStep {
  const { targetName: _saved, ...rest } = step;
  return {
    ...rest,
    thingName: names.thingName,
    ...(names.targetName ? { targetName: names.targetName } : {}),
  };
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * The names of what a step acts on as Whombat knows them now: the server's (as its pages call it), its machine's from
 * the hosts service's list, Home Assistant's label and the entity's own friendly name. The names the assistant wrote
 * are never used: nothing checked them, and the plan card and the approval card are a yes for what they say. A name
 * Whombat can't read just now is left to the id. `missing` when the hosts service or Home Assistant says the machine or
 * the entity isn't there.
 */
async function directNames(
  services: Services,
  conn: CatalogConnectionRow,
  step: RunActionStep,
  server: { id: string; name: string } | null,
): Promise<DirectNames | 'missing'> {
  const kind = directTargetKind(step);
  if (kind === 'home' || kind === 'entity') {
    if (kind === 'home' || !step.target) return { thingName: conn.label };
    // Loaded here, as `alreadySo` does: the connection modules reach this one through the automation commands.
    const { getJson, ReadProblem } = await import('../things/kinds/read');
    try {
      const state = rec(await getJson(services, conn, conn.label, `/api/states/${step.target}`));
      const friendly = rec(state.attributes).friendly_name;
      return typeof friendly === 'string' && friendly.trim()
        ? { thingName: conn.label, targetName: friendly.trim().slice(0, 120) }
        : { thingName: conn.label };
    } catch (err) {
      return err instanceof ReadProblem && err.httpStatus === 404 ? 'missing' : { thingName: conn.label };
    }
  }
  const thingName = server?.name ?? idOf(step.thing);
  if (kind !== 'machine' || !step.target) return { thingName };
  const guests = await hostsFor(services)
    .guestsRaw(server?.id ?? idOf(step.thing))
    .catch(() => null);
  if (!guests) return { thingName };
  // The machine as `guest_power` finds it: by its id, else by a name only one of them has.
  const want = step.target.trim().toLowerCase();
  const list = guests.map(rec);
  const byName = list.filter((g) => String(g.name ?? '').toLowerCase() === want);
  const guest =
    list.find((g) => String(g.id ?? '').toLowerCase() === want) ??
    (byName.length === 1 ? byName[0] : undefined);
  if (!guest) return 'missing';
  const name = typeof guest.name === 'string' && guest.name.trim() ? guest.name.trim() : String(guest.id);
  return { thingName, targetName: name.slice(0, 120) };
}

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

/**
 * How the step would run now: the connection, the tool, the call, and whether the person's rules ask. Why it can't is
 * said in `locale` (English when none): it is the step's line on the run page.
 */
export async function planDirectAction(
  db: Db | Tx,
  services: Services,
  burrowId: string,
  step: RunActionStep,
  locale?: string | null,
): Promise<DirectPlan> {
  const t = (key: Parameters<typeof tServer>[1], vars?: Record<string, string>) => tServer(locale, key, vars);
  // Drafts are refused a scene or a script by the definition's own check; one an automation saved before that may
  // still run, asking each time.
  const problem = directActionProblem(step, locale, { saved: true });
  if (problem) return { ok: false, reason: problem, fatal: true };
  const call = directCall(step);
  if (!call) return { ok: false, reason: t('automations.direct.cantDirect'), fatal: true };
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
        ? t('automations.direct.noServers', { name: step.thingName })
        : t('automations.direct.gone', { name: step.thingName }),
      fatal: false,
      gone: true,
    };
  if (!onServer && conn.catalogId !== 'homeassistant')
    return { ok: false, reason: t('automations.direct.onlyHome'), fatal: true };
  if (conn.status !== 'active')
    return {
      ok: false,
      reason: onServer
        ? t('automations.direct.serversAway')
        : isEnglish(locale)
          ? needsReauthText(conn)
          : t('automations.direct.signIn', { name: conn.label }),
      fatal: false,
    };
  const entry = catalogEntry(conn.catalogId);
  if (!entry)
    return {
      ok: false,
      reason: t('automations.direct.gone', { name: conn.label }),
      fatal: false,
      gone: true,
    };
  const [tool] = await db
    .select()
    .from(connectionTools)
    .where(and(eq(connectionTools.connectionId, conn.id), eq(connectionTools.name, call.tool)));
  if (!tool)
    return {
      ok: false,
      reason: t('automations.direct.cantDo', { name: conn.label }),
      fatal: false,
      gone: true,
    };
  const server = await callServerOf(db, services, burrowId, conn.catalogId, call.args);
  // The plan's yes is the key: what still asks is what the person set to ask, and the catalog's own rules.
  const decided = callTier(entry, tool, call.args, 'can', conn.access, server);
  if (decided.lookOnly)
    return {
      ok: false,
      reason: isEnglish(locale)
        ? lookOnlyText(conn.label)
        : t('automations.direct.lookOnly', { name: conn.label }),
      fatal: false,
    };
  if (decided.toolTier === 'off' || decided.tier === 'off')
    return { ok: false, reason: t('automations.direct.setNot', { name: conn.label }), fatal: false };
  // The limits the person set on the tool hold for an automation as for the assistant.
  const outside = limitsProblem(tool.limits, call.args, await limitWordsFor(db, conn, tool));
  if (outside) return { ok: false, reason: outside, fatal: false };
  const named = server ? { id: server.id, name: server.name } : null;
  const names = await directNames(services, conn, step, named);
  if (names === 'missing')
    return {
      ok: false,
      reason:
        directTargetKind(step) === 'entity'
          ? t('automations.direct.noEntity', { name: conn.label, target: step.target ?? '' })
          : t('automations.direct.noMachine', {
              name: named?.name ?? idOf(step.thing),
              target: step.target ?? '',
            }),
      fatal: false,
      gone: true,
    };
  // Home Assistant's own name for the entity may be what makes it sensitive (a switch it calls “Front door lock”).
  const unsafe = directActionProblem(withNames(step, names), locale, { saved: true });
  if (unsafe) return { ok: false, reason: unsafe, fatal: true };
  return {
    ok: true,
    conn,
    entry,
    tool,
    args: call.args,
    asks: decided.tier === 'ask' || directActionAsksEachTime(step),
    server: named,
    names,
  };
}

/**
 * A definition whose `run_action` steps carry the names Whombat knows now instead of the ones the assistant wrote: what
 * the plan card and the automation's page say is what each step acts on. A step that can't run now keeps no name
 * Whombat didn't check: the id stands in for its target, and for its server.
 */
export async function withRealNames(
  db: Db | Tx,
  services: Services,
  burrowId: string,
  definition: AutomationDefinition,
): Promise<AutomationDefinition> {
  if (!definition.steps.some((s) => s.kind === 'run_action')) return definition;
  const steps: AutomationStep[] = [];
  for (const s of definition.steps) {
    if (s.kind !== 'run_action') {
      steps.push(s);
      continue;
    }
    const plan = await planDirectAction(db, services, burrowId, s);
    if (plan.ok) steps.push(withNames(s, plan.names));
    else
      steps.push(
        withNames(s, {
          thingName: s.thing.startsWith('server:') ? idOf(s.thing) : await connectionLabel(db, burrowId, s),
        }),
      );
  }
  return { ...definition, steps };
}

/** The label of the connection a Home Assistant step names, else the name it was saved with. */
async function connectionLabel(db: Db | Tx, burrowId: string, step: RunActionStep): Promise<string> {
  const [row] = await db
    .select({ label: catalogConnections.label })
    .from(catalogConnections)
    .where(and(eq(catalogConnections.burrowId, burrowId), eq(catalogConnections.id, idOf(step.thing))));
  return row?.label ?? step.thingName;
}

/**
 * Whether this try needs the person's yes on the card: their rules ask, it starts a scene or a script, or it is a test
 * run (“Try it” acts for real, so it never acts unattended).
 */
export function directAsks(
  plan: Extract<DirectPlan, { ok: true }>,
  run: Pick<AutomationRunRow, 'test'>,
): boolean {
  return plan.asks || run.test;
}

/* Already so ------------------------------------------------------------------------------------------------------------ */

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Whether the thing is already as the step would leave it (a light on), read just before: the quiet no-op. `unreachable`
 * for a server the hosts service can't reach: it may be off or only cut off, so nothing is sent and the step doesn't
 * count as done. Null when it isn't, or Whombat can't tell (then the action runs; doing it twice does no harm).
 */
async function alreadySo(
  services: Services,
  plan: Extract<DirectPlan, { ok: true }>,
  step: RunActionStep,
): Promise<DirectOutcome | 'unreachable' | null> {
  const kind = directTargetKind(step);
  try {
    if (kind === 'server' && step.action === 'shut_down') {
      const fleet = rec(await hostsFor(services).fleetRaw());
      const id = idOf(step.thing).toLowerCase();
      const server = (Array.isArray(fleet.servers) ? fleet.servers : [])
        .map(rec)
        .find((s) => String(s.id ?? '').toLowerCase() === id);
      return server?.status === 'offline' ? 'unreachable' : null;
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

const RESULT: Partial<Record<RunActionStep['action'], 'switching_off' | 'restarting' | 'starting'>> = {
  shut_down: 'switching_off',
  restart: 'restarting',
  start: 'starting',
};

/* How a power action ended -------------------------------------------------------------------------------------------- */

/**
 * How long a server's or a machine's power action may take to say how it ended: the agent gives a machine up to 100
 * seconds to get there, so this is a little more.
 */
export const POWER_FINISH_MS = 2 * 60_000;

/** How the hosts service said a power action ended (its `action.finished`). */
export interface PowerFinish {
  ok: boolean;
  /** The agent found it already so (a machine already stopped, a shutdown already under way). */
  noop: boolean;
  /** Why it didn't, in the agent's code (`remote_control_disabled`, …). */
  code: string | null;
}

/**
 * Listens for how power actions end, from before the call that starts one: a server that answers at once is still
 * heard. `wait` gives the end of one action, or null when it isn't heard within `ms`.
 */
export function listenForPowerFinish(hosts: Pick<HostsService, 'onChange'>): {
  wait(actionId: string | null, ms: number): Promise<PowerFinish | null>;
  stop(): void;
} {
  const heard = new Map<string, PowerFinish>();
  const waiters = new Map<string, (finish: PowerFinish) => void>();
  const stop = hosts.onChange((change: HostsChange) => {
    if (change.kind !== 'task' || change.data.event !== 'action.finished') return;
    const id = change.data.action_id;
    if (typeof id !== 'string' || !id) return;
    const code = change.data.code;
    const finish: PowerFinish = {
      ok: change.data.result === 'ok',
      noop: change.data.noop === true,
      code: typeof code === 'string' && code ? code : null,
    };
    const waiter = waiters.get(id);
    if (waiter) waiter(finish);
    // Other actions end meanwhile too: only a few are kept for the one asked about.
    else if (heard.size < 100) heard.set(id, finish);
  });
  return {
    wait(actionId, ms) {
      if (!actionId) return Promise.resolve(null);
      const early = heard.get(actionId);
      if (early) return Promise.resolve(early);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(actionId);
          resolve(null);
        }, ms);
        timer.unref?.();
        waiters.set(actionId, (finish) => {
          clearTimeout(timer);
          waiters.delete(actionId);
          resolve(finish);
        });
      });
    },
    stop() {
      stop();
    },
  };
}

/** The id of the power action a Servers tool started (`server_power`, `guest_power`), or null. */
function actionIdOf(structured: unknown, content: string): string | null {
  let out = rec(structured);
  if (!Object.keys(out).length)
    try {
      out = rec(JSON.parse(content));
    } catch {
      out = {};
    }
  return typeof out.actionId === 'string' && out.actionId ? out.actionId : null;
}

/**
 * How a power step settles from how its action ended (pure): done (a machine already so is the quiet no-op), refused
 * by the server (with the agent's code), or unknown when nothing was heard in time.
 */
export function powerSettle(
  step: Pick<RunActionStep, 'thing' | 'target' | 'action'>,
  finish: PowerFinish | null,
): { kind: 'done'; outcome: DirectOutcome } | { kind: 'refused'; code: string | null } | { kind: 'unknown' } {
  if (!finish) return { kind: 'unknown' };
  if (!finish.ok) return { kind: 'refused', code: finish.code };
  if (finish.noop && directTargetKind(step) === 'machine' && step.action !== 'restart')
    return {
      kind: 'done',
      outcome: { kind: 'noop', already: step.action === 'start' ? 'running' : 'stopped' },
    };
  return { kind: 'done', outcome: { kind: 'done', result: RESULT[step.action] ?? null } };
}

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

/**
 * A `run_action` step marked `running` (outside any transaction): its plan checked again, the quiet no-op when the
 * thing is already so, then the call, and the step settled with its one line (“Shut down nas-01 at 21:14 — it’s
 * switching off.”). A server's or a machine's power counts only once the server said how it ended: a refusal is a
 * failure, and no word in time may not have happened. A failure skips the step when `otherwise` says so (one server
 * that can't be reached mustn't keep the others on), else fails it; a restart that didn't answer in time may have
 * happened, so a person checks. `recovering`: Whombat stopped while the step was running, and does it again now.
 */
export async function runDirectAction(
  lease: LeasedRun,
  row: AutomationStepRow,
  saved: RunActionStep,
  opts: { recovering?: boolean } = {},
): Promise<void> {
  const { services, run } = lease;
  const db = services.db;
  // The step's line is read on the run page and in the person's messages: in their language.
  const locale = await burrowLocale(services, run.burrowId);
  const t = (key: Parameters<typeof tServer>[1], vars?: Record<string, string>) => tServer(locale, key, vars);
  const who = await publisherCheck(db, run.burrowId, run.publishedById);
  if (!who.ok) return void (await cannot(lease, row, saved, who.reason, true));
  // Loaded here: `steps.ts` reaches this module through its step handlers, so a static import would be a cycle.
  const { stepRoomsCheck } = await import('./steps');
  const rooms = await stepRoomsCheck(db, run, row.idx, who.publisher);
  if (!rooms.ok) return void (await cannot(lease, row, saved, rooms.reason, true));
  const out = row.output as { approvalId?: string; callId?: string; target?: string };
  const plan = await planDirectAction(db, services, run.burrowId, saved, locale);
  if (!plan.ok) return void (await cannot(lease, row, saved, plan.reason, plan.fatal));
  // Every line names what it acts on as Whombat knows it now.
  const step = withNames(saved, plan.names);
  // A call that asks (the person's rules, a scene or a script, a test run) runs only with the yes this attempt got.
  if (directAsks(plan, run) && !out.approvalId)
    return void (await lease.commit({ op: 'settle', idx: row.idx, state: 'pending', from: ['running'] }));
  const agent = await automationAgent(db, run.burrowId);
  if (!agent) return void (await cannot(lease, row, step, t('automations.direct.noAssistant'), false));
  const [burrow] = await db
    .select({ timeZone: burrows.timeZone })
    .from(burrows)
    .where(eq(burrows.id, run.burrowId));
  const at = () => clock(services.clock(), burrow?.timeZone ?? 'UTC');
  const settleLine = (
    state: 'succeeded' | 'skipped' | 'failed' | 'uncertain',
    line: string,
    error?: string,
  ) =>
    lease.commit({
      op: 'settle',
      idx: row.idx,
      state,
      ...(state === 'succeeded' ? {} : { error: (error ?? line).slice(0, 1000) }),
      output: { ran: false, text: line.slice(0, 500), summary: line.slice(0, 500) },
      from: ['running'],
    });

  const already = await alreadySo(services, plan, step);
  if (already === 'unreachable') {
    // Whombat stopped while it was shutting this server down: off now is the shutdown it had sent, done.
    if (opts.recovering && step.action === 'shut_down') {
      const line = directDoneLine(step, { kind: 'done', result: null }, at(), locale);
      await lease.commit({
        op: 'settle',
        idx: row.idx,
        state: 'succeeded',
        output: { ran: true, text: line, summary: line },
        from: ['running'],
      });
      return;
    }
    const line = t('automations.direct.unreachable', { name: step.thingName, time: at() });
    await settleLine(step.otherwise === 'skip' ? 'skipped' : 'failed', line);
    return;
  }
  if (already) {
    const line = directDoneLine(step, already, at(), locale);
    await lease.commit({
      op: 'settle',
      idx: row.idx,
      state: 'succeeded',
      output: { ran: false, noop: true, text: line, summary: line },
      from: ['running'],
    });
    return;
  }

  const what = directActionText(step, locale);
  // English says it mid-sentence (“Couldn’t shut down nas-01”); Dutch starts with the thing's name.
  const failedLine = (reason: string) =>
    t('automations.direct.failed', { what: isEnglish(locale) ? lowerFirst(what) : what, reason });
  const kind = directTargetKind(step);
  // A server's or a machine's power: listening starts before the call, so an action that ends at once is still heard.
  const listening = kind === 'server' || kind === 'machine' ? listenForPowerFinish(hostsFor(services)) : null;
  try {
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
      change: what,
      approvalId: out.approvalId ?? null,
      target: out.target ?? callTarget(plan.conn),
    });
    const status = res.kind === 'ok' ? res.output.httpStatus : undefined;
    const failed =
      res.kind === 'failed' ||
      res.output.isError ||
      (status !== undefined && (status < 200 || status >= 300));
    if (res.kind === 'failed' || failed) {
      const timedOut = res.kind === 'failed' && res.reason === 'timeout';
      const reason =
        res.kind === 'failed'
          ? res.message
          : status
            ? t('automations.direct.httpError', { name: plan.conn.label, status: String(status) })
            : t('automations.direct.saidNo', { name: plan.conn.label });
      // An action that didn't answer in time may have happened: one that isn't the same done twice (a restart, a scene
      // or a script) isn't tried again, a person checks.
      const unsure = timedOut && !directActionRepeatable(step);
      await settleLine(
        unsure ? 'uncertain' : step.otherwise === 'skip' ? 'skipped' : 'failed',
        failedLine(reason),
        unsure
          ? t(
              step.action === 'restart' ? 'automations.direct.maybeRestarted' : 'automations.direct.maybeRan',
              {
                reason,
              },
            )
          : undefined,
      );
      return;
    }
    const settled = listening
      ? powerSettle(
          step,
          await listening.wait(actionIdOf(res.output.structured, res.output.content), POWER_FINISH_MS),
        )
      : ({ kind: 'done', outcome: { kind: 'done', result: RESULT[step.action] ?? null } } as const);
    if (settled.kind === 'refused') {
      // The agent on the server said no: switched off there, or it couldn't.
      const reason =
        settled.code === 'remote_control_disabled'
          ? t('automations.direct.offThere', { name: step.thingName })
          : t('automations.direct.saidNo', { name: step.thingName });
      await settleLine(step.otherwise === 'skip' ? 'skipped' : 'failed', failedLine(reason));
      return;
    }
    if (settled.kind === 'unknown') {
      // Sent, but the server didn't say how it ended: it may not have happened. A restart isn't the same done twice, so
      // a person checks; the rest goes on as `otherwise` says.
      const reason = t('automations.direct.noAnswer', { name: step.thingName });
      if (!directActionRepeatable(step)) {
        await settleLine('uncertain', failedLine(reason), t('automations.direct.maybeRestarted', { reason }));
        return;
      }
      await settleLine(
        step.otherwise === 'skip' ? 'skipped' : 'failed',
        t('automations.direct.notConfirmed', { what, name: step.thingName, time: at() }),
      );
      return;
    }
    const outcome = settled.outcome;
    const line = directDoneLine(step, outcome, at(), locale);
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
  } finally {
    listening?.stop();
  }
}
