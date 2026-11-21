/**
 * The Inbox (Whombat inbox.md IBX-01…; needs-you-list.md NYL-01…NYL-09): the groups in order with the one count, each
 * row's buttons in the shared words — its way forward, Settle, and More — and what they do.
 */
import type { LookResearch, NeedsYouItem } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  askText,
  inboxGroupOf,
  needsYouApprovalCard,
  needsYouListIntent,
  needsYouListView,
  needsYouMore,
  needsYouRowById,
  needsYouSwipe,
  withNeedsYouListItem,
} from './needsYouList';

const NOW = Date.parse('2026-10-30T10:00:00.000Z');
const TZ = 'Europe/Amsterdam';
const AT = '2026-10-30T08:00:00.000Z';

const base = (over: Partial<NeedsYouItem> & Pick<NeedsYouItem, 'id' | 'kind'>): NeedsYouItem => ({
  ref: { kind: over.kind, id: over.id },
  severity: 'warn',
  title: 'Worth a look',
  body: '',
  at: AT,
  actions: [],
  ...over,
});

const research = (state: LookResearch['state'], extra: Partial<LookResearch> = {}): LookResearch => ({
  key: 'server:pve-02',
  state,
  at: AT,
  threadRootId: 'msg_look',
  ...extra,
});

const pve = { kind: 'server' as const, id: 'pve-02', name: 'pve-02' };

const approval = base({
  id: 'approval:3',
  kind: 'approval',
  title: 'Restart pve-02?',
  approvalNumber: 3,
  group: 'you',
  actions: [
    { id: 'approve', label: 'Yes, do it', style: 'primary', kind: 'approve' },
    { id: 'later', label: 'Tonight', style: 'secondary', kind: 'approve_later', at: AT },
    { id: 'decline', label: 'No', style: 'secondary', kind: 'decline' },
  ],
});
const unlooked = base({
  id: 'hosts.alert:1',
  kind: 'alert',
  severity: 'bad',
  nature: 'problem',
  title: 'Disk 1 is 89 % full',
  subject: pve,
  group: 'you',
  actions: [{ id: 'investigate', label: 'Ask Neo', style: 'primary', kind: 'investigate' }],
});
const backup = base({
  id: 'hosts.hint:b',
  kind: 'hint',
  nature: 'you',
  fixable: true,
  title: '3 guests have no backup job',
  body: 'web-01, db-01 and mail.',
  subject: pve,
  group: 'you',
  href: '/things/server%3Apve-02?tab=guests',
});
const found = base({
  id: 'connection:con_ha',
  kind: 'connection',
  nature: 'problem',
  title: 'Home Assistant isn’t answering',
  subject: { kind: 'connection', id: 'con_ha', name: 'Home Assistant' },
  research: research('found', {
    key: 'connection:con_ha',
    title: 'Zigbee stopped',
    summary: 'The stick dropped out.',
    fix: 'Restart Zigbee',
  }),
  group: 'you',
});
const looking = base({
  id: 'hosts.alert:2',
  kind: 'alert',
  severity: 'bad',
  nature: 'problem',
  title: 'pve-02 is running hot',
  subject: pve,
  research: research('looking'),
  group: 'assistant',
});
const fyi = base({ id: 'hosts.hint:u', kind: 'hint', nature: 'fyi', severity: 'info', group: 'fyi' });
const quiet = base({
  id: 'hosts.hint:q',
  kind: 'hint',
  nature: 'you',
  group: 'quiet',
  state: 'snoozed',
  snoozedUntil: '2026-10-31T08:00:00.000Z',
});

const settled = base({
  id: 'hosts.hint:s',
  kind: 'hint',
  nature: 'you',
  group: 'quiet',
  state: 'acknowledged',
});

const list = [unlooked, looking, approval, backup, found, fyi, quiet, settled];
const view = (items: NeedsYouItem[] = list) =>
  needsYouListView({ needsYou: [], needsYouList: items }, { now: NOW, timeZone: TZ, assistant: 'Neo' });

describe('needsYouListView', () => {
  it('draws the groups in order, heads-ups and Settled folded, and counts only the first', () => {
    const v = view();
    expect(v.groups.map((g) => [g.key, g.label, g.rows.length, g.folded])).toEqual([
      ['you', 'Needs you', 4, false],
      ['assistant', 'Neo’s on it', 1, false],
      ['fyi', 'Heads-ups', 1, true],
      ['later', 'Later', 1, false],
      ['settled', 'Settled', 1, true],
    ]);
    expect(v.groups.find((g) => g.key === 'settled')?.fold?.show).toContain('1');
    expect(v.count).toBe(4);
    expect(v.empty).toBe(false);
  });

  it('draws an approval row as the approval card: where, what happens, no key named, the exact later time', () => {
    const row = needsYouRowById(view(), 'approval:3');
    const card = row && needsYouApprovalCard(row, { timeZone: TZ, assistant: 'neo' });
    expect(card?.status).toContain('Neo');
    expect(card?.permission).toBe('Not supplied in this request');
    expect(card?.tonight?.at).toBe('Friday, 30 October 2026 at 09:00 · Europe/Amsterdam');
    const unknownRow = needsYouRowById(view(), 'hosts.alert:1');
    expect(unknownRow && needsYouApprovalCard(unknownRow, { timeZone: TZ, assistant: 'neo' })).toBeNull();
  });

  it('gives each row its way forward, the rest in More', () => {
    const v = view();
    const kinds = (id: string) => needsYouRowById(v, id)?.buttons.map((b) => b.kind);
    const more = (id: string) =>
      needsYouRowById(v, id)
        ?.buttons.filter((b) => b.more)
        .map((b) => b.kind);
    // An approval is answered, never settled; More only offers to talk it over.
    expect(kinds('approval:3')).toEqual(['action', 'action', 'action', 'talk']);
    // A problem nobody looks at: hand it to the assistant, Settle; talk, remind and the server's Look into it gone.
    expect(kinds('hosts.alert:1')).toEqual(['handle', 'settle', 'talk', 'snooze']);
    expect(needsYouRowById(v, 'hosts.alert:1')?.buttons[0]).toMatchObject({ label: 'Ask Neo to handle it' });
    // A line that needs the person shows one way forward: Settle and the rest are in its More.
    expect(more('hosts.alert:1')).toEqual(['settle', 'talk', 'snooze']);
    expect(more('connection:con_ha')).toEqual(['settle', 'talk', 'snooze']);
    expect(kinds('hosts.hint:b')?.[0]).toBe('askFix');
    // One verb for every problem, whether the assistant looks into it or fixes what only the person could.
    expect(needsYouRowById(v, 'hosts.hint:b')?.buttons[0]?.label).toBe('Ask Neo to handle it');
    // A finding: its step first, then Settle; talking it over opens its thread.
    expect(kinds('connection:con_ha')).toEqual(['fix', 'settle', 'talk', 'snooze']);
    // The assistant's: only More. A heads-up settles, and can be handed over.
    expect(kinds('hosts.alert:2')).toEqual(['talk']);
    expect(kinds('hosts.hint:u')).toEqual(['settle', 'handle', 'talk', 'snooze']);
    expect(kinds('hosts.hint:q')).toEqual(['back', 'talk']);
    expect(kinds('hosts.hint:s')).toEqual(['back', 'talk']);
  });

  it('answers an approval in the one order and words, whatever the server called them', () => {
    const labels = (item: NeedsYouItem) =>
      needsYouListView({ needsYou: [], needsYouList: [item] }, { now: NOW, timeZone: TZ, assistant: 'Neo' })
        .groups[0]?.rows[0]?.buttons.filter((b) => b.kind === 'action')
        .map((b) => [b.label, b.look]);
    expect(labels({ ...approval, actions: [...approval.actions].reverse() })).toEqual([
      ['Yes, now', 'primary'],
      ['Yes, tonight', 'secondary'],
      ['No', 'secondary'],
    ]);
    const noLater = { ...approval, actions: approval.actions.filter((a) => a.kind !== 'approve_later') };
    expect(labels(noLater)?.map(([label]) => label)).toEqual(['Yes, do it', 'No']);
  });

  it('makes an older Whombat’s “Not now” on an approval the quiet Remind me tomorrow, not an answer', () => {
    const buttons = (item: NeedsYouItem) =>
      needsYouListView(
        { needsYou: [], needsYouList: [item] },
        { now: NOW, timeZone: TZ, assistant: 'Neo' },
      ).groups[0]?.rows[0]?.buttons.map((b) => [b.kind, b.look]);
    const notNow = {
      ...approval,
      actions: [
        ...approval.actions,
        { id: 'snooze', label: 'Not now', style: 'secondary' as const, kind: 'snooze' as const },
      ],
    };
    expect(buttons(notNow)).toEqual([
      ['action', 'primary'],
      ['action', 'secondary'],
      ['action', 'secondary'],
      ['talk', 'quiet'],
      ['snooze', 'quiet'],
    ]);
    expect(buttons(approval)?.map(([kind]) => kind)).not.toContain('snooze');
  });

  it('puts what isn’t working first in Needs you, else keeps the server’s order', () => {
    const v = needsYouListView(
      { needsYou: [], needsYouList: [approval, backup, unlooked] },
      { now: NOW, timeZone: TZ, assistant: 'Neo' },
    );
    expect(v.groups[0]?.rows.map((r) => r.id)).toEqual(['hosts.alert:1', 'approval:3', 'hosts.hint:b']);
  });

  it('swipes to Settle, or to Bring it back on Later and Settled; none on the assistant’s', () => {
    const v = view();
    const swipe = (id: string) => {
      const row = needsYouRowById(v, id);
      return row ? needsYouSwipe(row)?.kind : undefined;
    };
    expect(swipe('hosts.alert:1')).toBe('settle');
    expect(swipe('approval:3')).toBeUndefined();
    expect(swipe('hosts.alert:2')).toBeUndefined();
    expect(swipe('hosts.hint:s')).toBe('back');
    const row = needsYouRowById(v, 'hosts.alert:2');
    expect(row && needsYouMore(row).map((b) => b.kind)).toEqual(['talk']);
  });

  it('says who is on it, the finding in its own words, and when a quiet one comes back', () => {
    const v = view();
    expect(needsYouRowById(v, 'hosts.alert:2')?.says?.text).toBe('Neo is looking into it');
    const finding = needsYouRowById(v, 'connection:con_ha');
    expect(finding).toMatchObject({ title: 'Zigbee stopped', body: '' });
    expect(finding?.says?.text).toBe('The stick dropped out.');
    expect(needsYouRowById(v, 'hosts.hint:q')?.state).toBe('Until tomorrow 09:00');
    expect(needsYouRowById(v, 'hosts.alert:1')?.meta).toBe('pve-02 · 09:00');
  });

  it('shows an older Whombat’s Needs you items in the first group', () => {
    const v = needsYouListView(
      { needsYou: [{ ...approval, group: undefined }] },
      { now: NOW, timeZone: TZ, assistant: 'Neo' },
    );
    expect(v.groups.map((g) => g.key)).toEqual(['you', 'settled']);
    expect(v.count).toBe(1);
  });

  it('is empty without items, Settled still there and last', () => {
    const v = view([]);
    expect(v).toMatchObject({ count: 0, empty: true });
    expect(v.groups.map((g) => [g.key, g.rows.length, g.folded])).toEqual([['settled', 0, false]]);
    expect(view([unlooked, quiet]).groups.at(-1)?.key).toBe('settled');
  });
});

describe('Stop watching this (on-purpose.md)', () => {
  const watch = { thing: 'connection:con_plex', check: 'plex.remote', name: '“Plex can’t be reached”' };
  const plex = base({
    id: 'connection:con_plex',
    kind: 'connection',
    nature: 'problem',
    title: 'Plex can’t be reached from outside your network',
    subject: { kind: 'connection', id: 'con_plex', name: 'Plex' },
    group: 'you',
    watch,
  });
  const buttonsOf = (items: NeedsYouItem[]) =>
    view(items).groups.flatMap((g) => g.rows.map((r) => ({ group: g.key, buttons: r.buttons })));

  it('sits in More of a line with a check behind it, found or not, and of a settled one', () => {
    const rows = buttonsOf([
      plex,
      { ...plex, id: 'connection:con_plex2', research: found.research },
      { ...plex, id: 'connection:con_plex3', group: 'quiet', state: 'acknowledged' },
    ]);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const stop = row.buttons.find((b) => b.kind === 'stop');
      expect(stop, row.group).toMatchObject({ label: 'Stop watching this', more: true });
    }
  });

  it('names the item when it is about one, and is absent without a check', () => {
    const item = { ...plex, watch: { ...watch, subject: { id: 'dev:1', name: 'Garage AP' } } };
    expect(buttonsOf([item])[0]?.buttons.find((b) => b.kind === 'stop')?.label).toContain('Garage AP');
    expect(buttonsOf([unlooked])[0]?.buttons.some((b) => b.kind === 'stop')).toBe(false);
  });

  it('switches off the check behind the row', () => {
    expect(needsYouListIntent(plex, { kind: 'stop' }, NOW, TZ)).toEqual({ type: 'stop', watch });
    expect(needsYouListIntent(unlooked, { kind: 'stop' }, NOW, TZ)).toBeNull();
  });
});

describe('needsYouListIntent', () => {
  it('hands a thing to the assistant, talks in its thread once it found out, else in a new one', () => {
    expect(needsYouListIntent(unlooked, { kind: 'handle' }, NOW, TZ)).toEqual({
      type: 'handle',
      key: 'server:pve-02',
      text: 'pve-02: Disk 1 is 89 % full\nCan you look into it?',
      subject: pve,
    });
    expect(
      needsYouListIntent({ ...unlooked, subject: undefined }, { kind: 'handle' }, NOW, TZ),
    ).toMatchObject({
      type: 'ask',
      subject: null,
    });
    expect(needsYouListIntent(found, { kind: 'talk' }, NOW, TZ)).toEqual({
      type: 'open',
      href: '/chat?thread=msg_look',
    });
    expect(needsYouListIntent(unlooked, { kind: 'talk' }, NOW, TZ)).toEqual({
      type: 'talk',
      ref: unlooked.ref,
    });
    expect(needsYouListIntent(unlooked, { kind: 'settle' }, NOW, TZ)).toEqual({
      type: 'settle',
      ref: unlooked.ref,
    });
    expect(needsYouListIntent(backup, { kind: 'askFix' }, NOW, TZ)).toMatchObject({
      type: 'ask',
      text: expect.stringContaining('Can you fix it?'),
    });
  });

  it('reminds tomorrow at 09:00, ignores and brings back by the item’s ref', () => {
    expect(needsYouListIntent(unlooked, { kind: 'snooze' }, NOW, TZ)).toEqual({
      type: 'snooze',
      ref: unlooked.ref,
      until: '2026-10-31T08:00:00.000Z',
    });
    expect(needsYouListIntent(quiet, { kind: 'back' }, NOW, TZ)).toEqual({ type: 'back', ref: quiet.ref });
  });

  it('sends the person’s yes to a proposal as their own words, and opens where else it is done', () => {
    const proposal = base({
      id: 'backup:this-whombat',
      kind: 'backup',
      title: 'Back up this Whombat to nas-01 every night?',
      group: 'you',
      actions: [
        {
          id: 'yes',
          label: 'Yes, do it',
          style: 'primary',
          kind: 'ask',
          text: 'Yes, back up this Whombat to nas-01 every night.',
        },
        { id: 'places', label: 'See other places', style: 'secondary', kind: 'open', href: '/settings' },
      ],
    });
    const row = view([proposal]).groups[0]?.rows[0];
    expect(row?.buttons.map((b) => b.kind)).toEqual(['action', 'action', 'settle', 'talk', 'snooze']);
    const [yes] = row?.buttons ?? [];
    expect(yes && needsYouListIntent(proposal, yes, NOW, TZ)).toEqual({
      type: 'ask',
      text: 'Yes, back up this Whombat to nas-01 every night.',
      subject: null,
    });
  });

  it('names the thing in a new thread’s title only when the title doesn’t', () => {
    expect(askText({ title: 'pve-02 is running hot', subject: pve }).split('\n')[0]).toBe(
      'pve-02 is running hot',
    );
  });
});

describe('withNeedsYouListItem', () => {
  it('moves a settled item to Settled, a snoozed one to Later, and takes a decided one out, the count following', () => {
    const overview = {
      needsYou: [approval],
      needsYouList: list,
      summary: { needsYou: 4, working: 0, problems: 0 },
    };
    const quieted = withNeedsYouListItem(overview, unlooked.ref, 'quiet');
    expect(quieted.needsYouList?.find((i) => i.id === unlooked.id)?.group).toBe('quiet');
    expect(quieted.summary.needsYou).toBe(3);
    const snoozed = withNeedsYouListItem(overview, unlooked.ref, 'snoozed', '2026-10-31T08:00:00.000Z');
    const later = snoozed.needsYouList?.find((i) => i.id === unlooked.id);
    expect(later && inboxGroupOf(later)).toBe('later');
    const settledNow = quieted.needsYouList?.find((i) => i.id === unlooked.id);
    expect(settledNow && inboxGroupOf(settledNow)).toBe('settled');
    const decided = withNeedsYouListItem(overview, approval.ref, 'gone');
    expect(decided.needsYouList?.some((i) => i.id === approval.id)).toBe(false);
    expect(decided.needsYou).toEqual([]);
    expect(decided.summary.needsYou).toBe(3);
  });
});
