/**
 * Tailscale in the demo world (hermes-engine-app.md AP-5378): the client's fake (`createFakeTailscale`) answering
 * `host.tailscale*` as a box does, starting off. Nothing leaves the phone, so Sign in doesn't open Tailscale's page:
 * you are taken as having signed in there, and the next look says it is on. Pure TypeScript.
 */
import type { TailscaleApi } from '@whombat/client';
import { createFakeTailscale, type FakeTailscale } from '@whombat/client/host/fake';
import { OperationError } from '@whombat/client/session';

export interface DemoTailscale {
  /** The ops. */
  api(): TailscaleApi;
  /** Stands for you finishing Tailscale's own sign-in page. */
  signedIn(): void;
  fake: FakeTailscale;
}

export function createDemoTailscale(): DemoTailscale {
  const fake = createFakeTailscale('off');
  const call = <T>(op: string, input: unknown): Promise<T> => {
    const r = fake.call(op, input);
    if (!r) return Promise.reject(new Error(`${op} isn’t Tailscale’s`));
    if (r.status >= 300) {
      const e = (r.body as { error?: { code?: string; message?: string } }).error;
      return Promise.reject(
        new OperationError(op, r.status, e?.code ?? 'failed', e?.message ?? 'Failed.', { code: e?.code }),
      );
    }
    return Promise.resolve(r.body as T);
  };
  return {
    api: () => ({
      state: () => call('host.tailscale', {}),
      on: () => call('host.tailscale.on', {}),
      off: (signOut) => call('host.tailscale.off', signOut ? { signOut: true } : {}),
      signIn: () => call('host.tailscale.signIn', {}),
    }),
    signedIn: () => fake.signedIn(),
    fake,
  };
}

let demo: DemoTailscale | null = null;

/** The demo world's one Tailscale, made on first use; it keeps its state while the app runs. */
export function demoTailscale(): DemoTailscale {
  demo ??= createDemoTailscale();
  return demo;
}
