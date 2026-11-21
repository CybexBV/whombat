/**
 * Tailscale on a box without a box (fixture mode, the fake managed world, tests; hermes-engine-app.md AP-5305): the
 * `host.tailscale*` ops as the runtime answers them (CT-1254) over the fixtures' states — off until the person turns it
 * on, a login link to sign in with, then on as the fixture box's name. `signedIn()` stands for the person finishing
 * Tailscale's own page. A login server of the person's own (CT-1306; AP-5404) gives the login link on that server and the
 * Headscale fixture's name once signed in; changing it signs the box out first, as the manager does.
 */

import { TAILSCALE_HEADSCALE, TAILSCALE_STATES_FIXTURE } from '@whombat/fixtures';
import {
  type HostTailscaleChangeOutput,
  HostTailscaleOnInput,
  type HostTailscaleOutput,
  TAILSCALE_OFF,
  type TailscaleStatus,
} from '@whombat/protocol/session';

export interface FakeTailscale {
  /** One op as the runtime answers it, in HTTP terms; null for an op that isn't Tailscale's. */
  call(op: string, input: unknown): { status: number; body: unknown } | null;
  /** The person finished Tailscale's sign-in page: it is on. */
  signedIn(): void;
  status(): TailscaleStatus;
  onChange(listener: () => void): () => void;
}

export function createFakeTailscale(initial: TailscaleStatus['state'] = 'off'): FakeTailscale {
  let status: TailscaleStatus = { ...TAILSCALE_STATES_FIXTURE[initial] };
  /** The box's login server (null: Tailscale's own), kept across off and on as the manager keeps it. */
  let server: string | null = null;
  const withServer = (s: TailscaleStatus): TailscaleStatus => {
    const { loginServer: _, ...rest } = s;
    return server ? { ...rest, loginServer: server } : rest;
  };
  const signInState = (): TailscaleStatus =>
    server
      ? withServer({
          ...TAILSCALE_HEADSCALE.needs_sign_in,
          loginUrl: `${server}/register/nodekey:7c1e2f9a40b3d5`,
        })
      : { ...TAILSCALE_STATES_FIXTURE.needs_sign_in };
  const listeners = new Set<() => void>();
  const set = (next: TailscaleStatus) => {
    status = next;
    for (const l of [...listeners]) l();
  };
  const changed = (): { status: number; body: HostTailscaleChangeOutput } => ({
    status: 200,
    body: { tailscale: status },
  });
  return {
    call(op, input) {
      switch (op) {
        case 'host.tailscale': {
          const body: HostTailscaleOutput = { tailscale: status };
          return { status: 200, body };
        }
        case 'host.tailscale.on': {
          const parsed = HostTailscaleOnInput.safeParse(input ?? {});
          if (!parsed.success)
            return {
              status: 422,
              body: { error: { code: 'validation_failed', message: 'That login server isn’t valid.' } },
            };
          const wanted = parsed.data.loginServer;
          // Another login server: out of the tailnet first, then a fresh sign-in there (CT-1306).
          if (wanted !== undefined && wanted !== server) {
            server = wanted;
            set(signInState());
          } else if (status.state === 'off' || status.state === 'error') set(signInState());
          return changed();
        }
        case 'host.tailscale.signIn':
          set(signInState());
          return changed();
        case 'host.tailscale.off':
          void input;
          set(withServer({ ...TAILSCALE_OFF }));
          return changed();
        default:
          return null;
      }
    },
    signedIn() {
      if (status.state === 'needs_sign_in' || status.state === 'needs_approval')
        set(server ? withServer({ ...TAILSCALE_HEADSCALE.on }) : { ...TAILSCALE_STATES_FIXTURE.on });
    },
    status: () => status,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
