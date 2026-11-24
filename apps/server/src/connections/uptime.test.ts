import { catalogEntry, fieldsProblems, UptimeFields, UptimeHubCheck, uptimeFields } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { uptimeSeen } from '../things/kinds/infra/uptime';
import { checkInCommand, currentUptimeReading, uptimeSpec } from './uptime';

const entry = catalogEntry('uptime');
if (!entry) throw new Error('Missing catalog entry.');
const now = new Date('2026-11-24T14:02:00Z');
const row = { id: 'con_example', label: 'Example', fields: { kind: 'http', address: 'https://example.com' } };
const check = UptimeHubCheck.parse({
  id: 'ck_example',
  name: row.label,
  kind: 'http',
  target: row.fields.address,
  runner: 'hub',
  intervalS: 300,
  timeoutS: 10,
  graceS: 0,
  options: {},
  enabled: true,
  status: 'up',
  since: now.toISOString(),
  last: { at: now.toISOString(), ok: true, latencyMs: 82, certNotAfter: '2026-12-08T14:02:00Z' },
  lastPing: null,
  uptime24h: null,
  latency24h: [],
  pingUrl: null,
  createdBy: 'whombat',
});

describe('Website or address', () => {
  it('validates the different kinds of addresses', () => {
    for (const [kind, address] of [
      ['http', 'https://example.com/status?q=ready'],
      ['tcp', '[2001:db8::1]:443'],
      ['ping', '2001:db8::1'],
      ['dns', 'example.com.'],
    ] as const)
      expect(fieldsProblems(entry, 'none', { kind, address })).toEqual({});
    for (const [kind, address] of [
      ['http', 'https://user:secret@example.com'],
      ['tcp', 'example.com:65536'],
      ['ping', 'example.com:443'],
      ['dns', 'https://example.com'],
    ] as const)
      expect(fieldsProblems(entry, 'none', { kind, address })).toHaveProperty('address');
    expect(fieldsProblems(entry, 'none', { kind: 'http' })).toHaveProperty('address');
  });

  it('stores only the fields for the selected kind', () => {
    const fields = uptimeFields(
      UptimeFields.parse({
        kind: 'heartbeat',
        address: 'https://example.com',
        keyword: 'Welcome',
        runner: 'server-example',
        every: '15',
        late: '1',
      }),
    );
    expect(fields).toEqual({ kind: 'heartbeat', runner: 'hub', every: '15', late: '1' });
    expect(uptimeSpec({ ...row, fields })).toMatchObject({
      target: '',
      runner: 'hub',
      interval_s: 900,
      grace_s: 60,
      options: {},
    });
  });

  it('uses the hub latency and ignores observations from before an edit or from a stale runner', () => {
    expect(uptimeSeen(check, row, now, 'UTC').points.rtt_ms).toBe(82);
    const stale = uptimeSeen({ ...check, stale: true }, row, now, 'UTC');
    expect(stale.points.rtt_ms).toBeNull();
    expect(stale.notices).toMatchObject([{ check: 'uptime.unseen', nature: 'fyi' }]);
    expect(stale.notices?.[0]?.title).toContain('14:02');
    expect(currentUptimeReading(check, new Date(now.getTime() + 1000))).toMatchObject({
      status: 'pending',
      last: null,
    });
  });

  it('distinguishes a late check-in, a failed probe and the two certificate thresholds', () => {
    expect(uptimeSeen({ ...check, status: 'down' }, row, now, 'UTC').notices).toContainEqual(
      expect.objectContaining({ check: 'uptime.down', offline: true, tone: 'bad' }),
    );
    expect(
      uptimeSeen(
        { ...check, kind: 'heartbeat', status: 'down' },
        { ...row, fields: { kind: 'heartbeat' } },
        now,
        'UTC',
      ).notices,
    ).toMatchObject([{ check: 'uptime.checkin_late', tone: 'bad', nature: 'you' }]);
    expect(uptimeSeen(check, row, now, 'UTC').notices).toMatchObject([
      { check: 'uptime.cert_expiring', tone: 'warn' },
    ]);
    expect(uptimeSeen(check, row, new Date('2026-12-05T14:02:00Z'), 'UTC').notices).toMatchObject([
      { check: 'uptime.cert_expiring', tone: 'bad' },
    ]);
    expect(uptimeSeen(check, row, new Date(now.getTime() - 1), 'UTC').notices).toEqual([]);
  });

  it('makes a pinned HTTPS command for the check-in listener', () => {
    const pin = `sha256//${'A'.repeat(43)}=`;
    const url = 'https://10.100.0.8:8443/ping/example';
    expect(checkInCommand(url, pin)).toEqual(expect.stringContaining(`--pinnedpubkey '${pin}' '${url}'`));
    expect(checkInCommand(url, null)).toBeNull();
    expect(checkInCommand("https://example.com/ping/token'broken", pin)).toBeNull();
  });
});
