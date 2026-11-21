/**
 * `dev/panel` — control's operator panel in the dev environment (control BL-27, IN-70; the maintainers' dev-instance runbook,
 * “Billing, signups and the admin panel”).
 *
 *   dev/panel [show]                  the panel's URL, allowlist, users, admin app and billing, and control's signup info
 *   dev/panel user <name> --from <credentials file> [--operator id]
 *                                     adds <name> to the users file with the `hash=` line of the credentials file (the
 *                                     password is never read); says whether its `allowed=` matches the allowlist
 *   dev/panel user <name> [--generate] [--operator id]
 *                                     control's `pnpm panel:user set` on the users file (password from stdin, or a
 *                                     generated one printed once)
 *   dev/panel restart                 restarts control, which reads the users file and the allowlist at start
 *   dev/panel ops <command…>          control's operator CLI (control `pnpm ops`, CL-185) with control's settings:
 *                                     `ops link <device>`, `ops comp <device> --operator <id> --note <why>`, …
 *
 * The users file is `WB_MGD_PANEL_USERS_FILE` (else the harness's own, local environments only). Users act as the dev
 * operator (`local-operator`) unless `--operator` names another entry of control's operators.json.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { acquireEnvLock, releaseEnvLock } from '../lib/lock.ts';
import { expandHome, ports } from '../lib/paths.ts';
import { baseEnv, httpGet } from '../lib/proc.ts';
import {
  configuredUsersFile,
  DEV_OPERATOR,
  PASSWORD_HASH,
  panelAllowed,
  readCredentials,
  readPanelUsers,
  upsertPanelUser,
} from './billing.ts';
import { type EnvState, envPath, loadEnv } from './env.ts';
import { restartService } from './restart.ts';
import { controlEnv } from './services.ts';

const arg = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** The users file `dev/panel user` writes: the configured one, else the harness's own. */
function usersFileOf(state: EnvState): string {
  return configuredUsersFile() ?? state.panel?.usersFile ?? join(envPath('control'), 'panel-users.json');
}

async function show(state: EnvState): Promise<void> {
  const p = state.panel;
  const lines = [
    `panel      ${p ? `${p.url}${p.url === p.local ? '' : ` → ${p.local}`}` : `- (control has no panel, or dev/up hasn't run since; port ${ports.controlPanel})`}`,
    `allowlist  ${(p?.allowed ?? panelAllowed()).join(', ')}${p ? '' : ' (at the next start)'}`,
    `users file ${p?.usersFile ?? usersFileOf(state)}`,
    `users      ${
      readPanelUsers(usersFileOf(state))
        .map((u) => `${u.username} (${u.operator})`)
        .join(', ') || 'none'
    }${p ? ` · control started with: ${p.users.join(', ') || 'none'}` : ''}`,
    `admin app  ${state.admin?.dist ?? `- (${state.admin?.note ?? 'not built'})`}`,
    `billing    ${state.billing ? `${state.billing.provider}${state.billing.signupMode ? `, signup mode default ${state.billing.signupMode}` : ''}` : '-'}`,
  ];
  if (state.control) {
    const r = await httpGet(`${state.control.url}/v1/signup`).catch(() => null);
    if (r?.ok) {
      const i = (await r.json()) as {
        mode: string;
        billing: string;
        trialDays: number;
        termsVersion: string;
      };
      lines.push(
        `signup     ${i.mode} · billing ${i.billing} · trial ${i.trialDays} days · terms ${i.termsVersion}`,
      );
    } else lines.push(`signup     - (GET /v1/signup: ${r ? r.status : 'unreachable'})`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Adds a user from a credentials file's `hash=` line; never reads the password. */
function userFrom(state: EnvState, name: string, credentials: string, operator: string): void {
  const file = expandHome(credentials);
  if (!existsSync(file)) throw new Error(`${file} doesn't exist`);
  const c = readCredentials(file);
  if (c.username && c.username !== name) throw new Error(`${file} is for ${c.username}, not ${name}`);
  if (!c.hash || !PASSWORD_HASH.test(c.hash))
    throw new Error(`${file} has no hash= line in the panel's format (scrypt$<log2N>$<r>$<p>$<salt>$<key>)`);
  const users = usersFileOf(state);
  upsertPanelUser(users, { username: name, passwordHash: c.hash, operator });
  process.stdout.write(`${name} (${operator}) → ${users}\n`);
  if (c.allowed?.length) {
    const now = panelAllowed();
    const same = c.allowed.length === now.length && c.allowed.every((x) => now.includes(x));
    process.stdout.write(
      same
        ? `allowed= matches WB_MGD_PANEL_ALLOWED_NETWORKS\n`
        : `allowed= in ${file} is ${c.allowed.join(',')}; the panel allows ${now.join(',')} (set WB_MGD_PANEL_ALLOWED_NETWORKS)\n`,
    );
  }
}

/** Control's own `pnpm panel:user set` (BL-27): stdin passes through, so the password is typed or piped there. */
function userViaControl(state: EnvState, name: string, operator: string, generate: boolean): void {
  const src = state.sources['whombat-api'];
  if (!src) throw new Error('no source of control in this environment: dev/up first');
  const users = usersFileOf(state);
  const r = spawnSync(
    'pnpm',
    [
      '--silent',
      'panel:user',
      'set',
      name,
      '--operator',
      operator,
      '--file',
      users,
      ...(generate ? ['--generate'] : []),
    ],
    { cwd: src.path, env: baseEnv(), stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error(`pnpm panel:user set exited with ${r.status ?? r.signal}`);
}

/** Control's operator CLI (`src/scripts/ops.ts`) with the settings control runs with; its answer on stdout. */
function ops(state: EnvState, args: string[]): void {
  const src = state.sources['whombat-api'];
  if (!src || !state.control) throw new Error('no control in this environment: dev/up first');
  if (!existsSync(join(src.path, 'src', 'scripts', 'ops.ts')))
    throw new Error(`control at ${src.path} has no operator CLI (before control CL-185)`);
  const r = spawnSync('node', [join('src', 'scripts', 'ops.ts'), ...args], {
    cwd: src.path,
    env: baseEnv(controlEnv(state, join(state.control.dir, '.local'))),
    stdio: 'inherit',
  });
  process.exitCode = r.status ?? 1;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'show';
  const state = loadEnv();
  if (!state) throw new Error('no environment: dev/up first');
  const log = (l: string) => process.stderr.write(`${l}\n`);
  switch (cmd) {
    case 'show':
      await show(state);
      break;
    case 'user': {
      const name = argv[1];
      if (!name || !/^[a-z0-9._-]{1,64}$/.test(name))
        throw new Error('dev/panel user <name>: 1…64 of a-z 0-9 . _ -');
      const operator = arg(argv, '--operator') ?? DEV_OPERATOR;
      const from = arg(argv, '--from');
      if (from) userFrom(state, name, from, operator);
      else userViaControl(state, name, operator, argv.includes('--generate'));
      log('Control reads the users file at start: dev/panel restart');
      break;
    }
    case 'restart':
      acquireEnvLock('dev/panel restart');
      try {
        await restartService('control', log);
      } finally {
        releaseEnvLock();
      }
      await show(loadEnv() ?? state);
      break;
    case 'ops':
      ops(state, argv.slice(1));
      break;
    default:
      throw new Error(`unknown command ${cmd} (show | user | restart | ops)`);
  }
}
