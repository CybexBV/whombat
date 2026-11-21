/**
 * The provider credential of one managed turn (PV-04; docs/decisions/one-person.md OP-09): the person's own sign-in for
 * the agent's provider, or the API key they added — the one home of that provider (`<root>/<provider>`) — if, and only
 * if, it exists, the policy allows its mode for this workflow, the runtime is the pinned one, and it hasn't lapsed.
 * Otherwise the turn is refused with the state and explanation the person sees. Turns outsiders' input starts (OP-17)
 * run on the same sign-in.
 *
 * The workflow (provider-evidence.md) is the person's own work either way: `PI` when they asked, or for what carries on
 * from their asking; `NA` for their automations and schedules, and for what outsiders' input starts while
 * they are away (a website report, a tracker's customer, a mail).
 *
 * There is deliberately no second choice: no key from the runner's environment, no operator login, no API-key fallback
 * when a subscription runs out. `resolveTurnCredential` reads exactly one directory.
 */

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { credentialEnv, readCredentialMeta } from './credential-home';
import type { DriftResult } from './drift';
import { providerEligibility } from './eligibility';
import { credentialStatus } from './states';
import {
  authModeName,
  type CredentialState,
  type ModelProvider,
  PROVIDER_NAMES,
  type Workflow,
} from './types';

export interface TurnCredential {
  workflow: Workflow;
  provider: ModelProvider;
  authMode: string;
  /** The provider's home (the sandbox mounts it, and only it, writable). */
  home: string;
  /** The provider's login environment from that home (and nothing else). */
  env: Record<string, string>;
}

export type TurnCredentialResult =
  | { ok: true; credential: TurnCredential }
  | {
      ok: false;
      state: CredentialState;
      /** `error.details.code` for the refusal. */
      code: string;
      explanation: string;
    };

export interface ResolveTurnCredentialInput {
  /** `WHOMBAT_CREDENTIALS_ROOT`. */
  root: string;
  provider: ModelProvider;
  /** The dispatch's trigger (`workflowOf`). */
  trigger: string;
  /** The drift check of this provider's runtime (null: matches). */
  drift?: DriftResult | null;
  now?: Date;
}

/**
 * Triggers that run the person's automations (a published automation's step, a schedule) and
 * Feedback assessments (outsiders' input, while the person is away): `NA`. Everything else is the person asking, or
 * carrying on what they asked: `PI`.
 */
const AUTOMATION_TRIGGERS = new Set(['automation', 'schedule', 'feedback']);

/** The workflow of a turn by its trigger (pure). */
export function workflowOf(trigger: string): Workflow {
  return AUTOMATION_TRIGGERS.has(trigger) ? 'NA' : 'PI';
}

/** App error codes of credential refusals (`provider.<state>`; new in 0.5.0, docs/managed/provider-login.md). */
export function credentialRefusalCode(state: CredentialState): string {
  return `provider.${state}`;
}

async function isPrivateHome(home: string): Promise<boolean> {
  const info = await lstat(home).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory() || info.mode & 0o077) return false;
  return typeof process.getuid !== 'function' || info.uid === process.getuid();
}

export async function resolveTurnCredential(
  input: ResolveTurnCredentialInput,
): Promise<TurnCredentialResult> {
  const now = input.now ?? new Date();
  const workflow = workflowOf(input.trigger);
  const home = join(input.root, input.provider);
  // A home that isn't a private directory of this user (a link, open to others) counts as no sign-in.
  const meta = (await isPrivateHome(home)) ? await readCredentialMeta(home) : null;
  const names = { provider: PROVIDER_NAMES[input.provider] };
  let refused: { explanation: string; code: string } | null = null;
  if (meta) {
    // The appliance's eligibility policy (PV-02), the only rules there are (HE-48).
    const verdict = providerEligibility({ provider: input.provider, authMode: meta.authMode, workflow });
    if (!verdict.allowed)
      refused = { explanation: verdict.explanation ?? '', code: verdict.code ?? 'managed.provider_excluded' };
    else if (meta.authMode === 'access_token' && (!meta.creatorAttested || !meta.expiresAt))
      refused = {
        code: 'managed.provider_gated',
        explanation: `A ${authModeName(input.provider, meta.authMode)} runs only when its creator stored it with its expiry. Sign in again.`,
      };
  }
  const status = credentialStatus(
    {
      refused,
      drift: input.drift && !input.drift.ok ? { explanation: input.drift.explanation } : null,
      signedIn: Boolean(meta),
      expiresAt: meta?.expiresAt ?? null,
      signal: meta?.signal ?? null,
      now,
    },
    names,
  );
  if (status.state !== 'ready' || !meta)
    return {
      ok: false,
      state: status.state,
      code: status.state === 'gated' && refused ? refused.code : credentialRefusalCode(status.state),
      explanation: status.explanation ?? '',
    };
  try {
    const env = await credentialEnv(home, input.provider, meta.authMode);
    return {
      ok: true,
      credential: { workflow, provider: input.provider, authMode: meta.authMode, home, env },
    };
  } catch {
    return {
      ok: false,
      state: 'not_signed_in',
      code: credentialRefusalCode('not_signed_in'),
      explanation: `Your ${names.provider} sign-in is incomplete. Sign in again.`,
    };
  }
}
