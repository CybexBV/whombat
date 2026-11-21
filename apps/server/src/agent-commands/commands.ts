/**
 * Consequential commands of the agent (docs/decisions/agent-computer.md AC-41, AC-42; one-person.md OP-07, OP-S107:
 * they run through Hermes's own terminal on the person's Whombat).
 *
 * The runner's guard (`classifyCommand`) found a deploy, a merge, a push to the default branch, a destructive command on
 * another machine or a message to the outside world. The server checks the classification again (never less severe
 * than what the runner said), then the category's key decides for the agent (`commandCategoryKey`, the keys engine):
 *
 * - **On** → `run`; for a production server its address and port are opened for the command (`open`, AC-11).
 * - **Off** → `blocked`: the pipeline signs a Blocked event and the agent reads `commandBlockedText` (exit 126).
 * - **Ask** → a standing yes lets it run: an allowance (“Always allow for {Agent}”), a `task` pass of the same run (or
 *   thread, without a run) for the same command and target, or an unused `once` pass a late yes left. Else a
 *   `run_command` approval card goes to the person, in the turn's thread, and the runner long-polls it
 *   (`runner.authorizeWait`).
 *
 * A yes is stored with its scope (`approvals.decide` `scope`): `once` and `task` on the request's own row
 * (`command_passes`), `agent` as a `command_allowances` row (signed `command.allowance_added`). A yes that no runner is
 * waiting for any more wakes the agent (`approval_granted`, EA-07): it runs the command again and the pass applies.
 * Whombat never signs that the command ran (EA-03): the approval's log line says it was allowed.
 */
import {
  type ApprovalAction,
  actionScope,
  COMMAND_ALLOWANCES_MAX,
  COMMAND_MAX,
  COMMAND_TARGET_MAX,
  type CommandAllowance,
  CommandCategory,
  type CommandOpening,
  type CommandScope,
  classifyCommand,
  commandCategoryKey,
  commandWaitingText,
  commandWhyNeededText,
  DEFAULT_BRANCHES,
  isToolCategory,
  KEY_CATALOG,
  type KeyId,
  moreSevereCategory,
  newId,
  normaliseCommand,
  runCommandPhrase,
} from '@whombat/core';
import { and, asc, desc, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { createApproval } from '../approvals/create';
import type { Executor } from '../approvals/engine';
import { wakeForApproval } from '../approvals/wake';
import { outsideCommandScope } from '../commit/scope';
import { type ApplyContext, defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import {
  approvals,
  commandAllowances,
  commandPasses,
  dispatches,
  repos,
  vaultSshServers,
} from '../db/schema/index';
import { conflict, forbidden, notFound } from '../lib/errors';
import { iso } from '../lib/time';
import { loadConversationRow } from '../read/conversations';
import { loadAgentRow, loadPrincipalRow, shortName } from '../read/principals';
import type { Services } from '../services';
import { resolveSshHost } from '../vault/ssh';
import { listedNetworks } from '../vault/store';
import { productionServers, reachableAddresses } from './context';
import { runnerWaiting } from './waiters';

/** Dispatch states in which a turn is still going. */
const LIVE = ['queued', 'claimed', 'running'] as const;

/** A runner that long-polled within this long is still waiting (a poll lasts at most 25 s, the next starts at once). */
export const RUNNER_WAITING_MS = 35_000;

/** How long a `once` pass a late yes left waits for the agent's identical command. */
export const ONCE_PASS_MS = 24 * 3600_000;

/**
 * How long after a yes the server waits for a waiting runner to pick it up before waking the agent instead (it may
 * have given up between two polls).
 */
let deliveryGraceMs = 40_000;

/** Tests: a shorter grace before a yes no runner picked up wakes the agent. */
export function setCommandDeliveryGraceForTests(ms: number): void {
  deliveryGraceMs = ms;
}

export type CommandPassRow = typeof commandPasses.$inferSelect;

/* Classification and openings -------------------------------------------------------------------------------- */

/** The default branches the guard reads pushes against: the burrow's repos' and `main`, `master`. */
async function defaultBranches(db: Db | Tx, burrowId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ branch: repos.defaultBranch })
    .from(repos)
    .where(eq(repos.burrowId, burrowId));
  return [...new Set([...DEFAULT_BRANCHES, ...rows.map((r) => r.branch).filter(Boolean)])];
}

/**
 * What the server makes of a command the runner asks about: `classifyCommand` again, with this burrow's production
 * servers and default branches; the more severe of the two answers wins, so a runner can only ever ask about more.
 * In a turn whose `gh` goes through Whombat the guard leaves `gh` alone (`ghThroughWhombat`, agent-gh.md AGH-11): its
 * writes are decided when they reach `runner.ghAuthorize`.
 */
export async function classifyAgain(
  services: Services,
  burrowId: string,
  asked: { command: string; category: CommandCategory; target: string | null },
  options: { ghThroughWhombat?: boolean } = {},
): Promise<{ category: CommandCategory; target: string | null }> {
  const homeNetworks = (await listedNetworks(services.db)).map((n) => n.cidr);
  const [servers, branches] = await Promise.all([
    productionServers(services, services.db, burrowId, homeNetworks),
    defaultBranches(services.db, burrowId),
  ]);
  const found = classifyCommand(asked.command, {
    productionServers: servers.map((s) => ({ name: s.name, host: s.host, addresses: s.addresses })),
    defaultBranches: branches,
    ...(options.ghThroughWhombat ? { ghThroughWhombat: true } : {}),
  });
  if (!found || found.category === asked.category) return { category: asked.category, target: asked.target };
  return moreSevereCategory(found.category, asked.category) === found.category
    ? { category: found.category, target: found.target }
    : { category: asked.category, target: asked.target };
}

/**
 * The addresses a command may reach through the commands' network (AC-11): for a command on a production server (by its
 * name, host or one of its addresses), the server's host and every address it resolves to now, on its port.
 */
export async function openingsFor(
  services: Services,
  burrowId: string,
  category: CommandCategory,
  target: string | null,
): Promise<CommandOpening[]> {
  if (category !== 'deploy_production' || !target) return [];
  const wanted = target.toLowerCase();
  const rows = await services.db
    .select()
    .from(vaultSshServers)
    .where(and(eq(vaultSshServers.burrowId, burrowId), eq(vaultSshServers.production, true)));
  const homeNetworks = (await listedNetworks(services.db)).map((n) => n.cidr);
  const out = new Map<string, CommandOpening>();
  for (const server of rows) {
    const addresses = reachableAddresses(await resolveSshHost(services, server.host), homeNetworks);
    const matches =
      server.name.toLowerCase() === wanted || server.host === wanted || addresses.includes(wanted);
    if (!matches) continue;
    for (const host of [server.host, ...addresses])
      out.set(`${host}:${server.port}`, { host, port: server.port });
  }
  return [...out.values()].slice(0, 64);
}

/* Authorize ---------------------------------------------------------------------------------------------------- */

export type AuthorizeOutcome =
  | { outcome: 'run'; approvalId: string | null; scope: CommandScope | null; open: CommandOpening[] }
  | { outcome: 'pending'; approvalId: string; message: string }
  /** A card would be posted, but the command doesn't say what it is for: it doesn't run, the agent says why first. */
  | { outcome: 'why'; message: string };

const AuthorizeInput = z.object({
  dispatchId: z.string(),
  command: z.string().min(1).max(COMMAND_MAX),
  category: CommandCategory,
  target: z.string().max(COMMAND_TARGET_MAX).nullable(),
  reason: z.string().max(500).nullable().default(null),
});

function runAction(input: z.output<typeof AuthorizeInput>): Extract<ApprovalAction, { type: 'run_command' }> {
  return {
    type: 'run_command',
    params: { command: input.command, category: input.category, target: input.target, reason: input.reason },
  };
}

/** The asking dispatch, the agent's own and still going. */
async function askingDispatch(ctx: ApplyContext, dispatchId: string) {
  const [dispatch] = await ctx.tx
    .select()
    .from(dispatches)
    .where(and(eq(dispatches.id, dispatchId), eq(dispatches.agentId, ctx.actor.id)));
  if (!dispatch || dispatch.burrowId !== ctx.burrow.id) throw notFound('Dispatch');
  if (!(LIVE as readonly string[]).includes(dispatch.state)) throw conflict('This dispatch is not running.');
  return dispatch;
}

/** The standing yes that lets a command run without asking (AC-42), or null. */
async function standingYes(
  ctx: ApplyContext,
  dispatch: typeof dispatches.$inferSelect,
  match: { keyId: KeyId; command: string; target: string },
): Promise<{ scope: CommandScope; approvalId: string | null } | null> {
  const { tx } = ctx;
  const [allowance] = await tx
    .select({ id: commandAllowances.id })
    .from(commandAllowances)
    .where(
      and(
        eq(commandAllowances.agentId, ctx.actor.id),
        eq(commandAllowances.keyId, match.keyId),
        eq(commandAllowances.command, match.command),
        eq(commandAllowances.target, match.target),
      ),
    );
  if (allowance) return { scope: 'agent', approvalId: null };
  const sameTarget = and(
    eq(commandPasses.agentId, ctx.actor.id),
    eq(commandPasses.keyId, match.keyId),
    eq(commandPasses.target, match.target),
    eq(approvals.state, 'approved'),
  );
  const same = and(sameTarget, eq(commandPasses.command, match.command));
  // For this task: the same run, or the same thread when the turn is in no run — and the turn a late yes woke, wherever
  // the card took it (the Chat of the person it was for, OA-12), carries the task on.
  const sameTask = dispatch.runId
    ? eq(commandPasses.runId, dispatch.runId)
    : and(
        isNull(commandPasses.runId),
        eq(commandPasses.conversationId, dispatch.conversationId),
        dispatch.threadRootId
          ? eq(commandPasses.threadRootId, dispatch.threadRootId)
          : isNull(commandPasses.threadRootId),
      );
  const task = dispatch.approvalId
    ? or(sameTask, eq(commandPasses.approvalId, dispatch.approvalId))
    : sameTask;
  const [forTask] = await tx
    .select({ approvalId: commandPasses.approvalId })
    .from(commandPasses)
    .innerJoin(approvals, eq(approvals.id, commandPasses.approvalId))
    // “Allow for this task” covers the target (goal-first.md GF-10): every command of that key to the same production
    // server, branch or host in the run (a deploy is several commands); without a target, the same command only.
    .where(and(match.target ? sameTarget : same, eq(commandPasses.scope, 'task'), task))
    .limit(1);
  if (forTask) return { scope: 'task', approvalId: forTask.approvalId };
  // Once: the yes for this very turn, or a late yes for the next identical command where the card was (the wake): the
  // card's room, the Chat of the person the turn was for when it was asked elsewhere (one-agent.md OA-12).
  const [once] = await tx
    .select({ approvalId: commandPasses.approvalId })
    .from(commandPasses)
    .innerJoin(approvals, eq(approvals.id, commandPasses.approvalId))
    .where(
      and(
        same,
        eq(commandPasses.scope, 'once'),
        isNull(commandPasses.usedAt),
        gte(commandPasses.createdAt, new Date(ctx.now.getTime() - ONCE_PASS_MS)),
        or(eq(commandPasses.dispatchId, dispatch.id), eq(approvals.conversationId, dispatch.conversationId)),
      ),
    )
    .orderBy(asc(commandPasses.createdAt))
    .limit(1);
  if (!once) return null;
  await tx
    .update(commandPasses)
    .set({ usedAt: ctx.now })
    .where(and(eq(commandPasses.approvalId, once.approvalId), isNull(commandPasses.usedAt)));
  return { scope: 'once', approvalId: once.approvalId };
}

/**
 * `runner.authorizeCommand` as the agent (the pipeline's keys decision is the category's key): run, or pending on a
 * `run_command` card. Off never reaches `apply` (the pipeline answers `blocked` and signs it).
 */
export const authorizeCommand = defineCommand({
  name: 'commands.authorize',
  schema: AuthorizeInput,
  async requiredKey(input) {
    const action = runAction(input);
    const label = KEY_CATALOG[commandCategoryKey(input.category)].label;
    return {
      keyId: commandCategoryKey(input.category),
      scope: actionScope(action),
      attempt: runCommandPhrase(input.category, input.target),
      where: input.target ? `${input.target} · ${label}` : label,
      // An `ask` is answered here: a standing yes, or a card in the turn's thread.
      onAsk: 'apply' as const,
    };
  },
  async apply(tx, ctx, input): Promise<AuthorizeOutcome> {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only the agent runs commands.');
    const dispatch = await askingDispatch(ctx, input.dispatchId);
    const keyId = commandCategoryKey(input.category);
    const match = { keyId, command: normaliseCommand(input.command), target: input.target ?? '' };
    const open = () => openingsFor(ctx.services, ctx.burrow.id, input.category, input.target);
    if (ctx.decision?.outcome !== 'ask')
      return { outcome: 'run', approvalId: null, scope: null, open: await open() };

    const standing = await standingYes(ctx, dispatch, match);
    if (standing) return { outcome: 'run', ...standing, open: await open() };

    // Asked already (a retry, or the same command again in the same place): the card that waits answers.
    const [waiting] = await tx
      .select({ approvalId: commandPasses.approvalId })
      .from(commandPasses)
      .innerJoin(approvals, eq(approvals.id, commandPasses.approvalId))
      .where(
        and(
          eq(commandPasses.agentId, ctx.actor.id),
          eq(commandPasses.keyId, keyId),
          eq(commandPasses.command, match.command),
          eq(commandPasses.target, match.target),
          eq(commandPasses.conversationId, dispatch.conversationId),
          eq(approvals.state, 'pending'),
        ),
      )
      .limit(1);
    const message = commandWaitingText(input.category);
    if (waiting) return { outcome: 'pending', approvalId: waiting.approvalId, message };
    // The person decides by why the agent needs it (docs/decisions/chat-asks.md): no card without one. A web or browser
    // tool call has none to give; its card shows what it looks at.
    if (!isToolCategory(input.category) && !input.reason?.trim())
      return { outcome: 'why', message: commandWhyNeededText(input.category) };

    const conversation = await loadConversationRow(tx, dispatch.conversationId);
    if (!conversation) throw notFound('Conversation');
    const agent = ctx.actor.shortName;
    const label = KEY_CATALOG[keyId].label;
    const phrase = runCommandPhrase(input.category, input.target);
    const { approval } = await createApproval(ctx, {
      keyId,
      action: runAction(input),
      decision: ctx.decision,
      // Title, question, target and the first WHAT HAPPENS line come from the action (the exact command).
      title: '',
      question: '',
      target: '',
      whatHappens: [],
      explainer: `${agent} holds “${label}”, a key that only turns when a person approves. If you allow it, the command runs on your Whombat — once, for the rest of this task, or always.`,
      summary: '',
      conditions: [],
      involvedIds: [],
      conversation,
      // The thread the turn was asked in (RC-14).
      threadRootId: dispatch.threadRootId,
      cardText: `I need a person to say yes before I ${phrase}.`,
      where: input.target ? `${input.target} · ${label}` : label,
      command: null,
      onBehalfOfAccountId: dispatch.onBehalfOfAccountId ?? null,
    });
    await tx.insert(commandPasses).values({
      approvalId: approval.id,
      burrowId: ctx.burrow.id,
      agentId: ctx.actor.id,
      dispatchId: dispatch.id,
      runId: dispatch.runId,
      conversationId: dispatch.conversationId,
      threadRootId: dispatch.threadRootId,
      category: input.category,
      keyId,
      command: match.command,
      target: match.target,
      createdAt: ctx.now,
    });
    return { outcome: 'pending', approvalId: approval.id, message };
  },
});

/* A person's yes ------------------------------------------------------------------------------------------------ */

/** Whether a runner is still waiting on the request (it polled lately, its turn goes on). */
export async function runnerStillWaiting(
  services: Services,
  db: Db | Tx,
  pass: CommandPassRow,
  now: Date,
): Promise<boolean> {
  if (runnerWaiting(services, pass.approvalId)) return true;
  if (!pass.polledAt || now.getTime() - pass.polledAt.getTime() > RUNNER_WAITING_MS) return false;
  const [dispatch] = await db
    .select({ state: dispatches.state })
    .from(dispatches)
    .where(eq(dispatches.id, pass.dispatchId));
  return !!dispatch && (LIVE as readonly string[]).includes(dispatch.state);
}

/** The request row of a `run_command` approval. */
export async function commandPassOf(db: Db | Tx, approvalId: string): Promise<CommandPassRow | null> {
  const [row] = await db.select().from(commandPasses).where(eq(commandPasses.approvalId, approvalId));
  return row ?? null;
}

/** Whether `actor` may say “Always allow” for the agent: the person (AC-DS09; one-person.md OP-01). */
export async function mayAlwaysAllow(
  db: Db | Tx,
  actor: { id: string; kind: 'person' | 'agent' },
  agentId: string,
): Promise<boolean> {
  if (actor.kind !== 'person') return false;
  return (await loadPrincipalRow(db, agentId))?.kind === 'agent';
}

/** Keeps the agent's allowances at `COMMAND_ALLOWANCES_MAX`: the oldest go. */
async function trimAllowances(tx: Tx, agentId: string): Promise<void> {
  const rows = await tx
    .select({ id: commandAllowances.id })
    .from(commandAllowances)
    .where(eq(commandAllowances.agentId, agentId))
    .orderBy(desc(commandAllowances.createdAt), desc(commandAllowances.id));
  const extra = rows.slice(COMMAND_ALLOWANCES_MAX).map((r) => r.id);
  if (extra.length) await tx.delete(commandAllowances).where(inArray(commandAllowances.id, extra));
}

/**
 * The `run_command` executor's commit, as the person who said yes: the scope goes on the request's pass; “Always allow”
 * stores the allowance (signed). Answers whether the agent must be woken now (nobody waits for the yes), later (a
 * runner was waiting; if it never picks the yes up, the agent is woken then), or not at all (already delivered).
 */
export const allowCommand = defineCommand({
  name: 'commands.allow',
  schema: z.object({ approvalId: z.string() }),
  async apply(tx, ctx, input): Promise<{ wake: 'now' | 'later' | 'no' }> {
    const [approval] = await tx.select().from(approvals).where(eq(approvals.id, input.approvalId));
    if (
      !approval ||
      approval.burrowId !== ctx.burrow.id ||
      approval.action.type !== 'run_command' ||
      approval.state !== 'approved' ||
      approval.decidedById !== ctx.actor.id ||
      approval.execution.state !== 'running'
    )
      throw forbidden('That approval does not cover this.');
    const pass = await commandPassOf(tx, approval.id);
    if (!pass) throw notFound('Command');
    const scope = approval.scope ?? 'once';
    await tx.update(commandPasses).set({ scope }).where(eq(commandPasses.approvalId, pass.approvalId));
    if (scope === 'agent') {
      const [added] = await tx
        .insert(commandAllowances)
        .values({
          id: newId('commandAllowance'),
          burrowId: ctx.burrow.id,
          agentId: pass.agentId,
          keyId: pass.keyId,
          command: pass.command,
          target: pass.target,
          createdById: ctx.actor.id,
          createdAt: ctx.now,
        })
        .onConflictDoNothing()
        .returning();
      if (added) {
        await trimAllowances(tx, pass.agentId);
        const agent = await loadPrincipalRow(tx, pass.agentId);
        await ctx.emit({
          type: 'command.allowance_added',
          kind: 'Keys',
          text: `Always allowed ${agent ? shortName(agent) : 'the agent'} to ${runCommandPhrase(pass.category, pass.target || null)}`,
          where: agent ? `Agent · ${agent.handle}` : null,
          aboutId: pass.agentId,
          ...(agent ? { ref: { type: 'agent' as const } } : {}),
          payload: {
            allowanceId: added.id,
            agentId: pass.agentId,
            keyId: pass.keyId,
            approvalId: approval.id,
          },
        });
      }
    }
    if (pass.deliveredAt || pass.wokenAt) return { wake: 'no' };
    return { wake: (await runnerStillWaiting(ctx.services, tx, pass, ctx.now)) ? 'later' : 'now' };
  },
});

/**
 * A yes no runner picked up wakes the agent where the card is (`approval_granted`, EA-07), once: it runs the command
 * again in that turn and the pass lets it through.
 */
export const wakeAfterYes = defineCommand({
  name: 'commands.wake_after_yes',
  schema: z.object({ approvalId: z.string() }),
  async apply(tx, ctx, input) {
    const pass = await commandPassOf(tx, input.approvalId);
    if (!pass || pass.burrowId !== ctx.burrow.id || pass.deliveredAt || pass.wokenAt) return null;
    const woken = await wakeForApproval.apply(tx, ctx, { approvalId: input.approvalId });
    if (woken)
      await tx
        .update(commandPasses)
        .set({ wokenAt: ctx.now })
        .where(eq(commandPasses.approvalId, pass.approvalId));
    return woken;
  },
});

async function wakeIfUndelivered(services: Services, approvalId: string, actorId: string, burrowId: string) {
  try {
    await services.pipeline.commit(wakeAfterYes, { approvalId }, { burrowId, actorId });
  } catch (err) {
    services.log.warn({ err: String(err), approvalId }, 'could not wake the agent after a yes to a command');
  }
}

/** The `run_command` executor: stores the yes (`allowCommand`) and wakes the agent when nobody waits for it. */
export const runCommandExecutor: Executor = async (approval, services) => {
  if (approval.action.type !== 'run_command') throw new Error('Not a run_command approval.');
  const decidedBy = approval.decidedById;
  if (!decidedBy) return { ok: false, error: 'Nobody allowed it.' };
  const res = await services.pipeline.commit(
    allowCommand,
    { approvalId: approval.id },
    { burrowId: approval.burrowId, actorId: decidedBy },
  );
  if (res.status !== 'ok') return { ok: false, error: 'It couldn’t be allowed.' };
  if (res.result.wake === 'now') await wakeIfUndelivered(services, approval.id, decidedBy, approval.burrowId);
  else if (res.result.wake === 'later')
    // Not part of the decision's command (its scope may still be open when this fires).
    outsideCommandScope(() =>
      setTimeout(() => {
        void wakeIfUndelivered(services, approval.id, decidedBy, approval.burrowId);
      }, deliveryGraceMs),
    ).unref();
  return { ok: true, resultUrl: null };
};

/* Allowances (Access settings) ---------------------------------------------------------------------------------- */

export function toAllowance(row: typeof commandAllowances.$inferSelect): CommandAllowance {
  return {
    id: row.id,
    agentId: row.agentId,
    keyId: row.keyId,
    command: row.command,
    target: row.target || null,
    createdById: row.createdById,
    createdAt: iso(row.createdAt),
  };
}

/** An agent's allowances, newest first. */
export async function allowancesOf(db: Db | Tx, agentId: string): Promise<CommandAllowance[]> {
  const rows = await db
    .select()
    .from(commandAllowances)
    .where(eq(commandAllowances.agentId, agentId))
    .orderBy(desc(commandAllowances.createdAt), desc(commandAllowances.id));
  return rows.map(toAllowance);
}

/** “Remove” on an allowance (`agents.removeCommandAllowance`): the command asks again next time. */
export const removeCommandAllowance = defineCommand({
  name: 'agents.remove_command_allowance',
  schema: z.object({ allowanceId: z.string() }),
  // The person changes what the agent may do (one-agent.md OA-09).
  requiredKey: () => ({
    keyId: 'burrow.manage',
    attempt: 'remove a command the agent may always run',
    where: 'Agent',
  }),
  async apply(tx, ctx, input) {
    const agent = await loadAgentRow(tx, ctx.burrow.id);
    if (!agent) throw notFound('Agent');
    const [removed] = await tx
      .delete(commandAllowances)
      .where(and(eq(commandAllowances.id, input.allowanceId), eq(commandAllowances.agentId, agent.id)))
      .returning();
    if (!removed) throw notFound('Allowance');
    const event = await ctx.emit({
      type: 'command.allowance_removed',
      kind: 'Keys',
      text: `${shortName(agent)} asks again to ${runCommandPhrase(categoryOfKey(removed.keyId), removed.target || null)}`,
      where: `Agent · ${agent.handle}`,
      aboutId: agent.id,
      ref: { type: 'agent' },
      payload: { allowanceId: removed.id, agentId: agent.id, keyId: removed.keyId },
    });
    return { agentId: agent.id, eventId: event.id };
  },
});

/** The category a key stands for (the most specific one): what a removed allowance's log line names. */
function categoryOfKey(keyId: KeyId): CommandCategory {
  const found = CommandCategory.options.find((c) => commandCategoryKey(c) === keyId);
  return found ?? 'deploy';
}

export const COMMAND_APPROVAL_COMMANDS = [
  authorizeCommand,
  allowCommand,
  wakeAfterYes,
  removeCommandAllowance,
];
