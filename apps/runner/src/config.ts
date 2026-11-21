import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { agentNetSocket } from '@whombat/agent-net';
import { defaultWhombatHome, defaultWorkspaceRoot } from '@whombat/agent-runtime';
import { settingPath } from '@whombat/agent-runtime/host';
import { z } from 'zod';
import { SANDBOX_WALL_MINUTES } from './managed';

const RunnerConfigShape = z.object({
  /** Server origin; defaults to `http://localhost:$PORT` (4400). */
  WHOMBAT_SERVER_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(4400),
  RUNNER_TOKEN: z.string().min(1).default('dev-runner-token'),
  /** Read `RUNNER_TOKEN` from this file (absolute path, mode 600) instead. */
  RUNNER_TOKEN_FILE: z.string().optional(),
  /** Whombat's own directory (S-03), absolute or `~/…`; default `~/.whombat`. */
  WHOMBAT_HOME: z
    .string()
    .refine((v) => settingPath(v) !== null, 'must be a full path (/… or ~/…)')
    .optional(),
  /** Git worktrees for coding work: `<dir>/<burrow>/<repo>/<branch>`; default `$WHOMBAT_HOME/workspaces`. */
  WHOMBAT_WORKSPACES: z.string().optional(),
  /**
   * Workspaces nobody used for this many days are removed (at start and daily) — never uncommitted or unpushed
   * work; merged ones go after a day.
   */
  WHOMBAT_WORKSPACE_IDLE_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  /**
   * The cache of the conversations' Files the runner keeps for commands turns (files-space.md FS-09), in bytes: the
   * least recently used go beyond it. Default 10 GiB.
   */
  WHOMBAT_FILES_CACHE_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .default(10 * 1024 ** 3),
  /** Turns this runner runs at once. */
  RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  RUNNER_ID: z
    .string()
    .regex(/^rnr_[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  RUNNER_NAME: z.string().max(120).optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  /** Per-identity provider credential homes, `<root>/<identity>/<provider>`; default `$WHOMBAT_HOME/credentials`. */
  WHOMBAT_CREDENTIALS_ROOT: z.string().optional(),
  /**
   * The manager's AI client status as the server last received it (`LocalClientsStatus`, CT-73; the server writes it,
   * this runner reads it before each turn). Unset: the image's pinned runtimes (PV-01).
   */
  WHOMBAT_CLIENTS_FILE: z.string().optional(),
  /**
   * Where the manager installs the AI clients (default `/persist/whombat/clients`). A client the clients file
   * names runs (and signs people in) only if its realpath is inside this directory's realpath, and neither it nor any
   * directory above it can be changed by the server's user or anyone but root, the directory's owner (the manager) and
   * this runner's user (SUB-45).
   */
  WHOMBAT_CLIENTS_ROOT: z.string().optional(),
  /**
   * The server's sign-in socket (`/run/whombat/signin.sock`, review I-1): the sign-in executor talks to the server only
   * there, after checking the socket belongs to its directory's owner (the server's user). Unset: over HTTP.
   */
  WHOMBAT_SIGNIN_SOCKET: z.string().optional(),
  /**
   * The runner's own state (generation counter, sandbox control files); default `$WHOMBAT_HOME/runner`. Private to the
   * runner: never inside a task's view.
   */
  WHOMBAT_RUNNER_STATE: z.string().optional(),
  /** Bubblewrap for the task sandbox (the pinned one); default `WHOMBAT_BWRAP`, else `bwrap` on PATH. */
  WHOMBAT_SANDBOX_BWRAP: z.string().optional(),
  /** util-linux's `nsenter` (absolute; one-person.md OP-07: how a command joins its holder); default on PATH. */
  WHOMBAT_SANDBOX_NSENTER: z.string().optional(),
  /**
   * Where task cgroups come from — `systemd-user` (a transient delegated scope in the user manager: a development host,
   * the default) or `delegated` (the runner's systemd unit has `Delegate=yes`: the appliance's module sets it).
   */
  WHOMBAT_SANDBOX_CGROUP: z.enum(['delegated', 'systemd-user']).default('systemd-user'),
  /** `systemd-user`: the slice for generation scopes. */
  WHOMBAT_SANDBOX_SLICE: z
    .string()
    .regex(/^[A-Za-z0-9_]+\.slice$/)
    .default('whombat_tasks.slice'),
  /** Extra read-only paths every task sees (toolchains), colon-separated absolute paths. */
  WHOMBAT_SANDBOX_RO_PATHS: z.string().optional(),
  /** Extra hosts every task may reach (`registry.npmjs.org,*.pypi.org`); default none. */
  WHOMBAT_SANDBOX_EGRESS_ALLOW: z.string().optional(),
  /** Explicit customer-network grants, `10.20.0.0/16:5432;fd12::/48` (never loopback or metadata). */
  WHOMBAT_SANDBOX_GRANTS: z.string().optional(),
  WHOMBAT_SANDBOX_MEMORY_MB: z.coerce.number().int().min(128).default(4096),
  WHOMBAT_SANDBOX_PIDS: z.coerce.number().int().min(32).default(1024),
  WHOMBAT_SANDBOX_CPU_WEIGHT: z.coerce.number().int().min(1).max(10000).default(100),
  WHOMBAT_SANDBOX_TMP_MB: z.coerce.number().int().min(16).default(1024),
  WHOMBAT_SANDBOX_OUTPUT_MB: z.coerce.number().int().min(1).default(256),
  /** The longest a turn runs, minutes (resourceful-agents.md RA-14). */
  WHOMBAT_SANDBOX_WALL_MINUTES: z.coerce.number().int().min(1).default(SANDBOX_WALL_MINUTES),
  /**
   * The agent's commands (docs/decisions/one-person.md OP-07, interfaces I-1…I-4): its home (`$HOME` at its own path;
   * default `$WHOMBAT_HOME/agent/home`), the image's tools (a Nix store path whose `bin` goes first on the commands'
   * `PATH`; unset: the host's `PATH`) and nix-ld's loader and libraries, the container engine's socket (unset or not
   * there: no Docker), and the commands-network daemon's proxy socket (default as `whombat-agent-net` makes it).
   */
  WHOMBAT_AGENT_HOME: z.string().optional(),
  WHOMBAT_AGENT_TOOLS: z.string().optional(),
  WHOMBAT_AGENT_NIX_LD: z.string().optional(),
  WHOMBAT_AGENT_NIX_LD_LIBRARY_PATH: z.string().optional(),
  WHOMBAT_CONTAINERS_SOCKET: z.string().optional(),
  WHOMBAT_AGENT_NET_SOCKET: z.string().optional(),
  /** How long a consequential command waits for a person's yes in the same turn (AC-41). */
  WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  /**
   * The person's one Hermes (docs/decisions/hermes-native.md HN-W10, HN-W11, HN-W16; one-person.md OP-S84): how many of
   * their turns run at once in their pod, its memory, and when an idle pod stops.
   */
  WHOMBAT_POD_TURNS: z.coerce.number().int().min(1).max(16).default(4),
  WHOMBAT_POD_MEMORY_MB: z.coerce.number().int().min(512).default(6144),
  WHOMBAT_POD_IDLE_MINUTES: z.coerce.number().int().min(1).default(15),
  WHOMBAT_POD_MAX_HOURS: z.coerce.number().int().min(1).default(12),
});

export const RunnerConfigSchema = RunnerConfigShape.refine(
  (cfg) =>
    [
      cfg.WHOMBAT_AGENT_HOME,
      cfg.WHOMBAT_AGENT_TOOLS,
      cfg.WHOMBAT_CONTAINERS_SOCKET,
      cfg.WHOMBAT_AGENT_NET_SOCKET,
    ].every((p) => p === undefined || p.startsWith('/')),
  {
    message:
      'WHOMBAT_AGENT_HOME, WHOMBAT_AGENT_TOOLS, WHOMBAT_CONTAINERS_SOCKET and WHOMBAT_AGENT_NET_SOCKET are absolute paths',
  },
).transform((cfg) => {
  const paths = { WHOMBAT_HOME: cfg.WHOMBAT_HOME, WHOMBAT_WORKSPACES: cfg.WHOMBAT_WORKSPACES };
  const whombatHome = defaultWhombatHome(paths);
  return {
    ...cfg,
    WHOMBAT_SERVER_URL: cfg.WHOMBAT_SERVER_URL ?? `http://localhost:${cfg.PORT}`,
    WHOMBAT_HOME: whombatHome,
    WHOMBAT_AGENT_HOME: cfg.WHOMBAT_AGENT_HOME ?? join(whombatHome, 'agent', 'home'),
    WHOMBAT_AGENT_NET_SOCKET: agentNetSocket({
      ...process.env,
      WHOMBAT_HOME: whombatHome,
      ...(cfg.WHOMBAT_AGENT_NET_SOCKET ? { WHOMBAT_AGENT_NET_SOCKET: cfg.WHOMBAT_AGENT_NET_SOCKET } : {}),
    }),
    WHOMBAT_WORKSPACES: defaultWorkspaceRoot(paths),
    WHOMBAT_CREDENTIALS_ROOT: cfg.WHOMBAT_CREDENTIALS_ROOT ?? join(whombatHome, 'credentials'),
  };
});

export type RunnerConfig = z.output<typeof RunnerConfigSchema>;

/**
 * The settings the runner takes from the repo's `.env`: its own configuration and where the provider CLIs
 * (and bubblewrap) live. That file is shared with the server (database, master key,
 * SMTP and other secrets); none of that belongs in a process that starts agents.
 */
export const RUNNER_ENV_KEYS: readonly string[] = [
  ...Object.keys(RunnerConfigShape.shape),
  'WHOMBAT_CLAUDE_PATH',
  'WHOMBAT_PROVIDER_ENV',
  'WHOMBAT_BWRAP',
];

/**
 * Problem with a secret file: not absolute, unreadable, empty, or readable by group or others. A file in the unit's
 * systemd credentials directory is exempt from the mode rule when that directory gives others no access: systemd
 * creates credential files 0440 in a directory only the unit can open (MR-74).
 */
function readSecretFile(
  name: string,
  file: string,
  credentialsDir?: string,
): { value?: string; issue?: string } {
  if (!isAbsolute(file)) return { issue: `${name}: must be an absolute path (got ${file})` };
  let value: string;
  try {
    value = readFileSync(file, 'utf8').trim();
  } catch (err) {
    return { issue: `${name}: cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? String(err)})` };
  }
  if (!value) return { issue: `${name}: ${file} is empty` };
  const mode = statSync(file).mode & 0o777;
  const privateDir =
    credentialsDir !== undefined &&
    isAbsolute(credentialsDir) &&
    resolve(dirname(file)) === resolve(credentialsDir) &&
    (statSync(credentialsDir).mode & 0o007) === 0;
  if (mode & 0o077 && !privateDir)
    return {
      issue: `${name}: ${file} is readable by group or others (mode ${mode.toString(8)}); run chmod 600 ${file}`,
    };
  return { value };
}

export function loadRunnerConfig(env: Record<string, string | undefined> = process.env): RunnerConfig {
  const cleaned: Record<string, string> = Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== ''),
  );
  const issues: string[] = [];
  // systemd credentials (NX-20, MR-37): `$CREDENTIALS_DIRECTORY/runner-token` when nothing else names the token.
  const credentials = cleaned.CREDENTIALS_DIRECTORY;
  if (
    credentials &&
    cleaned.RUNNER_TOKEN === undefined &&
    cleaned.RUNNER_TOKEN_FILE === undefined &&
    existsSync(join(credentials, 'runner-token'))
  )
    cleaned.RUNNER_TOKEN_FILE = join(credentials, 'runner-token');
  const tokenFile = cleaned.RUNNER_TOKEN_FILE;
  if (tokenFile !== undefined) {
    if (cleaned.RUNNER_TOKEN !== undefined) {
      issues.push('RUNNER_TOKEN: set either RUNNER_TOKEN or RUNNER_TOKEN_FILE, not both');
    } else {
      const { value, issue } = readSecretFile('RUNNER_TOKEN_FILE', tokenFile, credentials);
      if (issue) issues.push(issue);
      else if (value) cleaned.RUNNER_TOKEN = value;
    }
  }
  const result = RunnerConfigSchema.safeParse(cleaned);
  if (!result.success) issues.push(...result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  if (!result.success || issues.length > 0) {
    throw new Error(`Invalid runner configuration:\n${issues.map((i) => `  ${i}`).join('\n')}`);
  }
  return result.data;
}

/**
 * Loads the runner's own settings (`RUNNER_ENV_KEYS`) from an env file into `env`; variables already set win.
 * Everything else in the file is ignored, so the runner can share the server's production env file without
 * holding its database URL, master key or GitHub secrets. The file is `file`, else `WHOMBAT_ENV_FILE` (which
 * must exist), else the repo's `.env` if present.
 */
export function loadDotEnv(file?: string, env: Record<string, string | undefined> = process.env): void {
  const fromEnv = file === undefined ? env.WHOMBAT_ENV_FILE : undefined;
  // A packaged release (docs/decisions/bp-distribution.md BP-F02) has no repository `.env` to fall back to.
  if (file === undefined && !fromEnv && env.WHOMBAT_APP_DIR?.trim()) return;
  const path = file ?? fromEnv ?? resolve(import.meta.dirname, '../../../.env');
  if (!existsSync(path)) {
    if (fromEnv) throw new Error(`Invalid runner configuration:\n  WHOMBAT_ENV_FILE: ${path} does not exist`);
    return;
  }
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  for (const key of RUNNER_ENV_KEYS) {
    const value = parsed[key];
    if (value !== undefined && env[key] === undefined) env[key] = value;
  }
}
