/**
 * State of the local integrated environment (`~/.cache/whombat-mgd/env/env.json`): which sources run, the
 * services with their pids, ports, logs and URLs, and the dev appliance's public identity. Secrets live in
 * separate 0600 files under the same directory; env.json only points to them.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../lib/paths.ts';

export type ServiceName =
  | 'postgres'
  | 'control'
  | 'relay'
  | 'restic'
  | 'backup'
  | 'manager'
  | 'tuf'
  /** Re-signs the dev TUF repository's timestamp every 6 h (IN-224). */
  | 'tuf-refresh'
  | 'helper'
  | 'bridge'
  /** The hosts service (hosts `serve --headless`, NX-155): servers, guests, alerts and consoles. */
  | 'hosts'
  /** The commands' network daemon (Whombat one-person.md OP-07): the runtime's `apps/agent-net`, when it has one. */
  | 'agent-net'
  | 'runtime'
  | 'runner'
  | 'web'
  | 'embed';

/**
 * Services an older harness ran that this one doesn't: the agents' browser host (IN-88, gone with IN-407) and computerd
 * (gone with the agent's computer, Whombat one-person.md OP-04). dev/up and dev/down stop what an older env.json still
 * lists, remove its files and drop it.
 */
export const RETIRED_SERVICES = ['browser', 'computerd'] as const;

export interface ServiceState {
  pid: number | null;
  /** `docker` for the Postgres container. */
  kind: 'process' | 'docker';
  url?: string;
  log: string;
  startedAt: string;
  command?: string;
  cwd?: string;
  /** Why it isn't running (skipped, blocked). */
  note?: string;
  status: 'running' | 'stopped' | 'skipped' | 'blocked' | 'failed';
}

export interface SourceState {
  id: string;
  path: string;
  commit: string;
  mode: 'pinned' | 'live';
  /** Live trees: uncommitted changes present (never allowed in pinned mode). */
  dirty: boolean;
  lockfileDrift?: boolean;
}

export interface EnvState {
  $schema: 'whombat.local-env/1';
  mode: 'pinned' | 'live' | 'mixed';
  /** The pins file the environment was started from (IN-20). */
  pinsFile?: string;
  createdAt: string;
  updatedAt: string;
  ports: Record<string, number>;
  sources: Record<string, SourceState>;
  services: Partial<Record<ServiceName, ServiceState>>;
  control?: {
    url: string;
    adminUrl: string;
    /** 0600 files. */
    provisioningTokenFile: string;
    operatorTokenFile: string;
    dir: string;
  };
  relay?: { url: string; adminUrl: string; worker: string; audience: string };
  appliance?: {
    deviceId: string;
    route: string;
    peerId: string;
    fingerprint: string;
    identityDir: string;
    claimCardFile: string;
    claimFile: string;
    managerSocket: string;
    adminSocket: string;
  };
  /** `direct`: the runtime's direct listener, `127.0.0.1:<port>` (IN-419); absent in environments from before it. */
  runtime?: { url: string; databaseUrl: string; home: string; direct?: string };
  /**
   * How the runtime's agents run (`WB_MGD_AGENTS`, IN-38, IN-403): `scripted`, the runtime's scripted Hermes, or `live`,
   * Hermes from the image's package with the installed clients; absent: scripted (environments before IN-38).
   */
  agents?: 'scripted' | 'live';
  /** The Hermes the runner was started with (`WHOMBAT_HERMES_BIN`) and its home (`WHOMBAT_HERMES_ROOT`). */
  hermes?: { bin: string; root: string };
  /** The commands' network daemon's socket (`WHOMBAT_AGENT_NET_SOCKET`) while it runs. */
  agentNet?: { socket: string };
  /**
   * The runtime's `WHOMBAT_GOOGLE` (`WB_MGD_GOOGLE`, IN-49); absent: unset (the runtime's default, real Google). Read
   * at every runtime start, so a scenario may switch it and restart the runtime (scenario m restores it).
   */
  google?: 'real' | 'fake' | 'off';
  web?: { url: string };
  /**
   * The Feedback widget's embed origin (IN-54): the origin websites load `embed/v1/widget.js` from (the runtime's
   * `WHOMBAT_EMBED_URL`, control's `CONTROL_EMBED_ORIGINS`), the loopback server behind it and the built tree.
   */
  embed?: { url: string; local: string; dist: string };
  /**
   * The admin app (control's `admin/`, or an older Whombat's `build:admin`; BL-30, IN-69), built before control starts and served by control's panel
   * listener (`ADMIN_UI_DIR`). `dist` null: not built (`note` says why); the panel then serves only its API.
   */
  admin?: { dist: string | null; commit?: string; note?: string };
  /**
   * Control's operator panel (BL-27, IN-69): the listener, the allowlist and users file control was started with (the
   * usernames only), and the harness's own panel user's password file when the harness made the users file.
   */
  panel?: {
    url: string;
    local: string;
    allowed: string[];
    usersFile: string;
    users: string[];
    harnessPasswordFile?: string;
  };
  /** Control's billing provider and signup mode as started (BL-12, BL-29, IN-69); the signup mode is the default only. */
  billing?: { provider: 'manual' | 'stripe'; signupMode: string | null };
  manager?: { kind: 'standin' | 'real'; note: string };
  /**
   * The appliance backup service (IN-26): its local API socket, config and PostgreSQL 17 tools, and its CLI (for the
   * offline checkpoint a contract migration needs, IN-424; absent in environments from before it).
   */
  backup?: { socket: string; config: string; pgBin: string; cli?: string };
  /**
   * The hosts service (NX-155): its API socket and the service token file the runtime gets (`WHOMBAT_HOSTS_SOCKET`,
   * `WHOMBAT_HOSTS_TOKEN_FILE`), its data directory, the agents' port and the agents it serves.
   */
  hosts?: { socket: string; tokenFile: string; data: string; agentPort: number; agentDist: string };
  /**
   * The appliance licence (IN-39): the dev image's pinned key set, written from control's `GET /v1/licence/keys` when
   * control starts (a provisioning-time step; the boxes never fetch it), and the development overrides scenarios and
   * `dev/licence` may set (control CL-41 `LICENCE_TTL_S`/`LICENCE_RENEW_AFTER_S`, runtime MR-60
   * `WHOMBAT_LICENCE_GRACE_S`/`WHOMBAT_LICENCE_CLOCK_OFFSET_S`); they apply at the next start of that service.
   */
  licence?: {
    keysFile: string;
    env: string;
    kids: string[];
    overrides?: LicenceOverrides;
  };
}

export interface LicenceOverrides {
  ttlS?: number;
  renewAfterS?: number;
  graceS?: number;
  clockOffsetS?: number;
}

export const ENV_DIR = paths.env;

export function envPath(...parts: string[]): string {
  return join(ENV_DIR, ...parts);
}

export function loadEnv(): EnvState | null {
  if (!existsSync(paths.envFile)) return null;
  return JSON.parse(readFileSync(paths.envFile, 'utf8')) as EnvState;
}

export function saveEnv(state: EnvState): void {
  mkdirSync(ENV_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${paths.envFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, paths.envFile);
}

export function writeSecret(file: string, value: string): void {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(file, value, { mode: 0o600 });
}
