/**
 * What a turn may do, from its dispatch context alone: the agent's grants as the keys engine sees them, the sandbox
 * (`workspace-write` for a writable checkout or the agent's work folder), the network (“Browse the web”) and whether
 * the turn runs the agent's commands. One implementation for the runner, which prepares the turn by it, and the
 * prompt, which describes it. Pure.
 */
import type { DispatchContext } from '@whombat/core/contracts';
import type { Grant } from '@whombat/core/domain';
import { branchWriteKey, decide, type KeyId } from '@whombat/core/keys';

/** The agent's grants as the keys engine sees them (from the persona's key rows). */
export function personaGrants(ctx: Pick<DispatchContext, 'agent'>): Grant[] {
  const k = ctx.agent.keys;
  return [
    ...k.can.map((x) => ({ agentId: ctx.agent.id, keyId: x.id, tier: 'can' as const })),
    ...k.ask.map((x) => ({ agentId: ctx.agent.id, keyId: x.id, tier: 'ask' as const })),
    ...k.cannot.map((x) => ({ agentId: ctx.agent.id, keyId: x.id, tier: 'cannot' as const })),
  ];
}

/** How the keys engine answers the agent for `keyId`: `allow`, `ask` or `deny`. */
export function keyOutcome(ctx: Pick<DispatchContext, 'agent'>, keyId: KeyId): 'allow' | 'ask' | 'deny' {
  return decide({ id: ctx.agent.id, kind: 'agent' }, personaGrants(ctx), keyId).outcome;
}

/** The agent holds `keyId` at `can` or `ask` (a tool behind it runs, or asks a person first). */
export function holdsKey(ctx: Pick<DispatchContext, 'agent'>, keyId: KeyId): boolean {
  return keyOutcome(ctx, keyId) !== 'deny';
}

/**
 * A person's commands turn (Whombat one-person.md OP-07, OP-S109): the server gave the
 * turn its commands' context (`DispatchContext.commands`, null in an outsiders' turn) and it isn't a Whombat Feedback
 * assessment. A turn without a checkout is one too (AC-24): it works in the agent's work folder (`~/work`). The runner
 * sets the turn's commands up by exactly this rule (and clears `commands` from the context it builds the turn from when
 * it runs none), so the prompt and the turn agree.
 */
export function isCommandsTurn(ctx: DispatchContext): boolean {
  if (!ctx.commands) return false;
  return ctx.dispatch.trigger !== 'feedback';
}

/**
 * A commands turn without a checkout (OP-S109): its working directory is the agent's work folder, `~/work` in the
 * agent's home, writable and kept between turns.
 */
export function isWorkFolderTurn(ctx: DispatchContext): boolean {
  return isCommandsTurn(ctx) && !ctx.workspace;
}

/**
 * `workspace-write` for coding work on a branch the agent may write — its branch key allows it, or it asks and a
 * person approved exactly this turn's branch (`writeApproved`, bp-automations.md BP-C37) — and for a commands turn
 * without a checkout (its work folder, one-person.md OP-S109). Everything else is read-only — also a checkout an
 * automation gave the agent only to read (a review, an investigation: BP-C26). The key is classified against the repository's default branch, never
 * the base (BP-C36).
 */
export function sandboxFor(ctx: DispatchContext): 'read-only' | 'workspace-write' {
  // A Whombat Feedback assessment is read-only whatever the keys say (docs/decisions/feedback.md FB-21).
  if (ctx.dispatch.trigger === 'feedback') return 'read-only';
  if (isWorkFolderTurn(ctx)) return 'workspace-write';
  const ws = ctx.workspace;
  if (!ws || ws.access === 'read') return 'read-only';
  const d = decide(
    { id: ctx.agent.id, kind: 'agent' },
    personaGrants(ctx),
    branchWriteKey(ws.branch, ws.defaultBranch),
    {
      branch: ws.branch,
      repo: ws.repo,
    },
  );
  if (d.outcome === 'allow') return 'workspace-write';
  return d.outcome === 'ask' && ws.writeApproved ? 'workspace-write' : 'read-only';
}

/**
 * How a key behind the turn's own tools stands for it (hermes-engine.md HE-44): `allow` runs them, `ask` asks a person
 * each time through Hermes's hook, `deny` blocks them. Never while assessing a report (FB-21: its URLs are not to be
 * visited), and Ask only in a commands turn: elsewhere the turn's commands share the task's network, which a yes to one
 * web page would open for them as well.
 */
export function toolKeyAccess(
  ctx: DispatchContext,
  keyId: 'web.browse' | 'browser.use',
): 'allow' | 'ask' | 'deny' {
  if (ctx.dispatch.trigger === 'feedback') return 'deny';
  const outcome = keyOutcome(ctx, keyId);
  return outcome === 'ask' && !isCommandsTurn(ctx) ? 'deny' : outcome;
}

/** Network access for the agent's own tools: with “Browse the web” at Allowed, or at Ask in a commands turn. */
export function networkFor(ctx: DispatchContext): boolean {
  return toolKeyAccess(ctx, 'web.browse') !== 'deny';
}
