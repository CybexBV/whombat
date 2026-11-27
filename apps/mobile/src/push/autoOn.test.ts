import { describe, expect, it } from 'vitest';
import { allowedQuietly, osMajor, type PushFacts, pushFacts, pushStart } from './autoOn';

const facts = (over: Partial<PushFacts>): PushFacts => ({
  platform: 'android',
  osVersion: 34,
  status: 'undetermined',
  canAskAgain: true,
  provisional: false,
  notNow: false,
  ...over,
});

describe('notifications on by themselves', () => {
  it('registers without a word where they are allowed already', () => {
    // Android 12 and older let apps notify unless the person turned it off.
    expect(pushStart(facts({ osVersion: 31, status: 'granted' }))).toBe('register');
    expect(pushStart(facts({ status: 'granted' }))).toBe('register');
    expect(pushStart(facts({ platform: 'ios', osVersion: 18, status: 'granted' }))).toBe('register');
    // An iPhone allowed quietly counts as on, “Not now” or not.
    expect(pushStart(facts({ platform: 'ios', osVersion: 18, provisional: true, notNow: true }))).toBe(
      'register',
    );
  });

  it('allows an iPhone never asked quietly, with no question', () => {
    expect(pushStart(facts({ platform: 'ios', osVersion: 18 }))).toBe('quietly');
    expect(pushStart(facts({ platform: 'ios', osVersion: 0 }))).toBe('quietly');
    // Before quiet notifications there was only the question.
    expect(pushStart(facts({ platform: 'ios', osVersion: 11 }))).toBe('sheet');
  });

  it('shows the sheet once on Android 13 and later, never asked', () => {
    expect(pushStart(facts({ osVersion: 33 }))).toBe('sheet');
    expect(pushStart(facts({ osVersion: 36 }))).toBe('sheet');
  });

  it('does nothing after Not now, after a refusal, or where it can’t ask', () => {
    expect(pushStart(facts({ notNow: true }))).toBe('nothing');
    expect(pushStart(facts({ platform: 'ios', osVersion: 18, notNow: true }))).toBe('nothing');
    expect(pushStart(facts({ status: 'denied' }))).toBe('nothing');
    // Refused once on Android 13: Android could ask again, but the person answered.
    expect(pushStart(facts({ status: 'denied', canAskAgain: true }))).toBe('nothing');
    expect(pushStart(facts({ canAskAgain: false }))).toBe('nothing');
    expect(pushStart(facts({ platform: 'ios', osVersion: 18, status: 'denied', canAskAgain: false }))).toBe(
      'nothing',
    );
    // Android 12 and older never ask: turned off there is the person's own setting.
    expect(pushStart(facts({ osVersion: 31, status: 'denied', canAskAgain: false }))).toBe('nothing');
    expect(pushStart(facts({ platform: 'other', osVersion: 0 }))).toBe('nothing');
  });
});

describe('reading expo-notifications’ answer', () => {
  it('counts a quiet iPhone as on although it isn’t `granted`', () => {
    const provisional = { status: 'undetermined', granted: false, canAskAgain: true, ios: { status: 3 } };
    expect(allowedQuietly(provisional)).toBe(true);
    expect(pushFacts(provisional, 'ios', 18, false)).toEqual({
      platform: 'ios',
      osVersion: 18,
      status: 'undetermined',
      canAskAgain: true,
      provisional: true,
      notNow: false,
    });
    // An App Clip's ephemeral authorization lets them through too.
    expect(allowedQuietly({ ...provisional, ios: { status: 4 } })).toBe(true);
    const never = { status: 'undetermined', granted: false, canAskAgain: true, ios: { status: 0 } };
    expect(allowedQuietly(never)).toBe(false);
    expect(pushStart(pushFacts(never, 'ios', 18, false))).toBe('quietly');
  });

  it('keeps allowed, refused and never asked apart on Android', () => {
    expect(
      pushFacts({ status: 'granted', granted: true, canAskAgain: true }, 'android', 34, false).status,
    ).toBe('granted');
    expect(
      pushFacts({ status: 'denied', granted: false, canAskAgain: false }, 'android', 31, false),
    ).toMatchObject({ status: 'denied', provisional: false });
    expect(
      pushStart(
        pushFacts({ status: 'undetermined', granted: false, canAskAgain: true }, 'android', 33, false),
      ),
    ).toBe('sheet');
  });

  it('reads the system’s version as a whole number', () => {
    expect(osMajor(34)).toBe(34);
    expect(osMajor('17.2')).toBe(17);
    expect(osMajor('26')).toBe(26);
    expect(osMajor(undefined)).toBe(0);
    expect(osMajor('beta')).toBe(0);
  });
});
