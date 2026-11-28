import { describe, expect, it } from 'vitest';
import { backWordUnder } from './backWord';

describe('the “‹ …” of a page opened without one', () => {
  const tabs = (tab: string) => ({ key: 'tabs', name: 'Tabs', state: { index: 0, routes: [{ name: tab }] } });

  it('names the tab, the place or the titled page under it', () => {
    const page = { key: 'p', name: 'Thing' };
    expect(backWordUnder({ routes: [tabs('NeedsYou'), page] }, 'p')).toBe('Inbox');
    expect(backWordUnder({ routes: [tabs('NeedsYou'), { key: 's', name: 'ServersPlace' }, page] }, 'p')).toBe(
      'Servers',
    );
    expect(
      backWordUnder({ routes: [tabs('ChatRoom'), { key: 'c', name: 'ConnectionsPlace' }, page] }, 'p', 'nl'),
    ).toBe('Koppelingen');
    expect(
      backWordUnder(
        { routes: [tabs('ChatRoom'), { key: 'h', name: 'Thing', params: { title: 'pve-02' } }, page] },
        'p',
      ),
    ).toBe('pve-02');
  });

  it('says Chat over the Overview’s old tab, and Back with nothing under it', () => {
    expect(backWordUnder({ routes: [tabs('Dashboard'), { key: 'p', name: 'Approval' }] }, 'p')).toBe('Chat');
    expect(backWordUnder({ routes: [{ key: 'p', name: 'Approval' }] }, 'p')).toBe('Back');
  });
});
