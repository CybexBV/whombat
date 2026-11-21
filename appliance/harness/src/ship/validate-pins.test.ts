import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_DIR } from '../lib/paths.ts';
import { COMPONENTS_FILE } from '../manifest/components.ts';
import { pinsOfBuild } from './validate.ts';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  }).trim();

function commit(repo: string, files: Record<string, string | null>): string {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) sh(repo, 'rm', '-q', path);
    else {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  }
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'a commit');
  return sh(repo, 'rev-parse', 'HEAD');
}

function repo(files: Record<string, string>): { dir: string; rev: string } {
  const dir = mkdtempSync(join(tmpdir(), 'validate-pins-'));
  sh(dir, 'init', '-q', '-b', 'main');
  return { dir, rev: commit(dir, files) };
}

const releaseDir = () => mkdtempSync(join(tmpdir(), 'validate-pins-release-'));
const OLD = 'manifest/candidates/0.283.2.json';

describe('the pins a build is validated with', () => {
  it('are the candidate manifest in the checkout for a build of the old flow, when it is the build’s', () => {
    const old = repo({ 'flake.nix': '{}', 'nix/profiles/prod.nix': '{}', [OLD]: '{"pins":1}\n' });
    const build = { source: { rev: old.rev }, ship: { candidate: { file: OLD, name: '0.283.2' } } };
    const find = { checkout: old.dir, archives: [] };
    expect(pinsOfBuild({ repo: old.dir, dir: releaseDir(), build, find }).file).toBe(OLD);
    writeFileSync(join(old.dir, OLD), '{"pins":2}\n');
    expect(() => pinsOfBuild({ repo: old.dir, dir: releaseDir(), build, find })).toThrow(
      /validate the pins you built/,
    );
  });

  it('are the build’s own commit’s once the manifests left the checkout', () => {
    // The old repository is the archive; the checkout is the one repository, without the candidate manifests.
    const archive = repo({ 'flake.nix': '{}', 'nix/profiles/prod.nix': '{}', [OLD]: '{"pins":1}\n' });
    const here = repo({ 'appliance/flake.nix': '{}' });
    const dir = releaseDir();
    const r = pinsOfBuild({
      repo: join(here.dir, 'appliance'),
      dir,
      build: { source: { rev: archive.rev }, ship: { candidate: { file: OLD, name: '0.283.2' } } },
      find: { checkout: join(here.dir, 'appliance'), archives: [archive.dir] },
    });
    expect(r.file).toBe(join(dir, 'validation', '0.283.2.json'));
    expect(readFileSync(r.file, 'utf8')).toBe('{"pins":1}\n');
  });

  it('are the component list at the commit for a build of the one repository', () => {
    const version = (v: string) => JSON.stringify({ version: v });
    const here = repo({
      'appliance/flake.nix': '{}',
      [`appliance/${COMPONENTS_FILE}`]: readFileSync(join(REPO_DIR, COMPONENTS_FILE), 'utf8'),
      'package.json': version('0.2.0'),
      'packages/core/package.json': version('4.10.0'),
      'apps/web/package.json': version('3.134.1'),
    });
    const cloud = repo({ 'control/package.json': version('0.1.0') });
    const ops = mkdtempSync(join(tmpdir(), 'validate-pins-ops-'));
    mkdirSync(join(ops, 'guards'));
    mkdirSync(join(ops, 'records', 'releases'), { recursive: true });
    writeFileSync(
      join(ops, 'records', 'releases', '0.284.0.json'),
      JSON.stringify({ cloud: { rev: cloud.rev, parts: ['control', 'relay'] } }),
    );
    const dir = releaseDir();
    const r = pinsOfBuild({
      repo: join(here.dir, 'appliance'),
      dir,
      build: { source: { rev: here.rev }, ship: { candidate: { file: '', name: '0.284.0' } } },
      find: { checkout: join(here.dir, 'appliance'), archives: [] },
      env: { WHOMBAT_CLOUD: cloud.dir, WHOMBAT_OPS: ops },
    });
    expect(r.file).toBe(join(dir, 'validation', '0.284.0.json'));
    const pins = JSON.parse(readFileSync(r.file, 'utf8')) as {
      productVersion: string;
      components: { id: string; commit: string; dir?: string }[];
    };
    expect(pins.productVersion).toBe('0.284.0');
    expect(pins.components.find((c) => c.id === 'appliance-manager')).toMatchObject({
      commit: here.rev,
      dir: 'appliance',
    });
    expect(pins.components.find((c) => c.id === 'whombat-api')?.commit).toBe(cloud.rev);
    // The same build gives the same file: a rerun can stand on the gates of the first.
    const again = pinsOfBuild({
      repo: join(here.dir, 'appliance'),
      dir,
      build: { source: { rev: here.rev }, ship: { candidate: { file: '', name: '0.284.0' } } },
      find: { checkout: join(here.dir, 'appliance'), archives: [] },
      env: { WHOMBAT_CLOUD: cloud.dir, WHOMBAT_OPS: ops },
    });
    expect(readFileSync(again.file, 'utf8')).toBe(JSON.stringify(pins, null, 2).concat('\n'));
  });
});
