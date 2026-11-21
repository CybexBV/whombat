/**
 * Runtime bridge (IN-21): the update helper's fake activator records a runtime restart (`runtime-restarts`) after
 * pointing `profiles/whombat-runtime` at the activated runtime; the bridge restarts the **real** runtime to match —
 * as that release (`WHOMBAT_RELEASE_ID`), or broken when the release's artifact says `runtimeHealth: bad` (it
 * then starts against a database that doesn't exist, so it never becomes healthy). It stands in for systemd
 * restarting the runtime unit from the switched Nix profile.
 *
 *   node runtime-bridge.ts <fakeRoot>
 */
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { sleep } from '../lib/proc.ts';
import { envPath, loadEnv, writeSecret } from './env.ts';
import { restartService } from './restart.ts';

const root = process.argv[2] ?? '';
const restarts = () =>
  existsSync(join(root, 'runtime-restarts'))
    ? Number(readFileSync(join(root, 'runtime-restarts'), 'utf8').trim())
    : 0;
const say = (msg: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), msg, ...extra })}\n`);

const profile = () => {
  try {
    return readlinkSync(join(root, 'profiles', 'whombat-runtime'));
  } catch {
    return '';
  }
};
/** Stops the running runtime at once: systemd stops the old unit before `restart` returns (the fake doesn't). */
function killRuntimeNow(): void {
  const pid = loadEnv()?.services.runtime?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // gone
  }
}

let seen = restarts();
let active = profile();
say('runtime bridge watching the fake activator', { root, restarts: seen, profile: active });
for (;;) {
  await sleep(100);
  const p = profile();
  if (p !== active) {
    // The profile switched (set-runtime): the old runtime must not keep answering health checks for the new one.
    active = p;
    killRuntimeNow();
    say('profile switched; the old runtime was stopped', { profile: p });
  }
  const n = restarts();
  if (n === seen) continue;
  seen = n;
  killRuntimeNow();
  const target = readlinkSync(join(root, 'profiles', 'whombat-runtime'));
  const artifact = JSON.parse(readFileSync(join(root, 'store', basename(target)), 'utf8')) as {
    releaseId?: string;
    runtimeHealth?: string;
    version?: string;
    source?: string;
  };
  // The checkpoint the helper's migrate step recorded (`migrate <store> -> N checkpoint="ref"`), for this runtime.
  const events = existsSync(join(root, 'events.log'))
    ? readFileSync(join(root, 'events.log'), 'utf8').trim().split('\n')
    : [];
  const mig = events.reverse().find((l) => l.startsWith(`migrate ${target} `));
  const checkpoint = (mig && /checkpoint="([^"]*)"/.exec(mig)?.[1]) || null;
  const overrides = {
    releaseId: artifact.releaseId ?? null,
    broken: artifact.runtimeHealth === 'bad',
    storePath: target,
    runtimeDir: artifact.source ?? null,
    checkpoint,
  };
  writeSecret(envPath('runtime', 'overrides.json'), JSON.stringify(overrides));
  say('restarting the real runtime for the activated profile', { restart: n, ...overrides });
  try {
    await restartService('runtime', (l) => say(l));
    say('runtime restarted', { releaseId: overrides.releaseId });
  } catch (err) {
    say('runtime did not come up', { err: String(err).split('\n')[0], broken: overrides.broken });
  }
}
