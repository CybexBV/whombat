/**
 * A turn's logins service (hermes-engine.md HE-42, HE-S141): the website logins of the person the turn is for, switched
 * on for the agent, reach Hermes's credential vault only during their own turn, one password at a fill.
 *
 * A unix socket of the turn, whose file alone is bound into the task sandbox (`SANDBOX_LOGINS_SOCKET`, never a loopback
 * port): Hermes's vault (our plugin's `logins.py`) sends one line `{"entry": "<vault entry id>"}` and gets one line back,
 * `{"password", "otp"}` or `{"error"}`. Only an entry of the turn's own `DispatchContext.logins` is fetched — from the
 * server (`runner.loginSecret`, the live lease, re-checked there) at that moment, never kept, never logged. The socket
 * goes with the turn; what Hermes held of a password goes with its process.
 *
 * Hermes's own asks (vault-simplify.md VLT-45) come the same way, in the person's turns only: `{"ask": "login" | "code",
 * "origin", "username"}` — its save-login or code prompt, from our plugin. The runner asks the server (`runner.loginAsk`),
 * which posts the card in the turn's thread, and long-polls it (`runner.loginAskWait`) until the person answers or the
 * wait (`LOGIN_ASK_WAIT_MS`) is over; the turn's progress beats go on meanwhile. A saved login becomes one of the turn's
 * and its password is fetched as every login's (`{"identifier", "password"}`); a code comes back once (`{"code"}`);
 * anything else is `{"declined": true, "error"}`. Never a value in a log.
 *
 * The agent's kept sites (kept-sites.md, the plugin's `browser_keep_site`) come the same way, in a person's turn in
 * their pod with its browser only: `{"keep": {"origins", "hours"}}`, `{"forget": {"origins"}}`, `{"kept": "list"}`.
 * The answer is `{"ok": true, "site" | "forgotten" | "sites"}` — the sites as the person sees them, never a cookie — or
 * `{"ok": false, "error"}`.
 */
import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { KeptSiteHours, LOGIN_ASK_WAIT_MS, type LoginAskKind } from '@whombat/core';
import type { RunnerApi } from './api';
import {
  KEPT_NOT_HERE,
  KEPT_UNAVAILABLE,
  KeptSiteRefusal,
  type KeptSitesRoute,
  keptOrigins,
} from './kept-sites';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', msg: string, extra?: Record<string, unknown>) => void;

/** A login's secret as the server gives it for the turn. */
export interface LoginSecret {
  password: string;
  otp: string | null;
}

export interface TurnLoginsDeps {
  /** The runner's private temp root: the socket goes in a folder of its own there (0700). */
  tmpRoot: string;
  log: Log;
  /** One login's secret from the server for this turn (`runner.loginSecret`). */
  fetchSecret: (entryId: string) => Promise<LoginSecret>;
  /** Hermes's asks to the person (VLT-45); none: Hermes hears nobody can be asked. */
  ask?: LoginAsker | undefined;
}

/** A request line arrives within this, at most this long. */
const LINE_MS = 10_000;
const LINE_MAX = 8192;
const SOCKET_PATH_MAX = 100;

/** What Hermes is told when it asks for a login the turn doesn't have, or the server won't give it. */
export const LOGIN_NOT_THIS_TURN = 'That login isn’t one of this turn’s.';
export const LOGIN_UNAVAILABLE = 'Whombat couldn’t give this login right now.';
/** What Hermes hears when this turn can't ask the person. */
export const LOGIN_NO_ASK = 'Whombat can’t ask the person in this turn.';
/** What Hermes hears when the person didn't answer in time: the card stays, and a later answer wakes the agent. */
export const LOGIN_ASK_TIMED_OUT =
  'The person didn’t answer in time. The card stays in the thread; carry on without it this turn.';
export const LOGIN_ASK_DECLINED = 'The person chose Not now. Don’t ask again this turn.';

/** How one of Hermes's asks ended: a login saved (one of the turn's now), a code, or why not. */
export type LoginAskAnswer =
  | { login: { entryId: string; username: string } }
  | { code: string }
  | { declined: string };

/** Asks the person for a login or a code in the turn and waits for the answer (`loginAsker`). */
export type LoginAsker = (
  kind: LoginAskKind,
  origin: string,
  username: string | null,
  signal: AbortSignal,
) => Promise<LoginAskAnswer>;

/**
 * `runner.loginAsk`, then `runner.loginAskWait` until the card is answered or its wait is over (VLT-45). `pollMs` is one
 * long poll's length (25 s; tests shorten it).
 */
export function loginAsker(deps: {
  api: Required<Pick<RunnerApi, 'loginAsk' | 'loginAskWait'>>;
  dispatchId: string;
  lease: { runnerId: string; attempt: number };
  log: Log;
  pollMs?: number;
  now?: () => number;
}): LoginAsker {
  const now = deps.now ?? Date.now;
  return async (kind, origin, username, signal) => {
    const asked = await deps.api.loginAsk(deps.dispatchId, { ...deps.lease, kind, origin, username });
    if (asked.status === 'refused') return { declined: asked.message || LOGIN_NO_ASK };
    const until = Math.min(Date.parse(asked.until), now() + LOGIN_ASK_WAIT_MS[kind]);
    for (;;) {
      if (signal.aborted) return { declined: LOGIN_UNAVAILABLE };
      const left = until - now();
      if (left <= 0) return { declined: LOGIN_ASK_TIMED_OUT };
      const reply = await deps.api.loginAskWait(
        deps.dispatchId,
        asked.messageId,
        { ...deps.lease, waitMs: Math.max(0, Math.min(deps.pollMs ?? 25_000, left)) },
        signal,
      );
      // How it went, never what was typed.
      if (reply.status !== 'pending')
        deps.log('info', `logins: ${kind} card ${asked.messageId} ${reply.status}`, {
          dispatchId: deps.dispatchId,
        });
      switch (reply.status) {
        case 'pending':
          continue;
        case 'saved':
          return { login: { entryId: reply.login.entryId, username: reply.login.username } };
        case 'code':
          return { code: reply.code };
        case 'timed_out':
          return { declined: LOGIN_ASK_TIMED_OUT };
        default:
          return { declined: LOGIN_ASK_DECLINED };
      }
    }
  };
}

export class TurnLogins {
  /** The socket bound into the sandbox (`SandboxTask.logins`). */
  readonly socket: string;
  readonly #deps: TurnLoginsDeps;
  readonly #dispatchId: string;
  readonly #entries: Set<string>;
  readonly #remove: string[];
  readonly #sockets = new Set<Socket>();
  /** Ends Hermes's asks in flight when the turn does. */
  readonly #asks = new AbortController();
  #server: Server | null = null;
  #closing: Promise<void> | null = null;

  private constructor(
    deps: TurnLoginsDeps,
    dispatchId: string,
    entries: readonly string[],
    socket: string,
    remove: string[],
  ) {
    this.#deps = deps;
    this.#dispatchId = dispatchId;
    this.#entries = new Set(entries);
    this.socket = socket;
    this.#remove = remove;
  }

  /** Starts the turn's service for `entries` (its `DispatchContext.logins`); throws when it can't listen. */
  static async open(
    deps: TurnLoginsDeps,
    dispatchId: string,
    entries: readonly string[],
  ): Promise<TurnLogins> {
    await mkdir(deps.tmpRoot, { recursive: true, mode: 0o700 });
    const safe = dispatchId.replace(/[^A-Za-z0-9_-]/g, '_');
    let dir = join(realpathSync(deps.tmpRoot), 'logins', safe);
    const remove = [dir];
    if (Buffer.byteLength(join(dir, 'logins.sock')) > SOCKET_PATH_MAX) {
      dir = await mkdtemp(join('/tmp', 'wblg-'));
      remove.splice(0, 1, dir);
    } else {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await chmod(dir, 0o700);
    const logins = new TurnLogins(deps, dispatchId, entries, join(dir, 'logins.sock'), remove);
    try {
      await logins.#listen();
    } catch (err) {
      await logins.close();
      throw err;
    }
    return logins;
  }

  async #listen(): Promise<void> {
    const server = createServer((socket) => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
      socket.on('error', () => {});
      void this.#serve(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socket, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.#server = server;
    await chmod(this.socket, 0o600);
  }

  async #serve(socket: Socket): Promise<void> {
    const line = await readLine(socket);
    await answerRequest(socket, requestOf(line), {
      route: {
        dispatchId: this.#dispatchId,
        entries: this.#entries,
        fetchSecret: this.#deps.fetchSecret,
        ask: this.#deps.ask,
      },
      log: this.#deps.log,
      closing: Boolean(this.#closing),
      signal: this.#asks.signal,
    });
  }

  /** The turn is over (cancel and failure too): connections dropped, the socket and its folder removed. */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#asks.abort();
      for (const s of this.#sockets) s.destroy();
      await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
      for (const d of this.#remove) await rm(d, { recursive: true, force: true }).catch(() => {});
    })();
    return this.#closing;
  }
}

/** What a logins request may be given (HE-S141): the turn's entries, and how their secrets are fetched for it. */
export interface LoginsRoute {
  dispatchId: string;
  /** The turn's logins; a login the person saves on Hermes's card joins them. */
  entries: Set<string>;
  fetchSecret: (entryId: string) => Promise<LoginSecret>;
  /** Hermes's asks to the person (VLT-45), in a turn of theirs only. */
  ask?: LoginAsker | undefined;
  /** The agent's kept sites (kept-sites.md): a person's turn in their pod, with its browser, only. */
  kept?: KeptSitesRoute | undefined;
}

/**
 * A request line as the plugin sends it: an entry, an ask or a kept site's, and in a person's pod the Hermes session
 * (HN-W06).
 */
interface LoginsRequest {
  entry: unknown;
  session: unknown;
  ask: unknown;
  origin: unknown;
  username: unknown;
  keep: unknown;
  forget: unknown;
  kept: unknown;
}

function requestOf(line: string | null): LoginsRequest {
  const none = {
    entry: null,
    session: null,
    ask: null,
    origin: null,
    username: null,
    keep: null,
    forget: null,
    kept: null,
  };
  try {
    const parsed = line === null ? null : (JSON.parse(line) as Partial<LoginsRequest> | null);
    if (!parsed || typeof parsed !== 'object') return none;
    return {
      entry: parsed.entry ?? null,
      session: parsed.session ?? null,
      ask: parsed.ask ?? null,
      origin: parsed.origin ?? null,
      username: parsed.username ?? null,
      keep: parsed.keep ?? null,
      forget: parsed.forget ?? null,
      kept: parsed.kept ?? null,
    };
  } catch {
    return none;
  }
}

/** Whether a request is about kept sites. */
const keptRequest = (req: LoginsRequest) => req.keep !== null || req.forget !== null || req.kept !== null;

/** One kept-site request (kept-sites.md): keep, forget or list, answered without a cookie. */
async function answerKept(
  socket: Socket,
  req: LoginsRequest,
  at: { route: LoginsRoute | null; log: Log; closing: boolean },
): Promise<void> {
  const answer = (value: Record<string, unknown>): void => {
    socket.end(`${JSON.stringify(value)}\n`);
  };
  const refused = (error: string) => answer({ ok: false, error });
  const kept = at.route?.kept;
  if (!kept || at.closing) return refused(KEPT_NOT_HERE);
  const dispatchId = at.route?.dispatchId;
  try {
    if (req.keep !== null) {
      const body = (typeof req.keep === 'object' ? req.keep : {}) as { origins?: unknown; hours?: unknown };
      const origins = keptOrigins(body.origins);
      const hours =
        body.hours === undefined || body.hours === null ? undefined : KeptSiteHours.safeParse(body.hours);
      if (!origins) return refused('Name the site by its https address.');
      if (hours && !hours.success) return refused('Hours are a whole number from 1 to 24.');
      const site = await kept.keep(origins, hours?.data);
      return answer({ ok: true, site });
    }
    if (req.forget !== null) {
      const body = (typeof req.forget === 'object' ? req.forget : {}) as { origins?: unknown };
      const origins = keptOrigins(body.origins);
      if (!origins) return refused('Name the site by its https address.');
      return answer({ ok: true, forgotten: await kept.forget(origins) });
    }
    if (req.kept !== 'list') return refused(KEPT_UNAVAILABLE);
    return answer({ ok: true, sites: await kept.list() });
  } catch (err) {
    if (err instanceof KeptSiteRefusal) return refused(err.message);
    // How it failed, never what was read from the browser.
    at.log(
      'warn',
      `kept sites: a request failed (${err instanceof Error ? err.name : 'error'} ${statusOf(err)})`,
      {
        dispatchId,
      },
    );
    return refused(statusOf(err) === 403 ? KEPT_NOT_HERE : KEPT_UNAVAILABLE);
  }
}

const statusOf = (err: unknown): number | string =>
  typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : '';

/** An https origin as the server takes it (`LoginAskBody.origin`). */
const ORIGIN = /^https:\/\/[^\s/?#]{1,290}$/;

/** One request: a login's secret, or one of Hermes's asks. */
async function answerRequest(
  socket: Socket,
  req: LoginsRequest,
  at: { route: LoginsRoute | null; log: Log; closing: boolean; signal: AbortSignal },
): Promise<void> {
  if (keptRequest(req)) return answerKept(socket, req, at);
  if (req.ask === null) return answerLogin(socket, req.entry, at);
  const answer = (value: Record<string, unknown>): void => {
    socket.end(`${JSON.stringify(value)}\n`);
  };
  const declined = (error: string): void => answer({ declined: true, error });
  const { route } = at;
  if (!route) return declined(LOGIN_NOT_THIS_TURN);
  if (!route.ask || at.closing) return declined(LOGIN_NO_ASK);
  if (
    (req.ask !== 'login' && req.ask !== 'code') ||
    typeof req.origin !== 'string' ||
    !ORIGIN.test(req.origin)
  )
    return declined(LOGIN_NO_ASK);
  const username =
    typeof req.username === 'string' && req.username.trim() ? req.username.slice(0, 320) : null;
  // The plugin gave up (its own timeout, the tool stopped): the wait ends with it.
  const gone = new AbortController();
  const stop = () => gone.abort();
  socket.once('close', stop);
  at.signal.addEventListener('abort', stop, { once: true });
  try {
    const got = await route.ask(req.ask, req.origin, username, gone.signal);
    if ('declined' in got) return declined(got.declined);
    if ('code' in got) return answer({ code: got.code });
    // Saved by the person: one of the turn's logins from now on, its password fetched as every login's.
    route.entries.add(got.login.entryId);
    const secret = await route.fetchSecret(got.login.entryId);
    at.log('info', `logins: gave Hermes ${got.login.entryId}, saved on its card`, {
      dispatchId: route.dispatchId,
    });
    return answer({ identifier: got.login.username, password: secret.password, entry: got.login.entryId });
  } catch (err) {
    at.log('warn', `logins: an ask failed (${err instanceof Error ? err.name : 'error'})`, {
      dispatchId: route.dispatchId,
    });
    return declined(LOGIN_UNAVAILABLE);
  } finally {
    socket.off('close', stop);
    at.signal.removeEventListener('abort', stop);
  }
}

/** Answers one request: the secret of an entry the turn has, fetched now; else why not. */
async function answerLogin(
  socket: Socket,
  entry: unknown,
  at: { route: LoginsRoute | null; log: Log; closing: boolean },
): Promise<void> {
  const answer = (value: Record<string, unknown>) => socket.end(`${JSON.stringify(value)}\n`);
  const { route } = at;
  if (!route || typeof entry !== 'string' || !route.entries.has(entry)) {
    answer({ error: LOGIN_NOT_THIS_TURN });
    return;
  }
  if (at.closing) {
    answer({ error: LOGIN_UNAVAILABLE });
    return;
  }
  try {
    const secret = await route.fetchSecret(entry);
    // The entry's id only: never the secret, the username or the site.
    at.log('info', `logins: gave Hermes ${entry} to fill`, { dispatchId: route.dispatchId });
    answer({ password: secret.password, otp: secret.otp });
  } catch (err) {
    at.log('warn', `logins: ${entry} couldn’t be fetched (${err instanceof Error ? err.message : 'error'})`, {
      dispatchId: route.dispatchId,
    });
    answer({ error: LOGIN_UNAVAILABLE });
  }
}

/**
 * A person's pod's logins service (hermes-native.md HN-W06): one socket for all of the person's turns, whose requests
 * name the Hermes session they come from. A session answers with its live turn's logins (`route`); an unknown or ended
 * one gets nothing.
 */
export class PodLogins {
  readonly socket: string;
  readonly #route: (session: string) => LoginsRoute | null;
  readonly #sockets = new Set<Socket>();
  readonly #asks = new AbortController();
  #server: Server | null = null;
  #closing = false;

  private constructor(socket: string, route: (session: string) => LoginsRoute | null) {
    this.socket = socket;
    this.#route = route;
  }

  /** Listens at `socket` (in the pod's private control folder). */
  static async open(
    socket: string,
    log: Log,
    route: (session: string) => LoginsRoute | null,
  ): Promise<PodLogins> {
    const logins = new PodLogins(socket, route);
    const server = createServer((conn) => {
      logins.#sockets.add(conn);
      conn.once('close', () => logins.#sockets.delete(conn));
      conn.on('error', () => {});
      void readLine(conn).then((line) => {
        const req = requestOf(line);
        const found = typeof req.session === 'string' ? logins.#route(req.session) : null;
        return answerRequest(conn, req, {
          route: found,
          log,
          closing: logins.#closing,
          signal: logins.#asks.signal,
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => {
        server.off('error', reject);
        resolve();
      });
    });
    logins.#server = server;
    await chmod(socket, 0o600);
    return logins;
  }

  close(): Promise<void> {
    this.#closing = true;
    this.#asks.abort();
    for (const s of this.#sockets) s.destroy();
    return new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
  }
}

/** One line from the socket (without its newline), or null when none comes in time or it is too long. */
function readLine(socket: Socket): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => done(null), LINE_MS);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) done(buf.slice(0, nl));
      else if (buf.length > LINE_MAX) done(null);
    };
    const onEnd = () => done(buf.length ? buf : null);
    function done(v: string | null) {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      resolve(v);
    }
    socket.on('data', onData);
    socket.once('end', onEnd);
  });
}
