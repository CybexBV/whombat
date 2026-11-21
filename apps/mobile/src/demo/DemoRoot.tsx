/**
 * The demo world (`EXPO_PUBLIC_WHOMBAT_MODE=fixtures`, hermes-engine-app.md AP-5370): Burrow HQ on an in-memory box, no
 * Whombat and no network. The phone's fixture server answers the box's operations (`createFakeSession` over its REST
 * world, so every call crosses the session protocol as a box's would); its realtime stand-in plays the agent's
 * replies. A demo build is only ever the demo: there is nothing to sign out of.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Realtime, WhombatClient } from '@whombat/client';
import { WhombatClientProvider } from '@whombat/client/react';
import { type ReactNode, useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { BurrowProvider } from '../data/BurrowProvider';
import { FIXTURE_BURROW } from '../data/config';
import { DrawnPictures, type DrawPicture } from '../data/thingPictures';
import { createClock } from '../lib/time';
import { VersionGate } from '../managed/VersionGate';
import { RootNavigator } from '../navigation/RootNavigator';
import { AccountThemeProvider } from '../settings/accountTheme';
import { Screen } from '../ui/headers';
import { Button, ErrorState, Loading } from '../ui/primitives';
import { StartHold } from '../ui/StartHold';
import { CommunityDemo } from './CommunityDemo';
import { demoCommunity } from './communityLink';
import { demoClient } from './session';
import { demoVersionGate } from './versionLink';

/** `whombat://demo/community` opened the demo (AP-5478): the community journey instead of the demo world. */
function useDemoCommunity(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    void Linking.getInitialURL().then((url) => setOn(demoCommunity(url)));
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (demoCommunity(url)) setOn(true);
    });
    return () => sub.remove();
  }, []);
  return on;
}

function useDemoVersionGate(): ['client' | 'appliance' | null, () => void] {
  const [who, setWho] = useState<'client' | 'appliance' | null>(null);
  useEffect(() => {
    void Linking.getInitialURL().then((url) => setWho(demoVersionGate(url)));
    const sub = Linking.addEventListener('url', ({ url }) => {
      const next = demoVersionGate(url);
      if (next) setWho(next);
    });
    return () => sub.remove();
  }, []);
  return [who, () => setWho(null)];
}

interface Demo {
  client: WhombatClient;
  realtime: Realtime;
  clock: () => Date;
  /** The demo world's pictures on service pages, drawn on the phone (service-dashboards.md AP-4651). */
  pictures: DrawPicture;
}

function StateScreen({ error, retry }: { error: Error | null; retry: () => void }) {
  // A placeholder of the start: the launch screen stays while it shows (one-layout-android.md AP-2643).
  if (!error)
    return (
      <StartHold>
        <Screen>
          <Loading />
        </Screen>
      </StartHold>
    );
  return (
    <Screen>
      <ErrorState text="Your Whombat didn’t load." onRetry={retry} />
    </Screen>
  );
}

async function openDemo(): Promise<Demo> {
  // Loaded on demand: the fixture world (and its signed audit chain) is only built in the demo.
  const [
    { createFixtureFetch },
    { at, fixturePictureDataUrl, vaultSignInEntries, vaultSshDeployKey },
    { createFixtureServer },
  ] = await Promise.all([
    import('@whombat/fixtures/fetch'),
    import('@whombat/fixtures'),
    import('../fixtures/fixture-server'),
  ]);
  // The demo world is the one-Whombat world (AP-1377, one-layout-android.md AP-2646): mock 4's moment, 14:05.
  const clock = createClock(new Date(at('14:05')));
  // The demo Vault also holds the shared fixtures' SSH key (“Deploy key”, two servers; AP-605), with the sign-in
  // cards' world prod-1 too, whose password is kept (AP-6680).
  const signIns = process.env.EXPO_PUBLIC_WHOMBAT_SIGNIN === '1';
  const deployKey =
    (signIns && vaultSignInEntries.find((e) => e.id === vaultSshDeployKey.id)) || vaultSshDeployKey;
  const server = createFixtureServer({
    inner: createFixtureFetch({ vaultEntries: [deployKey] }),
    now: clock,
  });
  return {
    client: demoClient(server.fetch),
    realtime: server.realtime,
    clock,
    pictures: fixturePictureDataUrl,
  };
}

export function DemoRoot() {
  // One cache for the demo's lifetime.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true } },
      }),
  );
  const [demo, setDemo] = useState<Demo | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [versionGate, closeVersionGate] = useDemoVersionGate();
  const community = useDemoCommunity();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry (a new attempt) opens the demo again.
  useEffect(() => {
    let alive = true;
    setError(null);
    openDemo().then(
      (d) => alive && setDemo(d),
      (e: unknown) => alive && setError(e instanceof Error ? e : new Error(String(e))),
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  let body: ReactNode;
  if (community) return <CommunityDemo />;
  if (versionGate)
    return (
      <VersionGate
        who={versionGate}
        back={<Button label="Back" variant="secondary" size="lg" onPress={closeVersionGate} />}
      />
    );
  if (!demo) body = <StateScreen error={error} retry={() => setAttempt((n) => n + 1)} />;
  else
    body = (
      <WhombatClientProvider client={demo.client} realtime={demo.realtime}>
        <DrawnPictures.Provider value={demo.pictures}>
          <BurrowProvider
            slug={FIXTURE_BURROW}
            mode="fixtures"
            clock={demo.clock}
            renderState={({ error: e, retry }) => <StateScreen error={e} retry={retry} />}
          >
            <AccountThemeProvider>
              <RootNavigator persistScope={null} />
            </AccountThemeProvider>
          </BurrowProvider>
        </DrawnPictures.Provider>
      </WhombatClientProvider>
    );
  return <QueryClientProvider client={queryClient}>{body}</QueryClientProvider>;
}
