import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySums } from '@whombat/cli/release';
import { ReleaseManifest } from '@whombat/core';
import * as esbuild from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_FILES,
  bundleOptions,
  copyAppFiles,
  ENTRIES,
  LAUNCHERS,
  launcher,
  runtimePostgres,
} from './build';
import { keygen, signDir } from './sign';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whombat-package-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('release signing (BP-F20)', () => {
  it('keygen writes a private key only its owner reads; sign refuses an unpinned key when asked to', () => {
    const k = keygen(join(dir, 'keys'));
    expect(statSync(k.privateKey).mode & 0o777).toBe(0o600);
    expect(() => keygen(join(dir, 'keys'))).toThrow(/exists already/);
    writeFileSync(join(dir, 'SHA256SUMS'), `${'c'.repeat(64)}  whombat-runtime-0.1.0-linux-x64.tar.gz\n`);
    // The throwaway key isn't pinned in keys.ts: a bundle must not be signed with it.
    expect(() => signDir(dir, k.privateKey, true)).toThrow(/isn’t pinned/);
    expect(signDir(dir, k.privateKey).id).toBe(k.key.id);
    expect(
      verifySums(readFileSync(join(dir, 'SHA256SUMS')), readFileSync(join(dir, 'SHA256SUMS.sig')), [k.key]),
    ).toEqual(k.key);
  });
});

describe('the runtime bundle’s manifest', () => {
  it('names the appliance’s own PostgreSQL, and the contract keeps it', () => {
    const manifest = ReleaseManifest.parse({
      format: 1,
      name: 'whombat',
      version: '0.2.0-20260928190000.abcdef1',
      gitSha: 'a'.repeat(40),
      gitDirty: false,
      buildTime: new Date(0).toISOString(),
      node: '>=24',
      platform: 'linux',
      arch: 'x64',
      postgres: runtimePostgres(),
      claude: { bundled: false },
      schema: { latest: null, migrations: [] },
      files: {},
    });
    // The appliance's own PostgreSQL (NX-18): nothing of PostgreSQL is in the bundle.
    expect(manifest.postgres).toEqual({ package: 'postgresql', version: '17', major: 17 });
  });
});

describe('the release bundles load (MR-72, MR-76)', () => {
  // A bundle that fails while loading its modules (a native addon it can't find, an export read before esbuild's lazy
  // initialiser ran) fails every start. Each entry point must get as far as its own configuration check.
  it('server, runner and CLI get past their imports', async () => {
    const build = { version: '0.0.0', gitSha: 'test', buildTime: new Date(0).toISOString() };
    for (const app of ['server', 'runner', 'cli', 'agent-net'] as const)
      await esbuild.build({
        ...bundleOptions(ENTRIES[app], join(dir, 'app', `${app}.mjs`), build),
        logLevel: 'error',
      });
    const run = (app: string, args: string[], env: Record<string, string>) =>
      spawnSync(process.execPath, [join(dir, 'app', `${app}.mjs`), ...args], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const server = run('server', [], { NODE_ENV: 'production', WHOMBAT_MODE: 'managed' });
    expect(server.stderr).toMatch(/Invalid server configuration/);
    const runner = run('runner', [], { RUNNER_TOKEN_FILE: 'runner-token' });
    expect(runner.stderr).toMatch(/Invalid runner configuration/);
    // The commands' network daemon (one-person.md OP-S106): a socket that isn't a full path stops it at once.
    const agentNet = run('agent-net', [], { WHOMBAT_AGENT_NET_SOCKET: 'relative.sock' });
    expect(agentNet.stderr).toMatch(/WHOMBAT_AGENT_NET_SOCKET/);
    // `bin/whombat --help` through the bundle's launcher: the appliance's Nix build checks for this line.
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'whombat'), launcher('whombat', LAUNCHERS.whombat));
    const cli = spawnSync('sh', [join(dir, 'bin', 'whombat'), '--help'], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, WHOMBAT_NODE: process.execPath },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout).toMatch(/Usage: whombat/);
    // Every file a bundle opens next to itself is shipped there (MR-77: the runner's sandbox shim was not, and every
    // managed turn failed with MODULE_NOT_FOUND while the sandbox probe, which doesn't start it, passed).
    copyAppFiles(join(dir, 'app'));
    const siblings = new Set<string>();
    for (const app of ['server', 'runner', 'cli', 'agent-net'] as const) {
      const text = readFileSync(join(dir, 'app', `${app}.mjs`), 'utf8');
      for (const m of text.matchAll(/new URL\(\s*["']\.\/([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g))
        siblings.add(m[1] as string);
    }
    expect([...siblings]).toContain('shim.mjs');
    // A person's pod's payload (hermes-native.md HN-W01): the runner starts it with Node inside the pod.
    expect([...siblings]).toContain('pod-init.mjs');
    // The agent's commands (one-person.md OP-07): the launcher, the holder, a task sandbox's init, the helpers.
    for (const name of [
      'whombat-command.mjs',
      'commands-host.mjs',
      'commands-init.mjs',
      'commands-net.mjs',
      'whombat-gh.mjs',
      'whombat-git.mjs',
      'whombat-helper.mjs',
      'whombat-connect.mjs',
      'whombat-askpass.mjs',
    ])
      expect([...siblings]).toContain(name);
    for (const name of siblings) expect(existsSync(join(dir, 'app', name)), `app/${name}`).toBe(true);
    // The helpers import their neighbours (`./frames.mjs`, `./line-client.mjs`): whatever a shipped file imports from
    // beside it is shipped too, and the helpers load from `app/` alone.
    for (const name of Object.keys(APP_FILES)) {
      const text = readFileSync(join(dir, 'app', name), 'utf8');
      for (const m of text.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+["']\.\/([^"']+)["']/gm))
        expect(existsSync(join(dir, 'app', m[1] as string)), `${name} imports ./${m[1]}`).toBe(true);
    }
    const helpers = ['whombat-gh.mjs', 'whombat-git.mjs', 'whombat-helper.mjs'].map((n) =>
      join(dir, 'app', n),
    );
    const load = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `for (const f of ${JSON.stringify(helpers)}) await import(f);`],
      { cwd: dir, encoding: 'utf8', timeout: 60_000 },
    );
    expect(load.status, load.stderr).toBe(0);
  }, 180_000);
});
