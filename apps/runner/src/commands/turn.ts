/**
 * A turn's part of the agent's commands (docs/decisions/one-person.md OP-07, OP-S107; agent-computer.md AC-22, AC-41,
 * AC-42; health-command-loops.md HC-02…HC-04). Before Hermes starts, git's control files are snapshotted (AC-22)
 * and the turn's production servers looked up (a name that answers late closes the wall when it does); then every
 * command of the turn's Hermes session is decided here:
 *
 * - a command that keeps failing the same way is told so after its second failure and not run after its third
 *   (`repeats.ts`);
 * - the guard (`classifyCommand`) reads the agent's command; a consequential one asks the server (`authorizeCommand`)
 *   and, on Ask, waits for a person's answer in the same turn (`authorizeWait`) while the command shows one line; an
 *   approved production server is opened in the commands' wall (`AgentNet`) for the command or the turn;
 * - what the command sees of the turn (its checkout and git folders, `~/files`, a step's folder, the gh service), its
 *   environment (the turn's git identity, `WHOMBAT_TURN`) and the turn's Vault keys (environment variables, key files on
 *   a tmpfs) are the turn's own; the place adds the box's (`place.ts`).
 *
 * When the turn ends its openings go and git's control files are restored before the runner runs any git of its own.
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { KeyFile } from '@whombat/commands';
import {
  addressIsPublic,
  COMMAND_EXIT_CODES,
  COMMAND_MAX,
  type CommandOpening,
  classifyAddress,
  commandTimedOutText,
  commandWhy,
  parseCidr,
  parseIp,
  VAULT_ASKPASS_DIR,
} from '@whombat/core';
import type { AuthorizeWaitReply, CommandGuard, CommandsContext, RunnerCommandsApi, TurnKeys } from './api';
import { type GitControlSnapshot, snapshotGitControl } from './git-control';
import type { AgentNet } from './net';
import { agentCommand, CommandRepeats, REPEAT_REFUSED_EXIT, type RepeatVerdict } from './repeats';
import { type Bind, IN } from './wrapper';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', msg: string, extra?: Record<string, unknown>) => void;

/** What a command prints while it waits for a person (AC-41). */
export const WAITING_LINE = 'Waiting for a person to approve this command…';
/** Exit statuses of a command that didn't run (AC-41): refused or declined, and no answer in time. */
export const EXIT_REFUSED = COMMAND_EXIT_CODES.refused;
export const EXIT_TIMED_OUT = COMMAND_EXIT_CODES.timedOut;
/** A “once” opening stays this long after its command ended (AC-11, AC-DR16). */
export const ONCE_GRACE_MS = 60_000;
/** How long a turn's start waits for its production servers' names; one that answers later is added then. */
export const RESOLVE_WAIT_MS = 1000;

/** A command as logs name it: its first word and the first 8 hex of its sha256 (`curl #3fa9c1d2`). */
export function commandLabel(text: string): string {
  const first = (text.trim().split(/\s+/)[0] ?? '').split('/').pop()?.slice(0, 40) ?? '';
  return `${first || '(empty)'} #${createHash('sha256').update(text).digest('hex').slice(0, 8)}`;
}

/** The guard's text of a command: the script of `bash -c <script>` (`-lc` too), else the words. */
export function commandText(argv: readonly string[]): string {
  const [bin, flag, script] = argv;
  if (bin && /(^|\/)(ba|da|z)?sh$/.test(bin) && (flag === '-c' || flag === '-lc') && script !== undefined)
    return script;
  return argv.join(' ');
}

/** Whether an address lies in a CIDR of the same family. */
function inNetwork(address: string, cidr: string): boolean {
  const ip = parseIp(address);
  const net = parseCidr(cidr);
  if (!ip || !net || ip.family !== net.family) return false;
  let bits = net.prefix;
  for (let i = 0; i < ip.bytes.length && bits > 0; i++, bits -= 8) {
    const mask = (0xff << (8 - Math.min(8, bits))) & 0xff;
    if (((ip.bytes[i] ?? 0) & mask) !== ((net.bytes[i] ?? 0) & mask)) return false;
  }
  return true;
}

/**
 * Whether commands could reach an address but for the wall's production rule (AC-10, RA-41): a public one, one on the
 * home networks, or — when the turn reaches the local network (`lan`) — a private one.
 */
export function reachableAddress(address: string, ctx: { homeNetworks: readonly string[]; lan?: boolean }) {
  if (addressIsPublic(address)) return true;
  if (ctx.homeNetworks.some((cidr) => inNetwork(address, cidr))) return true;
  const ip = parseIp(address);
  return ctx.lan === true && ip !== null && classifyAddress(ip) === 'private';
}

/** Runs at most `max` of the functions it is given at once; the others start in the order they came. */
export function limiter(max: number): <T>(f: () => Promise<T>) => Promise<T> {
  let running = 0;
  const queue: (() => void)[] = [];
  return async (f) => {
    if (running < max) running++;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await f();
    } finally {
      // The slot goes straight to the next in line, so a newcomer can't take it in between.
      const next = queue.shift();
      if (next) next();
      else running--;
    }
  };
}

/**
 * `lookup` runs on libuv's thread pool (four threads, shared with the runner's file access), and a name that doesn't
 * resolve can hold a thread for seconds: at most two of the turns' lookups run at once.
 */
const lookups = limiter(2);

const defaultResolve4 = async (host: string): Promise<string[]> => {
  if (isIP(host) === 4) return [host];
  if (isIP(host) === 6) return [];
  return lookups(async () =>
    (await lookup(host, { all: true, family: 4 }).catch(() => [])).map((a) => a.address),
  );
};

export interface TurnCommandsDeps {
  api: RunnerCommandsApi;
  guard: CommandGuard;
  /** The commands' wall (a person's turns); null: an outsiders' turn, whose wall is its task's egress. */
  net: AgentNet | null;
  log: Log;
  /** How long a command waits for a person's yes (`WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES`, default 15). */
  approvalWaitMs?: number;
  resolve4?: (host: string) => Promise<string[]>;
  /** How long the turn's start waits for its production servers' names (`RESOLVE_WAIT_MS`). */
  resolveWaitMs?: number;
  now?: () => number;
  /** A command wasn't run because it kept failing the same way (HC-03): the turn's activity marks its row. */
  onNotRun?: () => void;
}

export interface TurnCommandsTurn {
  dispatchId: string;
  lease: { runnerId: string; attempt: number };
  /** The production servers, home networks and local network (`DispatchContext.commands`); null: an outsiders' turn. */
  context: CommandsContext | null;
  /** What of the turn its commands see, at its own path (the checkout, its git folders, `~/files`, a step's folder). */
  binds: readonly Bind[];
  /** Where its commands start. */
  cwd: string;
  /** The turn's own environment (its git identity, the work folder's git ceiling). */
  env: Readonly<Record<string, string>>;
  /** Read-only even inside a writable bind (`.git` config, hooks): snapshotted and restored (AC-22). */
  readOnlyInside: readonly string[];
  /** The turn's Vault keys when the runner fetched them already (a turn with Vault MCP servers); else asked once. */
  keys?: TurnKeys | null;
  /** Whether the turn has keys to ask for at all (a person's turn). */
  wantsKeys: boolean;
  /** Its commands don't run, with this line (an outsiders' turn that found itself in the person's pod, OP-17). */
  closed?: string;
}

/** What the place gets for a command of the turn: run it with this, or refuse. */
export type TurnDecision =
  | {
      outcome: 'run';
      binds: readonly Bind[];
      env: Record<string, string>;
      keys: KeyFile[];
      cwd: string;
      /** Its “once” openings (AC-11): closed a while after it ended (`ran`). */
      once: string[];
    }
  | { outcome: 'refuse'; code: number; line: string };

export class TurnCommands {
  readonly dispatchId: string;
  readonly #deps: TurnCommandsDeps;
  readonly #t: TurnCommandsTurn;
  readonly #repeats = new CommandRepeats();
  /** Production servers as the guard sees them: with the addresses the wall closes that commands could reach. */
  #production: CommandsContext['productionServers'] = [];
  #git: GitControlSnapshot | null = null;
  #keys: Promise<{ env: Record<string, string>; files: KeyFile[] }> | null = null;
  #ghSocket: string | null = null;
  #closing: Promise<void> | null = null;

  private constructor(deps: TurnCommandsDeps, t: TurnCommandsTurn) {
    this.#deps = deps;
    this.#t = t;
    this.dispatchId = t.dispatchId;
  }

  /** The turn's commands, before Hermes starts: git's control files snapshotted, the wall told the turn's servers. */
  static async open(deps: TurnCommandsDeps, t: TurnCommandsTurn): Promise<TurnCommands> {
    const turn = new TurnCommands(deps, t);
    const [git, wall] = await Promise.all([
      snapshotGitControl(t.readOnlyInside),
      turn.#productionAddresses(),
    ]);
    turn.#git = git;
    if (deps.net && t.context)
      await deps.net.turn(t.dispatchId, {
        homeNetworks: t.context.homeNetworks,
        lan: t.context.lan === true,
        production: wall,
      });
    return turn;
  }

  get turn(): TurnCommandsTurn {
    return this.#t;
  }

  /** The turn's gh goes through Whombat (agent-gh.md AGH-02, AGH-11): the guard leaves `gh` to Whombat's own decision. */
  useGh(socket: string): void {
    this.#ghSocket = socket;
  }

  get ghSocket(): string | null {
    return this.#ghSocket;
  }

  /**
   * Every IPv4 address of the production servers, for the wall: the server's, and what the host resolves to here now
   * (the wall holds even when the server's list is older than the name's address). The guard gets the resolved ones
   * commands could otherwise reach too — a private one on this network when the turn reaches it (RA-41) — so a command
   * to such an address asks a person instead of failing at the wall.
   *
   * The names are looked up together, and the turn waits for them only `resolveWaitMs`: one name that doesn't resolve
   * cost seconds before Hermes could start. The server's addresses are in the wall from the start; a name that answers
   * later adds its addresses to the wall and the guard when it does (the wall only ever closes more).
   */
  async #productionAddresses(): Promise<string[]> {
    const ctx = this.#t.context;
    if (!ctx) return [];
    const resolve4 = this.#deps.resolve4 ?? defaultResolve4;
    const servers = ctx.productionServers;
    const wall = new Set<string>();
    for (const s of servers) for (const a of s.addresses) if (isIP(a) === 4) wall.add(a);
    this.#production = [...servers];
    let started = false;
    const looked = servers.map(async (s, i) => {
      const resolved = await resolve4(s.host).catch(() => [] as string[]);
      const more = resolved.filter((a) => !s.addresses.includes(a) && reachableAddress(a, ctx));
      if (more.length)
        this.#production = this.#production.map((p, j) =>
          j === i ? { ...s, addresses: [...s.addresses, ...more] } : p,
        );
      if (!started) for (const a of resolved) wall.add(a);
      else if (resolved.length) await this.#deps.net?.closeProduction(resolved).catch(() => {});
    });
    let timer: NodeJS.Timeout | undefined;
    const waited = await Promise.race([
      Promise.all(looked).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.#deps.resolveWaitMs ?? RESOLVE_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    started = true;
    if (!waited)
      this.#deps.log(
        'info',
        'commands · a production server’s name hasn’t resolved yet; the wall gets it later',
        {
          dispatchId: this.dispatchId,
        },
      );
    return [...wall];
  }

  /** The turn's keys, once (AC-30): its environment variables and the files for the keys tmpfs. */
  #turnKeys(): Promise<{ env: Record<string, string>; files: KeyFile[] }> {
    this.#keys ??= (async () => {
      const t = this.#t;
      if (!t.wantsKeys) return { env: {}, files: [] };
      let keys: TurnKeys;
      try {
        keys = t.keys ?? (await this.#deps.api.turnKeys(t.dispatchId, t.lease));
      } catch (err) {
        this.#deps.log('warn', `no keys for this turn's commands: ${String(err)}`, {
          dispatchId: t.dispatchId,
        });
        return { env: {}, files: [] };
      }
      // A server's kept password (vault-simplify.md VLT-42): ssh asks the commands' askpass helper, which reads it from
      // the keys tmpfs. The variables name the helper, never the password.
      const askpass: Record<string, string> = keys.files.some((f) =>
        f.path.startsWith(`${VAULT_ASKPASS_DIR}/`),
      )
        ? { SSH_ASKPASS: `${IN.bin}/whombat-askpass`, SSH_ASKPASS_REQUIRE: 'force' }
        : {};
      return {
        env: { ...Object.fromEntries(keys.env.map((e) => [e.name, e.value])), ...askpass },
        files: keys.files.map((f) => ({
          path: f.path,
          base64: f.base64,
          mode: Number.parseInt(f.mode, 8) & 0o700,
        })),
      };
    })();
    return this.#keys;
  }

  /**
   * A command of the turn (`say`: a line to the command's stderr now): the repeats, the guard and the person's answer,
   * then what it runs with.
   */
  async decide(
    argv: readonly string[],
    say: (line: string) => void,
    gone: AbortSignal,
  ): Promise<TurnDecision> {
    if (this.#closing) return { outcome: 'refuse', code: EXIT_REFUSED, line: 'whombat: the turn is over.' };
    if (this.#t.closed) return { outcome: 'refuse', code: EXIT_REFUSED, line: this.#t.closed };
    const text = commandText(argv);
    // The same command already failed the same way too often in this turn (HC-03): not run, and its row says so.
    const refused = this.#repeats.refusal(text, this.#t.cwd);
    if (refused) {
      this.#repeated('not run', text, refused);
      this.#deps.onNotRun?.();
      return { outcome: 'refuse', code: REPEAT_REFUSED_EXIT, line: refused.line };
    }
    const decision = await this.#authorize(text, say, gone);
    if (decision.outcome === 'stop') return { outcome: 'refuse', code: decision.code, line: decision.line };
    let once: string[] = [];
    if (decision.open.length && this.#deps.net) {
      const resolve4 = this.#deps.resolve4 ?? defaultResolve4;
      const openings: { address: string; port: number | null }[] = [];
      for (const o of decision.open)
        for (const address of await resolve4(o.host).catch(() => [] as string[]))
          openings.push({ address, port: o.port ?? null });
      const keys = await this.#deps.net.open(
        this.dispatchId,
        openings,
        decision.scope === 'once' ? Number.POSITIVE_INFINITY : null,
      );
      if (decision.scope === 'once') once = keys;
    }
    const keys = await this.#turnKeys();
    const t = this.#t;
    return {
      outcome: 'run',
      binds: t.binds,
      env: {
        ...t.env,
        ...keys.env,
        // The turn, so a job this command starts can wake the agent here (`whombat notify`, RA-31).
        WHOMBAT_TURN: t.dispatchId,
      },
      keys: keys.files,
      cwd: t.cwd,
      once,
    };
  }

  /** A command of the turn ended: did it fail the same way as before (HC-02)? The line to tell the agent, or null. */
  ran(argv: readonly string[], status: number, once: readonly string[] = []): string | null {
    const keys = once;
    if (keys.length && this.#deps.net)
      void this.#deps.net
        .closeAt(this.dispatchId, keys, (this.#deps.now ?? Date.now)() + ONCE_GRACE_MS)
        .catch((err: unknown) => this.#notClosed(err));
    const text = commandText(argv);
    const verdict = this.#repeats.ran(text, this.#t.cwd, status);
    if (!verdict) return null;
    this.#repeated('told the agent', text, verdict);
    return verdict.line;
  }

  /** The wall didn't take an opening's end: said in the journal (it still lapses at the daemon within its lease). */
  #notClosed(err: unknown): void {
    this.#deps.log(
      'error',
      `commands · an opening couldn't be closed: ${err instanceof Error ? err.message : String(err)}`,
      { dispatchId: this.dispatchId },
    );
  }

  /** The journal's line for a command that keeps failing (HC-07): never the command, its first word and a short hash. */
  #repeated(what: string, text: string, verdict: RepeatVerdict): void {
    this.#deps.log(
      what === 'not run' ? 'warn' : 'info',
      `command ${commandLabel(agentCommand(text))} failed the same way ${verdict.failures} times (exit ${verdict.code}): ${what}`,
      { dispatchId: this.dispatchId },
    );
  }

  /** The guard and, for a consequential command, the server's decision (AC-40, AC-41). */
  async #authorize(
    text: string,
    say: (line: string) => void,
    gone: AbortSignal,
  ): Promise<
    | { outcome: 'run'; open: CommandOpening[]; scope: 'once' | 'task' | 'agent' }
    | { outcome: 'stop'; code: number; line: string }
  > {
    // The comment lines the command starts with say what it is for (`# why: …`): the person reads them on its card;
    // the shell skips them, so the guard reads, and the card shows, what follows.
    const { why, command } = commandWhy(agentCommand(text));
    const hit = this.#deps.guard(command, {
      productionServers: this.#production,
      ...(this.#ghSocket ? { ghThroughWhombat: true } : {}),
    });
    if (!hit) return { outcome: 'run', open: [], scope: 'once' };
    const t = this.#t;
    const lease = t.lease;
    let reply: Awaited<ReturnType<RunnerCommandsApi['authorizeCommand']>>;
    try {
      reply = await this.#deps.api.authorizeCommand({
        dispatchId: t.dispatchId,
        ...lease,
        command: command.slice(0, COMMAND_MAX) || text.slice(0, COMMAND_MAX),
        category: hit.category,
        target: hit.target,
        reason: why,
      });
    } catch (err) {
      return {
        outcome: 'stop',
        code: EXIT_REFUSED,
        line: `whombat: couldn’t ask whether this may run (${err instanceof Error ? err.message : String(err)}); it didn’t run.`,
      };
    }
    this.#deps.log(
      'info',
      // Never the command itself (it may carry a secret, AC-DR21): its first word and a short hash.
      `command ${commandLabel(command)} · ${hit.category}${hit.target ? ` → ${hit.target}` : ''}: ${reply.outcome}`,
      { dispatchId: t.dispatchId },
    );
    if (reply.outcome === 'run') return { outcome: 'run', open: reply.open, scope: 'task' };
    if (reply.outcome === 'blocked' || !reply.approvalId)
      return { outcome: 'stop', code: EXIT_REFUSED, line: reply.message };
    // The server's sentence (`commandWaitingText`), one line while the command waits.
    say(reply.message.trim() || WAITING_LINE);
    const now = this.#deps.now ?? Date.now;
    const waitMs = this.#deps.approvalWaitMs ?? 15 * 60_000;
    const deadline = now() + waitMs;
    let last: AuthorizeWaitReply | null = null;
    while (!gone.aborted) {
      const left = deadline - now();
      if (left <= 0) break;
      try {
        last = await this.#deps.api.authorizeWait(
          reply.approvalId,
          { dispatchId: t.dispatchId, ...lease, waitMs: Math.max(0, Math.min(25_000, left)) },
          gone,
        );
      } catch (err) {
        if (gone.aborted) break;
        // A blip: ask again shortly.
        this.#deps.log('warn', `waiting for an approval failed: ${String(err)}`, {
          dispatchId: t.dispatchId,
        });
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (last.outcome === 'run') return { outcome: 'run', open: last.open, scope: last.scope ?? 'once' };
      if (last.outcome === 'declined') return { outcome: 'stop', code: EXIT_REFUSED, line: last.message };
    }
    return {
      outcome: 'stop',
      code: EXIT_TIMED_OUT,
      line: commandTimedOutText(Math.max(1, Math.round(waitMs / 60_000))),
    };
  }

  /** Before the runner's own git (a push mid-turn, the landing): the control files restored. */
  async beforeRunnerGit(): Promise<string[]> {
    return (await this.#git?.restore()) ?? [];
  }

  /** The turn is over: its openings go, git's control files come back. Idempotent; returns nothing, logs problems. */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      await this.#deps.net?.drop(this.dispatchId).catch((err: unknown) => this.#notClosed(err));
      const problems = (await this.#git?.restore().catch((err: unknown) => [String(err)])) ?? [];
      if (problems.length)
        this.#deps.log('warn', `commands · git control files: ${problems.join('; ')}`, {
          dispatchId: this.dispatchId,
        });
    })();
    return this.#closing;
  }
}
