import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expandHome } from '../lib/paths.ts';
import { buildScript, defaultDeploySh, flakeAt } from './context.ts';

describe('where deploy.sh is', () => {
  const cloud = expandHome('~/Code/whombat-cloud/infra/hetzner/deploy.sh');

  it('is the one named', () => {
    expect(defaultDeploySh({ WB_DEPLOY_SH: '/x/deploy.sh' })).toBe('/x/deploy.sh');
  });

  it('is whombat-cloud’s otherwise', () => {
    expect(defaultDeploySh({})).toBe(cloud);
  });
});

describe('a checkout in either layout', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  /** A repository with these files in one commit; its folder and the commit. */
  const repository = (files: string[]) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ship-context-')));
    roots.push(dir);
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), '{ }\n');
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'files');
    return { dir, rev: git('rev-parse', 'HEAD') };
  };
  const APPLIANCE = ['flake.nix', 'nix/profiles/prod.nix', 'release/build'];

  it('names the flake and the build script of the appliance’s own repository as before', () => {
    const { dir, rev } = repository(APPLIANCE);
    expect(flakeAt(dir, rev)).toBe(`git+file://${dir}?rev=${rev}`);
    expect(buildScript(dir)).toBe(join(dir, 'release', 'build'));
  });

  it('finds both in Whombat’s appliance/ folder, from the checkout’s top or from the folder', () => {
    const { dir, rev } = repository(APPLIANCE.map((f) => `appliance/${f}`));
    const flake = `git+file://${dir}?rev=${rev}&dir=appliance`;
    expect(flakeAt(dir, rev)).toBe(flake);
    expect(flakeAt(join(dir, 'appliance'), rev)).toBe(flake);
    expect(buildScript(dir)).toBe(join(dir, 'appliance', 'release', 'build'));
    expect(buildScript(join(dir, 'appliance'))).toBe(join(dir, 'appliance', 'release', 'build'));
  });

  it('falls back to the script’s name from before, for a worktree of an old commit', () => {
    const { dir } = repository(['flake.nix']);
    expect(buildScript(dir)).toBe(join(dir, 'release', 'build-proxmox'));
  });
});
