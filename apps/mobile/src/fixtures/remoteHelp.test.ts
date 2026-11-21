/**
 * Remote help in the demo world (app remote-help.md AP-4478): every state answers as the box would, turning it on with
 * the dialog or the demo's passkey goes through the shared flow, Claude connects a little later, and Show has a record.
 */
import { remoteHelpCard, turnOnRemoteHelp } from '@whombat/client/managed';
import { RemoteHelpState, RemoteHelpVisit } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import {
  createDemoRemoteHelp,
  REMOTE_HELP_DEMO_STATES,
  REMOTE_HELP_DEMO_WHO,
  type RemoteHelpDemoState,
} from './remoteHelp';

const me = { id: 'prn_mara', name: 'Mara' };
const NOW = Date.parse('2026-10-21T12:05:00Z');

function world(state: RemoteHelpDemoState = 'off') {
  let now = NOW;
  const timers: { fn: () => void; at: number }[] = [];
  const demo = createDemoRemoteHelp({
    me,
    state,
    now: () => now,
    visitAfterMs: 5_000,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
  };
  return { demo, advance };
}

/** The shared card for what the demo answers. */
async function card(demo: ReturnType<typeof createDemoRemoteHelp>) {
  return remoteHelpCard({
    state: await demo.api.get(),
    hasPasskey: await demo.api.hasPasskey(),
    now: new Date(NOW),
    timeZone: 'Europe/Amsterdam',
  });
}

describe('the demo’s states', () => {
  it.each(REMOTE_HELP_DEMO_STATES)('%s answers in the contract’s shapes', async (state) => {
    const { demo } = world(state);
    RemoteHelpState.parse(await demo.api.get());
    for (const v of await demo.api.visits()) RemoteHelpVisit.parse(v);
  });

  it('starts off, on or as a customer’s Whombat as the card shows them', async () => {
    expect((await card(world('off').demo)).kind).toBe('off');
    expect(await card(world('passkey').demo)).toMatchObject({ kind: 'off', hint: expect.any(String) });
    expect((await card(world('unavailable').demo)).kind).toBe('unavailable');

    const on = await card(world('on').demo);
    expect(on).toMatchObject({ kind: 'on', level: 'fix', helpCode: null });
    expect(on.kind === 'on' && on.connected).toHaveLength(1);

    const customer = await card(world('customer').demo);
    expect(customer).toMatchObject({ kind: 'on', level: 'look', helpCode: { code: expect.any(String) } });
    // A test Whombat has Forever, a customer's doesn't.
    expect((await world('off').demo.api.get()).foreverAllowed).toBe(true);
    expect((await world('customer').demo.api.get()).foreverAllowed).toBe(false);
  });

  it('keeps what support did on earlier visits, the older one longer than is shown', async () => {
    const { demo } = world('history');
    const visits = await demo.api.visits();
    expect(visits.map((v) => [v.level, v.endedAt !== null, v.truncated])).toEqual([
      ['fix', true, false],
      ['look', true, true],
    ]);
    const shown = await demo.api.transcript(visits[0]?.id as string);
    expect(shown.text).toContain('systemctl restart whombat-voice');
    expect(shown.text).not.toContain('\u001b');
    await expect(demo.api.transcript(visits[1]?.id as string)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('turning it on in the demo', () => {
  it('asks in the dialog without a passkey, then Claude connects a few seconds later', async () => {
    const { demo, advance } = world('off');
    let changes = 0;
    demo.onChange(() => changes++);
    const asked: unknown[] = [];
    const deps = {
      api: demo.api,
      platform: demo.platform,
      endpoint: demo.endpoint,
      confirm: async (choice: unknown) => {
        asked.push(choice);
        return true;
      },
    };
    const r = await turnOnRemoteHelp(deps, { level: 'fix', duration: 'forever' });
    expect(r).toMatchObject({ kind: 'on', state: { grant: { level: 'fix', until: null } } });
    expect(asked).toEqual([{ level: 'fix', duration: 'forever' }]);
    expect((await demo.api.get()).connected).toEqual([]);

    advance(5_000);
    expect(changes).toBe(1);
    expect((await demo.api.get()).connected.map((c) => c.who)).toEqual([REMOTE_HELP_DEMO_WHO]);
    const [visit] = await demo.api.visits();
    expect(visit?.steps.map((s) => s.kind)).toContain('shell');
    expect(visit?.transcriptBytes).toBeGreaterThan(0);
  });

  it('confirms with the demo’s passkey, bound to the choice and this phone', async () => {
    const { demo, advance } = world('passkey');
    const deps = {
      api: demo.api,
      platform: demo.platform,
      endpoint: demo.endpoint,
      confirm: async () => {
        throw new Error('no dialog with a passkey');
      },
    };
    const turning = turnOnRemoteHelp(deps, { level: 'look', duration: 'week' });
    // The authenticator answers after a moment, as a fingerprint does.
    await Promise.resolve();
    await Promise.resolve();
    advance(600);
    await expect(turning).resolves.toMatchObject({ kind: 'on', state: { grant: { level: 'look' } } });
    // A passkey request for one choice confirms that choice only.
    const begun = await demo.api.confirmBegin({ level: 'look', duration: 'hour' });
    await expect(demo.api.start({ level: 'fix', duration: 'hour' })).rejects.toMatchObject({
      details: { code: 'passkey_required' },
    });
    expect(begun.options?.challenge).toBeTruthy();
  });

  it('Stop ends it, and nobody comes later', async () => {
    const { demo, advance } = world('off');
    await demo.api.start({ level: 'fix', duration: 'hour' });
    const stopped = await demo.api.stop();
    expect(stopped.grant).toBeNull();
    advance(10_000);
    expect((await demo.api.get()).connected).toEqual([]);
    expect(await demo.api.visits()).toEqual([]);
  });

  it('starts over in another state', async () => {
    const { demo } = world('on');
    demo.reset('off');
    expect((await demo.api.get()).grant).toBeNull();
    expect(await demo.api.visits()).toEqual([]);
  });
});
