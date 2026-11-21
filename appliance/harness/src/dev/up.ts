/**
 * `dev/up` — the one-command local integrated environment (R-75, IN-07).
 *
 *   dev/up [--live [app,runtime,…]] [--lockfile-drift] [--without web,runner,…] [--reset]
 *
 * Starts, in order: Postgres (whombat-mgd-pg), control, relay, dev appliance provisioning (keys, registration
 * with control, claim card; the console code comes from the runtime, `dev/console`), restic rest-server (append-only), the dev manager, the
 * commands' network daemon (when the runtime has `apps/agent-net`), the managed runtime, its runner (Hermes in the managed sandbox for every turn: the runtime's
 * scripted Hermes; `WB_MGD_AGENTS=live`: the image's Hermes with the installed clients, IN-38, IN-403) and the web app
 * (session transport). Mailpit is the shared one (never started/stopped).
 * Before control: the admin app its panel listener serves (IN-69; `--without admin` skips it).
 * State: ~/.cache/whombat-mgd/env/ (env.json, logs/, run/, control/, appliance/, runtime/, restic/).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireEnvLock, releaseEnvLock } from '../lib/lock.ts';
import { agentsMode, googleMode, mailpit, paths, ports, publicUrls } from '../lib/paths.ts';
import { PINS_FILE } from '../manifest/pins.ts';
import { consoleSummary, readConsoleState } from './console.ts';
import { stopAll, stopRetired } from './down.ts';
import { type EnvState, envPath, loadEnv, type ServiceName, saveEnv } from './env.ts';
import { ensurePostgres } from './postgres.ts';
import { provisionDevAppliance } from './provision.ts';
import { pruneCopies } from './prune-copies.ts';
import {
  adminBuildOf,
  buildAdmin,
  buildHostedWeb,
  buildRuntimeWeb,
  startAgentNet,
  startBackup,
  startControl,
  startEmbed,
  startHosts,
  startManager,
  startRealManager,
  startRelay,
  startRestic,
  startRunner,
  startRuntime,
  startWeb,
} from './services.ts';
import { isLive, type LiveSelection, parseLive, pinsComponents, sourcePreparation } from './sources.ts';

const OPTIONAL: ServiceName[] = [
  'restic',
  'backup',
  'manager',
  'hosts',
  'agent-net',
  'runtime',
  'runner',
  'web',
  'embed',
];
/** Optional steps that aren't services: `admin` (the admin app control's panel serves, IN-69). */
const OPTIONAL_STEPS = ['admin'];

export interface UpOptions {
  /** null: pinned; `all` or component ids: those run from their live trees (`--live app,runtime`). */
  live: LiveSelection | null;
  lockfileDrift: boolean;
  without: Set<string>;
  reset: boolean;
  quiet?: boolean;
  /** `auto` (default): the real manager, else the stand-in; `real`/`standin` force one. */
  manager?: 'auto' | 'real' | 'standin';
}

export async function up(options: UpOptions): Promise<{ state: EnvState; failures: string[] }> {
  acquireEnvLock('dev/up');
  try {
    return await upLocked(options);
  } finally {
    releaseEnvLock();
  }
}

async function upLocked(options: UpOptions): Promise<{ state: EnvState; failures: string[] }> {
  const t0 = Date.now();
  const log = (l: string) => {
    if (!options.quiet)
      process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${l}\n`);
  };
  if (options.reset) {
    log(
      'reset: stopping services and removing ~/.cache/whombat-mgd/env (the Postgres databases are dropped too)',
    );
    await stopAll({ purge: true, quiet: true });
  }
  mkdirSync(paths.logs, { recursive: true });
  mkdirSync(paths.run, { recursive: true, mode: 0o700 });
  const prev = loadEnv();
  const mode = !options.live ? 'pinned' : options.live === 'all' ? 'live' : 'mixed';
  if (prev && prev.mode !== mode && Object.values(prev.services).some((s) => s?.status === 'running'))
    throw new Error(`the environment is running in ${prev.mode} mode; dev/down first`);
  const state: EnvState = prev ?? {
    $schema: 'whombat.local-env/1',
    mode,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ports: { ...ports },
    sources: {},
    services: {},
  };
  state.mode = mode;
  if (
    prev?.pinsFile &&
    prev.pinsFile !== PINS_FILE &&
    Object.values(prev.services).some((s) => s?.status === 'running')
  )
    throw new Error(`the environment runs ${prev.pinsFile}; dev/down first (or set WB_MGD_PINS to it)`);
  state.pinsFile = PINS_FILE;
  // The runner reads WB_MGD_AGENTS at start (IN-38, IN-403: which Hermes): switching needs it restarted.
  const running = (n: ServiceName) => prev?.services[n]?.status === 'running';
  if (prev && (prev.agents ?? 'scripted') !== agentsMode && running('runner'))
    throw new Error(
      `the environment runs ${prev.agents ?? 'scripted'} agents; dev/down first (or set WB_MGD_AGENTS=${prev.agents ?? 'scripted'})`,
    );
  state.agents = agentsMode;
  // The runtime reads WB_MGD_GOOGLE at start (IN-49): switching needs it restarted.
  if (prev && (prev.google ?? null) !== googleMode && running('runtime'))
    throw new Error(
      `the environment runs Google ${prev.google ?? 'unset (real)'}; dev/down first (or set WB_MGD_GOOGLE=${prev.google ?? ''})`,
    );
  if (googleMode) state.google = googleMode;
  else delete state.google;
  state.ports = { ...ports };
  // What an older harness ran goes: the browser host (IN-88, IN-407) and computerd (Whombat one-person.md OP-04).
  await stopRetired(state, log);
  const failures: string[] = [];
  const pins = pinsComponents();
  const prep = (id: string) => ({
    live: !!options.live && isLive(options.live, id),
    lockfileDrift: options.lockfileDrift,
    log,
  });
  const want = (s: ServiceName | 'admin') => !options.without.has(s);
  const prepared = sourcePreparation(pins, prep);
  const source = async (id: string) => {
    const s = await prepared.source(id);
    state.sources[id] = s;
    if (s.mode === 'live' && s.dirty) log(`${id}: live tree has uncommitted changes (running as is)`);
    return s;
  };
  let pagesDone: Promise<unknown> = Promise.resolve();

  try {
    // 1. Postgres
    await ensurePostgres(log);
    state.services.postgres = {
      pid: null,
      kind: 'docker',
      url: `postgres://127.0.0.1:${ports.postgres}`,
      log: 'docker logs whombat-mgd-pg',
      startedAt: new Date().toISOString(),
      status: 'running',
    };
    saveEnv(state);

    // 2. the admin app (BL-30, IN-69): control's panel listener serves it (ADMIN_UI_DIR, read at start), so it is
    // built first, from control's own source (control's `admin/`) or, with an older control, the app's
    // `build:admin`. A failure is reported and control starts without it (the panel serves only its API).
    if (!want('admin')) state.admin = { dist: null, note: '--without admin' };
    else
      try {
        const api = await source('whombat-api');
        if (adminBuildOf(api.path)) await buildAdmin(state, 'whombat-api', api, log);
        else {
          const app = await source('whombat-app');
          await prepared.install(app);
          await buildAdmin(state, 'whombat-app', app, log);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`admin: ${msg}`);
        state.admin = { dist: null, note: msg.split('\n')[0] };
        log(`✗ admin: ${msg}`);
      }
    saveEnv(state);

    // These builds write separate output folders in the pinned clone and need no running services. Observe both
    // failures immediately, await each at its service, and settle both before returning even if startup fails.
    const runtimePage =
      want('runtime') && !running('runtime')
        ? (async () => {
            const rt = await source('whombat-runtime');
            await prepared.install(rt);
            await buildRuntimeWeb(rt, log);
          })()
        : undefined;
    const hostedPage =
      publicUrls && want('web') && !running('web')
        ? (async () => {
            const app = await source('whombat-app');
            await prepared.install(app);
            return buildHostedWeb(app, log);
          })()
        : undefined;
    pagesDone = Promise.allSettled([runtimePage, hostedPage]);

    // 3. control
    const control = await source('whombat-api');
    await prepared.install(control);
    await startControl(state, control, log);
    saveEnv(state);

    // 4. relay (JWKS from control)
    const relay = await source('whombat-relay');
    await startRelay(state, relay, log);
    saveEnv(state);

    // 5. dev appliance: identities, registration, claim card
    const dir = envPath('appliance');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ctl = state.control;
    if (!ctl) throw new Error('control did not start');
    const prov = await provisionDevAppliance({
      dir,
      controlUrl: ctl.url,
      provisioningToken: readFileSync(ctl.provisioningTokenFile, 'utf8').trim(),
      claimUrlBase: `${publicUrls?.web ?? `http://localhost:${ports.web}`}/claim`,
      // Every image makes its identity itself and registers at control only when its Whombat Link starts (Whombat
      // LNK-01, LNK-03). `WB_MGD_PROVISION=control` is a box control registered before Link, as Cybex's first ones.
      registrar: process.env.WB_MGD_PROVISION?.trim() === 'control' ? 'control' : 'local',
    });
    state.appliance = {
      deviceId: prov.record.deviceId,
      route: prov.record.applianceRoute,
      peerId: prov.record.contentPeerId,
      fingerprint: prov.record.fingerprint,
      identityDir: prov.identityDir,
      claimCardFile: prov.cardFile,
      claimFile: prov.claimFile,
      managerSocket: join(paths.run, 'manager.sock'),
      adminSocket: join(paths.run, 'admin.sock'),
    };
    log(
      `appliance: ${prov.record.deviceId} ${prov.created ? (prov.record.applianceRoute === 'local' ? 'provisioned on the box (not registered with control)' : 'provisioned and registered with control') : '(existing identity)'}; fingerprint ${prov.record.fingerprint}`,
    );
    saveEnv(state);

    // 6. optional services: a failure is reported, the rest continues where it can.
    const optional = async (name: ServiceName, fn: () => Promise<void>) => {
      if (!want(name)) {
        state.services[name] = {
          pid: null,
          kind: 'process',
          log: '',
          startedAt: new Date().toISOString(),
          status: 'skipped',
          note: '--without',
        };
        return;
      }
      try {
        await fn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${name}: ${msg}`);
        const s = state.services[name];
        state.services[name] = {
          ...(s ?? { pid: null, kind: 'process', log: '', startedAt: new Date().toISOString() }),
          status: 'failed',
          note: msg.split('\n')[0],
        };
        log(`✗ ${name}: ${msg}`);
      }
      saveEnv(state);
    };
    await optional('restic', () => startRestic(state, log));
    await optional('backup', async () => startBackup(state, await source('appliance-backup'), log));
    await optional('manager', async () => {
      if (options.manager === 'standin') return startManager(state, log);
      try {
        const m = await source('appliance-manager');
        const rt = await source('whombat-runtime');
        await startRealManager(state, m, rt, log);
      } catch (err) {
        // The stand-in knows nothing of Whombat Link, and a box that made its identity itself is known to control
        // only through Link: there it would start a box nobody can reach, so the real manager's failure is the answer.
        if (options.manager === 'real' || state.appliance?.route === 'local') throw err;
        log(
          `manager: the real manager did not start (${String(err).split('\n')[0]}); using the stand-in (IN-09)`,
        );
        await startManager(state, log);
      }
    });
    let runtimeSrc: Awaited<ReturnType<typeof source>> | null = null;
    // The hosts service (NX-155), before the runtime: the runtime gets its socket and token only when it runs. Pins from
    // before it (candidates before 0.86.0) have no whombat-hosts: nothing to run.
    await optional('hosts', async () => {
      if (!pins.has('whombat-hosts')) {
        state.services.hosts = {
          pid: null,
          kind: 'process',
          log: '',
          startedAt: new Date().toISOString(),
          status: 'skipped',
          note: 'the pins have no whombat-hosts',
        };
        delete state.hosts;
        return;
      }
      await startHosts(state, await source('whombat-hosts'), log);
    });
    // The commands' network (Whombat one-person.md OP-07), before the runner, which reaches its socket. No container
    // engine (OP-16): the runtime then says Docker and the agent's services aren't available.
    await optional('agent-net', async () => {
      const rt = await source('whombat-runtime');
      await prepared.install(rt);
      await startAgentNet(state, rt, log);
    });
    await optional('runtime', async () => {
      runtimeSrc = await source('whombat-runtime');
      await prepared.install(runtimeSrc);
      await startRuntime(state, runtimeSrc, log, runtimePage);
    });
    await optional('runner', async () => {
      if (!runtimeSrc || state.services.runtime?.status !== 'running') throw new Error('needs the runtime');
      await startRunner(state, runtimeSrc, log);
    });
    await optional('web', async () => {
      const app = await source('whombat-app');
      await prepared.install(app);
      await startWeb(state, app, log, hostedPage);
    });
    await optional('embed', async () => {
      const app = await source('whombat-app');
      await prepared.install(app);
      await startEmbed(state, app, log);
    });
  } catch (err) {
    saveEnv(state);
    throw err;
  } finally {
    await pagesDone;
  }
  saveEnv(state);
  // The copies of older commits nobody runs any more (src/, bin/, fixtures/): each candidate adds a few GB.
  try {
    pruneCopies(state, log);
  } catch (err) {
    log(
      `copies: pruning failed (${err instanceof Error ? err.message : String(err)}); the environment is up`,
    );
  }
  return { state, failures };
}

export async function sessionEndpointProbe(state: EnvState): Promise<string> {
  // The runtime's session endpoint is reachable only through the relay; the admin socket says whether it runs.
  if (!state.appliance) return 'no appliance';
  if (!existsSync(state.appliance.adminSocket)) return 'admin socket absent (runtime managed boot not wired)';
  return 'admin socket present';
}

function printSummary(state: EnvState, failures: string[]): void {
  const lines = [
    '',
    `Whombat managed — local integrated environment (${state.mode})`,
    `  control   ${state.control?.url ?? '-'}   operator ${state.control?.adminUrl ?? '-'}`,
    `  relay     ${state.relay?.url ?? '-'}   admin ${state.relay?.adminUrl ?? '-'}`,
    `  runtime   ${state.runtime?.url ?? '-'} (loopback, managed) · direct ${state.runtime?.direct ?? '-'} (loopback)`,
    `  agents    ${state.agents === 'live' ? 'live (the installed Claude Code and ChatGPT through Hermes, each person’s own sign-in)' : 'scripted (deterministic)'}${state.hermes ? ` · Hermes ${state.hermes.bin}` : ''}`,
    `  agent-net ${state.agentNet && state.services['agent-net']?.status === 'running' ? `${state.agentNet.socket} (the commands' network)` : `- (${state.services['agent-net']?.note ?? 'not running'})`}`,
    `  google    ${state.google === 'fake' ? 'fake (connect completes without Google)' : state.google === 'off' ? 'off' : 'real (each Whombat’s own OAuth client)'}`,
    `  web       ${state.web?.url ?? '-'}`,
    `  embed     ${state.embed?.url ?? '-'} (the Feedback widget)`,
    `  hosts     ${state.hosts && state.services.hosts?.status === 'running' ? `${state.hosts.socket} · agents on :${state.hosts.agentPort}` : '-'}`,
    `  panel     ${state.panel ? `${state.panel.url}${state.panel.url === state.panel.local ? '' : ` → ${state.panel.local}`} · users ${state.panel.users.join(', ') || 'none'} · allow ${state.panel.allowed.join(',')}` : '-'}`,
    `  admin app ${state.admin?.dist ?? `- (${state.admin?.note ?? 'not built'})`}`,
    `  billing   ${state.billing ? `${state.billing.provider}${state.billing.signupMode ? ` · signup mode ${state.billing.signupMode} (default)` : ''}` : '-'}`,
    publicUrls?.smtpUrlFile
      ? `  mail      SMTP from ${publicUrls.smtpUrlFile}`
      : `  mailpit   ${mailpit.api} (shared)`,
    `  postgres  127.0.0.1:${ports.postgres}`,
    `  appliance ${state.appliance?.deviceId ?? '-'}  fingerprint ${state.appliance?.fingerprint ?? '-'}`,
    `  console   ${state.appliance ? consoleSummary(readConsoleState()) : '-'}`,
    // Only a box control registered is claimed through control, where a card is the fallback.
    ...(state.appliance && state.appliance.route !== 'local'
      ? [`  claim card ${join(envPath('appliance'), 'claim-card.txt')} (fallback: “Claim with a card”)`]
      : []),
    `  manager   ${state.manager?.kind ?? '-'}`,
    '',
    'Services:',
    ...Object.entries(state.services).map(
      ([n, s]) => `  ${n.padEnd(9)} ${s?.status.padEnd(8)} ${s?.pid ? `pid ${s.pid}` : ''} ${s?.note ?? ''}`,
    ),
  ];
  if (failures.length) lines.push('', 'Not running:', ...failures.map((f) => `  ✗ ${f.split('\n')[0]}`));
  lines.push('', 'dev/status · dev/logs <service> · dev/down');
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** `--live` (all) or `--live app,runtime` (those only); absent: pinned. */
export function liveArg(args: string[]): LiveSelection | null {
  const i = args.indexOf('--live');
  if (i < 0) return null;
  const next = args[i + 1];
  return next && !next.startsWith('-') ? parseLive(next) : 'all';
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const withoutIdx = args.indexOf('--without');
  const without = new Set(withoutIdx >= 0 ? (args[withoutIdx + 1] ?? '').split(',').filter(Boolean) : []);
  for (const w of without)
    if (!OPTIONAL.includes(w as ServiceName) && !OPTIONAL_STEPS.includes(w)) {
      console.error(
        `--without: ${w} is not optional (optional: ${[...OPTIONAL, ...OPTIONAL_STEPS].join(', ')})`,
      );
      process.exit(2);
    }
  try {
    const { state, failures } = await up({
      live: liveArg(args),
      lockfileDrift: args.includes('--lockfile-drift'),
      without,
      reset: args.includes('--reset'),
      manager: args.includes('--manager=standin')
        ? 'standin'
        : args.includes('--manager=real')
          ? 'real'
          : 'auto',
    });
    printSummary(state, failures);
    process.exit(failures.length ? 1 : 0);
  } catch (err) {
    console.error(`\ndev/up failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Partial environment left running; dev/status shows it, dev/down stops it.');
    process.exit(1);
  }
}
