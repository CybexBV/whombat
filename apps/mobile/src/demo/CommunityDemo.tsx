/**
 * The community demo (`whombat://demo/community` in a demo build; hermes-engine-app.md AP-5478): the phone's real
 * community journey (`CommunityApp`: Add this phone with a link, then the box on its direct ways only) against Mara's
 * box as a community edition in memory (`fixtures/community.ts`) over the demo world's burrow. The phone's key is its
 * own; the registry lives in memory, so every launch starts at Add this phone with a link. Paste the fixtures' device
 * link to come in as Mara.
 */
import type { ControlApi } from '@whombat/client/managed';
import { createRegistry, readLocalLink } from '@whombat/client/managed';
import { DEVICE_LINK } from '@whombat/fixtures';
import { useEffect, useMemo, useState } from 'react';
import { Linking } from 'react-native';
import { FIXTURE_ORIGIN } from '../data/config';
import type { CommunityBox } from '../fixtures/community';
import { createClock } from '../lib/time';
import type { CommunityRoute } from '../managed/CommunityApp';
import { CommunityApp } from '../managed/CommunityApp';
import { createLinkBus, createPushTaps } from '../managed/context';
import { type EndpointKey, loadEndpointKey, type ManagedEnvironment } from '../managed/env';
import { Screen } from '../ui/headers';
import { Loading } from '../ui/primitives';
import { StartHold } from '../ui/StartHold';
import { demoCommunityStart } from './communityLink';

/** A community box has no control: anything that asks it fails loudly in the demo. */
const NO_CONTROL = new Proxy(
  {},
  { get: () => () => Promise.reject(new Error('A community Whombat has no control.')) },
) as ControlApi;

/** The registry's storage, in memory (a fresh start every launch). */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

export function CommunityDemo() {
  const [ready, setReady] = useState<{ box: CommunityBox; key: EndpointKey; start: CommunityRoute } | null>(
    null,
  );
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [
        { createFixtureFetch },
        { at: atTime, vaultSshDeployKey },
        { createFixtureServer },
        { createCommunityBox },
      ] = await Promise.all([
        import('@whombat/fixtures/fetch'),
        import('@whombat/fixtures'),
        import('../fixtures/fixture-server'),
        import('../fixtures/community'),
      ]);
      const clock = createClock(new Date(atTime('14:05')));
      const server = createFixtureServer({
        inner: createFixtureFetch({ vaultEntries: [vaultSshDeployKey] }),
        now: clock,
      });
      const box = createCommunityBox({ rest: server.fetch as never, origin: FIXTURE_ORIGIN });
      const key = await loadEndpointKey();
      const at = demoCommunityStart(await Linking.getInitialURL());
      const link = at === 'device' ? readLocalLink(DEVICE_LINK.link) : null;
      if (alive) setReady({ box, key, start: link ? { name: 'link', link } : { name: 'join' } });
    })();
    return () => {
      alive = false;
    };
  }, []);
  const registry = useMemo(() => createRegistry('community-demo', memoryStorage()), []);
  const taps = useMemo(() => createPushTaps(), []);
  const links = useMemo(() => createLinkBus(), []);
  const env = useMemo<ManagedEnvironment | null>(
    () =>
      ready
        ? { control: NO_CONTROL, connector: (t) => ready.box.connectorFor(t.key.peerId, t.channel) }
        : null,
    [ready],
  );
  if (!ready || !env)
    return (
      <StartHold>
        <Screen>
          <Loading />
        </Screen>
      </StartHold>
    );
  return (
    <CommunityApp
      env={env}
      keyPair={ready.key}
      registry={registry}
      start={ready.start}
      onLeave={() => {}}
      rekey={async () => {}}
      taps={taps}
      links={links}
      addSignOutTask={() => () => {}}
    />
  );
}
