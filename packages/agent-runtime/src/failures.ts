/**
 * Why a turn failed for good, as one of contracts' `TurnFailureCode`s (docs/decisions/essentials-agents.md EA-08,
 * contracts CT-167): the runner reports it with `CompleteBody.failure` in both modes, from everything it knows — the
 * managed outcome, the refusal's code, the provider's credential signal and its message; the server falls back to the
 * same rules for what the runner can't know (a lost lease, no runner) and for older runners. Pure.
 *
 * | code          | when                                                                                         |
 * |---------------|----------------------------------------------------------------------------------------------|
 * | `signin`      | Claude/Codex not set up or not signed in for this person, a lapsed or revoked sign-in        |
 * | `usage_limit` | the sign-in's usage limit (with its reset time when the provider said); the AI gateway's     |
 * |               | pool with no room for the model (Fusebox's 429, with the wait it names: `gatewayRoomAt`)     |
 * | `provider`    | the provider errored or is unavailable (5xx, overloaded, network), its client isn't there    |
 * | `refused`     | the model declined the request's content (a safety or content filter): reword or switch model |
 * | `sandbox`     | the sandbox or its limits: bubblewrap, a read-only path, “fs sandbox helper failed”          |
 * | `timeout`     | the turn's wall time                                                                         |
 * | `runner`      | no runner, a lost lease, a runner without the provider                                       |
 * | `workspace`   | the working directory, the clone, the checkout or a git step                                 |
 * | `internal`    | anything else                                                                                |
 */
import type { TurnFailureCode, TurnFailureReport } from '@whombat/core';
import type { ManagedOutcome } from './access/managed/outcomes';
import type { RunSignalState } from './providers/types';

export interface FailureSignals {
  /** The technical text or code the dispatch ends with (`CompleteBody.error`, `dispatches.error`). */
  error?: string | null;
  /** The refusal's own code (`TurnRefusal.code`: `checkout`, `workspace_busy`, `provider.not_signed_in`, `sandbox_unavailable` …). */
  refusalCode?: string | null;
  /** A managed turn's outcome (`managed:<outcome>`). */
  managedOutcome?: ManagedOutcome | null;
  /** What the provider's failure said about the credential (PV-05). */
  credentialState?: RunSignalState | null;
  /** Until when that state holds (a usage limit's reset), ISO. */
  credentialUntil?: string | null;
}

const MANAGED: Record<ManagedOutcome, TurnFailureCode> = {
  not_signed_in: 'signin',
  auth_expired: 'signin',
  quota_exhausted: 'usage_limit',
  provider_outage: 'provider',
  provider_missing: 'provider',
  version_drift: 'provider',
  sandbox_unavailable: 'sandbox',
  output_limit: 'sandbox',
  memory_limit: 'sandbox',
  pids_limit: 'sandbox',
  wall_time: 'timeout',
  lease_lost: 'runner',
};

/** The runner's and the workspace's own refusal codes. */
const REFUSALS: Record<string, TurnFailureCode> = {
  sandbox_unavailable: 'sandbox',
  scratch_not_private: 'sandbox',
  work_folder_not_private: 'workspace',
  lease_lost: 'runner',
  workspace_busy: 'workspace',
  // A run turn whose checkout couldn't be made (resourceful-agents.md RA-DS54).
  checkout: 'workspace',
  trusted_personal_source: 'signin',
  credential_source_changed: 'signin',
  // A turn through the burrow's AI gateway this runner couldn't send there (Whombat ai-gateway.md AIG-12).
  gateway_unusable: 'provider',
  gateway_unavailable: 'provider',
};

/** Codes the server writes itself (`dispatches.error`). */
const SERVER_CODES: Record<string, TurnFailureCode> = {
  lease_expired: 'runner',
  runner_shutdown: 'runner',
  credential_source_changed: 'signin',
  'unrunnable:no_runner': 'runner',
  'unrunnable:provider': 'signin',
  'unrunnable:no_provider': 'signin',
  'unrunnable:acp': 'provider',
};

/** App error codes (`provider.*`, `client.*`, `managed.*`, SUB-50). */
function appCode(code: string): TurnFailureCode | null {
  if (code.startsWith('client.')) return 'provider';
  if (code === 'managed.acp_runtimes') return 'provider';
  if (code.startsWith('managed.')) return 'signin';
  if (code === 'provider.usage_failed') return 'provider';
  if (code.startsWith('provider.')) return 'signin';
  return null;
}

/**
 * Fusebox's answer when none of its accounts has room for the model (its 429): “all accounts for claude-opus-5-5 are
 * rate limited; next available in 2949s”, the wait to the first account's (ai-gateway.md AIG-D31).
 */
const GATEWAY_NO_ROOM = /all accounts for \S+ are rate limited(?:; next available in (\d+)s)?/i;

/**
 * What a turn ends with when its Hermes profile stayed busy (another Hermes held the profile's lock longer than the turn
 * may wait for it, `HermesProvider`). The server tells it apart by these words: an outsiders' turn is then queued again
 * rather than failed (Whombat outsiders-turns.md). Older runners send the same words.
 */
export const HERMES_PROFILE_BUSY =
  'I’m still busy with another of your conversations, so this one has to wait. Try again in a moment.';

/** Whether a turn's error is its Hermes profile staying busy (`HERMES_PROFILE_BUSY`). */
export function hermesProfileBusy(text: string | null | undefined): boolean {
  return (text ?? '').trim() === HERMES_PROFILE_BUSY;
}

/** Claude's third-party billing refusal (HTTP 400), even when Hermes calls it a malformed request. */
export function claudeExtraUsageRequired(text: string): boolean {
  return /\bthird[- ]party apps (?:now )?draw from (?:your )?extra usage\b/i.test(text);
}

/** When the AI gateway has room again as its answer says (`GATEWAY_NO_ROOM`), from `now`, ISO; null when it doesn't. */
export function gatewayRoomAt(text: string, now: Date): string | null {
  const seconds = GATEWAY_NO_ROOM.exec(text)?.[1];
  return seconds ? new Date(now.getTime() + Number(seconds) * 1000).toISOString() : null;
}

/**
 * The provider (or the AI gateway's filter) declined the request on its content, rather than erroring: the model
 * didn't answer, and the same request would be declined again, so the way forward is to reword it or switch models,
 * not to retry. Distinct from a usage limit, a sign-in problem or an outage. Matches the content/safety wording the
 * engines use (“safety filter refused this request”, “safeguards flagged this message”, “content policy”, …).
 */
export function providerDeclinedContent(text: string): boolean {
  return /safety filter refused|content[_ ]polic(?:y|ies)|safeguards? flagged|flagged (?:this|your) (?:message|request|prompt)|refused (?:this|the|your) (?:request|prompt)|declined to (?:answer|respond)|won['’]t answer this/i.test(
    text,
  );
}

/** Text rules over a provider's (or the runner's) message, most specific first. */
const TEXT_RULES: [TurnFailureCode, RegExp][] = [
  ['usage_limit', GATEWAY_NO_ROOM],
  // The dev monolith's real case: “fs sandbox helper failed … bwrap: Can't create file …: Read-only file system”.
  [
    'sandbox',
    /sandbox helper|bwrap|bubblewrap|read-only file system|\bEROFS\b|seccomp|landlock|user namespaces?|sandbox (is )?(unavailable|failed|error)|sandboxError/i,
  ],
  [
    'usage_limit',
    /usage[_ ]limit|hit your (usage )?limit|limit (has been )?reached|insufficient[_ ]quota|quota (exceeded|exhausted)|credit balance is too low|usageLimitExceeded/i,
  ],
  [
    'signin',
    /not logged in|please run \/login|log ?in again|sign in again|oauth token (has )?(expired|been revoked)|token[_ ]expired|invalid[_ ]grant|refresh token|could not be refreshed|token refresh failed|no codex credentials|re-?authenticate|invalid (api|x-api-)key|authentication[_ ](error|failed)|\b401\b|unauthori[sz]ed|not signed in/i,
  ],
  [
    'workspace',
    /\bgit (clone|fetch|push|checkout|worktree|switch|merge)\b|worktree|not a git repository|uncommitted changes|could not read from remote|repository not found|non-fast-forward|working directory/i,
  ],
  ['timeout', /wall[_ ]time|ran longer than a turn may/i],
  // A Fusebox that is restarting: its 503 before an answer, and the error ending an answer it cut short (Fusebox
  // 0.17). A hiccup of the gateway's, like an outage; the turn's retry goes through once it is back.
  [
    'provider',
    /Fusebox is restarting|Fusebox stopped before the answer was complete|overloaded|\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway time-?out|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|connection (error|refused|reset)|stream disconnected|error sending request|timed out|rate[_ ]limit|\b429\b|too many requests|flex capacity|upstream for \S+ stalled|\bENOENT\b|executable not found|command not found/i,
  ],
  ['runner', /No \S+ provider on this runner|lost contact with Whombat/i],
];

/** The classification of a failed turn (and, for a usage limit, when it resets). */
export function classifyTurnFailure(s: FailureSignals): TurnFailureReport {
  const error = (s.error ?? '').trim();
  const extraUsage = claudeExtraUsageRequired(error);
  const until = s.credentialUntil ?? null;
  const report = (code: TurnFailureCode): TurnFailureReport =>
    code === 'usage_limit' ? { code, resetsAt: extraUsage ? null : until } : { code };
  if (s.managedOutcome) return report(MANAGED[s.managedOutcome]);
  const managed = /^managed:([a-z_]+)$/.exec(error)?.[1] as ManagedOutcome | undefined;
  if (managed && managed in MANAGED) return report(MANAGED[managed]);
  for (const code of [s.refusalCode, error]) {
    if (!code) continue;
    const known = REFUSALS[code] ?? SERVER_CODES[code] ?? appCode(code);
    if (known) return report(known);
  }
  // Paying for extra usage needs an account action; a plan window's reset cannot fix it.
  if (extraUsage) return report('usage_limit');
  if (s.credentialState === 'quota_exhausted') return report('usage_limit');
  if (s.credentialState === 'auth_revoked' || s.credentialState === 'auth_expired') return report('signin');
  if (s.credentialState === 'outage') return report('provider');
  if (error.startsWith('unrunnable:')) return report('runner');
  if (error.startsWith('context:')) return report('internal');
  // A content/safety refusal reads like no other failure; retrying the same request wouldn't help (reword or switch
  // model), so it is its own code, checked before the error-text rules.
  if (providerDeclinedContent(error)) return report('refused');
  for (const [code, pattern] of TEXT_RULES) if (pattern.test(error)) return report(code);
  return report('internal');
}
