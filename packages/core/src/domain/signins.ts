/**
 * Provider sign-ins (MA-10, MA-17, SUB-01…SUB-05): the person's own sign-ins to Claude Code, ChatGPT and GitHub — one
 * credential home per provider holding a subscription sign-in or an API key the person added (Whombat one-person.md
 * OP-09, contracts 3.0, CT-1503) — and the console the Claude subscription sign-in runs in, as the `signins.*` ops carry
 * them (CT-70). Secrets never appear here: a key travels only in a `secret` op's input and is never echoed.
 */
import { z } from 'zod';
import { utf8ByteLength } from '../text/utf8.js';
import { Timestamp } from './common.js';

export const SignInProvider = z.enum(['claude', 'codex', 'github']);
export type SignInProvider = z.infer<typeof SignInProvider>;

/** How a sign-in authenticates: `api_key`, `subscription_cli`, `chatgpt`, `access_token`, `device`, … (open set). */
export const AuthModeName = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_]*$/);
export const ProviderLoginId = z.string().regex(/^plg_[A-Za-z0-9_-]{8,40}$/);
/** A sign-in console (CT-71). */
export const ProviderConsoleId = z.string().regex(/^pcn_[A-Za-z0-9_-]{8,40}$/);
export type ProviderConsoleId = z.infer<typeof ProviderConsoleId>;

/**
 * A credential's state as the person sees it (assignment §8: quota exhausted, auth expired and outage are distinct;
 * `owner_departed` went with other people's sign-ins in 3.0, CT-1503). Also `appliance.status.providers[].state` (`ProviderState` in `@whombat/protocol/session`).
 */
export const ProviderSignInState = z.enum([
  'ready',
  'not_signed_in',
  'quota_exhausted',
  'auth_expired',
  'auth_revoked',
  'outage',
  'version_drift',
  /** Can't run here (e.g. its sandbox can't start); a managed appliance never runs a turn without it. */
  'gated',
]);
export type ProviderSignInState = z.infer<typeof ProviderSignInState>;

/** `valid`: a free check accepted it; `unverified`: checked on first use. */
export const SignInVerified = z.enum(['valid', 'unverified']);

/** A code and the explanation people see (`provider.*`). */
export const SignInError = z.object({ code: z.string().max(64), message: z.string().max(500) });

/** A sign-in attempt as its owner sees it. */
export const ProviderLogin = z.object({
  loginId: ProviderLoginId,
  provider: SignInProvider,
  authMode: AuthModeName,
  state: z.enum(['awaiting_secret', 'awaiting_user', 'completed', 'failed', 'expired', 'cancelled']),
  /** Device flows: open `verificationUri` on any computer and enter `userCode` before `expiresAt`. */
  device: z
    .object({ verificationUri: z.url().max(500), userCode: z.string().max(40), expiresAt: Timestamp })
    .nullable(),
  /** Why it failed or expired (`provider.*` code and the explanation). */
  error: SignInError.nullable(),
  /** After a key: `valid` (a free check accepted it) or `unverified` (checked on first use). */
  verified: SignInVerified.nullable(),
  expiresAt: Timestamp,
});
export type ProviderLogin = z.infer<typeof ProviderLogin>;

/**
 * The person's sign-in for one provider (no secret, no fragment of one): a subscription or an API key (`authMode`
 * `api_key`), one per provider.
 */
export const ProviderSignIn = z.object({
  provider: SignInProvider,
  authMode: AuthModeName,
  createdAt: Timestamp,
  expiresAt: Timestamp.nullable(),
  verified: SignInVerified,
  /** GitHub: the login it belongs to. */
  login: z.string().max(100).nullable(),
  state: ProviderSignInState,
  explanation: z.string().max(500).nullable(),
});
export type ProviderSignIn = z.infer<typeof ProviderSignIn>;

/* The sign-in console (CT-71) ------------------------------------------------------------------------------------ */

/**
 * The console runs `claude auth login --claudeai` — the unmodified CLI's own sign-in, and nothing else — in a PTY
 * with the person's own credential home (SUB-02, SUB-03). The command follows from `{provider, authMode}` alone; no
 * input chooses a program, an argument or an environment variable, and there is no shell.
 */
export const PROVIDER_CONSOLE_COMMANDS = {
  'claude:subscription_cli': ['claude', 'auth', 'login', '--claudeai'],
} as const;
/** How long a console lives; the server stops it then (`expired`). */
export const PROVIDER_CONSOLE_TTL_S = 600;
/** Most bytes of one input write (UTF-8). */
export const PROVIDER_CONSOLE_INPUT_MAX_BYTES = 4_096;
/** Most output bytes one read answers with. */
export const PROVIDER_CONSOLE_READ_MAX_BYTES = 16_384;
/** Output the server keeps per console (the newest bytes); older output is dropped and a read says so. */
export const PROVIDER_CONSOLE_BUFFER_BYTES = 65_536;
/** Longest a read waits for new output. */
export const PROVIDER_CONSOLE_WAIT_MAX_MS = 25_000;
/** Terminal size bounds. */
export const PROVIDER_CONSOLE_COLS = { min: 20, max: 400 } as const;
export const PROVIDER_CONSOLE_ROWS = { min: 5, max: 200 } as const;
/** Largest output offset (a cursor); far above what a 10-minute login writes. */
export const PROVIDER_CONSOLE_MAX_OFFSET = 2_147_483_647;

export const ConsoleCols = z.number().int().min(PROVIDER_CONSOLE_COLS.min).max(PROVIDER_CONSOLE_COLS.max);
export const ConsoleRows = z.number().int().min(PROVIDER_CONSOLE_ROWS.min).max(PROVIDER_CONSOLE_ROWS.max);
export const ConsoleOffset = z.number().int().min(0).max(PROVIDER_CONSOLE_MAX_OFFSET);

/** Exported here too, beside the console input's limit in UTF-8 bytes. */
export { utf8ByteLength };

/** Standard base64 (with padding) of at most `maxBytes` bytes. */
export function base64Of(maxBytes: number) {
  return z
    .string()
    .max(Math.ceil(maxBytes / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
}

/** Console output bytes (PTY output, terminal escapes included), base64. */
export const ConsoleOutputData = base64Of(PROVIDER_CONSOLE_READ_MAX_BYTES);

/**
 * Keystrokes or pasted text for the console, as the terminal emulator produced them (control characters included:
 * `\r`, `\u0003`, escape sequences), at most 4 KiB of UTF-8.
 */
export const ConsoleInputText = z
  .string()
  .min(1)
  .max(PROVIDER_CONSOLE_INPUT_MAX_BYTES)
  .refine((s) => utf8ByteLength(s) <= PROVIDER_CONSOLE_INPUT_MAX_BYTES, 'at most 4 KiB of UTF-8');

/**
 * - `running`: the CLI runs; read its output, type into it.
 * - `completed`: it exited 0 and the CLI's own status says signed in — the sign-in is in `signins.list` (`claude` /
 *   `subscription_cli`).
 * - `failed`: it exited otherwise, or exited 0 without a sign-in (`error`: `provider.login_failed`,
 *   `provider.login_missing`).
 * - `cancelled`: its owner cancelled it, or a newer console for the same provider replaced it.
 * - `expired`: `PROVIDER_CONSOLE_TTL_S` passed; the process was stopped (`provider.login_expired`).
 */
export const ProviderConsoleState = z.enum(['running', 'completed', 'failed', 'cancelled', 'expired']);
export type ProviderConsoleState = z.infer<typeof ProviderConsoleState>;

/** A sign-in console as its owner sees it. It belongs to the account that started it; nobody else can see it. */
export const ProviderConsole = z.object({
  consoleId: ProviderConsoleId,
  provider: z.literal('claude'),
  authMode: z.literal('subscription_cli'),
  state: ProviderConsoleState,
  /** The CLI's exit code once it exited (null while running, or when it was stopped by a signal). */
  exitCode: z.number().int().min(-255).max(255).nullable(),
  cols: ConsoleCols,
  rows: ConsoleRows,
  startedAt: Timestamp,
  /** When the server stops it (`startedAt` + `PROVIDER_CONSOLE_TTL_S`). */
  expiresAt: Timestamp,
  endedAt: Timestamp.nullable(),
  /** Output bytes written so far: the end of the output (a read's cursor never passes it). */
  outputBytes: ConsoleOffset,
  /** The last input `seq` applied (0: none). */
  inputSeq: z.number().int().min(0).max(PROVIDER_CONSOLE_MAX_OFFSET),
  error: SignInError.nullable(),
});
export type ProviderConsole = z.infer<typeof ProviderConsole>;
