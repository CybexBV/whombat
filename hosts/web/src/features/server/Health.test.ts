import { describe, expect, it } from 'vitest';
import { fullText, systemRows } from './Health';
import { niceRate } from './SummaryTab';

describe('systemRows', () => {
  it('lists only what the agent reports, with tones', () => {
    const rows = systemRows({
      system: {
        package_manager: 'apt',
        updates: 17,
        security_updates: 6,
        updates_checked_at: null,
        updates_error: null,
        reboot_required: true,
        reboot_reason: 'Kernel 6.12.111 is installed',
        init_system: 'systemd',
        failed_count: 4,
        failed_units: ['a.service', 'b.service', 'c.service', 'd.service'],
        time_synced: false,
        time_offset_ms: 2480,
        time_source: 'chrony',
        oom_kills: 0,
        processes: 200,
        steal_pct: null,
        pressure: null,
      },
      ups: [{ name: 'rack', model: null, status: 'on_battery', charge_pct: 80, runtime_s: 1500, load_pct: null }],
      gpus: [],
    });
    expect(rows.map((r) => `${r.k}: ${r.v}${r.tone ? ` (${r.tone})` : ''}`)).toEqual([
      'Updates: 17 available · 6 security (warn)',
      'Reboot: Required (warn)',
      'Services: 4 failed (warn)',
      'Clock: Not synced · offset 2.5 s (warn)',
      'UPS rack: On battery · 80% · 25 min left (warn)',
    ]);
    expect(rows[2]?.sub).toBe('a.service, b.service, c.service, …');
  });

  it('is empty for older agents', () => {
    expect(systemRows({})).toEqual([]);
  });
});

describe('formatting', () => {
  it('rounds rate ceilings to 1, 2 or 5', () => {
    expect(niceRate(0)).toBe(1);
    expect(niceRate(240)).toBe(500);
    expect(niceRate(1700)).toBe(2000);
    expect(niceRate(null)).toBe(1);
  });
  it('says when a volume is full', () => {
    expect(fullText(0.4)).toBe('Full within a day');
    expect(fullText(12.3)).toBe('Full in about 12 days');
  });
});
