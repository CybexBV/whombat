/** The bar's tabs, the Inbox on the phone (mock 4, one-whombat-mobile.md AP-1350…) and where a connection's row goes. */

import { needsYouListRow, needsYouListView } from '@whombat/client';
import { type NeedsYouItem, type ThingSummary, thingHref } from '@whombat/core';
import { at } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { serviceRowOpens } from './home';
import {
  groupHeading,
  needsYouTabBadge,
  phoneRowActions,
  phoneRowInline,
  phoneRowOpens,
  phoneRowSwipe,
  phoneSheet,
  swipeEdgeLabel,
} from './needsYou';
import { HOME_TAB, INBOX_TAB, knownTab, TAB_WORDS, TABS } from './shell';

const restart: NeedsYouItem = {
  id: 'approval:31',
  ref: { kind: 'approval', id: '31' },
  kind: 'approval',
  severity: 'warn',
  title: 'Restart arnica-prod-nest-01?',
  body: 'It needs a restart to get its extra memory (4 → 8 GB). It’s down for about 40 seconds.',
  at: at('13:58'),
  actions: [
    { id: 'approve', label: 'Yes, do it', style: 'primary', kind: 'approve' },
    { id: 'later', label: 'Tonight', style: 'secondary', kind: 'approve_later', at: at('03:00', 1) },
    { id: 'decline', label: 'No', style: 'secondary', kind: 'decline' },
  ],
  subject: { kind: 'server', id: 'pve-02', name: 'pve-02' },
  approvalNumber: 31,
};

const disk: NeedsYouItem = {
  id: 'hosts.alert:al_1',
  ref: { kind: 'alert', id: 'al_1' },
  kind: 'alert',
  severity: 'bad',
  title: 'blackbox’s disk array failed',
  body: 'Your files have no protection now',
  at: at('13:52'),
  actions: [
    { id: 'investigate', label: 'Ask Dusty', style: 'primary', kind: 'investigate' },
    { id: 'snooze', label: 'Remind me tomorrow', style: 'secondary', kind: 'snooze' },
  ],
  nature: 'problem',
  subject: { kind: 'server', id: 'blackbox', name: 'blackbox' },
};

const heat: NeedsYouItem = {
  id: 'device_skill:dvp_1',
  ref: { kind: 'device_skill', id: 'dvp_1' },
  kind: 'device_skill',
  severity: 'info',
  title: 'Heat pump: what may I change?',
  body: 'It reads fine already',
  at: at('13:41'),
  actions: [{ id: 'open', label: 'Choose', style: 'primary', kind: 'open', href: '/chats/cnv_heat' }],
};

describe('the phone’s one layout (one-layout-android.md AP-2640)', () => {
  it('has Chat, Inbox, Automations and Settings, and opens on Chat', () => {
    // Needs you replaces Watch (needs-you-list.md NYL-05); Settings ends the bar (settings-tab-android.md AP-2620).
    // Servers and Connections are places, not tabs.
    expect(TABS).toEqual(['ChatRoom', 'NeedsYou', 'Automations', 'Settings']);
    expect(TABS.map((t) => TAB_WORDS[t])).toEqual(['Chat', 'Inbox', 'Automations', 'Settings']);
    expect(HOME_TAB).toBe('ChatRoom');
    // “The inbox” of a link or a push that names no item is the Inbox (NYL-09).
    expect(INBOX_TAB).toBe('NeedsYou');
  });

  it('restores Chat for a tab that is gone, such as the Overview', () => {
    expect(knownTab('Dashboard')).toBe('ChatRoom');
    expect(knownTab(null)).toBe('ChatRoom');
    expect(knownTab('Automations')).toBe('Automations');
  });
});

describe('the Inbox tab (inbox.md; needs-you-list.md NYL-01…NYL-09)', () => {
  const opts = { now: Date.parse(at('14:05')), timeZone: 'Europe/Amsterdam', assistant: 'Dusty' };
  const row = (item: NeedsYouItem) => needsYouListRow(item, opts);

  it('opens a sheet for what needs the person, the thread for what the assistant is on, the place of a heads-up', () => {
    expect(phoneRowOpens(row(restart))).toEqual({ to: 'sheet' });
    const looking = {
      ...disk,
      group: 'assistant' as const,
      research: {
        key: 'server:blackbox',
        state: 'looking' as const,
        threadRootId: 'msg_look',
        at: at('13:55'),
      },
    } as NeedsYouItem;
    expect(phoneRowOpens(row(looking))).toEqual({ to: 'href', href: '/chat?thread=msg_look' });
    const fyi = { ...disk, nature: 'fyi', group: 'fyi', href: '/things/server%3Ablackbox' } as NeedsYouItem;
    expect(phoneRowOpens(row(fyi))).toEqual({ to: 'href', href: '/things/server%3Ablackbox' });
  });

  it('makes the sheet: the group and thing as its badge, every button stacked in the shared words', () => {
    const sheet = phoneSheet(row(restart), { Name: 'Dusty' });
    expect(sheet.badge).toBe('Needs you · pve-02');
    // An approval is answered, never settled: its three, equal while tonight is on offer, then Talk to Dusty about it
    // as quiet words beside the others.
    expect(sheet.linksInRow).toBe(true);
    expect(sheet.buttons.map((b) => [b.label, b.variant])).toEqual([
      ['Yes, now', 'secondary'],
      ['Yes, tonight', 'secondary'],
      ['No', 'secondary'],
      ['Talk to Dusty about it', 'quiet'],
    ]);
    // A problem nobody looks at: hand it over, Settle, then More's.
    expect(phoneSheet(row(disk), { Name: 'Dusty' }).buttons.map((b) => b.button.kind)).toEqual([
      'handle',
      'settle',
      'talk',
      'snooze',
    ]);
    expect(phoneSheet(row(heat), { Name: 'Dusty' }).badge).toBe('Needs you');
    const settled = { ...disk, group: 'quiet', state: 'acknowledged' } as NeedsYouItem;
    expect(phoneSheet(row(settled), { Name: 'Dusty' })).toMatchObject({
      badge: 'Settled · blackbox',
      tone: 'mut',
      note: null,
      buttons: [{ label: 'Bring it back' }, { button: { kind: 'talk' } }],
    });
  });

  it('shows an approval’s answers and a line’s one way forward under the row, the rest in More', () => {
    const answers = phoneRowInline(row(restart));
    expect(answers?.answers.map((b) => b.label)).toEqual(['Yes, now', 'Yes, tonight', 'No']);
    expect(answers?.lead).toBeNull();
    const line = phoneRowInline(row(disk));
    expect(line?.lead?.kind).toBe('handle');
    expect(line?.more.map((b) => b.kind)).toEqual(['settle', 'talk', 'snooze']);
    // An approval's sheet carries its card's facts: no key named by the Inbox item, the exact later time.
    const sheet = phoneSheet(
      row(restart),
      { Name: 'Dusty' },
      { now: Date.parse(at('14:05')), timeZone: 'Europe/Amsterdam' },
    );
    expect(sheet.approval?.permission).toBe('Not supplied in this request');
    expect(sheet.approval?.tonight?.at).toMatch(/2026 at 03:00 · /);
    // Settled with nothing in it shows no zero.
    expect(groupHeading({ label: 'Settled', rows: [] })).toBe('Settled');
    // The 1Password guard's two answers both show under its row, equal, like an approval's.
    const gone: NeedsYouItem = {
      id: 'connection:con_1p',
      ref: { kind: 'connection', id: 'con_1p' },
      kind: 'connection',
      severity: 'warn',
      nature: 'you',
      group: 'you',
      title: '1Password says 4 items are gone',
      body: '',
      at: at('09:00'),
      actions: [
        {
          id: 'remove',
          label: 'Remove them here too',
          style: 'secondary',
          kind: 'onepassword_removals',
          removals: { answer: 'remove', token: 't1' },
        },
        {
          id: 'keep',
          label: 'Keep them here',
          style: 'primary',
          kind: 'onepassword_removals',
          removals: { answer: 'keep', token: 't1' },
        },
      ],
    };
    const guard = phoneRowInline(row(gone));
    expect(guard?.answers.map((b) => b.label)).toEqual(['Remove them here too', 'Keep them here']);
    expect(guard?.lead).toBeNull();
    expect(guard?.more.map((b) => b.kind)).toEqual(['settle', 'talk', 'snooze']);
  });

  it('swipes left to Settle (or Bring back) with More beside it; Dusty’s rows only More', () => {
    expect(phoneRowSwipe(row(disk))).toMatchObject({
      edge: { kind: 'settle' },
      more: [{ kind: 'talk' }, { kind: 'snooze' }],
    });
    const edge = phoneRowSwipe(row(disk))?.edge;
    if (edge) expect(swipeEdgeLabel(edge)).toBe('Settle');
    // An approval waits on the answer: no Settle.
    expect(phoneRowSwipe(row(restart))).toMatchObject({ edge: null, more: [{ kind: 'talk' }] });
    const settled = row({ ...disk, group: 'quiet', state: 'acknowledged' } as NeedsYouItem);
    const back = phoneRowSwipe(settled)?.edge;
    expect(back?.kind).toBe('back');
    if (back) expect(swipeEdgeLabel(back)).toBe('Bring back');
    const looking = row({
      ...disk,
      group: 'assistant',
      research: { key: 'server:blackbox', state: 'looking', threadRootId: 'msg_look', at: at('13:55') },
    } as NeedsYouItem);
    expect(phoneRowSwipe(looking)).toMatchObject({ edge: null, more: [{ kind: 'talk' }] });
    // A screen reader gets the same as the row's actions, by the button's id.
    expect(phoneRowActions(row(disk)).map((a) => a.name)).toEqual(['settle', 'talk', 'snooze']);
  });

  it('badges the tab with the one count: amber, red only when something isn’t working', () => {
    const overview = {
      summary: { needsYou: 2, working: 0, problems: 0 },
      needsYou: [],
      needsYouList: [
        { ...disk, group: 'you' as const },
        { ...restart, group: 'you' as const },
        { ...heat, group: 'fyi' as const },
      ],
    };
    expect(needsYouTabBadge(overview)).toEqual({ count: 2, tone: 'bad' });
    expect(needsYouListView(overview, opts).count).toBe(2);
    expect(needsYouTabBadge(undefined)).toEqual({ count: 0, tone: null });
    // An ask alone is amber: red only when something isn't working.
    expect(
      needsYouTabBadge({
        ...overview,
        summary: { ...overview.summary, needsYou: 1 },
        needsYouList: [restart],
      }),
    ).toEqual({ count: 1, tone: 'warn' });
  });
});

describe('where a connection’s tile goes (AP-2814)', () => {
  const thing = (over: Partial<ThingSummary> & Pick<ThingSummary, 'id' | 'name'>): ThingSummary => ({
    kind: 'connection',
    icon: 'plug',
    status: 'ok',
    facts: [],
    href: thingHref('connection', over.id.split(':')[1] ?? over.id),
    ...over,
  });

  it('sends a mail account’s tile where its href says: the server has no page for it', () => {
    // The server's Google mail glance: a builtin entry's connection, linked to Settings → Connections.
    const gmail = thing({
      id: 'connection:con_g',
      name: 'Mail',
      catalogId: 'google',
      href: '/settings/connections',
    });
    expect(serviceRowOpens(gmail)).toBe('/settings/connections');
    // A builtin entry whose href is a thing's page after all, a catalog connection, a device, an entry this phone
    // doesn't know (a newer server's) and a server open their page.
    expect(serviceRowOpens({ ...gmail, href: '/burrow-hq/things/connection%3Acon_g' })).toBeNull();
    expect(serviceRowOpens({ ...gmail, catalogId: 'homeassistant' })).toBeNull();
    expect(serviceRowOpens({ ...gmail, kind: 'device', catalogId: 'device' })).toBeNull();
    expect(serviceRowOpens({ ...gmail, catalogId: 'not_yet_known' })).toBeNull();
    expect(serviceRowOpens({ ...gmail, kind: 'server', catalogId: undefined })).toBeNull();
  });
});
