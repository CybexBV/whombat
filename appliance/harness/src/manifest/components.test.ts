import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_DIR } from '../lib/paths.ts';
import {
  COMPONENTS_FILE,
  ComponentList,
  cloudCommits,
  legacyCloud,
  pinsFor,
  readCloudRecords,
  writePinsAt,
} from './components.ts';
import { Pins } from './pins.ts';

const list = ComponentList.parse(JSON.parse(readFileSync(join(REPO_DIR, COMPONENTS_FILE), 'utf8')));
const A = 'a'.repeat(40);
const C = 'c'.repeat(40);
const R = 'd'.repeat(40);

const VERSIONS: Record<string, string> = {
  'packages/core/package.json': '4.10.0',
  'apps/web/package.json': '3.134.1',
  'package.json': '0.2.0',
};
const facts = (over: Partial<Parameters<typeof pinsFor>[1]> = {}): Parameters<typeof pinsFor>[1] => ({
  commit: A,
  time: 1_795_197_095,
  name: '0.284.0',
  sources: { whombat: '/src/whombat', cloud: '/src/cloud' },
  cloud: { control: C, relay: R },
  read: (_place, _commit, path) => JSON.stringify({ version: VERSIONS[path] }),
  ...over,
});

describe('the component list', () => {
  it('names no commit and no folder of a machine', () => {
    const text = readFileSync(join(REPO_DIR, COMPONENTS_FILE), 'utf8');
    expect(text).not.toMatch(/[0-9a-f]{40}/);
    expect(text).not.toMatch(/~\/|\/home\//);
    for (const c of list.components) expect(c).not.toHaveProperty('commit');
  });

  it('holds the appliance and the hosts service as folders of this repository', () => {
    const where = Object.fromEntries(list.components.map((c) => [c.id, `${c.in}:${c.dir ?? ''}`]));
    expect(where['appliance-manager']).toBe('whombat:appliance');
    expect(where['whombat-hosts']).toBe('whombat:hosts');
    expect(where['whombat-runtime']).toBe('whombat:');
    expect(where['whombat-api']).toBe('cloud:control');
    expect(where['whombat-relay']).toBe('cloud:relay');
  });
});

describe('the pins of a commit', () => {
  const pins = pinsFor(list, facts());
  const of = (id: string) => {
    const c = pins.components.find((x) => x.id === id);
    if (!c) throw new Error(`no ${id}`);
    return c;
  };

  it('pin every component of this repository at the commit, and control and the relay at theirs', () => {
    for (const c of pins.components)
      expect(c.commit).toBe(c.id === 'whombat-api' ? C : c.id === 'whombat-relay' ? R : A);
    expect(of('appliance-manager')).toMatchObject({ source: '/src/whombat', dir: 'appliance' });
    expect(of('appliance-manager').live).toBe('/src/whombat/appliance');
    expect(of('whombat-api')).toMatchObject({ source: '/src/cloud', dir: 'control' });
    expect(of('whombat-runtime').live).toBe('/src/whombat');
  });

  it('take each version from the commit, and fill it into the commands that name it', () => {
    expect(pins.contracts).toEqual({ version: '4.10.0', component: 'whombat-contracts' });
    expect(of('whombat-contracts').version).toBe('4.10.0');
    expect(of('whombat-app').version).toBe('3.134.1');
    expect(of('whombat-runtime').version).toBe('0.2.0');
    const sums = of('whombat-contracts').artifacts[0]?.from;
    expect(sums).toMatchObject({
      type: 'sums',
      path: 'dist-release/contracts/4.10.0/SHA256SUMS',
      compareWith: '/src/whombat/dist-release/contracts/4.10.0/SHA256SUMS',
    });
    expect(JSON.stringify(pins)).not.toMatch(/\{(contracts|app|whombat|cloud)\}/);
  });

  it('are named after the candidate and dated by the commit, the same every time', () => {
    expect(pins.productVersion).toBe('0.284.0');
    expect(pins.tuple.releaseId).toBe('rt-0.284.0');
    expect(pins.updatedAt).toBe(1_795_197_095);
    expect(pinsFor(list, facts())).toEqual(pins);
    expect(() => Pins.parse(pins)).not.toThrow();
  });

  it('refuse a short commit id and a package without a version', () => {
    expect(() => pinsFor(list, facts({ commit: 'abc1234' }))).toThrow(/full commit id/);
    expect(() => pinsFor(list, facts({ cloud: { control: C, relay: '' } }))).toThrow(/the relay/);
    expect(() => pinsFor(list, facts({ read: () => '{}' }))).toThrow(/names no version/);
  });
});

describe('which whombat-cloud commits a release runs against', () => {
  const records = [
    { version: '0.284.0', cloud: null },
    { version: '0.284.1', cloud: { rev: C, parts: ['control'] } },
    { version: '0.284.3', cloud: { rev: R, parts: ['control', 'relay'] } },
  ];
  const legacy = { control: 'e'.repeat(40), relay: 'f'.repeat(40) };

  it('is the newest record up to the candidate that deployed the part', () => {
    expect(cloudCommits({ given: null, records, upTo: '0.284.2', legacy })).toEqual({
      control: C,
      relay: legacy.relay,
    });
    expect(cloudCommits({ given: null, records, upTo: '0.284.3', legacy })).toEqual({ control: R, relay: R });
    expect(cloudCommits({ given: null, records, upTo: null, legacy })).toEqual({ control: R, relay: R });
  });

  it('is what the old flow last pinned while no record deployed the part', () => {
    expect(cloudCommits({ given: null, records, upTo: '0.284.0', legacy })).toEqual(legacy);
  });

  it('is the commit --cloud names, for both', () => {
    expect(cloudCommits({ given: A, records, upTo: '0.284.3', legacy })).toEqual({ control: A, relay: A });
  });

  it('stops when nothing names a part', () => {
    expect(() => cloudCommits({ given: null, records: [], upTo: null, legacy: null })).toThrow(/--cloud/);
    expect(() => cloudCommits({ given: null, records: [], upTo: null, legacy: { control: C } })).toThrow(
      /the relay/,
    );
  });

  it('reads the records and the old candidates from their folders', () => {
    const ops = mkdtempSync(join(tmpdir(), 'components-ops-'));
    mkdirSync(join(ops, 'records', 'releases'), { recursive: true });
    mkdirSync(join(ops, 'records', 'candidates'), { recursive: true });
    writeFileSync(
      join(ops, 'records', 'releases', '0.284.1.json'),
      JSON.stringify({ cloud: { rev: C, parts: ['control'] } }),
    );
    writeFileSync(join(ops, 'records', 'releases', 'notes.txt'), 'not a record');
    expect(readCloudRecords(ops)).toEqual([{ version: '0.284.1', cloud: { rev: C, parts: ['control'] } }]);
    expect(readCloudRecords(null)).toEqual([]);
    for (const [v, commit] of [
      ['0.283.2', R],
      ['0.99.0', A],
    ] as const)
      writeFileSync(
        join(ops, 'records', 'candidates', `${v}.json`),
        JSON.stringify({ components: [{ id: 'whombat-api', commit }] }),
      );
    writeFileSync(join(ops, 'records', 'candidates', '0.283.2.build-report.json'), '{}');
    expect(legacyCloud([join(ops, 'none'), join(ops, 'records', 'candidates')])).toEqual({ control: R });
    expect(legacyCloud([join(ops, 'none')])).toBeNull();
  });
});

describe('writing the pins of a commit', () => {
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
  const put = (repo: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'a commit');
    return sh(repo, 'rev-parse', 'HEAD');
  };
  const repo = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'components-repo-'));
    sh(dir, 'init', '-q', '-b', 'main');
    return { dir, rev: put(dir, files) };
  };
  const version = (v: string) => JSON.stringify({ version: v });
  const small = JSON.stringify({
    $schema: 'whombat.components/1',
    components: [
      { id: 'whombat-runtime', repository: 'Whombat', in: 'whombat', versionFrom: 'package.json' },
      {
        id: 'appliance-manager',
        repository: 'whombat-appliance',
        in: 'whombat',
        dir: 'appliance',
        version: '0.0.0-dev',
      },
      {
        id: 'whombat-api',
        repository: 'whombat-api',
        in: 'cloud',
        dir: 'control',
        versionFrom: 'package.json',
      },
      { id: 'whombat-relay', repository: 'whombat-relay', in: 'cloud', dir: 'relay', version: '0.0.0-dev' },
    ],
    tuple: list.tuple,
  });
  const whombat = repo({
    'appliance/flake.nix': '{}',
    [`appliance/${COMPONENTS_FILE}`]: small,
    'package.json': version('0.2.0'),
    'packages/core/package.json': version('4.10.0'),
    'apps/web/package.json': version('3.134.1'),
  });
  const cloud = repo({ 'control/package.json': version('0.1.0') });
  const ops = mkdtempSync(join(tmpdir(), 'components-ops-'));
  mkdirSync(join(ops, 'guards'));
  mkdirSync(join(ops, 'records', 'releases'), { recursive: true });
  writeFileSync(
    join(ops, 'records', 'releases', '0.284.0.json'),
    JSON.stringify({ cloud: { rev: cloud.rev, parts: ['control', 'relay'] } }),
  );
  const env = { WHOMBAT_CLOUD: cloud.dir, WHOMBAT_OPS: ops };
  const find = { checkout: whombat.dir, archives: [] };

  it('takes the list the commit holds, and control and the relay from the release records', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'components-out-')), 'validation', '0.284.0.json');
    const r = writePinsAt({ rev: whombat.rev, name: '0.284.0', out, find, env });
    expect(r.listFrom).toContain(`appliance/${COMPONENTS_FILE}`);
    expect(r.cloud).toEqual({ control: cloud.rev, relay: cloud.rev });
    const written = Pins.parse(JSON.parse(readFileSync(out, 'utf8')));
    expect(written.components.map((c) => `${c.id}@${c.commit}`)).toEqual([
      `whombat-runtime@${whombat.rev}`,
      `appliance-manager@${whombat.rev}`,
      `whombat-api@${cloud.rev}`,
      `whombat-relay@${cloud.rev}`,
    ]);
    expect(written.components[2]).toMatchObject({ source: cloud.dir, dir: 'control', version: '0.1.0' });
    expect(written.components[1]).toMatchObject({ source: whombat.dir, dir: 'appliance' });
  });

  it('stops for a whombat-cloud commit the checkout does not have', () => {
    writeFileSync(
      join(ops, 'records', 'releases', '0.284.1.json'),
      JSON.stringify({ cloud: { rev: 'b'.repeat(40), parts: ['control', 'relay'] } }),
    );
    const out = join(mkdtempSync(join(tmpdir(), 'components-out-')), 'pins.json');
    expect(() => writePinsAt({ rev: whombat.rev, name: '0.284.1', out, find, env })).toThrow(
      /is not in .*WHOMBAT_CLOUD/,
    );
    // An earlier candidate doesn't read the later record.
    expect(writePinsAt({ rev: whombat.rev, name: '0.284.0', out, find, env }).cloud.control).toBe(cloud.rev);
  });

  it('refuses a commit of the appliance’s old repository', () => {
    const old = repo({ 'flake.nix': '{}', 'nix/profiles/prod.nix': '{}' });
    const out = join(mkdtempSync(join(tmpdir(), 'components-out-')), 'pins.json');
    expect(() => writePinsAt({ rev: old.rev, out, find: { checkout: old.dir, archives: [] }, env })).toThrow(
      /old repository/,
    );
  });
});
