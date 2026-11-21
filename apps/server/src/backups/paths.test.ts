/** The staging directory (backup-file.md BF-10, BF-D03): its own names only, tagged so box backups skip it. */
import { describe, expect, it } from 'vitest';
import { CACHEDIR_TAG, madeFileName, scratchName, stagedPath, stagingDir, uploadFileName } from './paths';

const config = { WHOMBAT_HOME: '/srv/whombat', WHOMBAT_BACKUP_FILES_DIR: undefined };

describe('the staging directory', () => {
  it('lives in WHOMBAT_HOME, and holds only names the server made', () => {
    expect(stagingDir(config)).toBe('/srv/whombat/backup-files');
    expect(stagedPath(config, madeFileName('bkf_abc'))).toBe('/srv/whombat/backup-files/bkf_abc.wbk');
    expect(stagedPath(config, uploadFileName('bku_x'))).toBe('/srv/whombat/backup-files/bku_x.upload');
    expect(stagedPath(config, scratchName('bkr_y'))).toBe('/srv/whombat/backup-files/bkr_y.work');
    for (const bad of ['../etc', '.hidden', 'a/b', '', 'x y'])
      expect(() => stagedPath(config, bad)).toThrow();
  });

  it('carries the cache directory tag restic skips', () => {
    expect(CACHEDIR_TAG.startsWith('Signature: 8a477f597d28d172789f06886806bc55')).toBe(true);
  });
});
