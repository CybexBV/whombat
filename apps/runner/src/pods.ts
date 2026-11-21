/**
 * One Hermes for the person (hermes-native.md HN-09, HN-W01…HN-W16; one-person.md OP-08): the runner's `PodManager`
 * keeps one long-lived managed sandbox — the pod — on the person's Hermes profile, whose payload `pod-init` runs
 * Hermes's own gateway and hands each turn a pre-started `hermes acp`. Turns outsiders' input starts never come here
 * (OP-17: a task sandbox of their own on the outsiders' profile).
 *
 * - The pod holds nothing of a turn (HN-W03): its mounts, environment and credential home are fixed when it starts
 *   (`PodShape`); a turn whose shape differs waits until the pod is idle, which restarts it.
 * - What is a turn's own is routed by the Hermes session its tool calls run in (HN-W04…HN-W08): the turn registers its
 *   commands, logins and AI-gateway token when it is admitted and names its session once Hermes gave it one
 *   (`PodTurn.bind`); the pod's commands service, logins and gateway hand a request only to that session's live turn.
 * - The agent's commands run in the pod beside Hermes, each in a wrapper of its own (one-person.md OP-07, `commands/`):
 *   the pod holds the agent's home and the workspaces at their own paths, the commands' folder, the commands' proxy
 *   and cgroup; `pod-init` starts their holder. The person's Chromium is one per pod (HN-W05, OP-S113), in the
 *   commands' network, started for Hermes's first CDP connection. The websites the agent keeps signed in (kept-sites.md,
 *   `PodKeptSites`) go into each fresh Chromium before Hermes gets it, and are renewed after a turn and at the stop.
 * - Up to `cap` live turns at once (HN-W10, HN-W20); more wait for a slot, never fail.
 * - Lifecycle (HN-W11): started by the first turn; stopped after `idleMs` with no live turn, or once idle past
 *   `maxAgeMs`; quiesced for the Hermes-home steps (`quiesce`: no new turn is admitted, running turns end, the pod
 *   stops, the step runs under the profile lock); retired on a new sign-in (`retire`, or a credential home made again:
 *   its stamp), so it restarts once idle; a pod whose `pod-init` died is gone and the next turn starts a new one. The
 *   pod holds the profile's lock while it lives; it dies with the runner (`--die-with-parent`, the generation's
 *   cgroups).
 * - Egress is the pod's (HN-W15): what every turn may reach, plus the grants of its live turns, updated as turns come
 *   and go.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import {
  type EgressPolicy,
  HERMES_REVIEW_DIR,
  joinPolicies,
  lockHermesProfile,
  POD_INIT_PATH,
  podAcpProcess,
  podRequest,
  type SandboxSession,
  type SandboxTask,
} from '@whombat/agent-runtime';
import type { RunnerApi } from './api';
import { Browser, type BrowserHost } from './browser';
import type { BrowserWatchTimings } from './browser-watch';
import { browserHost } from './commands/own';
import { type CommandsBox, CommandsPlace } from './commands/place';
import type { TurnCommands } from './commands/turn';
import { GatewayForwarder } from './gateway';
import { type KeptSitesBrowser, PodKeptSites, type TurnKeptSites } from './kept-sites';
import { type LoginsRoute, PodLogins } from './logins';
import type { TaskSandboxes } from './managed';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', msg: string, extra?: Record<string, unknown>) => void;

/** What fixes a pod's sandbox for its life (HN-W03): two turns with the same shape share a pod. */
export interface PodShape {
  /** The person's profile (`HERMES_HOME`): the pod's only writable state. */
  profile: string;
  /** `hermes` (absolute, inside one of `installs`). */
  bin: string;
  /** Hermes, its Python, the plugin and what they read (read-only). */
  installs: readonly string[];
  readable: readonly string[];
  /** Folders first on the pod's `PATH` (agent-browser beside `hermes`). */
  path: readonly string[];
  /** The pod's environment (HN-W03): never a token, a Vault value or a turn's path. */
  env: Readonly<Record<string, string>>;
  /**
   * The sign-in the pod's model clients use (HN-W03), fixed for its life: Claude's config home (read-write) and its
   * variables, or the person's API key file (read-only). Null: the turn needs none (ChatGPT's login is in the profile,
   * the AI gateway's token comes through the forwarder) and fits any pod; another one waits for an idle restart.
   */
  credential: PodCredential | null;
  /** Paths never visible, even inside a mounted one. */
  denied: readonly string[];
  /** Whombat's MCP endpoint (each session's MCP bridge reaches it through the pod's MCP bridge). */
  mcpUrl: string;
  /** What every turn of the person may reach; the live turns' own grants are added while they run (HN-W15). */
  egress: EgressPolicy;
}

export interface PodCredential {
  home: string | null;
  files: readonly string[];
  env: Readonly<Record<string, string>>;
}

/** What a turn brings to the pod: the things routed to it by its Hermes session (HN-W04…HN-W08). */
export interface PodTurnRoutes {
  dispatchId: string;
  /** The turn's part of its commands (`commands/turn.ts`): the pod's commands service routes its session's there. */
  commands: TurnCommands | null;
  logins: Pick<LoginsRoute, 'entries' | 'fetchSecret' | 'ask'> | null;
  /** The agent's kept sites in this turn (kept-sites.md: a person's turn with the pod's browser); none: refused. */
  keptSites?: TurnKeptSites | null;
  /** The agent token, for a turn through the AI gateway (HN-W08). */
  gatewayToken: string | null;
  /** What the turn's model, keys and web access need to reach (HN-W15). */
  egress: EgressPolicy;
}

/** A turn admitted to the pod. */
export interface PodTurn {
  readonly profile: string;
  /** Whombat's MCP endpoint as Hermes reaches it inside the pod. */
  readonly mcpUrl: string | undefined;
  /** The pod's spare `hermes acp`, its session's folder (`cwd`) made as a placeholder (HN-W02, HN-W03). */
  spawnAcp(cwd: string): ChildProcessWithoutNullStreams;
  /** The Hermes session the turn runs in: from now on its tool calls reach this turn's things (HN-W04). */
  bind(session: string): void;
  /** Where the pod's commands are (a turn's own folder for its sockets, the browser's host); null without commands. */
  readonly commands: CommandsPlace | null;
  /** The person's browser (`browser_preview` drives it too); null without one. */
  readonly browser: Browser | null;
  /** The turn ended: its session reaches nothing of it any more, and its slot is free. */
  release(): Promise<void>;
}

export interface PodManagerDeps {
  sandboxes: TaskSandboxes;
  /**
   * How Hermes's gateway and viewer start (`hermes <args>`), asked at each pod's start: `gateway` null for the scripted
   * Hermes, which has none.
   */
  hermes: () => { gateway: readonly string[] | null; acp: readonly string[] };
  /** The runner's private folder for the pods' control files (`<runner tmp>/pods`). */
  stateDir: string;
  /** Hermes's root (`WHOMBAT_HERMES_ROOT`): the profile lock. */
  hermesRoot: string;
  /** Roots where turn folders live (the workspaces): at their own paths in the pod and the commands' holder. */
  roots: () => readonly string[];
  /**
   * The box's side of the agent's commands (one-person.md OP-07): with it the pod runs them; without (tests on an
   * unwalled sandbox) Hermes's terminal is off.
   */
  commands?: CommandsBox;
  /** Whether a Chromium is where the commands run (the person's browser). */
  chromium?: boolean;
  /**
   * The server's kept sites for the pod's browser (kept-sites.md): restore into each fresh Chromium, renew a used site.
   * None: nothing is restored or renewed, and no turn keeps a site.
   */
  keptSites?: Required<Pick<RunnerApi, 'keptSiteRestore' | 'keptSiteRenew'>> | null;
  /** Where the pod's browser runs (default: its commands' wrapper, `browserHost`); tests give a stand-in Chromium. */
  browserHost?: (place: CommandsPlace, ownSocket: string) => BrowserHost;
  /** The browser watchdog's timings (default `BROWSER_WATCH`); tests make them short. */
  browserWatch?: BrowserWatchTimings;
  /** The server's origin, for the pod's AI-gateway forwarder. */
  serverUrl: string;
  log: Log;
  /** Live turns at once (HN-W10, HN-W20; default 4). */
  cap?: number;
  /** How long an ended turn's egress and gateway token stay for Hermes's review after its answer (default 2 min). */
  lingerMs?: number;
  /** Stop a pod after this long with no live turn (default 15 minutes). */
  idleMs?: number;
  /** Stop a pod once idle past this age (default 12 hours). */
  maxAgeMs?: number;
  /** How long `pod-init` may take to serve (default 60 s). */
  startMs?: number;
  /** How long a stop may take before the cgroup is killed (default 10 s). */
  stopMs?: number;
  /** How long a pod waits for its profile's lock (a Hermes-home step running; default 10 minutes). */
  lockWaitMs?: number;
  /** The pod's sandbox limits (`WHOMBAT_POD_MEMORY_MB`). */
  limits?: SandboxTask['limits'];
  /**
   * How long a stop waits for Hermes's memory and skill review of an ended turn (HN-W13: its marker in the profile,
   * HN-08) before the pod goes (default 2 minutes); an idle stop or a Hermes-home step never cuts one short sooner.
   */
  reviewWaitMs?: number;
  now?: () => number;
}

const SOCKET_PATH_MAX = 100;
/** How long a stop waits for the kept sites' renewal before the pod goes. */
const KEPT_RENEW_STOP_MS = 30_000;

/** The pod's name for a profile: short (socket paths), stable. */
export function podName(profile: string): string {
  return `pod_${createHash('sha256').update(profile).digest('hex').slice(0, 16)}`;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sortedEntries = (o: object) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/**
 * Two shapes can share a pod when everything but the egress (which follows the turns) and the credential (`fits`) is the
 * same.
 */
export function shapeKey(shape: PodShape): string {
  const { egress: _egress, credential: _credential, ...fixed } = shape;
  return digest(sortedEntries({ ...fixed, env: sortedEntries(fixed.env) }));
}

function credentialKey(c: PodCredential | null): string | null {
  return c ? digest({ home: c.home, files: [...c.files].sort(), env: sortedEntries(c.env) }) : null;
}

/**
 * Whether a turn of `shape` may run in `pod`: the same shape, its sign-in the pod's (or none needed) and that sign-in's
 * home the one the pod mounted (`stamp`, the home's inode now), the pod not retired by a sign-in change.
 */
function fits(pod: Pod, shape: PodShape, stamp: string | null): boolean {
  if (pod.retiring || pod.key !== shapeKey(shape)) return false;
  const want = credentialKey(shape.credential);
  if (want === null) return true;
  return want === credentialKey(pod.shape.credential) && stamp === pod.credentialStamp;
}

/**
 * A credential home's identity on disk (device, inode and birth time: an inode number may come back for a directory made
 * again at once), or null when there is none.
 */
async function credentialStamp(credential: PodCredential | null): Promise<string | null> {
  if (!credential?.home) return null;
  const st = await stat(credential.home, { bigint: true }).catch(() => null);
  return st ? `${st.dev}:${st.ino}:${st.birthtimeNs}` : null;
}

interface LiveTurn {
  routes: PodTurnRoutes;
  session: string | null;
  admitted: number;
  /** Its thread (HN-W10: one turn per thread). */
  threads: readonly string[];
}

/** What a turn leaves for Hermes's review after its answer (HN-W13): its egress and gateway token, for a while. */
interface Lingering {
  egress: EgressPolicy;
  gatewayToken: string | null;
  until: number;
}

type PodState = 'starting' | 'running' | 'stopping' | 'stopped';

class Pod {
  readonly name: string;
  readonly key: string;
  readonly shape: PodShape;
  state: PodState = 'starting';
  startedAt = 0;
  readonly turns = new Set<LiveTurn>();
  readonly sessions = new Map<string, LiveTurn>();
  lingering: Lingering[] = [];
  /** A sign-in of the person changed (`retire`): no new turn here, the pod stops once idle. */
  retiring = false;
  /** Its credential home as it was mounted (inode): a sign-in that made the home again leaves the mount stale. */
  credentialStamp: string | null = null;
  session: SandboxSession | null = null;
  /** `pod-init`'s exit (the stop waits for it before the cgroup goes). */
  exited: Promise<void> | null = null;
  socket = '';
  ready: Promise<void> | null = null;
  stopped: Promise<void> | null = null;
  idleTimer: NodeJS.Timeout | null = null;
  readonly closers: (() => Promise<void>)[] = [];
  /** The agent's commands here, and the person's browser (one-person.md OP-07, OP-S113). */
  commands: CommandsPlace | null = null;
  browser: Browser | null = null;
  /** The sites its browser keeps signed in (kept-sites.md), with the browser; and the renewal running now. */
  kept: PodKeptSites | null = null;
  keptWork: Promise<void> = Promise.resolve();
  /** The last lines of its log (journal on a failure). */
  readonly tail: string[] = [];

  constructor(shape: PodShape) {
    this.shape = shape;
    this.name = podName(shape.profile);
    this.key = shapeKey(shape);
  }

  /**
   * The newest live turn's agent token through the AI gateway (HN-W08); none live: the newest that ended a moment ago,
   * for Hermes's review after its answer (HN-W13; the server may have revoked it by then and refuse).
   */
  gatewayToken(now: number): string | null {
    let best: LiveTurn | null = null;
    for (const t of this.turns) if (t.routes.gatewayToken && (!best || t.admitted >= best.admitted)) best = t;
    if (best?.routes.gatewayToken) return best.routes.gatewayToken;
    const left = this.lingering.filter((l) => l.until > now && l.gatewayToken);
    return left.at(-1)?.gatewayToken ?? null;
  }

  /** The person's egress, the live turns' grants and those of turns whose review may still run (HN-W15). */
  egress(now: number): EgressPolicy {
    return joinPolicies([
      this.shape.egress,
      ...[...this.turns].map((t) => t.routes.egress),
      ...this.lingering.filter((l) => l.until > now).map((l) => l.egress),
    ]);
  }
}

/** A folder for unix sockets: `want`, or a short private one under /tmp when a socket there would be too long. */
async function socketDir(want: string, remove: string[]): Promise<string> {
  if (Buffer.byteLength(join(want, 'logins.sock')) <= SOCKET_PATH_MAX) {
    await mkdir(want, { recursive: true, mode: 0o700 });
    return want;
  }
  const dir = await mkdtemp(join('/tmp', 'wbpod-'));
  remove.push(dir);
  return dir;
}

export class PodManager {
  readonly #deps: PodManagerDeps;
  /** The pod, while one runs (or starts, or stops). */
  #pod: Pod | null = null;
  /** Hermes-home steps quiescing the pod (HN-W11): no turn is admitted meanwhile. */
  #draining = 0;
  /** Whoever waits for a change (a slot, a stop, a drain lifted). */
  #waiters: (() => void)[] = [];
  #closed = false;

  constructor(deps: PodManagerDeps) {
    this.#deps = deps;
  }

  get cap(): number {
    return Math.max(1, this.#deps.cap ?? 4);
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #changed(): void {
    for (const wake of this.#waiters.splice(0)) wake();
  }

  /** Resolves on the next change; rejects when `signal` aborts. */
  #change(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.#waiters = this.#waiters.filter((w) => w !== wake);
        reject(signal?.reason ?? new Error('aborted'));
      };
      this.#waiters.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** The pod now, if any (status, tests). */
  pods(): { profile: string; state: PodState; turns: number; sessions: string[] }[] {
    const p = this.#pod;
    return p
      ? [{ profile: p.shape.profile, state: p.state, turns: p.turns.size, sessions: [...p.sessions.keys()] }]
      : [];
  }

  /**
   * A slot in the pod for a turn (HN-W10, HN-W11): the pod started when there is none, restarted when idle and of
   * another shape, with another sign-in or too old; waits while `cap` turns live, the pod restarts or a Hermes-home step
   * runs. Rejects when `signal` aborts or the pod can't start.
   */
  async admit(
    shape: PodShape,
    routes: PodTurnRoutes,
    signal?: AbortSignal,
    options: { threads?: readonly string[] } = {},
  ): Promise<PodTurn> {
    const threads = options.threads ?? [];
    const stamp = await credentialStamp(shape.credential);
    for (;;) {
      if (this.#closed) throw new Error('the runner is stopping');
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      if (this.#draining) {
        await this.#change(signal);
        continue;
      }
      const pod = this.#pod;
      if (pod && (pod.state === 'stopping' || pod.state === 'stopped')) {
        await pod.stopped;
        continue;
      }
      const fitting = pod ? fits(pod, shape, stamp) : true;
      if (pod && pod.turns.size === 0 && (!fitting || this.#tooOld(pod))) {
        this.#deps.log('info', `pod ${pod.name}: restarting (${!fitting ? 'another shape' : 'its age'})`);
        await this.#stop(pod);
        continue;
      }
      // One turn per thread (HN-W10): Hermes would queue a second prompt, and refuse its token on a busy session.
      const sameThread = pod && [...pod.turns].some((t) => t.threads.some((x) => threads.includes(x)));
      if (pod && (!fitting || pod.turns.size >= this.cap || sameThread)) {
        await this.#change(signal);
        continue;
      }
      const target = pod ?? this.#start(shape);
      const live: LiveTurn = { routes, session: null, admitted: this.#now(), threads };
      target.turns.add(live);
      if (target.idleTimer) clearTimeout(target.idleTimer);
      target.idleTimer = null;
      target.session?.setEgress(target.egress(this.#now()));
      try {
        await target.ready;
      } catch (err) {
        target.turns.delete(live);
        this.#changed();
        throw err;
      }
      if (target.state !== 'running') {
        // It died before this turn could use it: the next one starts.
        target.turns.delete(live);
        continue;
      }
      target.session?.setEgress(target.egress(this.#now()));
      return this.#lease(target, live);
    }
  }

  #tooOld(pod: Pod): boolean {
    return pod.state === 'running' && this.#now() - pod.startedAt >= (this.#deps.maxAgeMs ?? 12 * 3_600_000);
  }

  #lease(pod: Pod, live: LiveTurn): PodTurn {
    let released = false;
    return {
      profile: pod.shape.profile,
      mcpUrl: pod.session?.mcpUrl,
      spawnAcp: (cwd) => podAcpProcess(pod.socket, cwd),
      commands: pod.commands,
      browser: pod.browser,
      bind: (session) => {
        if (released) return;
        if (live.session) pod.sessions.delete(live.session);
        const other = pod.sessions.get(session);
        // One live turn per session (HN-W10): a turn naming a session another live turn has takes nothing of it.
        if (other && other !== live) {
          this.#deps.log('warn', `pod ${pod.name}: session already bound to ${other.routes.dispatchId}`, {
            dispatchId: live.routes.dispatchId,
          });
          return;
        }
        live.session = session;
        pod.sessions.set(session, live);
        if (live.routes.commands) pod.commands?.bind(session, live.routes.commands);
      },
      release: async () => {
        if (released) return;
        released = true;
        if (live.session && pod.sessions.get(live.session) === live) pod.sessions.delete(live.session);
        if (live.routes.commands) pod.commands?.release(live.routes.commands);
        pod.turns.delete(live);
        this.#linger(pod, live);
        // The turn's logins go with it (HE-S141); its policy stays for the review after the answer (HN-W13).
        if (live.session)
          await rm(join(pod.shape.profile, 'whombat-turns', live.session, 'logins.json'), {
            force: true,
          }).catch(() => {});
        if (pod.turns.size === 0 && pod.retiring && pod.state === 'running') void this.#stop(pod);
        if (pod.turns.size === 0) {
          // Hermes's own credential store goes when no turn runs (HE-S141).
          await rm(join(pod.shape.profile, 'vault'), { recursive: true, force: true }).catch(() => {});
          if (pod.state === 'running') {
            if (this.#tooOld(pod)) void this.#stop(pod);
            else this.#idle(pod);
          }
        }
        pod.session?.setEgress(pod.egress(this.#now()));
        this.#changed();
        // A kept site the turn used stays kept for its hours from now (in the background: the turn goes on ending).
        if (pod.state === 'running') void this.#renewKept(pod);
      },
    };
  }

  /**
   * Renews the pod's kept sites that have a page open (kept-sites.md), one renewal after another; in `browser`, the
   * pod's by default.
   */
  #renewKept(pod: Pod, browser: KeptSitesBrowser | null = pod.browser): Promise<void> {
    const kept = pod.kept;
    if (!kept || !browser) return pod.keptWork;
    pod.keptWork = pod.keptWork
      .then(() => kept.renew(browser))
      .catch((err: unknown) =>
        this.#deps.log(
          'warn',
          `kept sites ${pod.name}: couldn’t renew (${err instanceof Error ? err.message : String(err)})`,
        ),
      );
    return pod.keptWork;
  }

  /** Keeps an ended turn's egress and gateway token for the review after its answer (HN-W13), then drops them. */
  #linger(pod: Pod, live: LiveTurn): void {
    const ms = this.#deps.lingerMs ?? 2 * 60_000;
    if (ms <= 0) return;
    const until = this.#now() + ms;
    pod.lingering = pod.lingering.filter((l) => l.until > this.#now());
    pod.lingering.push({ egress: live.routes.egress, gatewayToken: live.routes.gatewayToken, until });
    const timer = setTimeout(() => {
      pod.lingering = pod.lingering.filter((l) => l.until > this.#now());
      if (pod.state === 'running') pod.session?.setEgress(pod.egress(this.#now()));
    }, ms + 1);
    timer.unref?.();
  }

  #idle(pod: Pod): void {
    if (pod.idleTimer) clearTimeout(pod.idleTimer);
    pod.idleTimer = setTimeout(
      () => {
        pod.idleTimer = null;
        if (pod.turns.size === 0 && pod.state === 'running') {
          this.#deps.log('info', `pod ${pod.name}: idle, stopping`);
          void this.#stop(pod);
        }
      },
      this.#deps.idleMs ?? 15 * 60_000,
    );
    pod.idleTimer.unref?.();
  }

  /**
   * Quiesces the pod for a Hermes-home step (HE-38, HN-W11): no turn is admitted until the returned function runs;
   * running turns end first, then the pod stops (its lock with it). Rejects when `signal` aborts (nothing held).
   */
  async quiesce(signal?: AbortSignal): Promise<() => void> {
    this.#draining++;
    let lifted = false;
    const lift = () => {
      if (lifted) return;
      lifted = true;
      this.#draining--;
      this.#changed();
    };
    try {
      for (;;) {
        const pod = this.#pod;
        if (!pod) break;
        // A stop may wait for a review (HN-W13): the step waits for it only as long as it waits at all.
        if (pod.state === 'stopping' || pod.state === 'stopped') {
          await untilAborted(pod.stopped as Promise<void>, signal);
          continue;
        }
        if (pod.turns.size === 0) {
          await untilAborted(this.#stop(pod), signal);
          continue;
        }
        await this.#change(signal);
      }
    } catch (err) {
      lift();
      throw err;
    }
    return lift;
  }

  /**
   * A sign-in changed (a sign-out, a new login: HN-W11): the pod takes no new turn and stops once its turns ended — at
   * once when idle — so the next turn starts one with the sign-in as it is now, and nothing of the old one lives on in
   * Hermes (the ChatGPT login's second removal then gets the profile, HN-C04).
   */
  retire(): void {
    const pod = this.#pod;
    if (!pod || pod.state === 'stopping' || pod.state === 'stopped') return;
    pod.retiring = true;
    this.#deps.log('info', `pod ${pod.name}: a sign-in changed, stopping once idle`);
    if (pod.turns.size === 0 && pod.state === 'running') void this.#stop(pod);
    this.#changed();
  }

  /** Whether the pod has a live turn (the Hermes-home steps' `polite` take waits then). */
  busy(): boolean {
    return (this.#pod?.turns.size ?? 0) > 0;
  }

  /** The pod stops (runner shutdown). */
  async close(): Promise<void> {
    this.#closed = true;
    this.#changed();
    if (this.#pod) await this.#stop(this.#pod);
  }

  #start(shape: PodShape): Pod {
    const pod = new Pod(shape);
    this.#pod = pod;
    pod.ready = this.#boot(pod).then(
      () => {
        if (pod.state !== 'starting') return;
        pod.state = 'running';
        pod.startedAt = this.#now();
        this.#deps.log('info', `pod ${pod.name}: running`);
        this.#changed();
      },
      async (err: unknown) => {
        this.#deps.log(
          'error',
          `pod ${pod.name}: couldn’t start (${String(err)}) ${pod.tail.slice(-3).join(' ')}`,
        );
        await this.#stop(pod);
        throw err;
      },
    );
    pod.ready.catch(() => {});
    return pod;
  }

  async #boot(pod: Pod): Promise<void> {
    const deps = this.#deps;
    const { shape } = pod;
    const started = this.#now();
    const remove: string[] = [];
    pod.closers.push(async () => {
      for (const d of remove) await rm(d, { recursive: true, force: true }).catch(() => {});
    });
    await mkdir(deps.stateDir, { recursive: true, mode: 0o700 });
    await chmod(deps.stateDir, 0o700).catch(() => {});
    const base = join(realpathSync(deps.stateDir), pod.name);
    await rm(base, { recursive: true, force: true });
    remove.push(base);
    const run = join(base, 'run');
    await mkdir(run, { recursive: true, mode: 0o700 });
    const ctl = await socketDir(join(base, 'ctl'), remove);
    // Hermes's rule (one process per profile): the pod holds the profile for its life (HN-W10).
    const lock = await lockHermesProfile(deps.hermesRoot, shape.profile, {
      holder: pod.name,
      waitMs: deps.lockWaitMs ?? 10 * 60_000,
    });
    pod.closers.push(() => lock.release());
    // No Hermes runs on the profile now: a review marker left here is a killed one's (HN-08).
    await rm(join(shape.profile, HERMES_REVIEW_DIR), { recursive: true, force: true });
    const node = deps.sandboxes.node;
    // The agent's commands and the person's browser (one-person.md OP-07, OP-S113).
    const commands = await this.#commands(pod, base, ctl);
    // The routers (HN-W04…HN-W08).
    const logins = await PodLogins.open(join(ctl, 'logins.sock'), deps.log, (session) => {
      const turn = pod.sessions.get(session);
      if (!turn) return null;
      const { logins, keptSites } = turn.routes;
      // Kept sites need the pod's browser and the turn's say (a person's turn); logins aren't needed for them.
      const kept = keptSites && pod.kept && pod.browser ? pod.kept.route(pod.browser, keptSites) : undefined;
      if (!logins && !kept) return null;
      return {
        dispatchId: turn.routes.dispatchId,
        entries: logins?.entries ?? new Set<string>(),
        fetchSecret: logins?.fetchSecret ?? (() => Promise.reject(new Error('no logins this turn'))),
        ask: logins?.ask,
        kept,
      };
    });
    pod.closers.push(() => logins.close());
    const forwarder = await GatewayForwarder.open(
      {
        serverUrl: deps.serverUrl,
        tmpRoot: base,
        log: deps.log,
        authToken: () => pod.gatewayToken(this.#now()),
      },
      pod.name,
    );
    pod.closers.push(() => forwarder.close());
    const place = commands.place;
    const task: SandboxTask = {
      id: pod.name,
      cwd: run,
      writeCwd: true,
      stateDirs: [shape.profile, ...(place?.stateDirs ?? [])],
      installs: [...shape.installs],
      readable: [
        ...shape.readable,
        ...(shape.credential?.files ?? []),
        dirname(POD_INIT_PATH),
        ...(place?.readable ?? []),
      ],
      denied: [...shape.denied],
      ...(shape.credential?.home ? { credentialHome: shape.credential.home } : {}),
      env: { ...shape.env, ...(shape.credential?.env ?? {}), ...(place?.env ?? {}), WHOMBAT_POD: '1' },
      path: [...shape.path],
      ...(place ? { commands: place.sandbox } : {}),
      ...(commands.browser ? { browser: { socket: commands.browser.socket } } : {}),
      logins: { socket: join(ctl, 'logins.sock') },
      gateway: { socket: forwarder.socket },
      egress: pod.egress(this.#now()),
      mcpUrl: shape.mcpUrl,
      pod: true,
      ...(deps.limits ? { limits: deps.limits } : {}),
    };
    pod.credentialStamp = await credentialStamp(shape.credential);
    const session = await deps.sandboxes.open(task);
    pod.session = session;
    pod.closers.push(() => session.close());
    pod.socket = join(run, 'pod.sock');
    const hermes = deps.hermes();
    const config = {
      socket: pod.socket,
      hermes: shape.bin,
      gateway: hermes.gateway,
      acp: hermes.acp,
      spares: 1,
      cwd: run,
      // The commands' holder and wrapper (OP-07), once the sandbox made the commands' cgroup (a stand-in sandbox of
      // tests makes none: no holder there).
      ...(place && session.commandsCgroup() !== null
        ? {
            commands: place.hostConfig({
              bwrap: deps.sandboxes.config.bwrap,
              nsenter: deps.sandboxes.config.nsenter ?? 'nsenter',
              cgroup: session.commandsCgroup(),
            }),
          }
        : {}),
    };
    const init = session.spawn(node, [POD_INIT_PATH, JSON.stringify(config)], {
      cwd: run,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'C.UTF-8' },
    });
    init.stdin.end();
    pod.exited = new Promise<void>((r) => init.once('exit', () => r()));
    init.stderr.setEncoding('utf8');
    init.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const text = line.trim();
        if (!text) continue;
        pod.tail.push(text.slice(0, 300));
        if (pod.tail.length > 20) pod.tail.shift();
        deps.log('debug', `pod ${pod.name}: ${text.slice(0, 500)}`);
      }
    });
    init.on('exit', (code, sig) => {
      if (pod.state === 'stopping' || pod.state === 'stopped') return;
      deps.log('warn', `pod ${pod.name}: pod-init exited (${code ?? sig}) ${pod.tail.slice(-3).join(' ')}`);
      // Its turns' viewers are gone with it (their connections closed); the next turn starts a new pod.
      void this.#stop(pod);
    });
    await new Promise<void>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(
        () => reject(new Error('the pod didn’t start in time')),
        deps.startMs ?? 60_000,
      );
      timer.unref?.();
      const onData = (d: Buffer) => {
        buf += d.toString();
        if (!buf.includes('\n')) return;
        clearTimeout(timer);
        init.stdout.off('data', onData);
        init.off('exit', onExit);
        init.stdout.resume();
        if (buf.startsWith('{"ready":true}')) resolve();
        else reject(new Error(`the pod said ${buf.slice(0, 200)}`));
      };
      const onExit = (code: number | null) => {
        clearTimeout(timer);
        reject(new Error(`pod-init exited (${code})`));
      };
      init.stdout.on('data', onData);
      init.once('exit', onExit);
    });
    deps.log('info', `pod ${pod.name}: started in ${this.#now() - started} ms`);
  }

  /**
   * The agent's commands in the pod (one-person.md OP-07): their place (folders, sockets, the holder's plan) and the
   * person's browser in their network (OP-S113); none without the box's commands (tests on an unwalled sandbox).
   */
  async #commands(
    pod: Pod,
    base: string,
    ctl: string,
  ): Promise<{ place: CommandsPlace | null; browser: Browser | null }> {
    const box = this.#deps.commands;
    if (!box) return { place: null, browser: null };
    const place = await CommandsPlace.open(box, {
      kind: 'person',
      base,
      node: this.#deps.sandboxes.node,
      skills: join(pod.shape.profile, 'skills'),
      roots: this.#deps.roots(),
    });
    pod.commands = place;
    pod.closers.push(() => place.close());
    if (this.#deps.chromium === false) return { place, browser: null };
    const api = this.#deps.keptSites;
    const kept = api ? new PodKeptSites({ api, log: this.#deps.log, name: pod.name }) : null;
    pod.kept = kept;
    const browser = await Browser.open(
      {
        host: (this.#deps.browserHost ?? browserHost)(place, join(base, 'run', 'pod.sock')),
        socket: join(ctl, 'cdp.sock'),
        log: this.#deps.log,
        ...(this.#deps.browserWatch ? { watch: this.#deps.browserWatch } : {}),
        // Each fresh Chromium starts signed in to the sites the agent keeps (kept-sites.md); one the watchdog ends
        // renews them first, while it still runs, so the next one gets the cookies as they were.
        ...(kept
          ? {
              onStart: (connect: () => Socket) => kept.restore(connect),
              onStop: (connect: () => Socket) => this.#renewKept(pod, { devtools: async () => connect }),
            }
          : {}),
      },
      { name: pod.name, sites: null },
    );
    pod.browser = browser;
    pod.closers.push(() => browser.close());
    return { place, browser };
  }

  /** Waits while the plugin marks a review running in the pod's profile (HN-08), at most `reviewWaitMs`. */
  async #reviewsEnd(pod: Pod): Promise<void> {
    const until = this.#now() + (this.#deps.reviewWaitMs ?? 2 * 60_000);
    const dir = join(pod.shape.profile, HERMES_REVIEW_DIR);
    while (this.#now() < until && (await readdir(dir).catch(() => [] as string[])).length > 0)
      await new Promise((r) => setTimeout(r, 250).unref?.());
  }

  /** Stops a pod (idempotent): gracefully, then its cgroup; its routers, lock and folders go. */
  #stop(pod: Pod): Promise<void> {
    if (pod.stopped) return pod.stopped;
    const wasRunning = pod.state === 'running' || pod.state === 'starting';
    pod.state = 'stopping';
    if (pod.idleTimer) clearTimeout(pod.idleTimer);
    pod.idleTimer = null;
    pod.sessions.clear();
    this.#changed();
    pod.stopped = (async () => {
      // A review of an ended turn runs on in the gateway (HN-W13): it gets its time before the pod goes.
      if (wasRunning) await this.#reviewsEnd(pod);
      // The kept sites with a page open are renewed while their Chromium still runs (kept-sites.md).
      if (wasRunning && pod.kept) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          this.#renewKept(pod),
          new Promise<void>((r) => {
            timer = setTimeout(r, KEPT_RENEW_STOP_MS);
            timer.unref?.();
          }),
        ]);
        clearTimeout(timer);
      }
      // Gracefully first (Hermes's gateway ends its sessions' work), then the cgroup.
      const stopMs = this.#deps.stopMs ?? 10_000;
      if (wasRunning && pod.socket && pod.exited) {
        const grace = new Promise<void>((r) => setTimeout(r, stopMs).unref?.());
        await podRequest(pod.socket, 'stop', stopMs).catch(() => {});
        await Promise.race([pod.exited, grace]);
      }
      for (const close of pod.closers.splice(0).reverse()) await close().catch(() => {});
      // What the pod's sessions had of their turns (policies, logins) goes with the pod.
      await rm(join(pod.shape.profile, 'whombat-turns'), { recursive: true, force: true }).catch(() => {});
      pod.state = 'stopped';
      if (this.#pod === pod) this.#pod = null;
      this.#deps.log('info', `pod ${pod.name}: stopped`);
      this.#changed();
    })();
    return pod.stopped;
  }
}

/** `p`, or a rejection with `signal`'s reason once it aborts first (`p` goes on). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
