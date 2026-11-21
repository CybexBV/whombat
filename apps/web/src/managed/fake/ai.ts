/**
 * A fake of the AI side of a Whombat (SUB-01…SUB-11, CT-70…CT-72) for the fixture transport (tests, Storybook, visual
 * checks) and the fake managed world: Claude Code installing at its latest tested version (the only client: ChatGPT
 * needs nothing installed, and `clients.install` for it is refused as the runtime refuses it, chatgpt-no-client.md
 * AP-5619), the person's own sign-ins (Claude Code's sign-in console, ChatGPT's device code, API keys; one per
 * provider, CT-1503), open attempts and consoles. Answers are neutral (`FakeAiAnswer`); `restAnswer` / `sessionAnswer` shape them for the
 * transport (REST puts the app code in `details.code`, the session in `error.code`, AP-19).
 *
 * The console plays `claude auth login --claudeai` as Claude Code 2.1.283 does, just enough to try the UI: it prints the
 * sign-in link (an OSC 8 hyperlink) and asks for the code without echoing it; any code of 6+ characters signs in,
 * `wrong` prints “Login failed: …” and exits 1, Ctrl+C stops it.
 */
import { CLIENT_PROVIDERS, type ClientProvider, needsClient } from '@whombat/client/signins';
import type {
  ClientStatus,
  LiveProvider,
  ProviderConsole,
  ProviderLogin,
  ProviderSignIn,
  SignInProvider,
} from '@whombat/core/domain';
import {
  PROVIDER_CONSOLE_BUFFER_BYTES,
  PROVIDER_CONSOLE_READ_MAX_BYTES,
  PROVIDER_CONSOLE_TTL_S,
} from '@whombat/core/domain';

export interface FakeAiOptions {
  /** Installed at the start: its version (Claude Code, the only client). */
  installed?: Partial<Record<ClientProvider, string>>;
  /** Already signed in at the start (GitHub too: a managed box's own GitHub sign-in, essentials item 6). */
  signedIn?: { provider: SignInProvider; authMode: string; state?: ProviderSignIn['state'] }[];
  /** How long an install takes. */
  installMs?: number;
  /** The device code completes on this status poll. */
  deviceCompletesAfterPolls?: number;
  /** The page ChatGPT's device code sign-in names (default `https://auth.openai.com/codex/device`). */
  deviceUri?: string;
  /** The sign-in link the console prints (default a claude.com link, as Claude Code 2.1.283 prints it). */
  consoleLink?: string;
  /** Installing this client fails. */
  failInstall?: ClientProvider[];
  /**
   * No tested version of this client is published (an appliance whose manager answers `unavailable`): the install
   * answers `failed` with `client.unavailable`, and — as a runtime before Whombat SUB-55 did — the list still says
   * `not_installed`.
   */
  unpublished?: ClientProvider[];
  /** Modes the policy refuses, with the reason. */
  unavailable?: { provider: LiveProvider; authMode: string; reason: string }[];
  now?: () => number;
  /** State kept from before (the fake managed world survives a reload in localStorage). */
  restore?: FakeAiSnapshot;
}

/** What survives a reload: sign-ins and installed clients (not attempts or consoles). */
export interface FakeAiSnapshot {
  signIns: ProviderSignIn[];
  installed: Partial<Record<ClientProvider, ClientRecord['installed']>>;
}

export interface FakeAiAnswer {
  status: number;
  body?: unknown;
  /** Errors: the app code (`provider.console_input_gap`), the message and details. */
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export const FAKE_LATEST: Record<ClientProvider, string> = { claude: '2.1.278' };
/** The runtime's refusal of `clients.install` for ChatGPT (Whombat hermes-native.md HN-C08; AP-5619). */
export const FAKE_NO_CLIENT = 'ChatGPT needs nothing installed. Sign in to it in Settings → AI sign-in.';
/** The GitHub account the fake's GitHub sign-ins belong to. */
export const FAKE_GITHUB_LOGIN = 'maraokafor';
const PUBLISHED = '2026-09-24T08:00:00Z';

interface ClientRecord {
  installed: { version: string; installedAt: string } | null;
  installStartedAt: number | null;
  failed: { code: string; message: string } | null;
}

interface ConsoleRecord {
  c: ProviderConsole;
  bytes: number[];
  line: string;
  waiters: Set<() => void>;
}

interface LoginRecord {
  login: ProviderLogin;
  polls: number;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function randomId(n: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => alphabet[x % alphabet.length]).join('');
}

function toBase64(bytes: number[]): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));

const fail = (status: number, code: string, message: string, details?: Record<string, unknown>) => ({
  status,
  error: { code, message, ...(details && { details }) },
});
const ok = (body: unknown, status = 200): FakeAiAnswer => ({ status, body });

export type FakeAi = ReturnType<typeof createFakeAi>;

export function createFakeAi(options: FakeAiOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const installMs = options.installMs ?? 4_000;
  const clients: Record<ClientProvider, ClientRecord> = {
    claude: { installed: null, installStartedAt: null, failed: null },
  };
  for (const p of CLIENT_PROVIDERS) {
    const i = options.installed?.[p];
    if (i) clients[p].installed = { version: i, installedAt: iso(now() - 86_400_000) };
  }
  let signIns: ProviderSignIn[] = (options.signedIn ?? []).map((s) =>
    signInOf(s.provider, s.authMode, s.state),
  );
  if (options.restore) {
    signIns = options.restore.signIns;
    for (const p of CLIENT_PROVIDERS) clients[p].installed = options.restore.installed[p] ?? null;
  }
  const logins = new Map<string, LoginRecord>();
  const consoles = new Map<string, ConsoleRecord>();
  const failInstall = new Set(options.failInstall ?? []);
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of [...listeners]) l();
  };

  function signInOf(provider: SignInProvider, authMode: string, state: ProviderSignIn['state'] = 'ready') {
    return {
      provider,
      authMode,
      createdAt: iso(now()),
      expiresAt: null,
      verified: 'valid' as const,
      // GitHub sign-ins name the account they belong to (“Signed in as @maraokafor”).
      login: provider === 'github' ? FAKE_GITHUB_LOGIN : null,
      state,
      explanation: state === 'ready' ? null : state === 'auth_expired' ? 'Sign in again.' : null,
    };
  }

  function clientStatus(p: ClientProvider): ClientStatus {
    const r = clients[p];
    if (r.installStartedAt != null) {
      const progress = Math.min(100, Math.floor(((now() - r.installStartedAt) / installMs) * 100));
      if (progress >= 100) {
        r.installStartedAt = null;
        if (failInstall.has(p))
          r.failed = {
            code: 'client.install_failed',
            message: 'The download was interrupted. Nothing was changed.',
          };
        else r.installed = { version: FAKE_LATEST[p], installedAt: iso(now()) };
      } else
        return {
          provider: p,
          installed: r.installed,
          latest: { version: FAKE_LATEST[p], publishedAt: PUBLISHED },
          state: r.installed ? 'updating' : 'installing',
          progress,
          error: null,
        };
    }
    return {
      provider: p,
      installed: r.installed,
      latest: { version: FAKE_LATEST[p], publishedAt: PUBLISHED },
      state: r.failed ? 'failed' : r.installed ? 'installed' : 'not_installed',
      progress: null,
      error: r.failed,
    };
  }

  function modes() {
    const off = (p: string, m: string) =>
      options.unavailable?.find((u) => u.provider === p && u.authMode === m)?.reason ?? null;
    return [
      ['claude', 'subscription_cli'],
      ['claude', 'api_key'],
      ['codex', 'chatgpt'],
      ['codex', 'api_key'],
      ['github', 'device'],
      ['github', 'token'],
    ].map(([provider, authMode]) => {
      const reason = off(provider as string, authMode as string);
      return { provider, authMode, available: reason == null, reason };
    });
  }

  /* Consoles ----------------------------------------------------------------------------------------------------- */

  function wake(rec: ConsoleRecord) {
    for (const w of [...rec.waiters]) w();
    changed();
  }

  function emit(rec: ConsoleRecord, text: string) {
    const bytes = utf8(text);
    for (const b of bytes) rec.bytes.push(b);
    rec.c = { ...rec.c, outputBytes: rec.c.outputBytes + bytes.length };
    wake(rec);
  }

  function end(
    rec: ConsoleRecord,
    state: ProviderConsole['state'],
    exitCode: number | null,
    error: ProviderConsole['error'],
  ) {
    rec.c = { ...rec.c, state, exitCode, endedAt: iso(now()), error };
    wake(rec);
  }

  function expireConsoles() {
    for (const rec of consoles.values())
      if (rec.c.state === 'running' && now() >= Date.parse(rec.c.expiresAt))
        end(rec, 'expired', null, {
          code: 'provider.login_expired',
          message: 'The sign-in took too long, so it was stopped.',
        });
  }

  function typeInto(rec: ConsoleRecord, data: string) {
    // Bracketed paste markers (ESC [200~ … ESC [201~) are the terminal's, not typed text.
    const typed = data.split('\u001b[200~').join('').split('\u001b[201~').join('');
    for (const ch of typed) {
      if (rec.c.state !== 'running') return;
      if (ch === '\u0003') {
        emit(rec, '^C\r\n');
        end(rec, 'failed', 130, { code: 'provider.login_failed', message: 'The sign-in was stopped.' });
        return;
      }
      if (ch === '\r' || ch === '\n') {
        const code = rec.line.trim();
        rec.line = '';
        if (!code) {
          emit(rec, '\r\nPaste code here if prompted > ');
          continue;
        }
        if (code === 'wrong' || code.length < 6) {
          // Claude Code's theme colors are truecolor (the hosted build's terminal shows them under its CSP, AP-55).
          emit(
            rec,
            '\r\n\x1b[38;2;255;107;128mLogin failed: Request failed with status code 400\x1b[39m\r\n',
          );
          end(rec, 'failed', 1, {
            code: 'provider.login_failed',
            message: 'Claude Code’s sign-in didn’t complete. Start again.',
          });
          return;
        }
        emit(
          rec,
          '\r\n\x1b[38;2;78;186;101mLogin successful.\x1b[39m Logged in as mara@burrowhq.example\r\n',
        );
        signIns = [...signIns.filter((s) => s.provider !== 'claude'), signInOf('claude', 'subscription_cli')];
        end(rec, 'completed', 0, null);
        return;
      }
      // Like Claude Code (2.1.283): the code prompt echoes nothing, not even a backspace.
      if (ch === '\u007f') {
        rec.line = rec.line.slice(0, -1);
        continue;
      }
      if (ch >= ' ') rec.line += ch;
    }
  }

  function consoleStart(body: { cols: number; rows: number }): FakeAiAnswer {
    for (const rec of consoles.values())
      if (rec.c.state === 'running')
        end(rec, 'cancelled', null, { code: 'provider.console_replaced', message: 'Opened somewhere else.' });
    const started = now();
    const rec: ConsoleRecord = {
      c: {
        consoleId: `pcn_${randomId(12)}`,
        provider: 'claude',
        authMode: 'subscription_cli',
        state: 'running',
        exitCode: null,
        cols: body.cols,
        rows: body.rows,
        startedAt: iso(started),
        expiresAt: iso(started + PROVIDER_CONSOLE_TTL_S * 1000),
        endedAt: null,
        outputBytes: 0,
        inputSeq: 0,
        error: null,
      },
      bytes: [],
      line: '',
      waiters: new Set(),
    };
    consoles.set(rec.c.consoleId, rec);
    // Like Claude Code 2.1.283: the link is an OSC 8 hyperlink around its (bright blue) text.
    const link =
      options.consoleLink ??
      `https://claude.com/cai/oauth/authorize?code=true&client_id=fake&response_type=code&state=${randomId(16)}`;
    emit(
      rec,
      [
        'Opening browser to sign in…',
        `If the browser didn't open, visit: \x1b]8;;${link}\x07\x1b[94m${link}\x1b[39m\x1b]8;;\x07`,
        'Paste code here if prompted > ',
      ].join('\r\n'),
    );
    return ok(rec.c, 201);
  }

  async function consoleRead(consoleId: string, cursor: number, waitMs: number): Promise<FakeAiAnswer> {
    expireConsoles();
    const rec = consoles.get(consoleId);
    if (!rec) return fail(404, 'provider.console_not_found', 'No such sign-in console.');
    if (cursor >= rec.c.outputBytes && rec.c.state === 'running' && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          rec.waiters.delete(done);
          resolve();
        };
        const t = setTimeout(done, Math.min(waitMs, Math.max(0, Date.parse(rec.c.expiresAt) - now()) + 50));
        rec.waiters.add(done);
      });
      expireConsoles();
    }
    const total = rec.c.outputBytes;
    const kept = Math.max(0, total - PROVIDER_CONSOLE_BUFFER_BYTES);
    const from = Math.min(Math.max(cursor, kept), total);
    const next = Math.min(total, from + PROVIDER_CONSOLE_READ_MAX_BYTES);
    const data = toBase64(rec.bytes.slice(from, next));
    return ok({ console: rec.c, from, data, next, more: next < total });
  }

  function consoleWrite(consoleId: string, seq: number, data: string): FakeAiAnswer {
    expireConsoles();
    const rec = consoles.get(consoleId);
    if (!rec) return fail(404, 'provider.console_not_found', 'No such sign-in console.');
    if (seq <= rec.c.inputSeq) return ok(rec.c);
    if (rec.c.state !== 'running')
      return fail(409, 'provider.console_ended', 'The sign-in console isn’t running any more.');
    if (seq > rec.c.inputSeq + 1)
      return fail(409, 'provider.console_input_gap', 'A write was skipped.', { inputSeq: rec.c.inputSeq });
    rec.c = { ...rec.c, inputSeq: seq };
    typeInto(rec, data);
    return ok(rec.c);
  }

  /* Logins ------------------------------------------------------------------------------------------------------- */

  function loginStart(provider: string, authMode: string): FakeAiAnswer {
    if (provider === 'claude' && authMode === 'subscription_cli')
      return fail(400, 'provider.use_console', 'Claude subscriptions sign in through the sign-in console.');
    const mode = modes().find((m) => m.provider === provider && m.authMode === authMode);
    if (mode && !mode.available) return fail(403, 'provider.mode_unavailable', mode.reason ?? 'Not here.');
    const device = authMode === 'chatgpt' || authMode === 'device';
    const login: ProviderLogin = {
      loginId: `plg_${randomId(12)}`,
      provider: provider as ProviderLogin['provider'],
      authMode,
      state: device ? 'awaiting_user' : 'awaiting_secret',
      device: device
        ? {
            verificationUri:
              provider === 'github'
                ? 'https://github.com/login/device'
                : (options.deviceUri ?? 'https://auth.openai.com/codex/device'),
            userCode: `${randomId(4).toUpperCase()}-${randomId(5).toUpperCase()}`,
            expiresAt: iso(now() + 15 * 60_000),
          }
        : null,
      error: null,
      verified: null,
      expiresAt: iso(now() + 15 * 60_000),
    };
    logins.set(login.loginId, { login, polls: 0 });
    return ok(login, 201);
  }

  function loginStatus(loginId: string): FakeAiAnswer {
    const rec = logins.get(loginId);
    if (!rec) return fail(404, 'not_found', 'No such sign-in.');
    const l = rec.login;
    if (l.state === 'awaiting_user') {
      rec.polls += 1;
      if (now() >= Date.parse(l.expiresAt))
        rec.login = {
          ...l,
          state: 'expired',
          error: { code: 'provider.login_expired', message: 'The code expired before the sign-in finished.' },
        };
      else if (rec.polls >= (options.deviceCompletesAfterPolls ?? 3)) {
        rec.login = { ...l, state: 'completed', verified: 'valid' };
        signIns = [...signIns.filter((s) => s.provider !== l.provider), signInOf(l.provider, l.authMode)];
        changed();
      }
    }
    return ok(rec.login);
  }

  function loginSubmit(loginId: string, secret: string): FakeAiAnswer {
    const rec = logins.get(loginId);
    if (rec?.login.state !== 'awaiting_secret') return fail(404, 'not_found', 'No such sign-in.');
    if (secret.length < 8 || /bad|wrong/.test(secret))
      return fail(400, 'provider.key_invalid', 'That key isn’t right. Check it and try again.');
    const l = rec.login;
    rec.login = { ...l, state: 'completed', verified: 'valid' };
    signIns = [...signIns.filter((s) => s.provider !== l.provider), signInOf(l.provider, l.authMode)];
    changed();
    return ok(rec.login);
  }

  /* Operations --------------------------------------------------------------------------------------------------- */

  type P = Record<string, string>;
  type Q = Record<string, unknown>;
  type B = Record<string, unknown>;

  /** One `signins.*` / `clients.*` operation (by endpoint id), with the REST call's parts. */
  async function call(op: string, params: P = {}, query: Q = {}, body: B = {}): Promise<FakeAiAnswer | null> {
    switch (op) {
      case 'clients.list':
        return ok({
          clients: CLIENT_PROVIDERS.map(clientStatus),
          checkedAt: iso(now() - 3_600_000),
        });
      case 'clients.install': {
        const p = params.provider as LiveProvider;
        if (p === 'codex') return fail(400, 'validation_failed', FAKE_NO_CLIENT);
        if (!needsClient(p)) return fail(404, 'not_found', 'No such client.');
        const r = clients[p];
        clientStatus(p);
        if (options.unpublished?.includes(p) && !r.installed)
          return ok({
            ...clientStatus(p),
            latest: null,
            state: 'failed',
            error: {
              code: 'client.unavailable',
              message: 'No tested Claude Code version is published for this appliance yet.',
            },
          });
        if (!r.installed && r.installStartedAt == null) {
          r.failed = null;
          r.installStartedAt = now();
          changed();
        }
        return ok(clientStatus(p));
      }
      case 'clients.remove': {
        const p = params.provider as LiveProvider;
        if (!needsClient(p)) return fail(404, 'not_found', 'No such client.');
        clients[p] = { installed: null, installStartedAt: null, failed: null };
        changed();
        return ok(clientStatus(p));
      }
      case 'signins.list':
        expireConsoles();
        return ok({
          signIns,
          logins: [...logins.values()]
            .map((l) => l.login)
            .filter((l) => l.state === 'awaiting_user' || l.state === 'awaiting_secret'),
          modes: modes(),
          consoles: [...consoles.values()].map((c) => c.c).slice(-8),
        });
      case 'signins.loginStart':
        return loginStart(String(body.provider), String(body.authMode));
      case 'signins.loginStatus':
        return loginStatus(String(params.loginId));
      case 'signins.loginSubmit':
        return loginSubmit(String(params.loginId), String(body.secret ?? ''));
      case 'signins.loginCancel': {
        const rec = logins.get(String(params.loginId));
        if (!rec) return fail(404, 'not_found', 'No such sign-in.');
        rec.login = { ...rec.login, state: 'cancelled' };
        return ok(rec.login);
      }
      case 'signins.logout': {
        const before = signIns.length;
        signIns = signIns.filter((s) => s.provider !== params.provider);
        changed();
        return ok({ removed: signIns.length < before });
      }
      case 'signins.consoleStart':
        return consoleStart(body as { cols: number; rows: number });
      case 'signins.consoleRead':
        return consoleRead(String(params.consoleId), Number(query.cursor ?? 0), Number(query.waitMs ?? 0));
      case 'signins.consoleWrite':
        return consoleWrite(String(params.consoleId), Number(body.seq), String(body.data ?? ''));
      case 'signins.consoleResize': {
        const rec = consoles.get(String(params.consoleId));
        if (!rec) return fail(404, 'provider.console_not_found', 'No such sign-in console.');
        rec.c = { ...rec.c, cols: Number(body.cols), rows: Number(body.rows) };
        return ok(rec.c);
      }
      case 'signins.consoleCancel': {
        const rec = consoles.get(String(params.consoleId));
        if (!rec) return fail(404, 'provider.console_not_found', 'No such sign-in console.');
        if (rec.c.state === 'running') end(rec, 'cancelled', null, null);
        return ok(rec.c);
      }
      default:
        return null;
    }
  }

  return {
    call,
    /** The world changed (a sign-in, an install): for tests. */
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Ends a running console the way the server does after `PROVIDER_CONSOLE_TTL_S`. */
    expireConsole(consoleId?: string) {
      for (const rec of consoles.values())
        if (rec.c.state === 'running' && (!consoleId || rec.c.consoleId === consoleId))
          end(rec, 'expired', null, {
            code: 'provider.login_expired',
            message: 'The sign-in took too long, so it was stopped.',
          });
    },
    signIns: () => signIns,
    /** The account's ready GitHub sign-in's login (a managed box connects GitHub with it, CT-181), or null. */
    githubLogin: () => signIns.find((s) => s.provider === 'github' && s.state === 'ready')?.login ?? null,
    snapshot(): FakeAiSnapshot {
      for (const p of CLIENT_PROVIDERS) clientStatus(p);
      return { signIns, installed: { claude: clients.claude.installed } };
    },
  };
}

/** The endpoint ids this fake answers. */
export const FAKE_AI_OPS = new Set([
  'clients.list',
  'clients.install',
  'clients.remove',
  'signins.list',
  'signins.loginStart',
  'signins.loginStatus',
  'signins.loginSubmit',
  'signins.loginCancel',
  'signins.logout',
  'signins.consoleStart',
  'signins.consoleRead',
  'signins.consoleWrite',
  'signins.consoleResize',
  'signins.consoleCancel',
]);

const REST_CODE: Record<number, string> = {
  400: 'bad_request',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
};

/** The REST server's shape: a core `ErrorCode`, and the app code in `details.code`. */
export function restAnswer(a: FakeAiAnswer): { status: number; body: unknown } {
  if (!a.error) return { status: a.status, body: a.body };
  return {
    status: a.status,
    body: {
      error: {
        // A refusal of what was asked (ChatGPT's install, AP-5619) is the core code itself.
        code: a.error.code === 'validation_failed' ? a.error.code : (REST_CODE[a.status] ?? 'internal'),
        message: a.error.message,
        details: { ...a.error.details, code: a.error.code },
      },
    },
  };
}

/** The session fake's shape: the app code as `error.code` (it moves it into `details.code`, AP-19). */
export function sessionAnswer(a: FakeAiAnswer): { status: number; body: unknown } {
  if (!a.error) return { status: a.status, body: a.body };
  return {
    status: a.status,
    body: { error: { code: a.error.code, message: a.error.message, details: a.error.details } },
  };
}
