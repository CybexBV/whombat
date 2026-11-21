/** A sign-in started on the phone and its return through the `/connect/` App Link (phone-connect.md PC-05, AP-2905…). */
import { describe, expect, it } from 'vitest';
import {
  asStarted,
  connectOutcome,
  failedReturnUrl,
  finishingDevice,
  HELD_CONNECT_MS,
  holdPhoneConnect,
  onConnectReturn,
  pushConnectReturn,
  takeConnectReturn,
  takeHeldConnect,
  thingOfUrl,
} from './connectReturn';
import { appUrl, incomingLink } from './incoming';

const UI = ['https://app.whombat.com'];

describe('the provider’s answer comes back to the app (AP-2905)', () => {
  it('reads a catalog entry’s, Google’s and Microsoft’s return; nothing else under /connect/ is an account sign-in', () => {
    const ha = incomingLink('https://app.whombat.com/connect/homeassistant?code=abc&state=st1', UI);
    expect(ha).toMatchObject({
      kind: 'connect',
      entry: 'homeassistant',
      back: { provider: 'connection', state: 'st1' },
    });
    expect(incomingLink('https://app.whombat.com/connect/google?code=c&state=s', UI)).toMatchObject({
      kind: 'connect',
      entry: 'google',
      back: { state: 's' },
    });
    expect(
      incomingLink('https://app.whombat.com/connect/microsoft?error=access_denied&state=s', UI),
    ).toMatchObject({
      kind: 'connect',
      back: { provider: 'microsoft', error: 'access_denied' },
    });
    // RFC 9207's issuer comes along.
    expect(
      incomingLink(
        'https://app.whombat.com/connect/notion?code=c&state=s&iss=https%3A%2F%2Fmcp.notion.com',
        UI,
      ),
    ).toMatchObject({ back: { iss: 'https://mcp.notion.com' } });
    expect(appUrl('https://app.whombat.com/connect/dropbox?code=c&state=s', UI)).toMatchObject({
      kind: 'link',
    });
  });

  it('leaves another host’s /connect/ and the hosted UI’s other pages alone', () => {
    expect(incomingLink('https://evil.example/connect/dropbox?code=c&state=s', UI)).toBeNull();
    expect(incomingLink('https://app.whombat.com/connect', UI)).toBeNull();
    expect(incomingLink('https://app.whombat.com/billing', UI)).toBeNull();
  });
});

describe('which Whombat finishes it', () => {
  const now = Date.parse('2026-10-19T10:00:00Z');

  it('is the one that started it, held for 30 minutes and taken once; else the one last used', () => {
    holdPhoneConnect({ device: 'wb-1', flow: 'connection' }, now);
    const held = takeHeldConnect(now + 60_000);
    expect(held?.device).toBe('wb-1');
    expect(takeHeldConnect(now + 60_000)).toBeNull();
    expect(finishingDevice(held, 'wb-2')).toBe('wb-1');
    expect(finishingDevice(null, 'wb-2')).toBe('wb-2');
    holdPhoneConnect({ device: 'wb-1' }, now);
    expect(takeHeldConnect(now + HELD_CONNECT_MS + 1)).toBeNull();
  });

  it('finishes a held catalog sign-in that came back to Google’s route as the entry’s (AP-766)', () => {
    const back = { code: 'c', state: 's', error: null };
    expect(asStarted(back, { device: 'wb-1', flow: 'connection', at: now }).provider).toBe('connection');
    expect(asStarted(back, { device: 'wb-1', at: now }).provider).toBeUndefined();
  });

  it('hands a return only to its own Whombat’s navigator, and keeps it until that one listens', () => {
    const back = { code: 'c', state: 's', error: null };
    const seen: string[] = [];
    const off = onConnectReturn((item) => {
      if (item.device !== 'wb-other') return false;
      seen.push(item.entry);
      return true;
    });
    pushConnectReturn({ device: 'wb-1', back, entry: 'dropbox' });
    off();
    expect(seen).toEqual([]);
    expect(takeConnectReturn('wb-2')).toBeNull();
    expect(takeConnectReturn('wb-1')?.entry).toBe('dropbox');
    expect(takeConnectReturn('wb-1')).toBeNull();
  });
});

describe('what the Whombat answered', () => {
  it('reads connected= and connect_error= off the return path', () => {
    expect(
      connectOutcome(
        '/burrow-hq/settings?tab=connections&connection=homeassistant&connected=homeassistant&connection=con_1',
      ),
    ).toEqual({ connected: 'homeassistant', error: null });
    expect(
      connectOutcome('/settings?tab=connections&connection=dropbox&connect_error=access_denied'),
    ).toEqual({
      connected: null,
      error: 'access_denied',
    });
  });

  it('says a return it couldn’t finish on the entry’s form or the account’s screen', () => {
    expect(failedReturnUrl('dropbox')).toBe(
      'whombat://settings/connections/connect/dropbox?error=exchange_failed',
    );
    expect(failedReturnUrl('google')).toBe(
      'whombat://settings/connections/account/google?error=exchange_failed',
    );
    expect(failedReturnUrl('../x')).toBe('whombat://settings/connections');
  });
});

describe('thingOfUrl', () => {
  it('names the connection of a things link, and nothing for a link it can’t read', () => {
    expect(thingOfUrl('whombat://things/thg_plex?connected=1')).toBe('thg_plex');
    expect(thingOfUrl('whombat://things/a%20b')).toBe('a b');
    expect(thingOfUrl('whombat://things/100%')).toBeNull();
    expect(thingOfUrl('whombat://things/')).toBeNull();
    expect(thingOfUrl('whombat://runs/12')).toBeNull();
  });
});
