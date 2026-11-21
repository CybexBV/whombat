/**
 * Whether Hermes, the engine every turn runs on, is ready on this host (hermes-engine.md HE-01, HE-10; contracts
 * `HermesCheck`, CT-1160): the profile root can be written, `hermes --version` answers, and it is the pinned release.
 * Reported with the CLIs' checks in every heartbeat (`RunnerStatus.hermes`).
 *
 * `--version` runs with a throwaway `HERMES_HOME` (`<root>/check`) whose config turns Hermes's update check off: its
 * version line otherwise asks GitHub whether it is up to date.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HermesCheck } from '@whombat/core';
import { privateDir } from '../host';
import { trimMessage } from '../support/errors';
import { HERMES_PIN } from './profile';

/** `Hermes Agent v0.22.5 (2026.9.24) · stable · …`, the first line of `hermes --version`. */
const VERSION_LINE = /Hermes Agent v(\d+\.\d+\.\d+[\w.+-]*)( \(scripted\))?/;

/** What the scripted Hermes adds to its version (`0.22.5 (scripted)`, `testing/scripted-hermes.ts`; HE-46). */
export const SCRIPTED_HERMES_SUFFIX = ' (scripted)';

/**
 * Whether a reported Hermes version is the scripted stand-in's (HE-46): it runs turns without a CLI or a sign-in, which
 * only a server that allows it (`WHOMBAT_ALLOW_SCRIPTED=1`) lets it do. A real Hermes never says so.
 */
export function isScriptedHermes(version: string | null | undefined): boolean {
  return typeof version === 'string' && version.endsWith(SCRIPTED_HERMES_SUFFIX);
}

export interface HermesCheckOptions {
  /** The `hermes` executable (`hermesBin`). */
  bin: string;
  /** `WHOMBAT_HERMES_ROOT` (`hermesRoot`). */
  root: string;
  /** Whose `PATH` finds it and the interpreter it starts (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** The version it must be (default the pin, `HERMES_PIN.version`). */
  version?: string;
  timeoutMs?: number;
}

const notReady = (
  problem: NonNullable<HermesCheck['problem']>,
  detail: string,
  version: string | null = null,
) => ({
  ready: false,
  version,
  problem,
  detail: trimMessage(detail, 500),
});

export async function checkHermes(options: HermesCheckOptions): Promise<HermesCheck> {
  const home = join(options.root, 'check');
  try {
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    await privateDir(options.root);
    await privateDir(home);
    await writeFile(join(home, 'config.yaml'), '{"updates": {"check": false}}\n', { mode: 0o600 });
  } catch (error) {
    return notReady('storage', `Can’t write ${options.root}: ${(error as Error).message}`);
  }
  const env = options.env ?? process.env;
  const ran = await new Promise<{ code: string | number | null; out: string; err: string }>((resolve) => {
    execFile(
      options.bin,
      ['--version'],
      {
        env: { PATH: env.PATH ?? '/usr/bin:/bin', HOME: home, HERMES_HOME: home, LANG: 'C.UTF-8' },
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 256 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as NodeJS.ErrnoException).code ?? 'failed') : null,
          out: String(stdout),
          err: String(stderr),
        }),
    );
  });
  if (ran.code === 'ENOENT' || ran.code === 'EACCES')
    return notReady('missing', `Hermes isn’t installed at ${options.bin}.`);
  const line = VERSION_LINE.exec(ran.out);
  const version = line?.[1] ?? null;
  if (ran.code !== null || !version)
    return notReady('broken', `${options.bin} --version: ${ran.err.trim() || ran.out.trim() || ran.code}`);
  const pinned = options.version ?? HERMES_PIN.version;
  if (version !== pinned)
    return notReady('outdated', `Hermes ${version} is installed; this Whombat runs ${pinned}.`, version);
  // The scripted stand-in says so in its version, for the runner's claims and the server's sign-in rule (HE-46).
  return {
    ready: true,
    version: line?.[2] ? `${version}${SCRIPTED_HERMES_SUFFIX}` : version,
    problem: null,
    detail: null,
  };
}
