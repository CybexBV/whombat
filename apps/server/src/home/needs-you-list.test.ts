/**
 * The one Needs you list (needs-you-list.md NYL-01…NYL-04): Needs you's and Watch's items each once, Watch's as items of
 * the same shape about their thing, research on what is about a thing, every item in its group.
 */
import type { LookResearch, NeedsYouItem, WatchItem } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { needsYouList, thingNames, watchNeedsYou } from './needs-you-list';

const AT = '2026-10-30T08:00:00.000Z';

const alert: NeedsYouItem = {
  id: 'hosts.alert:7',
  ref: { kind: 'alert', id: '7' },
  kind: 'alert',
  severity: 'bad',
  nature: 'problem',
  title: 'The disk array has failed on blackbox',
  body: 'Both parity drives dropped out.',
  at: AT,
  actions: [{ id: 'investigate', label: 'Ask Neo', style: 'primary', kind: 'investigate' }],
  subject: { kind: 'server', id: 'blackbox', name: 'blackbox' },
};

const approval: NeedsYouItem = {
  id: 'approval:3',
  ref: { kind: 'approval', id: '3' },
  kind: 'approval',
  severity: 'warn',
  title: 'Restart pve-02?',
  body: '',
  at: '2026-10-30T07:00:00.000Z',
  approvalNumber: 3,
  actions: [],
};

const watch = (over: Partial<WatchItem> & Pick<WatchItem, 'id' | 'ref' | 'source'>): WatchItem => ({
  severity: 'warn',
  title: 'Worth a look',
  body: '',
  at: AT,
  state: 'open',
  ...over,
});

const names = thingNames([
  { id: 'server:pve-02', name: 'pve-02' },
  { id: 'connection:con_ha', name: 'Home Assistant' },
]);

describe('watchNeedsYou', () => {
  it('makes a server hint an item about its server, with where it is fixed and whether it can be asked', () => {
    const item = watchNeedsYou(
      watch({
        id: 'hosts.hint:h1',
        ref: { kind: 'hint', id: 'h1' },
        source: 'server',
        serverId: 'pve-02',
        nature: 'you',
        fixable: true,
        href: '/things/server%3Apve-02?tab=guests',
      }),
      names,
    );
    expect(item).toMatchObject({
      kind: 'hint',
      subject: { kind: 'server', id: 'pve-02', name: 'pve-02' },
      href: '/things/server%3Apve-02?tab=guests',
      fixable: true,
      actions: [],
    });
    expect(item.state).toBeUndefined();
  });

  it('keeps a connection’s, a device’s and a failed run’s kind, and a quiet item’s state', () => {
    expect(
      watchNeedsYou(
        watch({ id: 'connection:con_ha', ref: { kind: 'connection', id: 'con_ha' }, source: 'connection' }),
        names,
      ),
    ).toMatchObject({
      kind: 'connection',
      subject: { kind: 'connection', id: 'con_ha', name: 'Home Assistant' },
    });
    expect(
      watchNeedsYou(
        watch({ id: 'device:con_d', ref: { kind: 'device', id: 'con_d' }, source: 'connection' }),
        names,
      ),
    ).toMatchObject({ kind: 'device', subject: { kind: 'device', id: 'con_d' } });
    const run = watchNeedsYou(
      watch({
        id: 'automation_run:r1',
        ref: { kind: 'automation_run', id: 'r1' },
        source: 'automation',
        state: 'snoozed',
        snoozedUntil: '2026-10-31T08:00:00.000Z',
      }),
      names,
    );
    expect(run).toMatchObject({
      kind: 'automation_run',
      state: 'snoozed',
      snoozedUntil: '2026-10-31T08:00:00.000Z',
    });
    expect(run.subject).toBeUndefined();
  });
});

describe('needsYouList', () => {
  const looking: LookResearch = { key: 'server:blackbox', state: 'looking', at: AT };

  it('has each item once: Needs you’s keeps its buttons and takes Watch’s place', () => {
    const list = needsYouList({
      open: [alert, approval],
      quiet: [],
      watch: [
        watch({
          id: 'hosts.alert:7',
          ref: { kind: 'alert', id: '7' },
          source: 'server',
          serverId: 'blackbox',
          href: '/things/server%3Ablackbox?tab=array',
        }),
      ],
      names,
      research: new Map(),
    });
    expect(list.map((i) => i.id)).toEqual(['hosts.alert:7', 'approval:3']);
    expect(list[0]).toMatchObject({
      actions: alert.actions,
      href: '/things/server%3Ablackbox?tab=array',
      group: 'you',
    });
  });

  it('carries the check behind a line, for Stop watching this (on-purpose.md)', () => {
    const behind = { thing: 'connection:con_ha', check: 'ha.zigbee', name: '“Zigbee stopped”' };
    const fromWatch = needsYouList({
      open: [],
      quiet: [],
      watch: [
        watch({
          id: 'connection:con_ha',
          ref: { kind: 'connection', id: 'con_ha' },
          source: 'connection',
          watch: behind,
        }),
      ],
      names,
      research: new Map(),
    });
    expect(fromWatch[0]?.watch).toEqual(behind);
    // Needs you's own item takes Watch's when it has none.
    const merged = needsYouList({
      open: [alert],
      quiet: [],
      watch: [
        watch({
          id: 'hosts.alert:7',
          ref: { kind: 'alert', id: '7' },
          source: 'server',
          watch: { ...behind, thing: 'server:blackbox', check: 'host.array' },
        }),
      ],
      names,
      research: new Map(),
    });
    expect(merged[0]?.watch).toMatchObject({ thing: 'server:blackbox', check: 'host.array' });
  });

  it('puts every item in its group by what the assistant does about it', () => {
    const list = needsYouList({
      open: [alert, approval],
      quiet: [{ ...approval, id: 'approval:4', ref: { kind: 'approval', id: '4' }, state: 'snoozed' }],
      watch: [
        watch({
          id: 'hosts.hint:fyi',
          ref: { kind: 'hint', id: 'fyi' },
          source: 'server',
          serverId: 'pve-02',
          nature: 'fyi',
          severity: 'info',
        }),
      ],
      names,
      research: new Map([['server:blackbox', looking]]),
    });
    const group = Object.fromEntries(list.map((i) => [i.id, i.group]));
    expect(group).toEqual({
      'hosts.alert:7': 'assistant',
      'approval:3': 'you',
      'approval:4': 'quiet',
      'hosts.hint:fyi': 'fyi',
    });
    expect(list.find((i) => i.id === 'hosts.alert:7')?.research).toEqual(looking);
  });

  it('never gives an ask the research of a thing', () => {
    const list = needsYouList({
      open: [{ ...approval, subject: { kind: 'server', id: 'blackbox', name: 'blackbox' } }],
      quiet: [],
      watch: [],
      names,
      research: new Map([['server:blackbox', looking]]),
    });
    expect(list[0]?.research).toBeUndefined();
    expect(list[0]?.group).toBe('you');
  });
});
