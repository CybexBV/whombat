/**
 * Why a managed turn ended the way it did, as distinct outcomes (docs/decisions/managed-sandbox.md MSB-14,
 * assignment §8): the login was never there, it expired or was revoked, its quota ran out, the provider is down, its binary is missing or not the pinned version — and the sandbox's own limits.
 * Each has a stable code (`CompleteBody.error`, `managed:<code>`) and what the agent says. None of them ever
 * falls back to another identity, the host's login or a paid API key: the turn stops and says why.
 *
 * Pure: the classifier reads the provider's error text (the CLIs' own messages, stable enough to match; an
 * unknown message stays an ordinary failure).
 */

export type ManagedOutcome =
  | 'not_signed_in'
  | 'auth_expired'
  | 'quota_exhausted'
  | 'provider_outage'
  | 'provider_missing'
  | 'version_drift'
  | 'sandbox_unavailable'
  | 'output_limit'
  | 'memory_limit'
  | 'pids_limit'
  | 'wall_time'
  | 'lease_lost';

/** Outcomes a retry can't fix (the server doesn't retry a refusal); the rest are failures it may retry once. */
export const FINAL_OUTCOMES: ReadonlySet<ManagedOutcome> = new Set([
  'not_signed_in',
  'auth_expired',
  'quota_exhausted',
  'provider_missing',
  'version_drift',
  'sandbox_unavailable',
  'output_limit',
  'memory_limit',
  'pids_limit',
  'wall_time',
]);

export const outcomeCode = (outcome: ManagedOutcome) => `managed:${outcome}`;

/** What people call the subscription a turn runs on (chat-runtime.md CR-04): ChatGPT, since no Codex CLI runs (HN-02). */
const LABEL = { claude: 'Claude', codex: 'ChatGPT' } as const;
type Provider = keyof typeof LABEL;

/** What the agent says in the conversation (its own voice, one or two sentences). */
export function outcomeCopy(outcome: ManagedOutcome, provider: string, detail?: string): string {
  const p = LABEL[provider as Provider] ?? provider;
  switch (outcome) {
    case 'not_signed_in':
      return `You haven’t signed in to ${p} for me on this Whombat yet, so I can’t work. Sign in under Settings → AI accounts, then ask me again.`;
    case 'auth_expired':
      return `Your ${p} sign-in has expired or was revoked. Sign in to ${p} again, then ask me again.`;
    case 'quota_exhausted':
      return `The ${p} sign-in I use has hit its usage limit. Ask me again once it resets, or give me another sign-in.`;
    case 'provider_outage':
      return `${p} isn’t answering right now, so I couldn’t finish. Ask me again in a little while.`;
    case 'provider_missing':
      return `${p} isn’t installed on this Whombat, so I can’t work. It comes back with the next update.`;
    case 'version_drift':
      return `${p} on this Whombat isn’t the version it should be${detail ? ` (${detail})` : ''}, so I didn’t start. An update puts it right.`;
    case 'sandbox_unavailable':
      return 'My sandbox can’t start on this Whombat, and I never work without it. I didn’t do anything.';
    case 'output_limit':
      return 'I stopped: what I was running printed far more than a turn may. Ask me again with a narrower task.';
    case 'memory_limit':
      return 'I stopped: what I was running used more memory than a turn may. Ask me again with a smaller task.';
    case 'pids_limit':
      return 'I stopped: what I was running started more processes than a turn may.';
    case 'wall_time':
      return 'I stopped: this turn ran longer than a turn may. Ask me again to pick it up.';
    case 'lease_lost':
      return 'I lost contact with Whombat and stopped, so another turn can take this over.';
  }
}

const RULES: [ManagedOutcome, RegExp][] = [
  // Missing binary first: "spawn codex ENOENT", "Claude Code executable not found". Only a program that couldn't be
  // started: any other missing file (a turn's folder the pod can't see) is an ordinary failure, not a missing provider.
  [
    'provider_missing',
    /\bspawn \S+ ENOENT\b|executable not found|command not found|No such file or directory \(os error 2\)/i,
  ],
  [
    'auth_expired',
    // Hermes's ChatGPT words too (hermes-native.md HN-02): “No Codex credentials stored”, “Codex token refresh failed”,
    // “… to re-authenticate”.
    /oauth token (has )?(expired|revoked)|token[_ ]expired|invalid[_ ]grant|refresh[_ ]token[_ ]reused|could not be refreshed|token refresh failed|no codex credentials|re-?authenticate|please (run \/login|log ?in again|sign in again)|not logged in|invalid (api|x-api-)key|authentication[_ ]error|\b401\b|unauthori[sz]ed|revoked/i,
  ],
  [
    'quota_exhausted',
    /usage[_ ]limit|limit reached|hit your (usage )?limit|insufficient[_ ]quota|quota (exceeded|exhausted)|credit balance is too low|rate[_ ]limit|\b429\b|too many requests/i,
  ],
  [
    'provider_outage',
    /overloaded|\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway time-?out|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|connection (error|refused|reset)|stream disconnected|error sending request|timed out/i,
  ],
];

/** The outcome a provider's error message means, or null for an ordinary failure. */
export function classifyProviderFailure(message: string): ManagedOutcome | null {
  for (const [outcome, pattern] of RULES) if (pattern.test(message)) return outcome;
  return null;
}

/** `2.1.282 (Claude Code)` → `2.1.282`. */
export function parseProviderVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)?.[1] ?? null;
}

export type VersionCheck =
  | { ok: true; version: string; pinned: string | null }
  | { ok: false; outcome: 'provider_missing' | 'version_drift'; detail: string };

/**
 * The installed provider against its pin (the pinning is the release's, `WHOMBAT_PROVIDER_PINS`): no output →
 * missing; another version → drift. Unpinned passes (and says so).
 */
export function checkProviderVersion(output: string | null, pinned: string | undefined): VersionCheck {
  if (output === null) return { ok: false, outcome: 'provider_missing', detail: 'not installed' };
  const version = parseProviderVersion(output);
  if (!version)
    return {
      ok: false,
      outcome: 'provider_missing',
      detail: `unrecognised version “${output.trim().slice(0, 80)}”`,
    };
  if (pinned && version !== pinned)
    return { ok: false, outcome: 'version_drift', detail: `${version} instead of ${pinned}` };
  return { ok: true, version, pinned: pinned ?? null };
}

/**
 * Environment that keeps a provider CLI from updating itself under a managed release (its version is the
 * release's): Claude Code's auto-updater and other non-essential traffic off.
 */
export function noSelfUpdateEnv(provider: string): Record<string, string> {
  if (provider === 'claude')
    return {
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    };
  return {};
}
