import { type HostAlert, type HostHint, type HostServer, hostHintCheck } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { NoticeQuietRow, WatchOffRow, WatchOnRow } from '../db/schema/index';
import { applyQuiet, FIXED_PASSES } from '../things/quiet/apply';
import type { ThingQuiet } from '../things/quiet/store';
import { toHostAlert, toHostHint, toHostServer } from './map';
import {
  alertLine,
  alertQuiet,
  hintEpisode,
  hintLine,
  hubBy,
  keepVerdict,
  markHints,
  serverNotice,
  serverVerdict,
} from './quiet-lines';
import { serverThing } from './sources';

const NOW = new Date('2026-10-22T10:00:00Z');

const alert = (over: Partial<HostAlert> = {}): HostAlert => ({
  id: 'al_1',
  serverId: 'pve-01',
  severity: 'warning',
  title: '/srv 91% full',
  detail: '910 GB of 1 TB used',
  openedAt: '2026-10-22T09:00:00Z',
  rule: 'disk.space_high',
  state: 'open',
  attention: true,
  entity: 'fs:/srv',
  key: 'disk.space_high:fs:/srv',
  ...over,
});

const hint = (over: Partial<HostHint> = {}): HostHint => ({
  serverId: 'pve-01',
  kind: 'guests.unhealthy',
  severity: 'warning',
  entity: 'docker',
  title: '2 containers unhealthy',
  detail: 'web (unhealthy), db (unhealthy)',
  section: 'guests',
  id: 'guests.unhealthy:docker',
  ...over,
});

const row = (over: Partial<NoticeQuietRow>): NoticeQuietRow => ({
  ownerId: 'burrow-hq',
  thingId: 'server:pve-01',
  checkId: 'host.hint.guests.unhealthy',
  subject: '',
  state: 'ignored',
  lifts: 'newer',
  episode: null,
  tone: 'warn',
  band: null,
  until: null,
  clearPasses: 0,
  title: '2 containers unhealthy',
  subjectName: null,
  words: 'Until another one fails.',
  byId: 'prn_mara',
  at: NOW,
  ...over,
});

const quiet = (
  quiets: NoticeQuietRow[] = [],
  offs: WatchOffRow[] = [],
  ons: WatchOnRow[] = [],
): ThingQuiet => ({ quiets, offs, ons });

describe('a server’s lines (QN-03, QN-S50)', () => {
  it('names an alert’s check and item as the web client keys them', () => {
    const line = alertLine(alert());
    expect(line).toMatchObject({
      check: 'host.disk.space_high',
      subject: { id: 'fs:/srv', name: '/srv' },
      tone: 'warn',
      nature: 'problem',
      ignore: { lifts: 'fixed' },
    });
    // About the server as a whole: no item.
    expect(alertLine(alert({ rule: 'agent.heartbeat_missing', entity: 'host' })).subject).toBeUndefined();
    // A rule this version doesn't know is its own check, a problem.
    expect(alertLine(alert({ rule: 'gpu.melting', entity: 'gpu:0' }))).toMatchObject({
      check: 'host.gpu.melting',
      nature: 'problem',
    });
  });

  it('keys a hint by its kind and entity, its id when the entity is missing', () => {
    expect(hintLine(hint({ kind: 'disk.space', entity: 'fs:/srv', severity: 'info' }))).toMatchObject({
      check: 'host.hint.disk.space',
      subject: { id: 'fs:/srv' },
      tone: 'info',
      nature: 'fyi',
    });
    expect(hintLine(hint({ kind: 'disk.space', entity: '', id: 'disk.space:fs:/data' })).subject?.id).toBe(
      'fs:/data',
    );
    // A pool at 95 % is a problem, at 80 % a heads-up.
    expect(
      hintLine(hint({ kind: 'incus.pool_full', entity: 'incus-pool:p', severity: 'warning' })).nature,
    ).toBe('problem');
    expect(hintLine(hint({ kind: 'incus.pool_full', entity: 'incus-pool:p', severity: 'info' })).nature).toBe(
      'fyi',
    );
  });

  it('compares the set of items, a count, or the words for “until something newer” (QN-S52)', () => {
    const lists = hintLine(hint());
    const same = hintLine(hint({ detail: 'db (unhealthy), web (unhealthy)' }));
    const other = hintLine(hint({ detail: 'web (unhealthy), cache (unhealthy)' }));
    expect(lists.episode).toBe(same.episode);
    expect(lists.episode).not.toBe(other.episode);
    // The hub's guest ids win over the names.
    const unhealthy = hostHintCheck('guests.unhealthy');
    expect(hintEpisode(unhealthy, hint(), ['docker:a'])).not.toEqual(
      hintEpisode(unhealthy, hint(), ['docker:b']),
    );
    expect(
      hintLine(hint({ kind: 'system.updates', entity: 'host', title: '12 updates waiting' })),
    ).toMatchObject({
      band: 12,
    });
    // One until it is fixed compares nothing.
    expect(hintLine(hint({ kind: 'memory.low', entity: 'host' })).episode).toBeUndefined();
  });
});

describe('what is quiet (QN-14, QN-23)', () => {
  const names = new Map([['prn_mara', 'Mara']]);
  const untilWords = () => 'until tomorrow 09:00';

  it('reads the hosts service’s acknowledgement as Ignore or Remind me tomorrow, by the person', () => {
    expect(hubBy('Mara Jansen (prn_mara)')).toEqual({ id: 'prn_mara', name: 'Mara Jansen' });
    expect(hubBy('notification link')).toBeNull();
    const ignored = alertQuiet(
      alert({
        attention: false,
        acknowledged: { at: NOW.toISOString(), by: 'Mara (prn_mara)', note: '', until: null },
      }),
      { now: NOW, names, untilWords },
    );
    expect(ignored).toMatchObject({
      state: 'ignored',
      words: 'until there’s room again',
      by: { id: 'prn_mara' },
    });
    const snoozed = alertQuiet(
      alert({
        attention: false,
        acknowledged: { at: NOW.toISOString(), by: 'admin', note: '', until: '2026-10-23T07:00:00Z' },
      }),
      { now: NOW, names, untilWords },
    );
    expect(snoozed).toMatchObject({ state: 'snoozed', words: 'until tomorrow 09:00' });
    expect(snoozed?.by).toBeUndefined();
    expect(alertQuiet(alert({ attention: false, muted: true }), { now: NOW, names, untilWords })?.state).toBe(
      'ignored',
    );
    expect(alertQuiet(alert(), { now: NOW, names, untilWords })).toBeUndefined();
  });

  it('marks quiet hints and leaves out those nobody watches', () => {
    const h = hint();
    const episode = hintLine(h).episode ?? null;
    const marked = markHints(
      [h, hint({ kind: 'system.failed_units', entity: 'host', id: 'system.failed_units:host' })],
      quiet(
        [row({ episode })],
        [
          {
            ownerId: 'burrow-hq',
            thingId: 'server:pve-01',
            checkId: 'host.hint.system.failed_units',
            subject: '',
            subjectName: null,
            byId: 'prn_mara',
            at: NOW,
          },
        ],
      ),
      NOW,
    );
    expect(marked.hints).toHaveLength(1);
    expect(marked.hints[0]?.row?.state).toBe('ignored');
    expect(marked.dropped.map((d) => d.kind)).toEqual(['system.failed_units']);
    // Another one failing ends it.
    const another = markHints(
      [hint({ detail: 'web (unhealthy), cache (unhealthy)' })],
      quiet([row({ episode })]),
      NOW,
    );
    expect(another.hints[0]?.row).toBeNull();
  });

  it('leaves out hints that start off until someone turns them on (watch-defaults.md)', () => {
    const updates = hint({
      kind: 'system.updates',
      severity: 'info',
      entity: 'host',
      title: '12 updates waiting',
      id: 'system.updates:host',
    });
    const off = markHints([hint(), updates], quiet(), NOW);
    expect(off.hints.map((h) => h.hint.kind)).toEqual(['guests.unhealthy']);
    expect(off.dropped.map((d) => d.kind)).toEqual(['system.updates']);
    const turnedOn = quiet(
      [],
      [],
      [
        {
          ownerId: 'burrow-hq',
          thingId: 'server:pve-01',
          checkId: 'host.hint.system.updates',
          byId: null,
          at: NOW,
        },
      ],
    );
    expect(markHints([hint(), updates], turnedOn, NOW).hints).toHaveLength(2);
    // A hint kind this version doesn't know starts off too.
    expect(
      markHints([hint({ kind: 'some.new_kind', id: 'some.new_kind:docker' })], quiet(), NOW).hints,
    ).toEqual([]);
  });

  it('ends an Ignore until fixed once enough passes went without its line (QN-11, QN-S56)', () => {
    const r = row({ checkId: 'host.hint.memory.low', lifts: 'fixed' });
    const first = applyQuiet({ lines: [], quiets: [r], offs: [], states: [], now: NOW, pass: true });
    expect(first.cleared[0]?.clearPasses).toBe(1);
    expect(first.lift).toHaveLength(0);
    const second = applyQuiet({
      lines: [],
      quiets: [{ ...r, clearPasses: FIXED_PASSES - 1 }],
      offs: [],
      states: [],
      now: NOW,
      pass: true,
    });
    expect(second.lift).toHaveLength(1);
    // An offline server's hints weren't read: nothing counts.
    const offline = applyQuiet({
      lines: [],
      quiets: [r],
      offs: [],
      states: [],
      now: NOW,
      pass: true,
      skipped: ['*'],
    });
    expect(offline.cleared).toHaveLength(0);
  });
});

describe('what a server comes to (QN-02, QN-23, QN-S51)', () => {
  const card = { id: 'pve-01', status: 'warning', statusNote: 'disk space' };

  it('counts alerts that ask for attention and aren’t heads-ups, and warnings nobody quieted', () => {
    expect(serverVerdict({ card, pending: false, alerts: [alert()], now: NOW })).toMatchObject({
      status: 'warn',
      note: 'disk space',
      dot: true,
    });
    // Acknowledged: fine, whatever the hub's status said.
    expect(
      serverVerdict({ card, pending: false, alerts: [alert({ attention: false })], now: NOW }),
    ).toMatchObject({ status: 'ok', note: null, dot: false });
    // A heads-up alert doesn't colour it; the note is then the line's own.
    const fyi = alert({
      id: 'al_2',
      rule: 'hypervisor.overcommit',
      entity: 'host',
      title: 'vCPUs 2× threads',
    });
    expect(serverVerdict({ card, pending: false, alerts: [fyi], now: NOW }).status).toBe('ok');
    expect(serverVerdict({ card, pending: false, alerts: [fyi, alert()], now: NOW }).note).toBe(
      '/srv 91% full',
    );
    // A warning hint that isn't a heads-up counts, until someone quiets it.
    const online = { id: 'pve-01', status: 'online', statusNote: null };
    const h = hint();
    expect(serverVerdict({ card: online, pending: false, alerts: [], hints: [h], now: NOW })).toMatchObject({
      status: 'warn',
      note: '2 containers unhealthy',
    });
    expect(
      serverVerdict({
        card: online,
        pending: false,
        alerts: [],
        hints: [h],
        quiet: quiet([row({ episode: hintLine(h).episode ?? null })]),
        now: NOW,
      }).status,
    ).toBe('ok');
    // Information never counts.
    expect(
      serverVerdict({
        card: online,
        pending: false,
        alerts: [],
        hints: [hint({ severity: 'info' })],
        now: NOW,
      }).status,
    ).toBe('ok');
  });

  it('keeps offline a fact, without a dot once its “offline” alert is quiet or switched off', () => {
    const off = { id: 'pve-01', status: 'offline', statusNote: 'no heartbeat' };
    const beat = alert({
      rule: 'agent.heartbeat_missing',
      entity: 'host',
      severity: 'critical',
      title: 'Agent unreachable',
    });
    expect(serverVerdict({ card: off, pending: false, alerts: [beat], now: NOW })).toMatchObject({
      status: 'offline',
      dot: true,
    });
    expect(
      serverVerdict({ card: off, pending: false, alerts: [{ ...beat, attention: false }], now: NOW }),
    ).toMatchObject({ status: 'offline', dot: false });
    expect(serverVerdict({ card: off, pending: false, alerts: [], heartbeatOff: true, now: NOW }).dot).toBe(
      false,
    );
  });

  it('gives the desk the line behind a row and the sidebar no dot for a quiet offline server', () => {
    const row = toHostServer(
      {
        id: 'pve-01',
        status: 'offline',
        status_note: 'no heartbeat',
        os: 'Debian',
        last_seen: NOW.toISOString(),
      },
      [],
    ) as HostServer;
    const beat = toHostAlert({
      id: 'al_9',
      server: 'pve-01',
      severity: 'critical',
      title: 'Agent unreachable',
      rule: 'agent.heartbeat_missing',
      entity: 'host',
      state: 'open',
      attention: true,
    });
    keepVerdict(
      row,
      serverVerdict({ card: { id: 'pve-01', status: 'offline' }, pending: false, alerts: [beat], now: NOW }),
    );
    expect(serverNotice(row)).toMatchObject({
      check: 'host.agent.heartbeat_missing',
      nature: 'problem',
      ignoreWords: 'Until it checks in again.',
    });
    expect(serverNotice(row)?.question).toContain('pve-01');
    expect(serverThing(row).status).toBe('offline');
    keepVerdict(
      row,
      serverVerdict({
        card: { id: 'pve-01', status: 'offline' },
        pending: false,
        alerts: [{ ...beat, attention: false }],
        now: NOW,
      }),
    );
    expect(serverNotice(row)).toBeUndefined();
    expect(serverThing(row)).toMatchObject({ status: 'ok', line: 'No heartbeat' });
  });

  it('maps the hub’s entity, key, hint id and the banner’s alert', () => {
    const a = toHostAlert({
      id: 'al_1',
      server: 's',
      rule: 'disk.space_high',
      entity: 'fs:/srv',
      key: 'disk.space_high:fs:/srv',
    });
    expect(a).toMatchObject({ entity: 'fs:/srv', key: 'disk.space_high:fs:/srv' });
    expect(toHostHint({ server: 's', kind: 'disk.space', entity: 'fs:/srv' }).id).toBe('disk.space:fs:/srv');
    expect(
      toHostHint({ server: 's', kind: 'disk.space', entity: 'fs:/srv', id: 'disk.space:fs:/srv#2' }).id,
    ).toBe('disk.space:fs:/srv#2');
  });
});
