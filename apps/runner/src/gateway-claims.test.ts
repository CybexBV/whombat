/**
 * What a runner claims for (hermes-engine.md HE-32; ai-gateway.md AIG-16; hermes-native.md HN-04): every turn runs on
 * Hermes, so nothing while Hermes isn't ready; then `claude` while Claude Code is installed here (signed in or not: a
 * turn signs in with the person's sign-in) or the burrow's AI gateway is switched on for it (a gateway turn needs no CLI), `codex`
 * (ChatGPT, Hermes's own) and `local` always. The switches come with every heartbeat, and a change ends the waiting
 * claim so the next one asks for what this runner can run now (SUB-53).
 */
import type { Availability } from '@whombat/agent-runtime';
import type { HermesCheck } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { RunnerApi } from './api';
import { createRegistry, gatewaySwitchesOf } from './registry';
import { Runner } from './runner';
import { testPolicy } from './test-sandbox';

const HERMES_READY: HermesCheck = { ready: true, version: '0.22.5', problem: null, detail: null };
const HERMES_MISSING: HermesCheck = { ready: false, version: null, problem: 'missing', detail: 'not there' };

const LOGGED_OUT: Availability = {
  ok: false,
  reason: 'Claude is installed but not logged in.',
  kind: 'logged_out',
};
const MISSING: Availability = { ok: false, reason: 'spawn claude ENOENT', kind: 'missing' };
const READY: Availability = { ok: true, version: '2.1.302 (Claude Code)' };

/** A registry whose Hermes and Claude Code answer what the test says. */
function registryWith(claude: Availability, hermes = HERMES_READY) {
  return createRegistry({
    hermesCheck: async () => hermes,
    cliCheck: async () => claude,
    listModels: async () => null,
  });
}

describe('a runner’s claims on Hermes (HE-32, AIG-16)', () => {
  it('claims Claude Code installed here, signed in or not, or its gateway switch on; ChatGPT with Hermes; local', async () => {
    const registry = await registryWith(MISSING);
    expect(registry.claims()).toEqual(['codex', 'local']);
    expect(registry.for('claude')).toBeNull();
    expect(registry.for('codex')?.kind).toBe('codex');
    expect(registry.for('local')?.kind).toBe('local');

    // Switched on for Claude: Claude Code isn't installed here, which a gateway turn doesn't need.
    expect(registry.setGateway?.({ claude: true, codex: false })).toBe(true);
    expect(registry.claims()).toEqual(['claude', 'codex', 'local']);
    expect(registry.for('claude', { gateway: true })?.kind).toBe('claude');
    expect(registry.for('claude')).toBeNull();
    // The same switches again: nothing changed.
    expect(registry.setGateway?.({ claude: true, codex: false })).toBe(false);

    // Off (or a server without the gateway): not claimed for any more, but a gateway turn claimed before still runs (AIG-07).
    expect(registry.setGateway?.(null)).toBe(true);
    expect(registry.claims()).toEqual(['codex', 'local']);
    expect(registry.for('claude', { gateway: true })?.kind).toBe('claude');
    // The AI provider panel still reads the truth about the host's Claude Code, ChatGPT's Hermes, and Hermes.
    const status = registry.status?.();
    expect(status?.providers.find((p) => p.provider === 'claude')?.state).toBe('missing');
    expect(status?.providers.find((p) => p.provider === 'codex')).toMatchObject({
      state: 'ready',
      version: 'Hermes 0.22.5',
    });
    expect(status?.hermes).toEqual(HERMES_READY);
    const loggedOut = await registryWith(LOGGED_OUT);
    expect(loggedOut.claims()).toEqual(['claude', 'codex', 'local']);
  });

  it('with the scripted Hermes claims every provider and runs them without a CLI (HE-46)', async () => {
    const registry = await registryWith(MISSING, {
      ready: true,
      version: '0.22.5 (scripted)',
      problem: null,
      detail: null,
    });
    expect(registry.claims()).toEqual(['claude', 'codex', 'local']);
    expect(registry.for('claude')?.kind).toBe('claude');
    expect(registry.hermesScripted?.()).toBe(true);
    // A real Hermes is never taken for it.
    const real = await registryWith(MISSING);
    expect(real.claims()).toEqual(['codex', 'local']);
    expect(real.hermesScripted?.()).toBe(false);
  });

  it('claims nothing and runs nothing while Hermes isn’t ready', async () => {
    const registry = await registryWith(READY, HERMES_MISSING);
    expect(registry.status?.().providers.find((p) => p.provider === 'codex')?.state).toBe('missing');
    expect(registry.claims()).toEqual([]);
    expect(registry.for('claude')).toBeNull();
    expect(registry.for('local')).toBeNull();
    expect(registry.status?.().hermes).toMatchObject({ ready: false, problem: 'missing' });
  });

  it('reads the heartbeat’s switches, and none from an answer without them', () => {
    expect(gatewaySwitchesOf({ gateway: { claude: true, codex: false } })).toEqual({
      claude: true,
      codex: false,
    });
    // Not the contract's shape: none (both off).
    expect(gatewaySwitchesOf({ gateway: { claude: 'yes' } })).toBeNull();
    expect(gatewaySwitchesOf({})).toBeNull();
    expect(gatewaySwitchesOf({ gateway: null })).toBeNull();
  });
});

interface Claim {
  providers: string[];
  answered: boolean;
}

/** A server whose claims wait (a long poll) until the runner hangs up; its heartbeats carry the switches. */
class Api implements RunnerApi {
  claims: Claim[] = [];
  gateway: { claude: boolean; codex: boolean } | undefined;
  async claim(body: Parameters<RunnerApi['claim']>[0], signal?: AbortSignal) {
    const claim: Claim = { providers: [...body.providers], answered: false };
    this.claims.push(claim);
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    claim.answered = true;
    return null;
  }
  async progress() {
    return { cancel: false, reason: null };
  }
  async complete() {}
  async heartbeat() {
    return { cancel: [], ...(this.gateway ? { gateway: this.gateway } : {}) } as Awaited<
      ReturnType<RunnerApi['heartbeat']>
    >;
  }
  async gitCredentials(): Promise<never> {
    throw new Error('no git');
  }
}

async function until<T>(read: () => T | undefined, ms = 2_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('a runner’s claims follow the AI gateway’s switches (AIG-16, SUB-53)', () => {
  it('a switch change ends the waiting claim, and the next one asks for what it can run now', async () => {
    const api = new Api();
    const registry = await registryWith(MISSING);
    const logs: string[] = [];
    const runner = new Runner({
      api,
      registry,
      serverUrl: 'http://127.0.0.1:1',
      workspacesRoot: '/nonexistent',
      managed: testPolicy(),
      waitMs: 60_000,
      heartbeatMs: 3_600_000,
      log: (_level, msg) => logs.push(msg),
    });
    runner.start();
    try {
      const first = await until(() => api.claims[0]);
      expect(first.providers.sort()).toEqual(['codex', 'local']);

      // Switched on for Claude Code: its CLI isn't installed here, which a gateway turn doesn't need.
      api.gateway = { claude: true, codex: false };
      await runner.beat();
      const second = await until(() => api.claims[1]);
      expect(first.answered).toBe(true);
      expect(second.providers.sort()).toEqual(['claude', 'codex', 'local']);
      expect(logs.join('\n')).toContain('switched on: claude');

      // The same switches: the claim waits on.
      await runner.beat();
      await new Promise((r) => setTimeout(r, 50));
      expect(api.claims).toHaveLength(2);

      // Off again (here: a server that stopped sending them).
      api.gateway = undefined;
      await runner.beat();
      const third = await until(() => api.claims[2]);
      expect(second.answered).toBe(true);
      expect(third.providers.sort()).toEqual(['codex', 'local']);
    } finally {
      await runner.stop(1_000);
    }
  });
});
