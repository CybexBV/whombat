import { describe, expect, it } from 'vitest';
import { runbookSection } from './candidate.ts';
import * as plan from './release-plan.ts';

const REV = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
// 2026-11-19 16:00:00 UTC.
const T = Date.UTC(2026, 10, 19, 16, 0, 0) / 1000;
const commit = plan.stampOf(REV, T);
const published: plan.PublishedRuntime = {
  release: 'whombat-20261120.14',
  stamp: plan.stampOf(OLD, T - 7600),
  storePath: '/nix/store/aaa-whombat-runtime',
  narHash: 'sha256:1',
};

describe('the stamp', () => {
  it('names the commit, its time and that time in UTC', () => {
    expect(plan.stampOf(REV, T)).toEqual({ rev: REV, time: T, date: '20261119160000' });
    expect(plan.stampArg(commit)).toBe(`${REV}:${T}:20261119160000`);
    expect(plan.parseStamp(plan.stampArg(commit))).toEqual(commit);
    expect(() => plan.parseStamp(`${REV}:${T}:20261119160001`)).toThrow(/not the time/);
    expect(() => plan.parseStamp('HEAD')).toThrow(/runtime stamp/);
    expect(plan.runtimeVersion('0.2.0', commit)).toBe('0.2.0-20261119160000.aaaaaaa');
    expect(plan.agentVersion(commit)).toBe('0.0.0-20261119160000.aaaaaaa');
  });
  it('refuses a short commit and a time that is none', () => {
    expect(() => plan.stampOf('abc1234', 1)).toThrow(/full commit/);
    expect(() => plan.stampOf(REV, 0)).toThrow(/commit time/);
  });
});

describe('the runtime of a release', () => {
  const same = { published, evaluated: published.storePath, inStore: published.narHash, commit };
  it('is kept when this commit builds the published object and it is still in the store', () => {
    expect(plan.chooseRuntime(same)).toMatchObject({
      kept: true,
      stamp: published.stamp,
      from: published.release,
    });
  });
  it('is new when the files changed', () => {
    const c = plan.chooseRuntime({ ...same, evaluated: '/nix/store/bbb-whombat-runtime' });
    expect(c).toMatchObject({ kept: false, stamp: commit, from: null });
  });
  it('is new, never the old version built again, when the published object is gone or has another hash', () => {
    expect(plan.chooseRuntime({ ...same, inStore: null })).toMatchObject({ kept: false, stamp: commit });
    expect(plan.chooseRuntime({ ...same, inStore: 'sha256:2' })).toMatchObject({
      kept: false,
      stamp: commit,
    });
  });
  it('is new when nothing is published or the comparison failed', () => {
    expect(plan.chooseRuntime({ ...same, published: null }).kept).toBe(false);
    expect(plan.chooseRuntime({ ...same, evaluated: null }).kept).toBe(false);
  });
});

describe('a store object’s hash', () => {
  it('is compared in the form the release tuple names it', () => {
    // The same hash as Nix prints it and as a build.json's tuple holds it.
    expect(plan.tupleNarHash('sha256-qfgUOoPeiQRcHGtrg3i36lc67rGL1k4EVm1USWFCjSc=')).toBe(
      'sha256:a9f8143a83de89045c1c6b6b8378b7ea573aeeb18bd64e04566d544961428d27',
    );
    expect(plan.tupleNarHash('sha256:a9f8143a83de89045c1c6b6b8378b7ea573aeeb18bd64e04566d544961428d27')).toBe(
      'sha256:a9f8143a83de89045c1c6b6b8378b7ea573aeeb18bd64e04566d544961428d27',
    );
    expect(plan.tupleNarHash('md5-abc')).toBeNull();
  });
});

describe('the agents', () => {
  const committed = '0.0.0-20261118064128.35fbc57';
  it('stay as they are when the manifest matches', () => {
    expect(plan.chooseAgents({ check: 0, committed, commit })).toMatchObject({
      action: 'unchanged',
      version: committed,
    });
  });
  it('are signed as this commit when only their bytes changed', () => {
    expect(plan.chooseAgents({ check: 3, committed, commit })).toMatchObject({
      action: 'sign',
      version: '0.0.0-20261119160000.aaaaaaa',
    });
  });
  it('are never signed after any other failure', () => {
    expect(() => plan.chooseAgents({ check: 1, committed, commit, detail: 'key "x"' })).toThrow(
      /nothing is signed/,
    );
  });
});

describe('the image', () => {
  const equal = { hostRelease: 'whombat-20261120.5', equal: true };
  it('is reused when it is the one the boxes run', () => {
    expect(plan.chooseHost({ force: false, agents: 'unchanged', compared: equal })).toMatchObject({
      changed: false,
      reuse: 'whombat-20261120.5',
    });
  });
  it('goes out when it differs, when asked, with new agents, or when nothing compares', () => {
    for (const o of [
      { force: false, agents: 'unchanged' as const, compared: { ...equal, equal: false } },
      { force: true, agents: 'unchanged' as const, compared: equal },
      { force: false, agents: 'sign' as const, compared: equal },
      { force: false, agents: 'unchanged' as const, compared: null },
    ])
      expect(plan.chooseHost(o)).toMatchObject({ changed: true, reuse: null });
  });
});

describe('the five kinds', () => {
  it.each([
    [{ imageChanged: true, runtimeKept: false, hosted: 0 }, 'host'],
    [{ imageChanged: true, runtimeKept: true, hosted: 2 }, 'host-kept'],
    [{ imageChanged: false, runtimeKept: false, hosted: 0 }, 'runtime'],
    [{ imageChanged: false, runtimeKept: true, hosted: 1 }, 'hosted'],
    [{ imageChanged: false, runtimeKept: true, hosted: 0 }, 'nothing'],
  ] as const)('%j is %s', (o, kind) => {
    expect(plan.kindOf(o)).toBe(kind);
  });
  it('only three of them make a release', () => {
    expect((['host', 'host-kept', 'runtime', 'hosted', 'nothing'] as const).filter(plan.isRelease)).toEqual([
      'host',
      'host-kept',
      'runtime',
    ]);
  });
});

const FIRST = '0.284.0';

describe('candidate numbers', () => {
  it('start one minor above the old flow’s last candidate, whatever that was', () => {
    expect(plan.firstVersion(['0.282.16', '0.283.0', '0.283.2', '0.99.0'])).toBe(FIRST);
    // The old flow made a feature release before releases moved here: the border moves with it.
    expect(plan.firstVersion(['0.283.2', '0.284.0'])).toBe('0.285.0');
    // Reports and annotations beside the manifests are no candidates.
    expect(plan.firstVersion(['0.283.2', '0.283.2.build-report', 'pins'])).toBe(FIRST);
    expect(plan.firstVersion([])).toBe('0.1.0');
  });
  it('count from the records', () => {
    expect(plan.nextVersion([], 'patch', null, FIRST)).toBe(FIRST);
    expect(plan.nextVersion(['0.282.16', '0.283.0', FIRST], 'patch', null, FIRST)).toBe('0.284.1');
    expect(plan.nextVersion([FIRST], 'minor', null, FIRST)).toBe('0.285.0');
  });
  it('never go below the first one or onto a release that exists', () => {
    expect(() => plan.nextVersion([], 'patch', '0.283.17', FIRST)).toThrow(/start at 0\.284\.0/);
    expect(() => plan.nextVersion([FIRST], 'patch', FIRST, FIRST)).toThrow(/already/);
    expect(plan.nextVersion([], 'patch', FIRST, FIRST)).toBe(FIRST);
  });
  it('leave the old flow its own minor: its next number is that minor’s next patch', () => {
    expect(plan.legacyVersion(['0.282.16', '0.283.0', '0.283.2'])).toBe('0.283.3');
    // A run of the old flow after the move left its folder, and the one repository's numbers are not its own.
    expect(plan.legacyVersion(['0.283.2'], ['0.283.3', '0.284.0', '0.284.7'])).toBe('0.283.4');
    expect(plan.firstVersion(['0.283.2', '0.283.3', '0.283.4'])).toBe(FIRST);
    expect(() => plan.legacyVersion([])).toThrow(/no candidate/);
  });
});

const aPlan = (over: Partial<plan.ReleasePlan> = {}): plan.ReleasePlan => ({
  v: 1,
  version: FIRST,
  what: 'something works again',
  why: 'It was broken.',
  commit: REV,
  kind: 'host',
  releaseId: 'whombat-20261121.1',
  runtime: { kept: false, stamp: commit, from: null, why: 'changed' },
  agents: { action: 'unchanged', version: '0.0.0-20261118064128.35fbc57', why: 'signed' },
  host: { changed: true, reuse: null, why: 'differs' },
  contracts: '4.10.0',
  cloud: null,
  web: { deploy: false, why: 'unchanged' },
  hosted: [],
  prep: { hashes: [], sign: false, commit: null },
  done: ['plan'],
  at: '2026-11-21T10:00:00.000Z',
  ...over,
});

describe('the steps of a run', () => {
  it('a release without prep or hosted parts builds, publishes and records', () => {
    const p = aPlan();
    const seen: plan.Step[] = [];
    for (let s = plan.nextStep(p); s; s = plan.nextStep(p)) {
      seen.push(s);
      p.done.push(s);
    }
    expect(seen).toEqual(['build', 'beta', 'record']);
  });
  it('a release that signs agents and deploys control has every step', () => {
    const p = aPlan({
      done: [],
      prep: { hashes: [], sign: true, commit: null },
      hosted: [{ part: 'control', ref: OLD }] as plan.ReleasePlan['hosted'],
    });
    const seen: plan.Step[] = [];
    for (let s = plan.nextStep(p); s; s = plan.nextStep(p)) {
      seen.push(s);
      p.done.push(s);
    }
    expect(seen).toEqual(['plan', 'prep', 'build', 'hosted', 'beta', 'record']);
  });
  it('a hosted-only run builds nothing and has no Beta step', () => {
    const p = aPlan({
      kind: 'hosted',
      releaseId: null,
      hosted: [{ part: 'web', ref: REV }] as plan.ReleasePlan['hosted'],
    });
    expect(plan.nextStep(p)).toBe('hosted');
    p.done.push('hosted');
    expect(plan.nextStep(p)).toBe('record');
  });
  it('nothing to ship ends with the plan', () => {
    expect(plan.nextStep(aPlan({ kind: 'nothing', releaseId: null }))).toBeNull();
  });
  it('the release is built from the prep commit when there is one', () => {
    expect(plan.releaseCommit(aPlan())).toBe(REV);
    expect(plan.releaseCommit(aPlan({ prep: { hashes: ['hostsGo'], sign: false, commit: OLD } }))).toBe(OLD);
  });
});

describe('carrying on', () => {
  const ask = { cloud: null, version: null, onMain: true };
  it('a stopped run carries on with its plan', () => {
    expect(plan.resumes(aPlan(), ask)).toMatchObject({ resume: true });
  });
  it('not when it is finished, was planned for another request, or its commit left main', () => {
    expect(plan.resumes(aPlan({ done: ['plan', 'build', 'beta', 'record'] }), ask).resume).toBe(false);
    expect(plan.resumes(aPlan(), { ...ask, cloud: OLD }).resume).toBe(false);
    expect(plan.resumes(aPlan({ cloud: { rev: OLD, parts: ['control'] } }), ask).resume).toBe(false);
    expect(plan.resumes(aPlan(), { ...ask, version: '0.999.0' }).resume).toBe(false);
    expect(plan.resumes(aPlan(), { ...ask, onMain: false }).resume).toBe(false);
    expect(plan.resumes(aPlan(), { ...ask, fresh: true }).resume).toBe(false);
  });
  it('a plan survives being written and read', () => {
    expect(plan.parsePlan(JSON.stringify(aPlan()))).toEqual(aPlan());
    expect(() => plan.parsePlan('{"v":2}')).toThrow(/not a plan/);
  });
});

describe('what is said and recorded', () => {
  it('names the kind, the runtime, the agents and the hosted parts', () => {
    const words = plan.planWords(aPlan());
    for (const part of ['host release', 'aaaaaaa', '35fbc57', 'nothing hosted'])
      expect(words).toContain(part);
    expect(
      plan.planWords(
        aPlan({ kind: 'hosted', hosted: [{ part: 'relay', ref: OLD }] as plan.ReleasePlan['hosted'] }),
      ),
    ).toContain('relay');
  });
  it('the record carries the commit, the stamp and what was deployed, and no channel without a release', () => {
    const r = plan.recordOf(aPlan(), {
      runtimeVersion: '0.2.0-20261119160000.aaaaaaa',
      hosted: [],
      at: 'now',
    });
    expect(r).toMatchObject({
      version: FIRST,
      commit: REV,
      kind: 'host',
      channel: 'development',
    });
    expect(r.runtime.stamp).toEqual(commit);
    const h = plan.recordOf(aPlan({ kind: 'hosted', releaseId: null }), {
      runtimeVersion: null,
      hosted: [],
      at: 'now',
    });
    expect(h.channel).toBeNull();
  });
});

describe('the runbook’s section', () => {
  it('says what went out in words a person reads, with the facts someone needs to act', () => {
    const r = plan.recordOf(
      aPlan({ hosted: [{ part: 'control', ref: OLD }] as plan.ReleasePlan['hosted'] }),
      {
        runtimeVersion: '0.2.0-20261119160000.aaaaaaa',
        hosted: [{ part: 'control', ref: OLD }] as plan.ReleasePlan['hosted'],
        at: '2026-11-21T10:05:00.000Z',
      },
    );
    const text = runbookSection(r, '9 min 10 s');
    for (const fact of [
      'whombat-20261121.1',
      FIRST,
      '2026-11-21',
      REV.slice(0, 12),
      'control',
      'promote whombat-20261121.1 --yes',
    ])
      expect(text).toContain(fact);
  });
  it('a run without a release names no release and no promotion', () => {
    const r = plan.recordOf(aPlan({ kind: 'hosted', releaseId: null }), {
      runtimeVersion: null,
      hosted: [],
      at: '2026-11-21T10:05:00.000Z',
    });
    const text = runbookSection(r, '1 min 02 s');
    expect(text).toContain('hosted parts only');
    expect(text).not.toContain('promote');
  });
});

describe('the copies of the source tree a run leaves in the Nix store', () => {
  const copy = '/nix/store/c84f7g4alsvyf06pijgjrp96frq3n28a-source';
  const since = 1_795_200_000;
  it('are removed when the run made them and nothing refers to them', () => {
    expect(plan.dropsCopy({ path: copy, registeredAt: since + 5, since, referrers: [] }).drop).toBe(true);
    expect(plan.dropsCopy({ path: copy, registeredAt: since, since, referrers: [] }).drop).toBe(true);
  });
  it('stay when they were there before, when something refers to them, or when they are something else', () => {
    expect(plan.dropsCopy({ path: copy, registeredAt: since - 1, since, referrers: [] })).toMatchObject({
      drop: false,
      why: 'it was there before this run',
    });
    const used = plan.dropsCopy({
      path: copy,
      registeredAt: since + 5,
      since,
      referrers: ['/nix/store/vd15ib20lw46a0alb9wv97mdxcvbnpjl-whombat-runtime-pnpm-deps.drv'],
    });
    expect(used.drop).toBe(false);
    expect(plan.dropsCopy({ path: copy, registeredAt: null, since, referrers: [] }).drop).toBe(false);
    for (const other of [
      '/nix/store/c84f7g4alsvyf06pijgjrp96frq3n28a-whombat-runtime-0.2.0',
      '/nix/store/c84f7g4alsvyf06pijgjrp96frq3n28a-source/appliance',
      '/home/someone/source',
    ])
      expect(plan.dropsCopy({ path: other, registeredAt: since + 5, since, referrers: [] }).drop).toBe(false);
  });
});

describe('the first release from the one repository', () => {
  it('carries the agents servers have and adds no database change', () => {
    const first = true;
    expect(plan.firstReleaseRefusal({ first, agents: 'unchanged' })).toBeNull();
    expect(plan.firstReleaseRefusal({ first, agents: 'sign' })).toMatch(/agents servers already have/);
    const same = { writes: 85, lastWrites: 85, last: 'whombat-20261120.19' };
    expect(plan.firstReleaseRefusal({ first, schema: same })).toBeNull();
    expect(
      plan.firstReleaseRefusal({
        first,
        schema: { writes: 86, lastWrites: 85, last: 'whombat-20261120.19' },
      }),
    ).toMatch(/writes schema 86 where whombat-20261120\.19 wrote 85/);
    // Nothing published to compare with (a repository that starts here): nothing to hold it to.
    expect(
      plan.firstReleaseRefusal({ first, schema: { writes: 85, lastWrites: null, last: null } }),
    ).toBeNull();
  });

  it('holds no later release to it', () => {
    expect(plan.firstReleaseRefusal({ first: false, agents: 'sign' })).toBeNull();
    expect(
      plan.firstReleaseRefusal({ first: false, schema: { writes: 86, lastWrites: 85, last: 'x' } }),
    ).toBeNull();
  });
});
