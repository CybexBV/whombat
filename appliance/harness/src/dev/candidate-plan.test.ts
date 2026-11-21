import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { frozen, parseArgs, unfrozenStage } from './candidate.ts';
import {
  apiCarried,
  appendRow,
  appendSection,
  appVersionAt,
  type BuiltRelease,
  betaBuilds,
  buildForRun,
  type CandidateManifest,
  candidateBuildArgs,
  candidateRow,
  cloudPinned,
  contractsAt,
  controlSpeaks,
  decisionFor,
  deployArgs,
  FAKE_HASH,
  fitSubject,
  githubPublishArgs,
  type HostsMove,
  healthContracts,
  hostBuildFor,
  hostedPlan,
  hostedWords,
  hubBehind,
  inCloud,
  isHostRelease,
  isOneImage,
  memoryHighFor,
  newestCandidate,
  newestOnBeta,
  nextDecision,
  nextManifest,
  nextProdId,
  nextVersion,
  parseCloudPlan,
  pinnedCommit,
  publishedRelease,
  type RowFacts,
  relayCarried,
  releasesTarget,
  reportedHash,
  repositoryForbidden,
  resumes,
  runbookSection,
  type SectionFacts,
  savedBuild,
  setPnpmDepsHash,
  setRuntimeCandidate,
  setVendorHash,
  shipBuildArgs,
  shippedBuild,
  signedAgents,
  summaryCarried,
  unchanged,
  vendoredContracts,
  WEB_PATHS,
  webBuildCommit,
  webDecision,
  wrap,
} from './candidate-plan.ts';

const OLD = 'dd3d564156a1ea4154ec79d48db43597e5b78132';
const NEW = '272918ff73f9864856366a09799de3f82be932df';
const NOW = new Date('2026-10-19T06:29:25Z');

describe('the candidate preflight', () => {
  it('builds the release bundle and every pin check together, including a moved hosts service', () => {
    for (const hosts of [false, true]) {
      const args = candidateBuildArgs('/repo/candidate', hosts);
      const expr = args[args.indexOf('--expr') + 1] ?? '';
      expect(expr).toContain('git+file:///repo/candidate');
      expect(expr).toContain('f.lib.releaseRuntime f.packages.x86_64-linux.whombat-runtime null');
      for (const check of ['runtime-pin', 'hosts-pin', 'hosts-agent-manifest'])
        expect(expr).toContain(`f.checks.x86_64-linux.${check}`);
      expect(expr.includes('f.packages.x86_64-linux.whombat-hosts')).toBe(hosts);
      expect(args).toContain('--no-link');
    }
  });
});

const manifest = (): CandidateManifest => ({
  productVersion: '2026.10.18-rc.124',
  updatedAt: 1,
  contracts: { version: '0.93.0', component: 'whombat-contracts' },
  components: [
    {
      id: 'whombat-contracts',
      repository: 'whombat-contracts',
      ref: 'contracts-v0.93.0',
      commit: 'c93',
      tag: 'contracts-v0.93.0',
      version: '0.93.0',
      artifacts: [{ from: { path: 'dist-release/0.93.0/SHA256SUMS' } }],
    },
    { id: 'whombat-runtime', repository: 'Whombat', commit: OLD, version: '0.2.0' },
    {
      id: 'whombat-app',
      repository: 'whombat-app',
      ref: 'app-v0.91.0',
      commit: 'a910',
      tag: 'app-v0.91.0',
      version: '0.91.0',
    },
    { id: 'whombat-hosts', repository: 'whombat-hosts', commit: 'h1' },
    { id: 'whombat-api', repository: 'whombat-api', ref: 'main', commit: 'api1', version: '0.1.0' },
    { id: 'whombat-relay', repository: 'whombat-relay', ref: 'main', commit: 'relay1', version: '0.1.0' },
  ],
  tuple: { releaseId: 'rt-2026.10.18-rc.124', hostAbi: 1 },
});

describe('the next candidate', () => {
  it('is the newest file plus a patch, or a minor', () => {
    const v = newestCandidate(['0.99.0.json', '0.102.0.json', '0.101.2.json', 'README.md']);
    expect(v).toBe('0.102.0');
    expect(nextVersion(v, 'patch')).toBe('0.102.1');
    expect(nextVersion(v, 'minor')).toBe('0.103.0');
  });

  it('takes today’s next rc and the new runtime and app, leaving the rest', () => {
    const prev = manifest();
    const next = nextManifest(prev, { whombatRev: NEW, app: { version: '0.91.1', commit: 'a911' } }, NOW);
    expect(next.productVersion).toBe('2026.10.19-rc.125');
    expect(next.tuple.releaseId).toBe('rt-2026.10.19-rc.125');
    expect(next.updatedAt).toBe(Math.floor(NOW.getTime() / 1000));
    expect(next.components.find((c) => c.id === 'whombat-runtime')?.commit).toBe(NEW);
    expect(next.components.find((c) => c.id === 'whombat-app')).toMatchObject({
      ref: 'app-v0.91.1',
      tag: 'app-v0.91.1',
      commit: 'a911',
      version: '0.91.1',
    });
    expect(next.components.find((c) => c.id === 'whombat-hosts')).toEqual(prev.components[3]);
    expect(next.contracts.version).toBe('0.93.0');
    expect(prev.productVersion).toBe('2026.10.18-rc.124');
  });

  it('moves the contracts component, its artifact paths included, when Whombat vendors new ones', () => {
    const next = nextManifest(
      manifest(),
      {
        whombatRev: NEW,
        app: { version: '0.91.1', commit: 'a911' },
        contracts: { version: '0.94.0', commit: 'c94' },
      },
      NOW,
    );
    expect(next.contracts.version).toBe('0.94.0');
    const c = next.components.find((x) => x.id === 'whombat-contracts');
    expect(c).toMatchObject({ ref: 'contracts-v0.94.0', commit: 'c94', version: '0.94.0' });
    expect(JSON.stringify(c)).toContain('dist-release/0.94.0/SHA256SUMS');
    expect(JSON.stringify(c)).not.toContain('0.93.0');
  });

  it('reads the contracts Whombat vendors', () => {
    const pkg = JSON.stringify({
      dependencies: { '@whombat/core': 'file:vendor/whombat-contracts/0.93.0/whombat-core-0.93.0.tgz' },
    });
    expect(vendoredContracts(pkg)).toBe('0.93.0');
    expect(() => vendoredContracts('{}')).toThrow();
  });

  it('reads the contracts and the app from a Whombat that holds them, and from one that vendors them', () => {
    const vendored = JSON.stringify({
      dependencies: { '@whombat/core': 'file:vendor/whombat-contracts/0.93.0/whombat-core-0.93.0.tgz' },
    });
    expect(contractsAt(vendored, null)).toBe('0.93.0');
    expect(contractsAt('{}', JSON.stringify({ name: '@whombat/core', version: '3.0.1' }))).toBe('3.0.1');
    expect(() => contractsAt('{}', JSON.stringify({ version: '0.0.0-x' }))).toThrow();
    expect(appVersionAt(JSON.stringify({ name: '@whombat/web', version: '3.1.0' }))).toBe('3.1.0');
    expect(() => appVersionAt('{}')).toThrow();
  });

  describe('once the app and the contracts live in Whombat', () => {
    const rt = {
      id: 'whombat-runtime',
      repository: 'Whombat',
      source: '~/Code/Whombat',
      remote: 'git@github.com:CybexBV/whombat.git',
      ref: 'main',
      commit: OLD,
      version: '0.2.0',
      build: [{ run: ['pnpm', 'install', '--frozen-lockfile'] }, { run: ['pnpm', 'contracts:verify'] }],
    };
    const prev = (): CandidateManifest => {
      const m = manifest();
      m.components[1] = structuredClone(rt);
      Object.assign(m.components[2] as object, {
        source: '~/Code/whombat-app',
        build: [
          { run: ['pnpm', 'install', '--frozen-lockfile'] },
          { run: ['pnpm', 'contracts:verify'] },
          { run: ['pnpm', 'build:admin'] },
        ],
        gates: [{ id: 'check', run: ['pnpm', 'check'] }],
      });
      return m;
    };

    it('pins the app at the runtime’s commit of the Whombat checkout, its builds without the contracts check', () => {
      const next = nextManifest(
        prev(),
        { whombatRev: NEW, app: { version: '3.0.0', commit: NEW, inWhombat: true } },
        NOW,
      );
      const app = next.components.find((c) => c.id === 'whombat-app');
      expect(app).toMatchObject({
        repository: 'Whombat',
        source: '~/Code/Whombat',
        remote: rt.remote,
        ref: 'main',
        commit: NEW,
        version: '3.0.0',
        gates: [],
      });
      expect(app?.tag).toBeUndefined();
      expect(JSON.stringify(app?.build)).toContain('build:admin');
      for (const id of ['whombat-app', 'whombat-runtime'])
        expect(JSON.stringify(next.components.find((c) => c.id === id)?.build)).not.toContain(
          'contracts:verify',
        );
      // Contracts that didn't move stay the release consumers vendor.
      expect(next.components.find((c) => c.id === 'whombat-contracts')).toEqual(prev().components[0]);
    });

    it('drops the operator panel’s build and artifact once the Whombat commit has no apps/admin', () => {
      const withPanel = prev();
      Object.assign(withPanel.components[2] as object, {
        artifacts: [{ name: 'whombat-app/web' }, { name: 'whombat-app/admin' }],
      });
      const app = (hasAdmin: boolean) =>
        nextManifest(
          withPanel,
          { whombatRev: NEW, app: { version: '3.0.0', commit: NEW, inWhombat: true, hasAdmin } },
          NOW,
        ).components.find((c) => c.id === 'whombat-app');
      expect(JSON.stringify(app(true)?.build)).toContain('build:admin');
      expect(app(true)?.artifacts).toEqual([{ name: 'whombat-app/web' }, { name: 'whombat-app/admin' }]);
      expect(JSON.stringify(app(false)?.build)).not.toContain('build:admin');
      expect(JSON.stringify(app(false)?.build)).toContain('--frozen-lockfile');
      expect(app(false)?.artifacts).toEqual([{ name: 'whombat-app/web' }]);
    });

    it('moves the contracts into the Whombat checkout when their version moves there', () => {
      const next = nextManifest(
        prev(),
        {
          whombatRev: NEW,
          app: { version: '3.0.0', commit: NEW, inWhombat: true },
          contracts: { version: '3.0.1', commit: 'c301', inWhombat: true },
        },
        NOW,
      );
      expect(next.contracts).toEqual({ version: '3.0.1', component: 'whombat-contracts' });
      const c = next.components.find((x) => x.id === 'whombat-contracts');
      expect(c).toMatchObject({
        repository: 'Whombat',
        source: '~/Code/Whombat',
        ref: 'contracts-v3.0.1',
        tag: 'contracts-v3.0.1',
        commit: 'c301',
        version: '3.0.1',
      });
      const text = JSON.stringify(c);
      expect(text).toContain('dist-release/contracts/3.0.1/SHA256SUMS');
      expect(text).toContain('contracts:release');
      expect(text).toContain('contracts:test:go');
      expect(text).not.toContain('0.93.0');
    });
  });
});

describe('the pins in nix', () => {
  const nix = [
    '  # The pnpm store’s hash for the pinned rev: dd3d5641 since IN-294',
    '  # taken with a fake hash.',
    '  pinnedPnpmDepsHash = "sha256-old=";',
    '    candidate = "0.102.0";',
  ].join('\n');

  it('names the candidate and sets the pnpm store hash with its comment', () => {
    expect(setRuntimeCandidate(nix, '0.102.1')).toContain('candidate = "0.102.1";');
    const empty = setPnpmDepsHash(nix, '');
    expect(empty).toContain('pinnedPnpmDepsHash = "";');
    expect(empty).toContain('dd3d5641 since IN-294');
    const out = setPnpmDepsHash(empty, 'sha256-new=', ['272918ff since IN-296', 'second line']);
    expect(out).toContain('pinnedPnpmDepsHash = "sha256-new=";');
    expect(out).toContain('  # 272918ff since IN-296\n  # second line\n  pinnedPnpmDepsHash');
    expect(out).not.toContain('IN-294');
  });

  it('reads the hash Nix reports', () => {
    const err =
      'error: hash mismatch in fixed-output derivation:\n  specified: sha256-AAAA=\n     got:    sha256-tIKnEhxUDT8h/cB2Ned5ZQ82orR52GKw+wYT73OAWK0=\n';
    expect(reportedHash(err)).toBe('sha256-tIKnEhxUDT8h/cB2Ned5ZQ82orR52GKw+wYT73OAWK0=');
    expect(reportedHash('built fine')).toBeNull();
  });
});

describe('the docs', () => {
  const md =
    '| IN-294 | **Candidate 0.102.0: Chat.** x | y |\n| IN-295 | **Candidate 0.102.1: delete.** x | y |\n';

  it('takes the next decision, finds a candidate’s and appends a row', () => {
    expect(nextDecision(md)).toBe(296);
    expect(decisionFor(md, '0.102.1')).toBe(295);
    expect(decisionFor(md, '0.102.10')).toBeNull();
    expect(appendRow(md.trimEnd(), '| IN-296 | z | w |')).toBe(`${md}| IN-296 | z | w |\n`);
  });

  it('puts the releases runbook’s new section at its end', () => {
    const rb = '# Releases\n\n### whombat-20261120.1: candidate 0.282.0\n\ntext\n\n';
    const out = appendSection(rb, '### whombat-20261120.2: candidate 0.282.1\n\nnew\n');
    expect(out.indexOf('20261120.1')).toBeLessThan(out.indexOf('20261120.2'));
    expect(out.endsWith('new\n')).toBe(true);
    expect(appendSection('# Releases', '### s')).toBe('# Releases\n\n### s\n');
  });

  it('wraps at the width', () => {
    const lines = wrap('word '.repeat(100), 30).split('\n');
    expect(lines.every((l) => l.length <= 30)).toBe(true);
    expect(lines.join(' ').split(' ')).toHaveLength(100);
  });
});

describe('ids', () => {
  it('takes the next production id of the day', () => {
    expect(nextProdId(['whombat-20261018.18', 'whombat-dev-20261018.40', 'whombat-20260928.902'], NOW)).toBe(
      'whombat-20261019.1',
    );
    expect(nextProdId(['whombat-20261019.1', 'whombat-20261019.3'], NOW)).toBe('whombat-20261019.4');
    // ONE-04: one family with today's whombat-dev- ids (Home moves from whombat-dev-… to whombat-… and never back).
    expect(nextProdId(['whombat-20261019.2', 'whombat-dev-20261019.9'], NOW)).toBe('whombat-20261019.10');
  });
});

describe('Beta and production (ONE-01, ONE-19)', () => {
  it('needs the publisher’s clone and token before anything starts', () => {
    expect(releasesTarget({ WHOMBAT_RELEASES_DIR: '/srv/releases', WHOMBAT_RELEASES_TOKEN: 't' })).toEqual({
      dir: '/srv/releases',
    });
    expect(() => releasesTarget({})).toThrow(/WHOMBAT_RELEASES_DIR.*WHOMBAT_RELEASES_TOKEN.*releases\.env/);
    expect(() => releasesTarget({ WHOMBAT_RELEASES_DIR: '/srv/releases' })).toThrow(/WHOMBAT_RELEASES_TOKEN/);
    expect(githubPublishArgs('/srv/releases', '/b/whombat-20261120.1/release')).toEqual([
      'gh-publish',
      '--dir',
      '/srv/releases',
      '--release-dir',
      '/b/whombat-20261120.1/release',
    ]);
  });

  it('says the options that went with DEV are gone', () => {
    expect(() => parseArgs(['--what', 'x', '--github'], {})).toThrow(/went with DEV/);
    expect(() => parseArgs(['--what', 'x', '--no-rollout'], {})).toThrow(/Beta has no rollouts/);
  });

  it('says the options that named a commit of another repository are gone, and what replaced each', () => {
    expect(() => parseArgs(['--what', 'x', '--whombat', 'abc1234'], {})).toThrow(/ships origin\/main/);
    expect(() => parseArgs(['--what', 'x', '--hosts', 'd2098f2'], {})).toThrow(/signs the agents/);
    expect(() => parseArgs(['--what', 'x', '--reuse-host', 'whombat-20261019.6'], {})).toThrow(
      /--host forces/,
    );
  });

  it('knows the one Whombat image by its profile’s channel (ONE-02)', () => {
    const profile = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'nix', 'profiles', 'prod-instance.nix'),
      'utf8',
    );
    expect(isOneImage(profile)).toBe(true);
    expect(isOneImage(profile.replace(/^\s*whombat\.helper\.defaultChannel.*$/m, ''))).toBe(false);
    expect(isOneImage('  # whombat.helper.defaultChannel = "development";')).toBe(false);
    expect(isOneImage(null)).toBe(false);
  });

  it('remembers a release as in Beta from its published.json', () => {
    expect(
      publishedRelease(JSON.stringify({ release: 'whombat-20261120.1', channel: 'development' })),
    ).toEqual({
      release: 'whombat-20261120.1',
    });
    expect(publishedRelease(null)).toBeNull();
    expect(publishedRelease('{"release": "nope"}')).toBeNull();
    expect(publishedRelease('not json')).toBeNull();
  });

  it('reads the commit production’s account site was built from', () => {
    expect(webBuildCommit(JSON.stringify({ version: '3.132.0', build: '3.132.0+43a0982' }))).toBe('43a0982');
    expect(webBuildCommit(JSON.stringify({ version: '3.132.0', build: '3.132.0' }))).toBeNull();
    expect(webBuildCommit('<html>')).toBeNull();
    expect(webBuildCommit(null)).toBeNull();
  });

  it('deploys the account site when its paths moved, or when production’s is unknown', () => {
    const rev = '43a09823ffffffffffffffffffffffffffffffff';
    expect(webDecision({ deployed: '43a0982', rev, changed: null })).toMatchObject({ deploy: false });
    expect(webDecision({ deployed: '1111111', rev, changed: false })).toMatchObject({ deploy: false });
    expect(webDecision({ deployed: '1111111', rev, changed: true })).toMatchObject({
      deploy: true,
      why: expect.stringMatching(/changed since Whombat 1111111/),
    });
    expect(webDecision({ deployed: '1111111', rev, changed: null })).toMatchObject({ deploy: true });
    expect(webDecision({ deployed: null, rev, changed: null })).toMatchObject({ deploy: true });
    expect(WEB_PATHS).toContain('apps/web');
    expect(WEB_PATHS).toContain('packages');
  });

  it('refuses to ship ahead of control: the release and site need contracts control must speak (R2 A11)', () => {
    expect(controlSpeaks({ needed: '4.7.0', control: '4.7.0', from: 'production control' })).toBeNull();
    expect(controlSpeaks({ needed: '4.7.0', control: '4.8.0', from: 'production control' })).toBeNull();
    expect(controlSpeaks({ needed: '4.8.0', control: '4.7.0', from: 'production control' })).toMatch(
      /production control speaks contracts 4\.7\.0, older than the 4\.8\.0.*--cloud/,
    );
    expect(controlSpeaks({ needed: '4.8.0', control: null, from: 'production control' })).toMatch(
      /says no contracts/,
    );
    expect(healthContracts('{"ok":true,"env":"prod","version":"12e8db0f97df","contracts":"4.0.0"}')).toBe(
      '4.0.0',
    );
    expect(healthContracts('{"ok":true}')).toBeNull();
    expect(healthContracts('<html>')).toBeNull();
    expect(healthContracts(null)).toBeNull();
  });

  it('deploys control first, then the relay, then the account site and its embed; a stopped run’s are left out', () => {
    const web = { deploy: true, why: 'w' };
    const cloud = {
      rev: 'a'.repeat(40),
      plan: parseCloudPlan(
        'control deploy 111111111111 control/ changed\nrelay deploy 222222222222 relay/ changed\n',
      ),
    };
    const plan = hostedPlan({ cloud, whombatRev: 'c'.repeat(40), web });
    expect(plan.map((h) => h.part)).toEqual(['control', 'relay', 'web', 'embed']);
    expect(plan[0]?.why).toBe('control/ changed');
    expect(deployArgs(plan[0] as never)).toEqual(['control', 'a'.repeat(40)]);
    expect(deployArgs(plan[1] as never)).toEqual(['relay', 'a'.repeat(40)]);
    expect(hostedPlan({ cloud: null, whombatRev: 'c', web: { deploy: false, why: '' } })).toEqual([]);
    const done = plan.slice(0, 2);
    expect(hostedPlan({ cloud, whombatRev: 'c'.repeat(40), web, done }).map((h) => h.part)).toEqual([
      'web',
      'embed',
    ]);
    expect(hostedWords([])).toMatch(/nothing hosted deployed/);
    expect(hostedWords(plan)).toMatch(
      /whombat-cloud.*dump first.*control at `aaaaaaaaaaaa`, relay at `aaaaaaaaaaaa`/,
    );
  });
});

describe('control and the relay from one whombat-cloud commit (--cloud)', () => {
  const REV = 'c10d'.repeat(10);
  const LIVE = '0a9eb3ab16f4';
  const lines = (control: string, relay: string) =>
    parseCloudPlan(`control ${control} ${LIVE} c-why\nrelay ${relay} fae185340f70 r-why\n`);

  it('reads deploy.sh plan: one line a part, and refuses anything less', () => {
    expect(lines('deploy', 'keep')).toEqual([
      { part: 'control', verdict: 'deploy', live: LIVE, why: 'c-why' },
      { part: 'relay', verdict: 'keep', live: 'fae185340f70', why: 'r-why' },
    ]);
    expect(() => parseCloudPlan('control deploy x why\n')).toThrow(/nothing usable about relay/);
    expect(() => parseCloudPlan('')).toThrow(/control and relay/);
    expect(() => parseCloudPlan('control maybe x why\nrelay keep y why\n')).toThrow(/control/);
  });

  it('deploys only the part whose folder changed', () => {
    const only = (control: string, relay: string) =>
      hostedPlan({
        cloud: { rev: REV, plan: lines(control, relay) },
        whombatRev: 'w',
        web: { deploy: false, why: '' },
      }).map((h) => h.part);
    expect(only('deploy', 'keep')).toEqual(['control']);
    expect(only('keep', 'deploy')).toEqual(['relay']);
    expect(only('keep', 'keep')).toEqual([]);
    // Production runs that commit already (a run that stopped after deploying it): nothing to do again.
    expect(only('same', 'deploy')).toEqual(['relay']);
  });

  it('pins the commit for a part that moves to it, and leaves a part that stays', () => {
    expect(cloudPinned(lines('deploy', 'keep'))).toEqual(['control']);
    expect(cloudPinned(lines('same', 'deploy'))).toEqual(['control', 'relay']);
    expect(cloudPinned(lines('keep', 'keep'))).toEqual([]);
    const pins = { whombatRev: NEW, app: { version: '0.91.1', commit: 'a911' } };
    const moved = nextManifest(manifest(), { ...pins, cloud: { rev: REV, parts: ['control'] } }, NOW);
    const control = moved.components.find((c) => c.id === 'whombat-api');
    // The component keeps its id and repository name (the contracts' own); only where it comes from is new.
    expect(control).toMatchObject({
      repository: 'whombat-api',
      commit: REV,
      dir: 'control',
      source: '~/Code/whombat-cloud',
      live: '~/Code/whombat-cloud/control',
    });
    expect(control?.remote).toContain('CybexBV/whombat-cloud');
    expect(pinnedCommit(moved, 'whombat-relay')).toBe('relay1');
    expect(moved.components.find((c) => c.id === 'whombat-relay')?.dir).toBeUndefined();
    expect(inCloud('relay').dir).toBe('relay');
  });

  it('carries on only with a candidate that pins the commit for every part that moves', () => {
    const pins = { whombatRev: NEW, app: { version: '0.91.1', commit: 'a911' } };
    const prev = nextManifest(manifest(), { ...pins, cloud: { rev: REV, parts: ['control'] } }, NOW);
    expect(resumes(prev, NEW, null, { rev: REV, parts: ['control'] })).toBe(true);
    expect(resumes(prev, NEW, null, { rev: REV, parts: ['control', 'relay'] })).toBe(false);
    expect(resumes(prev, NEW, null, { rev: 'other', parts: ['control'] })).toBe(false);
    // Nothing moves (both folders as production has them): the commit asks nothing of the pins.
    expect(resumes(prev, NEW, null, { rev: 'other', parts: [] })).toBe(true);
    expect(resumes(prev, NEW, null)).toBe(true);
  });

  it('takes --cloud, and says so to the options it replaced', () => {
    expect(parseArgs(['--what', 'x', '--cloud', 'c10dc10'], {}).cloud).toBe('c10dc10');
    expect(parseArgs(['--what', 'x'], {}).cloud).toBeNull();
    expect(() => parseArgs(['--what', 'x', '--cloud'], {})).toThrow(/--cloud needs a value/);
    expect(() => parseArgs(['--what', 'x', '--api', 'b2a1c0f'], {})).toThrow(/--cloud <a commit/);
    expect(() => parseArgs(['--what', 'x', '--relay', 'd00rc0f'], {})).toThrow(/--cloud <a commit/);
  });
});

describe('whombat-hosts with the candidate (--hosts, IN-314)', () => {
  const H_OLD = '5394c53bb45b5a04efd7fc7269342ba4e87de3ec';
  const H_NEW = 'd2098f2aa9f00b1e5c7e0c2d4b3a1f6e8d7c9b0a';
  const hosts: HostsMove = {
    rev: H_NEW,
    subject: 'Merge swu: software updates | on servers',
    vendorMoved: false,
  };

  it('takes --host to force a host release, --version and --minor', () => {
    expect(parseArgs(['--what', 'x', '--host'], {}).host).toBe(true);
    expect(parseArgs(['--what', 'x'], {})).toMatchObject({ host: false, version: null, minor: false });
    expect(parseArgs(['--what', 'x', '--version', '0.284.3', '--minor'], {})).toMatchObject({
      version: '0.284.3',
      minor: true,
    });
    expect(() => parseArgs(['--what', 'x', '--version', 'v1'], {})).toThrow(/x\.y\.z/);
  });

  it('moves the hosts component to the commit, and leaves it without one', () => {
    const prev = manifest();
    const pins = { whombatRev: NEW, app: { version: '0.91.1', commit: 'a911' } };
    const next = nextManifest(prev, { ...pins, hostsRev: H_NEW }, NOW);
    expect(pinnedCommit(next, 'whombat-hosts')).toBe(H_NEW);
    expect(pinnedCommit(next, 'whombat-runtime')).toBe(NEW);
    expect(next.components.find((c) => c.id === 'whombat-hosts')).toMatchObject({
      repository: 'whombat-hosts',
    });
    expect(pinnedCommit(prev, 'whombat-hosts')).toBe('h1');
    expect(pinnedCommit(nextManifest(prev, pins, NOW), 'whombat-hosts')).toBe('h1');
    expect(pinnedCommit(prev, 'nothing')).toBeNull();
    const without = { ...prev, components: prev.components.filter((c) => c.id !== 'whombat-hosts') };
    expect(() => nextManifest(without, { ...pins, hostsRev: H_NEW }, NOW)).toThrow(/no whombat-hosts/);
  });

  it('moves the hosts service’s vendorHash with its comment', () => {
    const nix =
      '  # When they change: set it to lib.fakeHash.\n  vendorHash = "sha256-old=";\n  shortRev = 1;';
    const fake = setVendorHash(nix, FAKE_HASH);
    expect(fake).toContain(`vendorHash = "${FAKE_HASH}";`);
    expect(setVendorHash(fake, 'sha256-new=')).toBe(nix.replace('sha256-old=', 'sha256-new='));
    expect(() => setVendorHash('nothing', 'x')).toThrow(/vendorHash/);
  });

  it('gives the release the number kept for it when a later row came first', () => {
    const md = '| IN-311 | a | b |\n| IN-312 | c | d |\n';
    expect(nextDecision(md)).toBe(313);
    const ahead = appendRow(md, '| IN-314 | tooling | e |');
    expect(nextDecision(ahead)).toBe(313);
    const both = appendRow(ahead, '| IN-313 | release | f |');
    expect(both.indexOf('IN-312')).toBeLessThan(both.indexOf('IN-313'));
    expect(both.indexOf('IN-313')).toBeLessThan(both.indexOf('IN-314'));
    expect(both.endsWith('| IN-314 | tooling | e |\n')).toBe(true);
    expect(nextDecision(both)).toBe(315);
  });

  const built = (id: string, host: string, candidate: string, whombatRev = NEW): BuiltRelease => ({
    id,
    env: 'prod',
    twin: null,
    whombatRev,
    host,
    candidate,
  });
  const all = [
    built('whombat-20261019.6', 'whombat-20261019.6', '0.102.5', OLD),
    built('whombat-20261019.16', 'whombat-20261019.6', '0.109.0'),
    // A PROD release of before ONE-02 with its DEV twin, which Beta carried.
    { ...built('whombat-20261019.3', 'whombat-20261019.3', '0.101.0', OLD), twin: 'whombat-dev-20261019.3' },
  ];

  it('reuses the host of Beta’s newest release when it is a build of the image here', () => {
    const beta = ['whombat-dev-20261019.3', 'whombat-20261019.6', 'whombat-20261019.16', 'x'];
    expect(newestOnBeta(beta)).toBe('whombat-20261019.16');
    // One family (ONE-04): a DEV twin of a later number is newer.
    expect(newestOnBeta(['whombat-20261019.6', 'whombat-dev-20261019.9'])).toBe('whombat-dev-20261019.9');
    expect(newestOnBeta(['nothing'])).toBeNull();
    const { on, host } = betaBuilds(all, newestOnBeta(beta));
    expect(on?.id).toBe('whombat-20261019.16');
    expect(on?.host).toBe('whombat-20261019.6');
    expect(host?.candidate).toBe('0.102.5');
    expect(betaBuilds(all, 'whombat-20261019.6').host?.id).toBe('whombat-20261019.6');
    // Beta's newest is a DEV twin (the first release of the one image) or a build from elsewhere: a host release.
    expect(betaBuilds(all, 'whombat-dev-20261019.3')).toEqual({ on: null, host: null });
    expect(betaBuilds(all, 'whombat-20261001.1')).toEqual({ on: null, host: null });
    expect(betaBuilds(all, null)).toEqual({ on: null, host: null });
    expect(isHostRelease(all[0] as BuiltRelease)).toBe(true);
    expect(isHostRelease(all[1] as BuiltRelease)).toBe(false);
    // Hermes comes from the real host's Whombat pin, even when the runtime already has the requested commit.
    expect(hostBuildFor(all, 'whombat-20261019.16')?.whombatRev).toBe(OLD);
    expect(hostBuildFor(all, 'whombat-20261019.6')?.whombatRev).toBe(OLD);
    expect(hostBuildFor(all, 'unknown')).toBeNull();
  });

  it('has nothing to ship once the previous candidate’s release is in Beta', () => {
    const out = { release: 'whombat-20261019.16' };
    expect(shippedBuild(all, '0.109.0', NEW, false, out)?.id).toBe('whombat-20261019.16');
    // stopped before publishing, or published from another candidate or commit: carry on
    expect(shippedBuild(all, '0.109.0', NEW, false, null)).toBeNull();
    expect(shippedBuild(all, '0.109.0', NEW, false, { release: 'whombat-20261019.99' })).toBeNull();
    expect(shippedBuild(all, '0.109.1', NEW, false, out)).toBeNull();
    expect(shippedBuild(all, '0.109.0', OLD, false, out)).toBeNull();
    // --host or --hosts: only a host release of it counts
    expect(shippedBuild(all, '0.109.0', NEW, true, out)).toBeNull();
    expect(shippedBuild(all, '0.102.5', OLD, true, { release: 'whombat-20261019.6' })?.id).toBe(
      'whombat-20261019.6',
    );
  });

  it('carries on with a merged candidate only when it pins both commits', () => {
    const prev = manifest();
    expect(resumes(prev, OLD, null)).toBe(true);
    expect(resumes(prev, OLD, 'h1')).toBe(true);
    expect(resumes(prev, OLD, H_NEW)).toBe(false);
    expect(resumes(prev, NEW, null)).toBe(false);
    expect(resumes(prev, OLD, null, { rev: 'api1', parts: ['control'] })).toBe(true);
    expect(resumes(prev, OLD, null, { rev: 'api2', parts: ['control'] })).toBe(false);
  });

  it('ships an explicitly new version even when only the appliance changed', () => {
    const prev = manifest();
    const previous = '0.150.0';
    expect(resumes(prev, OLD, null, null, { previous, requested: null })).toBe(true);
    expect(resumes(prev, OLD, null, null, { previous, requested: previous })).toBe(true);
    expect(resumes(prev, OLD, null, null, { previous, requested: '0.150.1' })).toBe(false);
    // An interrupted run for that newly merged version still carries on.
    expect(resumes(prev, OLD, null, null, { previous: '0.150.1', requested: '0.150.1' })).toBe(true);
  });

  it('asks for --hosts when the candidate keeps a hub Beta’s newest release doesn’t carry', () => {
    expect(hubBehind(H_NEW, H_OLD, null)).toBe(H_NEW);
    expect(hubBehind(H_NEW, H_OLD, H_NEW)).toBeNull();
    expect(hubBehind(H_OLD, H_OLD, null)).toBeNull();
    expect(hubBehind(H_NEW, null, null)).toBeNull();
  });

  it('builds a host release for a new hub, runtime-only otherwise', () => {
    expect(shipBuildArgs('whombat-20261019.17', 'whombat-20261019.6')).toEqual([
      'build',
      'whombat-20261019.17',
      '--reuse-host',
      'whombat-20261019.6',
    ]);
    expect(shipBuildArgs('whombat-20261019.17', null)).toEqual(['build', 'whombat-20261019.17', '--host']);
  });

  const row: RowFacts = {
    decision: 313,
    version: '0.110.0',
    what: 'software updates on servers',
    why: 'John asked for it.',
    whombat: { short: NEW.slice(0, 8), subject: 'Merge swu' },
    app: { version: '0.100.0', commit: 'a1000000ffff' },
    contracts: { version: '0.98.0', previous: '0.97.0' },
    lockfileMoved: true,
    hosts: null,
  };

  it('names the hosts commit in the IN row instead of “unchanged”', () => {
    const before = candidateRow(row);
    expect(before.startsWith('| IN-313 | **Candidate 0.110.0: software updates on servers.**')).toBe(true);
    expect(before).toContain('control, relay, manager and the hosts service unchanged');
    expect(before).not.toContain('--host');
    const after = candidateRow({ ...row, hosts });
    expect(after).toContain('the hosts service at `d2098f2` (“Merge swu: software updates / on servers”)');
    expect(after).toContain('control, relay and manager unchanged');
    expect(after).not.toContain('the hosts service unchanged');
    expect(after).toContain('`--host`');
    expect(after).toContain('a host release');
    expect(after).toContain('Published to Beta; Production only by `promote`');
    expect(after).not.toContain('backed up');
    expect(after).toContain('.#whombat-hosts');
    expect(after).toContain('`vendorHash` unchanged');
    expect(candidateRow({ ...row, hosts: { ...hosts, vendorMoved: true } })).toContain('a new `vendorHash`');
    expect(after.endsWith('| John asked for it. |')).toBe(true);
  });

  const section: SectionFacts = {
    version: '0.110.0',
    day: '2026-10-19',
    previous: '0.109.0',
    decision: 313,
    what: 'software updates on servers',
    whombatShort: NEW.slice(0, 8),
    app: '0.100.0',
    contracts: '0.98.0',
    contractsMoved: true,
    lockfileMoved: true,
    hosts: null,
    total: '3 min 00 s',
    releaseId: 'rt-2026.10.19-rc.140',
    build: 'whombat-20261019.17',
    reuse: 'whombat-20261019.6',
  };

  it('writes the runbook section: the release in Beta, a host release with the hub, what went to production', () => {
    const flat = (s: string) => s.replace(/\s+/g, ' ');
    const before = flat(runbookSection(section));
    expect(before).toContain('### whombat-20261019.17: candidate 0.110.0 (2026-10-19)');
    expect(before).toContain('control, relay, manager and the hosts service unchanged');
    expect(before).toContain('--reuse-host whombat-20261019.6');
    expect(before).toContain('`whombat-20261019.17` published in Beta');
    expect(before).toContain('within the hour');
    expect(before).toContain('nothing hosted deployed');
    expect(before).toContain('`promote whombat-20261019.17 --yes`');
    expect(before).not.toMatch(/dev stack|DEV|rollout/);
    expect(before).not.toContain('hub');
    const after = flat(
      runbookSection({
        ...section,
        hosts,
        reuse: null,
        api: { rev: 'a'.repeat(40), subject: 'Merge x' },
        hosted: [{ part: 'control', ref: 'a'.repeat(40), why: 'control/ changed' }],
      }),
    );
    expect(after).toContain('the hosts service at `d2098f2` (“Merge swu: software updates / on servers”)');
    expect(after).toContain('relay and manager unchanged');
    expect(after).toContain('`release/ship build whombat-20261019.17 --host`');
    expect(after).toContain('deployed to production');
    expect(after).toContain('control at `aaaaaaaaaaaa`');
    expect(after).not.toContain('--reuse-host');
    expect(
      runbookSection({ ...section, hosts, reuse: null })
        .split('\n')
        .every((l) => l.length <= 120),
    ).toBe(true);
  });

  it('says in the summary which hosts commit it carried', () => {
    const f = { whombatShort: NEW.slice(0, 8), app: '0.100.0', contracts: '0.98.0', decision: 313 };
    expect(summaryCarried({ ...f, hosts: null })).toBe(
      'Whombat 272918ff, app 0.100.0, contracts 0.98.0; IN-313',
    );
    expect(summaryCarried({ ...f, hosts })).toContain('the hosts service at d2098f2');
  });

  describe('the signed agents (dev/sign-agents, NX-158)', () => {
    const files = { 'whombat-agent-linux-amd64': {}, 'whombat-agent-linux-arm64': {} };
    const manifest = (m: object) =>
      JSON.stringify({ version: '0.0.0-20261019212356.d2098f2', key: '40f47772ee26385e', files, ...m });

    it('reads the version and key of the new pin’s manifest', () => {
      expect(signedAgents(manifest({}), H_NEW)).toEqual({
        version: '0.0.0-20261019212356.d2098f2',
        key: '40f47772ee26385e',
      });
    });

    it('refuses a manifest of another pin, without a key or without both agents', () => {
      expect(() => signedAgents(manifest({}), H_OLD)).toThrow(
        /not the hosts service at 5394c53.*dev\/sign-agents/,
      );
      expect(() => signedAgents(manifest({ key: '' }), H_NEW)).toThrow(/no key fingerprint/);
      expect(() => signedAgents(manifest({ files: { 'whombat-agent-linux-amd64': {} } }), H_NEW)).toThrow(
        /not both agents/,
      );
      expect(() => signedAgents(manifest({ files: {} }), H_NEW)).toThrow(/signs nothing/);
    });

    it('takes the macOS agents and Whombat Helper beside them (NX-515)', () => {
      const mac = {
        ...files,
        'whombat-agent-darwin-amd64': {},
        'whombat-agent-darwin-arm64': {},
        'whombat-helper-macos.zip': {},
      };
      expect(signedAgents(manifest({ files: mac }), H_NEW).key).toBe('40f47772ee26385e');
      const { 'whombat-agent-darwin-amd64': _, ...oneMac } = mac;
      expect(() => signedAgents(manifest({ files: oneMac }), H_NEW)).toThrow(/not both agents/);
      expect(() =>
        signedAgents(manifest({ files: { ...mac, 'whombat-agent-windows-amd64': {} } }), H_NEW),
      ).toThrow(/not both agents/);
    });

    it('names the key in the IN row and the manifest check with the pins', () => {
      expect(candidateRow({ ...row, hosts: { ...hosts, agentKey: '40f47772ee26385e' } })).toContain(
        'key `40f47772ee26385e` (`dev/sign-agents`',
      );
      expect(candidateRow({ ...row, hosts })).not.toContain('dev/sign-agents');
      expect(candidateRow(row)).toContain('`checks.hosts-agent-manifest`');
    });
  });
});

describe('the scopes its commands run in', () => {
  it('caps what reads many files, and leaves what works in a container or a unit', () => {
    expect(memoryHighFor('tar', {})).toBe('1G');
    expect(memoryHighFor('git', {})).toBe('1G');
    expect(memoryHighFor('nix', {})).toBe('4G');
    expect(memoryHighFor('pnpm', {})).toBe('4G');
    expect(memoryHighFor('node', {})).toBe('4G');
    expect(memoryHighFor('/home/me/Code/.wt/x/dev/sign-agents', {})).toBe('4G');
    expect(memoryHighFor('/home/me/Code/.wt/x/release/ship', {})).toBe('8G');
    for (const cmd of ['docker', 'systemctl', '/home/me/Services/whombat-appliance-dev/dev/status'])
      expect(memoryHighFor(cmd, {})).toBeNull();
  });

  it('takes the caps from the environment', () => {
    const env = { WB_MEMORY_HIGH_FILES: '512M', WB_MEMORY_HIGH_BUILD: '6G', WB_MEMORY_HIGH_SHIP: '12G' };
    expect(memoryHighFor('tar', env)).toBe('512M');
    expect(memoryHighFor('nix', env)).toBe('6G');
    expect(memoryHighFor('release/ship', env)).toBe('12G');
    expect(memoryHighFor('git', { WB_MEMORY_HIGH_FILES: '' })).toBe('1G');
  });
});

describe('control with the candidate (IN-388)', () => {
  const API = 'b2a1c0ffee00112233445566778899aabbccddee';
  const pins = { whombatRev: NEW, app: { version: '0.91.1', commit: 'a911' } };

  it('leaves the whombat-api component alone unless a whombat-cloud commit moves it', () => {
    expect(pinnedCommit(nextManifest(manifest(), pins, NOW), 'whombat-api')).toBe('api1');
  });

  it('names control instead of “unchanged”', () => {
    const api = { rev: API, subject: 'Merge remote-help | control' };
    expect(unchanged(null)).toBe('control, relay, manager and the hosts service unchanged');
    expect(unchanged(null, api)).toBe('relay, manager and the hosts service unchanged');
    expect(apiCarried(api)).toBe('control at whombat-cloud `b2a1c0f` (“Merge remote-help / control”)');
  });
});

describe('the relay with the candidate (the own address’s door)', () => {
  const RELAY = 'd00rc0ffee00112233445566778899aabbccddee';

  it('names the relay instead of “unchanged”', () => {
    const relay = { rev: RELAY, subject: 'Merge door' };
    const api = { rev: 'b2a1c0f', subject: 'Merge own address' };
    expect(unchanged(null, null, relay)).toBe('control, manager and the hosts service unchanged');
    expect(unchanged(null, api, relay)).toBe('manager and the hosts service unchanged');
    expect(relayCarried(relay)).toBe('the relay at whombat-cloud `d00rc0f` (“Merge door”)');
    const row = candidateRow({
      decision: 900,
      version: '0.300.0',
      what: 'the door',
      why: '',
      whombat: { short: 'abcdef12', subject: 'x' },
      app: { version: '3.130.0', commit: 'abcdef12', inWhombat: true },
      contracts: { version: '4.3.0', previous: '4.3.0' },
      lockfileMoved: false,
      hosts: null,
      relay,
    });
    expect(row).toContain('the relay at whombat-cloud `d00rc0f`');
    expect(row).toContain('control, manager and the hosts service unchanged');
  });
});

describe('a subject with a text the repository must never hold', () => {
  // As the guard list writes its rules, so that this file doesn't hold the text itself.
  const forbid = [
    '# literal rules for the public copy',
    'regex:(?i)not-repository-wide',
    '',
    '# repository-wide: never anywhere in this repository',
    'regex:(?i)ac[m]e',
    'regex:M1 2L3 [4]',
    '',
    'regex:later',
  ].join('\n');
  const rules = repositoryForbidden(forbid);

  it('reads only the repository-wide rules, with their case flag', () => {
    expect(rules.map(String)).toEqual(['/ac[m]e/i', '/M1 2L3 [4]/']);
  });

  it('leaves the subject out of the row instead of quoting it', () => {
    const named = fitSubject('Merge cut: ACME removed', rules);
    expect(named).toBe('');
    expect(fitSubject('Merge cut: the old name removed', rules)).toBe('Merge cut: the old name removed');
    expect(apiCarried({ rev: 'b2a1c0f00', subject: named })).toBe('control at whombat-cloud `b2a1c0f`');
  });
});

describe('the freeze and a run that stopped', () => {
  it('refuses candidates while the freeze is on, and says how to lift it', () => {
    const home = mkdtempSync(join(tmpdir(), 'freeze-'));
    const file = join(home, 'freeze');
    const e = { WHOMBAT_CANDIDATE_FREEZE: file };
    expect(frozen({ dryRun: false }, e, home)).toBeNull();
    writeFileSync(file, 'the key ceremony, 2026-11-20\n');
    const msg = frozen({ dryRun: false }, e, home);
    expect(msg).toContain('the key ceremony, 2026-11-20');
    expect(msg).toContain(`rm ${file}`);
    expect(frozen({ dryRun: true }, e, home)).toBeNull();
    // The default place, for every session on the machine.
    expect(frozen({ dryRun: false }, {}, home)).toBeNull();
  });

  it('checks the freeze again right before it publishes or deploys: one set while the run built stops it there', async () => {
    const home = mkdtempSync(join(tmpdir(), 'freeze-'));
    const file = join(home, 'freeze');
    const e = { WHOMBAT_CANDIDATE_FREEZE: file };
    let published = 0;
    const publish = async () => ++published;
    await unfrozenStage({ dryRun: false }, 'beta', publish, e, home);
    expect(published).toBe(1);
    writeFileSync(file, 'the key ceremony, 2026-11-20\n');
    await expect(unfrozenStage({ dryRun: false }, 'beta', publish, e, home)).rejects.toThrow(
      /came while this run was under way.*the key ceremony, 2026-11-20/,
    );
    expect(published).toBe(1);
  });

  it('carries on with the build it chose', () => {
    const run = { resume: true, reuse: 'whombat-20261119.1' };
    const first = buildForRun(null, run, 'whombat-20261119.4');
    expect(first).toEqual({ id: 'whombat-20261119.4', reuse: 'whombat-20261119.1' });
    const saved = { ...first, release: { releaseId: 'whombat-20261119.4', dir: '/r/whombat-20261119.4' } };
    // The retry Beta's error asks for: the same id, not the next one.
    expect(buildForRun(saved, run, 'whombat-20261120.1')).toEqual(saved);
    // A new candidate (not a resume) chooses again.
    expect(buildForRun(saved, { ...run, resume: false }, 'whombat-20261120.1').id).toBe('whombat-20261120.1');
    expect(() => buildForRun(saved, { ...run, reuse: null }, 'x')).toThrow(/on host whombat-20261119\.1/);
    // What a DEV-era run chose (a twin, a way of rolling out) isn't carried on with.
    expect(savedBuild(JSON.stringify(saved))).toEqual(saved);
    const devEra = {
      ...first,
      noRollout: false,
      github: true,
      twin: { releaseId: 'whombat-dev-20261119.9', dir: '/r' },
    };
    expect(savedBuild(JSON.stringify(devEra))).toBeNull();
    expect(savedBuild('nope')).toBeNull();
  });
});
