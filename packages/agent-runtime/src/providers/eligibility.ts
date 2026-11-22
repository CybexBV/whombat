/**
 * The provider eligibility policy (docs/decisions/managed-providers.md PV-02): the evidence register of
 * `appliance/docs/implementation/provider-evidence.md` (fetched 2026-09-25) as data — with the subscription
 * rows as decided on 2026-09-26 (docs/decisions/provider-subscriptions.md SUB-01, SUB-04) — and the managed-mode
 * rule that only `permitted` (and `permitted_candidate`, with its conditions) modes run turns. `gated` and
 * `excluded` modes are refused with the explanation people see. Every box runs this rule (one runtime mode,
 * hermes-engine.md HE-48).
 *
 * Pure (no I/O). Unknown provider × mode × workflow combinations are `excluded` (fail closed).
 */
import {
  type AuthMode,
  authModeName,
  type CredentialProvider,
  type ModelProvider,
  PROVIDER_NAMES,
  type Workflow,
} from './types';

/** Register classification (provider-evidence.md): documented permission, pending confirmation, or not permitted. */
export type Classification = 'permitted' | 'permitted_candidate' | 'gated' | 'excluded';

/** Evidence ids of the register (E-C1 … E-X3) plus `A-8` for assignment §8 and `A-1` for §1. */
export type EvidenceId = 'E-C1' | 'E-C2' | 'E-X1' | 'E-X2' | 'E-X3' | 'A-1' | 'A-8';

export interface RegisterRow {
  provider: ModelProvider;
  authMode: AuthMode<ModelProvider>;
  /** The person's own credential, per workflow (one-person.md OP-09: there is no other). */
  person: Record<Workflow, Classification>;
  evidence: readonly EvidenceId[];
  /** Conditions a `permitted_candidate` (or `permitted`) row holds only under; enforced by the caller. */
  conditions: readonly string[];
  /** What the register says is still open. */
  open: string | null;
}

/** The register (provider-evidence.md, 2026-09-25). One row per provider × auth mode. */
export const ELIGIBILITY_REGISTER: readonly RegisterRow[] = [
  {
    provider: 'claude',
    authMode: 'api_key',
    person: { PI: 'permitted', NA: 'permitted' },
    evidence: ['E-C1', 'E-C2'],
    conditions: ['The key is the person’s own: it serves their requests and automations.'],
    open: null,
  },
  {
    provider: 'claude',
    authMode: 'cloud',
    person: { PI: 'permitted', NA: 'permitted' },
    evidence: ['E-C1'],
    conditions: ['The customer’s own Bedrock / Google Cloud / Foundry credential, billed to them.'],
    open: 'Adapter configuration and sign-in are not built in this slice.',
  },
  {
    provider: 'claude',
    authMode: 'subscription_sdk',
    person: { PI: 'excluded', NA: 'excluded' },
    evidence: ['E-C2', 'E-C1'],
    conditions: [],
    open: null,
  },
  {
    // SUB-01…SUB-04 (docs/decisions/provider-subscriptions.md): permitted for the person's own work.
    provider: 'claude',
    authMode: 'subscription_cli',
    person: { PI: 'permitted', NA: 'permitted' },
    evidence: ['E-C1', 'E-C2'],
    conditions: [
      'The unmodified Claude Code binary, run as published (SUB-02, SUB-10).',
      'The person signs in through Claude Code’s own flow; Whombat never reads, copies or stores the login (SUB-03).',
      'A subscription serves only the person: their own requests and their automations (SUB-04).',
    ],
    open: null,
  },
  {
    provider: 'codex',
    authMode: 'api_key',
    person: { PI: 'permitted', NA: 'permitted' },
    evidence: ['E-X2'],
    conditions: ['The key is the person’s own: it serves their requests and automations.'],
    open: null,
  },
  {
    // SUB-01, SUB-04: a person's own ChatGPT sign-in (device code) for their own work.
    provider: 'codex',
    authMode: 'chatgpt',
    person: { PI: 'permitted', NA: 'permitted' },
    evidence: ['E-X2'],
    conditions: [
      'The person signs in with `codex login --device-auth`; Whombat never reads or copies auth.json (SUB-03).',
      'A ChatGPT sign-in serves only the person: their own requests and their automations (SUB-04).',
    ],
    open: null,
  },
  {
    provider: 'codex',
    authMode: 'access_token',
    person: { PI: 'permitted_candidate', NA: 'permitted_candidate' },
    evidence: ['E-X3', 'E-X2'],
    conditions: [
      'The token was created by the credential owner (“Each token belongs to its creator”).',
      'The token has an expiry, and runs stop once it has passed.',
      'The appliance is a trusted runner (the customer’s own device).',
    ],
    open: null,
  },
];

export function registerRow(provider: string, authMode: string): RegisterRow | null {
  return ELIGIBILITY_REGISTER.find((r) => r.provider === provider && r.authMode === authMode) ?? null;
}

/** App error codes (`error.details.code`) of eligibility refusals (new in 0.5.0, see provider-login.md). */
export const ELIGIBILITY_CODES = {
  gated: 'managed.provider_gated',
  excluded: 'managed.provider_excluded',
} as const;

export interface EligibilityInput {
  provider: string;
  authMode: string;
  workflow: Workflow;
}

export interface EligibilityVerdict {
  classification: Classification;
  /** May a turn run (or a sign-in be started) in this mode? */
  allowed: boolean;
  /** `managed.provider_gated` / `managed.provider_excluded` when refused. */
  code: string | null;
  /** What people see when refused. */
  explanation: string | null;
  evidence: readonly EvidenceId[];
  conditions: readonly string[];
}

const WORKFLOW_WORDS: Record<Workflow, string> = {
  PI: 'your own requests',
  NA: 'your automations',
};

function refusalText(input: EligibilityInput, row: RegisterRow | null, c: Classification): string {
  const provider = PROVIDER_NAMES[input.provider as CredentialProvider] ?? input.provider;
  const mode = authModeName(input.provider as CredentialProvider, input.authMode);
  if (!row) return `${provider} with ${mode} isn’t a sign-in Whombat supports on a managed appliance.`;
  if (input.provider === 'claude' && input.authMode === 'subscription_sdk')
    return 'Whombat runs Claude Code itself, never through the Agent SDK, and Anthropic doesn’t allow apps built on the Agent SDK to use Claude.ai logins. Sign in to Claude Code with your subscription, or use your own Anthropic API key.';
  return c === 'gated'
    ? `${provider} with ${mode} isn’t enabled on a managed Whombat yet.`
    : `${provider} with ${mode} can’t be used for ${WORKFLOW_WORDS[input.workflow]} on a managed Whombat.`;
}

/** The classification of one provider × mode × workflow, and whether managed mode lets it run. */
export function providerEligibility(input: EligibilityInput): EligibilityVerdict {
  const row = registerRow(input.provider, input.authMode);
  const classification: Classification = !row ? 'excluded' : row.person[input.workflow];
  const evidence = row?.evidence ?? ['A-8'];
  const conditions = row?.conditions ?? [];
  const allowed = classification === 'permitted' || classification === 'permitted_candidate';
  return {
    classification,
    allowed,
    code: allowed ? null : ELIGIBILITY_CODES[classification === 'gated' ? 'gated' : 'excluded'],
    explanation: allowed ? null : refusalText(input, row, classification),
    evidence,
    conditions,
  };
}

/**
 * May this mode be signed in to at all on a managed appliance (some workflow of it is allowed)? A sign-in whose
 * every workflow is refused is refused up front, with the same explanation a turn would get.
 */
export function signInEligibility(
  input: Omit<EligibilityInput, 'workflow'> & { provider: CredentialProvider },
): EligibilityVerdict {
  if (input.provider === 'github')
    return {
      classification: 'permitted',
      allowed: true,
      code: null,
      explanation: null,
      evidence: ['A-8'],
      conditions: [],
    };
  const verdicts = (['PI', 'NA'] as const).map((workflow) => providerEligibility({ ...input, workflow }));
  return verdicts.find((v) => v.allowed) ?? (verdicts[0] as EligibilityVerdict);
}
