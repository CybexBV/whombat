/**
 * Where the agent's commands run (docs/decisions/one-person.md OP-07, OP-S105…OP-S112): one `CommandsPlace` per sandbox
 * whose Hermes runs commands — the person's pod, or an outsiders' task sandbox (OP-17). It makes the commands' folder
 * (`<base>/cmd`: their `/etc` files, `/tmp`, the helpers' launchers, a folder per turn for its sockets, the holder's
 * way in), says what the sandbox must hold for them (`stateDirs`, `readable`, `env`, `sandbox`) and how its init starts
 * the holder (`hostConfig`), and serves two sockets:
 *
 * - `commands.sock` (`whombat-command`, before and after every command): the request goes to the live turn of the
 *   Hermes session it names (`bind`), or the task's one turn; a session with none — a background job's poll after its
 *   turn ended, the review after an answer — gets the place's own view (the agent's home, nothing of a turn), and a
 *   consequential command there doesn't run. The answer is the command's bubblewrap arguments (`wrapper.ts`), its
 *   environment and its key files;
 * - `agent.sock` (the `whombat` helper, a person's commands only): `notify` wakes the agent in the turn that started the
 *   command — also from a background job after that turn ended, for as long as the place lives — and `status`.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  agentEnvExtras,
  ETC_ALLOWLIST,
  nodeInstall,
  SANDBOX_PROXY_SOCKET,
  type SandboxCommands,
  withGitConfig,
} from '@whombat/agent-runtime';
import {
  ASKPASS_PATH,
  COMMANDS_DIR,
  COMMANDS_HOST_PATH,
  COMMANDS_NET_PATH,
  CONNECT_PATH,
  CommandExit,
  CommandRequest,
  GH_STANDIN_PATH,
  GIT_HELPER_PATH,
  GITHUB_VIA_WHOMBAT,
  HELPER_PATH,
  HelperRequest,
  type KeyFile,
} from '@whombat/commands';
import type { CommandGuard, RunnerNotifyBody } from './api';
import type { AgentNet } from './net';
import { agentCommand } from './repeats';
import { commandText, EXIT_REFUSED, type TurnCommands } from './turn';
import { type Bind, commandArgs, etcFiles, holderArgs, IN, inside, launcher, PROXY_PORT } from './wrapper';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', msg: string, extra?: Record<string, unknown>) => void;

/** A unix socket's path has at most 107 bytes. */
const SOCKET_PATH_MAX = 100;
const LINE_MAX = 1024 * 1024 + 64 * 1024;
/** What a consequential command outside a running turn answers (a background job's, the review's). */
export const NO_TURN_LINE =
  'whombat: this command needs a running turn to ask a person first, so it didn’t run. Ask again in the conversation.';

/** The box's side of the commands, the same for every place (the runner's start). */
export interface CommandsBox {
  guard: CommandGuard;
  /** The commands' wall of a person's commands (`whombat-agent-net`'s policy). */
  net: AgentNet;
  /** `whombat-agent-net`'s proxy socket. */
  proxySocket: string;
  log: Log;
  /** The agent's home (I-3: `WHOMBAT_AGENT_HOME`), the person's commands' `$HOME` at its own path. */
  agentHome: string;
  /** The image's tools (I-1): `bin` first on the commands' `PATH`, nix-ld's variables. Null: the host's `PATH`. */
  tools: string | null;
  nixLd: { ld: string | null; libraryPath: string | null };
  /** The runner's own `PATH` (development without the image's tools). */
  hostPath: string;
  /** The container engine's socket when it is there (I-2: `WHOMBAT_CONTAINERS_SOCKET`); null: no Docker. */
  containers: string | null;
  /** `runner.notify` (RA-31, contracts 3.0.0: the server's wake behind it). */
  notify: (body: RunnerNotifyBody) => Promise<void>;
}

export interface PlaceOptions {
  /** A person's pod, or an outsiders' task sandbox (OP-17: no agent home, no Docker, no keys, no notify). */
  kind: 'person' | 'outside';
  /** The place's own folder (the runner's, private): `cmd/` and `ctl/` go there. */
  base: string;
  /** The sandbox's pinned Node. */
  node: string;
  /** Hermes's skills (`<profile>/skills`), read-only to commands. */
  skills: string | null;
  /** More roots a turn's folders lie in (a person's: the workspaces root), bound into the sandbox and the holder. */
  roots: readonly string[];
  /** An outsiders' turn's folders (its checkout read-only), for the holder. */
  binds?: readonly Bind[];
}

/** The box's view of a command beyond its turn: whose home, whose sockets. */
interface BaseView {
  home: string;
  binds: Bind[];
  env: Record<string, string>;
}

const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** The `/etc` entries of the sandbox's allowlist this host has (a command's `/etc`, with the generated ones). */
const ETC_NAMES = ETC_ALLOWLIST.filter(
  (name, i, all) => all.indexOf(name) === i && existsSync(join('/etc', name)),
);

export class CommandsPlace {
  readonly kind: 'person' | 'outside';
  /** The commands' folder (bound into the sandbox and the holder at its own path). */
  readonly dir: string;
  /** The runner's commands service (`SandboxCommands.socket`). */
  readonly socket: string;
  /**
   * A task's browser relay (`SandboxTask.browser.socket`): beside the commands service, never in the commands' folder.
   * The sandbox mounts the relay socket's folder read-only for its bridge, which over `dir` would stop the holder from
   * making its way in there.
   */
  readonly browserSocket: string;
  /** The holder's way in (`<port>\n`, then the connection to `127.0.0.1:<port>` of the commands' network). */
  readonly inbound: string;
  readonly #box: CommandsBox;
  readonly #o: PlaceOptions;
  readonly #remove: string[];
  readonly #servers: Server[] = [];
  readonly #sockets = new Set<Socket>();
  /** The live turns by Hermes session (a pod), or the one turn (a task sandbox). */
  readonly #sessions = new Map<string, TurnCommands>();
  #only: TurnCommands | null = null;
  /** Every turn that ran here and its lease (`whombat notify` from a job it started), for as long as the place lives. */
  readonly #turns = new Map<string, { runnerId: string; attempt: number }>();
  #base: BaseView | null = null;
  #closing: Promise<void> | null = null;

  private constructor(box: CommandsBox, o: PlaceOptions, dir: string, ctl: string, remove: string[]) {
    this.#box = box;
    this.#o = o;
    this.kind = o.kind;
    this.dir = dir;
    this.#remove = remove;
    this.socket = join(ctl, 'commands.sock');
    this.browserSocket = join(ctl, 'cdp.sock');
    this.inbound = join(dir, 'in.sock');
  }

  /** Makes the commands' folder and serves its sockets; throws when it can't (what was made is removed). */
  static async open(box: CommandsBox, o: PlaceOptions): Promise<CommandsPlace> {
    await mkdir(o.base, { recursive: true, mode: 0o700 });
    const remove: string[] = [];
    // The sockets' paths must fit (the runner listens on them; the sandbox sees them at the same path).
    let root = join(realpathSync(o.base), 'cmd');
    if (Buffer.byteLength(join(root, 't', 'x'.repeat(12), 'gh.sock')) > SOCKET_PATH_MAX) {
      root = await mkdtemp(join('/tmp', 'wbcmd-'));
      remove.push(root);
    } else {
      await rm(root, { recursive: true, force: true });
      remove.push(root);
    }
    const ctl = join(root, 'ctl');
    const dir = join(root, 'w');
    for (const d of [ctl, dir, join(dir, 'etc'), join(dir, 'tmp'), join(dir, 'bin'), join(dir, 't')])
      await mkdir(d, { recursive: true, mode: 0o700 });
    const place = new CommandsPlace(box, o, dir, ctl, remove);
    try {
      await place.#prepare();
    } catch (err) {
      await place.close();
      throw err;
    }
    return place;
  }

  get home(): string {
    return this.kind === 'person' ? this.#box.agentHome : join(this.dir, 'home');
  }

  /** The container engine's socket for this place's commands (a person's only, OP-17). */
  get docker(): string | null {
    return this.kind === 'person' ? this.#box.containers : null;
  }

  /** The commands' bash: the image's tools' (an appliance has no `/bin/bash`), else the host's. */
  get shell(): string {
    return this.#box.tools ? join(this.#box.tools, 'bin', 'bash') : '/bin/bash';
  }

  async #prepare(): Promise<void> {
    const home = this.home;
    await mkdir(home, { recursive: true, mode: this.kind === 'person' ? 0o770 : 0o700 });
    // Hermes's skills folder is there from the start: the holder and every command bind the same view of it.
    if (this.#o.skills) await mkdir(this.#o.skills, { recursive: true, mode: 0o700 }).catch(() => {});
    // `~/files` (FS-09) and `~/work` (AC-24) are mount points and the work folder: there before any command.
    if (this.kind === 'person')
      for (const d of ['files', 'work']) await mkdir(join(home, d), { recursive: true }).catch(() => {});
    const shell = this.shell;
    for (const [name, content] of Object.entries(etcFiles({ home, shell })))
      await writeFile(join(this.dir, 'etc', name), content, { mode: 0o644 });
    for (const [name, script] of [
      ['gh', GH_STANDIN_PATH],
      ['git-remote-whombat', GIT_HELPER_PATH],
      ['whombat', HELPER_PATH],
      ['whombat-connect', CONNECT_PATH],
      ['whombat-askpass', ASKPASS_PATH],
    ] as const) {
      const file = join(this.dir, 'bin', name);
      await writeFile(file, launcher(this.#o.node, script), { mode: 0o755 });
      await chmod(file, 0o755);
    }
    await this.#listen(this.socket, (s) => this.#serveCommand(s));
    if (this.kind === 'person') await this.#listen(join(this.dir, 'agent.sock'), (s) => this.#serveHelper(s));
  }

  async #listen(path: string, serve: (socket: Socket) => Promise<void>): Promise<void> {
    const server = createServer((socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
      socket.on('error', () => {});
      void serve(socket).catch((err: unknown) => {
        this.#box.log('warn', `commands · a request failed: ${String(err)}`);
        socket.destroy();
      });
    });
    await rm(path, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(path, 0o600);
    this.#servers.push(server);
  }

  /** What the sandbox holds for its commands: these folders writable, these readable, this environment. */
  get stateDirs(): string[] {
    return [this.dir, ...(this.kind === 'person' ? [this.#box.agentHome] : []), ...this.#o.roots];
  }

  get readable(): string[] {
    return [COMMANDS_DIR, ...(this.#o.skills ? [this.#o.skills] : []), ...(this.docker ? [this.docker] : [])];
  }

  get env(): Record<string, string> {
    return {
      WHOMBAT_COMMANDS_LAUNCHER: join(COMMANDS_DIR, 'whombat-command.mjs'),
      WHOMBAT_COMMANDS_HOME: this.home,
    };
  }

  /** `SandboxTask.commands`: the runner's service and the commands' proxy (the daemon's, or the task's egress). */
  get sandbox(): SandboxCommands {
    return { socket: this.socket, proxy: this.kind === 'person' ? this.#box.proxySocket : null };
  }

  /** The holder's view: everything a command of this place may bind. */
  #holderBinds(): Bind[] {
    const binds: Bind[] = [
      { src: this.dir, dest: this.dir, mode: 'rw' },
      { src: nodeInstall(this.#o.node), dest: nodeInstall(this.#o.node), mode: 'ro' },
      { src: COMMANDS_DIR, dest: COMMANDS_DIR, mode: 'ro' },
      ...(this.kind === 'person'
        ? [{ src: this.#box.agentHome, dest: this.#box.agentHome, mode: 'rw' as const }]
        : []),
      ...this.#o.roots.map((r) => ({ src: r, dest: r, mode: 'rw' as const })),
      ...(this.#o.binds ?? []),
      ...(this.#o.skills ? [{ src: this.#o.skills, dest: this.#o.skills, mode: 'ro' as const }] : []),
      ...(this.docker ? [{ src: this.docker, dest: this.docker, mode: 'ro' as const }] : []),
    ];
    return binds.filter((b) => existsSync(b.src));
  }

  /**
   * How the sandbox's init starts the holder and runs commands (`pod-init.mjs`'s `commands`, `commands-init.mjs`'s
   * configuration): once the sandbox is open, with its commands' cgroup and its `nsenter`.
   */
  hostConfig(o: { bwrap: string; nsenter: string; cgroup: string | null }) {
    return {
      host: COMMANDS_HOST_PATH,
      holder: {
        bwrap: o.bwrap,
        args: holderArgs({
          binds: this.#holderBinds(),
          node: this.#o.node,
          netScript: COMMANDS_NET_PATH,
          proxy: SANDBOX_PROXY_SOCKET,
          inbound: this.inbound,
          services: this.kind === 'person',
        }),
      },
      wrapper: { nsenter: o.nsenter, bwrap: o.bwrap, cgroup: o.cgroup },
    };
  }

  /** The place's own view of a command (its home, the box's sockets): every command starts from it. */
  #baseView(): BaseView {
    if (this.#base) return this.#base;
    const box = this.#box;
    const home = this.home;
    const node = nodeInstall(this.#o.node);
    const binds: Bind[] = [
      { src: node, dest: node, mode: 'ro' },
      { src: COMMANDS_DIR, dest: COMMANDS_DIR, mode: 'ro' },
      { src: home, dest: home, mode: 'rw' },
      ...(this.#o.skills && existsSync(this.#o.skills)
        ? [{ src: this.#o.skills, dest: this.#o.skills, mode: 'ro' as const }]
        : []),
    ];
    const proxy = `http://127.0.0.1:${PROXY_PORT}`;
    // A host PATH entry that reaches the bound node through a link (a version manager's `node/24` → `node/24.21.0`)
    // names the install itself: only the install is inside, not the link to it.
    const viaLink = (dir: string) => {
      try {
        const real = realpathSync(dir);
        return inside(real, [node]) ? real : dir;
      } catch {
        return dir;
      }
    };
    const path = [
      IN.bin,
      ...(box.tools ? [join(box.tools, 'bin')] : []),
      join(home, '.local', 'bin'),
      ...(box.tools
        ? []
        : box.hostPath
            .split(':')
            .filter((d) => d.startsWith('/') && !inside(d, [home]))
            .map(viaLink)),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/run/current-system/sw/bin',
    ].filter((d, i, all) => all.indexOf(d) === i);
    const env: Record<string, string> = {
      ...agentEnvExtras(),
      PATH: path.join(':'),
      HOME: home,
      USER: 'agent',
      LOGNAME: 'agent',
      SHELL: box.tools ? join(box.tools, 'bin', 'bash') : '/bin/bash',
      TMPDIR: '/tmp',
      LANG: process.env.LANG?.includes('UTF-8') ? process.env.LANG : 'C.UTF-8',
      TERM: 'xterm-256color',
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      ALL_PROXY: proxy,
      all_proxy: proxy,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      NODE_USE_ENV_PROXY: '1',
      ...(box.nixLd.ld ? { NIX_LD: box.nixLd.ld } : {}),
      ...(box.nixLd.libraryPath ? { NIX_LD_LIBRARY_PATH: box.nixLd.libraryPath } : {}),
      ...(this.docker ? { DOCKER_HOST: `unix://${IN.docker}` } : {}),
    };
    this.#base = { home, binds, env };
    return this.#base;
  }

  /** A turn's own folder in the place (its gh socket): made now, at its own path inside the sandbox. */
  async turnDir(dispatchId: string): Promise<string> {
    const dir = join(this.dir, 't', shortHash(dispatchId));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** A pod's turn names its Hermes session: its commands are this turn's from now on (HN-W04). */
  bind(session: string, turn: TurnCommands): void {
    this.#turns.set(turn.dispatchId, turn.turn.lease);
    const other = this.#sessions.get(session);
    if (other && other !== turn) return;
    this.#sessions.set(session, turn);
  }

  /** A task sandbox's one turn: every command is its. */
  admit(turn: TurnCommands): void {
    this.#turns.set(turn.dispatchId, turn.turn.lease);
    this.#only = turn;
  }

  /** The turn ended: its session reaches nothing of it any more. */
  release(turn: TurnCommands): void {
    for (const [s, t] of this.#sessions) if (t === turn) this.#sessions.delete(s);
    if (this.#only === turn) this.#only = null;
    void rm(join(this.dir, 't', shortHash(turn.dispatchId)), { recursive: true, force: true }).catch(
      () => {},
    );
  }

  #route(session: string | null): TurnCommands | null {
    if (this.#only) return this.#only;
    return session ? (this.#sessions.get(session) ?? null) : null;
  }

  /** The run spec of a command: the place's view with the turn's on top. */
  #spec(
    turn: { binds: readonly Bind[]; env: Record<string, string>; keys: KeyFile[]; cwd: string } | null,
    tty: boolean,
    gh: string | null,
  ) {
    const base = this.#baseView();
    const binds = [...base.binds, ...(turn?.binds ?? [])];
    const cwd =
      turn &&
      inside(
        turn.cwd,
        binds.map((b) => b.dest),
      )
        ? turn.cwd
        : base.home;
    let env: Record<string, string> = { ...base.env, ...(turn?.env ?? {}) };
    if (gh) {
      env.WHOMBAT_GH_SOCKET = IN.gh;
      env = withGitConfig(env, GITHUB_VIA_WHOMBAT);
    }
    return {
      bwrap: commandArgs({
        etcNames: ETC_NAMES,
        etc: join(this.dir, 'etc'),
        tmp: join(this.dir, 'tmp'),
        bin: join(this.dir, 'bin'),
        binds,
        agentSocket: this.kind === 'person' ? join(this.dir, 'agent.sock') : null,
        gh,
        docker: this.docker,
        keys: turn?.keys ?? [],
        tty,
        cwd,
      }),
      env,
      keys: turn?.keys ?? [],
    };
  }

  /** Whombat's own command in the commands' wrapper (the browser's Chromium): the place's view, no turn's. */
  ownSpec(): { bwrap: string[]; env: Record<string, string> } {
    const { bwrap, env } = this.#spec(null, false, null);
    return { bwrap, env };
  }

  async #serveCommand(socket: Socket): Promise<void> {
    const reader = lineReader(socket);
    const first = await reader.next();
    if (first === null) return void socket.destroy();
    const parsed = CommandRequest.safeParse(safeJson(first));
    if (!parsed.success) {
      socket.end(
        `${JSON.stringify({ refuse: { code: 2, line: 'whombat: the command couldn’t be read.' } })}\n`,
      );
      return;
    }
    const req = parsed.data;
    const send = (m: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(m)}\n`);
    };
    const gone = new AbortController();
    socket.once('close', () => gone.abort());
    const turn = this.#route(req.session);
    let once: string[] = [];
    if (turn) {
      const decision = await turn.decide(req.argv, (line) => send({ say: line }), gone.signal);
      if (gone.signal.aborted) return;
      if (decision.outcome === 'refuse') {
        send({ refuse: { code: decision.code, line: decision.line } });
        socket.end();
        return;
      }
      once = decision.once;
      send({ run: this.#spec(decision, req.tty, turn.ghSocket) });
    } else {
      // No live turn (a background job's poll, the review after an answer): the place's view, and nothing that asks.
      if (this.#box.guard(agentCommand(commandText(req.argv)), { productionServers: [] })) {
        send({ refuse: { code: EXIT_REFUSED, line: NO_TURN_LINE } });
        socket.end();
        return;
      }
      send({ run: this.#spec(null, req.tty, null) });
    }
    const end = await reader.next();
    const exit = end === null ? null : CommandExit.safeParse(safeJson(end));
    if (turn && exit?.success) {
      const line = turn.ran(req.argv, exit.data.exit, once);
      if (line) send({ say: line });
    } else if (turn && once.length) turn.ran(req.argv, 255, once);
    socket.end();
  }

  async #serveHelper(socket: Socket): Promise<void> {
    const reader = lineReader(socket);
    const first = await reader.next();
    if (first === null) return void socket.destroy();
    const parsed = HelperRequest.safeParse(safeJson(first));
    const answer = (m: unknown): void => {
      socket.end(`${JSON.stringify(m)}\n`);
    };
    if (!parsed.success) return answer({ ok: false, error: 'Whombat couldn’t read that.' });
    const req = parsed.data;
    if (req.op === 'status') {
      const policy = this.#box.net.policy();
      return answer({
        ok: true,
        status: { homeNetworks: policy.homeNetworks, lan: policy.lan, docker: Boolean(this.docker) },
      });
    }
    const lease = this.#turns.get(req.turn);
    if (!lease)
      return answer({ ok: false, error: 'that turn isn’t one of this agent’s, so nobody was woken.' });
    try {
      await this.#box.notify({ fromDispatchId: req.turn, ...lease, eventId: req.eventId, text: req.text });
    } catch (err) {
      return answer({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    this.#box.log('info', `notify from a command for ${req.turn}`);
    return answer({ ok: true });
  }

  /** The place goes (its sandbox stopped): sockets closed, folders removed. Idempotent. */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      for (const s of this.#sockets) s.destroy();
      await Promise.all(this.#servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      for (const d of this.#remove) await rm(d, { recursive: true, force: true }).catch(() => {});
    })();
    return this.#closing;
  }
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Lines from a socket, one at a time (null at its end). */
function lineReader(socket: Socket): { next(): Promise<string | null> } {
  let buf = '';
  let ended = false;
  const lines: string[] = [];
  let wake: (() => void) | null = null;
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      lines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
    if (buf.length > LINE_MAX) socket.destroy();
    wake?.();
  });
  const onEnd = () => {
    ended = true;
    wake?.();
  };
  socket.once('end', onEnd);
  socket.once('close', onEnd);
  return {
    async next() {
      while (!lines.length && !ended) await new Promise<void>((r) => (wake = r));
      wake = null;
      return lines.shift() ?? null;
    },
  };
}
