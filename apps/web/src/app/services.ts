/**
 * The app's data services: client, realtime and query cache over one appliance session (AP-10): every call, event,
 * resource and upload goes through it. A box's session comes from `ManagedRoot` (through the relay or straight to the
 * box); `VITE_FIXTURES=1` (and Storybook, tests) opens one on an in-memory box serving the mock world from
 * `@whombat/fixtures` (hermes-engine-app.md AP-5303), with no realtime.
 */
import { QueryClient } from '@tanstack/react-query';
import {
  type BluetoothApi,
  bluetoothApi,
  createClient,
  type HardwareLoader,
  type HostMetricsLoader,
  hardwareLoader,
  hostMetricsLoader,
  type NetworkApi,
  networkApi,
  type Realtime,
  type WhombatClient,
} from '@whombat/client';
import { type DeskApi, deskApi } from '@whombat/client/desk';
import { DESK_QUERY_KEY, DESK_SCREENS_CHANGED } from '@whombat/client/desk/react';
import type { ControlApi, ManagedWhombats, PasskeyPlatform } from '@whombat/client/managed';
import { createQueries, type WhombatQueries } from '@whombat/client/query';
import {
  type ApplianceSession,
  type CommandTracker,
  createCommandTracker,
  createSessionRealtime,
} from '@whombat/client/session';
import { type VoiceApi, voiceApi } from '@whombat/client/voice';
import { VOICE_QUERY_KEY } from '@whombat/client/voice/react';
import { createObjectUrlCache, type ObjectUrlCache } from '@whombat/client/web';
import type { Edition } from '@whombat/protocol/session';
import type { ManagedWebPush } from '../managed/webPush';
import type { WebFixtureOptions } from './fixtureFetch';
import { type FixtureMode, fixtureMode } from './fixtureMode';
import type { OpenTiming } from './openTiming';
import { type BurrowMemory, createBurrowMemory } from './routing/currentBurrow';

export interface AppServices {
  /** The current opening's local measurements; absent for fixtures and isolated screens. */
  openTiming?: OpenTiming;
  client: WhombatClient;
  /** Null in fixture mode (the mock world sends no events). */
  realtime: Realtime | null;
  queryClient: QueryClient;
  queries: WhombatQueries;
  fixtures: boolean;
  /** The mock world fixture mode runs on (its canvases' local hub); null on a box's session. */
  fixtureWorld: FixtureMode | null;
  /**
   * The hosted app's demo (docs/app/decisions/look-around.md): every screen says so in the shell's notice slot, and
   * Leave goes back to the sign-in page. Null everywhere else.
   */
  demo: { leave: () => void } | null;
  /** The session the client talks through. */
  session: ApplianceSession;
  /** Decrypted resources as object URLs (attachments, pictures on thing pages). */
  resources: ObjectUrlCache;
  /**
   * Pictures on thing pages (contracts 0.121, CT-1000; service-dashboards.md AP-4562): the `thing-image` stream,
   * shown from `blob:` object URLs (the same cache as `resources`).
   */
  thingImages: ObjectUrlCache;
  /** Durable command states of the mutations started here (AP-14). */
  commands: CommandTracker;
  /** A box's session's extras (status panels, devices); null in fixture mode. */
  managed: ManagedContext | null;
  /** The burrow the burrow-less paths open, remembered per tab and browser (AP-361). */
  burrowMemory: BurrowMemory;
  /**
   * How the box is doing (`host.metrics`, box-status.md AP-1137): the session op, or fixture mode's box
   * (`VITE_FIXTURE_HOST=1`; null without it).
   */
  hostMetrics: HostMetricsLoader | null;
  /**
   * The box's own screen as a desk display (`desk.*`, desk-display-web.md AP-3001): the session's ops, or fixture
   * mode's screen (`VITE_FIXTURE_DESK`; null without it).
   */
  desk: DeskApi | null;
  /**
   * The machine itself (`host.network`, `host.wifi.*`, `host.hardware`; hardware-support-web.md AP-3222): the session's
   * ops, or fixture mode's machine (`VITE_FIXTURE_MACHINE`; null without it).
   */
  network: NetworkApi | null;
  hardware: HardwareLoader | null;
  /** The box's Bluetooth (`host.bluetooth*`; bluetooth-web.md AP-3711), as `network`. */
  bluetooth: BluetoothApi | null;
  /**
   * Voice typing (`voice.*` and the `dictation` upload; docs/decisions/dictation.md): the session's, in fixture mode too
   * (its box answers with the fake speech service of `VITE_FIXTURE_VOICE`, or as a box without one).
   */
  voice: VoiceApi;
}

/** What managed screens need beyond the burrow app (set by `ManagedRoot`). */
export interface ManagedContext {
  applianceId: string;
  applianceName: string | null;
  /** This browser's key fingerprint. */
  deviceFingerprint: string;
  appliancePeerId: string;
  applianceFingerprint: string;
  /** Always false since BX-01 (no kit at the claim); kept for the shape. */
  kitPending: boolean;
  /**
   * Open the recovery kit journey (“Make a kit”, a Whombat from before the passkey); absent where there is none (the box's
   * own page): its buttons are hidden.
   */
  onKit?(): void;
  /**
   * Open bringing a Whombat back (Whombat backup-options.md BKO-28, BKO-29, BKO-34): where a restore stands (finish it, try
   * again), or `later` on a Whombat that started fresh. Absent where the app can't (the box's own page).
   */
  onBringBack?(later: boolean): void;
  /** Sign out of the cloud account (clears every local cache). */
  signOut(): void;
  /** Back to the appliance list. */
  switchAppliance(): void;
  /** The burrow name's menu (whombat-switcher.md AP-3080): the organization's Whombats, and opening another one. */
  whombats?: ManagedWhombats;
  /** Browser notifications through control (MA-18). */
  push?: ManagedWebPush;
  /** Control (the cloud account's session) and this appliance's organization: organization invitations (G-01). */
  control?: ControlApi;
  orgId?: string;
  /** The organization's name: a new burrow starts with it (AP-75). */
  orgName?: string | null;
  /** This browser's passkeys (PK-06, passkeys.md AP-793); null where it has no WebAuthn. */
  passkeys?: PasskeyPlatform | null;
  /** This browser's key (its PeerId): the nudge is remembered per key and Whombat (AP-794). */
  devicePeerId?: string;
  /**
   * The box's own page (HE-50; hermes-engine-app.md AP-5325): no control behind it, so no passkeys (they belong to the
   * hosted app's name) and no notifications; `secure` is false on the plain-HTTP local-network page. Absent: the hosted
   * app.
   */
  page?: {
    kind: 'box';
    secure: boolean;
    /** The page is the box's own address (its setup made the passkey there); absent: not known. */
    atAddress?: boolean;
  };
  /**
   * The box's edition as its page learnt it before connecting (CT-1300); absent on the hosted app, where the session's
   * `welcome.edition` says it (`useEdition`; AP-5429).
   */
  edition?: Edition;
}

export interface CreateServicesOptions {
  /** Serve fixtures (a session on the in-memory box) when no `session` is given. Defaults to `VITE_FIXTURES=1`. */
  fixtures?: boolean | WebFixtureOptions;
  /**
   * The mock world to serve them from: fixture mode's own by default; the hosted app's demo hands in the one it loaded
   * on demand (a production build has no fixture mode, WE-02).
   */
  world?: FixtureMode;
  /** The hosted app's demo: its way back to the sign-in page (docs/app/decisions/look-around.md). */
  demo?: { leave: () => void };
  /** Replace the realtime (`null` = none). */
  realtime?: Realtime | null;
  queryClient?: QueryClient;
  /** Talk through this appliance session (AP-10). */
  session?: ApplianceSession;
  managed?: ManagedContext;
  /** Where the open burrow is remembered (tests); the browser's storage by default. */
  burrowMemory?: BurrowMemory;
}

export function fixturesFromEnv(): boolean {
  return import.meta.env.VITE_FIXTURES === '1' || import.meta.env.VITE_FIXTURES === 'true';
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
  });
}

export function createAppServices(options: CreateServicesOptions = {}): AppServices {
  const fixtureOption = options.fixtures ?? fixturesFromEnv();
  const fixtureOptions = typeof fixtureOption === 'object' ? fixtureOption : {};
  // A production build has no fixture mode (WE-02): it always talks to its Whombat.
  const fixtures = !options.session && fixtureOption !== false ? (options.world ?? fixtureMode) : null;
  if (!options.session && !fixtures)
    throw new Error(
      'No session: a box’s session, or fixture mode (VITE_FIXTURES, for development, tests and Storybook).',
    );
  const queryClient = options.queryClient ?? createQueryClient();
  // Fixture mode sends no events: the settled cards' world puts its thinking agents in the cache (AP-734, AP-735).
  if (fixtures?.settleSeeded(fixtureOptions)) fixtures.seedSettleLive(queryClient);

  // Fixture mode's speech service answers on its session; its changes refetch `voice.get` as `voice.changed` does.
  const voiceHere = fixtures ? fixtures.voice(fixtureOptions) : null;
  voiceHere?.onChange(() => void queryClient.invalidateQueries({ queryKey: VOICE_QUERY_KEY }));
  const client = createClient({
    session: options.session ?? (fixtures as NonNullable<typeof fixtures>).session(fixtureOptions, voiceHere),
    validateResponses: import.meta.env.DEV,
  });
  const session = client.session;
  const realtime =
    options.realtime !== undefined ? options.realtime : fixtures ? null : createSessionRealtime(session);
  const resources = createObjectUrlCache(() => session);
  // Fixture mode sends no events: its screen’s changes refetch `desk.get` as `desk.changed` does (AP-3012).
  const deskHere = fixtures ? fixtures.desk(fixtureOptions) : null;
  const machine = fixtures ? fixtures.machine(fixtureOptions) : null;
  deskHere?.desk.onChange(() => {
    void queryClient.invalidateQueries({ queryKey: DESK_QUERY_KEY });
    // Settings → Screens (3.6) as `desk.changed` refetches it.
    for (const queryKey of DESK_SCREENS_CHANGED) void queryClient.invalidateQueries({ queryKey });
  });
  return {
    client,
    realtime,
    queryClient,
    queries: createQueries(client),
    fixtures: fixtures !== null,
    fixtureWorld: fixtures,
    demo: options.demo ?? null,
    session,
    resources,
    thingImages: resources,
    commands: createCommandTracker(() => session),
    managed: options.managed ?? null,
    burrowMemory: options.burrowMemory ?? createBurrowMemory(options.managed?.applianceId),
    hostMetrics: fixtures ? fixtures.hostMetrics(fixtureOptions) : hostMetricsLoader(session),
    desk: fixtures ? (deskHere?.api ?? null) : deskApi(session),
    network: fixtures ? (machine?.network ?? null) : networkApi(session),
    hardware: fixtures ? (machine?.hardware ?? null) : hardwareLoader(session),
    bluetooth: fixtures ? (machine?.bluetooth ?? null) : bluetoothApi(session),
    voice: voiceApi(session),
  };
}
