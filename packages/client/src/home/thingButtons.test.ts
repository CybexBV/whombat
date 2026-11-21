import type { ThingPageButton } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { resourceKey, thingImageResource } from '../session/resources';
import {
  guessedOn,
  guessedStep,
  STEPPER_SEND_MS,
  settleGuesses,
  stepperCan,
  stepperClamp,
  stepperNext,
  stepperWords,
  switchValue,
  THING_IMAGE_RATIO,
  THING_PAGE_REFRESH_MIN_S,
  thingActionBody,
  thingButtonKey,
  thingButtonView,
  thingControlLook,
  thingGalleryWords,
  thingImageInitial,
  thingItemLink,
  thingPageIsLive,
  thingProgressPct,
  thingRefreshMs,
} from './thingButtons';

const approve: ThingPageButton = {
  action: 'approve',
  target: 'req_12',
  label: 'Approve',
  icon: 'check',
  tone: 'primary',
  allowed: true,
};

const unlock: ThingPageButton = {
  action: 'unlock',
  target: 'door_front',
  label: 'Unlock',
  icon: 'unlock',
  confirm: { title: 'Unlock Front door?', body: 'It opens for anyone.', button: 'Unlock' },
  allowed: false,
  reason: 'Look only: Whombat changes nothing here.',
};

describe('thing buttons (AP-4530, AP-4531)', () => {
  it('send their action, target and value — or the value the client chose', () => {
    expect(thingActionBody(approve)).toEqual({ action: 'approve', target: 'req_12' });
    expect(thingActionBody({ ...approve, value: 'half' })).toEqual({
      action: 'approve',
      target: 'req_12',
      value: 'half',
    });
    expect(
      thingActionBody({ action: 'toggle', target: 'light.kitchen', label: 'Kitchen', allowed: true }, false),
    ).toEqual({ action: 'toggle', target: 'light.kitchen', value: false });
    expect(thingActionBody({ action: 'pause', label: 'Pause', allowed: true })).toEqual({ action: 'pause' });
  });

  it('are told apart by action, target and value', () => {
    const keys = new Set([
      thingButtonKey(approve),
      thingButtonKey({ ...approve, target: 'req_13' }),
      thingButtonKey({ ...approve, value: 1 }),
      thingButtonKey({ ...approve, value: '1' }),
      thingButtonKey(approve, true),
    ]);
    expect(keys.size).toBe(5);
  });

  it('are disabled with the server’s reason when not allowed, and carry their question', () => {
    const v = thingButtonView(unlock);
    expect(v.disabled).toBe(true);
    expect(v.reason).toContain('Look only');
    expect(v.confirm?.button).toBe('Unlock');
    expect(v.icon).toBe('unlock');
    expect(v.tone).toBeNull();
    const a = thingButtonView(approve);
    expect(a.disabled).toBe(false);
    expect(a.reason).toBeNull();
    expect(a.confirm).toBeNull();
    expect(a.tone).toBe('primary');
  });
});

describe('controls (AP-4532…AP-4534)', () => {
  const stepper = {
    value: 21,
    min: 7,
    max: 30,
    step: 0.5,
    unit: '°C',
    button: { action: 'set_temperature', target: 'climate.living', label: 'Set', allowed: true },
  };

  it('draw a switch, a stepper, buttons, a picture or a value', () => {
    expect(thingControlLook({ id: 'a', label: 'A', on: true, toggle: approve })).toBe('switch');
    expect(thingControlLook({ id: 'a', label: 'A', stepper })).toBe('stepper');
    expect(thingControlLook({ id: 'a', label: 'A', buttons: [approve] })).toBe('buttons');
    expect(thingControlLook({ id: 'a', label: 'A', buttons: [] })).toBe('value');
    expect(
      thingControlLook({ id: 'a', label: 'A', image: { ref: 'x'.repeat(20), alt: '', shape: 'wide' } }),
    ).toBe('image');
    expect(thingControlLook({ id: 'a', label: 'A', state: '21.5 °C' })).toBe('value');
  });

  it('switch to the state they are not in', () => {
    expect(switchValue(true)).toBe(false);
    expect(switchValue(false)).toBe(true);
    expect(switchValue(undefined)).toBe(true);
  });

  it('step by their step within min…max, on the grid from min', () => {
    expect(stepperNext(stepper, 21, 1)).toBe(21.5);
    expect(stepperNext(stepper, 21, -1)).toBe(20.5);
    expect(stepperNext(stepper, 30, 1)).toBe(30);
    expect(stepperNext(stepper, 7, -1)).toBe(7);
    expect(stepperNext({ min: 0, max: 1, step: 0.1 }, 0.2, 1)).toBe(0.3);
    expect(stepperClamp(stepper, 21.3)).toBe(21.5);
    expect(stepperClamp({ min: 1, max: 10, step: 2 }, 4)).toBe(5);
    expect(stepperCan(stepper, 30, 1)).toBe(false);
    expect(stepperCan(stepper, 30, -1)).toBe(true);
    expect(stepperCan(stepper, 7, -1)).toBe(false);
    expect(STEPPER_SEND_MS).toBeGreaterThan(0);
  });

  it('say their figure with the step’s decimals and the unit', () => {
    expect(stepperWords(stepper, 21)).toBe('21.0 °C');
    expect(stepperWords(stepper, 21.5)).toBe('21.5 °C');
    expect(stepperWords({ step: 5 }, 40)).toBe('40');
  });

  it('keep what the person set until a read after the answer', () => {
    const light = { id: 'light.kitchen', on: false };
    const running = { 'light.kitchen': { value: true, answeredAt: null } };
    expect(guessedOn(light, running)).toBe(true);
    // A read while it runs leaves the guess.
    expect(settleGuesses(running, 5_000)).toBe(running);
    const answered = { 'light.kitchen': { value: true, answeredAt: 1_000 } };
    expect(settleGuesses(answered, 999)).toBe(answered);
    const settled = settleGuesses(answered, 1_000);
    expect(settled).toEqual({});
    expect(guessedOn(light, settled)).toBe(false);
    const thermostat = { id: 'climate.living', stepper: { value: 21 } };
    expect(guessedStep(thermostat, { 'climate.living': { value: 22.5, answeredAt: null } })).toBe(22.5);
    expect(guessedStep(thermostat, {})).toBe(21);
  });
});

describe('live pages (AP-4535)', () => {
  it('read again as often as the page asks, never under 5 s, else every minute', () => {
    expect(thingRefreshMs({ refreshS: 10 })).toBe(10_000);
    expect(thingRefreshMs({ refreshS: 1 })).toBe(THING_PAGE_REFRESH_MIN_S * 1000);
    expect(thingRefreshMs({})).toBe(60_000);
    expect(thingRefreshMs(null)).toBe(60_000);
    expect(thingPageIsLive({ refreshS: 5 })).toBe(true);
    expect(thingPageIsLive({})).toBe(false);
  });
});

describe('galleries and pictures (AP-4536, AP-4537)', () => {
  it('keep each shape’s box', () => {
    expect(THING_IMAGE_RATIO).toEqual({ poster: '2 / 3', wide: '16 / 9', square: '1 / 1' });
  });

  it('lead to the app’s page first, else the service’s', () => {
    expect(thingItemLink({ href: '/things/x', url: 'https://plex.example/web' })).toEqual({
      kind: 'href',
      href: '/things/x',
    });
    expect(thingItemLink({ url: 'https://plex.example/web' })).toEqual({
      kind: 'url',
      url: 'https://plex.example/web',
    });
    expect(thingItemLink({})).toBeNull();
  });

  it('fill a progress bar in whole percent within 0…100', () => {
    expect(thingProgressPct(0.634)).toBe(63);
    expect(thingProgressPct(1.2)).toBe(100);
    expect(thingProgressPct(undefined)).toBeNull();
    expect(thingProgressPct(Number.NaN)).toBeNull();
  });

  it('show the title’s first letter in an empty box', () => {
    expect(thingImageInitial('dune: Part Two')).toBe('D');
    expect(thingImageInitial('’71')).toBe('7');
    expect(thingImageInitial('…')).toBe('');
  });

  it('name an item by its words in order', () => {
    expect(
      thingGalleryWords({ title: 'Dune', sub: '2024', badge: { text: '4K', tone: 'ok' }, progress: 0.5 }),
    ).toBe('Dune · 2024 · 4K · 50 %');
    expect(thingGalleryWords({ title: 'Dune', note: '63 % · 12 min left', progress: 0.63 })).toBe(
      'Dune · 63 % · 12 min left',
    );
  });

  it('load as resources keyed short enough for a file name', () => {
    const ref = `${'a'.repeat(400)}.${'b'.repeat(22)}`;
    const r = thingImageResource('mara', 'connection:con_plex', ref);
    expect(r).toEqual({ kind: 'thing-image', burrow: 'mara', thing: 'connection:con_plex', ref });
    const key = resourceKey(r);
    expect(key.length).toBeLessThanOrEqual(44);
    expect(key).not.toBe(resourceKey({ ...r, ref: `${ref}c` }));
    expect(key).not.toBe(resourceKey({ ...r, thing: 'connection:con_other' }));
    expect(key).toBe(resourceKey(thingImageResource('mara', 'connection:con_plex', ref)));
  });
});
