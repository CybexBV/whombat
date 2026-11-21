import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../lib/proc.ts';
import type { SourceState } from './env.ts';

const commands = vi.hoisted(() => ({ run: vi.fn(), must: vi.fn() }));
vi.mock('../lib/proc.ts', async (original) => ({
  ...(await original<typeof import('../lib/proc.ts')>()),
  ...commands,
}));
vi.mock('../lib/paths.ts', async (original) => {
  const o = await original<typeof import('../lib/paths.ts')>();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  // An empty environment of its own: a scenario running beside these tests leaves a runtime override in the real
  // one (a fixture build to run instead), which would change what the builds here do.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-web-home-'));
  const moved = (v: unknown) =>
    typeof v === 'string' && v.startsWith(o.STATE_HOME) ? home + v.slice(o.STATE_HOME.length) : v;
  return {
    ...o,
    paths: Object.fromEntries(Object.entries(o.paths).map(([k, v]) => [k, moved(v)])) as typeof o.paths,
    publicUrls: {
      control: 'https://control.example',
      relay: 'https://relay.example',
      web: 'https://web.example',
    },
  };
});

import { buildHostedWeb, buildRuntimeWeb } from './services.ts';

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const source = (): SourceState => {
  const path = mkdtempSync(join(tmpdir(), 'prepare-web-'));
  roots.push(path);
  mkdirSync(join(path, 'apps/web'), { recursive: true });
  writeFileSync(join(path, 'apps/web/package.json'), '{}');
  return { id: 'app', path, commit: 'a'.repeat(40), mode: 'pinned', dirty: false };
};
const success = { code: 0 } as RunResult;

describe('preparing pages before their services start', () => {
  it('can prepare both targets from one clone and reuses the completed hosted build', async () => {
    const src = source();
    const dist = join(src.path, 'apps/web/dist-hosted');
    commands.run.mockResolvedValue(success);
    commands.must.mockImplementation(async () => {
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, 'index.html'), '<html></html>');
      return success;
    });
    const [_, hosted] = await Promise.all([buildRuntimeWeb(src, () => {}), buildHostedWeb(src, () => {})]);
    expect(hosted).toBe(dist);
    expect(commands.run.mock.calls[0]?.[2]).toMatchObject({
      cwd: src.path,
      env: { VITE_FIXTURES: '', VITE_WHOMBAT_TARGET: 'box' },
    });
    expect(commands.must.mock.calls[0]?.[2]).toMatchObject({
      cwd: join(src.path, 'apps/web'),
      env: {
        VITE_WHOMBAT_CONTROL_URL: 'https://control.example',
        VITE_WHOMBAT_RELAY_ORIGINS: 'wss://relay.example',
      },
    });
    const stamp = JSON.parse(readFileSync(join(dist, '.whombat-build.json'), 'utf8'));
    expect(stamp).toMatchObject({
      commit: src.commit,
      control: 'https://control.example',
      relay: 'https://relay.example',
    });
    expect(await buildHostedWeb(src, () => {})).toBe(dist);
    expect(commands.must).toHaveBeenCalledTimes(1);
  });

  it('does not record a failed hosted build as prepared', async () => {
    const src = source();
    commands.must.mockRejectedValue(new Error('build failed'));
    await expect(buildHostedWeb(src, () => {})).rejects.toThrow('build failed');
    expect(existsSync(join(src.path, 'apps/web/dist-hosted/.whombat-build.json'))).toBe(false);
  });
});
