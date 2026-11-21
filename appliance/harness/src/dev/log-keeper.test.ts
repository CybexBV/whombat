import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BoundedLog, prune } from './log-keeper.ts';

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'log-keeper-'));

describe('log keeper (IN-41, control CL-38)', () => {
  it('rotates at a new day and past the size bound, and keeps at most 14 days', () => {
    const dir = tmp();
    const file = join(dir, 'control.log');
    let now = Date.parse('2026-09-26T10:00:00Z');
    const log = new BoundedLog({ file, days: 14, maxBytes: 100, maxTotal: 10_000 }, () => now);
    log.write(Buffer.from('a'.repeat(60)));
    log.write(Buffer.from('b'.repeat(60))); // past 100 bytes: rotated first
    now = Date.parse('2026-09-27T00:00:01Z');
    log.write(Buffer.from('c\n')); // a new day: rotated again
    log.close();
    const names = readdirSync(dir).sort();
    expect(names).toEqual(['control.log', 'control.log.2026-09-26T100000', 'control.log.2026-09-27T000001']);
    expect(readFileSync(file, 'utf8')).toBe('c\n');
    // Rotated copies older than 14 days go, the current file stays.
    const old = join(dir, 'control.log.2026-09-26T100000');
    const t = new Date(Date.parse('2026-09-01T00:00:00Z'));
    utimesSync(old, t, t);
    expect(
      prune({ file, days: 14, maxBytes: 100, maxTotal: 10_000 }, Date.parse('2026-09-27T01:00:00Z')),
    ).toEqual([old]);
  });

  it('drops the oldest copies past the total bound and never touches other files', () => {
    const dir = tmp();
    const file = join(dir, 'control.log');
    writeFileSync(join(dir, 'relay.log.2026-09-01T000000'), 'x');
    for (const [i, n] of ['2026-09-20T000000', '2026-09-21T000000', '2026-09-22T000000'].entries()) {
      writeFileSync(join(dir, `control.log.${n}`), 'y'.repeat(50));
      const t = new Date(Date.parse('2026-09-20T00:00:00Z') + i * 86_400_000);
      utimesSync(join(dir, `control.log.${n}`), t, t);
    }
    prune({ file, days: 14, maxBytes: 100, maxTotal: 120 }, Date.parse('2026-09-23T00:00:00Z'));
    expect(readdirSync(dir).sort()).toEqual([
      'control.log.2026-09-21T000000',
      'control.log.2026-09-22T000000',
      'relay.log.2026-09-01T000000',
    ]);
  });
});
