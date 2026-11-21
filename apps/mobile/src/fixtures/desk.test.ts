/** The desk screen in the demo world (desk-display-android.md AP-3061): every state reads as `desk.get` answers it. */
import { hostPowerLine } from '@whombat/client';
import {
  DeskScreen,
  deskErrorCode,
  deskLockAgainPatch,
  deskSectionShown,
  deskSectionView,
  deskUnlockRequest,
} from '@whombat/client/desk';
import { describe, expect, it } from 'vitest';
import { createDemoDesk, DESK_DEMO_STATES, type DeskDemoState, deskDemoSetup } from './desk';

const me = { id: 'prn_mara', name: 'Mara' };
const NOW = Date.parse('2026-09-23T12:05:00Z');
const context = { assistant: 'Neo', timeZone: 'Europe/Amsterdam', now: NOW };

function world(state: DeskDemoState = 'unpaired') {
  let now = NOW;
  const timers: { fn: () => void; at: number }[] = [];
  const demo = createDemoDesk({
    now: () => now,
    me,
    state,
    unlockAfterPairMs: 5_000,
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
  return { demo, advance, now: () => now };
}

describe('the demo desk’s states', () => {
  it.each(DESK_DEMO_STATES)('%s answers desk.get in the contract’s shape', async (state) => {
    const { demo } = world(state);
    const screen = await demo.api.get();
    expect(DeskScreen.safeParse(screen).success).toBe(true);
  });

  it('pairs when unpaired, and leaves out a box without a screen', async () => {
    const view = async (state: DeskDemoState) => {
      const screen = await world(state).demo.api.get();
      return { shown: deskSectionShown(screen), view: deskSectionView(screen, context) };
    };
    expect((await view('unpaired')).view.unpaired).not.toBeNull();
    expect((await view('paired')).view.mine?.lockedView).toBe('summary');
    expect((await view('none')).shown).toBe(false);
    expect((await view('no-mic')).view.mine?.talk).toMatchObject({ on: false, disabled: true });
    expect((await view('no-voice')).view.mine?.talk).toMatchObject({ on: false, disabled: true });
  });

  it('with the switch: what the screen is, whether it is on, and a pairing without a PIN', async () => {
    const view = async (state: DeskDemoState) => deskSectionView(await world(state).demo.api.get(), context);
    const auto = await view('auto');
    expect(auto.onScreen).toMatchObject({ on: true, line: 'Built-in screen', hint: null });
    expect(auto.mine?.pin.has).toBe(false);
    expect((await view('pinned')).mine?.pin.has).toBe(true);
    expect((await view('off')).onScreen).toMatchObject({ on: false, line: 'DELL U2720Q · connected' });
    expect((await view('off')).unpaired).toBeNull();
    expect((await view('vm')).onScreen?.hint).toContain('virtual machine');
    expect((await view('unplugged')).onScreen?.line).toContain('No screen');
  });

  it('chooses when the screen locks again and turns the camera on', async () => {
    const view = async (state: DeskDemoState) => deskSectionView(await world(state).demo.api.get(), context);
    const values = (v: Awaited<ReturnType<typeof view>>) => v.lockAgain?.options.map((o) => o.value);
    const pinned = await view('pinned');
    expect(values(pinned)).toEqual(['idle', 'away', 'never']);
    expect(pinned.lockAgain).toMatchObject({ value: 'idle' });
    expect(pinned.cameraWake).toMatchObject({ on: false });
    expect(values(await view('auto'))).toEqual(['idle', 'away', 'never']);
    // No camera: no When you leave, no camera switch.
    const noCamera = await view('nocamera');
    expect(values(noCamera)).toEqual(['idle', 'never']);
    expect(noCamera.cameraWake).toBeNull();

    const { demo } = world('pinned');
    const never = await demo.api.update(deskLockAgainPatch('never'));
    expect(deskSectionView(never, context).lockAgain?.value).toBe('never');
    expect(deskSectionView(never, context).lockAgain?.meta).toContain('Neo');
    expect((await demo.api.update({ cameraWake: true })).settings.cameraWake).toBe(true);
  });

  it('speaks with the six voices on the panel (0.105): Voice under Talk, a choice, Listen', async () => {
    const view = async (state: DeskDemoState) =>
      deskSectionView(await world(state).demo.api.get(), context).mine?.voice ?? null;
    expect((await view('auto'))?.options).toHaveLength(6);
    expect((await view('pinned'))?.value).toBe('heart');
    // Runtimes from before list no voices.
    for (const state of ['paired', 'unplugged'] as const) expect(await view(state)).toBeNull();
    const { demo } = world('pinned');
    expect((await demo.api.update({ speechVoice: 'emma' })).settings.speechVoice).toBe('emma');
    const wav = await demo.api.voiceSample('emma');
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
  });

  it('refuses a PIN that is too easy before it tries the letters', async () => {
    const { demo } = world('pairing');
    const easy = await demo.api.pair({ code: 'ABCD', pin: '1111' }).catch((error: unknown) => error);
    expect(deskErrorCode(easy)).toBe('easy_pin');
    const paired = await demo.api.pair({ code: demo.screen().letters() ?? '', pin: '2580' });
    expect(paired.paired?.personId).toBe(me.id);
  });

  it('turns a virtual machine’s screen on (paired with you, no PIN) and asks to unlock once', async () => {
    const { demo, advance, now } = world('vm');
    const on = await demo.api.setScreen(true);
    expect(on.paired).toMatchObject({ personId: me.id, hasPin: false });
    advance(5_000);
    expect(deskUnlockRequest(await demo.api.get(), now())).not.toBeNull();
    const off = await demo.api.setScreen(false);
    expect(off).toMatchObject({ on: false, paired: null });
    expect(deskDemoSetup('vm', { me, now: NOW }).power).toBeNull();
  });

  it('powers the box: kept at 80 %, on battery, charging; none without a battery', () => {
    const power = (state: DeskDemoState) => deskDemoSetup(state, { me, now: NOW }).power;
    expect(hostPowerLine(power('paired'))).toMatchObject({ source: 'ac', tone: 'ok' });
    expect(hostPowerLine(power('paired'))?.text).toMatch(/80\s%/);
    expect(hostPowerLine(power('battery'))).toMatchObject({ source: 'battery', tone: 'warn' });
    expect(hostPowerLine(power('battery'))?.text).toContain('3 h 10 min');
    expect(hostPowerLine(power('charging'))?.text).toContain('charging');
    expect(power('none')).toBeNull();
  });
});

describe('pairing the demo desk', () => {
  it('takes the letters the screen shows, then asks to unlock once', async () => {
    const { demo, advance, now } = world();
    let changes = 0;
    demo.onChange(() => changes++);
    await demo.api.startPairing();
    const letters = demo.screen().letters();
    expect(letters).toMatch(/^[A-Z]{4}$/);
    const wrong = await demo.api.pair({ code: 'ABCD', pin: '2580' }).catch((error: unknown) => error);
    expect(deskErrorCode(wrong)).toBe('wrong_code');
    expect(wrong).toMatchObject({ details: { triesLeft: 4 } });
    const paired = await demo.api.pair({ code: letters ?? '', pin: '2580' });
    expect(paired.paired?.personId).toBe(me.id);
    expect(changes).toBeGreaterThan(0);
    advance(5_000);
    const request = deskUnlockRequest(await demo.api.get(), now());
    expect(request?.secondsLeft).toBe(120);
    await demo.api.answerUnlock({ id: request?.id ?? '', unlock: true });
    expect((await demo.api.get()).unlockRequest).toBeNull();
    // Once: unpairing and pairing again asks nothing.
    await demo.api.unpair();
    await demo.api.startPairing();
    await demo.api.pair({ code: demo.screen().letters() ?? '', pin: '2580' });
    advance(5_000);
    expect((await demo.api.get()).unlockRequest).toBeNull();
  });

  it('starts over in another state', async () => {
    const { demo, now } = world('paired');
    demo.reset('unlock');
    expect(deskUnlockRequest(await demo.api.get(), now())).not.toBeNull();
    demo.reset('pairing');
    expect(demo.screen().letters()).not.toBeNull();
    expect((await demo.api.get()).paired).toBeNull();
  });
});
