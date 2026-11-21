/**
 * The desk in Settings (desk-display-web.md AP-3000…AP-3011, AP-3100…, AP-3300…, AP-3600…): the rows, the forms'
 * checks, the ops' errors in words, the unlock request by the clock, the fake screen's rules, and the power line.
 */
import { describe, expect, it } from 'vitest';
import { hostPowerLine, hostPowerOf } from '../host/power';
import { OperationError } from '../session/managed-ops';
import {
  DEFAULT_DESK_SETTINGS,
  type DeskDisplay,
  DeskScreen,
  deskLockAgainPatch,
  deskPinTooEasy,
  formatPowerLeft,
} from './contract';
import { createFakeDesk, type FakeDeskPerson, fakeDeskApi } from './fake';
import {
  DESK_TEXT,
  deskErrorCode,
  deskErrorText,
  deskLetters,
  deskLettersMinutes,
  deskLettersRefused,
  deskLockAgainView,
  deskNeedsNewLetters,
  deskPairProblem,
  deskPinProblem,
  deskPinRefused,
  deskSectionShown,
  deskSectionView,
  deskSwitchView,
  deskTalkView,
  deskUnlockRequest,
  formatDeskPinInput,
} from './model';

const NOW = Date.parse('2026-10-20T12:34:00Z');
const TZ = 'Europe/Amsterdam';
const CTX = { assistant: 'Neo', timeZone: TZ, now: NOW };

const JOHN: FakeDeskPerson = { personId: 'prn_john', name: 'John' };

function screen(over: Partial<DeskScreen> = {}): DeskScreen {
  return {
    paired: null,
    settings: DEFAULT_DESK_SETTINGS,
    pairing: null,
    unlockRequest: null,
    hasDisplay: true,
    hasMicrophone: true,
    hasSpeaker: true,
    hasBattery: true,
    voiceAvailable: true,
    display: { connected: true, real: true, builtIn: true, name: null },
    on: true,
    onChosen: false,
    presenceAvailable: false,
    lockAgain: ['idle', 'never'],
    cameraWakeAvailable: false,
    ...over,
  };
}

/** The person paired (`hasPin` and `self` as each test says). */
type Paired = NonNullable<DeskScreen['paired']>;
const person = (p: Omit<Paired, 'hasPin' | 'self'> & Partial<Paired>): Paired => ({
  hasPin: false,
  self: false,
  ...p,
});
const pairedJohn = person({ personId: JOHN.personId, name: 'John', pairedAt: '2026-10-18T09:00:00Z' });

describe('SCREEN rows', () => {
  it('shows where there is a display or a pairing', () => {
    expect(deskSectionShown(screen())).toBe(true);
    expect(deskSectionShown(screen({ display: UNPLUGGED }))).toBe(false);
    expect(deskSectionShown(screen({ display: UNPLUGGED, paired: pairedJohn }))).toBe(true);
  });

  it('unpaired: one row, and a running pairing says until when', () => {
    const v = deskSectionView(screen(), CTX);
    expect(v.paired).toBeNull();
    expect(v.mine).toBeNull();
    expect(v.unpaired).not.toBeNull();
    const pairing = deskSectionView(screen({ pairing: { expiresAt: '2026-10-20T12:44:00Z' } }), CTX);
    expect(pairing.unpaired?.meta).toContain('14:44');
  });

  it('paired: the person’s rows, since when', () => {
    const s = screen({ paired: { ...pairedJohn, hasPin: true } });
    const mine = deskSectionView(s, CTX);
    expect(mine.paired?.title).toContain('you');
    expect(mine.paired?.title).toContain('18 Oct');
    expect(mine.mine?.lockedView).toBe('summary');
    expect(mine.mine?.lockedOptions.map((o) => o.value)).toEqual(['time', 'summary', 'everything']);
    expect(mine.mine?.nightOptions.map((o) => o.value)).toEqual(['dim', 'black']);
    expect(mine.mine?.quietMeta).toContain('23:00');
    expect(mine.mine?.talk.title).toContain('Neo');
  });

  it('“Everything” names the assistant in its hint', () => {
    const s = screen({
      paired: { ...pairedJohn },
      settings: { ...DEFAULT_DESK_SETTINGS, lockedView: 'everything' },
    });
    expect(deskSectionView(s, CTX).mine?.lockedHint).toContain('Neo');
  });

  it('Talk is off by itself without a microphone or speech, with the reason', () => {
    expect(deskTalkView(screen(), 'Neo')).toMatchObject({ on: true, disabled: false });
    expect(
      deskTalkView(screen({ settings: { ...DEFAULT_DESK_SETTINGS, voice: false } }), 'Neo'),
    ).toMatchObject({
      on: false,
      disabled: false,
    });
    const noMic = deskTalkView(screen({ hasMicrophone: false }), 'Neo');
    expect(noMic).toMatchObject({ on: false, disabled: true });
    expect(noMic.meta).toContain('microphone');
    expect(deskTalkView(screen({ voiceAvailable: false }), 'Neo')).toMatchObject({
      on: false,
      disabled: true,
    });
  });
});

/* Lock again and the camera for the clock (0.107, DK-72, DK-74) --------------------------------------------------- */

describe('Lock again and Use the camera to see when you’re here (AP-3600…)', () => {
  const v107 = (over: Partial<DeskScreen> = {}) =>
    screen({
      paired: { ...pairedJohn },
      presenceAvailable: true,
      lockAgain: ['idle', 'away', 'never'],
      cameraWakeAvailable: true,
      ...over,
    });
  const set = (over: Partial<DeskScreen['settings']>) => ({ ...DEFAULT_DESK_SETTINGS, ...over });

  it('lists the choices the box offers, in their order', () => {
    const v = deskSectionView(v107(), CTX);
    expect(v.lockAgain).toMatchObject({ title: DESK_TEXT.lockAgain, value: 'idle' });
    expect(v.lockAgain?.options.map((o) => o.value)).toEqual(['idle', 'away', 'never']);
    expect(v.lockAgain?.options.map((o) => o.label)).toEqual([
      'After 2 minutes',
      'When you leave',
      'When you press Lock',
    ]);
    expect(v.lockAgain?.meta).toContain('2 minutes');
    expect(v.cameraWake).toMatchObject({ title: DESK_TEXT.cameraWake, on: false });
    expect(v.cameraWake?.meta).toContain('quiet hours');
  });

  it('shows the choice the settings make, its hint with the assistant’s name', () => {
    const value = (over: Partial<DeskScreen['settings']>) =>
      deskLockAgainView(v107({ settings: set(over) }), 'Neo');
    expect(value({ presence: true })?.value).toBe('away');
    expect(value({ presence: true })?.meta).toContain('30 seconds');
    const never = value({ stayUnlocked: true });
    expect(never?.value).toBe('never');
    expect(never?.meta).toContain('Neo');
    expect(never?.meta).not.toContain('{assistant}');
    // An older app's switch left on: When you press Lock wins (DK-76).
    expect(value({ presence: true, stayUnlocked: true })?.value).toBe('never');
  });

  it('without a camera: After 2 minutes and When you press Lock, no camera switch', () => {
    const noCamera = v107({
      presenceAvailable: false,
      lockAgain: ['idle', 'never'],
      cameraWakeAvailable: false,
    });
    const v = deskSectionView(noCamera, CTX);
    expect(v.lockAgain?.options.map((o) => o.value)).toEqual(['idle', 'never']);
    expect(v.cameraWake).toBeNull();
    // When you leave chosen before the camera went: the screen locks after 2 minutes, and says so.
    const gone = deskLockAgainView({ ...noCamera, settings: set({ presence: true }) }, 'Neo');
    expect(gone?.value).toBe('idle');
    expect(gone?.meta).toContain('2 minutes');
  });

  it('shows both as chosen', () => {
    const v = deskSectionView(v107({ settings: set({ presence: true, cameraWake: true }) }), CTX);
    expect(v.lockAgain).toMatchObject({ value: 'away' });
    expect(v.cameraWake).toMatchObject({ on: true });
  });

  it('nothing while unpaired', () => {
    const v = deskSectionView(v107({ paired: null }), CTX);
    expect(v.lockAgain).toBeNull();
    expect(v.cameraWake).toBeNull();
  });

  it('choosing sends both members, so an older app’s switch can’t contradict it', () => {
    expect(deskLockAgainPatch('never')).toEqual({ presence: false, stayUnlocked: true });
    expect(deskLockAgainPatch('away')).toEqual({ presence: true, stayUnlocked: false });
    expect(deskLockAgainPatch('idle')).toEqual({ presence: false, stayUnlocked: false });
  });
});

/* The switch (0.101, DK-16…DK-20) ---------------------------------------------------------------------------------- */

const DELL: DeskDisplay = { connected: true, real: true, builtIn: false, name: 'DELL U2720Q' };
const PANEL: DeskDisplay = { connected: true, real: true, builtIn: true, name: null };
const QEMU: DeskDisplay = { connected: true, real: false, builtIn: false, name: 'QEMU Monitor' };
const UNPLUGGED: DeskDisplay = { connected: false, real: false, builtIn: false, name: null };

describe('SCREEN with the switch (AP-3100…AP-3106)', () => {
  it('the screen line: its name, a built-in panel, a nameless screen, none now', () => {
    const line = (display: DeskDisplay) => deskSwitchView(screen({ display }))?.line;
    expect(line(DELL)).toBe('DELL U2720Q · connected');
    expect(line(PANEL)).toBe('Built-in screen');
    expect(line({ ...DELL, name: null })).toBe('A screen is connected');
    expect(line(UNPLUGGED)).toBe('No screen is connected right now.');
  });

  it('a virtual machine’s screen reads off with its hint until the person turns it on', () => {
    const vm = deskSwitchView(screen({ display: QEMU, on: false, onChosen: false }));
    expect(vm).toMatchObject({ on: false });
    expect(vm?.hint).toContain('virtual machine');
    const chosen = deskSwitchView(screen({ display: QEMU, on: true, onChosen: true, paired: pairedJohn }));
    expect(chosen).toMatchObject({ on: true, hint: null });
    // Turned off on a real screen, or a screen that isn't there: what off means, not the VM's words.
    expect(deskSwitchView(screen({ display: DELL, on: false, onChosen: true }))?.hint).toContain('goes dark');
    expect(deskSwitchView(screen({ display: UNPLUGGED, on: false }))?.hint).not.toContain('virtual');
  });

  it('paired with you without a PIN: Choose a PIN, and the choices as before', () => {
    const s = screen({
      display: PANEL,
      on: true,
      paired: { ...pairedJohn, hasPin: false, self: true },
    });
    const v = deskSectionView(s, CTX);
    expect(v.paired?.meta).not.toContain('PIN');
    expect(v.mine?.pin).toMatchObject({ has: false, action: 'Choose a PIN' });
    expect(v.mine?.pin.meta).toContain('No PIN yet');
    expect(v.mine?.lockedView).toBe('summary');
    const withPin = deskSectionView(
      screen({ display: PANEL, on: true, paired: { ...pairedJohn, hasPin: true } }),
      CTX,
    );
    expect(withPin.mine?.pin).toMatchObject({ has: true, action: 'Change PIN' });
  });

  it('nobody paired: a row while on (it pairs itself), none while off', () => {
    const on = deskSectionView(screen({ display: DELL, on: true }), CTX);
    expect(on.unpaired?.meta).toContain('pairs itself');
    expect(deskSectionView(screen({ display: QEMU, on: false }), CTX).unpaired).toBeNull();
    // Letters on the screen say until when, on or off.
    const letters = deskSectionView(
      screen({ display: QEMU, on: false, pairing: { expiresAt: '2026-10-20T12:44:00Z' } }),
      CTX,
    );
    expect(letters.unpaired?.meta).toContain('14:44');
  });

  it('shows where a screen is connected or one is paired', () => {
    expect(deskSectionShown(screen({ display: QEMU }))).toBe(true);
    expect(deskSectionShown(screen({ display: UNPLUGGED, hasDisplay: false }))).toBe(false);
    expect(deskSectionShown(screen({ display: UNPLUGGED, hasDisplay: false, paired: pairedJohn }))).toBe(
      true,
    );
  });

  it('says why the switch or a PIN was refused', () => {
    const e = (code: string) => new OperationError('desk.setScreen', 409, 'conflict', 'x', { code });
    expect(deskErrorText(e('no_screen'))).toContain('No screen');
    expect(deskErrorText(e('no_pin'))).toContain('no PIN');
  });
});

describe('forms', () => {
  it('letters: four of the claim alphabet, any case and spacing', () => {
    expect(deskLetters('kx-qm')).toBe('KXQM');
    expect(deskLetters('KXQ')).toBeNull();
    expect(deskLetters('KXQO')).toBeNull();
  });

  it('PIN: 4 to 6 digits typed twice (DK-26)', () => {
    expect(formatDeskPinInput('25a 80-4173')).toBe('258041');
    expect(deskPinProblem('258', '258')).toMatchObject({ field: 'pin', text: DESK_TEXT.problems.pin });
    for (const pin of ['2580', '13975', '860417']) expect(deskPinProblem(pin, pin)).toBeNull();
    expect(deskPinProblem('2580', '2581')?.field).toBe('pinAgain');
    expect(deskPinProblem('25804', '2580')?.field).toBe('pinAgain');
    expect(deskPairProblem({ letters: 'KX', pin: '2580', pinAgain: '2580' })?.field).toBe('letters');
    expect(deskPairProblem({ letters: 'KXQM', pin: '2580', pinAgain: '2580' })).toBeNull();
  });

  it('PIN: one that is too easy to guess is refused before anything is sent (DK-27)', () => {
    for (const pin of [
      '0000',
      '1234',
      '7890',
      '8901',
      '9012',
      '0987',
      '4321',
      '1212',
      '6969',
      '123123',
      '123456',
      '654321',
    ]) {
      expect(deskPinTooEasy(pin)).toBe(true);
      expect(deskPinProblem(pin, pin)).toMatchObject({ field: 'pin', text: DESK_TEXT.problems.easy });
    }
    for (const pin of ['2580', '1397', '5203', '860417', '246810']) expect(deskPinTooEasy(pin)).toBe(false);
    // Easy before the second field: that one is to choose again first.
    expect(deskPinProblem('1111', '2222')?.field).toBe('pin');
  });

  it('minutes until the letters change', () => {
    expect(deskLettersMinutes('2026-10-20T12:43:30Z', NOW)).toBe(9);
    expect(deskLettersMinutes('2026-10-20T12:34:30Z', NOW)).toBe(0);
    expect(deskLettersMinutes('2026-10-20T12:34:00Z', NOW)).toBeNull();
  });
});

describe('errors', () => {
  // As the runtime refuses (CT-525): the generic code, the desk's own in `details.code`.
  const e = (code: string, details: Record<string, unknown> = {}) =>
    new OperationError('desk.pair', 403, 'forbidden', 'x', { code, ...details });
  it('says how many tries are left, and when the letters are new', () => {
    expect(deskErrorText(e('wrong_code', { triesLeft: 2 }))).toContain('2 tries left');
    expect(deskErrorText(e('wrong_code', { triesLeft: 1 }))).toContain('1 try left');
    expect(deskErrorText(e('wrong_code', { triesLeft: 0 }))).toContain('new ones');
    expect(deskLettersRefused(e('wrong_code', { triesLeft: 2 }))).toBe(true);
    expect(deskNeedsNewLetters(e('wrong_code', { triesLeft: 2 }))).toBe(false);
    expect(deskNeedsNewLetters(e('wrong_code', { triesLeft: 0 }))).toBe(true);
    expect(deskNeedsNewLetters(e('pairing_expired'))).toBe(true);
  });

  it('a PIN that is too easy, or too short for a Whombat from before 0.103 (DK-27, DK-34)', () => {
    const easy = new OperationError('desk.setPin', 400, 'validation_failed', 'x', { code: 'easy_pin' });
    expect(deskErrorText(easy)).toBe(DESK_TEXT.problems.easy);
    expect(deskPinRefused(easy)).toBe(true);
    // An older runtime's schema refuses a 4-digit PIN: no desk code, the `pin` field.
    const old = new OperationError('desk.pair', 400, 'validation_failed', 'The request input is not valid.', {
      fields: { pin: ['Invalid string'] },
    });
    expect(deskErrorText(old)).toBe(DESK_TEXT.errors.sixDigits);
    expect(deskPinRefused(old)).toBe(true);
    const other = new OperationError('desk.update', 400, 'validation_failed', 'x', {
      fields: { night: ['x'] },
    });
    expect(deskErrorText(other)).toBe(DESK_TEXT.errors.failed);
    expect(deskPinRefused(e('wrong_code', { triesLeft: 2 }))).toBe(false);
  });

  it('falls back to plain words', () => {
    expect(deskErrorCode(e('not_paired'))).toBe('not_paired');
    expect(deskErrorText(new OperationError('desk.get', 403, 'forbidden', 'x'))).not.toContain('x');
    expect(deskErrorText(new Error('boom'))).not.toContain('boom');
    expect(deskErrorCode(new Error('boom'))).toBeNull();
  });
});

describe('the unlock request', () => {
  const request = { id: 'u1', expiresAt: '2026-10-20T12:35:30Z' };
  const s = screen({ paired: pairedJohn, unlockRequest: request });
  it('is the person’s while paired, until it expires', () => {
    expect(deskUnlockRequest(s, NOW)).toMatchObject({ id: 'u1', secondsLeft: 90 });
    expect(deskUnlockRequest(s, Date.parse('2026-10-20T12:35:30Z'))).toBeNull();
    expect(deskUnlockRequest(screen({ unlockRequest: request }), NOW)).toBeNull();
    expect(deskUnlockRequest(null, NOW)).toBeNull();
  });
});

describe('the fake screen', () => {
  function world() {
    let now = NOW;
    const desk = createFakeDesk({ now: () => now });
    return { desk, tick: (ms: number) => (now += ms) };
  }
  /** The desk's refusal (`details.code`, with `triesLeft`). */
  const codeOf = (r: { body: unknown }) =>
    (r.body as { error?: { details?: { code: string; triesLeft?: number } } }).error?.details;

  it('pairs when the person types the letters on the screen', async () => {
    const { desk } = world();
    const john = fakeDeskApi(desk, JOHN);
    await john.startPairing();
    const letters = desk.letters();
    expect(letters).toHaveLength(4);
    const paired = await john.pair({ code: (letters as string).toLowerCase(), pin: '246810' });
    expect(paired.paired?.personId).toBe(JOHN.personId);
    // What the fake answers is what the contracts let through.
    expect(DeskScreen.safeParse(paired).success).toBe(true);
    expect(paired.pairing).toBeNull();
    expect(desk.letters()).toBeNull();
  });

  it('counts wrong letters and draws new ones after five', () => {
    const { desk } = world();
    desk.call('desk.startPairing', {}, JOHN);
    const first = desk.letters();
    for (let i = 1; i <= 4; i++)
      expect(codeOf(desk.call('desk.pair', { code: 'WWWW', pin: '246810' }, JOHN))).toEqual({
        code: 'wrong_code',
        triesLeft: 5 - i,
      });
    expect(codeOf(desk.call('desk.pair', { code: 'WWWW', pin: '246810' }, JOHN))).toEqual({
      code: 'wrong_code',
      triesLeft: 0,
    });
    expect(desk.letters()).not.toBe(first);
  });

  it('takes a 4-digit PIN, and refuses an easy one before the letters are tried', async () => {
    const { desk } = world();
    desk.call('desk.startPairing', {}, JOHN);
    const easy = desk.call('desk.pair', { code: 'WWWW', pin: '1234' }, JOHN);
    expect(easy.status).toBe(400);
    expect(codeOf(easy)?.code).toBe('easy_pin');
    // No try was used up: five wrong letters still to go.
    expect(codeOf(desk.call('desk.pair', { code: 'WWWW', pin: '2580' }, JOHN))).toEqual({
      code: 'wrong_code',
      triesLeft: 4,
    });
    const john = fakeDeskApi(desk, JOHN);
    expect((await john.pair({ code: desk.letters() as string, pin: '2580' })).paired?.personId).toBe(
      JOHN.personId,
    );
    expect(desk.snapshot().paired?.pin).toBe('2580');
    await expect(john.setPin('0000')).rejects.toMatchObject({ details: { code: 'easy_pin' } });
    expect(codeOf(desk.call('desk.setPin', { pin: '123' }, JOHN))).toBeUndefined();
    expect((await john.setPin('13975')).paired?.personId).toBe(JOHN.personId);
    expect(desk.snapshot().paired?.pin).toBe('13975');
  });

  it('keeps Stay unlocked while you’re here among the screen’s choices', async () => {
    const desk = createFakeDesk({ hardware: { presenceAvailable: true } });
    desk.call('desk.startPairing', {}, JOHN);
    desk.call('desk.pair', { code: desk.letters(), pin: '246810' }, JOHN);
    const john = fakeDeskApi(desk, JOHN);
    const before = await john.get();
    expect(before).toMatchObject({ presenceAvailable: true, settings: { presence: false } });
    expect(DeskScreen.safeParse(before).success).toBe(true);
    expect((await john.update({ presence: true })).settings).toMatchObject({ presence: true, voice: true });
  });

  it('answers with Lock again: the choices, the camera switch and both members', async () => {
    const desk = createFakeDesk({ hardware: { presenceAvailable: true } });
    desk.call('desk.startPairing', {}, JOHN);
    desk.call('desk.pair', { code: desk.letters(), pin: '246810' }, JOHN);
    const john = fakeDeskApi(desk, JOHN);
    const before = await john.get();
    expect(before).toMatchObject({ lockAgain: ['idle', 'away', 'never'], cameraWakeAvailable: true });
    expect(DeskScreen.safeParse(before).success).toBe(true);
    const after = await john.update({ ...deskLockAgainPatch('never'), cameraWake: true });
    expect(after.settings).toMatchObject({ presence: false, stayUnlocked: true, cameraWake: true });
    // Without a camera: no When you leave, no camera switch.
    expect(await fakeDeskApi(createFakeDesk(), JOHN).get()).toMatchObject({
      lockAgain: ['idle', 'never'],
      cameraWakeAvailable: false,
    });
  });

  it('lets the letters run out after 10 minutes', () => {
    const { desk, tick } = world();
    desk.call('desk.startPairing', {}, JOHN);
    const code = desk.letters();
    tick(10 * 60_000);
    expect(codeOf(desk.call('desk.pair', { code, pin: '246810' }, JOHN))?.code).toBe('pairing_expired');
  });

  it('lets the person choose and unpair; choices need a pairing', async () => {
    const { desk } = world();
    expect(codeOf(desk.call('desk.update', { lockedView: 'time' }, JOHN))?.code).toBe('not_paired');
    desk.call('desk.startPairing', {}, JOHN);
    desk.call('desk.pair', { code: desk.letters(), pin: '246810' }, JOHN);
    const updated = await fakeDeskApi(desk, JOHN).update({
      quietHours: { enabled: false, start: '22:00', end: '06:00' },
    });
    expect(updated.settings.quietHours).toEqual({ enabled: false, start: '22:00', end: '06:00' });
    expect(updated.settings.lockedView).toBe('summary');
    const unpaired = await fakeDeskApi(desk, JOHN).unpair();
    expect(unpaired.paired).toBeNull();
  });

  it('with a display: on pairs the person without a PIN, off unpairs and stays off', async () => {
    let now = NOW;
    const desk = createFakeDesk({ now: () => now, display: QEMU });
    const john = fakeDeskApi(desk, JOHN);
    const vm = await john.get();
    expect(DeskScreen.safeParse(vm).success).toBe(true);
    expect(vm).toMatchObject({ display: QEMU, on: false, onChosen: false, paired: null, hasDisplay: true });

    const on = await john.setScreen(true);
    expect(on).toMatchObject({ on: true, onChosen: true });
    expect(on.paired).toMatchObject({ personId: JOHN.personId, hasPin: false, self: true });
    // The first PIN is set as one is changed (DK-18).
    now += 1000;
    expect((await john.setPin('135790')).paired?.hasPin).toBe(true);

    // `desk.unpair` from an older app turns it off (DK-20).
    const off = await john.unpair();
    expect(off).toMatchObject({ on: false, onChosen: true, paired: null });
    expect(desk.snapshot()).toMatchObject({ on: false, paired: null });
  });

  it('with a display: on needs a connected screen; the letters still pair with a PIN', async () => {
    expect(
      codeOf(createFakeDesk({ display: UNPLUGGED }).call('desk.setScreen', { on: true }, JOHN))?.code,
    ).toBe('no_screen');
    const desk = createFakeDesk({ display: DELL });
    desk.call('desk.startPairing', {}, JOHN);
    const paired = desk.call('desk.pair', { code: desk.letters(), pin: '246810' }, JOHN).body as DeskScreen;
    expect(paired.paired).toMatchObject({ personId: JOHN.personId, hasPin: true, self: false });
    expect(paired.on).toBe(true);
  });

  it('asks the person to unlock for 2 minutes', async () => {
    const { desk, tick } = world();
    desk.call('desk.startPairing', {}, JOHN);
    desk.call('desk.pair', { code: desk.letters(), pin: '246810' }, JOHN);
    let changes = 0;
    desk.onChange(() => changes++);
    desk.requestUnlock();
    expect(changes).toBe(1);
    const john = fakeDeskApi(desk, JOHN);
    const asked = await john.get();
    expect(asked.unlockRequest).not.toBeNull();
    await john.answerUnlock({ id: asked.unlockRequest?.id as string, unlock: true });
    expect(desk.unlocked()).toBe(true);

    desk.requestUnlock();
    const again = await john.get();
    tick(2 * 60_000);
    await expect(
      john.answerUnlock({ id: again.unlockRequest?.id as string, unlock: true }),
    ).rejects.toMatchObject({ code: 'expired', details: { code: 'request_expired' } });
  });
});

describe('the power line', () => {
  const text = (l: { text: string } | null) => l?.text.replaceAll('\u00a0', ' ');
  const ac = {
    source: 'ac' as const,
    percent: 80,
    charging: false,
    minutesLeft: null,
    chargeLimit: 80,
    since: null,
  };
  it('plugged in: held at the limit, or charging', () => {
    expect(hostPowerLine(ac)).toMatchObject({ source: 'ac', tone: 'ok' });
    expect(text(hostPowerLine(ac))).toContain('kept at 80 %');
    expect(text(hostPowerLine({ ...ac, charging: true, percent: 64.4 }))).toContain('charging · 64 %');
    expect(text(hostPowerLine({ ...ac, chargeLimit: null, percent: 100 }))).toContain('100 %');
  });

  it('on battery: amber with the time left, red from 15 %', () => {
    const out = {
      ...ac,
      source: 'battery' as const,
      percent: 64,
      minutesLeft: 190,
      since: '2026-10-20T00:14:00Z',
    };
    expect(hostPowerLine(out)).toMatchObject({ source: 'battery', tone: 'warn' });
    expect(text(hostPowerLine(out))).toContain('3 h 10 min');
    expect(hostPowerLine({ ...out, percent: 15 })?.tone).toBe('bad');
    expect(text(hostPowerLine({ ...out, minutesLeft: null }))).not.toContain('left');
  });

  it('nothing without a battery, or from a sample it can’t read', () => {
    expect(hostPowerLine(null)).toBeNull();
    expect(hostPowerOf({ cores: 4 })).toBeNull();
    expect(hostPowerOf({ power: { source: 'mains' } })).toBeNull();
    expect(hostPowerOf({ power: ac })).toEqual(ac);
  });

  it('time left in hours and minutes', () => {
    expect(formatPowerLeft(45)).toBe('45 min');
    expect(formatPowerLeft(120)).toBe('2 h');
    expect(formatPowerLeft(190)).toBe('3 h 10 min');
  });
});
