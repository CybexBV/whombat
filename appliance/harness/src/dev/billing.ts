/**
 * Billing, signups and the operator panel in the dev environment (control BL-12, BL-27, BL-29; IN-69, IN-70):
 * control's billing settings from the harness's `WB_MGD_*` variables, the panel's allowlist and users file, and the
 * dev operator's permissions. Control reads all of them at start.
 *
 *   WB_MGD_BILLING_PROVIDER            manual (default) | stripe → BILLING_PROVIDER
 *   WB_MGD_STRIPE_SECRET_KEY_FILE      → STRIPE_SECRET_KEY_FILE (a test key: control runs as CONTROL_ENV=local)
 *   WB_MGD_STRIPE_WEBHOOK_SECRET_FILE  → STRIPE_WEBHOOK_SECRET_FILE (written by `dev/stripe setup`)
 *   WB_MGD_STRIPE_AUTOMATIC_TAX        → STRIPE_AUTOMATIC_TAX
 *   WB_MGD_SIGNUP_MODE                 → SIGNUP_MODE (the live setting's default only; the panel changes it live)
 *   WB_MGD_TRIAL_JOB_SECONDS           → TRIAL_JOB_SECONDS (the manual trial job's interval, when control has it)
 *   WB_MGD_PANEL_USERS_FILE            → PANEL_USERS_FILE (else a harness file with the user `harness`, local only)
 *   WB_MGD_PANEL_ALLOWED_NETWORKS      → PANEL_ALLOWED_NETWORKS (else loopback only)
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OPERATOR_PERMISSIONS } from '@whombat/control-contracts';
import { expandHome, ports, publicUrls } from '../lib/paths.ts';
import type { EnvState } from './env.ts';

type Log = (line: string) => void;

/** The dev operator control's dev-init writes (`operators.json`); panel users act as it. */
export const DEV_OPERATOR = 'local-operator';
/** The harness's own panel user (local environments only). */
export const HARNESS_PANEL_USER = 'harness';
/**
 * The allowlist when `WB_MGD_PANEL_ALLOWED_NETWORKS` is unset: loopback (127.0.0.0/24 lets scenarios sign in from
 * several local addresses and be refused from 127.0.9.x). Never empty: control would answer everyone in local/dev
 * (BL-27), and a public instance's panel sees the real client address through the tunnel (TRUST_PROXY_HOPS=1).
 */
export const DEFAULT_PANEL_ALLOWED = ['127.0.0.0/24', '::1/128'];

const envFile = (name: string): string | null => {
  const v = (process.env[name] ?? '').trim();
  return v ? expandHome(v) : null;
};

/** Control's billing and signup settings (BL-12, BL-29) from the `WB_MGD_*` variables; refuses what control would. */
export function billingEnv(): Record<string, string> {
  const provider = (process.env.WB_MGD_BILLING_PROVIDER ?? '').trim() || 'manual';
  if (provider !== 'manual' && provider !== 'stripe')
    throw new Error(`WB_MGD_BILLING_PROVIDER must be manual or stripe, not ${provider}`);
  const key = envFile('WB_MGD_STRIPE_SECRET_KEY_FILE');
  const hook = envFile('WB_MGD_STRIPE_WEBHOOK_SECRET_FILE');
  if (provider === 'stripe') {
    const missing = [
      ...(!key || !existsSync(key) ? ['WB_MGD_STRIPE_SECRET_KEY_FILE'] : []),
      ...(!hook || !existsSync(hook) ? ['WB_MGD_STRIPE_WEBHOOK_SECRET_FILE'] : []),
    ];
    if (missing.length)
      throw new Error(
        `WB_MGD_BILLING_PROVIDER=stripe needs ${missing.join(' and ')} (existing files; dev/stripe setup writes the webhook secret)`,
      );
  }
  const mode = (process.env.WB_MGD_SIGNUP_MODE ?? '').trim();
  if (mode && !['open', 'waitlist', 'invite'].includes(mode))
    throw new Error(`WB_MGD_SIGNUP_MODE must be open, waitlist or invite, not ${mode}`);
  const tax = (process.env.WB_MGD_STRIPE_AUTOMATIC_TAX ?? '').trim();
  const trialJob = (process.env.WB_MGD_TRIAL_JOB_SECONDS ?? '').trim();
  return {
    BILLING_PROVIDER: provider,
    ...(key ? { STRIPE_SECRET_KEY_FILE: key } : {}),
    ...(hook ? { STRIPE_WEBHOOK_SECRET_FILE: hook } : {}),
    ...(tax ? { STRIPE_AUTOMATIC_TAX: tax } : {}),
    ...(mode ? { SIGNUP_MODE: mode } : {}),
    ...(trialJob ? { TRIAL_JOB_SECONDS: trialJob } : {}),
  };
}

/** The panel allowlist control gets: `WB_MGD_PANEL_ALLOWED_NETWORKS`, else loopback only. */
export function panelAllowed(): string[] {
  const v = (process.env.WB_MGD_PANEL_ALLOWED_NETWORKS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return v.length ? v : DEFAULT_PANEL_ALLOWED;
}

/** The users file named by `WB_MGD_PANEL_USERS_FILE`, if any. */
export const configuredUsersFile = (): string | null => envFile('WB_MGD_PANEL_USERS_FILE');

/** BL-27's hash format: `scrypt$<log2N>$<r>$<p>$<salt base64url>$<key base64url>`, a 32-byte key. */
export const PASSWORD_HASH = /^scrypt\$(1[4-9]|20)\$\d{1,2}\$\d{1,2}\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{43}$/;

export function scryptHash(password: string, log2N = 15): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N: 2 ** log2N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${log2N}$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export interface PanelUser {
  username: string;
  passwordHash: string;
  operator: string;
}

export function readPanelUsers(file: string): PanelUser[] {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { users?: PanelUser[] };
  return Array.isArray(parsed.users) ? parsed.users : [];
}

/** Writes the users file atomically, mode 0600 (as control's `pnpm panel:user` does). */
export function writePanelUsers(file: string, users: PanelUser[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ users }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Adds or replaces one user. */
export function upsertPanelUser(file: string, user: PanelUser): void {
  writePanelUsers(file, [...readPanelUsers(file).filter((u) => u.username !== user.username), user]);
}

/**
 * `key=value` lines of a credentials file (`~/.config/whombat/admin-dev-credentials`: `username`, `password`, `hash`,
 * `allowed`). Only `username`, `hash` and `allowed` are ever returned: the password stays in the file.
 */
export function readCredentials(file: string): { username?: string; hash?: string; allowed?: string[] } {
  const out: { username?: string; hash?: string; allowed?: string[] } = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([a-z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m?.[1]) continue;
    const v = m[2] ?? '';
    if (m[1] === 'username') out.username = v;
    else if (m[1] === 'hash') out.hash = v;
    else if (m[1] === 'allowed')
      out.allowed = v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
  }
  return out;
}

/**
 * Contracts 0.15.0 (BL-28): new permissions (`customers.read`, `customers.write`, `signup.write`, `plans.write`,
 * `settings.write`). dev-init gives the dev operator all of them in a new `.local/`, but never touches an existing
 * `operators.json`: the harness adds the missing ones to the dev operator there, before control reads it.
 */
export function ensureOperatorPermissions(local: string, log: Log): void {
  const file = join(local, 'operators.json');
  if (!existsSync(file)) return;
  const doc = JSON.parse(readFileSync(file, 'utf8')) as {
    operators: { id: string; permissions: string[] }[];
  };
  const op = doc.operators.find((o) => o.id === DEV_OPERATOR);
  if (!op) return;
  const missing = OPERATOR_PERMISSIONS.filter((p) => !op.permissions.includes(p));
  if (!missing.length) return;
  op.permissions = [...op.permissions, ...missing];
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  log(`control: the dev operator gets ${missing.join(', ')} (operators.json, BL-28)`);
}

/**
 * The panel's users file and allowlist for control (BL-27):
 *   - `WB_MGD_PANEL_USERS_FILE` when set (the dev instance: `dev/panel user`); a missing file means no users yet;
 *   - else, in a local environment, `env/control/panel-users.json` with the user `harness` (acting as the dev operator)
 *     and its random password in `env/control/tokens/panel-harness.password` (0600), for the scenarios;
 *   - else (a public instance without a users file) no users.
 * Returns control's environment and records the panel in `state.panel`.
 */
export function preparePanel(state: EnvState, dir: string, log: Log): Record<string, string> {
  const local = `http://127.0.0.1:${ports.controlPanel}`;
  const allowed = panelAllowed();
  const none = join(dir, 'panel-users.none.json');
  let usersFile = configuredUsersFile();
  let harnessPasswordFile: string | undefined;
  if (usersFile && !existsSync(usersFile)) {
    log(`panel: ${usersFile} doesn't exist yet: no panel users (dev/panel user <name>)`);
    usersFile = null;
  }
  if (!usersFile && !configuredUsersFile() && !publicUrls) {
    usersFile = join(dir, 'panel-users.json');
    harnessPasswordFile = join(dir, 'tokens', 'panel-harness.password');
    if (
      !existsSync(harnessPasswordFile) ||
      !readPanelUsers(usersFile).some((u) => u.username === HARNESS_PANEL_USER)
    ) {
      const password = randomBytes(18).toString('base64url');
      mkdirSync(join(dir, 'tokens'), { recursive: true, mode: 0o700 });
      writeFileSync(harnessPasswordFile, password, { mode: 0o600 });
      upsertPanelUser(usersFile, {
        username: HARNESS_PANEL_USER,
        passwordHash: scryptHash(password),
        operator: DEV_OPERATOR,
      });
      log(`panel: the harness's panel user “${HARNESS_PANEL_USER}” (password in ${harnessPasswordFile})`);
    }
  }
  if (!usersFile) {
    usersFile = none;
    writePanelUsers(none, []);
  }
  state.panel = {
    url: publicUrls?.admin ?? local,
    local,
    allowed,
    usersFile,
    users: readPanelUsers(usersFile).map((u) => u.username),
    ...(harnessPasswordFile ? { harnessPasswordFile } : {}),
  };
  return {
    PANEL_HOST: '127.0.0.1',
    PANEL_PORT: String(ports.controlPanel),
    PANEL_USERS_FILE: usersFile,
    PANEL_ALLOWED_NETWORKS: allowed.join(','),
  };
}
