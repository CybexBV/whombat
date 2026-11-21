import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_DISPLAY } from './hardware';
import { bootIdOf, lockAgainChoices, readBootId, screenOn } from './service';

describe('Show Whombat on this screen (DK-20)', () => {
  const real = { connected: true, real: true, builtIn: false, name: 'DELL U2720Q' };
  const virtual = { connected: true, real: false, builtIn: false, name: 'QEMU Monitor' };

  it('reads as the person chose', () => {
    expect(screenOn(false, real, false)).toBe(false);
    expect(screenOn(true, virtual, false)).toBe(true);
    expect(screenOn(true, NO_DISPLAY, false)).toBe(true);
  });

  it('reads on with a real screen, off with a VM’s, while nobody chose', () => {
    expect(screenOn(null, real, false)).toBe(true);
    expect(screenOn(null, virtual, false)).toBe(false);
    expect(screenOn(null, NO_DISPLAY, false)).toBe(false);
  });

  it('reads on while paired, a monitor off or unplugged for now', () => {
    expect(screenOn(null, NO_DISPLAY, true)).toBe(true);
    expect(screenOn(false, NO_DISPLAY, true)).toBe(false);
  });
});

describe('Lock again (DK-74)', () => {
  it('offers When you leave only where the camera works, in the contracts’ order', () => {
    expect(lockAgainChoices(true)).toEqual(['idle', 'away', 'never']);
    expect(lockAgainChoices(false)).toEqual(['idle', 'never']);
  });
});

describe('the boot an unlock that stays was made on (DK-75, DK-S73)', () => {
  const kernel = '5d0c4a52-8e0b-4b8e-9a43-0a6b0e1c2f3d';
  const one = '5d0c4a528e0b4b8e9a430a6b0e1c2f3d';

  it('is the kernel’s boot id or systemd’s %b, in one form; none when neither reads as one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-boot-'));
    try {
      const path = join(dir, 'boot_id');
      writeFileSync(path, `${kernel}\n`);
      expect(readBootId(undefined, path)).toBe(one);
      // systemd's %b (a sandbox without /proc/sys) is the same boot.
      expect(readBootId(one, join(dir, 'missing'))).toBe(one);
      expect(readBootId('not one', path)).toBe(one);
      writeFileSync(path, 'not a boot id\n');
      expect(readBootId(undefined, path)).toBeNull();
      expect(readBootId(undefined, join(dir, 'missing'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(bootIdOf(kernel.toUpperCase())).toBe(one);
    expect(bootIdOf('')).toBeNull();
  });
});
