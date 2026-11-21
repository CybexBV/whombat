import { describe, expect, it } from 'vitest';
import { sameNameKeys, settingsConnectionGroup, settingsConnectionGroups } from './settingsList';

describe('Settings → Connections', () => {
  it('puts what needs you first, then accounts, then apps and services', () => {
    const rows = [
      { page: 'hetzner', ok: true, key: 'a' },
      { page: 'google', ok: true, key: 'b' },
      { page: 'github', ok: false, key: 'c' },
      { page: 'feedback', ok: true, key: 'd' },
    ];
    const groups = settingsConnectionGroups(rows);
    expect(groups.needsYou.map((r) => r.key)).toEqual(['c']);
    expect(groups.accounts.map((r) => r.key)).toEqual(['b']);
    expect(groups.apps.map((r) => r.key)).toEqual(['a', 'd']);
    expect(settingsConnectionGroup('imap')).toBe('accounts');
  });

  it('finds the rows nothing tells apart', () => {
    const keys = sameNameKeys([
      { key: 'a', name: 'Hetzner Cloud', address: null },
      { key: 'b', name: 'hetzner cloud ', address: null },
      { key: 'c', name: 'Home Assistant', address: 'home.lan' },
      { key: 'd', name: 'Home Assistant', address: 'cabin.lan' },
    ]);
    expect([...keys]).toEqual(['a', 'b']);
  });
});
