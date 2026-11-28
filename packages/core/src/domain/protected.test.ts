import { describe, expect, it } from 'vitest';
import {
  isRestoreTestCopy,
  isRestoreTestId,
  type ProtectedRow,
  protectedAskSubject,
  protectedAskText,
  protectedGroupOf,
  protectedOffsiteLine,
  protectedRowLine,
  protectedRowOld,
  protectedRowsOf,
  restoreTestLine,
  restoreTestName,
  restoreTestWhen,
} from './protected.js';

const now = new Date('2026-11-28T12:00:00Z');
const tz = 'Europe/Amsterdam';

function row(over: Partial<ProtectedRow> & Pick<ProtectedRow, 'key' | 'name' | 'state'>): ProtectedRow {
  return { kind: 'vm', href: null, lastAt: null, where: null, ...over };
}

describe('restore test copies', () => {
  it('live in their own range, named or tagged as copies', () => {
    expect(isRestoreTestId('pve:990003')).toBe(true);
    expect(isRestoreTestId(101)).toBe(false);
    expect(restoreTestName('Home Assistant OS')).toBe('whombat-test-of-home-assistant-os');
    expect(restoreTestName('***')).toBe('whombat-test-of-machine');
    expect(isRestoreTestCopy({ id: 'pve:990000', name: 'whombat-test-of-plex' })).toBe(true);
    expect(isRestoreTestCopy({ id: 'pve:990000', name: 'plex', tags: ['whombat-restore-test'] })).toBe(true);
    // A machine of the person's that happens to sit in the range is never taken for a copy.
    expect(isRestoreTestCopy({ id: 'pve:990000', name: 'plex' })).toBe(false);
    expect(isRestoreTestCopy({ id: 'pve:101', name: 'whombat-test-of-plex' })).toBe(false);
  });
});

describe('the page’s groups and lines', () => {
  it('puts “can’t see” with “not backed up”, the worst first in each group', () => {
    expect(protectedGroupOf('unseen')).toBe('none');
    const rows = [
      row({ key: 'b', name: 'b', state: 'copied', lastAt: '2026-11-28T08:00:00Z' }),
      row({ key: 'w', name: 'Whombat', kind: 'whombat', state: 'copied' }),
      row({ key: 'a', name: 'a', state: 'copied', failedAt: '2026-11-28T09:00:00Z' }),
      row({ key: 'n', name: 'n', state: 'unseen' }),
    ];
    expect(protectedRowsOf(rows, 'copied').map((r) => r.key)).toEqual(['a', 'w', 'b']);
    expect(protectedRowsOf(rows, 'none').map((r) => r.key)).toEqual(['n']);
  });

  it('says where the copy is, a failure with the one before, and what Whombat can’t see', () => {
    const copied = protectedRowLine(
      row({ key: 'x', name: 'x', state: 'copied', lastAt: '2026-11-28T09:00:00Z', where: 'pbs-01' }),
      now,
      tz,
    );
    expect(copied).toContain('pbs-01');
    expect(
      protectedRowLine(row({ key: 'x', name: 'x', state: 'local', lastAt: '2026-11-28T09:00:00Z' }), now, tz),
    ).toContain('own disks');
    const failed = protectedRowLine(
      row({
        key: 'x',
        name: 'x',
        state: 'copied',
        lastAt: '2026-11-25T09:00:00Z',
        failedAt: '2026-11-28T09:00:00Z',
      }),
      now,
      tz,
    );
    expect(failed).toContain('failed');
    expect(failed).toContain('before');
    expect(
      protectedRowLine(row({ key: 'x', name: 'x', state: 'unseen', kind: 'server' }), now, tz),
    ).toContain('server itself');
    expect(
      protectedRowLine(row({ key: 'x', name: 'x', state: 'none', via: 'pve-02 · CT 131' }), now, tz),
    ).toContain('pve-02 · CT 131');
    expect(protectedRowOld({ state: 'copied', lastAt: '2026-11-10T00:00:00Z' }, now)).toBe(true);
    expect(protectedRowOld({ state: 'copied', lastAt: '2026-11-27T00:00:00Z' }, now)).toBe(false);
  });

  it('says the off-site copy, none yet, or that copying there fails', () => {
    const ok = protectedOffsiteLine({ name: 'Backblaze B2', lastAt: '2026-11-28T03:10:00Z' }, now, tz);
    expect(ok).toContain('Backblaze B2');
    const none = protectedOffsiteLine({ name: 'Backblaze B2', lastAt: null }, now, tz);
    expect(none).not.toBe(ok);
    const failing = protectedOffsiteLine(
      { name: 'Backblaze B2', lastAt: '2026-11-28T03:10:00Z', failedAt: '2026-11-28T09:00:00Z' },
      now,
      tz,
    );
    expect(failing).toContain('Backblaze B2');
    expect(failing).toContain('failed');
    expect(
      protectedOffsiteLine({ name: 'x', lastAt: null, failedAt: '2026-11-28T09:00:00Z' }, now, tz, 'nl'),
    ).toContain('mislukt');
  });

  it('asks in the thing’s own thread, naming it', () => {
    const guest = row({
      key: 'guest:pve-02:pve:131',
      name: 'gitea',
      state: 'local',
      on: 'pve-02',
      serverId: 'pve-02',
    });
    expect(protectedAskSubject(guest)).toEqual({ kind: 'server', id: 'pve-02', name: 'pve-02' });
    expect(protectedAskText(guest)).toContain('gitea');
    expect(protectedAskText(guest)).toContain('pve-02');
    expect(
      protectedAskSubject(
        row({ key: 'connection:con_plex', name: 'Plex', kind: 'service', state: 'unseen' }),
      ),
    ).toEqual({ kind: 'connection', id: 'con_plex', name: 'Plex' });
    expect(
      protectedAskSubject(row({ key: 'whombat', name: 'Whombat', kind: 'whombat', state: 'none' })),
    ).toBeNull();
  });
});

describe('restore test words', () => {
  it('say when, how long, and why it failed, in both languages', () => {
    const worked = restoreTestLine(
      { at: '2026-11-26T03:10:00Z', outcome: 'worked', durationS: 250, booted: true },
      now,
      tz,
    );
    expect(worked).toContain('4 min');
    const failed = restoreTestLine(
      { at: '2026-11-28T03:10:00Z', outcome: 'failed', reason: 'no_space' },
      now,
      tz,
    );
    expect(failed).toContain('today');
    expect(failed).toContain('space');
    expect(
      restoreTestLine({ at: '2026-11-28T03:10:00Z', outcome: 'failed', reason: 'no_space' }, now, tz, 'nl'),
    ).toContain('ruimte');
    expect(restoreTestWhen('2026-11-29T03:00:00Z', now, tz)).toBe('tomorrow');
    expect(restoreTestWhen('2026-11-27T03:00:00Z', now, tz)).toBe('yesterday');
  });
});
