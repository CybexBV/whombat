/**
 * A managed runner's Claude Code is ready when the manager installed it (SUB-49): readiness, version and drift come
 * from `WHOMBAT_CLIENTS_FILE` — re-read at every check and whenever the file changes — and the image's pin only without
 * one, a pin that isn't installed here (as on the appliance where a newer client was installed than the image pinned).
 * ChatGPT runs on Hermes alone (hermes-native.md HN-04): ready with Hermes, whatever the file says about a Codex client.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliAvailability } from '@whombat/agent-runtime';
import { CLAUDE_BUNDLE, clientNotInstalledText } from '@whombat/agent-runtime/providers';
import type { ProviderCheck } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { RunnerApi } from './api';
import { RunnerClients } from './clients';
import { createRegistry } from './registry';
import { Runner } from './runner';
import { testPolicy } from './test-sandbox';

/** Hermes as a ready runner reports it. */
const HERMES_READY = { ready: true, version: '0.22.5', problem: null, detail: null };

// Plain path segments only: the contract's executable paths refuse a dotted segment (so not under ~/.cache).
const dir = mkdtempSync(join(/(^|\/)\./.test(tmpdir()) ? '/tmp' : tmpdir(), 'wb-runner-ready-'));
const root = join(dir, 'clients');
const file = join(dir, 'clients.json');

/** Installs a client the way the manager does: `<root>/<provider>/<version>/<provider>`; its digest. */
function install(provider: 'claude' | 'codex', version: string): { path: string; sha256: string } {
  const path = join(root, provider, version, provider);
  mkdirSync(join(root, provider, version), { recursive: true });
  const bytes = `#!/bin/sh\necho ${provider} ${version}\n`;
  writeFileSync(path, bytes, { mode: 0o755 });
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const installed = (provider: 'claude' | 'codex', version: string, exe: { path: string; sha256: string }) => ({
  provider,
  state: 'installed',
  installed: {
    version,
    installedAt: '2026-09-26T10:00:00Z',
    executable: exe,
    fixturesDigest: `sha256:${'c'.repeat(64)}`,
  },
  latest: null,
  progress: null,
  error: null,
});
const notInstalled = (provider: 'claude' | 'codex') => ({
  provider,
  state: 'not_installed',
  installed: null,
  latest: null,
  progress: null,
  error: null,
});

/** Written whole and renamed into place, as the server does (SUB-46). */
function writeClients(clients: unknown[] | string) {
  const temp = `${file}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(
    temp,
    typeof clients === 'string' ? clients : JSON.stringify({ v: 1, clients, channel: null }),
  );
  renameSync(temp, file);
}

class Api implements RunnerApi {
  beats: { status?: { providers: ProviderCheck[] } }[] = [];
  async claim() {
    return null;
  }
  async progress() {
    return { cancel: false, reason: null };
  }
  async complete() {}
  async heartbeat(body: Parameters<RunnerApi['heartbeat']>[0]) {
    this.beats.push(body as never);
    return { cancel: [] };
  }
  async gitCredentials(): Promise<never> {
    throw new Error('no git');
  }
}

async function until<T>(read: () => T | undefined, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('a managed runner’s providers (SUB-49)', () => {
  it('are ready on the installed client, follow an update and a removal, and fall back to the image’s pin only without a file', async () => {
    rmSync(file, { force: true });
    // The image's pinned binary isn't where the image expects it (the provider's own managed `available()`).
    const imageEnv = { PATH: '/nonexistent', WHOMBAT_CLAUDE_PATH: join(dir, 'image', 'claude') };
    const target: NodeJS.ProcessEnv = {};
    const clients = new RunnerClients({ env: {}, clientsFile: file, clientsRoot: root, target });
    const registry = await createRegistry({
      hermesCheck: async () => HERMES_READY,
      cliCheck: (kind) => cliAvailability(kind, { env: imageEnv, managed: true }),
      listModels: async () => null,
      ...clients.registryOptions(),
      // Only a change of the clients file makes a provider due in this test.
      retryMs: 3_600_000,
      refreshMs: 3_600_000,
    });
    const api = new Api();
    const runner = new Runner({
      api,
      registry,
      serverUrl: 'http://127.0.0.1:1',
      workspacesRoot: dir,
      managed: testPolicy(),
    });
    const check = (provider: string) =>
      registry.status?.().providers.find((p) => p.provider === provider) as ProviderCheck;
    /** Beats until the server heard `want` of `provider`. */
    const heard = async (provider: string, want: Partial<ProviderCheck>) => {
      await runner.beat();
      return until(() => {
        const last = api.beats.at(-1)?.status?.providers.find((p) => p.provider === provider);
        return last && Object.entries(want).every(([k, v]) => (last as Record<string, unknown>)[k] === v)
          ? last
          : undefined;
      });
    };
    const chatgptReady = () =>
      expect(check('codex')).toMatchObject({ state: 'ready', version: 'Hermes 0.22.5' });

    // No clients file yet: the image's pin, which isn't installed. ChatGPT is Hermes's own.
    expect(check('claude')).toMatchObject({ state: 'missing', version: null });
    expect(check('claude').detail).toContain(`Claude Code ${CLAUDE_BUNDLE.version} isn’t installed`);
    chatgptReady();
    expect(registry.claims()).toEqual(['codex', 'local']);

    // The manager installs a version the image doesn't pin: ready on it, reported as installed.
    const claude1 = install('claude', '2.1.290');
    writeClients([installed('claude', '2.1.290', claude1), notInstalled('codex')]);
    await heard('claude', { state: 'ready', version: '2.1.290 (Claude Code)' });
    expect(registry.claims().sort()).toEqual(['claude', 'codex', 'local']);
    chatgptReady();
    // A turn runs exactly that client, and its drift check passes on its digest.
    const legacy = async () => {
      throw new Error('the image’s pins are not asked');
    };
    expect(await clients.prepare('claude')).toMatchObject({ ok: true, source: 'bundle', path: claude1.path });
    expect(target.WHOMBAT_CLAUDE_PATH).toBe(claude1.path);
    expect(await clients.drift(legacy)('claude')).toBeNull();

    // An update between two checks: the newer version, without a restart.
    const claude2 = install('claude', '2.1.302');
    writeClients([installed('claude', '2.1.302', claude2)]);
    await heard('claude', { state: 'ready', version: '2.1.302 (Claude Code)' });
    expect(await clients.prepare('claude')).toMatchObject({ path: claude2.path, version: '2.1.302' });
    expect(await clients.drift(legacy)('claude')).toBeNull();

    // The listed binary changed on disk: not ready (its digest), whatever the image pins.
    writeFileSync(claude2.path, '#!/bin/sh\necho tampered\n');
    expect((await registry.recheck?.({ force: true }))?.join('\n')).toContain('digest differs');
    writeFileSync(claude2.path, '#!/bin/sh\necho claude 2.1.302\n');
    await registry.recheck?.({ force: true });
    expect(check('claude')).toMatchObject({ state: 'ready', version: '2.1.302 (Claude Code)' });

    // A bundle outside the manager's install root never counts as installed (SUB-45).
    const elsewhere = join(dir, 'elsewhere-claude');
    writeFileSync(elsewhere, '#!/bin/sh\necho claude 2.1.302\n', { mode: 0o755 });
    writeClients([installed('claude', '2.1.302', { path: elsewhere, sha256: claude2.sha256 })]);
    await heard('claude', { state: 'error' });
    expect(check('claude').detail).toMatch(/isn’t one its client installer put in place/);

    // Removed: client.not_installed, for the claims and for a turn; ChatGPT doesn't care.
    writeClients([notInstalled('claude')]);
    await heard('claude', { state: 'missing', detail: clientNotInstalledText('claude') });
    expect(registry.claims()).toEqual(['codex', 'local']);
    expect(await clients.prepare('claude')).toMatchObject({ ok: false, code: 'client.not_installed' });
    chatgptReady();

    // A file that can't be read refuses, never falls back to the image (SUB-46).
    writeClients('{"v":1,"clients":[{"provider":"cla');
    await heard('claude', { state: 'error' });
    expect(check('claude').detail).toMatch(/can’t read which Claude Code is installed/);
    expect(registry.claims()).toEqual(['codex', 'local']);

    // No file again (an older manager): the image's pin.
    rmSync(file);
    await heard('claude', { state: 'missing' });
    expect(check('claude').detail).toContain('isn’t installed where the appliance expects it');
  });
});
