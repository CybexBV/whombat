/**
 * Which checks Whombat watches from the start (watch-defaults.md): every list registers itself, one check id has one
 * decision, most checks start off, servers' hints Whombat doesn't know start off, and a line of a check that starts off
 * is quiet until someone turns it on. Pure.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOST_WATCH_CHECKS } from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_CHECKS } from '../../devices/home';
import '../../home/box-backup';
import { MAIL_CHECKS } from '../../home/mail-glance';
import '../../managed/backup-key-inbox';
import '../../managed/link/notices';
import '../../managed/network-watch';
import '../../managed/own-address/notices';
import { KIND_MODULES } from '../kinds/index';
import { GENERIC_CHECKS } from '../panels';
import '../recipe/kind';
import { checkStartsOn, isRegisteredCheck, quietNow, reportUnregisteredChecks } from './defaults';
import { NO_QUIET } from './store';

const NOW = new Date('2026-10-30T10:00:00Z');

const lists = [
  GENERIC_CHECKS,
  DEVICE_CHECKS,
  MAIL_CHECKS,
  ...Object.values(KIND_MODULES).map((k) => k.checks ?? []),
  HOST_WATCH_CHECKS,
];

describe('checks that start off (watch-defaults.md)', () => {
  it('reads every list’s own decision', () => {
    expect(checkStartsOn('conn.answers')).toBe(true);
    expect(checkStartsOn('conn.read')).toBe(false);
    expect(checkStartsOn('fusebox.signin')).toBe(true);
    expect(checkStartsOn('fusebox.failing')).toBe(false);
    expect(checkStartsOn('fusebox.week_runs_out')).toBe(false);
    expect(checkStartsOn('device.readings')).toBe(false);
    expect(checkStartsOn('mail.count')).toBe(false);
    expect(checkStartsOn('host.disk.space_high')).toBe(true);
    expect(checkStartsOn('host.disk.wear_high')).toBe(false);
    expect(checkStartsOn('host.hint.system.updates')).toBe(false);
    expect(checkStartsOn('host.hint.guest.no_backup_job')).toBe(true);
    expect(checkStartsOn('qbittorrent.disconnected')).toBe(false);
    expect(checkStartsOn('frigate.camera_offline')).toBe(true);
    expect(checkStartsOn('hetzner.idle')).toBe(false);
    expect(checkStartsOn('cloudflare.domain_expiring')).toBe(false);
    expect(checkStartsOn('pbs.never_verified')).toBe(false);
  });

  it('starts what nobody decided off and reports it once; servers’ checks follow the contract', () => {
    const report = vi.fn();
    reportUnregisteredChecks(report);
    try {
      expect(checkStartsOn('nope.unknown')).toBe(false);
      expect(checkStartsOn('nope.unknown')).toBe(false);
      expect(report.mock.calls).toEqual([['nope.unknown']]);
    } finally {
      reportUnregisteredChecks(null);
    }
    expect(checkStartsOn('host.some_new_rule')).toBe(true);
    expect(checkStartsOn('host.hint.some_new_kind')).toBe(false);
  });

  it('has a decision for every check the server’s code names', () => {
    const src = join(import.meta.dirname, '../..');
    const named = new Set<string>();
    for (const file of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
      if (!file.endsWith('.ts') || file.includes('.test.') || file.includes('testing/')) continue;
      const text = readFileSync(join(src, file), 'utf8');
      for (const m of text.matchAll(/\bcheck(?:Id)?:\s*'([a-z][a-z0-9_]*\.[a-z0-9_.]+)'/g))
        named.add(m[1] as string);
      for (const m of text.matchAll(/checkStartsOn\('([^']+)'\)/g)) named.add(m[1] as string);
    }
    expect(named.size).toBeGreaterThan(100);
    expect([...named].filter((c) => !c.startsWith('host.') && !isRegisteredCheck(c))).toEqual([]);
  });

  it('gives a check shared by several kinds one decision', () => {
    const seen = new Map<string, boolean>();
    for (const list of lists)
      for (const c of list) {
        const before = seen.get(c.check);
        if (before !== undefined) expect([c.check, c.startsOn]).toEqual([c.check, before]);
        seen.set(c.check, c.startsOn);
      }
  });

  it('starts most checks off', () => {
    const all = new Map(lists.flat().map((c) => [c.check, c.startsOn]));
    const on = [...all.values()].filter(Boolean).length;
    expect(on).toBeLessThan(all.size / 2);
  });

  it('is quiet by its rows until someone turns it on', () => {
    expect(quietNow(NO_QUIET, 'fusebox.used_up', 'tool:claude', NOW)).toBe(true);
    expect(quietNow(NO_QUIET, 'fusebox.signin', 'account:a', NOW)).toBe(false);
    const on = {
      ...NO_QUIET,
      ons: [{ ownerId: 'b', thingId: 'connection:c', checkId: 'fusebox.used_up', byId: null, at: NOW }],
    };
    expect(quietNow(on, 'fusebox.used_up', 'tool:claude', NOW)).toBe(false);
  });
});
