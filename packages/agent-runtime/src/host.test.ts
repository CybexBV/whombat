import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostPathIssues, hostPaths, PrivateDirError, privateDir } from './host';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'whombat-host-')));

describe('host paths', () => {
  it('fills WHOMBAT_HOME and the workspaces from their settings', () => {
    const home = join(base, 'home');
    expect(hostPaths({}, home)).toMatchObject({
      whombatHome: join(home, '.whombat'),
      workspaces: join(home, '.whombat', 'workspaces'),
    });
    expect(hostPaths({ WHOMBAT_HOME: '~/w', WHOMBAT_WORKSPACES: '/srv/ws' }, home)).toMatchObject({
      whombatHome: join(home, 'w'),
      workspaces: '/srv/ws',
    });
    expect(hostPathIssues({ WHOMBAT_HOME: 'relative' })).toHaveLength(1);
    expect(hostPathIssues({ WHOMBAT_HOME: '~/w' })).toEqual([]);
  });
});

describe('the runner’s private scratch space (BP-C38)', () => {
  it('is made 0700, and refused when it is open to others, a link, or not a directory', async () => {
    const root = join(base, 'private');
    await privateDir(root);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    await expect(privateDir(root)).resolves.toBe(root);
    const open = join(base, 'open');
    mkdirSync(open);
    chmodSync(open, 0o755);
    await expect(privateDir(open)).rejects.toThrow(PrivateDirError);
    await expect(privateDir(open)).rejects.toThrow('is open to other users (mode 755).');
    const link = join(base, 'link');
    symlinkSync(root, link);
    await expect(privateDir(link)).rejects.toThrow('is a link, not a directory of its own.');
    const file = join(base, 'a-file');
    writeFileSync(file, 'x');
    await expect(privateDir(file)).rejects.toThrow('is not a directory.');
  });
});
