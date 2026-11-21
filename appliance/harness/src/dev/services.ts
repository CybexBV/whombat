/**
 * Starting each component of the local integrated environment (IN-07…IN-10): control, relay, restic
 * rest-server, the dev manager, the managed runtime and its runner, the web app. Each start function is
 * idempotent against a running service, waits for health and throws an actionable message.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LicenceKeySet } from '@whombat/protocol/licence';
import type { ReleaseTuple } from '@whombat/release';
import {
  type AgentsMode,
  browserControlUrl,
  embedOrigin,
  HARNESS_DIR,
  mailpit,
  PG_PASSWORD,
  PG_USER,
  paths,
  pgUrl,
  ports,
  publicUrls,
  REPO_DIR,
  relayConnectUrl,
} from '../lib/paths.ts';
import { alive, httpGet, must, run, spawnService, waitFor } from '../lib/proc.ts';
import { flakeHasInput } from '../lib/source.ts';
import { loadPins } from '../manifest/pins.ts';
import { contractsAtLeast } from '../manifest/version.ts';
import { billingEnv, ensureOperatorPermissions, preparePanel } from './billing.ts';
import {
  type EnvState,
  envPath,
  type ServiceName,
  type ServiceState,
  type SourceState,
  writeSecret,
} from './env.ts';
import {
  migrateRuntime,
  offlineBackupConfig,
  parseBackupRun,
  type StackBackup,
} from './migrate-checkpoint.ts';
import { ownAddressControlEnv, ownAddressManagerEnv, relayDoorArgs } from './own-address.ts';
import { ensureDatabase } from './postgres.ts';
import {
  DEV_CHANNEL,
  devManagerVersion,
  firstReleaseId,
  hasChannels,
  nextReleaseId,
  publishRelease,
  readTuple,
  runtimeFacts,
} from './releases.ts';
import { goBuild } from './sources.ts';
import { controlTufUrl } from './tuf-refresh.ts';

export type Log = (line: string) => void;

const logFile = (name: string) => join(paths.logs, `${name}.log`);

function service(
  state: EnvState,
  name: ServiceName,
  s: Omit<ServiceState, 'startedAt' | 'kind'>,
): ServiceState {
  const v: ServiceState = { kind: 'process', startedAt: new Date().toISOString(), ...s };
  state.services[name] = v;
  return v;
}

function running(state: EnvState, name: ServiceName): boolean {
  const s = state.services[name];
  return !!s && s.status === 'running' && alive(s.pid);
}

const hint = (name: string) => `see ${logFile(name)} (dev/logs ${name})`;

/* control ---------------------------------------------------------------------------------------------- */

export const CONTROL_DB = 'whombat_control';

export async function startControl(state: EnvState, src: SourceState, log: Log): Promise<void> {
  const url = `http://127.0.0.1:${ports.control}`;
  const adminUrl = `http://127.0.0.1:${ports.controlAdmin}`;
  const dir = envPath('control');
  const local = join(dir, '.local');
  const tokens = join(dir, 'tokens');
  const devInit = readFileSync(join(src.path, 'src/scripts/dev-init.ts'), 'utf8');
  // Contracts 0.10 (CL-39): control signs licences with a keyring from dev-init (`lic-local-…`, a DEV key).
  const knowsLicence = devInit.includes('licence-keys.json');
  const licenceKeys = join(local, 'licence-keys.json');
  if (!existsSync(join(local, 'admission-keys.json'))) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    log('control: generating local keys and credentials (control src/scripts/dev-init.ts)');
    const r = await must('node', [join(src.path, 'src/scripts/dev-init.ts')], {
      cwd: dir,
      env: { RELAY_PORT: String(ports.relay) },
    });
    const prov = /provisioning token:\s+(\S+)/.exec(r.stdout)?.[1];
    const op = /operator token:\s+(\S+)/.exec(r.stdout)?.[1];
    if (!prov || !op) throw new Error(`control dev-init printed no tokens:\n${r.stdout}`);
    writeSecret(join(tokens, 'provisioning.token'), prov);
    writeSecret(join(tokens, 'operator.token'), op);
  }
  // Contracts 0.7 (CL-31): the discovery key keys the network tags of `claims.nearby`. dev-init adds it to an
  // existing `.local/` on its own (it touches nothing else there); a control before 0.7 has no such file.
  const discoveryKey = join(local, 'discovery.key');
  const missing = [
    ...(!existsSync(discoveryKey) && devInit.includes('discovery.key') ? ['the discovery key'] : []),
    // Same for the licence keyring (CL-39: dev-init adds it to an existing `.local/`, IN-39).
    ...(knowsLicence && !existsSync(licenceKeys) ? ['the licence keyring'] : []),
    // And the DEV support CA (remote help, control CL-129, IN-385): dev-init makes `support-ca.key` and the line DEV
    // images pin, `support-ca.pub`, when they are missing.
    ...(devInit.includes('support-ca.key') && !existsSync(join(local, 'support-ca.key'))
      ? ['the support CA']
      : []),
  ];
  if (missing.length > 0) {
    log(`control: adding ${missing.join(' and ')} to an existing .local (dev-init)`);
    await must('node', [join(src.path, 'src/scripts/dev-init.ts')], { cwd: dir });
  }
  // A public instance assigns the relay's public URL (dev-init wrote the loopback one).
  if (publicUrls)
    writeFileSync(
      join(local, 'relay-workers.json'),
      `${JSON.stringify({ workers: [{ id: 'local-1', url: relayConnectUrl(publicUrls) }] }, null, 2)}\n`,
    );
  state.control = {
    url,
    adminUrl,
    provisioningTokenFile: join(tokens, 'provisioning.token'),
    operatorTokenFile: join(tokens, 'operator.token'),
    dir,
  };
  // The panel (BL-27, IN-69): a control that has it gets its listener, allowlist and users; from contracts 0.15.0
  // the dev operator also gets the new permissions (BL-28). Before control reads them.
  const knowsPanel = readFileSync(join(src.path, 'src/config.ts'), 'utf8').includes('PANEL_PORT');
  if (knowsPanel && contractsAtLeast('0.15.0')) ensureOperatorPermissions(local, log);
  const panelEnv = knowsPanel ? preparePanel(state, dir, log) : {};
  if (knowsPanel) {
    const b = billingEnv();
    state.billing = {
      provider: b.BILLING_PROVIDER === 'stripe' ? 'stripe' : 'manual',
      signupMode: b.SIGNUP_MODE ?? null,
    };
  } else {
    delete state.panel;
    delete state.billing;
  }
  if (running(state, 'control')) return;
  await ensureDatabase(CONTROL_DB);
  const env = { ...controlEnv(state, local), ...panelEnv };
  // Control's request log is kept at most 14 days (CL-38), here through the log keeper (IN-41).
  const pid = spawnService(
    'node',
    [
      join(HARNESS_DIR, 'src/dev/log-keeper.ts'),
      '--file',
      logFile('control'),
      '--days',
      '14',
      '--',
      'node',
      'src/index.ts',
    ],
    { cwd: src.path, env, logFile: `${logFile('control')}.keeper` },
  );
  const s = service(state, 'control', {
    pid,
    url,
    log: logFile('control'),
    status: 'running',
    command: 'node src/index.ts (log keeper: 14 days)',
    cwd: src.path,
  });
  await waitFor('control', async () => (await httpGet(`${url}/v1/health`)).ok, {
    timeoutMs: 90_000,
    alive: () => alive(pid),
    hint: hint('control'),
  }).catch((e) => {
    s.status = 'failed';
    throw e;
  });
  log(`control: ${url} (operator ${adminUrl})`);
  if (knowsLicence) await pinLicenceKeys(state, url, log);
  if (state.panel) await checkPanel(state.panel, state.admin, log);
}

/**
 * Control's environment (IN-07 and later): everything but the panel's, which `preparePanel` adds. Also what control's
 * own scripts run with (`dev/stripe setup`).
 */
/** The account site's https origin control is given (`UI_URL`): `WB_MGD_UI_URL`, else `https://localhost:<web port>`. */
export function accountSiteUrl(): string {
  return process.env.WB_MGD_UI_URL?.trim() || `https://localhost:${ports.web}`;
}

/**
 * A page of the account site as it answers on this machine: control writes `https://localhost:<web port>/…` in its
 * mails and on a box's screen, and the web app here speaks plain HTTP on loopback. Any other address is left alone.
 */
export function accountSitePage(url: string): string {
  const local = `https://localhost:${ports.web}`;
  return url === local || url.startsWith(`${local}/`) ? `http${url.slice('https'.length)}` : url;
}

export function controlEnv(state: EnvState, local: string): Record<string, string | undefined> {
  const url = `http://127.0.0.1:${ports.control}`;
  const discoveryKey = join(local, 'discovery.key');
  const licenceKeys = join(local, 'licence-keys.json');
  const supportCa = join(local, 'support-ca.key');
  const tufUrl = controlTufUrl(envPath('manager', 'tuf'), ports.tuf);
  return {
    CONTROL_ENV: 'local',
    // Both loopback families (Fastify binds 127.0.0.1 and ::1 for `localhost`): the boxes and the browser side of
    // the scenarios reach control over IPv4 and IPv6, like on a dual-stack LAN (IN-36).
    HOST: 'localhost',
    PORT: String(ports.control),
    ADMIN_HOST: '127.0.0.1',
    ADMIN_PORT: String(ports.controlAdmin),
    DATABASE_URL: pgUrl(CONTROL_DB),
    PUBLIC_URL: url,
    // The account site's origin as control names it in mails and on a box's screen. Whombat Link's code page must be
    // https (`LinkPageUrl`), or control answers no `link.begin` at all, so it is `https://localhost:<web port>`: a
    // screen shows it without the scheme (“Open localhost:5190/link”), which is where the web app is on this machine,
    // over plain HTTP (`accountSitePage` turns a mailed or shown address into the one that answers here).
    // `WB_MGD_UI_URL` names another https origin (an HTTPS proxy of your own in front of the web app).
    UI_ORIGINS: [`http://localhost:${ports.web}`, `http://127.0.0.1:${ports.web}`, accountSiteUrl()].join(
      ',',
    ),
    UI_URL: accountSiteUrl(),
    SMTP_URL: mailpit.smtp,
    MAIL_FROM: 'Whombat (local) <no-reply@whombat.local>',
    ADMISSION_KEYS_FILE: join(local, 'admission-keys.json'),
    ASSIGNMENT_KEYS_FILE: join(local, 'assignment-keys.json'),
    PROVISIONING_TOKENS_FILE: join(local, 'provisioning-tokens.txt'),
    OPERATORS_FILE: join(local, 'operators.json'),
    RELAY_WORKERS_FILE: join(local, 'relay-workers.json'),
    PUSH_HMAC_KEY_FILE: join(local, 'push-hmac.key'),
    // Contracts ≥ 0.5.1 (CT-42): Web Push keys from dev-init.
    VAPID_KEYS_FILE: join(local, 'vapid.json'),
    // Real pushes once a phone key is configured (IN-201, IN-518; control CL-53/CL-116): FCM to Android phones, APNs to
    // iPhones, and Web Push to browsers. Without either key the fake senders.
    ...(process.env.WB_MGD_FCM_SERVICE_ACCOUNT_FILE || process.env.WB_MGD_APNS_KEY_FILE
      ? { PUSH_MODE: 'live' }
      : { PUSH_MODE: 'fake' }),
    ...(process.env.WB_MGD_FCM_SERVICE_ACCOUNT_FILE
      ? {
          FCM_SERVICE_ACCOUNT_FILE: process.env.WB_MGD_FCM_SERVICE_ACCOUNT_FILE,
          ...(process.env.WB_MGD_FCM_PROJECT_ID ? { FCM_PROJECT_ID: process.env.WB_MGD_FCM_PROJECT_ID } : {}),
        }
      : {}),
    ...apnsControlEnv(process.env),
    // Probe appliances (IN-11) are claimed by the same test orgs run after run.
    DEFAULT_DEVICES_ALLOWED: '1000',
    // Absolute: control's default is relative to its working directory (the source checkout).
    ...(existsSync(discoveryKey) ? { DISCOVERY_KEY_FILE: discoveryKey } : {}),
    // The licence keyring (CL-39), absolute like the discovery key; shorter token lifetimes for scenarios and
    // `dev/licence` (CL-41: local and dev only, at least 60 s).
    ...(existsSync(licenceKeys) ? { LICENCE_KEYS_FILE: licenceKeys } : {}),
    ...licenceControlEnv(state),
    // Remote help (IN-385, control CL-129): the DEV support CA signs support certificates of 8 hours (control's
    // default is 4), so a working day of `dev/support` is one visit per Whombat. A control without the key file answers
    // support.open 503; one before remote help ignores both.
    ...(existsSync(supportCa) ? { SUPPORT_CA_KEY_FILE: supportCa, SUPPORT_CERT_TTL_S: '28800' } : {}),
    // The feedback drop (Whombat FD-40, IN-54): on (control's default outside prod, set so it doesn't depend on it),
    // pulls every 5 s instead of 30 (the scenario and people trying it wait less), and the embed origin the widget's
    // frame runs on may fetch cards and post drops (CORS and the Origin check). A control before 0.13 ignores them.
    FEEDBACK_DROP: 'on',
    FEEDBACK_PULL_S: '5',
    ...(embedOrigin() ? { CONTROL_EMBED_ORIGINS: embedOrigin() as string } : {}),
    // CC-10: `devices.selfRegister` is off unless asked for (WB_MGD_SELF_REGISTRATION=1).
    ...(process.env.WB_MGD_SELF_REGISTRATION === '1' ? { SELF_REGISTRATION: '1' } : {}),
    // The Android APK the hosted UI's “Mobile app” page links to (CT-191, IN-135): `<dir>/android/latest.json` and the
    // file it names, published by whombat-app's `apps/mobile/scripts/publish-apk.mjs`. A control before 0.23.2 ignores it.
    ...(process.env.WB_MGD_DOWNLOADS_DIR ? { DOWNLOADS_DIR: process.env.WB_MGD_DOWNLOADS_DIR } : {}),
    // Billing and signups (BL-12, BL-29, IN-69): the manual provider unless WB_MGD_BILLING_PROVIDER=stripe; the admin
    // app the panel serves (BL-27), built before control starts. A control before 0.15 ignores them.
    ...billingEnv(),
    ...(state.admin?.dist ? { ADMIN_UI_DIR: state.admin.dist } : {}),
    // The own address (CL-165, CL-166; plan §4): the zone labels are registered under and the `lbl` switch.
    ...ownAddressControlEnv(process.env),
    // Operator alerts (UP-G2, CL-88) on the dev TUF repository too: `tuf_timestamp_stale` below 12 h left, root and
    // targets, the client channel (IN-224). Nothing is mailed without OPERATOR_ALERT_EMAILS; the panel lists them.
    ...(tufUrl ? { TUF_PUBLIC_URL: tufUrl } : {}),
    LOG_LEVEL: 'info',
    ...(publicUrls
      ? {
          PUBLIC_URL: publicUrls.control,
          UI_ORIGINS: publicUrls.web,
          UI_URL: publicUrls.web,
          WEBAUTHN_RP_ID: publicUrls.webauthnRpId,
          // cloudflared on loopback is the one proxy hop; its X-Forwarded-For is the client.
          TRUST_PROXY_HOPS: '1',
          DEFAULT_DEVICES_ALLOWED: '10',
          ...(publicUrls.smtpUrlFile ? { SMTP_URL: undefined, SMTP_URL_FILE: publicUrls.smtpUrlFile } : {}),
          ...(publicUrls.mailFrom ? { MAIL_FROM: publicUrls.mailFrom } : {}),
        }
      : {}),
  };
}

/**
 * The panel answers from loopback (the default allowlist; on the dev instance loopback is outside the allowlist, so a
 * bare 403 is expected there too): `GET /v1/operator/session` without a cookie is 401.
 */
async function checkPanel(
  panel: NonNullable<EnvState['panel']>,
  admin: EnvState['admin'],
  log: Log,
): Promise<void> {
  const r = await httpGet(`${panel.local}/v1/operator/session`).catch(() => null);
  const how = !r
    ? '✗ not answering'
    : r.status === 401
      ? 'answering'
      : r.status === 403
        ? 'answering (loopback is outside the allowlist)'
        : `HTTP ${r.status}`;
  log(
    `panel: ${panel.url === panel.local ? panel.local : `${panel.url} → ${panel.local}`} ${how}; allow ${panel.allowed.join(',')}; users ${panel.users.join(', ') || 'none'}; admin app ${admin?.dist ? admin.dist : `none (${admin?.note ?? 'not built'})`}`,
  );
}

/** Control's licence overrides from env.json (IN-39). */
function licenceControlEnv(state: EnvState): Record<string, string> {
  const o = state.licence?.overrides ?? {};
  return {
    ...(o.ttlS !== undefined ? { LICENCE_TTL_S: String(o.ttlS) } : {}),
    ...(o.renewAfterS !== undefined ? { LICENCE_RENEW_AFTER_S: String(o.renewAfterS) } : {}),
  };
}

/** The runtime's licence settings (IN-39; runtime MR-55, MR-60): the pinned key set and the dev overrides. */
export function licenceRuntimeEnv(state: EnvState): Record<string, string> {
  if (!state.licence) return {};
  const o = state.licence.overrides ?? {};
  return {
    // Checked as on a commercial box: the runtime's own default is off outside production (Whombat HE-49).
    WHOMBAT_LICENCE: 'on',
    WHOMBAT_LICENCE_KEYS_FILE: state.licence.keysFile,
    ...(o.graceS !== undefined ? { WHOMBAT_LICENCE_GRACE_S: String(o.graceS) } : {}),
    ...(o.clockOffsetS !== undefined ? { WHOMBAT_LICENCE_CLOCK_OFFSET_S: String(o.clockOffsetS) } : {}),
  };
}

/** Where the dev image's pinned licence key set lives (the appliance's /etc/whombat/licence-keys.json). */
export const licenceKeysPath = () => envPath('appliance', 'licence-keys.json');

/**
 * Writes the dev image's pinned licence key set from control's public set (`GET /v1/licence/keys`, LC-03, IN-39): the
 * provisioning-time step that stands in for building the key set into the image. The boxes never fetch it; the
 * runtime (`WHOMBAT_LICENCE_KEYS_FILE`) and the managers (`licence.keysFile`) read this file. It changes only when
 * control's keyring does (a new image, logged).
 */
export async function pinLicenceKeys(state: EnvState, controlUrl: string, log: Log): Promise<void> {
  const r = await httpGet(`${controlUrl}/v1/licence/keys`);
  if (!r.ok) {
    log(`control: no licence key set (GET /v1/licence/keys: ${r.status}); the boxes get none`);
    return;
  }
  const ks = LicenceKeySet.parse(await r.json());
  const file = licenceKeysPath();
  const text = `${JSON.stringify(ks, null, 2)}\n`;
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (before !== text) {
    mkdirSync(envPath('appliance'), { recursive: true, mode: 0o700 });
    rmSync(file, { force: true });
    writeFileSync(file, text, { mode: 0o444 });
    log(
      `licence: ${before === null ? 'pinned' : 're-pinned (control’s keyring changed)'} the dev image’s key set (${ks.env}: ${ks.keys.map((k) => k.kid).join(', ')}) → ${file}`,
    );
  }
  state.licence = { ...state.licence, keysFile: file, env: ks.env, kids: ks.keys.map((k) => k.kid) };
}

/**
 * Where the dev appliance's manager reaches control (CC-11): on a public instance through the public API origin, so
 * control sees this host's public address (TRUST_PROXY_HOPS=1: cloudflared's X-Forwarded-For) and a browser on the
 * same network finds the box (`claims.nearby`); loopback otherwise. Provisioning and the harness's own calls stay on
 * loopback.
 */
export function managerControlUrl(loopback: string): string {
  return publicUrls?.control ?? dualStackLoopback(loopback);
}

/**
 * A loopback control URL by name (`localhost`, which resolves to 127.0.0.1 and ::1) instead of 127.0.0.1, for the
 * boxes' managers: they report over both families like a box on a dual-stack LAN (MG-32, control CL-36, IN-36).
 */
export function dualStackLoopback(url: string): string {
  return url.replace('//127.0.0.1:', '//localhost:');
}

/* relay ------------------------------------------------------------------------------------------------ */

export async function startRelay(state: EnvState, src: SourceState, log: Log): Promise<void> {
  const url = publicUrls ? relayConnectUrl(publicUrls) : `ws://127.0.0.1:${ports.relay}/v1/connect`;
  const adminUrl = `http://127.0.0.1:${ports.relayAdmin}`;
  state.relay = { url, adminUrl, worker: 'local-1', audience: 'whombat-relay:local' };
  if (running(state, 'relay')) return;
  const bin = await goBuild(src, ['./cmd/...']);
  const args = [
    '-environment',
    'local',
    '-worker-id',
    'local-1',
    '-audience',
    'whombat-relay:local',
    '-issuer',
    publicUrls?.control ?? `http://127.0.0.1:${ports.control}`,
    '-jwks-url',
    `http://127.0.0.1:${ports.control}/v1/admission/jwks`,
    '-jwks-allow-http',
    '-jwks-reload',
    '10s',
    '-listen',
    `127.0.0.1:${ports.relay}`,
    '-admin-listen',
    `127.0.0.1:${ports.relayAdmin}`,
    '-allowed-origins',
    publicUrls?.web ?? `http://localhost:${ports.web},http://127.0.0.1:${ports.web}`,
    // A public instance keeps the relay's default limits and takes the client address from cloudflared.
    ...(publicUrls
      ? [
          '-own-origins',
          publicUrls.relay,
          '-trusted-proxies',
          '127.0.0.1/32,::1/128',
          '-client-ip-header',
          'X-Forwarded-For',
        ]
      : // Local loopback: scenarios open many connections from one IP.
        ['-ip-conn-rate', '0', '-subject-hello-rate', '0']),
    '-log-format',
    'text',
    '-log-level',
    'info',
  ];
  const help = await run(join(bin, 'relay'), ['-h'], { cwd: src.path });
  // RL-32: all local clients share one source prefix (loopback); the storm scenario connects 40 at once.
  if (!publicUrls && `${help.stdout}${help.stderr}`.includes('max-preauth-per-prefix'))
    args.push('-max-preauth-per-prefix', '1000');
  // The door (RL-36): browsers' and validators' TLS for <label>.<zone>, from the door host's forwarder (plan D16).
  const door = relayDoorArgs(process.env, `${help.stdout}${help.stderr}`);
  args.push(...door.args);
  if (door.skipped) log(`relay: ${door.skipped}`);
  const pid = spawnService(join(bin, 'relay'), args, { cwd: src.path, logFile: logFile('relay') });
  const s = service(state, 'relay', {
    pid,
    url,
    log: logFile('relay'),
    status: 'running',
    command: `relay ${args.join(' ')}`,
    cwd: src.path,
  });
  await waitFor('relay', async () => (await httpGet(`${adminUrl}/readyz`)).ok, {
    timeoutMs: 30_000,
    alive: () => alive(pid),
    hint: hint('relay'),
  }).catch((e) => {
    s.status = 'failed';
    throw e;
  });
  log(
    `relay: ${url} (admin ${adminUrl}, JWKS from control)${door.args.length ? `; door on ${door.args[1]} for ${door.args[3]}` : ''}`,
  );
}

/* restic rest-server (append-only) --------------------------------------------------------------------- */

export const REST_SERVER_VERSION = 'v0.14.0';

export async function startRestic(state: EnvState, log: Log): Promise<void> {
  if (running(state, 'restic')) return;
  const bin = join(paths.bin, `rest-server-${REST_SERVER_VERSION}`);
  if (!existsSync(join(bin, 'rest-server'))) {
    log(`restic: building rest-server ${REST_SERVER_VERSION} (go install)`);
    await must('go', ['install', `github.com/restic/rest-server/cmd/rest-server@${REST_SERVER_VERSION}`], {
      cwd: HARNESS_DIR,
      env: { GOBIN: bin, CGO_ENABLED: '0' },
      logFile: logFile('build-rest-server'),
      timeoutMs: 600_000,
    });
  }
  const data = envPath('restic', 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const url = `http://127.0.0.1:${ports.restic}`;
  const args = ['--path', data, '--listen', `127.0.0.1:${ports.restic}`, '--append-only', '--no-auth'];
  const pid = spawnService(join(bin, 'rest-server'), args, { cwd: data, logFile: logFile('restic') });
  service(state, 'restic', {
    pid,
    url,
    log: logFile('restic'),
    status: 'running',
    command: `rest-server ${args.join(' ')}`,
  });
  await waitFor('restic rest-server', async () => (await httpGet(`${url}/`)).status < 500, {
    timeoutMs: 20_000,
    alive: () => alive(pid),
    hint: hint('restic'),
  });
  log(`restic: ${url} (append-only, no auth: local only)`);
}

/* backup service (appliance main backup/, IN-26) ------------------------------------------------------- */

/**
 * The appliance's persistent layout (MA-12) under `env/persist`: WHOMBAT_HOME, workspaces, provider credentials and
 * the master key live where the backup service's coverage expects them (`backup/pkg/coverage`); Hermes's home where a
 * box keeps it (`WHOMBAT_HERMES_ROOT`, NX-431) and the agent's own home beside it (`WHOMBAT_AGENT_HOME`, a box's
 * `/persist/whombat/agent/home`; Whombat one-person.md OP-04).
 */
export function persistLayout() {
  const root = envPath('persist');
  return {
    root,
    home: join(root, 'whombat', 'home'),
    workspaces: join(root, 'whombat', 'workspaces'),
    credentials: join(root, 'whombat', 'credentials'),
    hermes: join(root, 'whombat', 'hermes'),
    agentHome: join(root, 'whombat', 'agent', 'home'),
    secrets: join(root, 'secrets'),
  };
}

const PLAIN_PATH = /^\/[A-Za-z0-9_][A-Za-z0-9._+-]*(\/[A-Za-z0-9_][A-Za-z0-9._+-]*)*$/;

/**
 * Where the dev appliance's manager installs AI clients (MG-33, IN-37). The manager pushes executable paths under it
 * and the contract refuses dot-directories, which a `WB_MGD_HOME` like `~/.cache/whombat-mgd` has. So:
 * `WB_MGD_CLIENTS_ROOT` when set (a plain path); else `env/persist/whombat/clients` when that is plain; else a link
 * `$XDG_RUNTIME_DIR/whombat-mgd-clients-<hash of the state root>` to it (made on every start, the files stay in the
 * environment). null: no client installs.
 */
export function clientsRoot(): string | null {
  const set = process.env.WB_MGD_CLIENTS_ROOT?.trim();
  if (set) return PLAIN_PATH.test(set) ? set : null;
  const real = join(persistLayout().root, 'whombat', 'clients');
  if (PLAIN_PATH.test(real)) return real;
  const rt = process.env.XDG_RUNTIME_DIR;
  if (!rt || !PLAIN_PATH.test(rt) || !existsSync(rt)) return null;
  const link = join(
    rt,
    `whombat-mgd-clients-${createHash('sha256').update(real).digest('hex').slice(0, 10)}`,
  );
  mkdirSync(real, { recursive: true, mode: 0o755 });
  const target = lstatSync(link, { throwIfNoEntry: false });
  if (target && (!target.isSymbolicLink() || readlinkSync(link) !== real)) rmSync(link, { force: true });
  if (!lstatSync(link, { throwIfNoEntry: false })) symlinkSync(real, link);
  return link;
}

function ensurePersistLayout(masterKey: string): void {
  const l = persistLayout();
  for (const d of [l.home, l.workspaces, l.credentials, l.secrets])
    mkdirSync(d, { recursive: true, mode: 0o700 });
  const key = join(l.secrets, 'master.key');
  if (!existsSync(key)) writeSecret(key, `${masterKey}\n`);
}

/**
 * PostgreSQL 17 client tools for the backup service (pg_dump with `--snapshot`, pg_restore, initdb for drills):
 * nixpkgs' `postgresql_17` at the revision the appliance flake pins, rooted under the harness `bin/` — never the
 * host's tools (the database is the `postgres:17` container).
 */
async function postgres17Bin(appliance: SourceState, log: Log): Promise<string> {
  const link = join(paths.bin, 'postgresql-17');
  if (existsSync(join(link, 'bin', 'pg_dump'))) return join(link, 'bin');
  const lock = JSON.parse(readFileSync(join(appliance.path, 'flake.lock'), 'utf8')) as {
    nodes: Record<string, { locked?: { rev?: string } }>;
  };
  const rev = lock.nodes.nixpkgs?.locked?.rev;
  if (!rev) throw new Error('backup: the appliance flake.lock pins no nixpkgs revision');
  log(`backup: PostgreSQL 17 client tools from nixpkgs ${rev.slice(0, 12)} (nix build)`);
  await must(
    'nix',
    [
      '--extra-experimental-features',
      'nix-command flakes',
      'build',
      '--out-link',
      link,
      `github:NixOS/nixpkgs/${rev}#postgresql_17`,
    ],
    { cwd: paths.bin, logFile: logFile('build-postgresql-17'), timeoutMs: 1_800_000 },
  );
  return join(link, 'bin');
}

/**
 * The appliance backup service (`whombat-backup serve`, appliance main `backup/`) on its local API socket, with the
 * append-only rest-server as its destination. The manager gets its socket (`backupSocket`) for pre-migration
 * checkpoints (`POST /v1/checkpoints`, reason `migration`, under the manager's drain); the runtime gets it as
 * `WHOMBAT_BACKUP_SOCKET`. Development differences (named): one developer uid for runtime, manager and backup
 * peers; the `copy` snapshot driver (no btrfs); the database role is the harness superuser, not `whombat_backup`.
 */
export async function startBackup(state: EnvState, src: SourceState, log: Log): Promise<void> {
  const a = state.appliance;
  if (!a) throw new Error('backup: provision the appliance first');
  if (!running(state, 'restic')) throw new Error('backup: needs the restic rest-server');
  if (running(state, 'backup')) return;
  const bin = await goBuild(src, ['./cmd/...'], 'backup');
  const pgBin = await postgres17Bin(src, log);
  const restic = (await run('bash', ['-c', 'command -v restic'], { cwd: HARNESS_DIR })).stdout.trim();
  if (!restic) throw new Error('backup: restic is not installed');
  ensurePersistLayout(runtimeSecrets().masterKey);
  const dir = envPath('backup');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socket = join(paths.run, 'backup.sock');
  const uid = process.getuid?.() ?? -1;
  const config = join(dir, 'config.json');
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        applianceIdFile: join(a.identityDir, 'device.json'),
        persist: persistLayout().root,
        identityPublic: a.identityDir,
        runtimeSocket: a.adminSocket,
        driver: 'copy',
        apiSocket: socket,
        pgDsn: `host=127.0.0.1 port=${ports.postgres} user=${PG_USER} password=${PG_PASSWORD} dbname=${RUNTIME_DB} sslmode=disable`,
        pgBin,
        restic,
        reserveBytes: 64 * 1024 * 1024,
        runtimeUid: uid,
        managerUid: uid,
        backupUid: uid,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const cli = join(bin, 'whombat-backup');
  if (!existsSync(join(persistLayout().root, 'backup', 'destination.json'))) {
    const repo = `rest:http://127.0.0.1:${ports.restic}/${a.deviceId}/`;
    log(`backup: destination ${repo} (restic init)`);
    await must(cli, ['-config', config, 'destination', 'set', '-repository', repo, '-init'], {
      cwd: dir,
      logFile: logFile('backup'),
      timeoutMs: 120_000,
    });
  }
  const pid = spawnService(cli, ['-config', config, 'serve', '-socket', socket], {
    cwd: dir,
    logFile: logFile('backup'),
  });
  service(state, 'backup', {
    pid,
    log: logFile('backup'),
    status: 'running',
    command: `whombat-backup serve (${src.commit.slice(0, 12)})`,
  });
  state.backup = { socket, config, pgBin, cli };
  await waitFor(
    'backup API',
    async () => existsSync(socket) && (await unixJson(socket, 'GET', '/v1/status')).status === 200,
    { timeoutMs: 20_000, alive: () => alive(pid), hint: hint('backup') },
  );
  log(`backup: whombat-backup serve on ${socket} → rest-server ${ports.restic} (pg_dump 17 from ${pgBin})`);
}

/**
 * The stack's backup service for a contract migration's checkpoint (IN-424): available when it runs and has a
 * destination; the checkpoint is an offline one (`whombat-backup run -reason manual` with the service's config, no
 * runtime admin socket), since the runtime is stopped when `dev/up` migrates.
 */
export function stackBackup(state: EnvState): StackBackup {
  return {
    async missing() {
      const b = state.backup;
      if (!b || !running(state, 'backup')) return 'the stack runs no backup service';
      const st = await unixJson(b.socket, 'GET', '/v1/status').catch(() => null);
      if (st?.status !== 200) return `the backup service doesn't answer (${hint('backup')})`;
      const d = (st.body as { destination?: { configured?: boolean } }).destination;
      return d?.configured ? null : 'the backup service has no destination';
    },
    async take() {
      const b = state.backup;
      if (!b) throw new Error('backup: the stack runs no backup service');
      const src = state.sources['appliance-backup'];
      const cli =
        b.cli ??
        (src ? join(await goBuild(src, ['./cmd/...'], 'backup'), 'whombat-backup') : 'whombat-backup');
      const offline = envPath('backup', 'offline-config.json');
      writeFileSync(offline, offlineBackupConfig(readFileSync(b.config, 'utf8')), { mode: 0o600 });
      try {
        const r = await run(cli, ['-config', offline, 'run', '-reason', 'manual', '-json'], {
          cwd: dirname(b.config),
          logFile: logFile('backup'),
          timeoutMs: 1_800_000,
        });
        if (r.code !== 0)
          throw new Error(
            `backup: the checkpoint failed (whombat-backup run, exit ${r.code}): ${r.stderr.trim().slice(-400)}; ${hint('backup')}`,
          );
        return parseBackupRun(r.stdout);
      } finally {
        rmSync(offline, { force: true });
      }
    },
  };
}

/* hosts service ------------------------------------------------------------------------------------------ */

/** The architectures a monitored server may have: an agent for each (NX-152). */
export const HOSTS_AGENT_ARCHS = ['amd64', 'arm64'] as const;

/** Where the hosts service keeps its data and token (under the environment) and its API socket (`run/`). */
export const hostsPaths = () => ({
  data: envPath('hosts'),
  tokenFile: envPath('hosts', 'service-token'),
  socket: join(paths.run, 'hosts.sock'),
});

/**
 * The hosts service's arguments (Whombat ONE-11, NX-155): the box's (nix/modules/hosts.nix) with the environment's
 * paths and port. `WB_MGD_HOSTS_AGENT_HOST` binds the agents' listener to one address (default: every interface, as on a
 * box, so servers on this machine's LAN can be added); `--agent-url auto` puts this machine's LAN address in the
 * install command.
 */
export function hostsArgs(agentDist: string, agentPort: number = ports.hostsAgent): string[] {
  const p = hostsPaths();
  const host = process.env.WB_MGD_HOSTS_AGENT_HOST?.trim() ?? '';
  return [
    'serve',
    '--headless',
    '--data',
    p.data,
    '--listen',
    `unix:${p.socket}`,
    '--agent-listen',
    `${host.includes(':') ? `[${host}]` : host}:${agentPort}`,
    '--agent-url',
    'auto',
    '--agent-dist',
    agentDist,
    '--service-token-file',
    p.tokenFile,
  ];
}

/**
 * The hosts service (`whombat-hosts serve --headless`, NX-155) from the pinned whombat-hosts clone: the hub, and the
 * agents for amd64 and arm64 its install command hands out (unsigned, as on DEV boxes: no agent self-update). Before
 * the runtime, which gets its socket and token file only when it runs.
 */
export async function startHosts(state: EnvState, src: SourceState, log: Log): Promise<void> {
  if (running(state, 'hosts')) return;
  const tag = `${src.id}@${src.commit.slice(0, 12)}${src.dirty ? '-dirty' : ''}`;
  const ldflags = `-s -w -X main.version=0.0.0-dev.${src.commit.slice(0, 7)}`;
  const bin = await goBuild(src, ['./cmd/whombat-hosts'], '.', { ldflags });
  const agentDist = join(paths.bin, `${tag}-agents`);
  for (const goarch of HOSTS_AGENT_ARCHS)
    await goBuild(src, ['./cmd/whombat-agent'], '.', { ldflags, goarch, dir: `${tag}-agents` });
  const p = hostsPaths();
  mkdirSync(p.data, { recursive: true, mode: 0o700 });
  mkdirSync(paths.run, { recursive: true, mode: 0o700 });
  // A socket a killed hub left behind would refuse the new listener.
  rmSync(p.socket, { force: true });
  const pid = spawnService(join(bin, 'whombat-hosts'), hostsArgs(agentDist), {
    cwd: p.data,
    logFile: logFile('hosts'),
  });
  service(state, 'hosts', {
    pid,
    log: logFile('hosts'),
    status: 'running',
    command: `whombat-hosts serve --headless (${src.commit.slice(0, 12)})`,
    url: `wss://<this machine's LAN address>:${ports.hostsAgent}`,
  });
  state.hosts = {
    socket: p.socket,
    tokenFile: p.tokenFile,
    data: p.data,
    agentPort: ports.hostsAgent,
    agentDist,
  };
  await waitFor(
    'hosts service /healthz',
    async () =>
      existsSync(p.socket) &&
      existsSync(p.tokenFile) &&
      (await unixJson(p.socket, 'GET', '/healthz')).status === 200,
    { timeoutMs: 30_000, alive: () => alive(pid), hint: hint('hosts') },
  );
  log(
    `hosts: whombat-hosts on ${p.socket}, agents on :${ports.hostsAgent} (${HOSTS_AGENT_ARCHS.join(', ')})`,
  );
}

/* dev manager -------------------------------------------------------------------------------------------- */

/**
 * The real Go manager and update helper (appliance main, IN-15, IN-21): built from the pinned commit; a
 * development TUF repository (`tufrepo init --env local`) whose factory release describes the real runtime
 * (`releases.ts`) and which carries control's assignment public key (`add-assignment-key`, the contracts 0.5.0
 * AssignmentKeys document); served read-only on loopback. The helper runs as the developer with the **fake
 * activator** (a directory of profiles and a store) on its own socket; the runtime bridge turns the fake
 * activator's runtime restarts into restarts of the real runtime. The journal is provisioned with
 * `provision --factory-release`, the helper seeded with `seed-factory`.
 */
export async function startRealManager(
  state: EnvState,
  src: SourceState,
  runtimeSrc: SourceState,
  log: Log,
): Promise<void> {
  const a = state.appliance;
  if (!a || !state.control) throw new Error('manager: provision the appliance first');
  if (running(state, 'manager')) {
    // An environment started before IN-224, or whose refresher stopped: the repository is served, keep it fresh.
    if (running(state, 'tuf')) startTufRefresh(state, log);
    return;
  }
  const bin = await goBuild(src, ['./manager/cmd/...', './release-tools/cmd/...', './helper/cmd/...']);
  const dir = envPath('manager');
  const tuf = join(dir, 'tuf');
  const mlog = logFile('manager');
  const facts = runtimeFacts(runtimeSrc.path);
  if (!existsSync(join(tuf, 'metadata', '1.root.json'))) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await must(join(bin, 'tufrepo'), ['init', '--dir', tuf, '--env', 'local'], { cwd: dir, logFile: mlog });
    // The channel roles (Whombat LNK-23): the box takes the newest release its channel lists, as every box does. A
    // channel lists ordered ids only, so the box's first release gets one (kept for the next starts).
    await must(join(bin, 'tufrepo'), ['add-channels', '--dir', tuf], { cwd: dir, logFile: mlog });
    const first = nextReleaseId(tuf);
    await publishRelease(bin, tuf, { id: first, runtime: facts }, mlog);
    writeFileSync(join(dir, 'first-release'), `${first}\n`);
  }
  const releaseId = firstReleaseId(tuf, loadPins().tuple.releaseId);
  // Control's assignment public key, authorized by the (development) release custody through TUF.
  const keysMarker = join(dir, 'assignment-keys.imported');
  if (!existsSync(keysMarker)) {
    const doc = (await (await httpGet(`${state.control.url}/v1/assignment/keys`)).json()) as {
      keys: {
        kid: string;
        publicKey: string;
        state: string;
        notAfter?: number | null;
        notBefore?: number | null;
      }[];
    };
    for (const k of doc.keys) {
      const args = [
        'add-assignment-key',
        '--dir',
        tuf,
        '--kid',
        k.kid,
        '--public-hex',
        k.publicKey,
        '--state',
        k.state,
      ];
      if (k.notAfter) args.push('--not-after', String(k.notAfter));
      if (k.notBefore) args.push('--not-before', String(k.notBefore));
      await must(join(bin, 'tufrepo'), args, { cwd: dir, logFile: mlog });
    }
    writeFileSync(keysMarker, `${doc.keys.map((k) => k.kid).join('\n')}\n`);
    log(
      `manager: control's assignment key(s) ${doc.keys.map((k) => k.kid).join(', ')} published in the dev TUF repository`,
    );
  }
  // AI clients (MG-33, IN-37): the delegated clients role with a development key kept in the repository, and the
  // pinned channel key document for the manager. Only a manager source that installs clients gets them (an older
  // manager refuses unknown configuration).
  const managesClients = existsSync(join(src.path, 'manager', 'internal', 'clients'));
  const channelKeys = join(dir, 'client-channel-keys.json');
  if (managesClients) {
    if (!existsSync(join(tuf, 'keys', 'clients-0.json'))) {
      await must(join(bin, 'tufrepo'), ['add-clients-role', '--dir', tuf], { cwd: dir, logFile: mlog });
      log('manager: the clients role is delegated in the dev TUF repository (development key)');
    }
    await must(join(bin, 'tufrepo'), ['clients-keys', '--dir', tuf, '--out', channelKeys], {
      cwd: dir,
      logFile: mlog,
    });
    // A local environment with live agents gets the client channel the latest tested job last published (IN-107), so
    // scenario k runs in a fresh environment; the public dev instance has its own job and is never seeded.
    if ((state.agents ?? 'scripted') === 'live' && !publicUrls)
      await seedClientChannel(tuf, bin, dir, mlog, log);
  }
  const croot = managesClients ? clientsRoot() : null;
  const managesLicence = existsSync(join(src.path, 'manager', 'internal', 'licence'));
  if (managesClients && !croot)
    log(
      `manager: no AI client installs: ${join(persistLayout().root, 'whombat', 'clients')} has a dot-directory; set WB_MGD_CLIENTS_ROOT to a plain path`,
    );
  if (!running(state, 'tuf')) {
    // Private ISO links (PI-06) on updates-dev as on production's update server: with this key beside the repository
    // (never inside it: the server serves the repository) `/install/<version>/<file>` answers links signed with
    // `static-server.ts install-link`; without it `/install/` is 404 (dev-instance.md “A DEV ISO to download”).
    const installKey = join(dirname(tuf), 'install-link.key');
    const pid = spawnService(
      'node',
      [join(HARNESS_DIR, 'src/dev/static-server.ts'), tuf, String(ports.tuf)],
      {
        cwd: dir,
        logFile: logFile('tuf'),
        ...(existsSync(installKey) ? { env: { WHOMBAT_INSTALL_LINK_KEY_FILE: installKey } } : {}),
      },
    );
    service(state, 'tuf', {
      pid,
      url: `http://127.0.0.1:${ports.tuf}`,
      log: logFile('tuf'),
      status: 'running',
      command: 'static-server (dev TUF repository)',
    });
    await waitFor(
      'dev TUF server',
      async () => (await httpGet(`http://127.0.0.1:${ports.tuf}/metadata/timestamp.json`)).ok,
      {
        timeoutMs: 15_000,
        alive: () => alive(pid),
        hint: hint('tuf'),
      },
    );
  }
  startTufRefresh(state, log);
  const st = (p: string) => join(dir, 'state', p);
  const helperSocket = join(paths.run, 'helper.sock');
  const fakeRoot = join(dir, 'fake');
  const fakeDb = join(dir, 'fakedb');
  const config = join(dir, 'manager.json');
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        deviceFile: join(a.identityDir, 'device.json'),
        managementKey: join(a.identityDir, 'management.key'),
        // Below every release build's manager version (NX-105, IN-99); control keeps no manager floor (IN-420).
        managerVersion: devManagerVersion(src.commit),
        control: { url: managerControlUrl(state.control.url) },
        tuf: {
          pinnedRoot: join(tuf, 'metadata', '1.root.json'),
          metadataUrl: `http://127.0.0.1:${ports.tuf}/metadata`,
          targetsUrl: `http://127.0.0.1:${ports.tuf}/targets`,
          cacheDir: st('tuf-cache'),
          mirrorDir: st('tuf-mirror'),
        },
        stagingDir: st('staging'),
        journalDir: st('journal'),
        assignmentPath: st('assignment/current.json'),
        knownGoodDir: st('known-good'),
        helperSocket,
        apiSocket: a.managerSocket,
        runtime: { adminSocket: a.adminSocket, units: [] },
        // Pre-migration checkpoints through the backup service when dev/up runs it (IN-26).
        ...(state.backup && state.services.backup?.status === 'running'
          ? { backupSocket: state.backup.socket }
          : {}),
        ...(croot ? { clients: { root: croot, stateDir: st('clients'), channelKeys, checkSec: 60 } } : {}),
        // The licence (MG-34, IN-39): only for a manager source that renews it (an older one refuses unknown
        // configuration) and with a pinned key set.
        ...(managesLicence && state.licence
          ? { licence: { keysFile: state.licence.keysFile, stateFile: st('licence.json') } }
          : {}),
        // A fake tailscaled for the Tailscale way in (Whombat LNK-14); unset, the default path (none on this host).
        ...(process.env.WB_MGD_TAILSCALE_SOCKET
          ? { tailscaleSocket: process.env.WB_MGD_TAILSCALE_SOCKET }
          : {}),
        pollSec: 10,
        refreshSec: 20,
        // Development timings (IN-21): verification, health streak and idle steps in seconds, not minutes.
        policy: {
          healthIntervalMs: 2000,
          verifyTimeoutMs: 60_000,
          drainPollMs: 1000,
          retryBaseMs: 5000,
          idleIntervalMs: 2000,
          healthyStreak: 3,
          maxAttempts: 1,
        },
      },
      null,
      2,
    )}\n`,
  );
  const helperConfig = join(dir, 'helper.json');
  writeFileSync(
    helperConfig,
    `${JSON.stringify(
      {
        managerUser: String(process.getuid?.() ?? 0),
        deviceFile: join(a.identityDir, 'device.json'),
        pinnedRoot: join(tuf, 'metadata', '1.root.json'),
        mirrorDir: st('tuf-mirror'),
        stagingDir: st('staging'),
        assignmentPath: st('assignment/current.json'),
        networkCandidatesDir: st('network-candidates'),
        stateDir: join(dir, 'helper-state'),
        // The channel the box follows until its owner changes it (a repository from before channels has none).
        ...(hasChannels(tuf) ? { defaultChannel: DEV_CHANNEL } : {}),
        idleTimeoutSec: 0,
        activator: 'fake',
        fakeRoot,
        fakeDbDir: fakeDb,
      },
      null,
      2,
    )}\n`,
  );
  // A first start goes as on a box: the helper answers before the manager records its factory release (provisioning
  // asks it which update channel it keeps, and stops when it doesn't answer), and the helper is seeded afterwards,
  // from the update repository's files the manager's provisioning fetched for it.
  const firstStart = !existsSync(st('journal'));
  if (firstStart) {
    mkdirSync(join(dir, 'state'), { recursive: true, mode: 0o700 });
    seedFakeActivator(fakeRoot, fakeDb, readTuple(tuf, releaseId), tuf, facts.schema.writes);
  }
  if (!running(state, 'helper')) {
    const pid = spawnService(
      join(bin, 'whombat-update-helper'),
      ['--config', helperConfig, '--listen', helperSocket],
      {
        cwd: dir,
        logFile: logFile('helper'),
      },
    );
    service(state, 'helper', {
      pid,
      log: logFile('helper'),
      status: 'running',
      command: 'whombat-update-helper (fake activator)',
      cwd: dir,
    });
    await waitFor('update helper socket', async () => existsSync(helperSocket), {
      timeoutMs: 15_000,
      alive: () => alive(pid),
      hint: hint('helper'),
    });
  }
  if (firstStart) {
    await must(
      join(bin, 'whombat-manager'),
      ['--config', config, 'provision', '--factory-release', releaseId],
      { cwd: dir, logFile: mlog },
    );
    await must(join(bin, 'whombat-update-helper'), ['--config', helperConfig, 'seed-factory', releaseId], {
      cwd: dir,
      logFile: logFile('helper'),
    });
  }
  // The own address of the stack's own appliance: off unless WB_MGD_OWN_ADDRESS says otherwise (MG-161, plan D3).
  const own = ownAddressManagerEnv(process.env);
  const pid = spawnService(join(bin, 'whombat-manager'), ['--config', config], {
    cwd: dir,
    logFile: mlog,
    env: { ...own, ...linkManagerEnv(dir) },
  });
  service(state, 'manager', {
    pid,
    log: mlog,
    status: 'running',
    command: `WHOMBAT_OWN_ADDRESS=${own.WHOMBAT_OWN_ADDRESS} whombat-manager --config ${config}`,
    cwd: dir,
  });
  state.manager = {
    kind: 'real',
    note: `whombat-manager + whombat-update-helper ${src.commit.slice(0, 12)} (fake activator bridged to the real runtime), development TUF repository with control's assignment key; factory release ${releaseId}`,
  };
  await waitFor('manager socket', async () => existsSync(a.managerSocket), {
    timeoutMs: 20_000,
    alive: () => alive(pid),
    hint: hint('manager'),
  });
  const t = await unixJson(a.managerSocket, 'POST', '/v1/runtime/ticket', { class: 'interactive' });
  // A box whose Whombat Link isn't running has no tickets (Whombat LNK-03, MG-171: 404 `unavailable`): a fresh box
  // (WB_MGD_PROVISION=local) until the owner confirms its code, or after Link off.
  const linkOff =
    t.status === 404 && (t.body as { error?: { code?: string } })?.error?.code === 'unavailable';
  if (t.status !== 200 && !linkOff)
    throw new Error(`manager: ticket.issue failed: ${JSON.stringify(t.body)}; ${hint('manager')}`);
  if (!running(state, 'bridge')) {
    const bpid = spawnService('node', [join(HARNESS_DIR, 'src/dev/runtime-bridge.ts'), fakeRoot], {
      cwd: HARNESS_DIR,
      logFile: logFile('bridge'),
      env: process.env.WB_MGD_PINS ? { WB_MGD_PINS: process.env.WB_MGD_PINS } : {},
    });
    service(state, 'bridge', {
      pid: bpid,
      log: logFile('bridge'),
      status: 'running',
      command: 'runtime-bridge (fake activator → real runtime)',
    });
  }
  log(
    `manager: whombat-manager + update helper (fake activator) on ${a.managerSocket} (appliance ticket from control: ${linkOff ? 'none, Whombat Link is not on' : 'ok'})`,
  );
}

/**
 * Whombat Link on the stack's own appliance (LNK-12, LNK-13; MG-170…MG-175). The manager reads the owner's reach
 * choice from `WHOMBAT_REACH_FILE` (on a box the installer writes `/persist/whombat/reach.json`) and no environment
 * file (`WHOMBAT_ENVIRONMENT_DIR` names a folder that has none, so its configuration's control URL stands for it).
 * The installer's choice is written once, before the manager's first start: Whombat Link unless `WB_MGD_REACH` says
 * `tailscale`, `both` or `none` (no choice was made: the box talks to nobody until its owner turns a way in on). The
 * Tailscale socket is `WB_MGD_TAILSCALE_SOCKET` (a fake tailscaled) or none.
 */
export function linkManagerEnv(dir: string): Record<string, string> {
  const reachFile = join(persistLayout().root, 'whombat', 'reach.json');
  const asked = process.env.WB_MGD_REACH?.trim() || 'link';
  if (!['link', 'tailscale', 'both', 'none'].includes(asked))
    throw new Error(`WB_MGD_REACH must be link, tailscale, both or none, not ${asked}`);
  const want = asked === 'none' ? null : asked;
  if (want && !existsSync(reachFile)) {
    mkdirSync(dirname(reachFile), { recursive: true });
    writeFileSync(
      reachFile,
      `${JSON.stringify({
        v: 1,
        seq: 1,
        link: want === 'link' || want === 'both',
        tailscale: want === 'tailscale' || want === 'both',
        ...(process.env.WB_MGD_TAILSCALE_LOGIN_SERVER
          ? { loginServer: process.env.WB_MGD_TAILSCALE_LOGIN_SERVER }
          : {}),
        by: 'installer',
        at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      })}\n`,
      { mode: 0o644 },
    );
  }
  return {
    WHOMBAT_REACH_FILE: reachFile,
    WHOMBAT_ENVIRONMENT_DIR: join(dir, 'no-environment'),
  };
}

/**
 * The dev TUF repository's timestamp lives 24 h (as production's): `tuf-refresh.ts` re-signs it with `tufrepo refresh`
 * whenever it is 6 h old, as production's timer does (IN-224). It runs while the repository exists, whichever manager
 * runs, and outlives manager restarts; `dev/down` stops it.
 */
export function startTufRefresh(state: EnvState, log: Log): void {
  const dir = envPath('manager');
  const tuf = join(dir, 'tuf');
  if (running(state, 'tuf-refresh') || !existsSync(join(tuf, 'metadata', 'root.json'))) return;
  const pid = spawnService('node', [join(HARNESS_DIR, 'src/dev/tuf-refresh.ts'), tuf], {
    cwd: dir,
    logFile: logFile('tuf-refresh'),
  });
  service(state, 'tuf-refresh', {
    pid,
    log: logFile('tuf-refresh'),
    status: 'running',
    command: 'tuf-refresh.ts (tufrepo refresh when the timestamp is 6 h old)',
    cwd: dir,
  });
  log(
    `manager: the dev TUF timestamp is re-signed every 6 h (tuf-refresh, pid ${pid}; dev/logs tuf-refresh)`,
  );
}

/** The fake activator's layout for a factory-installed device (like `activator.NewFake(root, booted)`). */
function seedFakeActivator(root: string, db: string, tuple: ReleaseTuple, tuf: string, schema: number): void {
  for (const d of ['store', 'profiles', 'network']) mkdirSync(join(root, d), { recursive: true });
  mkdirSync(db, { recursive: true });
  writeFileSync(join(db, 'schema'), String(schema));
  const base = (p: string) => p.split('/').pop() ?? p;
  const art = join(tuf, '..', 'artifacts');
  copyFileSync(join(art, 'host.json'), join(root, 'store', base(tuple.host.storePath)));
  copyFileSync(
    join(art, `${tuple.releaseId}.runtime.json`),
    join(root, 'store', base(tuple.runtime.storePath)),
  );
  const link = (rel: string, target: string) => {
    if (!existsSync(join(root, rel))) symlinkSync(target, join(root, rel));
  };
  link('current-system', tuple.host.storePath);
  link('profiles/system', tuple.host.storePath);
  link('profiles/whombat-runtime', tuple.runtime.storePath);
  writeFileSync(join(root, 'boot-good'), tuple.host.storePath);
  writeFileSync(join(root, 'boot_id'), 'boot-1\n');
}

/**
 * The latest tested client bundle (IN-107): Claude Code's newest version the latest tested job passed on this
 * architecture (`markers/<provider>-<version>-<arch>.ok`, docs/runbooks/client-latest-tested.md) whose bundle and
 * artifact are still there; Codex's are left out (IN-432). `WB_MGD_CLIENT_BUNDLES` names the job's bundles directory
 * (default its state directory's).
 */
export function testedClientBundles(
  bundlesDir: string,
  arch: string,
): { provider: string; version: string; file: string }[] {
  if (!existsSync(bundlesDir)) return [];
  const markers = join(bundlesDir, '..', 'markers');
  const best = new Map<string, { provider: string; version: string; file: string }>();
  for (const f of readdirSync(bundlesDir)) {
    const m = /^([a-z]+)-(\d+(?:\.\d+)*)-([a-z0-9_]+)\.json$/.exec(f);
    if (!m?.[1] || !m[2] || m[3] !== arch) continue;
    // Claude Code only: Codex bundles an older job run left here are no longer offered (IN-432).
    if (m[1] !== 'claude') continue;
    if (!existsSync(join(markers, `${m[1]}-${m[2]}-${arch}.ok`))) continue;
    const file = join(bundlesDir, f);
    const art = (JSON.parse(readFileSync(file, 'utf8')) as { ArtifactFile?: string }).ArtifactFile;
    if (!art || !existsSync(art)) continue;
    const cur = best.get(m[1]);
    const newer = (a: string, b: string) => {
      const x = a.split('.').map(Number);
      const y = b.split('.').map(Number);
      for (let i = 0; i < Math.max(x.length, y.length); i++)
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
      return false;
    };
    if (!cur || newer(m[2], cur.version)) best.set(m[1], { provider: m[1], version: m[2], file });
  }
  return [...best.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

async function seedClientChannel(
  tuf: string,
  bin: string,
  dir: string,
  mlog: string,
  log: Log,
): Promise<void> {
  const cc = join(bin, 'clientchannel');
  if (!existsSync(cc)) return;
  if ((await run(cc, ['show', '--repo', tuf], { cwd: dir, logFile: mlog })).code === 0) return; // a channel exists
  const bundles = testedClientBundles(
    process.env.WB_MGD_CLIENT_BUNDLES ?? join(homedir(), '.local', 'state', 'whombat-clients', 'bundles'),
    process.arch === 'arm64' ? 'aarch64' : 'x86_64',
  );
  if (!bundles.length) {
    log(
      'manager: no tested client bundles here (the latest tested job, docs/runbooks/client-latest-tested.md): live agents have nothing to install, scenario k is blocked',
    );
    return;
  }
  await must(cc, ['publish', '--repo', tuf, ...bundles.flatMap((b) => ['--bundle', b.file])], {
    cwd: dir,
    logFile: mlog,
  });
  log(
    `manager: the client channel offers the latest tested ${bundles.map((b) => `${b.provider} ${b.version}`).join(', ')} (the latest tested job's bundles, IN-107)`,
  );
}

export async function startManager(state: EnvState, log: Log): Promise<void> {
  const a = state.appliance;
  if (!a || !state.control) throw new Error('manager: provision the appliance first');
  if (running(state, 'manager')) return;
  const config = envPath('appliance', 'dev-manager.json');
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        controlUrl: managerControlUrl(state.control.url),
        deviceFile: join(a.identityDir, 'device.json'),
        managementKey: join(a.identityDir, 'management.key'),
        socket: a.managerSocket,
        adminSocket: a.adminSocket,
        env: 'local',
        statusFile: envPath('appliance', 'dev-manager.status.json'),
        ...(state.licence
          ? {
              licenceKeysFile: state.licence.keysFile,
              licenceStateFile: envPath('appliance', 'dev-manager.licence.json'),
            }
          : {}),
      },
      null,
      2,
    )}\n`,
  );
  const script = join(HARNESS_DIR, 'src/dev/dev-manager.ts');
  const pid = spawnService('node', [script, '--config', config], {
    cwd: HARNESS_DIR,
    logFile: logFile('manager'),
  });
  service(state, 'manager', { pid, log: logFile('manager'), status: 'running', command: `node ${script}` });
  state.manager = {
    kind: 'standin',
    note: 'dev manager stand-in (harness/src/dev/dev-manager.ts): local IPC manager socket + device-signed control calls; no update engine (IN-09)',
  };
  await waitFor('dev manager socket', async () => existsSync(a.managerSocket), {
    timeoutMs: 15_000,
    alive: () => alive(pid),
    hint: hint('manager'),
  });
  // One real round trip: an appliance ticket from control through the manager socket.
  const t = await unixJson(a.managerSocket, 'POST', '/v1/runtime/ticket', { class: 'interactive' });
  if (t.status !== 200)
    throw new Error(`dev manager: ticket.issue failed: ${JSON.stringify(t.body)}; ${hint('manager')}`);
  log(`manager: stand-in on ${a.managerSocket} (appliance ticket from control: ok)`);
}

export async function unixJson(
  socketPath: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: data
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
          : {},
        timeout: 15_000,
      },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => {
          text += c.toString();
        });
        res.on('end', () => {
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // keep text
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

/* runtime + runner ------------------------------------------------------------------------------------- */

export const RUNTIME_DB = 'whombat_runtime';

function runtimeSecrets(): { runnerToken: string; masterKey: string } {
  const file = envPath('runtime', 'secrets.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const v = {
    runnerToken: randomBytes(32).toString('base64url'),
    masterKey: randomBytes(32).toString('base64'),
  };
  writeSecret(file, JSON.stringify(v));
  return v;
}

/** What the runtime bridge asked for (the activated release; `broken` for a bad candidate), IN-21. */
export interface RuntimeOverrides {
  releaseId: string | null;
  broken: boolean;
  /** A test-only fixture build to run instead of the pinned checkout (IN-25). */
  runtimeDir?: string | null;
  /** The checkpoint the helper migrated with (`whombat migrate --checkpoint`). */
  checkpoint?: string | null;
}

export function runtimeOverrides(): RuntimeOverrides {
  const f = envPath('runtime', 'overrides.json');
  if (!existsSync(f)) return { releaseId: null, broken: false };
  return JSON.parse(readFileSync(f, 'utf8'));
}

/**
 * How the environment's agents run: what `dev/up` recorded from `WB_MGD_AGENTS` (IN-38), so a restart (scenarios, the
 * runtime bridge) keeps it whatever its own environment says; environments from before IN-38 are scripted.
 */
export function agentsOf(state: EnvState): AgentsMode {
  return state.agents ?? 'scripted';
}

/**
 * Whether a runtime source files website feedback through the encrypted drop (Whombat FD-25, FD-31): it reads
 * `WHOMBAT_EMBED_URL`. An older managed runtime refuses intake whatever `WHOMBAT_FEEDBACK` says; it keeps `off`.
 */
export function runtimeHasFeedbackDrop(runtimePath: string | undefined): boolean {
  if (!runtimePath) return false;
  const cfg = join(runtimePath, 'apps/server/src/config.ts');
  return existsSync(cfg) && readFileSync(cfg, 'utf8').includes('WHOMBAT_EMBED_URL');
}

/**
 * The runtime's direct listener (Whombat HE-50; the runtime side is stream R2's): the same Noise XX session and frames
 * as through the relay, admitted by the box from an enrolled device's key. The dev stack opens it on loopback only, on a
 * port of its own range (`WB_MGD_DIRECT_PORT`, 4621 by default; shifted with the others for the live and isolated
 * environments). A box opens 4480 on `lan,tailscale0` (the image's settings).
 */
export function directListenerEnv(): { WHOMBAT_DIRECT_PORT: string; WHOMBAT_DIRECT_INTERFACES: string } {
  // `WB_MGD_DIRECT_INTERFACES` adds ways in (a test bridge as the local network, e.g. `loopback,br-1234abcd`): only
  // loopback otherwise, so the dev runtime never answers this host's real network.
  return {
    WHOMBAT_DIRECT_PORT: String(ports.direct),
    WHOMBAT_DIRECT_INTERFACES: process.env.WB_MGD_DIRECT_INTERFACES?.trim() || 'loopback',
  };
}

export function runtimeEnv(state: EnvState): Record<string, string> {
  const a = state.appliance;
  if (!a) throw new Error('runtime: provision the appliance first');
  const { runnerToken, masterKey } = runtimeSecrets();
  const home = persistLayout().home;
  ensurePersistLayout(masterKey);
  const croot = clientsRoot();
  const drop = runtimeHasFeedbackDrop(state.sources['whombat-runtime']?.path);
  const embed = embedOrigin();
  return {
    NODE_ENV: 'development',
    WHOMBAT_MODE: 'managed',
    // Required by a managed server (runtime MR-45): links point at the hosted UI, here the harness's web app
    // (http is accepted on loopback outside production).
    WHOMBAT_APP_URL: publicUrls?.web ?? `http://localhost:${ports.web}`,
    HOST: '127.0.0.1',
    PORT: String(ports.runtime),
    ...directListenerEnv(),
    DATABASE_URL: pgUrl(RUNTIME_DB),
    WHOMBAT_MASTER_KEY: masterKey,
    RUNNER_TOKEN: runnerToken,
    WHOMBAT_HOME: home,
    WHOMBAT_CREDENTIALS_ROOT: persistLayout().credentials,
    WHOMBAT_MANAGER_SOCKET: a.managerSocket,
    // The manager's ACME socket beside its API socket (MG-163); on a box the default path.
    WHOMBAT_MANAGER_ACME_SOCKET: join(dirname(a.managerSocket), 'acme.sock'),
    WHOMBAT_ADMIN_SOCKET: a.adminSocket,
    WHOMBAT_CONTENT_KEY_FILE: join(a.identityDir, 'content.key'),
    // The box's public record (Whombat LNK-01): whether control registered it, and what `link.on` signs.
    WHOMBAT_DEVICE_FILE: join(a.identityDir, 'device.json'),
    WHOMBAT_CLAIM_FILE: a.claimFile,
    // The console state (CC-08): on the appliance tty1 draws it, here `dev/console` does (IN-33).
    WHOMBAT_CONSOLE_FILE: paths.console,
    // The manager's AI client status as the server keeps it for the runner (Whombat SUB-25, NX-37, IN-37).
    WHOMBAT_CLIENTS_FILE: join(paths.run, 'clients.json'),
    // Where the manager installs them: the runner runs a client only from inside it (Whombat SUB-45, compared by
    // realpath, so the plain-path link works). Unset without a clients root: every bundle is refused.
    ...(croot ? { WHOMBAT_CLIENTS_ROOT: croot } : {}),
    // Runtime ≥ managed/hardening: the runner's sign-in routes on a unix socket (PV-12, MR-34).
    WHOMBAT_SIGNIN_SOCKET: join(paths.run, 'signin.sock'),
    WHOMBAT_RELEASE_ID:
      runtimeOverrides().releaseId ?? firstReleaseId(envPath('manager', 'tuf'), loadPins().tuple.releaseId),
    // Scripted (IN-404, Whombat HE-46): the scripted Hermes runs a turn without a CLI or a sign-in only where the server
    // allows it; never in live mode, never on a box.
    ...(agentsOf(state) === 'scripted' ? { WHOMBAT_ALLOW_SCRIPTED: '1' } : {}),
    // Small event retention so scenario (d) can reach the floor (IN-14).
    WHOMBAT_SESSION_EVENTS_MAX_COUNT: '200',
    // GitHub (IN-137): off for the scripted environments; `WB_MGD_GITHUB=real` (the public dev instance) reaches the real
    // GitHub the way a box does, through each person's own sign-in (Whombat EA-10, PV-06).
    WHOMBAT_GITHUB: process.env.WB_MGD_GITHUB?.trim() === 'real' ? 'gh' : 'off',
    // Website feedback (IN-54): `on` in managed mode is the encrypted drop (FD-25): no public route on the runtime,
    // cards and drops through the manager and control; the snippet base and the only accepted drop Origin is the
    // embed origin. Older runtimes keep `off`.
    WHOMBAT_FEEDBACK: drop ? 'on' : 'off',
    ...(drop && embed ? { WHOMBAT_EMBED_URL: embed } : {}),
    // Google (IN-49): unset is the runtime's default (real Google, each Whombat's own OAuth client, AG-14); `fake`
    // completes connect without Google for the scenarios (runtime MR-64).
    ...(state.google ? { WHOMBAT_GOOGLE: state.google } : {}),
    // The backup service's local API when dev/up runs it (IN-26): backup ops and manual checkpoints.
    ...(state.backup && state.services.backup?.status === 'running'
      ? { WHOMBAT_BACKUP_SOCKET: state.backup.socket }
      : {}),
    // The desk display (Whombat desk-display.md DK-12), opt-in: `WB_MGD_DESK=1` opens the desk socket beside the console
    // file, and `WB_MGD_VOICE=fake` gives Talk the runtime's fake voice (fixed transcripts, a tone as speech; refused in
    // production). Off by default: the dev stack has no screen to pair. `WB_MGD_BLUETOOTH=fake` gives Settings and
    // the desk the runtime's fake Bluetooth (an adapter, paired and found devices, pairings on a short clock; refused in
    // production, NX-363).
    ...(process.env.WB_MGD_DESK?.trim() === '1' ? { WHOMBAT_DESK_SOCKET: join(paths.run, 'desk.sock') } : {}),
    ...(process.env.WB_MGD_VOICE?.trim() === 'fake' ? { WHOMBAT_VOICE: 'fake' } : {}),
    ...(process.env.WB_MGD_BLUETOOTH?.trim() === 'fake' ? { WHOMBAT_BLUETOOTH: 'fake' } : {}),
    // The hosts service when dev/up runs it (NX-155): its API socket and the service token (as on a box, hosts.nix).
    ...(state.hosts && state.services.hosts?.status === 'running'
      ? { WHOMBAT_HOSTS_SOCKET: state.hosts.socket, WHOMBAT_HOSTS_TOKEN_FILE: state.hosts.tokenFile }
      : {}),
    // The ports a public SSH server may use (Whombat VT-S06, VT-S14; IN-150): the appliance's default
    // `whombat.vault.sshPorts` (vault-wall.nix). No firewall here; older runtimes ignore it.
    WHOMBAT_VAULT_SSH_PORTS: '22',
    // The local network (Whombat LN-04, NX-144): open on a box, closed here (no appliance firewall around this host's
    // LAN; scenarios p and r check the home network list's rules). `WB_MGD_LOCAL_NETWORK=auto|on` opens it. Older
    // runtimes ignore it.
    WHOMBAT_LOCAL_NETWORK: process.env.WB_MGD_LOCAL_NETWORK?.trim() || 'off',
    // No PUBLIC_URL: a managed runtime has no public origin (MR-04), and the appliance sets none (runtime.nix).
    LOG_LEVEL: 'info',
    // The pinned licence key set and the dev overrides (IN-39; required by a managed runtime ≥ MR-55).
    ...licenceRuntimeEnv(state),
  };
}

/** The box page needs only its source, so it can build while control and the other services start. */
export async function buildRuntimeWeb(src: SourceState, log: Log): Promise<void> {
  const root = runtimeOverrides().runtimeDir ?? src.path;
  if (!existsSync(join(root, 'apps/web/package.json'))) return;
  const build = await run('pnpm', ['--filter', '@whombat/web', 'build:prod'], {
    cwd: root,
    env: { VITE_FIXTURES: '', VITE_WHOMBAT_TARGET: 'box' },
    logFile: logFile('runtime-app'),
    timeoutMs: 600_000,
  });
  if (build.code !== 0) log(`runtime: the box's page didn't build (${hint('runtime-app')}); no box page`);
}

export async function startRuntime(
  state: EnvState,
  src: SourceState,
  log: Log,
  preparedPage?: Promise<void>,
): Promise<void> {
  const url = `http://127.0.0.1:${ports.runtime}`;
  state.runtime = {
    url,
    databaseUrl: pgUrl(RUNTIME_DB),
    home: persistLayout().home,
    direct: `127.0.0.1:${ports.direct}`,
  };
  if (running(state, 'runtime')) return;
  const a = state.appliance;
  if (!a) throw new Error('runtime: provision the appliance first');
  await ensureDatabase(RUNTIME_DB);
  const env = runtimeEnv(state);
  const ov = runtimeOverrides();
  const root = ov.runtimeDir ?? src.path;
  // The box's own page for direct browsers (Whombat HE-50): the runtime serves its checkout's apps/web/dist, built here
  // since the app moved into Whombat; before that, `.whombat-app/web`, the pinned whombat-app artifact unpacked
  // (IN-428). Without it the direct listener answers that it has no web app.
  if (existsSync(join(root, 'apps/web/package.json'))) {
    await (preparedPage ?? buildRuntimeWeb(src, log));
  } else if (existsSync(join(root, 'apps/cli/src/app-artifact-cli.ts'))) {
    const unpack = await run('node', ['--import', 'tsx', 'apps/cli/src/app-artifact-cli.ts'], {
      cwd: root,
      env,
      logFile: logFile('runtime-app'),
      timeoutMs: 120_000,
    });
    if (unpack.code !== 0)
      log(`runtime: the whombat-app artifact didn't unpack (${hint('runtime-app')}); no box page`);
  }
  // A managed boot only validates the schema; the CLI is the single migration authority (MD-02).
  log(
    `runtime: migrating (whombat migrate --json --env${ov.checkpoint ? ' --checkpoint …' : ''}, the migration authority)${ov.runtimeDir ? ` [fixture ${ov.runtimeDir}]` : ''}`,
  );
  // A contract migration needs a checkpoint first (MD-06): with none given, the stack's backup service takes one
  // while the runtime is stopped (IN-424).
  await migrateRuntime({
    given: ov.checkpoint ?? null,
    migrate: (checkpoint) =>
      run(
        'node',
        [
          '--import',
          'tsx',
          'apps/cli/src/bin.ts',
          'migrate',
          '--json',
          '--env',
          ...(checkpoint ? ['--checkpoint', checkpoint] : []),
        ],
        { cwd: root, env, logFile: logFile('runtime-migrate'), timeoutMs: 300_000 },
      ),
    backup: stackBackup(state),
    log,
    hint: hint('runtime-migrate'),
  });
  if (ov.broken) {
    // A bad candidate (IN-21): migrated like any release, then it can't start (no content identity), so it never
    // becomes healthy.
    const pid = spawnService('pnpm', ['exec', 'tsx', 'src/index.ts'], {
      cwd: join(root, 'apps/server'),
      env: { ...env, WHOMBAT_CONTENT_KEY_FILE: envPath('runtime', 'no-such-content.key') },
      logFile: logFile('runtime'),
    });
    service(state, 'runtime', {
      pid,
      url,
      log: logFile('runtime'),
      status: 'failed',
      note: 'bad candidate (runtime bridge)',
      command: 'tsx src/index.ts (bad candidate)',
    });
    throw new Error('runtime: started as a bad candidate (no content identity); it will not become healthy');
  }
  const server = join(root, 'apps/server');
  const pid = spawnService('pnpm', ['exec', 'tsx', 'src/index.ts'], {
    cwd: server,
    env: { ...hostLoginsUnset(), ...env },
    logFile: logFile('runtime'),
  });
  const s = service(state, 'runtime', {
    pid,
    url,
    log: logFile('runtime'),
    status: 'running',
    command: 'tsx src/index.ts (WHOMBAT_MODE=managed)',
    cwd: server,
  });
  // Managed: the loopback listener serves only the runner protocol and MCP; health is the admin socket's.
  let last: unknown = null;
  await waitFor(
    'runtime admin socket /health',
    async () => {
      if (!existsSync(a.adminSocket)) return null;
      const h = await unixJson(a.adminSocket, 'GET', '/health');
      last = h.body;
      return h.status === 200;
    },
    { timeoutMs: 120_000, alive: () => alive(pid), hint: hint('runtime') },
  ).catch((e) => {
    s.status = 'failed';
    throw new Error(`${e instanceof Error ? e.message : String(e)}; last /health: ${JSON.stringify(last)}`);
  });
  log(`runtime: managed mode (admin socket healthy; loopback ${url} serves the runner only)`);
}

/** Byte length of a log file now (to look only at what a new process writes). */
function logOffset(name: string): number {
  const f = logFile(name);
  return existsSync(f) ? readFileSync(f).length : 0;
}

/**
 * Hosts the Claude sign-in console needs from the runner (Whombat SUB-20), as the appliance adds them to the runner's
 * egress allowlist (`whombat.clients.signInHosts`, nix/modules/providers.nix). The providers' own API and sign-in hosts
 * (`*.anthropic.com`, `claude.ai`, `*.claude.com`, `*.openai.com`, `chatgpt.com`) are the sandbox's built-in list.
 */
export const SIGN_IN_HOSTS = [
  'claude.ai',
  'console.anthropic.com',
  'platform.claude.com',
  'api.anthropic.com',
] as const;

/**
 * The runner's managed sandbox on a development host (IN-38), for every turn since Hermes runs them all (Whombat
 * HE-S44; IN-403): the appliance's settings (nix/modules/sandbox.nix, providers.nix) with
 * the development differences Whombat supports (MS-16): task cgroups from a delegated `systemd --user` scope instead
 * of the unit's own delegation, in a slice of this environment's own (a runner sweeps every other generation's scope in
 * its slice at start, MS-09: two environments must never share one), the host's bubblewrap. No per-task uids: the
 * sandbox maps the runner's uid (MS-03).
 */
export function runnerSandboxEnv(): Record<string, string> {
  const l = persistLayout();
  const slice = `whombat_mgd_${createHash('sha256').update(paths.home).digest('hex').slice(0, 10)}.slice`;
  const clients = clientsRoot();
  const real = join(l.root, 'whombat', 'clients');
  const extra = (process.env.WB_MGD_EGRESS_ALLOW ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return {
    WHOMBAT_SANDBOX_CGROUP: 'systemd-user',
    WHOMBAT_SANDBOX_SLICE: slice,
    // Beside the persist root, not in it: a pod's sockets live under it (`sandbox/g1-pod_<32 hex>/net/proxy.sock`), and
    // a Unix socket's path has at most 107 bytes, which the environment's longer root overran (`listen EINVAL`). A box's
    // is `/persist/whombat/runner`.
    WHOMBAT_RUNNER_STATE: envPath('runner'),
    WHOMBAT_WORKSPACES: l.workspaces,
    // The installed clients, read-only in every task (Codex needs its codex-resources next to bin/).
    WHOMBAT_SANDBOX_RO_PATHS: [...new Set([real, ...(clients ? [clients] : [])])].join(':'),
    WHOMBAT_SANDBOX_EGRESS_ALLOW: [...new Set([...SIGN_IN_HOSTS, ...extra])].join(','),
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

/**
 * The developer's own provider logins, unset for the runtime and the runner (IN-38): an appliance has none, and a
 * session started from a shell inside Claude Code or Codex carries tokens (`ANTHROPIC_AUTH_TOKEN`, …) that must never
 * reach them, even though the sandbox and the sign-in executor filter their environments too (MS-18, SUB-20).
 */
export function hostLoginsUnset(env: NodeJS.ProcessEnv = process.env): Record<string, undefined> {
  const out: Record<string, undefined> = {};
  for (const k of Object.keys(env))
    if (/^(ANTHROPIC_|OPENAI_|CLAUDE_|CLAUDECODE$|CODEX_|AWS_BEARER_TOKEN_BEDROCK$)/.test(k))
      out[k] = undefined;
  return out;
}

/**
 * What the runner said at start (IN-38, IN-403): Hermes's and the CLIs' checks, the managed sandbox and Hermes's paths; ready once it prints its connection line (`<runner id> → <server> · up to n turns`), after all of them.
 */
export function runnerSummary(text: string): { ready: boolean; lines: string[] } {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\[runner\]\s*/, '').trim())
    .filter((l) =>
      /^provider (hermes|claude|codex): |^managed · (generation|sandbox)|^hermes · |^\S+ → http/.test(l),
    );
  return { ready: lines.some((l) => /^\S+ → http/.test(l)), lines };
}

/** What the runner's start says is wrong, as dev/up reports it (IN-403). */
export function runnerProblems(lines: readonly string[]): string[] {
  const out: string[] = [];
  if (lines.some((l) => /^managed · sandbox unavailable/.test(l)))
    out.push('the managed sandbox is unavailable: every turn is refused');
  const hermes = lines.find((l) => /^provider hermes: not ready/.test(l));
  if (hermes) out.push(`Hermes isn’t ready, so no turn runs (${hermes.replace(/^provider hermes: /, '')})`);
  return out;
}

/* The commands' network (Whombat one-person.md OP-07) ------------------------------------------------------- */

/** The commands' network daemon's socket, which the runner reaches (`WHOMBAT_AGENT_NET_SOCKET`). */
export function agentNetSocket(): string {
  return join(paths.run, 'agent-net.sock');
}

/** The ports the agent's services may publish (Whombat one-person.md OP-19), which the daemon lets commands reach. */
export const AGENT_SERVICE_PORTS = '20000-20099';

/**
 * The runtime checkout's commands' network daemon (`apps/agent-net`, Whombat stream R2: the proxy with the network
 * rules every command's wrapper goes through, a box's `whombat-agent-net` unit), or null when the checkout has none.
 */
export function agentNetDir(runtimePath: string): string | null {
  const dir = join(runtimePath, 'apps', 'agent-net');
  return existsSync(join(dir, 'package.json')) ? dir : null;
}

export function agentNetEnv(): Record<string, string> {
  return {
    WHOMBAT_AGENT_NET_SOCKET: agentNetSocket(),
    WHOMBAT_AGENT_NET_SERVICE_PORTS: AGENT_SERVICE_PORTS,
    LOG_LEVEL: 'info',
  };
}

/**
 * The commands' network daemon, before the runner, which reaches its socket. A runtime checkout without it starts
 * nothing (the service is `skipped`, the runner gets no socket). No container engine: `WHOMBAT_CONTAINERS_SOCKET` stays
 * unset, so the runtime says Docker and the agent's services aren't available here.
 */
export async function startAgentNet(state: EnvState, src: SourceState, log: Log): Promise<void> {
  if (running(state, 'agent-net')) return;
  const dir = agentNetDir(src.path);
  if (!dir) {
    service(state, 'agent-net', {
      pid: null,
      log: '',
      status: 'skipped',
      note: 'the runtime has no apps/agent-net',
    });
    delete state.agentNet;
    log(
      'agent-net: the runtime checkout has no apps/agent-net, so nothing starts and the runner gets no socket',
    );
    return;
  }
  const env = agentNetEnv();
  const socket = agentNetSocket();
  rmSync(socket, { force: true });
  const pid = spawnService('pnpm', ['exec', 'tsx', 'src/index.ts'], {
    cwd: dir,
    env: { ...hostLoginsUnset(), ...env },
    logFile: logFile('agent-net'),
  });
  service(state, 'agent-net', {
    pid,
    log: logFile('agent-net'),
    status: 'running',
    command: 'tsx src/index.ts',
    cwd: dir,
  });
  state.agentNet = { socket };
  await waitFor('agent-net socket', async () => existsSync(socket) || null, {
    timeoutMs: 60_000,
    alive: () => alive(pid),
    hint: hint('agent-net'),
  });
  log(`agent-net: the commands' network on ${socket} (service ports ${AGENT_SERVICE_PORTS})`);
}

/**
 * The Hermes every turn runs on (Whombat HE-01, HE-33; IN-403). Live: the image's package (`nix/packages/hermes`,
 * NX-430) built on this host with the Whombat plugin and patches of the runtime the environment runs: from that
 * runtime's own commit when it holds the appliance (the one repository), else from this checkout's flake with the
 * runtime as its `whombat` input (`--override-input whombat`, NX-432: copied by content, so the image's own pin gives
 * the same store path); its `bin/hermes` in the store, which every task sandbox sees. Scripted: the runtime's scripted Hermes
 * (`scripted-hermes.ts`, HE-S100), executable as it is, at the mock's pace, as the demo runs it (HE-S107).
 */
export async function hermesFor(state: EnvState, src: SourceState, log: Log): Promise<string> {
  if (agentsOf(state) === 'scripted') return join(src.path, SCRIPTED_HERMES);
  const link = join(paths.bin, `whombat-hermes@${src.commit.slice(0, 12)}`);
  // In the one repository the runtime's commit holds the appliance too: its own flake builds Hermes with its own
  // plugin and patches, so the Hermes that is tested is that commit's, whatever this checkout is at. Before, the
  // appliance was another repository and took the runtime's commit as its `whombat` input.
  const own = existsSync(join(src.path, 'appliance', 'flake.nix'));
  log(
    `runner: Hermes from ${own ? `${src.id}@${src.commit.slice(0, 12)}'s appliance/nix/packages/hermes` : `nix/packages/hermes with ${src.id}@${src.commit.slice(0, 12)}'s plugin`} (nix build${src.dirty ? '; the tree’s uncommitted changes are not in it' : ''})`,
  );
  await must(
    'nix',
    [
      '--extra-experimental-features',
      'nix-command flakes',
      'build',
      '--no-write-lock-file',
      '--out-link',
      link,
      ...(own
        ? [`git+file://${src.path}?rev=${src.commit}&dir=appliance#whombat-hermes`]
        : [
            `${REPO_DIR}#whombat-hermes`,
            // A flake that reads Whombat from its own commit has no such input to override.
            ...(flakeHasInput(readFileSync(join(REPO_DIR, 'flake.lock'), 'utf8'), 'whombat')
              ? ['--override-input', 'whombat', `git+file://${src.path}?rev=${src.commit}`]
              : []),
          ]),
    ],
    { cwd: REPO_DIR, logFile: logFile('build-hermes'), timeoutMs: 3_600_000 },
  );
  // Older links are other commits' plugins: the newest is enough to keep from the store's garbage collection.
  for (const old of readdirSync(paths.bin))
    if (old.startsWith('whombat-hermes@') && join(paths.bin, old) !== link)
      rmSync(join(paths.bin, old), { force: true });
  return join(realpathSync(link), 'bin', 'hermes');
}

/** The scripted Hermes in a runtime checkout (Whombat HE-S100). */
export const SCRIPTED_HERMES = 'packages/agent-runtime/src/hermes/testing/scripted-hermes.ts';

/**
 * The runner's own settings beside the runtime's (IN-38, IN-403): the managed sandbox, Hermes and its home where a box
 * keeps it (`WHOMBAT_HERMES_ROOT`, NX-431), the agent's home its commands see as `$HOME` (`WHOMBAT_AGENT_HOME`), and
 * the commands' network daemon's socket when it runs (`WHOMBAT_AGENT_NET_SOCKET`; Whombat one-person.md OP-07).
 */
export function runnerAgentEnv(hermesBin: string, agentNet: boolean): Record<string, string> {
  return {
    ...runnerSandboxEnv(),
    WHOMBAT_HERMES_BIN: hermesBin,
    WHOMBAT_HERMES_ROOT: persistLayout().hermes,
    WHOMBAT_AGENT_HOME: persistLayout().agentHome,
    ...(agentNet ? { WHOMBAT_AGENT_NET_SOCKET: agentNetSocket() } : {}),
  };
}

export async function startRunner(state: EnvState, src: SourceState, log: Log): Promise<void> {
  if (running(state, 'runner')) return;
  const env = runtimeEnv(state);
  const runner = join(src.path, 'apps/runner');
  const live = agentsOf(state) === 'live';
  const hermes = await hermesFor(state, src, log);
  state.hermes = { bin: hermes, root: persistLayout().hermes };
  mkdirSync(persistLayout().agentHome, { recursive: true, mode: 0o700 });
  const offset = logOffset('runner');
  const pid = spawnService('pnpm', ['exec', 'tsx', 'src/index.ts'], {
    cwd: runner,
    env: {
      ...hostLoginsUnset(),
      ...env,
      WHOMBAT_SERVER_URL: `http://127.0.0.1:${ports.runtime}`,
      RUNNER_NAME: 'harness-runner',
      ...runnerAgentEnv(hermes, running(state, 'agent-net')),
    },
    logFile: logFile('runner'),
  });
  service(state, 'runner', {
    pid,
    log: logFile('runner'),
    status: 'running',
    command: `tsx src/index.ts (${live ? 'Hermes' : 'the scripted Hermes'})`,
    cwd: runner,
  });
  const text = () =>
    existsSync(logFile('runner')) ? readFileSync(logFile('runner')).subarray(offset).toString() : '';
  // The runner has no port: wait for its connection line, printed after Hermes's and the CLIs' checks and the sandbox
  // probe.
  await waitFor('runner', async () => runnerSummary(text()).ready || null, {
    timeoutMs: 120_000,
    alive: () => alive(pid),
    hint: hint('runner'),
  }).catch(async (e) => {
    if (!alive(pid)) throw e;
    log('runner: running (no ready line seen yet)');
  });
  const { lines } = runnerSummary(text());
  log(
    live
      ? 'runner: live agents (Hermes with the installed clients, each person’s own sign-in; real model calls)'
      : 'runner: the scripted Hermes (deterministic, no model)',
  );
  for (const l of lines) log(`runner:   ${l}`);
  for (const p of runnerProblems(lines)) log(`runner: ✗ ${p} (${hint('runner')})`);
}

/* web ---------------------------------------------------------------------------------------------------- */

export async function startWeb(
  state: EnvState,
  src: SourceState,
  log: Log,
  preparedPage?: Promise<string>,
): Promise<void> {
  if (publicUrls) return startHostedWeb(state, src, log, preparedPage);
  const url = `http://localhost:${ports.web}`;
  state.web = { url };
  if (running(state, 'web')) return;
  const web = join(src.path, 'apps/web');
  const env = {
    // The hosted app (cloud sign-in, then the box through the relay); without it vite serves the box's own page.
    VITE_WHOMBAT_TARGET: 'hosted',
    VITE_WHOMBAT_TRANSPORT: 'session',
    VITE_WHOMBAT_CONTROL_URL: `http://127.0.0.1:${ports.control}`,
    VITE_FIXTURES: '',
    VITE_WHOMBAT_FAKE: '',
    WEB_PORT: String(ports.web),
  };
  const pid = spawnService(
    'pnpm',
    ['exec', 'vite', '--port', String(ports.web), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: web,
      env,
      logFile: logFile('web'),
    },
  );
  const s = service(state, 'web', {
    pid,
    url,
    log: logFile('web'),
    status: 'running',
    command: 'vite (VITE_WHOMBAT_TARGET=hosted)',
    cwd: web,
  });
  await waitFor('web', async () => (await httpGet(`http://127.0.0.1:${ports.web}/`)).ok, {
    timeoutMs: 60_000,
    alive: () => alive(pid),
    hint: hint('web'),
  }).catch((e) => {
    s.status = 'failed';
    throw e;
  });
  log(`web: ${url} (session transport → control ${state.control?.url})`);
}

/**
 * A public instance (IN-32) serves the hosted build (`build:hosted`: session transport, CSP for the public control
 * and relay origins) instead of the vite dev server; rebuilt when the commit or the origins change.
 */
export async function buildHostedWeb(src: SourceState, log: Log): Promise<string> {
  const pub = publicUrls;
  if (!pub) throw new Error('buildHostedWeb needs public URLs');
  const web = join(src.path, 'apps/web');
  const dist = join(web, 'dist-hosted');
  const stamp = JSON.stringify({ commit: src.commit, control: pub.control, relay: pub.relay });
  const stampFile = join(dist, '.whombat-build.json');
  if (!existsSync(stampFile) || readFileSync(stampFile, 'utf8') !== stamp) {
    log(`web: building the hosted UI (control ${pub.control}, relay ${pub.relay})`);
    await must('pnpm', ['run', 'build:hosted'], {
      cwd: web,
      env: {
        VITE_WHOMBAT_CONTROL_URL: pub.control,
        VITE_WHOMBAT_RELAY_ORIGINS: pub.relay.replace(/^https:/, 'wss:'),
      },
      timeoutMs: 600_000,
    });
    writeFileSync(stampFile, stamp);
  }
  return dist;
}

async function startHostedWeb(
  state: EnvState,
  src: SourceState,
  log: Log,
  preparedPage?: Promise<string>,
): Promise<void> {
  const pub = publicUrls;
  if (!pub) throw new Error('startHostedWeb needs public URLs');
  state.web = { url: pub.web };
  if (running(state, 'web')) return;
  const web = join(src.path, 'apps/web');
  const dist = await (preparedPage ?? buildHostedWeb(src, log));
  const pid = spawnService('node', [join(HARNESS_DIR, 'src/dev/web-server.ts'), dist, String(ports.web)], {
    cwd: web,
    logFile: logFile('web'),
  });
  const s = service(state, 'web', {
    pid,
    url: pub.web,
    log: logFile('web'),
    status: 'running',
    command: `web-server ${dist} (hosted build)`,
    cwd: web,
  });
  await waitFor('web', async () => (await httpGet(`http://127.0.0.1:${ports.web}/`)).ok, {
    timeoutMs: 30_000,
    alive: () => alive(pid),
    hint: hint('web'),
  }).catch((e) => {
    s.status = 'failed';
    throw e;
  });
  log(`web: ${pub.web} → 127.0.0.1:${ports.web} (hosted build)`);
}

/* embed ---------------------------------------------------------------------------------------------------- */

/** Whether the app source builds the widget's embed tree (whombat-app ≥ 0.6.0, FD-46). */
export function appHasEmbedBuild(appPath: string): boolean {
  const pkg = join(appPath, 'apps/widget/package.json');
  return existsSync(pkg) && readFileSync(pkg, 'utf8').includes('"build:embed"');
}

/**
 * The Feedback widget's embed origin (Whombat FD-31, FD-46, IN-54): the pinned app's `build:embed` with control's
 * browser URL, into the environment (never into the source tree), rebuilt when the commit or control's URL changes,
 * served by `embed-server.ts` on 127.0.0.1:EMBED_PORT (a public instance: `WB_MGD_PUBLIC_EMBED` through the tunnel).
 */
export async function startEmbed(state: EnvState, src: SourceState, log: Log): Promise<void> {
  const url = embedOrigin();
  if (!url) {
    service(state, 'embed', {
      pid: null,
      log: logFile('embed'),
      status: 'skipped',
      note: 'no embed origin (set WB_MGD_PUBLIC_EMBED)',
    });
    return;
  }
  if (!appHasEmbedBuild(src.path)) {
    service(state, 'embed', {
      pid: null,
      log: logFile('embed'),
      status: 'skipped',
      note: `whombat-app ${src.commit.slice(0, 12)} has no build:embed (app < 0.6.0)`,
    });
    return;
  }
  const dist = envPath('embed', 'dist-embed');
  const local = `http://127.0.0.1:${ports.embed}`;
  state.embed = { url, local, dist };
  if (running(state, 'embed')) return;
  const control = browserControlUrl();
  const stamp = JSON.stringify({ commit: src.commit, dirty: src.dirty, control });
  const stampFile = envPath('embed', 'build.json');
  if (src.dirty || !existsSync(stampFile) || readFileSync(stampFile, 'utf8') !== stamp) {
    log(`embed: building the widget's embed tree (control ${control})`);
    mkdirSync(envPath('embed'), { recursive: true });
    await must('pnpm', ['run', 'build:embed', '--control-url', control, '--out', dist], {
      cwd: join(src.path, 'apps/widget'),
      logFile: join(paths.logs, 'build-embed.log'),
      timeoutMs: 300_000,
    });
    writeFileSync(stampFile, stamp);
  }
  const pid = spawnService(
    'node',
    [join(HARNESS_DIR, 'src/dev/embed-server.ts'), dist, String(ports.embed)],
    {
      cwd: HARNESS_DIR,
      logFile: logFile('embed'),
    },
  );
  const s = service(state, 'embed', {
    pid,
    url,
    log: logFile('embed'),
    status: 'running',
    command: `embed-server ${dist}`,
    cwd: HARNESS_DIR,
  });
  await waitFor('embed', async () => (await httpGet(`${local}/embed/v1/widget.js`)).ok, {
    timeoutMs: 30_000,
    alive: () => alive(pid),
    hint: hint('embed'),
  }).catch((e) => {
    s.status = 'failed';
    throw e;
  });
  log(`embed: ${url} → 127.0.0.1:${ports.embed} (the widget's embed tree, control ${control})`);
}

/* admin app ------------------------------------------------------------------------------------------------ */

/** Where an older Whombat's `build:admin` writes the admin app (vite's default under `apps/admin`, BL-30). */
export const ADMIN_BUILD_DIR = 'apps/admin/dist';

/** Whether the app source builds the admin app (a root `build:admin`: a Whombat from before the panel moved). */
export function appHasAdminBuild(appPath: string): boolean {
  const pkg = join(appPath, 'package.json');
  return existsSync(pkg) && readFileSync(pkg, 'utf8').includes('"build:admin"');
}

/** How a source builds the operator panel: in its folder, these commands, into `out`. */
export interface AdminBuild {
  cwd: string;
  commands: string[][];
  out: string;
}

/**
 * The operator panel's build in a source: control's `admin/` (its own pnpm project, where the panel lives since it
 * left Whombat), or an older Whombat's root `build:admin`; null when the source has neither.
 */
export function adminBuildOf(path: string): AdminBuild | null {
  if (existsSync(join(path, 'admin', 'package.json')))
    return {
      cwd: join(path, 'admin'),
      commands: [
        ['pnpm', 'install', '--frozen-lockfile'],
        ['pnpm', 'run', 'build'],
      ],
      out: join(path, 'admin', 'dist'),
    };
  if (appHasAdminBuild(path))
    return { cwd: path, commands: [['pnpm', 'run', 'build:admin']], out: join(path, ADMIN_BUILD_DIR) };
  return null;
}

/**
 * The admin app control's panel listener serves (`ADMIN_UI_DIR`, BL-27, BL-30, IN-69): the panel of `src` (control's
 * `admin/`, or an older Whombat's `build:admin`; same-origin: no control URL in the build), copied into the environment
 * (`env/admin/dist`) so control serves a tree no later build changes under it; rebuilt when the commit changes or a
 * live tree is dirty. Runs before control starts. A source without the panel leaves `state.admin.dist` null: the
 * panel serves only its API.
 */
export async function buildAdmin(state: EnvState, id: string, src: SourceState, log: Log): Promise<void> {
  const build = adminBuildOf(src.path);
  if (!build) {
    state.admin = { dist: null, note: `${id} ${src.commit.slice(0, 12)} has no operator panel` };
    return;
  }
  const dist = envPath('admin', 'dist');
  const stamp = JSON.stringify({ commit: src.commit, dirty: src.dirty });
  const stampFile = envPath('admin', 'build.json');
  if (
    src.dirty ||
    !existsSync(join(dist, 'index.html')) ||
    !existsSync(stampFile) ||
    readFileSync(stampFile, 'utf8') !== stamp
  ) {
    log(`admin: building the admin app (${id})`);
    mkdirSync(envPath('admin'), { recursive: true });
    for (const [cmd, ...args] of build.commands)
      await must(cmd as string, args, {
        cwd: build.cwd,
        logFile: join(paths.logs, 'build-admin.log'),
        timeoutMs: 600_000,
      });
    const built = build.out;
    if (!existsSync(join(built, 'index.html')))
      throw new Error(
        `the panel's build wrote no ${built}/index.html (see ${join(paths.logs, 'build-admin.log')})`,
      );
    const next = `${dist}.next`;
    rmSync(next, { recursive: true, force: true });
    cpSync(built, next, { recursive: true });
    rmSync(dist, { recursive: true, force: true });
    renameSync(next, dist);
    writeFileSync(stampFile, stamp);
  }
  state.admin = { dist, commit: src.commit };
  log(`admin: ${dist} (${id} ${src.commit.slice(0, 12)}${src.dirty ? ', dirty' : ''})`);
}

export async function controlHealth(state: EnvState): Promise<boolean> {
  if (!state.control) return false;
  return (await run('curl', ['-sf', `${state.control.url}/v1/health`], { cwd: '/' })).code === 0;
}

/**
 * Control's APNs settings from the stack's (IN-518): the key file and its id, the team, and the app's bundle id as the
 * topic. The host defaults to Apple's production service, since the iPhones that use DEV run TestFlight builds, which
 * get production tokens (a sandbox token there is refused as a bad device token); `WB_MGD_APNS_HOST` for a build run
 * from Xcode.
 */
export function apnsControlEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const file = env.WB_MGD_APNS_KEY_FILE;
  if (!file) return {};
  const keyId = env.WB_MGD_APNS_KEY_ID;
  const teamId = env.WB_MGD_APNS_TEAM_ID;
  if (!keyId || !teamId)
    throw new Error('WB_MGD_APNS_KEY_FILE needs WB_MGD_APNS_KEY_ID and WB_MGD_APNS_TEAM_ID');
  return {
    APNS_KEY_FILE: file,
    APNS_KEY_ID: keyId,
    APNS_TEAM_ID: teamId,
    APNS_TOPIC: env.WB_MGD_APNS_TOPIC ?? 'com.whombat.mobile',
    APNS_HOST: env.WB_MGD_APNS_HOST ?? 'https://api.push.apple.com',
  };
}
