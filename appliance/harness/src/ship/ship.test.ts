import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_DIR, REPO_DIR, TMP_DIR } from '../lib/paths.ts';
import { newRunDir } from '../validate/validate.ts';
import { parseShipArgs, validateDuration } from './args.ts';
import { asImageReleases, pinnedRoot, provisionalTuple, reusedManagerOf, versionsAt } from './build.ts';
import { channelIdsOf, cloneChannelIds, holdHeavy, shipContext, together } from './context.ts';
import {
  BASELINE_RELEASE,
  compareIds,
  compareVersions,
  fromBaseline,
  idsFromTargets,
  newestBefore,
  newProdId,
  parseReleaseId,
  prodId,
} from './ids.ts';
import { LIVE_PATTERN, LIVE_SCENARIOS, liveEnv, selectsLive } from './live.ts';
import { type Compat, migrationsAfter, type ReleaseNotes, renderMarkdown, summarize } from './notes.ts';
import { builtFromOf, describeFailure, describePause, releaseRecord, runtimeContractsAt } from './record.ts';
import {
  AFTER,
  ChainError,
  type ChainedRecord,
  doneRecord,
  incomplete,
  nextChain,
  readRecord,
  requiredBefore,
  sha256Hex,
  verifyChain,
  writeRecord,
} from './records.ts';
import {
  channelNewest,
  claimedReleases,
  okApartFrom,
  passedOnly,
  pickPrevious,
  previousFromFile,
  reusableGates,
  reusableUpgradeGates,
  scenariosNotPassed,
  skipNotes,
  upgradeGatesCommand,
} from './validate.ts';

const tmp = () => mkdtempSync(join(TMP_DIR, 'ship-test-'));

describe('release ids', () => {
  it('parses NX-67 ids and refuses others', () => {
    expect(parseReleaseId('whombat-20260928.6')).toEqual({
      id: 'whombat-20260928.6',
      env: 'prod',
      gen: 1,
      day: '20260928',
      n: 6,
    });
    expect(parseReleaseId('whombat-dev-20260928.12')?.env).toBe('dev');
    expect(parseReleaseId('whombat-20260230.1')).toBeNull();
    expect(parseReleaseId('whombat-20260928.0')).toBeNull();
    expect(parseReleaseId('rt-2026.09.26-rc.9')).toBeNull();
    expect(parseReleaseId('proxmox-20260928.1')).toBeNull();
    expect(() => prodId('whombat-dev-20260928.1')).toThrow(/not a production release id/);
  });

  it('orders by day, then the counter numerically', () => {
    const p = (s: string) => parseReleaseId(s) as NonNullable<ReturnType<typeof parseReleaseId>>;
    expect(compareIds(p('whombat-20260928.10'), p('whombat-20260928.9'))).toBeGreaterThan(0);
    expect(compareIds(p('whombat-20260929.1'), p('whombat-20260928.10'))).toBeGreaterThan(0);
    expect(
      newestBefore(
        ['whombat-20260928.4', 'whombat-20260928.6', 'whombat-dev-20260928.9', 'whombat-20260929.1'],
        p('whombat-20260929.1'),
        'prod',
      ),
    ).toBe('whombat-20260928.6');
  });

  it('orders every whombat- id after every pve- id of its environment, as the helper orders hosts (PI-23)', () => {
    const p = (s: string) => parseReleaseId(s) as NonNullable<ReturnType<typeof parseReleaseId>>;
    expect(p('pve-dev-20261020.7')).toMatchObject({ env: 'dev', gen: 0, day: '20261020', n: 7 });
    expect(compareIds(p('whombat-dev-20261020.1'), p('pve-dev-20261021.7'))).toBeGreaterThan(0);
    expect(compareIds(p('whombat-20261001.1'), p('pve-20261002.5'))).toBeGreaterThan(0);
    // The boxes compare host versions (= release ids) with compareVersions: the same order.
    expect(compareVersions('whombat-dev-20261020.1', 'pve-dev-20261021.7')).toBeGreaterThan(0);
    expect(compareVersions('whombat-20261001.1', 'pve-20261002.5')).toBeGreaterThan(0);
    expect(compareVersions('whombat-dev-20261020.10', 'whombat-dev-20261020.9')).toBeGreaterThan(0);
    expect(newestBefore(['pve-20261002.5', 'whombat-20261020.1'], p('whombat-20261020.2'), 'prod')).toBe(
      'whombat-20261020.1',
    );
    expect(newestBefore(['pve-20261002.5', 'pve-20260930.2'], p('whombat-20261020.1'), 'prod')).toBe(
      'pve-20261002.5',
    );
  });

  it('builds no pve- id (PI-23)', () => {
    expect(prodId('pve-20261002.5').gen).toBe(0);
    expect(() => newProdId('pve-20261020.1')).toThrow(/whombat-YYYYMMDD.N/);
    expect(newProdId('whombat-20261020.1').gen).toBe(1);
  });

  it('reads release ids from TUF target names', () => {
    expect(
      idsFromTargets([
        `releases/${'a'.repeat(64)}.whombat-dev-20260928.1.json`,
        'runtime/0.1.0-x/whombat-runtime.closure',
        'releases/whombat-20260928.6.json',
      ]),
    ).toEqual(['whombat-dev-20260928.1', 'whombat-20260928.6']);
  });

  it('compares versions as the helper does, including the 0.2.0 transition (UP-A2)', () => {
    expect(compareVersions('0.1.0-e847497', '0.1.0-195421a')).toBeGreaterThan(0);
    for (const old of ['0.1.0-a2abeeb.p26a328c', '0.1.0-843d1ba', '0.1.0', '0.0.48-2be6fc1', '0.0.0-dev+abc'])
      expect(compareVersions(old, '0.2.0-20260928190000.abcdef1')).toBeLessThan(0);
    expect(compareVersions('0.2.0-20260928190000.aaaaaaa', '0.2.0-20260928190001.0000000')).toBeLessThan(0);
    expect(compareVersions('0.2.0-0.dev+x', '0.2.0-0')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0-0.dev+x', '0.2.0-20260928190632.2332f23')).toBeLessThan(0);
    expect(compareVersions('0.1.0', '0.2.0-0')).toBeLessThan(0);
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
  });
});

describe('the record chain', () => {
  const head = (dir: string, stage: Parameters<typeof nextChain>[2], ok = true, complete = true) =>
    nextChain(dir, 'whombat-20260929.1', stage, {
      twin: 'whombat-dev-20260929.1',
      ok,
      complete,
      notes: complete ? [] : ['skipped x'],
    });

  it('chains each record to the bytes of the one before', () => {
    const dir = tmp();
    writeRecord(dir, 'build', { chain: head(dir, 'build'), tuple: {} });
    const b = readRecord(dir, 'build');
    const g = head(dir, 'gates');
    expect(g.after).toEqual({ stage: 'build', file: 'build.json', sha256: b?.sha256 });
    writeRecord(dir, 'gates', { chain: g });
    writeRecord(dir, 'upgrade-gates', { chain: head(dir, 'upgrade-gates', true, false) });
    const chain = verifyChain(dir, 'whombat-20260929.1', 'upgrade-gates');
    expect(chain.map((c) => c.stage)).toEqual(['build', 'gates', 'upgrade-gates']);
    expect(incomplete(chain)).toEqual(['upgrade-gates.json: skipped x']);
  });

  it('refuses without the previous record, for another release, after a rebuild, or after a failure', () => {
    const dir = tmp();
    expect(() => head(dir, 'gates')).toThrow(/build.json is missing/);
    writeRecord(dir, 'build', { chain: head(dir, 'build') });
    writeRecord(dir, 'gates', { chain: head(dir, 'gates') });
    // Rebuilt: build.json changed, gates.json names the old bytes.
    const b = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')) as ChainedRecord;
    writeRecord(dir, 'build', { ...b, rebuilt: true });
    expect(() => verifyChain(dir, 'whombat-20260929.1', 'gates')).toThrow(/rebuilt or revalidated/);
    expect(() => verifyChain(dir, 'whombat-20260929.2', 'build')).toThrow(/record of whombat-20260929.1/);
    writeRecord(dir, 'gates', {
      chain: nextChain(dir, 'whombat-20260929.1', 'gates', {
        twin: null,
        ok: false,
        complete: true,
        notes: ['scenario x failed'],
      }),
    });
    expect(() => head(dir, 'upgrade-gates')).toThrow(ChainError);
    expect(() => head(dir, 'upgrade-gates')).toThrow(/gates.json failed \(scenario x failed\)/);
  });

  it('refuses a hand-made record', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'build.json'), '{"releaseId":"whombat-20260929.1"}\n');
    expect(() => verifyChain(dir, 'whombat-20260929.1', 'build')).toThrow(/no release\/ship chain/);
  });
});

const compat: Compat = {
  runtime: { readsFrom: '0002_c', writesFrom: '0002_c' },
  migrations: {
    '0000_a': { class: 'legacy' },
    '0001_b': { class: 'expand', readers: '0000_a', writers: '0000_a', note: 'adds b' },
    '0002_c': { class: 'contract', readers: '0002_c', writers: '0002_c' },
  },
};

describe('release notes', () => {
  it('lists the migrations since the previous schema with positions for tags', () => {
    expect(migrationsAfter(compat, 1)).toEqual([
      { tag: '0001_b', version: 2, class: 'expand', readers: 1, writers: 1, note: 'adds b' },
      { tag: '0002_c', version: 3, class: 'contract', readers: 3, writers: 3 },
    ]);
    expect(migrationsAfter(compat, 3)).toEqual([]);
    expect(migrationsAfter(compat, null)).toHaveLength(3);
  });

  it('numbers a chain after its schemaBase (Whombat report-trackers.md): its baseline follows the chain it replaced', () => {
    const next: Compat = {
      schemaBase: 76,
      runtime: { readsFrom: '0001_next', writesFrom: '0001_next' },
      migrations: {
        '0000_baseline': { class: 'incompatible', readers: '0000_baseline', writers: '0000_baseline' },
        '0001_next': { class: 'expand', readers: '0000_baseline', writers: '0000_baseline' },
      },
    };
    expect(migrationsAfter(next, 77)).toEqual([
      { tag: '0001_next', version: 78, class: 'expand', readers: 77, writers: 77 },
    ]);
    expect(migrationsAfter(next, null).map((m) => m.version)).toEqual([77, 78]);
  });

  const notes = (over: Partial<ReleaseNotes> = {}): ReleaseNotes => {
    const base = {
      v: 1 as const,
      releaseId: 'whombat-20260929.1',
      twin: 'whombat-dev-20260929.1',
      class: 'host' as const,
      previous: 'whombat-20260928.6',
      versions: {
        runtime: { from: '0.1.0-195421a', to: '0.2.0-20260929080000.abcdef1' },
        manager: { from: '0.1.0', to: '0.2.0-20260929080000.1234567' },
        host: { from: 'whombat-20260928.6', to: 'whombat-20260929.1' },
      },
      components: [
        {
          id: 'whombat-appliance',
          from: '6723564',
          to: 'abcdef1',
          commits: [{ rev: 'abc1234', subject: 'x' }],
          more: 2,
        },
      ],
      schema: { from: 49, to: 50 },
      migrations: [{ tag: '0049_x', version: 50, class: 'expand', readers: 49, writers: 49 }],
      knownIssues: [],
      ...over,
    };
    return { ...base, summary: summarize(base), generatedAt: '2026-09-29T08:00:00Z' };
  };

  it('summarizes in at most 500 characters and renders markdown', () => {
    const n = notes();
    expect(n.summary).toBe(
      'whombat-20260929.1: Whombat 0.2.0-20260929080000.abcdef1 (was 0.1.0-195421a), a new system image (the box restarts once), 1 database change (expand). 3 changes since whombat-20260928.6.',
    );
    const long = notes({ knownIssues: Array.from({ length: 5 }, () => 'x'.repeat(200)) });
    expect(long.summary.length).toBeLessThanOrEqual(500);
    const md = renderMarkdown(n);
    expect(md).toContain('| 0049_x | 50 | expand | 49 | 49 |');
    expect(md).toContain('- … and 2 more');
    expect(md).not.toContain('## Clients');
  });

  it('builds the record control keeps, with the gates by digest', () => {
    const dir = tmp();
    const n = notes();
    writeFileSync(join(dir, 'notes.json'), JSON.stringify(n));
    writeFileSync(join(dir, 'notes.md'), renderMarkdown(n));
    writeRecord(dir, 'build', {
      chain: nextChain(dir, n.releaseId, 'build', { twin: n.twin, ok: true, complete: true, notes: [] }),
    });
    const chain = verifyChain(dir, n.releaseId, 'build');
    const r = releaseRecord({
      env: 'dev',
      twin: n.releaseId,
      notesDir: dir,
      chain,
      builtFrom: { appliance: 'a'.repeat(40), contracts: '1.0.0' },
    });
    expect(r.gates?.build?.ok).toBe(true);
    expect(r.gates?.build?.sha256).toBe(chain[0]?.sha256);
    expect(r).toMatchObject({
      env: 'dev',
      twin: n.releaseId,
      migrations: [{ tag: '0049_x', version: 50 }],
      builtFrom: { contracts: '1.0.0' },
    });
    expect(r).not.toHaveProperty('apiLevel');
    expect(r).not.toHaveProperty('features');
  });
});

describe('every release record names the contracts its runtime vendors (IN-420)', () => {
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  /** A Whombat checkout with one commit whose package.json depends on `core`, and an appliance repo pinning it. */
  const setup = (core: string | null, ownCore?: string) => {
    const d = tmp();
    const whombat = join(d, 'Whombat');
    mkdirSync(whombat);
    sh(whombat, 'init', '-q');
    writeFileSync(
      join(whombat, 'package.json'),
      JSON.stringify({ name: 'whombat', dependencies: core ? { '@whombat/core': core } : {} }),
    );
    sh(whombat, 'add', 'package.json');
    if (ownCore) {
      mkdirSync(join(whombat, 'packages', 'core'), { recursive: true });
      writeFileSync(
        join(whombat, 'packages', 'core', 'package.json'),
        JSON.stringify({ name: '@whombat/core', version: ownCore }),
      );
      sh(whombat, 'add', 'packages/core/package.json');
    }
    sh(whombat, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'x');
    const rev = sh(whombat, 'rev-parse', 'HEAD');
    mkdirSync(join(d, 'manifest', 'candidates'), { recursive: true });
    writeFileSync(
      join(d, 'manifest', 'candidates', '1.0.0.json'),
      JSON.stringify({
        components: [
          { id: 'whombat-runtime', commit: rev, source: whombat },
          { id: 'whombat-app', commit: 'b'.repeat(40), version: '0.128.0', tag: 'app-v0.128.0' },
        ],
      }),
    );
    const build = {
      source: { rev: 'a'.repeat(40) },
      runtime: { whombatRev: rev },
      ship: { candidate: { file: 'manifest/candidates/1.0.0.json' } },
    };
    return { d, whombat, rev, build };
  };

  it('reads the @whombat/core tarball the runtime’s package.json depends on', async () => {
    const t = setup('file:vendor/whombat-contracts/1.0.0/whombat-core-1.0.0.tgz');
    expect(await runtimeContractsAt(t.whombat, t.rev)).toBe('1.0.0');
    expect(await builtFromOf(t.d, t.build)).toEqual({
      appliance: 'a'.repeat(40),
      whombat: t.rev,
      app: 'app-v0.128.0',
      contracts: '1.0.0',
    });
    // Recorded by release/ship build: no checkout needed.
    const recorded = { ...t.build, ship: { ...t.build.ship, contracts: '1.0.1' } };
    expect((await builtFromOf(t.d, recorded)).contracts).toBe('1.0.1');
  });

  it('reads the runtime’s own packages/core once Whombat holds the contracts', async () => {
    const t = setup(null, '3.0.1');
    expect(await runtimeContractsAt(t.whombat, t.rev)).toBe('3.0.1');
    expect((await builtFromOf(t.d, t.build)).contracts).toBe('3.0.1');
  });

  it('refuses a record when they can’t be read, instead of leaving them out', async () => {
    const t = setup(null);
    await expect(runtimeContractsAt(t.whombat, t.rev)).rejects.toThrow(/must name them \(IN-420\)/);
    await expect(builtFromOf(t.d, t.build)).rejects.toThrow(/@whombat\/core is missing/);
    await expect(runtimeContractsAt(join(t.d, 'nowhere'), t.rev)).rejects.toThrow(/no Whombat checkout/);
    await expect(runtimeContractsAt(t.whombat, 'c'.repeat(40))).rejects.toThrow(/is not in/);
  });
});

describe('arguments', () => {
  it('parses each stage', () => {
    const b = parseShipArgs(['build', 'whombat-20260929.1', '--known-issue', 'a', '--known-issue', 'b']);
    expect(b.build).toEqual({
      reuseHost: null,
      forceHost: false,
      knownIssues: ['a', 'b'],
      newerCheck: true,
      previous: null,
      runtimeStamp: null,
      candidate: null,
    });
    expect(() => parseShipArgs(['build', 'x', '--client-floor', 'web=3'])).toThrow(
      /unknown option --client-floor/,
    );
    expect(() => parseShipArgs(['validate', 'x', '--skip-skew'])).toThrow(/unknown option --skip-skew/);
    expect(
      parseShipArgs(['validate', 'whombat-20260929.1', '--previous', 'whombat-20260928.6,whombat-20260928.4'])
        .validate.previous,
    ).toEqual(['whombat-20260928.6', 'whombat-20260928.4']);
    expect(parseShipArgs(['validate', 'whombat-20260929.7', '--serial']).validate.serial).toBe(true);
    expect(parseShipArgs(['validate', 'whombat-20260929.7']).validate.serial).toBe(false);
  });

  it('refuses what a stage doesn’t take', () => {
    expect(() => parseShipArgs([])).toThrow(/usage/);
    expect(() => parseShipArgs(['build'])).toThrow(/<prod id>/);
    expect(() => parseShipArgs(['build', 'whombat-20260929.1', '--yes'])).toThrow(/unknown option --yes/);
    expect(() => parseShipArgs(['build', 'x', '--previous', 'a', '--previous', 'b'])).toThrow(/given twice/);
    expect(() => parseShipArgs(['validate', 'x', '--jobs'])).toThrow(/needs a value/);
    expect(() => validateDuration('two hours')).toThrow(/bad duration/);
  });

  it('says where the stages and options that went with DEV went (ONE-01, ONE-19)', () => {
    expect(() => parseShipArgs(['publish-dev', 'whombat-20260929.1'])).toThrow(
      /candidate publishes a release to Beta/,
    );
    expect(() => parseShipArgs(['promote-prod', 'whombat-20260929.1', '--yes'])).toThrow(
      /whombat-ops promote <id> --yes/,
    );
    expect(() => parseShipArgs(['all', 'whombat-20260929.1'])).toThrow(/went with DEV/);
    for (const o of ['--dev-only', '--ahead-of-line'])
      expect(() => parseShipArgs(['build', 'whombat-20260929.1', o])).toThrow(/the DEV twin went with DEV/);
    for (const o of ['--twin', '--reuse-host-twin', '--dev-allow-downgrade-from', '--override-input'])
      expect(() => parseShipArgs(['build', 'whombat-20260929.1', o, 'x'])).toThrow(
        /the DEV twin went with DEV/,
      );
    expect(() => parseShipArgs(['status', '--dev'])).toThrow(/DEV is gone/);
    expect(parseShipArgs(['status']).command).toBe('status');
  });
});

describe('failures and pauses in words', () => {
  it('renders a failure detail from its fields', () => {
    expect(
      describeFailure({
        failure: 'schema_incompatible',
        failureDetail: {
          stage: 'Staged',
          code: 'schema_incompatible',
          reasons: ['candidate_cannot_read_schema'],
          schema: { database: 48, target: null, candidateWrites: 49 },
        },
      }),
    ).toBe(
      'schema_incompatible at Staged; reasons candidate_cannot_read_schema; database 48, candidate writes 49, target —',
    );
    expect(describeFailure({ failure: 'unhealthy' })).toBe('failure unhealthy');
    // A complete detail renders as the admin panel and the owner see it (contracts' describeUpdateFailure, CT-137).
    const full = {
      stage: 'Verifying',
      code: 'unhealthy',
      reasons: [],
      release: 'whombat-dev-20260929.3',
      failedChecks: ['runtime'],
      at: 1_790_580_000,
    };
    expect(describeFailure({ failureDetail: full })).toBe(
      'whombat-dev-20260929.3 started but failed its health checks (the Whombat service). This Whombat went back to the release it ran before.',
    );
    expect(
      describePause({ pauseReason: 'device_failed', pauseDetail: { device: 'wb-a', failureDetail: full } }),
    ).toMatch(/^device_failed: wb-a — whombat-dev-20260929.3 started but failed its health checks/);
    expect(describePause({ pauseReason: 'operator', pauseDetail: null })).toBe('operator');
  });
});

describe('what a build is made of', () => {
  it('takes the runtime stamp and the candidate number it is given', () => {
    const stamp = `${'a'.repeat(40)}:1795107600:20261119160000`;
    const p = parseShipArgs([
      'build',
      'whombat-20261121.1',
      '--runtime-stamp',
      stamp,
      '--candidate',
      '0.284.0',
    ]);
    expect(p.build).toMatchObject({ runtimeStamp: stamp, candidate: '0.284.0', reuseHost: null });
    expect(parseShipArgs(['build', 'whombat-20261121.1']).build).toMatchObject({
      runtimeStamp: null,
      candidate: null,
    });
  });

  it('reads the contracts and the app version of a commit from the repository itself', async () => {
    const dir = tmp();
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    for (const [path, version] of [
      ['packages/core/package.json', '4.10.0'],
      ['apps/web/package.json', '3.134.0'],
    ] as const) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), JSON.stringify({ version }));
    }
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'versions');
    expect(await versionsAt(dir, git('rev-parse', 'HEAD'))).toEqual({ contracts: '4.10.0', app: '3.134.0' });
    await expect(versionsAt(dir, 'f'.repeat(40))).rejects.toThrow(/names no version/);
  });

  it('checks newer with the versions a build will have, before building (UP-A3)', () => {
    const t = provisionalTuple(
      'whombat-20260929.1',
      {
        runtime: { version: '0.2.0-20260929080000.abcdef1', outPath: '/nix/store/r' },
        manager: { version: '0.2.0-20260929080000.1234567', outPath: '/nix/store/m' },
        toplevel: '/nix/store/t',
        hostAbi: 1,
      },
      { version: 'whombat-20260929.1', storePath: '/nix/store/t' },
    );
    expect(t).toMatchObject({
      releaseId: 'whombat-20260929.1',
      host: { version: 'whombat-20260929.1', storePath: '/nix/store/t' },
      runtime: { version: '0.2.0-20260929080000.abcdef1' },
      manager: { version: '0.2.0-20260929080000.1234567' },
    });
  });
});

describe('validate: reused upgrade gates and the scenarios that didn’t pass', () => {
  it('reuses only a passing run of the same build and previous releases', () => {
    const dir = tmp();
    const f = join(dir, 'runner.json');
    const rec = (o: Record<string, unknown> = {}) =>
      writeFileSync(
        f,
        JSON.stringify({
          ok: true,
          buildSha256: 'b'.repeat(64),
          previous: [{ releaseId: 'whombat-20260928.6' }, { releaseId: 'whombat-20260928.4' }],
          gates: [{ id: 1, ok: true }],
          at: '2026-09-29T00:00:00Z',
          ...o,
        }),
      );
    const prev = ['whombat-20260928.6', 'whombat-20260928.4'];
    expect(reusableUpgradeGates(f, 'b'.repeat(64), prev)).toBeNull(); // no file yet
    rec();
    expect(reusableUpgradeGates(f, 'b'.repeat(64), prev)?.at).toBe('2026-09-29T00:00:00Z');
    expect(reusableUpgradeGates(f, 'c'.repeat(64), prev)).toBeNull(); // another build
    expect(reusableUpgradeGates(f, 'b'.repeat(64), ['whombat-20260928.7', 'whombat-20260928.6'])).toBeNull();
    rec({ ok: false });
    expect(reusableUpgradeGates(f, 'b'.repeat(64), prev)).toBeNull();
    rec({ breakCandidate: 'runtime' });
    expect(reusableUpgradeGates(f, 'b'.repeat(64), prev)).toBeNull();
  });

  it('names the scenarios that didn’t pass, by file, with why', () => {
    const k = (n: number) => `k live agents K${n}`;
    const report = {
      ok: false,
      totals: {},
      manifest: { ok: true, problems: [] },
      scenarios: [
        { file: 'scenarios/a-vertical-slice.scenario.ts', name: 'a 1', outcome: 'passed' },
        ...[1, 2].map((n) => ({
          file: 'scenarios/k-live-agents.scenario.ts',
          name: k(n),
          outcome: 'blocked',
          blocked: 'whombat-appliance/live-agents',
        })),
        {
          file: 'scenarios/r-browser.scenario.ts',
          name: 'r 1',
          outcome: 'failed',
          error: 'AssertionError: x',
        },
      ],
      records: [1, 2].map((n) => ({
        kind: 'blocked',
        test: k(n),
        gap: 'whombat-appliance/live-agents',
        detail: 'the environment runs scripted agents (start it with WB_MGD_AGENTS=live)',
      })),
    };
    expect(scenariosNotPassed(report)).toEqual([
      {
        file: 'k-live-agents.scenario.ts',
        outcome: 'blocked',
        count: 2,
        why: 'the environment runs scripted agents (start it with WB_MGD_AGENTS=live)',
      },
      { file: 'r-browser.scenario.ts', outcome: 'failed', count: 1, why: 'AssertionError: x' },
    ]);
  });
});

describe('validate: the VM upgrade gates on another machine (WB_UPGRADE_GATES_RUN)', () => {
  const runner = '/repo/appliance/release/upgrade-gates';
  const args = ['--candidate', '/r/c/build.json', '--previous', '/r/p/build.json', '--out', '/l/ug.json'];

  it('runs this tree’s runner here when nothing is named', () => {
    expect(upgradeGatesCommand(runner, [...args, '--no-lock'], {})).toEqual({
      cmd: runner,
      args: [...args, '--no-lock'],
      elsewhere: false,
    });
    expect(upgradeGatesCommand(runner, args, { WB_UPGRADE_GATES_RUN: '  ' }).elsewhere).toBe(false);
  });

  it('hands the named command the runner’s arguments, without this machine’s lock', () => {
    const there = upgradeGatesCommand(runner, [...args, '--no-lock'], {
      WB_UPGRADE_GATES_RUN: ' /ops/bin/gates-elsewhere  --ttl 3h ',
    });
    expect(there).toEqual({
      cmd: '/ops/bin/gates-elsewhere',
      args: ['--ttl', '3h', ...args],
      elsewhere: true,
    });
  });

  it('is what a validate run starts: the named command leaves the record, and a record of another build fails', async () => {
    // A stand-in for the other machine: it writes the record the runner would, for the build it was given.
    const dir = tmp();
    const there = join(dir, 'gates-elsewhere');
    writeFileSync(
      there,
      `#!/usr/bin/env bash
while [ $# -gt 0 ]; do case $1 in --candidate) c=$2; shift 2 ;; --out) o=$2; shift 2 ;; *) shift ;; esac; done
sha=$(sha256sum "$c" | cut -d' ' -f1)
[ -z "\${WRONG_BUILD:-}" ] || sha=0000
printf '{"v":1,"ok":true,"buildSha256":"%s","previous":[],"gates":[{"id":"1","ok":true}],"at":"now"}' "$sha" >"$o"
`,
      { mode: 0o755 },
    );
    const build = join(dir, 'build.json');
    writeFileSync(build, '{"v":1}');
    const out = join(dir, 'ug.json');
    const { spawnSync } = await import('node:child_process');
    const start = (env: NodeJS.ProcessEnv) => {
      const g = upgradeGatesCommand(runner, ['--candidate', build, '--out', out, '--no-lock'], {
        WB_UPGRADE_GATES_RUN: there,
      });
      expect(spawnSync(g.cmd, g.args, { env: { ...process.env, ...env } }).status).toBe(0);
      return JSON.parse(readFileSync(out, 'utf8')) as { buildSha256: string };
    };
    expect(reusableUpgradeGates(out, sha256Hex(readFileSync(build)), [])).toBeNull();
    expect(start({}).buildSha256).toBe(sha256Hex(readFileSync(build)));
    expect(reusableUpgradeGates(out, sha256Hex(readFileSync(build)), [])).not.toBeNull();
    start({ WRONG_BUILD: '1' });
    expect(reusableUpgradeGates(out, sha256Hex(readFileSync(build)), [])).toBeNull();
  });
});

describe('the live-agent scenarios in an environment of their own (IN-108)', () => {
  const ports = {
    postgres: 55493,
    control: 5500,
    controlAdmin: 5501,
    controlPanel: 5502,
    relay: 5510,
    relayAdmin: 5511,
    runtime: 5520,
    direct: 5521,
    web: 5530,
    restic: 5540,
    tuf: 5549,
    embed: 5550,
    hostsAgent: 5553,
  };

  it('derives the live environment from the caller’s: -live home and container, ports +400, live agents', () => {
    expect(liveEnv({ home: '/h/mgd-ship', container: 'whombat-mgd-pg-ship', ports })).toEqual({
      WB_MGD_HOME: '/h/mgd-ship-live',
      WB_MGD_PG_CONTAINER: 'whombat-mgd-pg-ship-live',
      WB_MGD_PG_PORT: '55893',
      CONTROL_PORT: '5900',
      CONTROL_ADMIN_PORT: '5901',
      CONTROL_PANEL_PORT: '5902',
      RELAY_PORT: '5910',
      RELAY_ADMIN_PORT: '5911',
      RUNTIME_PORT: '5920',
      WB_MGD_DIRECT_PORT: '5921',
      WEB_PORT: '5930',
      RESTIC_PORT: '5940',
      WB_MGD_TUF_PORT: '5949',
      EMBED_PORT: '5950',
      WB_MGD_HOSTS_AGENT_PORT: '5953',
      WB_MGD_AGENTS: 'live',
    });
  });

  it('runs them unless --scenarios selects others', () => {
    expect(LIVE_SCENARIOS.every((f) => f.startsWith(LIVE_PATTERN))).toBe(true);
    expect(
      readdirSync(join(HARNESS_DIR, 'scenarios'))
        .filter((f) => f.includes(LIVE_PATTERN))
        .sort(),
    ).toEqual([...LIVE_SCENARIOS].sort());
    expect(selectsLive(null)).toBe(true);
    expect(selectsLive('k-live')).toBe(true);
    expect(selectsLive('0-platform')).toBe(false);
  });

  it('judges the scripted run apart from them, and the live run by them alone', () => {
    const sc = (file: string, outcome: string) => ({
      file: `scenarios/${file}`,
      name: `${file} ${outcome}`,
      outcome,
    });
    const base = {
      ok: false,
      totals: {},
      manifest: { ok: true, problems: [] },
      harness: { outcome: 'passed' },
      gates: [],
    };
    const scripted = {
      ...base,
      scenarios: [sc('a-vertical-slice.scenario.ts', 'passed'), sc('k-live-agents.scenario.ts', 'blocked')],
    };
    expect(okApartFrom(scripted, ['k-live-agents.scenario.ts'])).toBe(true);
    expect(okApartFrom(scripted, [])).toBe(false);
    expect(okApartFrom({ ...scripted, gates: [{ outcome: 'failed' }] }, ['k-live-agents.scenario.ts'])).toBe(
      false,
    );
    expect(scenariosNotPassed(scripted, ['k-live-agents.scenario.ts'])).toEqual([]);
    const live = (outcome: string) => ({ ...base, scenarios: [sc('k-live-agents.scenario.ts', outcome)] });
    expect(passedOnly(live('passed'), ['k-live-agents.scenario.ts'])).toBe(true);
    expect(passedOnly(live('blocked'), ['k-live-agents.scenario.ts'])).toBe(false);
    expect(passedOnly({ ...base, scenarios: [] }, ['k-live-agents.scenario.ts'])).toBe(false);
  });
});

describe('N−1/N−2 from claimed boxes, the reused manager (ru-ship-fix3)', () => {
  const dev = (device: string, state: string, release?: string) => ({
    device,
    state,
    status: release ? { release } : undefined,
  });

  it('counts only claimed boxes running a production release from the baseline on, newest first', () => {
    expect(
      claimedReleases([
        dev('a', 'claimed', 'whombat-20261115.11'),
        dev('b', 'unclaimed', 'whombat-20261115.13'),
        dev('c', 'claimed', 'whombat-20261116.4'),
        dev('d', 'claimed', 'whombat-20261116.4'),
        dev('e', 'retired', 'whombat-20261117.1'),
        dev('f', 'claimed', 'whombat-dev-20261117.4'),
        dev('g', 'claimed'),
        dev('h', 'claimed', 'whombat-20261115.20'),
        // From before the migration baseline (IN-415, IN-768): nothing updates from it.
        dev('i', 'claimed', 'whombat-20261115.6'),
        dev('j', 'claimed', 'whombat-20261023.4'),
        dev('k', 'claimed', 'pve-20261002.5'),
      ]),
    ).toEqual(['whombat-20261116.4', 'whombat-20261115.20', 'whombat-20261115.11']);
    expect(claimedReleases([dev('b', 'unclaimed', 'whombat-20261115.13')])).toEqual([]);
  });

  it('reads previous.json: production ids from the baseline on, maybe none', () => {
    const d = tmp();
    mkdirSync(join(d, 'vm-tests', 'upgrade-gates'), { recursive: true });
    const f = join(d, 'vm-tests', 'upgrade-gates', 'previous.json');
    writeFileSync(f, JSON.stringify({ previous: ['whombat-20261116.4', 'whombat-20261115.11'] }));
    expect(previousFromFile(d)).toEqual(['whombat-20261116.4', 'whombat-20261115.11']);
    writeFileSync(f, JSON.stringify({ previous: [] }));
    expect(previousFromFile(d)).toEqual([]);
    for (const bad of ['whombat-dev-20261116.4', 'whombat-20261115.6', 'pve-20261002.5']) {
      writeFileSync(f, JSON.stringify({ previous: [bad] }));
      expect(() => previousFromFile(d)).toThrow(/from the migration baseline on \(whombat-20261115\.11\)/);
    }
    for (const id of previousFromFile(REPO_DIR)) expect(fromBaseline(prodId(id))).toBe(true);
    expect(fromBaseline(prodId(BASELINE_RELEASE))).toBe(true);
  });

  it('takes the previous releases from what boxes run: control, then the channels, then the file', () => {
    const beta = [
      'whombat-dev-20261119.9',
      'whombat-20261120.18',
      'whombat-20261120.19',
      'whombat-20261115.6',
    ];
    const production = ['whombat-20261120.5'];
    // The newest of each channel, newest first; ids of the old DEV family and from before the baseline don't count.
    expect(channelNewest(beta, production)).toEqual(['whombat-20261120.19', 'whombat-20261120.5']);
    expect(channelNewest(['whombat-20261120.5'], production)).toEqual(['whombat-20261120.5']);
    expect(channelNewest(beta, null)).toEqual(['whombat-20261120.19']);
    expect(channelNewest(['whombat-dev-20261119.9'], [])).toEqual([]);
    expect(channelNewest(null, null)).toBeNull();

    const listed = ['whombat-20261120.19', 'whombat-20261120.5'];
    const file = ['whombat-20261115.13', 'whombat-20261115.11'];
    // Two releases reported to control: those.
    expect(
      pickPrevious(['whombat-20261120.19', 'whombat-20261120.18', 'whombat-20261120.5'], listed, file).ids,
    ).toEqual(['whombat-20261120.19', 'whombat-20261120.18']);
    // One: N−2 is the channels' newest release older than it, never a stale file's.
    expect(pickPrevious(['whombat-20261120.19'], listed, file)).toEqual({
      ids: ['whombat-20261120.19', 'whombat-20261120.5'],
      from: 'the release claimed boxes run (control), then the newest release Beta and Production list',
    });
    // None, or no control: what the channels list.
    expect(pickPrevious([], listed, file).ids).toEqual(listed);
    expect(pickPrevious(null, listed, file).from).toBe('the newest release Beta and Production list');
    // The file only when the update repository can't be read, or lists nothing to update from.
    expect(pickPrevious(null, null, file)).toEqual({
      ids: file,
      from: 'vm-tests/upgrade-gates/previous.json',
    });
    expect(pickPrevious(['whombat-20261120.19'], [], file).ids).toEqual([
      'whombat-20261120.19',
      'whombat-20261115.13',
    ]);
    // Nothing older anywhere: one previous release, and the gate from N−2 is not applicable.
    expect(pickPrevious(['whombat-20261115.11'], ['whombat-20261115.11'], []).ids).toEqual([
      'whombat-20261115.11',
    ]);
  });

  it('takes the manager a runtime-only release keeps from the reused host’s build', () => {
    const b = {
      build: { tuple: { manager: { version: '0.2.0-20260928190000.dbbadbe', storePath: '/nix/store/m' } } },
    };
    expect(reusedManagerOf(b)).toEqual({
      version: '0.2.0-20260928190000.dbbadbe',
      storePath: '/nix/store/m',
    });
    expect(reusedManagerOf(null)).toBeNull();
    expect(reusedManagerOf({ build: {} })).toBeNull();
  });
});

describe('validate reuses a passing gates.json of the same build (ru-ship-fix4)', () => {
  const build = 'b'.repeat(64);
  const pins = 'manifest/candidates/0.19.2.json';
  const pinsSha256 = 'p'.repeat(64);
  const full = { skipGates: false, scenarios: null, demo: true };
  const want = { buildSha256: build, pins, pinsSha256, skips: skipNotes(full) };
  // The shape of whombat-20260929.2's gates.json (eacc0cf8): no pinsSha256 yet.
  const rec = (over: Record<string, unknown> = {}, chain: Record<string, unknown> = {}) => ({
    sha256: 'e'.repeat(64),
    record: {
      chain: {
        stage: 'gates' as const,
        releaseId: 'whombat-20260929.2',
        twin: 'whombat-dev-20260929.6',
        after: { stage: 'build' as const, file: 'build.json', sha256: build },
        ok: true,
        complete: true,
        notes: [] as string[],
        at: '2026-09-29T10:22:16.494Z',
        ...chain,
      },
      pins,
      ...over,
    },
  });

  it('reuses a passing record of this build and these pins', () => {
    expect(reusableGates(rec(), want)).toEqual({ reuse: true });
    expect(reusableGates(rec({ pinsSha256 }), want)).toEqual({ reuse: true });
    // A complete run stands for a run that skips something.
    expect(reusableGates(rec(), { ...want, skips: skipNotes({ ...full, demo: false }) })).toEqual({
      reuse: true,
    });
  });

  it('runs them again for another build, other pins, a failure or a skip', () => {
    const why = (r: ReturnType<typeof reusableGates>) => (r.reuse ? 'reused' : r.why);
    expect(why(reusableGates(null, want))).toBe('no gates.json');
    expect(why(reusableGates(rec({}, { ok: false }), want))).toBe('it did not pass');
    expect(why(reusableGates(rec(), { ...want, buildSha256: 'c'.repeat(64) }))).toMatch(/another build.json/);
    expect(why(reusableGates(rec({ pins: 'manifest/candidates/0.19.1.json' }), want))).toMatch(/it ran/);
    expect(why(reusableGates(rec({ pinsSha256: 'q'.repeat(64) }), want))).toMatch(/changed since/);
    expect(
      why(reusableGates(rec({}, { complete: false, notes: ['demo skipped (--no-demo)'] }), want)),
    ).toMatch(/left out what this run wants: demo skipped/);
  });

  it('parses --rerun-gates', () => {
    expect(parseShipArgs(['validate', 'whombat-20260929.2', '--rerun-gates']).validate.rerunGates).toBe(true);
    expect(parseShipArgs(['validate', 'whombat-20260929.2']).validate.rerunGates).toBe(false);
  });
});

describe('two branches after build.json (IN-115)', () => {
  const id = 'whombat-20260929.7';
  const head = (dir: string, stage: Parameters<typeof nextChain>[2], ok = true, complete = true) =>
    nextChain(dir, id, stage, {
      twin: 'whombat-dev-20260929.9',
      ok,
      complete,
      notes: complete ? [] : ['skipped x'],
    });
  const built = () => {
    const dir = tmp();
    writeRecord(dir, 'build', { chain: head(dir, 'build'), tuple: {} });
    return dir;
  };

  it('publish-dev follows build.json alone, so it can run while validate does', () => {
    expect(AFTER['dev-soak']).toEqual(['build']);
    expect([...requiredBefore('promote')].sort()).toEqual(['build', 'dev-soak', 'gates', 'upgrade-gates']);
    const dir = built();
    const d = head(dir, 'dev-soak');
    expect(d.after).toEqual({ stage: 'build', file: 'build.json', sha256: readRecord(dir, 'build')?.sha256 });
    writeRecord(dir, 'dev-soak', { chain: d });
    expect(verifyChain(dir, id, 'dev-soak').map((c) => c.stage)).toEqual(['build', 'dev-soak']);
    // validate afterwards (or at the same time): its records don't touch dev-soak.json's link.
    writeRecord(dir, 'gates', { chain: head(dir, 'gates') });
    writeRecord(dir, 'upgrade-gates', { chain: head(dir, 'upgrade-gates') });
    writeRecord(dir, 'gates', { chain: head(dir, 'gates'), rerun: true });
    expect(() => verifyChain(dir, id, 'dev-soak')).not.toThrow();
    expect(() => verifyChain(dir, id, 'upgrade-gates')).toThrow(
      /upgrade-gates.json follows another gates.json/,
    );
  });

  it('promote-prod needs both branches, ok, for the same build.json', () => {
    const dir = built();
    expect(() => verifyChain(dir, id, AFTER.promote)).toThrow(
      /dev-soak.json is missing .*release\/ship publish-dev whombat-20260929.7/,
    );
    writeRecord(dir, 'dev-soak', { chain: head(dir, 'dev-soak') });
    expect(() => head(dir, 'promote')).toThrow(/gates.json is missing .*release\/ship validate/);
    writeRecord(dir, 'gates', { chain: head(dir, 'gates') });
    writeRecord(dir, 'upgrade-gates', { chain: head(dir, 'upgrade-gates', false) });
    expect(() => head(dir, 'promote')).toThrow(/upgrade-gates.json failed/);
    writeRecord(dir, 'upgrade-gates', { chain: head(dir, 'upgrade-gates', true, false) });
    const p = head(dir, 'promote');
    expect(p.after?.stage).toBe('dev-soak');
    expect(p.alsoAfter?.map((l) => l.stage)).toEqual(['upgrade-gates']);
    const chain = verifyChain(dir, id, AFTER.promote);
    expect(chain.map((c) => c.stage)).toEqual(['build', 'gates', 'upgrade-gates', 'dev-soak']);
    expect(incomplete(chain)).toEqual(['upgrade-gates.json: skipped x']);
    writeRecord(dir, 'promote', { chain: p });
    expect(verifyChain(dir, id, 'promote').map((c) => c.stage)).toEqual([
      'build',
      'gates',
      'upgrade-gates',
      'dev-soak',
      'promote',
    ]);
    // A rebuild breaks both branches.
    const b = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')) as ChainedRecord;
    writeRecord(dir, 'build', { ...b, rebuilt: true });
    expect(() => verifyChain(dir, id, 'dev-soak')).toThrow(/dev-soak.json follows another build.json/);
    expect(doneRecord(dir, id, 'promote').chain).toBeNull();
  });

  it('still reads the single line before IN-115 (dev-soak.json after upgrade-gates.json)', () => {
    const dir = built();
    writeRecord(dir, 'gates', { chain: head(dir, 'gates') });
    writeRecord(dir, 'upgrade-gates', { chain: head(dir, 'upgrade-gates') });
    const ug = readRecord(dir, 'upgrade-gates');
    const legacy = {
      ...head(dir, 'dev-soak'),
      after: { stage: 'upgrade-gates' as const, file: 'upgrade-gates.json', sha256: ug?.sha256 ?? '' },
    };
    writeRecord(dir, 'dev-soak', { chain: legacy });
    expect(verifyChain(dir, id, 'dev-soak').map((c) => c.stage)).toEqual([
      'build',
      'gates',
      'upgrade-gates',
      'dev-soak',
    ]);
    const ds = readRecord(dir, 'dev-soak');
    const oldPromote = {
      ...head(dir, 'dev-soak'),
      stage: 'promote' as const,
      after: { stage: 'dev-soak' as const, file: 'dev-soak.json', sha256: ds?.sha256 ?? '' },
    };
    writeRecord(dir, 'promote', { chain: oldPromote });
    expect(() => verifyChain(dir, id, 'promote')).not.toThrow();
    // A new-style dev-soak with a promote.json that names only it doesn't cover validate's branch.
    writeRecord(dir, 'dev-soak', { chain: head(dir, 'dev-soak') });
    const ds2 = readRecord(dir, 'dev-soak');
    writeRecord(dir, 'promote', {
      chain: {
        ...oldPromote,
        after: { stage: 'dev-soak', file: 'dev-soak.json', sha256: ds2?.sha256 ?? '' },
      },
    });
    expect(() => verifyChain(dir, id, 'promote')).toThrow(/promote.json doesn't follow upgrade-gates.json/);
    // A link no record of that stage ever has.
    writeRecord(dir, 'gates', {
      chain: {
        ...head(dir, 'gates'),
        after: { stage: 'dev-soak', file: 'dev-soak.json', sha256: ds2?.sha256 ?? '' },
      },
    });
    expect(() => verifyChain(dir, id, 'gates')).toThrow(
      /gates.json follows dev-soak.json, which no gates.json follows/,
    );
    expect(sha256Hex('x')).toHaveLength(64);
  });
});

describe('the parallel parts of validate (IN-116)', () => {
  it('holds the heavy lock for the parts it runs side by side, and lets it go', async () => {
    const lock = join(tmp(), 'heavy.lock');
    const ctx = { ...shipContext(tmp()), heavyLock: lock };
    const held = await holdHeavy(ctx);
    expect(held.ctx.heavyHeld).toBe(true);
    const { spawnSync } = await import('node:child_process');
    expect(spawnSync('flock', ['-n', lock, 'true']).status).not.toBe(0);
    await held.release();
    expect(spawnSync('flock', ['-n', lock, 'true']).status).toBe(0);
  });

  it('waits for both parts even when one fails', async () => {
    let slowDone = false;
    await expect(
      together(
        () => Promise.reject(new Error('validate failed')),
        () =>
          new Promise((r) =>
            setTimeout(() => {
              slowDone = true;
              r(true);
            }, 50),
          ),
      ),
    ).rejects.toThrow('validate failed');
    expect(slowDone).toBe(true);
    await expect(
      together(
        async () => 1,
        async () => 2,
      ),
    ).resolves.toEqual([1, 2]);
  });

  it('gives two validate runs started in the same minute their own report directories', () => {
    const root = tmp();
    const t = new Date('2026-09-29T14:05:12Z');
    const a = newRunDir(t, root);
    const b = newRunDir(t, root);
    expect(a.endsWith('2026-09-29-1405')).toBe(true);
    expect(b.endsWith('2026-09-29-1405-2')).toBe(true);
  });
});

describe('one environment: the release and the Beta channel (ONE-01…ONE-04)', () => {
  it('reads a channel role’s releases, consistent-snapshot names included', () => {
    const d = 'a'.repeat(64);
    expect(
      channelIdsOf(
        [
          'development/releases/whombat-dev-20261119.9.json',
          `development/releases/${d}.whombat-20261120.1.json`,
          'development/host/whombat-20261120.1/whombat-host.index.json',
          'production/releases/whombat-20261118.1.json',
        ],
        'development',
      ),
    ).toEqual(['whombat-dev-20261119.9', 'whombat-20261120.1']);
  });

  it('reads the channel from the publisher’s clone: its newest role file', () => {
    const dir = tmp();
    expect(cloneChannelIds(dir, 'development')).toBeNull();
    mkdirSync(join(dir, 'metadata'));
    const role = (ids: string[]) =>
      JSON.stringify({
        signed: { targets: Object.fromEntries(ids.map((i) => [`development/releases/${i}.json`, {}])) },
      });
    writeFileSync(join(dir, 'metadata', '9.development.json'), role(['whombat-dev-20261119.9']));
    writeFileSync(
      join(dir, 'metadata', '10.development.json'),
      role(['whombat-dev-20261119.9', 'whombat-20261120.1']),
    );
    writeFileSync(join(dir, 'metadata', '2.production.json'), role([]));
    expect(cloneChannelIds(dir, 'development')).toEqual(['whombat-dev-20261119.9', 'whombat-20261120.1']);
    expect(cloneChannelIds(dir, 'production')).toEqual([]);
  });

  it('checks newer from the ceremony’s root and refuses a tree without it', () => {
    const dir = tmp();
    expect(() => pinnedRoot(dir)).toThrow(/manifest\/prod\/tuf-root.json is missing/);
    mkdirSync(join(dir, 'manifest', 'prod'), { recursive: true });
    writeFileSync(join(dir, 'manifest', 'prod', 'tuf-root.json'), '{}');
    expect(pinnedRoot(dir)).toBe(join(dir, 'manifest', 'prod', 'tuf-root.json'));
  });

  it('lets a DEV twin on Beta stand for its release, for the notes', () => {
    const twinOf = (dev: string) => (dev === 'whombat-dev-20261119.9' ? 'whombat-20261119.9' : null);
    expect(
      asImageReleases(
        ['whombat-dev-20261119.8', 'whombat-dev-20261119.9', 'whombat-20261120.1', 'x'],
        twinOf,
      ),
    ).toEqual(['whombat-20261119.9', 'whombat-20261120.1']);
  });
});
