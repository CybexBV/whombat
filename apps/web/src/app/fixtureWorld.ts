/**
 * The mock world (hermes-engine-app.md AP-5303) as fixture mode uses it: a session on an in-memory box serving it, the
 * settled cards' live seed and the canvases' local hub. Fixture mode (`VITE_FIXTURES=1`, Storybook, tests, the visual
 * suite) reaches it through `fixtureMode.ts`, which a production build replaces with null (vite.config `noFixtureMode`,
 * docs/decisions/web-efficiency.md WE-02). The hosted app's “Look around without a Whombat” imports this module itself,
 * on demand (docs/app/decisions/look-around.md): its own chunks, never loaded with the page. Import fixture code through
 * `fixtureMode.ts` or the demo, never directly from code a production build ships.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { HostMetricsLoader } from '@whombat/client';
import { createFakeBackupPlaces } from '@whombat/client/backup-places/fake';
import type { DeskApi } from '@whombat/client/desk';
import type { FakeDesk } from '@whombat/client/desk/fake';
import {
  createFakeBackupLook,
  createFakeSession,
  type FakeHandler,
  restHandler,
  restResources,
} from '@whombat/client/fake';
import type { ApplianceSession } from '@whombat/client/session';
import { type FakeVoice, withFakeVoice } from '@whombat/client/voice/fake';
import { createFixtureSession } from '../features/canvas/collab/fixture';
import type { CanvasCollabFactory } from '../features/canvas/collab/types';
import { createFakeBackupOptions } from './backupOptionsFixtures';
import { deskFixture } from './deskFixtures';
import {
  createWebFixtureFetch,
  FIXTURE_BASE_URL,
  hostSeeded,
  powerSeeded,
  settleSeeded,
  type WebFixtureOptions,
} from './fixtureFetch';
import { hostMetricsFixture, hostPowerFixture } from './hostFixtures';
import { type MachineFixture, machineFixture } from './machineFixtures';
import { seedSettleLive } from './settleFixtures';
import { voiceFixture } from './voiceFixtures';

export interface FixtureMode {
  /**
   * A session on the in-memory box serving the mock world (signed in as Mara, an owner), with `voice` as its speech
   * service when there is one.
   */
  session(options: WebFixtureOptions, voice?: FakeVoice | null): ApplianceSession;
  /** The mock world as a REST handler (the fake managed world and tests read it too). */
  createFetch(options: WebFixtureOptions): typeof fetch;
  /** The settled cards' world is on (AP-734). */
  settleSeeded(options: WebFixtureOptions): boolean;
  /** Its thinking agents, put in the cache (fixture mode has no socket; AP-735). */
  seedSettleLive(queryClient: QueryClient): void;
  /** Canvases open on a local hub (no `/collab`). */
  canvasSession: CanvasCollabFactory;
  /** The box's `host.metrics` (option `host`, AP-1147); null: no box, as on a self-hosted server. */
  hostMetrics(options: WebFixtureOptions): HostMetricsLoader | null;
  /** The box's own screen (option `desk`, desk-display-web.md AP-3012) and Mara's ops on it; null: none. */
  desk(options: WebFixtureOptions): { desk: FakeDesk; api: DeskApi } | null;
  /** The machine's network and hardware report (option `machine`, hardware-support-web.md AP-3221); null: none. */
  machine(options: WebFixtureOptions): MachineFixture | null;
  /** The box's speech service for voice typing (option `voice`, docs/decisions/dictation.md); null: none. */
  voice(options: WebFixtureOptions): FakeVoice | null;
  /** The screen page playing a device on the fake box (`/use-as-screen`, desk-display-web.md). */
  screenMode(): Promise<typeof import('../features/screens/screenMode/FixtureScreenMode')>;
}

/**
 * The mock world on the session fake: its operations, its downloads, Mara as the box's account, and voice typing's ops
 * and recordings answered by `voice` where there is one.
 */
function fixtureSession(options: WebFixtureOptions, voice: FakeVoice | null = null): ApplianceSession {
  const fetch = createWebFixtureFetch(options) as (url: string, init: RequestInit) => Promise<Response>;
  const rest = restHandler(fetch, { origin: FIXTURE_BASE_URL });
  // Backup places (backup-places.md AP-6716): blackbox keeps the backups; setting one up takes a moment, moving longer.
  const places = createFakeBackupPlaces({ setupMs: 1500, moveMs: 4000 });
  // Backup options and the list of backups (backup-options.md AP-6800): blackbox's, like the mocks.
  const backups = createFakeBackupOptions({ available: options.backupOptions !== false });
  if (options.backupFake) backups.set(options.backupFake);
  // Getting one thing back from a backup (backup-look.md AP-6940).
  const look = createFakeBackupLook({ available: options.backupOptions !== false });
  const handle: FakeHandler = (op, input, context) =>
    places.call(op, input) ?? backups.call(op, input) ?? look.call(op, input) ?? rest(op, input, context);
  return createFakeSession({
    ...(voice ? withFakeVoice({ handle }, voice) : { handle }),
    resources: restResources(fetch, FIXTURE_BASE_URL),
    account: { id: 'acc_mara', name: 'Mara Okafor' },
  }).session;
}

export const fixtureWorld: FixtureMode = {
  session: fixtureSession,
  createFetch: createWebFixtureFetch,
  settleSeeded,
  seedSettleLive: (queryClient) => seedSettleLive(queryClient),
  canvasSession: createFixtureSession,
  hostMetrics: (options) => {
    if (!hostSeeded(options)) return null;
    const power = powerSeeded(options);
    return async (input) => {
      const now = Date.now();
      return hostMetricsFixture(input, now, power && hostPowerFixture(power, now));
    };
  },
  desk: (options) => deskFixture(options.desk),
  machine: (options) => machineFixture(options.machine),
  voice: (options) => voiceFixture(options.voice),
  screenMode: () => import('../features/screens/screenMode/FixtureScreenMode'),
};
