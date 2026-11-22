import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Disk } from './api';
import { CONSOLE, checkNote, diskHolds, diskNote, GUIDE, GUIDE_LABEL, INSTALLER, WORD } from './copy';

// The console's words must stay those of the text console (CG-07): every WORD is a string literal in
// console/internal/screen, with %s / %d where the page fills in a value.
const go = ['render.go', 'start.go']
  .map((f) => readFileSync(new URL(`../../../internal/screen/${f}`, import.meta.url), 'utf8'))
  .join('\n');

describe('WORD', () => {
  it.each(Object.entries(WORD))('%s is verbatim from the text console', (_, w) => {
    // Each value the page fills in is a %s (a count of minutes: %d), in order.
    const values = typeof w === 'function' ? Array.from({ length: w.length }, () => '\u0000') : [];
    const text = typeof w === 'function' ? (w as (...v: never[]) => string)(...(values as never[])) : w;
    const literal = text.replaceAll('\u0000', typeof w === 'function' && /min\.$/.test(text) ? '%d' : '%s');
    expect(go).toContain(`"${literal}"`);
  });
});

// The guide is Hazel, as in the app's sign-in and claim pages (CG-35, CG-338).
describe('the guide', () => {
  it('is Hazel', () => {
    expect(GUIDE).toBe('Hazel');
    expect(GUIDE_LABEL).toBe('Hazel, your guide');
    expect(INSTALLER.welcomeSay).toBe('Hi, I’m Hazel. I’ll show you the way. It’s mostly digging.');
  });
});

describe('the alert', () => {
  it('says what the text console says (console/internal/screen/alert.go)', () => {
    const alertGo = readFileSync(new URL('../../../internal/screen/alert.go', import.meta.url), 'utf8');
    const m = /const WordAlertForeign = "([^"]*)" \+\s*"([^"]*)"/.exec(alertGo);
    expect(m ? `${m[1]}${m[2]}` : null).toBe(CONSOLE.alertForeign);
  });
});

describe('the start problem (CG-409)', () => {
  it('names the release when there is one', async () => {
    const { startWords } = await import('./console');
    expect(startWords({ problem: 'release-missing', release: 'whombat-20261120.15' })).toContain(
      'its version, whombat-20261120.15, on',
    );
    expect(startWords({ problem: 'release-missing', release: '' })).toBe(WORD.startReleaseMissingNoId);
    expect(startWords({ problem: 'offline', release: '' })).toBe(WORD.startOffline);
    expect(startWords({ problem: 'failed', release: 'x' })).toBe(WORD.startFailed);
  });
});

// The disk check says what stops each disk, not one sentence for every reason.
describe('the disk check', () => {
  const GiB = 1024 ** 3;
  const disk = (name: string, reason: Disk['reason'], gib = 128): Disk => ({
    path: `/dev/${name}`,
    name,
    model: '',
    sizeBytes: gib * GiB,
    eligible: reason === '',
    reason,
  });
  it('names each disk and its reason', () => {
    const small = diskNote([disk('sda', 'too-small', 64)]);
    expect(small).toContain('sda');
    expect(small).toContain('64 GiB');
    expect(small).toContain('110 GiB');
    const all = diskNote([disk('sdb', 'installer-medium'), disk('sdc', 'in-use'), disk('sdd', 'usb')]);
    for (const w of ['sdb', 'installer', 'sdc', 'in use', 'sdd', 'USB']) expect(all).toContain(w);
    expect(all).not.toContain('110 GiB');
  });
  it('says when it found no disk at all', () => {
    expect(diskNote([])).toContain('No disk found');
    expect(checkNote('disk', 'fail', '', [])).toBe(diskNote([]));
    expect(checkNote('disk', 'fail', '', [disk('sda', 'usb')])).toContain('sda');
    expect(checkNote('disk', 'ok', 'sda', [disk('sda', '')])).toBeNull();
  });
});

// What is on a disk that isn't empty, so the person knows what typing its name erases.
describe('what a disk holds', () => {
  const GiB = 1024 ** 3;
  const base: Disk = {
    path: '/dev/sda',
    name: 'sda',
    model: '',
    sizeBytes: 128 * GiB,
    eligible: true,
    reason: '',
  };
  it('names what made each part, its label and size, and counts the rest', () => {
    const held = diskHolds({
      ...base,
      parts: [
        { label: 'OS', fsType: 'ntfs', sizeBytes: 100 * GiB },
        { label: '', fsType: 'vfat', sizeBytes: 100 * 1024 ** 2 },
        { label: '', fsType: '', sizeBytes: GiB },
        { label: 'Data', fsType: 'ext4', sizeBytes: GiB },
        { label: '', fsType: 'swap', sizeBytes: GiB },
      ],
    });
    for (const w of ['Windows', '“OS”', '100 GiB', 'FAT', '100 MiB', '2 more']) expect(held).toContain(w);
    expect(held).not.toContain('Data');
  });
  it('says nothing for an empty disk, or when the server didn’t say', () => {
    expect(diskHolds({ ...base, empty: true, parts: [] })).toBeNull();
    expect(diskHolds(base)).toBeNull();
  });
  it('confirms an empty disk with a button, not the name typed', () => {
    expect(INSTALLER.eraseEmpty).not.toContain('sda');
    expect(INSTALLER.erase('sda')).toContain('sda');
  });
});

// After the installer, the screen shows a Link code or Tailscale's sign-in first, not always a claim code.
describe('the installer’s promise', () => {
  it('doesn’t promise a claim code', () => {
    expect(INSTALLER.welcomeNext).not.toMatch(/claim/i);
    expect(INSTALLER.doneSub).not.toMatch(/claim/i);
  });
});
