/**
 * The skills as Hermes keeps them (hermes-engine.md HE-19, HE-38, HE-41; hermes-skills.md HSK-02…HSK-09), seen from the
 * server: every read and change is a step of the runner's Hermes-home service (`SKILLS_METHODS`), never the files. What
 * the runner answers with a failure code becomes the API's (`skillsError`): `not_found`, `conflict`, `bad_request`; a
 * busy profile (a turn running in it) and a runner that isn't there are `unavailable`, said in plain words; Hermes's
 * policy refusing a skill is `not_allowed` with `skill_blocked`, Hermes's hub (or no real Hermes) not answering
 * `unavailable` with `skill_hub_unavailable`, a name taken by an install `conflict` with `skill_exists` (CT-1419).
 */
import type { HermesHomeMethod, HermesHomeParams, HermesHomeResult, HermesSkillScan } from '@whombat/core';
import { HermesHomeCallError, hermesHome } from '../hermes-home/service';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors';
import type { Services } from '../services';

type SkillsMethod = Extract<HermesHomeMethod, `skills.${string}`>;

/** Steps that are Hermes's own code (the plugin's): `unavailable` from them is Hermes's, not a missing runner. */
const HERMES_STEPS: ReadonlySet<SkillsMethod> = new Set([
  'skills.scan',
  'skills.restore',
  'skills.hubSearch',
  'skills.hubInspect',
  'skills.hubInstall',
  'skills.hubUninstall',
  'skills.hubCheck',
  'skills.hubUpdate',
]);

/** How long a step may take (the plugin's budgets plus Hermes's start, HSK-S02); the bridge's default otherwise. */
const STEP_TIMEOUT_MS: Partial<Record<SkillsMethod, number>> = {
  'skills.sync': 120_000,
  'skills.restore': 60_000,
  'skills.scan': 60_000,
  'skills.hubSearch': 60_000,
  'skills.hubInspect': 100_000,
  'skills.hubInstall': 130_000,
  'skills.hubUninstall': 60_000,
  'skills.hubCheck': 100_000,
  'skills.hubUpdate': 130_000,
};

const WORDS = {
  away: 'The skills can’t be reached right now. Try again in a moment.',
  busy: 'The agent is working with these skills right now. Try again in a moment.',
  hub: 'Hermes’s skill hub didn’t answer. Try again in a moment.',
  noHermes: 'Hermes can’t check skills here right now. Try again in a moment.',
  blocked: 'Hermes found something risky in it, so it can’t be added.',
  exists: 'There’s already a skill with that name.',
};

/** One step of the runner's skills area, its failure as the API's. */
export async function skillsCall<M extends SkillsMethod>(
  services: Services,
  method: M,
  params: HermesHomeParams<M>,
  options: { timeoutMs?: number } = {},
): Promise<HermesHomeResult<M>> {
  const home = hermesHome(services);
  // No runner is there to answer (none polled in the last minute): say so now rather than after a timeout.
  if (!home.runnerSeen) throw new ApiError('unavailable', WORDS.away);
  try {
    const timeoutMs = options.timeoutMs ?? STEP_TIMEOUT_MS[method];
    return await home.call(method, params, timeoutMs ? { timeoutMs } : {});
  } catch (err) {
    throw skillsError(err, method);
  }
}

/** A Hermes-home failure as the API's error (pure on its code); anything else as it is. */
export function skillsError(err: unknown, method?: SkillsMethod): unknown {
  if (!(err instanceof HermesHomeCallError)) return err;
  const install = method === 'skills.hubInstall';
  switch (err.code) {
    case 'not_found':
      return notFound('Skill');
    case 'conflict':
      return install
        ? new ApiError('conflict', WORDS.exists, { details: { code: 'skill_exists' } })
        : conflict(err.message);
    case 'invalid':
    case 'too_long':
      return badRequest(err.message);
    case 'busy':
      return new ApiError('unavailable', WORDS.busy);
    case 'blocked':
      return blockedError(blockedFacts(err.message));
    case 'unavailable':
      if (method && HERMES_STEPS.has(method))
        return new ApiError('unavailable', method === 'skills.scan' ? WORDS.noHermes : WORDS.hub, {
          details: { code: 'skill_hub_unavailable' },
        });
      return new ApiError('unavailable', WORDS.away);
    default:
      return new ApiError('unavailable', WORDS.away);
  }
}

/** Hermes's policy refused a skill (`skill_blocked`), with the verdict and trust when they are known. */
export function blockedError(
  facts: { verdict?: string; trust?: string } = {},
  message = WORDS.blocked,
): ApiError {
  return new ApiError('not_allowed', message, {
    details: {
      code: 'skill_blocked',
      ...(facts.verdict ? { verdict: facts.verdict } : {}),
      ...(facts.trust ? { trust: facts.trust } : {}),
    },
  });
}

/** The trust and verdict in Hermes's own refusal (“Blocked (community source + caution verdict, 2 findings)”). */
export function blockedFacts(message: string): { verdict?: string; trust?: string } {
  const m = /\(([a-z-]+) source \+ ([a-z]+) verdict/.exec(message);
  return m ? { trust: m[1] as string, verdict: m[2] as string } : {};
}

/**
 * Hermes's guard on the person's edit (HSK-07): its `block` and `ask` (an agent's dangerous skill, which nobody
 * confirms here) are refused as `skill_blocked`.
 */
export function refuseUnlessAllowed(scan: HermesSkillScan, message: string): void {
  if (scan.decision === 'allow') return;
  throw blockedError({ verdict: scan.verdict, trust: scan.trust }, message);
}
