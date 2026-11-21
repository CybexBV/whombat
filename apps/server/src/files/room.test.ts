import { describe, expect, it } from 'vitest';
import { DISK_RESERVE_MIN_BYTES, diskFits, diskReserve, filesRoom } from './room';

const GiB = 1024 * 1024 * 1024;

describe('the files’ room (page-sets.md PG-20)', () => {
  it('keeps 5 % of the disk free, at least 5 GiB', () => {
    expect(diskReserve(900 * GiB)).toBe(45 * GiB);
    expect(diskReserve(64 * GiB)).toBe(DISK_RESERVE_MIN_BYTES);
    expect(diskFits({ free: 895 * GiB, total: 913 * GiB }, 250 * 1024 * 1024)).toBe(true);
    expect(diskFits({ free: 46 * GiB, total: 900 * GiB }, 2 * GiB)).toBe(false);
  });

  it('is a fixed quota when one is set, else the disk', async () => {
    const config = { WHOMBAT_HOME: '/nowhere', WHOMBAT_FILES_DIR: '/nowhere/files' } as const;
    expect(await filesRoom({ ...config, WHOMBAT_BURROW_QUOTA_BYTES: 1000 }, 200, async () => 900)).toBe(
      'quota',
    );
    expect(await filesRoom({ ...config, WHOMBAT_BURROW_QUOTA_BYTES: 1000 }, 100, async () => 900)).toBe('ok');
    // No quota, and a disk that can't be read: nothing is refused for it.
    expect(await filesRoom(config, 10 * GiB, async () => 0)).toBe('ok');
  });
});
