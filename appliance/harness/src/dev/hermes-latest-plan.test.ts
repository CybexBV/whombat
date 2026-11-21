import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_DIR } from '../lib/paths.ts';
import * as plan from './hermes-latest-plan.ts';

const PIN_TS = `/**
 * The pinned Hermes release (HE-28).
 */
export const HERMES_PIN = {
  version: '0.22.5',
  tag: 'v0.22.5',
  commit: 'bf0203a794a07aac3ff764972ab9087baa4e4f4e',
};
`;
const NEW = 'c0ffee0000000000000000000000000000000001';

describe('which Hermes release is new', () => {
  it('takes stable SemVer tags only: no canary, pre-release, draft or calendar tag', () => {
    expect(plan.stableVersion('v0.23.0')).toBe('0.23.0');
    expect(plan.stableVersion('v0.23.0+canary.20261027')).toBeNull();
    expect(plan.stableVersion('v0.23.0-rc.1')).toBeNull();
    expect(plan.stableVersion('v2026.9.24')).toBeNull();
    expect(plan.stableVersion('0.23.0')).toBeNull();
    const r = (tag_name: string, more: Partial<plan.GithubRelease> = {}) => ({
      tag_name,
      draft: false,
      prerelease: false,
      ...more,
    });
    expect(
      plan.newestStable([
        r('v0.24.0', { prerelease: true }),
        r('v0.25.0', { draft: true }),
        r('v0.23.0+canary.1'),
        r('v2026.9.24'),
        r('v0.22.10'),
        r('v0.22.5'),
        r('v0.22.9'),
      ]),
    ).toEqual({ tag: 'v0.22.10', version: '0.22.10' });
    expect(plan.newestStable([r('v0.23.0+canary.1')])).toBeNull();
    expect(plan.compareSemver('0.22.10', '0.22.9')).toBeGreaterThan(0);
    expect(plan.compareSemver('0.23.0', '0.23.0')).toBe(0);
  });
});

describe('the pin in Whombat', () => {
  it('reads and moves pin.ts, keeping the rest', () => {
    expect(plan.readPinTs(PIN_TS)).toEqual({
      version: '0.22.5',
      tag: 'v0.22.5',
      commit: 'bf0203a794a07aac3ff764972ab9087baa4e4f4e',
    });
    const moved = plan.setPinTs(PIN_TS, { version: '0.23.0', tag: 'v0.23.0', commit: NEW });
    expect(plan.readPinTs(moved)).toEqual({ version: '0.23.0', tag: 'v0.23.0', commit: NEW });
    expect(
      moved.replace(/0\.23\.0/g, '0.22.5').replace(NEW, 'bf0203a794a07aac3ff764972ab9087baa4e4f4e'),
    ).toBe(PIN_TS);
  });
});

describe('the pin here', () => {
  const flake = readFileSync(join(REPO_DIR, 'flake.nix'), 'utf8');
  const pkg = readFileSync(join(REPO_DIR, 'nix', 'packages', 'hermes', 'default.nix'), 'utf8');

  it('moves the hermes input, its uv2nix inputs and the package together, and nothing else', () => {
    const before = plan.readFlakeHermes(flake);
    expect(before.rev).toMatch(/^[0-9a-f]{40}$/);
    expect(before.tag).toMatch(/^v\d+\.\d+\.\d+$/);
    const revs = {
      'pyproject-nix': 'a'.repeat(40),
      uv2nix: 'b'.repeat(40),
      'pyproject-build-systems': 'c'.repeat(40),
    };
    const moved = plan.setFlakeUv2nix(plan.setFlakeHermes(flake, NEW, 'v0.23.0'), revs);
    expect(plan.readFlakeHermes(moved)).toEqual({ rev: NEW, tag: 'v0.23.0' });
    for (const [input, repo] of Object.entries(plan.UV2NIX_INPUTS))
      expect(moved).toContain(`url = "github:${repo}/${revs[input as plan.Uv2nixInput]}";`);
    const changed = moved.split('\n').filter((l, i) => l !== flake.split('\n')[i]);
    expect(changed).toHaveLength(4);

    const p = plan.setHermesPackage(pkg, '0.23.0', NEW);
    expect(plan.readHermesPackage(p)).toEqual({ version: '0.23.0', rev: NEW });
    expect(p.split('\n').filter((l, i) => l !== pkg.split('\n')[i])).toHaveLength(2);
  });

  it("takes the uv2nix revisions from Hermes's own flake.lock", () => {
    const lock = JSON.stringify({
      root: 'root',
      nodes: {
        root: {
          inputs: { 'pyproject-nix': 'pyproject-nix', uv2nix: 'uv2nix', 'pyproject-build-systems': 'pbs' },
        },
        'pyproject-nix': { locked: { owner: 'pyproject-nix', repo: 'pyproject.nix', rev: '1'.repeat(40) } },
        uv2nix: { locked: { owner: 'pyproject-nix', repo: 'uv2nix', rev: '2'.repeat(40) } },
        pbs: { locked: { owner: 'pyproject-nix', repo: 'build-system-pkgs', rev: '3'.repeat(40) } },
      },
    });
    expect(plan.uv2nixRevs(lock)).toEqual({
      'pyproject-nix': '1'.repeat(40),
      uv2nix: '2'.repeat(40),
      'pyproject-build-systems': '3'.repeat(40),
    });
    // Renamed in Hermes's root: found by repository.
    const renamed = JSON.parse(lock);
    renamed.nodes.root.inputs = {};
    expect(plan.uv2nixRevs(JSON.stringify(renamed)).uv2nix).toBe('2'.repeat(40));
    renamed.nodes.other = { locked: { owner: 'pyproject-nix', repo: 'uv2nix', rev: '4'.repeat(40) } };
    expect(() => plan.uv2nixRevs(JSON.stringify(renamed))).toThrow(/uv2nix/);
  });
});

describe('shipping it', () => {
  it('names Hermes in the candidate (HU-06)', () => {
    expect(plan.candidateWords('0.23.0').what).toBe('hermes agent 0.23.0');
    expect(plan.candidateWords('0.23.0').why).toContain('0.23.0');
  });

  it('takes a main that moved only outside what the test covered', () => {
    const outside = (changed: string[]) => plan.movedOutsideTest(changed, plan.COVERED);
    expect(outside(['apps/web/src/x.tsx', 'packages/core/a.ts'])).toBe(true);
    expect(outside(['packages/hermes-whombat/whombat_hermes/plugin.py'])).toBe(false);
    expect(outside(['packages/agent-runtime/src/hermes/pin.ts'])).toBe(false);
    expect(outside(['packages/agent-runtime/src/access/x.ts'])).toBe(true);
    expect(outside(['appliance/flake.nix', 'appliance/manifest/candidates/0.166.0.json'])).toBe(true);
    expect(outside(['appliance/nix/modules/hermes.nix'])).toBe(false);
    expect(outside(['appliance/vm-tests/runtime-live-turn.nix'])).toBe(false);
    expect(outside(['appliance/nix/packages/hermes-extra/x.nix'])).toBe(true);
  });
});

describe('the review of a new version (NX-492)', () => {
  it('asks once, waits two days, then tests it as it is', () => {
    const now = Date.parse('2026-11-03T05:00:00Z');
    expect(plan.reviewStep(null, now)).toBe('ask');
    expect(plan.reviewStep(now - 60_000, now)).toBe('wait');
    expect(plan.reviewStep(now - plan.REVIEW_WAIT_MS + 1, now)).toBe('wait');
    expect(plan.reviewStep(now - plan.REVIEW_WAIT_MS, now)).toBe('test');
  });

  it('names the version and its release in the request', () => {
    expect(plan.reviewRequest('0.22.7', 'v0.22.7', '0.22.6', 'NousResearch/hermes-agent')).toEqual({
      event: 'hermes-release',
      version: '0.22.7',
      tag: 'v0.22.7',
      pinned: '0.22.6',
      release: 'https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.7',
    });
  });
});
