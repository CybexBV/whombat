import { describe, expect, it } from 'vitest';
import { parseNotificationUrl, parsePushTapUrl, urlTarget } from './routes';

const ORIGINS = ['https://app.whombat.com'];

describe('a link with a stray % in it', () => {
  it('is still read, never thrown on', () => {
    expect(urlTarget('https://app.whombat.com/search?q=100%', ORIGINS)).toMatchObject({ kind: 'app' });
    expect(urlTarget('/runs/12?x=%E0', ORIGINS)).toEqual({
      kind: 'app',
      url: 'whombat://runs/12',
      burrow: null,
      path: '/runs/12?x=%E0',
    });
    expect(urlTarget('https://app.whombat.com/canvases/%E0%A4%A', ORIGINS)).toMatchObject({ kind: 'system' });
    expect(parseNotificationUrl('whombat://open?path=%2Fruns%2F1&notification=%')).toMatchObject({
      url: 'whombat://runs/1',
      notificationId: '%',
    });
    expect(parsePushTapUrl('whombat://push?kind=a&ref=%zz')).toBeNull();
  });
});

describe('a link whose query value has an = in it', () => {
  it('keeps the whole value', () => {
    expect(parseNotificationUrl('whombat://open?path=/runs/1&notification=ntf_a=b')).toMatchObject({
      notificationId: 'ntf_a=b',
    });
    expect(urlTarget('/search?q=a=b', ORIGINS)).toMatchObject({
      kind: 'app',
      url: 'whombat://search?q=a%3Db',
    });
  });
});
