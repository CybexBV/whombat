import { describe, expect, it } from 'vitest';
import { edgeTone, MODAL_CLOSED, modalStep, modalView, notNow, pill, popping } from './attention';
import { FIXTURE_ATTENTION, FIXTURE_DISK, FIXTURE_OUTAGE, FIXTURE_QUESTION } from './fixtures';
import type { DeskAttention } from './types';

const none = new Set<string>();
const all: DeskAttention = { items: [FIXTURE_OUTAGE, FIXTURE_QUESTION, FIXTURE_DISK], more: 0, tone: 'bad' };

describe('the modal', () => {
  it('opens by itself for what pops, in the planner’s order', () => {
    const v = modalView(all, none, MODAL_CLOSED);
    expect(v.open).toBe(true);
    expect(v.items.map((i) => i.key)).toEqual([FIXTURE_OUTAGE.key, FIXTURE_QUESTION.key]);
    expect(v.item?.key).toBe(FIXTURE_OUTAGE.key);
  });

  it('steps through “1 of 2” and keeps the shown one by key', () => {
    let v = modalView(all, none, MODAL_CLOSED);
    v = modalView(all, none, modalStep(v, 1));
    expect([v.index, v.item?.key]).toEqual([1, FIXTURE_QUESTION.key]);
    expect(modalView(all, none, modalStep(v, 1)).index).toBe(1);
    // The outage resolved: the question stays shown.
    const later = { ...all, items: [FIXTURE_QUESTION, FIXTURE_DISK] };
    expect(modalView(later, none, modalStep(v, 1)).item?.key).toBe(FIXTURE_QUESTION.key);
  });

  it('puts the shown ones away with Not now and opens again only for something new', () => {
    const out = notNow(modalView(all, none, MODAL_CLOSED));
    expect(out.away).toEqual([FIXTURE_OUTAGE.key, FIXTURE_QUESTION.key]);
    const away = new Set(out.away);
    expect(modalView(all, away, out.state).open).toBe(false);
    const fresh = { ...FIXTURE_OUTAGE, key: 'look:server:nas', title: 'nas isn’t answering' };
    const v = modalView({ ...all, items: [fresh, ...all.items] }, away, out.state);
    expect([v.open, v.items.length, v.item?.key]).toEqual([true, 1, fresh.key]);
  });

  it('closes itself when what it shows is resolved', () => {
    const v = modalView({ items: [FIXTURE_DISK], more: 0, tone: 'warn' }, none, MODAL_CLOSED);
    expect(v.open).toBe(false);
  });

  it('opens from the pill with everything, smaller things and put-away ones too', () => {
    const away = new Set([FIXTURE_OUTAGE.key]);
    const v = modalView(all, away, { pill: true, shown: null });
    expect([v.open, v.mode, v.items.length]).toEqual([true, 'all', 3]);
    expect(popping(all, away).map((i) => i.key)).toEqual([FIXTURE_QUESTION.key]);
  });
});

describe('the pill and the edge', () => {
  it('counts everything, red for an outage or a question, amber otherwise', () => {
    expect(pill(FIXTURE_ATTENTION)).toEqual({ text: '2 things need you', tone: 'bad' });
    expect(pill({ items: [FIXTURE_DISK], more: 0 })).toEqual({ text: '1 thing needs you', tone: 'warn' });
    expect(pill({ items: [FIXTURE_DISK], more: 4, tone: 'warn' })?.text).toBe('5 things need you');
    expect(pill({ items: [], more: 0 })).toBeNull();
  });

  it('draws the edge while an outage or a question pops here, not for smaller things', () => {
    expect(edgeTone(all)).toBe('bad');
    expect(edgeTone({ items: [FIXTURE_DISK], more: 0 })).toBeNull();
    expect(edgeTone({ items: [{ ...FIXTURE_OUTAGE, pops: false }], more: 0 })).toBeNull();
  });
});
