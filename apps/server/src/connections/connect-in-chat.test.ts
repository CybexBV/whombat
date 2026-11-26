import { CONNECT_HERE_DECLINE, catalogEntry, GuideCard } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { parseGuideReturn } from '../guides/service';
import { connectAddress, connectCard, hostOfAddress } from './ask';
import { readSshBanner, serversAt, withoutDoubleServers } from './found-servers';
import { foundAddress, foundName, foundTagline, orderFound } from './found-view';

const entry = (id: string) => {
  const e = catalogEntry(id);
  if (!e) throw new Error(id);
  return e;
};

describe('connection_add’s pre-fill (connect-in-chat.md)', () => {
  const finds = [
    { host: '192.168.1.10', url: 'http://192.168.1.10:8123' },
    { host: '192.168.1.11', url: 'http://192.168.1.11:8123' },
  ];

  it('takes what the scan found when nothing is given', () => {
    expect(connectAddress(null, finds)).toEqual({ url: 'http://192.168.1.10:8123', found: true });
    expect(connectAddress(null, [])).toEqual({ url: null, found: false });
  });

  it('fills a bare host from the scan, keeps a full address as given', () => {
    expect(connectAddress('192.168.1.11', finds)).toEqual({ url: 'http://192.168.1.11:8123', found: true });
    expect(connectAddress('https://ha.lan:8443', finds)).toEqual({
      url: 'https://ha.lan:8443',
      found: false,
    });
    expect(connectAddress('192.168.1.99', finds)).toEqual({ url: '192.168.1.99', found: false });
  });

  it('reads the host of an address', () => {
    expect(hostOfAddress('https://10.0.0.5:8006')).toBe('10.0.0.5');
    expect(hostOfAddress('pve.lan')).toBe('pve.lan');
    expect(hostOfAddress('[fd00::5]:8006')).toBe('fd00::5');
  });

  it('makes a card with one button to the form, the level in words', () => {
    const card = connectCard(entry('homeassistant'), {
      url: 'http://192.168.1.10:8123',
      found: true,
      access: 'manage',
      agent: 'Dusty',
    });
    expect(GuideCard.parse(card)).toEqual(card);
    expect(card.state).toBe('done');
    expect(card.title).toBe('Connect Home Assistant at 192.168.1.10');
    expect(card.body).toContain('found it on your network');
    expect(card.body).toContain('Manage');
    const actions = card.blocks.flatMap((b) => (b.type === 'actions' ? b.actions : []));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.href).toContain('connection=homeassistant');
  });

  it('adds a Proxmox VE as a server first', () => {
    const card = connectCard(entry('proxmox'), {
      url: 'https://10.0.0.5:8006',
      found: true,
      access: 'read',
      agent: 'Dusty',
    });
    const actions = card.blocks.flatMap((b) => (b.type === 'actions' ? b.actions : []));
    expect(actions.map((a) => a.label)).toEqual(['Add as a server', 'Connect it instead']);
    expect(actions[0]?.href).toContain('address=10.0.0.5');
  });

  it('makes an open OAuth card with returnTo and Not now when OAuth is available', () => {
    const returnTo = '/burrow-hq/chat?thread=msg_root&guide=msg_card';
    const card = connectCard(entry('notion'), {
      url: null,
      found: false,
      access: 'read',
      agent: 'Dusty',
      returnTo,
      oauthMethod: 'mcp_oauth',
    });
    expect(GuideCard.parse(card)).toEqual(card);
    expect(card.state).toBe('open');
    expect(card.connectOAuth).toEqual({
      catalogId: 'notion',
      method: 'mcp_oauth',
      access: 'read',
      returnTo,
    });
    const actions = card.blocks.flatMap((b) => (b.type === 'actions' ? b.actions : []));
    expect(actions.map((a) => a.id)).toEqual(['connect', CONNECT_HERE_DECLINE]);
    expect(actions[0]?.href).toContain(`returnTo=${encodeURIComponent(returnTo)}`);
  });

  it('parses guide return paths for chat, feedback, task chats and rejects non-conversation paths', () => {
    expect(parseGuideReturn('/burrow-hq/chat?thread=msg_root&guide=msg_card1')).toEqual({
      slug: 'burrow-hq',
      messageId: 'msg_card1',
    });
    expect(parseGuideReturn('/burrow-hq/feedback?thread=msg_root&guide=msg_card2')).toEqual({
      slug: 'burrow-hq',
      messageId: 'msg_card2',
    });
    expect(parseGuideReturn('/chat?burrow=burrow-hq&thread=msg_root&guide=msg_card3')).toEqual({
      slug: 'burrow-hq',
      messageId: 'msg_card3',
    });
    expect(parseGuideReturn('/burrow-hq/settings?tab=connections&guide=msg_card4')).toBeNull();
  });
});

describe('servers found on the network (connect-in-chat.md)', () => {
  it('reads the system from the SSH greeting', () => {
    expect(readSshBanner('SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3')).toEqual({ system: 'Debian' });
    expect(readSshBanner('SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.10')).toEqual({ system: 'Ubuntu' });
    expect(readSshBanner('SSH-2.0-OpenSSH_9.7')).toEqual({ system: null });
    // Routers and appliances: not a computer Whombat's helper runs on.
    expect(readSshBanner('SSH-2.0-dropbear_2022.83')).toBeNull();
    expect(readSshBanner('HTTP/1.1 400 Bad Request')).toBeNull();
  });

  it('shows one row per machine', () => {
    const found = [
      { catalogId: 'server', host: '10.0.0.5', port: 22 },
      { catalogId: 'proxmox', host: '10.0.0.5', port: 8006 },
      { catalogId: 'server', host: '10.0.0.6', port: 22 },
      { catalogId: 'plex', host: '10.0.0.6', port: 32400 },
      { catalogId: 'server', host: '10.0.0.7', port: 22 },
      { catalogId: 'unifi_network', host: '10.0.0.7', port: 443 },
    ];
    expect(withoutDoubleServers(found).map((f) => `${f.catalogId}@${f.host}`)).toEqual([
      'proxmox@10.0.0.5',
      'server@10.0.0.6',
      'plex@10.0.0.6',
      'unifi_network@10.0.0.7',
    ]);
  });

  it('knows a server that is added already', () => {
    const servers = [{ id: 'pve-01', host: '10.0.0.5' }];
    expect(serversAt({ catalogId: 'server', host: '10.0.0.5' }, servers)).toEqual(['pve-01']);
    expect(serversAt({ catalogId: 'proxmox', host: '10.0.0.5' }, servers)).toEqual(['pve-01']);
    // A service on that machine is still found: it is connected, not added.
    expect(serversAt({ catalogId: 'plex', host: '10.0.0.5' }, servers)).toEqual([]);
  });

  it('names and places a found server', () => {
    const server = { catalogId: 'server', host: '10.0.0.6', port: 22, version: 'Debian' };
    expect(foundName(server)).toBe('Debian server');
    expect(foundTagline(server)).toBe('A computer Whombat can look after');
    expect(foundAddress(server, [server])).toBe('10.0.0.6');
    expect(
      orderFound([{ catalogId: 'plex', host: '10.0.0.1', port: 32400 }, server]).map((f) => f.catalogId),
    ).toEqual(['server', 'plex']);
  });
});
