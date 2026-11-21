/**
 * Provider sign-ins (`api.signins`, CT-70), reached as the session's `signins.*` ops (CT-06). Every op acts for the
 * person: one sign-in per provider, a subscription or an API key they add (`authMode` `api_key`; Whombat
 * one-person.md OP-09, contracts 3.0, CT-1503). A secret travels only in a `secret` op's input (CT-44): the
 * server never logs or echoes it, and the receipt keeps no digest of it.
 */
import { z } from 'zod';
import { Timestamp } from '../domain/common.js';
import {
  AuthModeName,
  ConsoleCols,
  ConsoleInputText,
  ConsoleOffset,
  ConsoleOutputData,
  ConsoleRows,
  PROVIDER_CONSOLE_MAX_OFFSET,
  PROVIDER_CONSOLE_WAIT_MAX_MS,
  ProviderConsole,
  ProviderConsoleId,
  ProviderLogin,
  ProviderLoginId,
  ProviderSignIn,
  SignInProvider,
} from '../domain/signins.js';
import { endpoint } from './endpoint.js';

/** The person's sign-ins, open attempts and consoles, and what the eligibility policy lets them start. */
export const ProvidersListOutput = z.object({
  signIns: z.array(ProviderSignIn).max(16),
  logins: z.array(ProviderLogin).max(16),
  /** What the eligibility policy lets the person start, and why not. */
  modes: z
    .array(
      z.object({
        provider: SignInProvider,
        authMode: AuthModeName,
        available: z.boolean(),
        reason: z.string().max(500).nullable(),
      }),
    )
    .max(32),
  /**
   * The account's sign-in consoles (CT-71): running ones, and ended ones until they expire, so a reloaded page can
   * pick one up again.
   */
  consoles: z.array(ProviderConsole).max(8).default([]),
});
export type ProvidersListOutput = z.infer<typeof ProvidersListOutput>;

export const ProviderLoginStartBody = z.strictObject({ provider: SignInProvider, authMode: AuthModeName });
/** A key or token for an `awaiting_secret` attempt. */
export const ProviderLoginSubmitBody = z.strictObject({
  secret: z.string().min(8).max(4_096),
  /** Codex access tokens: when it expires (required for them, at most 90 days ahead). */
  expiresAt: Timestamp.optional(),
  /** Codex access tokens: “I created this token” (each token belongs to its creator). */
  creatorAttested: z.boolean().optional(),
});
export const ProviderLogoutOutput = z.object({ removed: z.boolean() });

/* The sign-in console (CT-71) ------------------------------------------------------------------------------------ */

/**
 * Start the Claude subscription sign-in in a console (the account's own; SUB-02, SUB-03). A running console of the same
 * account and provider is cancelled first, so a second tab takes over instead of racing it.
 */
export const ProviderConsoleStartBody = z.strictObject({
  provider: z.literal('claude'),
  authMode: z.literal('subscription_cli'),
  cols: ConsoleCols,
  rows: ConsoleRows,
});

/**
 * Read output from `cursor` (a byte offset; start at 0, then send the previous `next`). With `waitMs` the read waits
 * until there is output past `cursor` or the console ended (long poll; over the session set `deadlineMs` above it).
 */
export const ProviderConsoleReadQuery = z.object({
  cursor: z.coerce.number().int().min(0).max(PROVIDER_CONSOLE_MAX_OFFSET).default(0),
  waitMs: z.coerce.number().int().min(0).max(PROVIDER_CONSOLE_WAIT_MAX_MS).default(0),
});

/**
 * Output from `from` to `next` (at most `PROVIDER_CONSOLE_READ_MAX_BYTES`). `from` is later than the cursor asked for
 * when that output was already dropped (the server keeps the newest `PROVIDER_CONSOLE_BUFFER_BYTES`). `more`: output
 * past `next` is already there, so read again at once. Stop reading once `console.state` isn't `running` and `more`
 * is false.
 */
export const ProviderConsoleOutput = z.object({
  console: ProviderConsole,
  from: ConsoleOffset,
  data: ConsoleOutputData,
  next: ConsoleOffset,
  more: z.boolean(),
});
export type ProviderConsoleOutput = z.infer<typeof ProviderConsoleOutput>;

/**
 * Keystrokes for the console. `seq` numbers the writes of one console from 1 in order; a write whose `seq` was already
 * applied is answered without typing it again, so a client can resend after a lost answer. A gap (`seq` above the
 * last applied + 1) is refused (`provider.console_input_gap`, with the last applied `seq`).
 */
export const ProviderConsoleWriteBody = z.strictObject({
  seq: z.number().int().min(1).max(PROVIDER_CONSOLE_MAX_OFFSET),
  data: ConsoleInputText,
});
export const ProviderConsoleResizeBody = z.strictObject({ cols: ConsoleCols, rows: ConsoleRows });

const LoginParams = z.object({ loginId: ProviderLoginId });
const ConsoleParams = z.object({ consoleId: ProviderConsoleId });

export const providerSignInEndpoints = {
  list: endpoint({
    id: 'signins.list',
    method: 'GET',
    path: '/sign-ins',
    summary:
      'The caller’s own provider sign-ins, open sign-in attempts and consoles, and which sign-in modes the policy lets them start.',
    response: ProvidersListOutput,
  }),
  loginStart: endpoint({
    id: 'signins.loginStart',
    method: 'POST',
    path: '/sign-ins/logins',
    summary:
      'Start a sign-in for the caller: key entry (`awaiting_secret`, also the API key the person adds) or a device code (`awaiting_user`). One sign-in per provider. A secret op.',
    body: ProviderLoginStartBody,
    response: ProviderLogin,
    status: 201,
  }),
  loginStatus: endpoint({
    id: 'signins.loginStatus',
    method: 'GET',
    path: '/sign-ins/logins/:loginId',
    summary: 'One of the caller’s sign-in attempts (poll every 2–5 s while `awaiting_user`).',
    params: LoginParams,
    response: ProviderLogin,
  }),
  loginSubmit: endpoint({
    id: 'signins.loginSubmit',
    method: 'POST',
    path: '/sign-ins/logins/:loginId/submit',
    summary: 'Give an `awaiting_secret` attempt its key or token (never logged or echoed). A secret op.',
    params: LoginParams,
    body: ProviderLoginSubmitBody,
    response: ProviderLogin,
  }),
  loginCancel: endpoint({
    id: 'signins.loginCancel',
    method: 'POST',
    path: '/sign-ins/logins/:loginId/cancel',
    summary: 'Cancel one of the caller’s sign-in attempts.',
    params: LoginParams,
    response: ProviderLogin,
  }),
  logout: endpoint({
    id: 'signins.logout',
    method: 'DELETE',
    path: '/sign-ins/providers/:provider',
    summary:
      'Sign the caller out of a provider: its CLI logs out where it can, and the credential home is removed.',
    params: z.object({ provider: SignInProvider }),
    response: ProviderLogoutOutput,
  }),
  consoleStart: endpoint({
    id: 'signins.consoleStart',
    method: 'POST',
    path: '/sign-ins/consoles',
    summary:
      'Start the Claude subscription sign-in (`claude auth login --claudeai`, nothing else) in a console for the caller.',
    body: ProviderConsoleStartBody,
    response: ProviderConsole,
    status: 201,
  }),
  consoleRead: endpoint({
    id: 'signins.consoleRead',
    method: 'GET',
    path: '/sign-ins/consoles/:consoleId',
    summary: 'The console’s state and output from a cursor, waiting up to `waitMs` for more. A secret op.',
    params: ConsoleParams,
    query: ProviderConsoleReadQuery,
    response: ProviderConsoleOutput,
  }),
  consoleWrite: endpoint({
    id: 'signins.consoleWrite',
    method: 'POST',
    path: '/sign-ins/consoles/:consoleId/input',
    summary: 'Type into the console (at most 4 KiB, numbered by `seq`; never logged). A secret op.',
    params: ConsoleParams,
    body: ProviderConsoleWriteBody,
    response: ProviderConsole,
  }),
  consoleResize: endpoint({
    id: 'signins.consoleResize',
    method: 'POST',
    path: '/sign-ins/consoles/:consoleId/resize',
    summary: 'The terminal’s new size.',
    params: ConsoleParams,
    body: ProviderConsoleResizeBody,
    response: ProviderConsole,
  }),
  consoleCancel: endpoint({
    id: 'signins.consoleCancel',
    method: 'POST',
    path: '/sign-ins/consoles/:consoleId/cancel',
    summary: 'Stop the console’s sign-in (`cancelled`).',
    params: ConsoleParams,
    response: ProviderConsole,
  }),
};
