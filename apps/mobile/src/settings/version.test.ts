import { describe, expect, it } from 'vitest';
import { appVersionText, VERSION_TEXT, versionRows } from './version';

describe('the version in Settings → This Whombat (SS-06, SS-30)', () => {
  it('reads the app version with its build number', () => {
    expect(appVersionText('0.36.0', 36000)).toBe('0.36.0 · build 36000');
    expect(appVersionText('0.36.0', '36000')).toBe('0.36.0 · build 36000');
    expect(appVersionText('0.36.0', undefined)).toBe('0.36.0');
    expect(appVersionText(undefined, 36000)).toBeNull();
  });

  it('lists the app, then the Whombat only when it says its version', () => {
    expect(versionRows('0.36.0 · build 36000', '0.41.1')).toEqual([
      { title: 'This app', meta: '0.36.0 · build 36000' },
      { title: 'Whombat', meta: '0.41.1' },
    ]);
    expect(versionRows('0.36.0', null)).toEqual([{ title: 'This app', meta: '0.36.0' }]);
    expect(versionRows(null, null)).toEqual([{ title: VERSION_TEXT.app, meta: 'Not known' }]);
  });

  it('names the Hermes Agent after the Whombat where its status was read (chat-settle.md AP-6159)', () => {
    const rows = versionRows('0.36.0', '0.165.3', null, { version: '0.12.0' });
    expect(rows.map((r) => [r.title, r.meta])).toEqual([
      ['This app', '0.36.0'],
      ['Whombat', '0.165.3'],
      [VERSION_TEXT.hermes, '0.12.0'],
    ]);
    expect(rows[2]?.body).toBe(VERSION_TEXT.hermesWhat);
    expect(versionRows('0.36.0', '0.165.3', null, null).at(-1)?.meta).toBe(VERSION_TEXT.hermesUnknown);
    // Nowhere else: the Settings tab and the demo world read no status.
    expect(versionRows('0.36.0', null).map((r) => r.title)).not.toContain(VERSION_TEXT.hermes);
  });

  it('says under this app’s version whether it is up to date (AP-2972)', () => {
    const [own] = versionRows('0.101.0 · build 101000', null, 'newest');
    expect(own?.meta).toContain('0.101.0 · build 101000');
    expect(own?.meta).toContain(VERSION_TEXT.status.newest);
    expect(versionRows('0.101.0', null, 'failed')[0]?.meta).toContain(VERSION_TEXT.status.failed);
    // A newer build has a row of its own; nothing known, nothing said.
    expect(versionRows('0.101.0', null, 'newer')[0]?.meta).toBe('0.101.0');
    expect(versionRows('0.101.0', null, 'unknown')[0]?.meta).toBe('0.101.0');
  });
});
