import { describe, expect, it } from 'vitest';
import { formatVersion } from '../agents/ApproveForm';
import { expiresIn } from '../agents/EnrollModal';
import { AUDIT_EVENT_GROUPS, formatBytes } from './AuditLog';

describe('admin formats', () => {
  it('counts the enrollment expiry down in minutes, then seconds', () => {
    const exp = Date.parse('2026-10-11T15:00:00Z');
    expect(expiresIn(exp, Date.parse('2026-10-11T14:00:08Z'))).toBe('Expires in 59 min');
    expect(expiresIn(exp, Date.parse('2026-10-11T14:59:00Z'))).toBe('Expires in 1 min');
    expect(expiresIn(exp, Date.parse('2026-10-11T14:59:15Z'))).toBe('Expires in 45 s');
    expect(expiresIn(exp, Date.parse('2026-10-11T15:01:00Z'))).toBe('Expires in 0 s');
  });

  it('formats byte counts and versions', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(48_213)).toBe('47.1 KB');
    expect(formatBytes(21_948_213)).toBe('20.9 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 300)).toBe('300 GB');
    expect(formatVersion('0.14.2')).toBe('v0.14.2');
    expect(formatVersion('v0.14.2')).toBe('v0.14.2');
    expect(formatVersion(null)).toBe('—');
  });

  it('lists every audit event of REMOTE-CONSOLE 8 and CONTRACT 7.3 once', () => {
    const all = AUDIT_EVENT_GROUPS.flatMap((g) => g.events);
    expect(new Set(all).size).toBe(all.length);
    for (const e of ['console.requested', 'console.denied', 'console.opened', 'console.closed', 'console.switched', 'action.requested', 'action.finished', 'remote_control.enabled', 'remote_control.disabled', 'screens.viewed', 'auth.login', 'enrollment.approved', 'server.deleted', 'audit.exported']) {
      expect(all).toContain(e);
    }
    for (const g of AUDIT_EVENT_GROUPS) if (g.prefix) expect(g.events.every((e) => e.startsWith(g.prefix!))).toBe(true);
  });
});

describe('audit event groups cover the hub', () => {
  it('lists every event the hub writes', async () => {
    // Event names the hub's Go code writes (Event: "x.y" and the computed ones).
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../../../../internal/hub/', import.meta.url);
    const found = new Set<string>();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.go') || f.endsWith('_test.go')) continue;
      const src = readFileSync(new URL(f, dir), 'utf8');
      for (const m of src.matchAll(/(?:Event: *|ev(?:ent)? *:?= *|rec\.Event, [^=]*= *)"([a-z_]+\.[a-z_]+)"/g)) found.add(m[1]!);
    }
    expect(found.size).toBeGreaterThan(40);
    const listed = new Set(AUDIT_EVENT_GROUPS.flatMap((g) => g.events));
    const missing = [...found].filter((e) => !listed.has(e) && !e.startsWith('alert.updated'));
    expect(missing).toEqual([]);
  });
});
