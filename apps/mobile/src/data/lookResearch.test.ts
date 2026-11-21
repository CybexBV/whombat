/**
 * Looks the assistant looked into on the phone (Whombat look-research.md LR-09; look-research-mobile.md AP-5920…): the
 * Needs you list's rows and their sheet, and the card on a thing's page. The words and buttons are the shared client's
 * (`lookResearchView`, tested there); this checks how the phone arranges them.
 */
import { needsYouListRow } from '@whombat/client';
import { type LookResearch, type NeedsYouItem, needsYouGroupOf } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { lookPlanItem } from './messages';
import { phoneRowOpens, phoneSheet } from './needsYou';
import { thingLookCard } from './thingPage';

const AT = '2026-10-27T09:12:00Z';
const KEY = 'connection:con_ha';

function research(over: Partial<LookResearch> = {}): LookResearch {
  return {
    key: KEY,
    state: 'found',
    title: 'Zigbee stopped working in Home Assistant',
    summary: 'After this morning’s update, Zigbee didn’t start again.',
    fix: 'Restart Zigbee',
    conversationId: 'cnv_dm-mara' as LookResearch['conversationId'],
    threadRootId: 'msg_look-ha' as LookResearch['threadRootId'],
    at: AT,
    ...over,
  };
}

const looking = (): LookResearch =>
  research({ state: 'looking', title: undefined, summary: undefined, fix: undefined });

function item(over: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    id: 'ny_look-ha',
    ref: { kind: 'connection', id: 'con_ha' },
    kind: 'connection',
    severity: 'warn',
    nature: 'problem',
    title: 'Home Assistant needs a look',
    body: '2 integrations stopped loading.',
    at: AT,
    subject: { kind: 'connection', id: 'con_ha', name: 'Home Assistant' },
    actions: [
      { id: 'look', label: 'Look into it', style: 'primary', kind: 'investigate' },
      { id: 'later', label: 'Not now', style: 'secondary', kind: 'snooze' },
    ],
    ...over,
  };
}

const opts = { now: Date.parse(AT) + 3 * 3_600_000, timeZone: 'Europe/Amsterdam', assistant: 'Neo' };
/** The item as the list draws it, in the group the Whombat gave it (core's `needsYouGroupOf`). */
const rowOf = (i: NeedsYouItem) => needsYouListRow({ ...i, group: needsYouGroupOf(i) }, opts);
const sheetOf = (i: NeedsYouItem) =>
  phoneSheet(rowOf(i), { Name: 'Neo' }, { now: opts.now, timeZone: opts.timeZone });
const buttons = (i: NeedsYouItem) => sheetOf(i).buttons.map((b) => [b.button.kind, b.label, b.variant]);

describe('Needs you rows with research (AP-5920; needs-you-list.md NYL-02, NYL-07)', () => {
  it('found: the assistant’s title and words, in Needs you; the row opens the sheet', () => {
    const row = rowOf(item({ research: research() }));
    expect(row).toMatchObject({ group: 'you', title: 'Zigbee stopped working in Home Assistant', body: '' });
    expect(row.says).toMatchObject({ state: 'found', fix: 'Restart Zigbee', busy: false });
    expect(phoneRowOpens(row)).toEqual({ to: 'sheet' });
    expect(row.label).toContain('Zigbee didn’t start again');
  });

  it('looking: Neo’s, its own words, “Neo is looking into it”; the row opens the look’s thread', () => {
    const row = rowOf(item({ research: looking() }));
    expect(row).toMatchObject({ group: 'assistant', title: 'Home Assistant needs a look' });
    expect(row.says?.text).toBe('Neo is looking into it');
    // Only More, to talk it over in its thread.
    expect(row.buttons.map((b) => [b.kind, b.more])).toEqual([['talk', true]]);
    expect(phoneRowOpens(row)).toEqual({ to: 'href', href: '/chat?thread=msg_look-ha' });
  });

  it('fixed: green in Neo’s group; once it failed, as before', () => {
    const fixed = rowOf(
      item({ research: research({ state: 'fixed', title: 'Zigbee works again', fix: undefined }) }),
    );
    expect(fixed).toMatchObject({ group: 'assistant', title: 'Zigbee works again' });
    expect(fixed.says?.fixed).toBe(true);
    const failed = rowOf(item({ research: research({ state: 'failed' }) }));
    expect(failed).toMatchObject({ group: 'you', says: null, title: 'Home Assistant needs a look' });
    expect(failed.buttons[0]).toMatchObject({ kind: 'handle', look: 'primary' });
  });
});

describe('the sheet with research (AP-5921)', () => {
  it('found with a step: the step filled, Settle outlined, then More’s quiet', () => {
    const sheet = sheetOf(item({ research: research() }));
    expect(sheet.title).toBe('Zigbee stopped working in Home Assistant');
    expect(sheet.says?.text).toContain('Zigbee didn’t start again');
    expect(buttons(item({ research: research() })).map((b) => [b[0], b[2]])).toEqual([
      ['fix', 'primary'],
      ['settle', 'secondary'],
      ['talk', 'quiet'],
      ['snooze', 'quiet'],
    ]);
  });

  it('found without a step: where it is done first, Settle and More’s', () => {
    const only = item({
      research: research({ fix: undefined }),
      actions: [
        ...item().actions,
        { id: 'reconnect', label: 'Sign in again', style: 'primary', kind: 'open', href: '/settings' },
      ],
    });
    expect(buttons(only).map((b) => b[0])).toEqual(['action', 'settle', 'talk', 'snooze']);
    expect(buttons(only)[0]).toEqual(['action', 'Sign in again', 'primary']);
    expect(buttons({ ...only, research: research() }).map((b) => b[0])).toEqual([
      'fix',
      'action',
      'settle',
      'talk',
      'snooze',
    ]);
  });

  it('says since when, as the desk’s card, on a finding only', () => {
    const since = sheetOf(item({ research: research() })).since;
    expect(since).toContain('10:12');
    expect(since).toContain('3 h');
    expect(sheetOf(item()).since).toBeNull();
  });

  it('without research: hand it to Neo first, never Look into it or Not now', () => {
    expect(buttons(item()).map((b) => b[0])).toEqual(['handle', 'settle', 'talk', 'snooze']);
    expect(buttons(item())[0]?.[1]).toContain('Neo');
  });
});

describe('the card on a thing’s page (AP-5923)', () => {
  it('found: its title, words, step and Ask opening the look’s thread, in the page’s colour', () => {
    const card = thingLookCard({ research: research(), status: 'warn' }, 'Neo');
    expect(card?.view).toMatchObject({
      title: 'Zigbee stopped working in Home Assistant',
      fix: 'Restart Zigbee',
    });
    expect(card?.view.ask).toBe('Ask Neo');
    expect(card?.thread).toBe('/chat?thread=msg_look-ha');
    expect(card?.tone).toBe('warn');
    expect(thingLookCard({ research: research(), status: 'offline' }, 'Neo')?.tone).toBe('bad');
  });

  it('looking: the line alone; fixed: green; none or failed: no card', () => {
    const card = thingLookCard({ research: looking(), status: 'warn' }, 'Neo');
    expect(card?.view).toMatchObject({ title: null, busy: true, ask: null, fix: null });
    expect(
      thingLookCard({ research: research({ state: 'fixed', fix: undefined }), status: 'warn' }, 'Neo')?.tone,
    ).toBe('ok');
    expect(thingLookCard({ status: 'warn' }, 'Neo')).toBeNull();
    expect(thingLookCard({ research: research({ state: 'failed' }), status: 'bad' }, 'Neo')).toBeNull();
    expect(
      thingLookCard({ research: research({ threadRootId: undefined }), status: 'bad' }, 'Neo')?.thread,
    ).toBeNull();
  });
});

describe('the assistant’s plan for a thing on the phone (handle-it.md)', () => {
  const steps = ['Add the 6 machines to a nightly backup at 02:00, keeping a week', 'Restart nginx'];
  const planned = research({
    key: 'server:pve-01',
    fix: undefined,
    plan: steps,
    threadRootId: 'msg_look-pve' as LookResearch['threadRootId'],
  });

  it('draws a plan on a page as the plan card, with Go ahead and Change something', () => {
    const card = thingLookCard({ research: planned, status: 'bad', name: 'pve-01' }, 'Neo');
    expect(card?.plan).toMatchObject({ head: 'Here’s what I’ll do on pve-01:', goAhead: 'Go ahead' });
    expect(card?.plan?.steps).toEqual(steps);
    expect(card?.planTone).toBe('bad');
    expect(card?.thread).toBe('/chat?thread=msg_look-pve');
    // One step stays the step's own button; a page without its name draws as before.
    expect(
      thingLookCard({ research: research(), status: 'warn', name: 'Home Assistant' }, 'Neo')?.plan,
    ).toBeNull();
    expect(thingLookCard({ research: planned, status: 'warn' }, 'Neo')?.plan).toBeNull();
  });

  it('draws the thread’s card from the plan, and a line once it is no longer needed', () => {
    const view = {
      name: 'pve-01',
      state: 'waiting' as const,
      steps,
      title: 'pve-01 isn’t backed up',
      summary: null,
      research: planned,
      at: AT,
    };
    const item = lookPlanItem({ kind: 'look_plan', researchId: 'lkr_1', plan: view });
    expect(item?.view.goAhead).toBe('Go ahead');
    expect(item?.thread).toBe('/chat?thread=msg_look-pve');
    expect(lookPlanItem({ kind: 'look_plan', researchId: 'lkr_1', plan: null })).toBeNull();
    const gone = lookPlanItem({
      kind: 'look_plan',
      researchId: 'lkr_1',
      plan: { ...view, state: 'gone', research: null },
    });
    expect(gone?.view.goAhead).toBeNull();
    expect(gone?.thread).toBeNull();
  });
});
