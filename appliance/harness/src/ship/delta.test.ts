import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TMP_DIR } from '../lib/paths.ts';
import { parseShipArgs } from './args.ts';
import { decideHost, type HostDeps } from './build.ts';
import { isoInfo } from './iso.ts';
import { type ReleaseNotes, renderMarkdown } from './notes.ts';

describe('automatic runtime-only releases on Beta’s newest release (UP-X16, ONE-02)', () => {
  const H = '/nix/store/zdywd424571h6w0i94c0chjzlkkisi5y-nixos-system-whombat';
  const builds: Record<string, Record<string, unknown>> = {
    'whombat-20261001.1': {
      releaseId: 'whombat-20261001.1',
      env: 'prod',
      class: 'host',
      tuple: {
        host: { version: 'whombat-20261001.1', storePath: H },
        runtime: { storePath: '/nix/store/rt1' },
      },
    },
    'whombat-20261002.1': {
      releaseId: 'whombat-20261002.1',
      env: 'prod',
      class: 'runtime',
      tuple: {
        host: { version: 'whombat-20261001.1', storePath: H },
        runtime: { storePath: '/nix/store/rt2' },
      },
    },
  };
  const deps = (
    o: Partial<HostDeps> & { evaluated?: string; fail?: string } = {},
  ): HostDeps & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      // Beta before ONE-02 carried the DEV twins; one family with the image's own releases (LNK-22).
      published: async () => ['whombat-dev-20261001.4', 'whombat-20261001.1', 'whombat-20261002.1'],
      findBuild: (id) => (builds[id] ? { dir: `/r/${id}`, build: builds[id] } : null),
      hostPath: async (f) => {
        asked.push(f);
        if (o.fail) throw new Error(o.fail);
        const host = o.evaluated ?? H;
        return { host, expected: H, equal: host === H };
      },
      ...o,
    };
  };
  const auto = { reuseHost: null, forceHost: false };

  it('reuses Beta’s newest release when this commit’s host is its host’s, evaluated against the host release', async () => {
    const d = deps();
    const r = await decideHost(auto, '/nix/store/rt3', d);
    expect(r).toMatchObject({
      class: 'runtime',
      reuse: 'whombat-20261002.1',
      compared: {
        release: 'whombat-20261002.1',
        hostRelease: 'whombat-20261001.1',
        expected: H,
        evaluated: H,
      },
    });
    expect(d.asked).toEqual(['/r/whombat-20261001.1/build.json']);
  });

  it('builds a host release when the host differs, the evaluation fails or nothing can be compared', async () => {
    expect(await decideHost(auto, '/nix/store/rt3', deps({ evaluated: '/nix/store/other' }))).toMatchObject({
      class: 'host',
      reuse: null,
      reason: expect.stringMatching(/differs from whombat-20261001\.1's/),
      compared: { evaluated: '/nix/store/other' },
    });
    expect(
      await decideHost(auto, '/nix/store/rt3', deps({ fail: 'error: attribute missing' })),
    ).toMatchObject({
      class: 'host',
      reason: expect.stringMatching(/failed \(error: attribute missing\)/),
    });
    expect(await decideHost(auto, 'x', deps({ published: async () => null }))).toMatchObject({
      class: 'host',
    });
    expect(await decideHost(auto, 'x', deps({ published: async () => [] }))).toMatchObject({ class: 'host' });
    expect(
      await decideHost(auto, 'x', deps({ published: async () => ['whombat-20261009.1'] })),
    ).toMatchObject({
      class: 'host',
      reason: expect.stringMatching(/no build.json here/),
    });
    // A DEV twin as Beta's newest (before the first release of the one image): never reused.
    const twinNewest = deps({ published: async () => ['whombat-20261002.1', 'whombat-dev-20261002.2'] });
    expect(await decideHost(auto, '/nix/store/rt3', twinNewest)).toMatchObject({
      class: 'host',
      reason: expect.stringMatching(/whombat-dev-20261002\.2, Beta's newest release, is the DEV image's/),
    });
    expect(twinNewest.asked).toEqual([]);
  });

  it('follows --reuse-host and --host without evaluating, and refuses when nothing changed', async () => {
    const d = deps();
    expect(await decideHost({ reuseHost: 'whombat-20261001.1', forceHost: false }, 'x', d)).toMatchObject({
      class: 'runtime',
      reuse: 'whombat-20261001.1',
    });
    expect(await decideHost({ reuseHost: null, forceHost: true }, 'x', d)).toMatchObject({ class: 'host' });
    expect(d.asked).toEqual([]);
    await expect(decideHost(auto, '/nix/store/rt2', deps())).rejects.toThrow(/nothing to release/);
  });

  it('takes --host and the iso command, and no --closures (IN-414)', () => {
    expect(parseShipArgs(['build', 'whombat-20261003.1', '--host']).build.forceHost).toBe(true);
    expect(parseShipArgs(['build', 'whombat-20261003.1']).build.forceHost).toBe(false);
    expect(() => parseShipArgs(['build', 'x', '--closures', 'index'])).toThrow(/unknown option --closures/);
    expect(() => parseShipArgs(['build', 'x', '--host', '--reuse-host', 'whombat-20261001.1'])).toThrow(
      /not both/,
    );
    expect(parseShipArgs(['iso', 'whombat-20261001.1']).command).toBe('iso');
    // No DEV twin since ONE-01: one ISO per build.
    expect(() => parseShipArgs(['iso', 'whombat-20261001.1', '--dev'])).toThrow(/went with DEV/);
    expect(() => parseShipArgs(['iso', 'x', '--both'])).toThrow(/went with DEV/);
    expect(() => parseShipArgs(['iso'])).toThrow(/<prod id>/);
  });
});

describe('the ISO on demand (UP-X15)', () => {
  it('reads iso.json first, then build.json’s iso of older builds', () => {
    const dir = mkdtempSync(join(TMP_DIR, 'ship-iso-'));
    try {
      expect(isoInfo(dir)).toBeNull();
      writeFileSync(join(dir, 'build.json'), JSON.stringify({ releaseId: 'whombat-20261001.1', iso: null }));
      expect(isoInfo(dir)).toBeNull();
      const old = { file: 'old.iso', sha256: 'a'.repeat(64), size: 3, storePath: '/nix/store/old' };
      writeFileSync(join(dir, 'build.json'), JSON.stringify({ releaseId: 'whombat-20261001.1', iso: old }));
      expect(isoInfo(dir)).toMatchObject({
        file: 'old.iso',
        path: join(dir, 'iso', 'old.iso'),
        from: 'build.json',
      });
      mkdirSync(join(dir, 'iso'));
      writeFileSync(
        join(dir, 'iso.json'),
        JSON.stringify({
          v: 1,
          file: 'new.iso',
          sha256: 'b'.repeat(64),
          size: 4,
          storePath: '/nix/store/new',
        }),
      );
      expect(isoInfo(dir)).toMatchObject({
        file: 'new.iso',
        sha256: 'b'.repeat(64),
        size: 4,
        from: 'iso.json',
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('the notes say how a release is delivered', () => {
  it('renders the host decision', () => {
    const n: ReleaseNotes = {
      v: 1,
      releaseId: 'whombat-20261003.1',
      twin: 'whombat-dev-20261003.1',
      class: 'runtime',
      previous: 'whombat-20261001.1',
      summary: 's',
      versions: {
        runtime: { from: 'a', to: 'b' },
        manager: { from: 'm', to: 'm' },
        host: { from: 'whombat-20261001.1', to: 'whombat-20261001.1' },
      },
      components: [],
      schema: { from: 49, to: 49 },
      migrations: [],
      knownIssues: [],
      generatedAt: 'now',
      delivery: {
        host: {
          class: 'runtime',
          reason: 'only the runtime changed',
          reusedFrom: 'whombat-20261001.1',
          compared: {
            release: 'whombat-20261001.1',
            hostRelease: 'whombat-20261001.1',
            expected: '/h',
            evaluated: '/h',
          },
        },
      },
    };
    const md = renderMarkdown(n);
    expect(md).toContain('## Delivery');
    expect(md).toContain('Runtime-only, on the host of whombat-20261001.1: only the runtime changed');
    expect(md).not.toContain('export');
  });
});
