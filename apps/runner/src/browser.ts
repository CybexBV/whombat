/**
 * The agent's browser (hermes-engine.md HE-20, HE-42, HE-S138, HE-S140; one-person.md OP-S113): Hermes's browser tools
 * drive a Chromium that runs where the agent's commands run, so browsing obeys the commands' wall and opens what a
 * command serves on 127.0.0.1.
 *
 * - **The relay** (`Browser`): a unix socket, which the sandbox's init bridges to `127.0.0.1:47105`
 *   (`SANDBOX_BROWSER_ORIGIN`, Hermes's `browser.cdp_url`). Each connection is one HTTP request of DevTools' (`/json…`)
 *   or one WebSocket (`/devtools/…`); anything else is refused. The request goes to Chromium unchanged — it builds its
 *   `webSocketDebuggerUrl`s from the request's `Host`, so they point back at the bridge — over the commands' holder's
 *   way in (`BrowserHost.connect`). Plain requests get `Connection: close`, so every request on the relay is one it read.
 * - **Chromium** starts for the first connection (a pod that never browses never starts one), headless, with a fresh
 *   profile in the commands' `/tmp` that goes with it, through the commands' proxy, on a port it picks itself
 *   (`DevTools listening on …`). It is Whombat's own command in the commands' wrapper (`BrowserHost.start`): one per
 *   person's pod (HN-W05), for as long as the pod lives; one that ends early is started again by the next connection.
 * - **Only some sites** (`sites`, a Feedback assessment's look at the reported website, FB-28, HE-S140): its own
 *   Chromium in the assessment's sandbox, whose wall lets only those sites out; Chromium gets a proxy script that sends
 *   only those sites (and their subdomains) out and every other address to a closed port, and the relay reads every CDP
 *   command the client sends: one that opens a page elsewhere (`Page.navigate`, `Target.createTarget`, outside
 *   `about:blank` and those sites over http(s)) or hands the page a file (`DOM.setFileInputFiles`) is answered with an
 *   error and never reaches Chromium, and `/json/new` is refused.
 * - **Its start** (`onStart`): what the person's pod does with each Chromium before any client gets it (the websites the
 *   agent keeps signed in, `kept-sites.ts`), straight over DevTools' port; it never stops the browser from starting.
 * - **Its watchdog** (`browser-watch.ts`): while a Chromium runs, a check every 20 s straight over its DevTools port. A
 *   page that stopped answering is closed; a Chromium that stopped answering, or can't start a page that answers, is
 *   ended (after `onStop`, the pod's last look at it) with the relay's connections to it, and the next connection
 *   starts a fresh one: a new profile, only the kept sites' cookies, no pages of the old one.
 */
import { existsSync } from 'node:fs';
import { chmod, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import type { DispatchContext } from '@whombat/core';
import { BrowserWatch, type BrowserWatchTimings } from './browser-watch';
import { FrameBuffer } from './frame-buffer';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', msg: string, extra?: Record<string, unknown>) => void;

/** How long Chromium may take to start. */
export const BROWSER_START_MS = 45_000;
/** A request's head arrives within this, at most `HEAD_MAX` bytes. */
const HEAD_MS = 10_000;
const HEAD_MAX = 16 * 1024;
/** The most a client's WebSocket message may hold while the relay reads it (an assessment's). */
const MESSAGE_MAX = 32 * 1024 * 1024;
/** The last lines of Chromium's errors kept for a start that failed. */
const TAIL_LINES = 6;
/** How long a start's own work (`BrowserDeps.onStart`) may hold the first connection. */
export const BROWSER_ON_START_MS = 20_000;
/** How long the work before a stuck Chromium is ended (`BrowserDeps.onStop`) may take. */
export const BROWSER_ON_STOP_MS = 15_000;

/**
 * The dispatch's browser (HE-42): null when the turn has none (the agent doesn't hold `browser.use`, a search answer, an
 * assessor that may not look); `sites` null for whatever the commands reach, else only those (an assessment, FB-28).
 * An assessment's browser without its sites is none: it never gets an open one.
 */
export function browserOf(ctx: DispatchContext): { sites: string[] | null } | null {
  const b = ctx.browser;
  if (!b) return null;
  const sites = b.sites?.length ? [...b.sites] : null;
  if (ctx.dispatch.trigger === 'feedback' && !sites) return null;
  return { sites };
}

/** Where a Chromium may be (the image's tools first, `WHOMBAT_AGENT_TOOLS`; else the host's own). */
const CHROMIUM_NAMES = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'];

/** Whether the commands can run a Chromium (OP-13: the image's tools have one; a development host's own). */
export function hasChromium(
  dirs: readonly string[],
  exists: (path: string) => boolean = existsSync,
): boolean {
  return dirs.some((d) => CHROMIUM_NAMES.some((b) => exists(`${d}/${b}`)));
}

/**
 * What the turn gets (HE-S137): its browser, `unavailable` when it should have one but this runner can't give it one
 * (no Chromium where its commands run), or null (none asked for).
 */
export function turnBrowserPlan(
  ctx: DispatchContext,
  host: { chromium: boolean },
): { sites: string[] | null } | 'unavailable' | null {
  const browser = browserOf(ctx);
  if (!browser) return null;
  if (!host.chromium) return 'unavailable';
  return browser;
}

/** Whombat's own processes beside the agent's commands: Chromium, and connections into the commands' network. */
export interface BrowserHost {
  /**
   * The bash Chromium's command line runs in, inside the commands' wrapper: the image's (an appliance has no
   * `/bin/bash`), else the host's.
   */
  shell: string;
  /** Starts `argv` in the commands' wrapper: its stdout and stderr together, its stdin; closing it ends the process. */
  start(argv: readonly string[]): Promise<Socket>;
  /** A connection to `127.0.0.1:<port>` of the commands' network (the holder's way in). */
  connect(port: number): Socket;
}

export interface BrowserDeps {
  host: BrowserHost;
  /** The relay's socket (a folder of the runner's, 0700). */
  socket: string;
  log: Log;
  /** How long Chromium may take to start (default `BROWSER_START_MS`). */
  startMs?: number;
  /**
   * Each Chromium once it listens, before any client gets it (`connect`: a fresh connection to its DevTools port). A
   * failure or one slower than `onStartMs` (default `BROWSER_ON_START_MS`) is logged, and the browser starts anyway.
   */
  onStart?: (connect: () => Socket) => Promise<void>;
  onStartMs?: number;
  /**
   * A Chromium the watchdog ends (it stopped answering), while it still runs (`connect` as `onStart`'s): bounded by
   * `onStopMs` (default `BROWSER_ON_STOP_MS`), a failure logged. Not when the browser closes.
   */
  onStop?: (connect: () => Socket) => Promise<void>;
  onStopMs?: number;
  /** The watchdog's timings (default `BROWSER_WATCH`); false: no watchdog. */
  watch?: BrowserWatchTimings | false;
}

/** One Chromium the relay started. */
interface ChromiumRun {
  /** Its DevTools port, once it listens and its start's work is done. */
  ready: Promise<number>;
  /** Its own-process connection: closing it ends the process (its cgroup). */
  process: Socket | null;
  /** The relay's connections to it. */
  clients: Set<Socket>;
  watch: BrowserWatch | null;
  /** Being ended by the watchdog. */
  ending: boolean;
  /** Ended: never handed out again. */
  gone: boolean;
}

export interface BrowserTurn {
  /** Whose (a pod's name, an assessment's dispatch id): the journal's lines. */
  name: string;
  /** Only these sites (registrable domains) and their subdomains; null: whatever the commands' wall allows. */
  sites: readonly string[] | null;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** What an assessment's Chromium can't resolve: the commands' own and link-local addresses (HE-S140). */
export const LOCAL_HOST_RULES =
  'MAP 127.* ~NOTFOUND, MAP localhost ~NOTFOUND, MAP *.localhost ~NOTFOUND, MAP [::1] ~NOTFOUND, MAP 0.0.0.0 ~NOTFOUND, MAP 169.254.* ~NOTFOUND';

/** The sites as a proxy script (PAC): those go out by `__ROUTE__`, everything else to a closed port. */
export function sitesPac(sites: readonly string[]): string {
  return [
    'function FindProxyForURL(url, host) {',
    '  host = host.toLowerCase();',
    `  var sites = ${JSON.stringify(sites.map((s) => s.toLowerCase()))};`,
    '  for (var i = 0; i < sites.length; i++)',
    '    if (host === sites[i] || dnsDomainIs(host, "." + sites[i])) return "__ROUTE__";',
    '  return "PROXY 127.0.0.1:9";',
    '}',
  ].join('\n');
}

/**
 * The command that starts Chromium (bash): the first Chromium on its `PATH`, headless, a fresh profile in `/tmp` removed
 * when it ends (or by the next start, when it was killed), the commands' proxy, a port of its own choosing. With
 * `sites`, the proxy script that lets only those out (through the proxy).
 */
export function chromiumCommand(sites: readonly string[] | null): string {
  // Chromium never asks a proxy script about loopback and link-local addresses (it goes straight): with `sites` those
  // names are made unresolvable instead, so the commands' own servers are out too — and the proxy (on their loopback)
  // is named by a name of its own that maps to it first.
  const net = sites
    ? `route=DIRECT
rules=${shellQuote(LOCAL_HOST_RULES)}
if [ -n "$proxy" ]; then
  hostport=\${proxy#*://}; hostport=\${hostport%%/*}
  route="PROXY whombat-egress:\${hostport##*:}"
  rules="MAP whombat-egress \${hostport%:*}, $rules"
fi
pac=${shellQuote(sitesPac(sites))}
pac=\${pac//__ROUTE__/$route}
net=(--proxy-pac-url="data:application/x-ns-proxy-autoconfig;base64,$(printf %s "$pac" | base64 -w0)" --host-rules="$rules")`
    : `net=()
if [ -n "$proxy" ]; then net=(--proxy-server="$proxy"); fi`;
  return `set -u
# A Chromium that was killed (the watchdog's end, the pod's) never ran its trap: its profile goes now, unless its
# shell still runs.
for old in /tmp/whombat-browser.*; do
  [ -d "$old" ] || continue
  pid=$(cat "$old/.whombat-pid" 2>/dev/null) || pid=
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then continue; fi
  rm -rf "$old"
done
dir=$(mktemp -d /tmp/whombat-browser.XXXXXXXX) || exit 1
trap 'rm -rf "$dir"' EXIT
echo $$ > "$dir/.whombat-pid"
trap 'exit 129' HUP
trap 'exit 143' TERM
bin=
for name in chromium chromium-browser google-chrome-stable google-chrome; do
  if bin=$(command -v "$name"); then break; fi
  bin=
done
if [ -z "$bin" ]; then echo 'whombat: no Chromium here' >&2; exit 127; fi
proxy=\${HTTPS_PROXY:-\${https_proxy:-}}
${net}
"$bin" --headless=new --remote-debugging-port=0 --user-data-dir="$dir" \\
  --no-first-run --no-default-browser-check --disable-dev-shm-usage --disable-background-networking \\
  --disable-component-update --disable-sync --disable-default-apps --mute-audio --password-store=basic \\
  --window-size=1280,800 --disable-blink-features=AutomationControlled --log-level=3 \\
  "\${net[@]}" about:blank`;
}

/** Chromium's `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<id>`: the port. */
export function devtoolsPort(line: string): number | null {
  const m =
    /DevTools listening on ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\/devtools\/browser\//.exec(
      line,
    );
  return m ? Number(m[1]) : null;
}

/** A request's head: its line, method, path and whether it upgrades to a WebSocket. */
export interface RequestHead {
  method: string;
  path: string;
  upgrade: boolean;
  /** The head's bytes up to and with its blank line. */
  length: number;
}

export function parseHead(buf: Buffer): RequestHead | 'more' | 'bad' {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return buf.length > HEAD_MAX ? 'bad' : 'more';
  const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
  const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? '');
  if (!m) return 'bad';
  const upgrade = lines.some((l) => /^upgrade:\s*websocket\s*$/i.test(l));
  return { method: m[1] as string, path: m[2] as string, upgrade, length: end + 4 };
}

/**
 * Whether the relay passes a request: DevTools' HTTP (`/json…`) or a WebSocket (`/devtools/page|browser/…`); with
 * `sites`, never `/json/new` (it opens a page by address, which the relay doesn't read).
 */
export function passes(head: RequestHead, sites: readonly string[] | null): boolean {
  const path = head.path.split('?')[0] ?? '';
  if (head.upgrade) return head.method === 'GET' && /^\/devtools\/(browser|page)\/[\w.-]+$/.test(path);
  if (!/^\/json(\/[\w.-]*)*$/.test(path)) return false;
  if (sites && /^\/json\/new/.test(path)) return false;
  return head.method === 'GET' || head.method === 'PUT';
}

/** The head with `Connection: close` in place of any `Connection` it had (a plain request). */
export function closingHead(head: Buffer): Buffer {
  const lines = head.toString('latin1').split('\r\n');
  const kept = lines.filter((l, i) => i === 0 || !/^(connection|keep-alive):/i.test(l));
  // The blank line(s) at the end stay last.
  const at = kept.indexOf('');
  kept.splice(at < 0 ? kept.length : at, 0, 'Connection: close');
  return Buffer.from(kept.join('\r\n'), 'latin1');
}

/** Whether an address may be opened in an assessment's browser: `about:blank`, or http(s) on one of the sites. */
export function siteAllows(url: unknown, sites: readonly string[]): boolean {
  if (typeof url !== 'string') return true;
  if (url === '' || url === 'about:blank') return true;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  return sites.some((s) => {
    const site = s.toLowerCase();
    return host === site || host.endsWith(`.${site}`);
  });
}

/** The CDP commands an assessment's client may not send, whatever their arguments. */
const ASSESSMENT_REFUSED_METHODS = new Set([
  'DOM.setFileInputFiles',
  'Page.setDownloadBehavior',
  'Browser.setDownloadBehavior',
]);
/** The CDP commands that open a page by address (`params.url`). */
const OPENING_METHODS = new Set(['Page.navigate', 'Target.createTarget']);

/** Why an assessment's CDP command doesn't go to Chromium, or null when it may. */
export function refusedCommand(message: unknown, sites: readonly string[]): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const { method, params } = message as { method?: unknown; params?: { url?: unknown } };
  if (typeof method !== 'string') return null;
  if (ASSESSMENT_REFUSED_METHODS.has(method)) return 'Not while assessing a report.';
  if (OPENING_METHODS.has(method) && !siteAllows(params?.url, sites))
    return `While assessing a report the browser opens only the reported website (${sites.join(', ')}).`;
  return null;
}

/** A server's (unmasked) WebSocket text frame. */
export function textFrame(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (n >= 126 && n < 65536) {
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else if (n >= 65536) {
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, body]);
}

/**
 * Reads a client's WebSocket frames (masked, RFC 6455) and decides each message: control frames pass at once; a data
 * message (its fragments together) passes, or is dropped with an error answer to the client. Bytes come in as they
 * arrive; `pass` gets the raw frames to forward, `answer` what goes back to the client.
 */
export class ClientFrames {
  readonly #buf = new FrameBuffer();
  /** The raw frames of the message being read, and its unmasked payload. */
  #message: Buffer[] = [];
  #payload: Buffer[] = [];
  #size = 0;
  #opcode = 0;

  constructor(
    private readonly decide: (text: string | null) => string | null,
    private readonly pass: (raw: Buffer) => void,
    private readonly answer: (raw: Buffer) => void,
    private readonly fail: (why: string) => void,
  ) {}

  push(chunk: Buffer): void {
    this.#buf.append(chunk);
    for (;;) {
      const frame = this.#next();
      if (frame === null) return;
      if (frame === 'bad') {
        this.fail('a WebSocket frame the relay can’t read');
        return;
      }
      const { raw, fin, opcode, payload } = frame;
      if (opcode >= 0x8) {
        this.pass(raw);
        continue;
      }
      if (opcode !== 0x0) this.#opcode = opcode;
      this.#message.push(raw);
      this.#payload.push(payload);
      this.#size += payload.length;
      if (this.#size > MESSAGE_MAX) {
        this.fail('a WebSocket message larger than the relay reads');
        return;
      }
      if (!fin) continue;
      const text = this.#opcode === 0x1 ? Buffer.concat(this.#payload).toString('utf8') : null;
      const refusal = this.decide(text);
      if (refusal === null) for (const r of this.#message) this.pass(r);
      else this.answer(textFrame(refusal));
      this.#message = [];
      this.#payload = [];
      this.#size = 0;
    }
  }

  #next(): { raw: Buffer; fin: boolean; opcode: number; payload: Buffer } | 'bad' | null {
    const b = this.#buf.bytes;
    if (b.length < 2) return null;
    const fin = ((b[0] as number) & 0x80) !== 0;
    const opcode = (b[0] as number) & 0x0f;
    const masked = ((b[1] as number) & 0x80) !== 0;
    if (!masked) return 'bad';
    let len = (b[1] as number) & 0x7f;
    let at = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      at = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MESSAGE_MAX)) return 'bad';
      len = Number(big);
      at = 10;
    }
    if (b.length < at + 4 + len) return null;
    const mask = b.subarray(at, at + 4);
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = (b[at + 4 + i] as number) ^ (mask[i % 4] as number);
    const raw = b.subarray(0, at + 4 + len);
    this.#buf.consume(at + 4 + len);
    return { raw: Buffer.from(raw), fin, opcode, payload };
  }
}

/** An assessment's decision on one client message: the CDP error answer for a refused command, else null. */
export function assessmentDecision(sites: readonly string[]) {
  return (text: string | null): string | null => {
    if (text === null) return null;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return null;
    }
    const why = refusedCommand(message, sites);
    if (!why) return null;
    const { id, sessionId } = message as { id?: unknown; sessionId?: unknown };
    return JSON.stringify({
      id: typeof id === 'number' ? id : 0,
      error: { code: -32000, message: why },
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
    });
  };
}

export class Browser {
  /** The relay's socket, which the sandbox's init bridges to `127.0.0.1:47105` (`SandboxTask.browser`). */
  readonly socket: string;
  readonly #deps: BrowserDeps;
  readonly #turn: BrowserTurn;
  readonly #sockets = new Set<Socket>();
  readonly #processes = new Set<Socket>();
  #server: Server | null = null;
  #closing: Promise<void> | null = null;
  /** The Chromium that runs now (or is starting). */
  #chromium: ChromiumRun | null = null;

  private constructor(deps: BrowserDeps, turn: BrowserTurn) {
    this.#deps = deps;
    this.#turn = turn;
    this.socket = deps.socket;
  }

  /** Starts the relay on `deps.socket`; throws when it can't listen. */
  static async open(deps: BrowserDeps, turn: BrowserTurn): Promise<Browser> {
    const browser = new Browser(deps, turn);
    try {
      await browser.#listen();
    } catch (err) {
      await browser.close();
      throw err;
    }
    return browser;
  }

  async #listen(): Promise<void> {
    const server = createServer((socket) => {
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
      socket.on('error', () => {});
      void this.#serve(socket).catch((err) => {
        this.#deps.log(
          'warn',
          `browser ${this.#turn.name}: a connection failed (${err instanceof Error ? err.message : String(err)})`,
        );
        socket.destroy();
      });
    });
    await rm(this.socket, { force: true });
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

  /** Reads a request's head (or gives up), as bytes and parsed. */
  #readHead(socket: Socket): Promise<{ buf: Buffer; head: RequestHead } | null> {
    return new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => done(null), HEAD_MS);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const head = parseHead(buf);
        if (head === 'more') return;
        done(head === 'bad' ? null : { buf, head });
      };
      const onEnd = () => done(null);
      function done(v: { buf: Buffer; head: RequestHead } | null) {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('end', onEnd);
        socket.off('close', onEnd);
        socket.pause();
        resolve(v);
      }
      socket.on('data', onData);
      socket.once('end', onEnd);
      socket.once('close', onEnd);
    });
  }

  async #serve(socket: Socket): Promise<void> {
    const read = await this.#readHead(socket);
    if (!read) {
      socket.destroy();
      return;
    }
    const { buf, head } = read;
    const sites = this.#turn.sites;
    if (!passes(head, sites)) {
      this.#deps.log(
        'debug',
        `browser ${this.#turn.name}: refused ${head.method} ${head.path.slice(0, 200)}`,
      );
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    let run: ChromiumRun;
    let port: number;
    try {
      run = this.#ensureChromium();
      port = await run.ready;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const body = `The browser couldn’t start: ${why}`;
      socket.end(
        `HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      return;
    }
    // Ended while this waited: the client connects again and gets the next one.
    if (socket.destroyed || run.gone) {
      socket.destroy();
      return;
    }
    run.clients.add(socket);
    socket.once('close', () => run.clients.delete(socket));
    const upstream = this.#deps.host.connect(port);
    upstream.on('error', () => socket.destroy());
    upstream.on('close', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.pipe(socket);
    const send = (bytes: Buffer) => {
      if (bytes.length && !upstream.destroyed) upstream.write(bytes);
    };
    const rest = buf.subarray(head.length);
    const headBytes = buf.subarray(0, head.length);
    let onData: (chunk: Buffer) => void = send;
    if (head.upgrade) {
      send(headBytes);
      // An assessment's commands are read before they reach Chromium (HE-S140).
      if (sites) {
        const frames = new ClientFrames(
          assessmentDecision(sites),
          send,
          (raw) => socket.write(raw),
          (why) => {
            this.#deps.log('warn', `browser ${this.#turn.name}: closed a connection (${why})`);
            socket.destroy();
          },
        );
        onData = (chunk) => frames.push(chunk);
      }
    } else send(closingHead(headBytes));
    if (rest.length) onData(rest);
    socket.on('data', (chunk: Buffer) => onData(chunk));
    socket.once('end', () => upstream.end());
    socket.resume();
  }

  /** The Chromium that runs, starting it for the first connection (or after it ended). */
  #ensureChromium(): ChromiumRun {
    if (this.#closing) throw new Error('the browser is closed');
    if (this.#chromium) return this.#chromium;
    const run: ChromiumRun = {
      ready: Promise.resolve(0),
      process: null,
      clients: new Set(),
      watch: null,
      ending: false,
      gone: false,
    };
    run.ready = this.#startChromium(run).then(async (port) => {
      await this.#bounded(
        'its start’s work',
        this.#deps.onStart,
        port,
        this.#deps.onStartMs ?? BROWSER_ON_START_MS,
      );
      this.#watch(run, port);
      return port;
    });
    run.ready.catch(() => {
      if (this.#chromium === run) this.#chromium = null;
    });
    this.#chromium = run;
    return run;
  }

  /** Work on a Chromium that listens (`onStart`, `onStop`): bounded, a failure logged, never a reason to stop. */
  async #bounded(
    what: string,
    work: ((connect: () => Socket) => Promise<void>) | undefined,
    port: number,
    ms: number,
  ): Promise<void> {
    if (!work) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        work(() => this.#deps.host.connect(port)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`not done within ${Math.round(ms / 1000)} s`)), ms);
        }),
      ]);
    } catch (err) {
      this.#deps.log(
        'warn',
        `browser ${this.#turn.name}: ${what} failed (${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** The watchdog of a Chromium that is up, for as long as it runs and the browser is open. */
  #watch(run: ChromiumRun, port: number): void {
    const timings = this.#deps.watch;
    if (timings === false || this.#closing || run.gone) return;
    run.watch = new BrowserWatch({
      ...timings,
      connect: () => this.#deps.host.connect(port),
      log: this.#deps.log,
      name: this.#turn.name,
      restart: (why) => void this.#restart(run, port, why),
    });
    run.watch.start();
  }

  /**
   * Ends a Chromium that stopped working (the watchdog's): `onStop` first while it still runs, then the process, its
   * relay connections (the clients connect again) and its place, so the next connection starts a fresh one.
   */
  async #restart(run: ChromiumRun, port: number, why: string): Promise<void> {
    if (run.ending || run.gone || this.#closing) return;
    run.ending = true;
    run.watch?.stop();
    this.#deps.log(
      'warn',
      `browser ${this.#turn.name}: ending Chromium (${why}); the next connection starts a fresh one`,
    );
    await this.#bounded(
      'the work before its end',
      this.#deps.onStop,
      port,
      this.#deps.onStopMs ?? BROWSER_ON_STOP_MS,
    );
    // A browser that closed meanwhile ends it itself.
    if (this.#closing) return;
    run.gone = true;
    if (this.#chromium === run) this.#chromium = null;
    for (const c of run.clients) c.destroy();
    run.process?.destroy();
  }

  /**
   * A way in to the Chromium that runs now (a fresh connection to its DevTools port per call), after its start's work;
   * null when none runs: this never starts one.
   */
  async devtools(): Promise<(() => Socket) | null> {
    const run = this.#chromium;
    if (this.#closing || !run) return null;
    const port = await run.ready.catch(() => null);
    if (port === null || this.#closing || run.gone) return null;
    return () => this.#deps.host.connect(port);
  }

  async #startChromium(run: ChromiumRun): Promise<number> {
    const { log } = this.#deps;
    const t0 = Date.now();
    const chromium = await this.#deps.host.start([
      this.#deps.host.shell,
      '-c',
      chromiumCommand(this.#turn.sites),
    ]);
    // Closed while it started: it goes at once.
    if (this.#closing) {
      chromium.destroy();
      throw new Error('the browser is closed');
    }
    run.process = chromium;
    this.#processes.add(chromium);
    return new Promise<number>((resolve, reject) => {
      let text = '';
      let ready = false;
      const tail: string[] = [];
      const timer = setTimeout(() => {
        if (ready) return;
        chromium.destroy();
        reject(
          new Error(
            `Chromium didn’t start within ${Math.round((this.#deps.startMs ?? BROWSER_START_MS) / 1000)} s`,
          ),
        );
      }, this.#deps.startMs ?? BROWSER_START_MS);
      chromium.on('data', (chunk: Buffer) => {
        if (ready) return;
        text += chunk.toString('utf8');
        let nl = text.indexOf('\n');
        while (nl >= 0) {
          const line = text.slice(0, nl).trim();
          text = text.slice(nl + 1);
          const port = devtoolsPort(line);
          if (port) {
            ready = true;
            clearTimeout(timer);
            log('info', `browser ${this.#turn.name}: Chromium is up (${Date.now() - t0} ms)`);
            resolve(port);
            return;
          }
          if (line && !/dbus|Fontconfig|GPU|gpu_|viz_|ALSA/i.test(line)) {
            tail.push(line.slice(0, 300));
            if (tail.length > TAIL_LINES) tail.shift();
          }
          nl = text.indexOf('\n');
        }
      });
      chromium.on('error', () => {});
      chromium.once('close', () => {
        this.#processes.delete(chromium);
        // Gone after it started: the next connection starts another.
        if (ready) {
          run.gone = true;
          run.watch?.stop();
          if (this.#chromium === run) this.#chromium = null;
          return;
        }
        clearTimeout(timer);
        const last = tail.find((l) => l.startsWith('whombat:')) ?? tail[tail.length - 1];
        reject(new Error(last ? last.replace(/^whombat:\s*/, '') : 'Chromium ended before it listened'));
      });
    });
  }

  /** The browser goes (its pod or assessment ended): connections dropped, Chromium ended, the socket removed. */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#chromium?.watch?.stop();
      for (const s of this.#sockets) s.destroy();
      for (const p of this.#processes) p.destroy();
      await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
      await rm(this.socket, { force: true }).catch(() => {});
    })();
    return this.#closing;
  }
}
