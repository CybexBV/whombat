import { FeedbackTrailStep } from '@whombat/core';
import { WIDGET_ATTRIBUTES } from '@whombat/core/feedback';
import { describe, expect, it } from 'vitest';
import {
  ATTRS,
  BRIDGE_TAG,
  parseContext,
  parseFrameMessage,
  parseHostMessage,
  parseTrail,
  randomToken,
  type WidgetContext,
} from './protocol';

const instance = randomToken();
const context: WidgetContext = {
  page: { url: 'https://shop.example.com/cart', title: 'Cart' },
  browser: {
    name: 'Chrome 131 · macOS',
    language: 'en-US',
    viewport: { width: 1440, height: 900 },
    timeZone: 'UTC',
  },
  app: { version: '1.4.2', environment: 'production', build: null },
  custom: { plan: 'pro', seats: 3, beta: true, none: null },
  references: ['req_123'],
};

describe('parseFrameMessage', () => {
  const ok = (type: string, payload: unknown = {}) => ({ wb: BRIDGE_TAG, instance, type, payload });

  it('ignores anything else', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'ready',
      42,
      [],
      ok('open', { context }),
      ok('context', { context }),
      ok('unknown'),
      ok('__proto__'),
      ok('ready', { extra: 1 }),
      ok('ready', null),
      ok('ready', []),
      ok('submitted', { reference: 'FB-bad' }),
      ok('submitted', { reference: 'FB-7K3Q-9M2X', more: 1 }),
      ok('submitted', {}),
      { ...ok('ready'), wb: 'whombat-feedback/2' },
      { ...ok('ready'), instance: randomToken() },
      { ...ok('ready'), instance: undefined },
      { ...ok('ready'), extra: true },
      { wb: BRIDGE_TAG, instance, payload: {} },
      Object.assign(Object.create({ polluted: true }), ok('ready')),
      new Map([['wb', BRIDGE_TAG]]),
    ];
    for (const data of bad) expect(parseFrameMessage(data, instance), JSON.stringify(data)).toBeNull();
    // An instance that isn't a nonce never matches, even when equal.
    expect(parseFrameMessage({ ...ok('ready'), instance: 'x' }, 'x')).toBeNull();
  });
});

describe('parseHostMessage', () => {
  const ok = (type: string, payload: unknown) => ({ wb: BRIDGE_TAG, instance, type, payload });

  it('refuses malformed payloads and frame-only types', () => {
    const bad: unknown[] = [
      ok('open', { type: 'question', context }),
      ok('open', { context: null }),
      ok('open', {}),
      ok('open', { context, channelId: 'cnv_x' }),
      ok('context', { context: { ...context, cookies: 'a=b' } }),
      ok('context', { context: { ...context, page: { url: 'x'.repeat(2000), title: null } } }),
      ok('context', { context: { ...context, custom: { nested: { a: 1 } } } }),
      ok('context', { context: { ...context, custom: { n: Number.NaN } } }),
      ok('context', { context: { ...context, references: ['a', 'b', 'c', 'd', 'e', 'f'] } }),
      ok('context', {
        context: { ...context, browser: { ...context.browser, viewport: { width: -1, height: 1 } } },
      }),
      ok('ready', {}),
      ok('submitted', { reference: 'FB-7K3Q-9M2X' }),
      ok('close', { now: true }),
    ];
    for (const data of bad)
      expect(parseHostMessage(data, instance), JSON.stringify(data).slice(0, 120)).toBeNull();
  });
});

describe('the trail in the context (CT-161)', () => {
  const step = { url: 'https://shop.example.com/cart', title: 'Cart', at: '2026-09-30T10:00:00.000Z' };

  it('recognizes the snippet attributes and the visitor’s language override', () => {
    const { lang, ...snippet } = ATTRS;
    expect(snippet).toEqual(WIDGET_ATTRIBUTES);
    expect(lang).toBe('data-lang');
  });

  it('accepts up to 10 steps that core accepts, copied', () => {
    const trail = Array.from({ length: 10 }, (_, i) => ({ ...step, title: i % 2 ? null : `Page ${i}` }));
    const parsed = parseContext({ ...context, trail });
    expect(parsed?.trail).toEqual(trail);
    expect(parsed?.trail?.[0]).not.toBe(trail[0]);
    for (const s of trail) expect(FeedbackTrailStep.parse(s)).toEqual(s);
    expect(parseContext(context)).not.toHaveProperty('trail');
    expect(parseTrail([{ ...step, at: '2026-09-30T12:00:00+02:00' }])).toHaveLength(1);
  });

  it('refuses a trail that isn’t exactly that', () => {
    const bad: unknown[] = [
      null,
      {},
      Array.from({ length: 11 }, () => step),
      [{ ...step, extra: 1 }],
      [{ url: step.url, at: step.at }],
      [{ ...step, url: '' }],
      [{ ...step, url: 'x'.repeat(1025) }],
      [{ ...step, title: 't'.repeat(161) }],
      [{ ...step, at: 'yesterday' }],
      [{ ...step, at: '2026-09-30' }],
      [{ ...step, at: 1_790_000_000 }],
      ['https://shop.example.com/cart'],
    ];
    for (const trail of bad) {
      expect(parseTrail(trail), JSON.stringify(trail)?.slice(0, 80)).toBeNull();
      expect(parseContext({ ...context, trail })).toBeNull();
    }
  });
});
