import type { KnownAppliance } from '@whombat/client/managed';
import { type ApplianceSession, createSecureSession } from '@whombat/client/session';
import type { DirectAddresses } from '@whombat/protocol/session';
import { createOpenTiming, type OpenTiming } from '../app/openTiming';
import { type ConnectTarget, type ManagedEnvironment, WEB_CLIENT } from './connect';

export interface Opening {
  session: ApplianceSession;
  timing: OpenTiming;
}

export function createOpening(input: {
  env: Pick<ManagedEnvironment, 'connector'>;
  orgId: string;
  appliance: KnownAppliance;
  keyPair: ConnectTarget['key'];
  direct: () => DirectAddresses | null | undefined;
}): Opening {
  const timing = createOpenTiming();
  const session = createSecureSession({
    connector: input.env.connector({
      orgId: input.orgId,
      device: input.appliance.device,
      peerId: input.appliance.peerId,
      channel: 'app',
      key: input.keyPair,
      direct: input.direct,
    }),
    client: WEB_CLIENT,
  });
  const off = session.onState((state) => {
    if (state.status === 'open') timing.mark('welcome');
    if (state.status === 'open' || state.status === 'closed') off();
  });
  return { session, timing };
}

/** One pinned, enrolled target at a time. Until selected, it sends only the normal session handshake. */
export function prepareOpening(open: (appliance: KnownAppliance) => Opening, maxAgeMs = 10_000) {
  let held: { appliance: KnownAppliance; opening: Opening; timer: ReturnType<typeof setTimeout> } | null =
    null;
  const matches = (a: KnownAppliance) =>
    held?.appliance.device === a.device && held.appliance.peerId === a.peerId;
  const clear = () => {
    if (!held) return;
    const old = held;
    held = null;
    clearTimeout(old.timer);
    old.opening.session.close();
  };
  const prepare = (a: KnownAppliance) => {
    if (!a.enrolled) {
      clear();
      return;
    }
    if (matches(a) && held?.opening.session.state().status !== 'closed') return;
    clear();
    const opening = open(a);
    held = { appliance: a, opening, timer: setTimeout(clear, maxAgeMs) };
    opening.session.connect();
  };
  return {
    prepare,
    select(a: KnownAppliance) {
      prepare(a);
      held?.opening.timing.mark('selected');
    },
    take(a: KnownAppliance): Opening | undefined {
      if (!a.enrolled || !matches(a) || held?.opening.session.state().status === 'closed') {
        clear();
        return;
      }
      const ready = held;
      held = null;
      if (!ready) return;
      clearTimeout(ready.timer);
      return ready.opening;
    },
    clear,
  };
}
