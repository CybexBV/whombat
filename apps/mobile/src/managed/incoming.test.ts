/**
 * Links that open the phone app (AP-64…AP-67): the ones that set this phone up name the Whombat's identity, and are
 * told apart from claim links (whose `p` is ignored, AP-48) and links that name an appliance (MR-45).
 */
import { addDeviceAppLink, addDeviceLink, phoneSignInLink } from '@whombat/client/managed';
import { describe, expect, it } from 'vitest';
import { appUrl, incomingLink, uiPathOf } from './incoming';

const UI = ['https://app.whombat.com'];
const PEER = '12D3KooW9w6DSVSH3c1ea57aKZvt1uACiQA5TDwyzeBXD9gjQstH';
const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

describe('links that open the phone app', () => {
  it('an add-a-device link, on the web’s origin or the app’s scheme, sets up with its identity', () => {
    for (const url of [addDeviceLink(UI[0] as string, 'dev_1', PEER), addDeviceAppLink('dev_1', PEER)])
      expect(incomingLink(url, UI)).toEqual({
        kind: 'setup',
        link: { kind: 'add', device: 'dev_1', peerId: PEER },
      });
  });

  it('a link with an identity that isn’t one, or from another host, sets nothing up', () => {
    expect(incomingLink(`https://app.whombat.com/appliances/dev_1/add#p=12D3KooWnope`, UI)).toBeNull();
    expect(incomingLink(addDeviceLink('https://evil.example', 'dev_1', PEER), UI)).toBeNull();
  });

  it('keeps claim links and links that name an appliance apart', () => {
    expect(incomingLink(`https://app.whombat.com/claim#v=1&d=dev_1&p=${PEER}&s=${SECRET}`, UI)).toMatchObject(
      {
        kind: 'claim',
      },
    );
    expect(incomingLink('https://app.whombat.com/appliances/dev_1/burrow-hq/chat', UI)).toEqual({
      kind: 'appliance',
      device: 'dev_1',
      path: '/burrow-hq/chat',
    });
    expect(uiPathOf('whombat://appliances/dev_1/add#p=x', UI)).toBe('/appliances/dev_1/add');
    // The query stays with the path (a thread, the burrow of a burrow-less link, AP-366).
    expect(
      incomingLink('https://app.whombat.com/appliances/dev_1/canvases/plan?burrow=burrow-hq#x', UI),
    ).toEqual({ kind: 'appliance', device: 'dev_1', path: '/canvases/plan?burrow=burrow-hq' });
    expect(uiPathOf('https://evil.example/claim', UI)).toBeNull();
  });

  it('opens burrow pages of the hosted UI in either form, and leaves its own pages alone (AP-366)', () => {
    expect(incomingLink('https://app.whombat.com/chat?thread=msg_1', UI)).toEqual({
      kind: 'path',
      path: '/chat?thread=msg_1',
    });
    expect(incomingLink('https://app.whombat.com/burrow-hq/settings/agent', UI)).toEqual({
      kind: 'path',
      path: '/burrow-hq/settings/agent',
    });
    for (const url of [
      'https://app.whombat.com/',
      'https://app.whombat.com/appliances',
      'https://app.whombat.com/legal/privacy',
      'https://app.whombat.com/login',
      'https://app.whombat.com/burrow-hq/nothing',
      'https://evil.example/chat',
    ])
      expect(incomingLink(url, UI)).toBeNull();
  });
});

describe('everything that opens the app (ManagedApp.onUrl)', () => {
  it('leaves the iPhone share extension’s link to the share screen (AP-6322)', () => {
    expect(appUrl('whombat://dataUrl=whombatShareKey?nonce=7#media', UI)).toBeNull();
  });

  const TOKEN = 'tok_0123456789abcdefghijkl';
  const KEY = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

  it('reads the computer’s sign-in code from the hosted UI or the app’s scheme, with or without a Whombat', () => {
    const withWhombat = phoneSignInLink(UI[0] as string, {
      token: TOKEN,
      key: KEY,
      appliance: { device: 'dev_1', peerId: PEER },
    });
    expect(appUrl(withWhombat, UI)).toEqual({
      kind: 'phone',
      link: { token: TOKEN, key: KEY, appliance: { device: 'dev_1', peerId: PEER } },
    });
    expect(appUrl(`whombat://auth/phone#t=${TOKEN}&k=${KEY}`, UI)).toEqual({
      kind: 'phone',
      link: { token: TOKEN, key: KEY, appliance: null },
    });
    // Another host, a broken key or a Whombat without a valid identity: not a sign-in code.
    expect(appUrl(`https://evil.example/auth/phone#t=${TOKEN}&k=${KEY}`, UI)).toBeNull();
    expect(appUrl(`https://app.whombat.com/auth/phone#t=${TOKEN}&k=short`, UI)).toBeNull();
    expect(appUrl(`https://app.whombat.com/auth/phone#t=${TOKEN}&k=${KEY}&d=dev_1&p=nope`, UI)).toBeNull();
    // It is never read as a burrow page or a setup link.
    expect(incomingLink(withWhombat, UI)).toBeNull();
  });

  it('keeps magic links, links for the signed-in app and notification taps apart', () => {
    expect(appUrl('https://app.whombat.com/auth/verify#token=abc', UI)).toEqual({
      kind: 'magic',
      token: 'abc',
    });
    expect(appUrl(addDeviceAppLink('dev_1', PEER), UI)).toEqual({
      kind: 'link',
      link: { kind: 'setup', link: { kind: 'add', device: 'dev_1', peerId: PEER } },
    });
    expect(appUrl('whombat://push?kind=message&ref=0123456789abcdefghijkl', UI)).toEqual({
      kind: 'tap',
      tap: { kind: 'message', ref: '0123456789abcdefghijkl' },
    });
    expect(appUrl('https://evil.example/chat', UI)).toBeNull();
  });
});
