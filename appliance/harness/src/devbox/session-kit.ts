/**
 * What every DEV box task does as its person (`session.devbox.ts`, `ra-check.ts`): sign in to DEV control, tickets for
 * the relay, and the app session through the real client with the enrolled endpoint key.
 */
import { deserializeIdentity } from '@whombat/secure-channel';
import {
  type ApplianceSession,
  openSession,
  type SessionInfo,
  type Ticket,
  whenOpen,
} from '../scenario-kit/app-client.ts';
import { devControl, shipContext } from '../ship/context.ts';
import { type CloudSession, publicApi, signIn } from './control.ts';
import { type DevboxState, saveState } from './state.ts';

export interface Step {
  name: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
}

export const control = devControl(shipContext());

export function need<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`the DEV box state has no ${what} (dev/devbox create)`);
  return v;
}

/** A fresh cloud session of the person (magic link redeemed through the API, IN-101), kept in the state file. */
export async function session(st: DevboxState): Promise<CloudSession> {
  const s = await signIn(control, st.owner.email);
  st.session = { token: s.token, expiresAt: s.expiresAt };
  st.owner.accountId = s.account.id;
  saveState(st);
  return s;
}

/** Control-issued relay tickets for the box, per connection; `first` is used for the first interactive one. */
export function tickets(st: DevboxState, token: string, channel: 'app' | 'enroll', first?: Ticket) {
  let pending = first ?? null;
  return async (r: { channel: 'app' | 'enroll'; class: 'interactive' | 'bulk' }): Promise<Ticket> => {
    if (pending && r.class === 'interactive') {
      const t = pending;
      pending = null;
      return t;
    }
    const t = await publicApi<{ ticket: string; relay: { url: string } }>(
      control,
      'POST',
      `/v1/orgs/${st.owner.org}/tickets`,
      { token, body: { device: need(st.device, 'device'), channel, class: r.class } },
    );
    return { ticket: t.ticket, relayUrl: t.relay.url };
  };
}

/** Signs in and opens the person's app session (the enrolled endpoint), open when it resolves. */
export async function personSession(st: DevboxState): Promise<{ s: ApplianceSession; info: SessionInfo }> {
  const identity = deserializeIdentity(
    new Uint8Array(Buffer.from(need(st.endpointKey, 'endpoint key'), 'base64')),
  );
  await session(st);
  const s = openSession({
    tickets: tickets(st, need(st.session, 'session').token, 'app'),
    identity,
    appliance: { peerId: need(st.peerId, 'peerId') },
    channel: 'app',
  });
  try {
    return { s, info: await whenOpen(s, 60_000) };
  } catch (err) {
    s.close('closed');
    throw err;
  }
}
