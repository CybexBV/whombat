/**
 * Fake providers in server tests run the way the scripted Hermes does (hermes-engine.md HE-46, HE-S174): the runner
 * needs no installed client and no sign-in for them, and a server that allows it (`SCRIPTED_ENV`, as `pnpm dev` sets it)
 * sends their turns no sign-in once the runner's heartbeat named its Hermes the scripted one.
 */
import { SCRIPTED_HERMES_SUFFIX } from '@whombat/agent-runtime';
import type { ProviderRegistry } from '@whombat/runner';

/** The server's side: turns on the scripted Hermes run without a sign-in. */
export const SCRIPTED_ENV: Readonly<Record<string, string>> = { WHOMBAT_ALLOW_SCRIPTED: '1' };

/** `registry` as the scripted Hermes': its claimed CLIs ready, Hermes the scripted stand-in. */
export function scripted(registry: ProviderRegistry): ProviderRegistry {
  return {
    ...registry,
    hermesScripted: () => true,
    status: () => ({
      hermes: { ready: true, version: `0.0.0${SCRIPTED_HERMES_SUFFIX}`, problem: null, detail: null },
      providers: registry
        .claims()
        .filter((p): p is 'claude' | 'codex' => p === 'claude' || p === 'codex')
        .map((provider) => ({ provider, state: 'ready' as const, version: 'test', detail: null })),
      checkedAt: new Date().toISOString(),
    }),
  };
}
