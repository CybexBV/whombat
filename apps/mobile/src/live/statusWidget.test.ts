import { describe, expect, it } from 'vitest';
import {
  type ClearStatusWidgetFilter,
  createStatusWidgetQueue,
  type StatusWidgetPayload,
} from '../../modules/whombat-live/src/statusWidget';
import { COMMUNITY_ORG } from '../managed/community';
import {
  clearCloudStatusWidget,
  clearDepartingStatusWidget,
  createStatusWidgetSync,
  shouldClearStatusWidget,
  statusWidgetPayload,
  statusWidgetSourceFor,
  switchActiveAppliance,
} from './statusWidget';

const TZ = 'Europe/Amsterdam';
const AT = '2026-11-21T13:05:00.000Z'; // 14:05 CET

const overview = {
  summary: { needsYou: 1, working: 0, problems: 0 },
  needsYou: [],
  things: [],
  generatedAt: AT,
};

describe('home-screen status widget bridge model', () => {
  it('prefers the appliance name, falling back to the burrow name and then Whombat', () => {
    const payload = statusWidgetPayload({
      overview,
      applianceId: 'wb-1',
      applianceName: 'Home',
      burrowName: 'Main',
      timeZone: TZ,
      now: new Date(AT),
    });
    expect(payload).toMatchObject({
      applianceId: 'wb-1',
      boxName: 'Home',
      status: '1 thing needs you',
      tone: 'warn',
      timeZone: TZ,
      updatedAt: Date.parse(AT),
    });
    expect('asOf' in payload).toBe(false);
    expect('asOfEarlier' in payload).toBe(false);
    expect('asOfDay' in payload).toBe(false);

    expect(
      statusWidgetPayload({
        overview: { ...overview, summary: { needsYou: 0, working: 0, problems: 0 } },
        applianceId: 'wb-1',
        applianceName: '  ',
        burrowName: 'Studio',
        timeZone: TZ,
        now: new Date(AT),
      }),
    ).toMatchObject({ boxName: 'Studio', status: 'All good', tone: 'ok' });

    expect(
      statusWidgetPayload({
        overview: { ...overview, summary: { needsYou: 0, working: 0, problems: 0 } },
        applianceId: 'wb-1',
        applianceName: null,
        burrowName: null,
        timeZone: TZ,
        now: new Date(AT),
      }).boxName,
    ).toBe('Whombat');
  });

  it('deduplicates unchanged writes and writes again after clear or failure', async () => {
    const saved: StatusWidgetPayload[] = [];
    const cleared: (string | ClearStatusWidgetFilter | undefined)[] = [];
    let failNext = false;
    const sync = createStatusWidgetSync({
      async setStatusWidget(payload) {
        if (failNext) {
          failNext = false;
          throw new Error('storage busy');
        }
        saved.push(payload);
      },
      async clearStatusWidget(filter) {
        cleared.push(filter);
      },
    });
    const first = statusWidgetPayload({
      overview,
      applianceId: 'wb-1',
      applianceName: 'Home',
      burrowName: null,
      timeZone: TZ,
      now: new Date(AT),
    });

    expect(await sync.push(first)).toBe(true);
    expect(await sync.push(first)).toBe(false);
    expect(saved).toHaveLength(1);

    await sync.clear('wb-1');
    expect(cleared).toEqual(['wb-1']);
    expect(await sync.push(first)).toBe(true);
    expect(saved).toHaveLength(2);

    const updated = { ...first, status: 'All good', tone: 'ok' as const };
    failNext = true;
    expect(await sync.push(updated)).toBe(false);
    expect(await sync.push(updated)).toBe(true);
    expect(saved).toHaveLength(3);
  });

  it('clears a cloud widget on cloud sign-out/expiry even when community boxes are known, without wiping a community widget', async () => {
    expect(statusWidgetSourceFor('org_123')).toBe('cloud');
    expect(statusWidgetSourceFor(COMMUNITY_ORG)).toBe('community');

    const cloudSnap = statusWidgetPayload({
      overview,
      applianceId: 'wb-cloud',
      applianceName: 'Cloud Box',
      burrowName: null,
      source: statusWidgetSourceFor('org_123'),
      timeZone: TZ,
      now: new Date(AT),
    });
    const communitySnap = statusWidgetPayload({
      overview,
      applianceId: 'wb-comm',
      applianceName: 'Home Box',
      burrowName: null,
      source: statusWidgetSourceFor(COMMUNITY_ORG),
      timeZone: TZ,
      now: new Date(AT),
    });
    const legacySnap: StatusWidgetPayload = { ...cloudSnap };
    delete legacySnap.source;

    expect(cloudSnap.source).toBe('cloud');
    expect(communitySnap.source).toBe('community');

    // Simulate the native widget store holding a snapshot while community boxes exist on the phone.
    let stored: StatusWidgetPayload | null = cloudSnap;
    const nativeStore = {
      async clearStatusWidget(filter?: string | ClearStatusWidgetFilter) {
        if (shouldClearStatusWidget(stored, filter)) stored = null;
      },
    };

    // Cloud sign-out / expiry clears a cloud snapshot regardless of known community boxes.
    await clearCloudStatusWidget(nativeStore);
    expect(stored).toBeNull();

    // A pre-upgrade snapshot without `source` is also cleared on cloud sign-out/expiry.
    stored = legacySnap;
    await clearCloudStatusWidget(nativeStore);
    expect(stored).toBeNull();

    // A widget currently showing a community box is kept on cloud sign-out/expiry.
    stored = communitySnap;
    await clearCloudStatusWidget(nativeStore);
    expect(stored).toEqual(communitySnap);

    // Removing that specific community box still clears it by applianceId.
    await nativeStore.clearStatusWidget('wb-comm');
    expect(stored).toBeNull();
  });

  it('clears the departing box on switch so an offline next box never keeps the previous box status', async () => {
    const boxA = statusWidgetPayload({
      overview,
      applianceId: 'wb-a',
      applianceName: 'Home',
      burrowName: null,
      source: 'cloud',
      timeZone: TZ,
      now: new Date(AT),
    });
    const boxB = statusWidgetPayload({
      overview: { ...overview, summary: { needsYou: 0, working: 0, problems: 0 } },
      applianceId: 'wb-b',
      applianceName: 'Office',
      burrowName: null,
      source: 'cloud',
      timeZone: TZ,
      now: new Date(AT),
    });

    let stored: StatusWidgetPayload | null = boxA;
    let lastUsed: string | null = 'wb-a';
    const registry = {
      lastUsed: () => lastUsed,
      setLastUsed: (device: string | null) => {
        lastUsed = device;
      },
    };
    const nativeStore = {
      async setStatusWidget(payload: StatusWidgetPayload) {
        stored = payload;
      },
      async clearStatusWidget(filter?: string | ClearStatusWidgetFilter) {
        if (shouldClearStatusWidget(stored, filter)) stored = null;
      },
    };

    // Reopening the same box preserves its status while it reconnects.
    switchActiveAppliance(registry, nativeStore, 'wb-a');
    await Promise.resolve();
    expect(lastUsed).toBe('wb-a');
    expect(stored).toEqual(boxA);

    // Switching to another box (which may be offline and never push) clears the departing box.
    switchActiveAppliance(registry, nativeStore, 'wb-b');
    await Promise.resolve();
    expect(lastUsed).toBe('wb-b');
    expect(stored).toBeNull();

    // Explicit departure to the appliances list (no next box) clears the departing box only.
    stored = boxB;
    await clearDepartingStatusWidget(nativeStore, 'wb-a');
    expect(stored).toEqual(boxB);
    await clearDepartingStatusWidget(nativeStore, 'wb-b', 'wb-b');
    expect(stored).toEqual(boxB);
    await clearDepartingStatusWidget(nativeStore, 'wb-b');
    expect(stored).toBeNull();

    // Switching away from box B to an unpinned/changed box C clears box B's snapshot.
    stored = boxB;
    await clearDepartingStatusWidget(nativeStore, 'wb-b', 'wb-c');
    expect(stored).toBeNull();
  });

  it('serializes writes and clears so an in-flight push from a departing box cannot overwrite a clear', async () => {
    const boxA1 = statusWidgetPayload({
      overview,
      applianceId: 'wb-a',
      applianceName: 'Home',
      burrowName: null,
      timeZone: TZ,
      now: new Date(AT),
    });
    const boxA2 = { ...boxA1, status: 'All good', tone: 'ok' as const };
    const boxB = statusWidgetPayload({
      overview: { ...overview, summary: { needsYou: 0, working: 0, problems: 0 } },
      applianceId: 'wb-b',
      applianceName: 'Office',
      burrowName: null,
      timeZone: TZ,
      now: new Date(AT),
    });

    let stored: StatusWidgetPayload | null = null;
    const events: string[] = [];
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstWrite = true;

    const sync = createStatusWidgetSync({
      async setStatusWidget(payload) {
        if (firstWrite) {
          firstWrite = false;
          enteredFirst();
          await firstGate;
        }
        events.push(`set:${payload.applianceId}:${payload.status}`);
        stored = payload;
      },
      async clearStatusWidget(filter) {
        const id = typeof filter === 'string' ? filter : (filter?.applianceId ?? '*');
        events.push(`clear:${id}`);
        if (shouldClearStatusWidget(stored, filter)) stored = null;
      },
    });

    // Wait for box A's first write to enter native storage, then queue a second box A write and clear box A.
    const p1 = sync.push(boxA1);
    await firstEntered;
    const p2 = sync.push(boxA2);
    const pClear = sync.clear('wb-a');
    releaseFirst();

    expect(await p1).toBe(true);
    expect(await p2).toBe(false);
    await pClear;
    expect(stored).toBeNull();
    expect(events).toEqual(['set:wb-a:1 thing needs you', 'clear:wb-a']);

    // Once box B comes online later, its write lands cleanly.
    expect(await sync.push(boxB)).toBe(true);
    expect(stored).toEqual(boxB);
  });

  it('invalidates queued bridge writes when an external clear runs on the native queue (revocation/rekey, switch, sign-out)', async () => {
    const boxA1 = statusWidgetPayload({
      overview,
      applianceId: 'wb-a',
      applianceName: 'Home',
      burrowName: null,
      source: 'cloud',
      timeZone: TZ,
      now: new Date(AT),
    });
    const boxA2 = { ...boxA1, status: 'All good', tone: 'ok' as const };
    const boxB = statusWidgetPayload({
      overview,
      applianceId: 'wb-b',
      applianceName: 'Office',
      burrowName: null,
      source: 'community',
      timeZone: TZ,
      now: new Date(AT),
    });

    let stored: StatusWidgetPayload | null = null;
    const nativeEvents: string[] = [];
    let enteredFirst!: () => void;
    let firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    let releaseFirst!: () => void;
    let firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let holdNextWrite = true;

    const nativeStore = {
      async setStatusWidget(json: string) {
        const parsed = JSON.parse(json) as StatusWidgetPayload;
        if (holdNextWrite) {
          holdNextWrite = false;
          enteredFirst();
          await firstGate;
        }
        nativeEvents.push(`set:${parsed.applianceId}:${parsed.status}`);
        stored = parsed;
      },
      async clearStatusWidget(applianceId: string | null, source?: 'cloud' | 'community' | null) {
        const filter: ClearStatusWidgetFilter | undefined =
          applianceId || source
            ? { ...(applianceId ? { applianceId } : {}), ...(source ? { source } : {}) }
            : undefined;
        nativeEvents.push(`clear:${applianceId ?? '*'}:${source ?? '*'}`);
        if (shouldClearStatusWidget(stored, filter)) stored = null;
      },
    };

    const nativeQueue = createStatusWidgetQueue(() => nativeStore);
    const sync = createStatusWidgetSync(nativeQueue);

    // 1. Revocation/rekey: boxA1 is in-flight in native, boxA2 is waiting in the bridge queue,
    // and ManagedApp calls nativeQueue.clearStatusWidget() before StatusWidgetBridge unmounts.
    const p1 = sync.push(boxA1);
    await firstEntered;
    const p2 = sync.push(boxA2);
    const pClear = nativeQueue.clearStatusWidget();
    releaseFirst();

    expect(await p1).toBe(true);
    expect(await p2).toBe(false);
    await pClear;
    expect(stored).toBeNull();
    expect(nativeEvents).toEqual(['set:wb-a:1 thing needs you', 'clear:*:*']);

    // An external clear also resets deduplication for the cleared box so reconnecting with the same overview writes again.
    expect(await sync.push(boxA1)).toBe(true);
    expect(stored).toEqual(boxA1);

    // 2. Scoped cloud sign-out clear drops queued cloud writes in the bridge queue without cancelling a queued community write.
    nativeEvents.length = 0;
    firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    holdNextWrite = true;

    const pCloud1 = sync.push(boxA2);
    await firstEntered;
    const pCloud2 = sync.push({ ...boxA2, status: '2 things need you' });
    const pComm = sync.push(boxB);
    const pCloudClear = nativeQueue.clearStatusWidget({ source: 'cloud' });
    releaseFirst();

    expect(await pCloud1).toBe(true);
    expect(await pCloud2).toBe(false);
    expect(await pComm).toBe(true);
    await pCloudClear;
    expect(stored).toEqual(boxB);
    expect(nativeEvents).toEqual([
      'set:wb-a:All good',
      'clear:*:cloud',
      'set:wb-b:1 thing needs you',
    ]);

    // 3. A push queued AFTER sync.clear() is not cancelled by sync.clear()'s own clear notification.
    nativeEvents.length = 0;
    firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    holdNextWrite = true;

    const pBefore = sync.push(boxA1);
    await firstEntered;
    const pSelfClear = sync.clear('wb-a');
    const pAfter = sync.push(boxA2);
    releaseFirst();

    expect(await pBefore).toBe(true);
    await pSelfClear;
    expect(await pAfter).toBe(true);
    expect(stored).toEqual(boxA2);

    sync.dispose();
  });
});
