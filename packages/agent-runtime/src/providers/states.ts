/**
 * Provider credential states (CT-24) from the signals the pinned providers actually give
 * (docs/decisions/managed-providers.md PV-05, with the signal table per provider and version):
 *
 * - Claude Code 2.1.283 (stream-JSON): the assistant message's `error` code, the result's `api_error_status`, and a
 *   subscription's `rate_limit_event` with `status: 'rejected'` (its usage limit; API-key sessions never send one).
 *   Observed from the pinned binary against a fake Messages API when Whombat still ran Claude Code's turns itself
 *   (before claude-directsdk.md CDS-01; that fixture is gone).
 * - ChatGPT on Hermes's own provider (hermes-native.md HN-02): what Hermes says when it fails a turn, by its words
 *   (`classifyProviderFailure`), and Hermes's own read-only check of the login at sign-in.
 * - Configuration: the eligibility policy, the pinned bundle, the recorded token expiry.
 *
 * Transient failures (a rate limit, one dropped stream) change nothing: the runner retries. Pure (no I/O).
 */
import type { CredentialState, RunSignalState } from './types';

/** Claude Code's `assistant.error` code (2.1.283) → the credential state it shows, or null (no change). */
export const CLAUDE_ERROR_STATES: Readonly<Record<string, RunSignalState | null>> = {
  authentication_failed: 'auth_revoked',
  oauth_org_not_allowed: 'auth_revoked',
  account_on_hold: 'auth_revoked',
  verification_required: 'auth_revoked',
  cloud_credential_error: 'auth_revoked',
  billing_error: 'quota_exhausted',
  rate_limit: null,
  overloaded: 'outage',
  server_error: 'outage',
  invalid_request: null,
  model_not_found: null,
  max_output_tokens: null,
  unknown: null,
};

/** An HTTP status from a provider → state (401/403 revoked, 402 quota, 5xx/529 outage; 429 is transient). */
export function stateFromHttpStatus(status: number | null | undefined): RunSignalState | null {
  if (status === null || status === undefined) return null;
  if (status === 401 || status === 403) return 'auth_revoked';
  if (status === 402) return 'quota_exhausted';
  if (status >= 500) return 'outage';
  return null;
}

/** Sign-in that has lapsed rather than been withdrawn (refresh failures, expired access tokens). */
const EXPIRED_TEXT =
  /refresh token (has )?(expired|been (used|revoked))|could not be refreshed|token (has )?expired|sign in again|log ?in again/i;

export interface ClaudeSignal {
  error?: string | null;
  httpStatus?: number | null;
  message?: string | null;
  /** A subscription's usage limit was reached (`rate_limit_event` rejected). */
  limitReached?: boolean;
}

export function stateFromClaudeSignal(signal: ClaudeSignal): RunSignalState | null {
  if (signal.message && EXPIRED_TEXT.test(signal.message)) return 'auth_expired';
  // A plain 429 is transient; a subscription whose limit is reached is used up until it resets.
  if (signal.limitReached && (signal.error === 'rate_limit' || signal.httpStatus === 429 || !signal.error))
    return 'quota_exhausted';
  const byCode = signal.error ? CLAUDE_ERROR_STATES[signal.error] : undefined;
  if (byCode !== undefined && byCode !== null) return byCode;
  return stateFromHttpStatus(signal.httpStatus);
}

/** A signal a failed run recorded on the credential, and until when it holds. */
export interface RecordedSignal {
  state: RunSignalState;
  at: string;
  /** Quota: when the provider said it resets; outage: when to look again. Null: until the next good run. */
  until: string | null;
}

export interface CredentialFacts {
  /** The eligibility policy refuses this mode for the workflow (its explanation). */
  refused: { explanation: string } | null;
  /** The installed runtime differs from the pinned bundle (its explanation). */
  drift: { explanation: string } | null;
  /** A sign-in exists for this provider. */
  signedIn: boolean;
  /** Recorded expiry (access tokens), ISO. */
  expiresAt: string | null;
  /** The last run's recorded signal, if any. */
  signal: RecordedSignal | null;
  now: Date;
}

export interface CredentialStatus {
  state: CredentialState;
  explanation: string | null;
}

/**
 * The one state of the person's credential (one-person.md OP-09), in order of what must be fixed first: the policy
 * refuses it, the runtime isn't the pinned one, nobody signed in, the sign-in lapsed, then what the last run reported.
 * Said to the person (“Your …”).
 */
export function credentialStatus(facts: CredentialFacts, names: { provider: string }): CredentialStatus {
  const whose = 'Your';
  if (facts.refused) return { state: 'gated', explanation: facts.refused.explanation };
  if (facts.drift) return { state: 'version_drift', explanation: facts.drift.explanation };
  if (!facts.signedIn)
    return {
      state: 'not_signed_in',
      explanation: `You haven’t signed in to ${names.provider} on this Whombat yet. Sign in under Settings → AI accounts.`,
    };
  if (facts.expiresAt && new Date(facts.expiresAt) <= facts.now)
    return {
      state: 'auth_expired',
      explanation: `${whose} ${names.provider} sign-in expired. Sign in again.`,
    };
  const signal = facts.signal;
  if (signal && (!signal.until || new Date(signal.until) > facts.now)) {
    const text: Record<RunSignalState, string> = {
      auth_expired: `${whose} ${names.provider} sign-in expired. Sign in again.`,
      auth_revoked: `${names.provider} refused your sign-in (revoked, suspended or wrong). Sign in again.`,
      quota_exhausted: `${whose} ${names.provider} usage limit or credit is used up${signal.until ? ` until ${signal.until}` : ''}. Whombat doesn’t switch to another sign-in or a paid key.`,
      outage: `${names.provider} isn’t answering right now. Runs wait and retry; nothing switches to another sign-in.`,
    };
    return { state: signal.state, explanation: text[signal.state] };
  }
  return { state: 'ready', explanation: null };
}
