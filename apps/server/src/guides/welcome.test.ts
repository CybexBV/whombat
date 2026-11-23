/**
 * The welcome built from what the box found (docs/decisions/first-day.md): what the finds are called, the buttons each
 * one gets, mail second, and the welcome when nothing was found yet. Facts, not sentences: names, links, ids.
 */
import { GuideCard } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import * as copy from './copy';
import { actionable, type GuideFacts, type GuidePost, materialize } from './flows';
import {
  findActions,
  foundLaterSteps,
  foundPhrase,
  IMAP_HREF,
  spokenFind,
  type WelcomeFind,
  welcomeSteps,
} from './welcome';

const facts = { personName: 'Mara', agentName: 'Dusty' } as GuideFacts;
let n = 0;
const post = (steps: Parameters<typeof materialize>[0]): GuidePost[] =>
  materialize(steps, facts, () => `msg_welcome${++n}`);
const cardOf = (p: GuidePost | undefined): GuideCard => {
  if (!p?.card) throw new Error('no card');
  // As stored and as read back.
  expect(GuideCard.parse(JSON.parse(JSON.stringify(p.card)))).toEqual(p.card);
  return p.card;
};
const actionsOf = (card: GuideCard) => card.blocks.flatMap((b) => (b.type === 'actions' ? b.actions : []));

const find = (catalogId: string, host: string, port: number, version: string | null = null): WelcomeFind => ({
  catalogId,
  host,
  port,
  url: catalogId === 'server' ? `ssh://${host}` : `https://${host}:${port}`,
  version,
});
const ha = find('homeassistant', '192.168.1.20', 8123);
const unifi = find('unifi_network', '192.168.1.1', 443);
const debian = find('server', '192.168.1.30', 22, 'Debian');

describe('what the finds are called', () => {
  it('says them as people do: a name stays a name, a product becomes what it is', () => {
    expect(spokenFind(ha)[0]).toBe('Home Assistant');
    expect(spokenFind(unifi)[0]).toBe('a UniFi gateway');
    expect(spokenFind(debian)[0]).toBe('a Debian server');
    expect(spokenFind(find('server', '192.168.1.31', 22))[0]).toBe('a server');
    expect(spokenFind(find('synology', '192.168.1.40', 5001))[0]).toBe('a Synology NAS');
  });

  it('names up to three kinds, counts one found twice, and says “like” beyond three', () => {
    expect(foundPhrase([ha, unifi, debian])).toBe('Home Assistant, a UniFi gateway and a Debian server');
    const pve = [find('proxmox', '10.0.0.240', 8006), find('proxmox', '10.0.0.241', 8006)];
    expect(foundPhrase([ha, ...pve])).toBe('Home Assistant and two Proxmox servers');
    const many = foundPhrase([
      ha,
      unifi,
      debian,
      find('plex', '10.0.0.9', 32400),
      find('pihole', '10.0.0.3', 80),
    ]);
    expect(many).toMatch(/^5 things, like /);
    expect(many).toContain('Home Assistant');
    expect(many).not.toContain('Plex');
  });
});

describe('the finds’ buttons', () => {
  it('opens the connect form filled in, or Add a server for a computer and a hypervisor', () => {
    const [connectHa, connectUnifi, addDebian] = findActions([ha, unifi, debian]);
    expect(connectHa).toMatchObject({ label: 'Connect Home Assistant', style: 'primary' });
    expect(connectHa?.href).toContain('connection=homeassistant');
    expect(connectHa?.href).toContain(encodeURIComponent(ha.url));
    expect(connectHa?.href).toContain('access=manage');
    expect(connectUnifi?.label).toBe('Connect the UniFi gateway');
    expect(connectUnifi?.href).toContain('access=read');
    expect(addDebian?.label).toBe('Add the Debian server');
    expect(addDebian?.href).toBe('/things/servers?add=1&address=192.168.1.30');
    const [pve] = findActions([find('proxmox', '10.0.0.240', 8006)]);
    expect(pve?.href).toContain('/things/servers?add=1');
  });

  it('tells two of the same apart by address, and folds the rest into See all', () => {
    const two = findActions([find('proxmox', '10.0.0.240', 8006), find('proxmox', '10.0.0.241', 8006)]);
    expect(two.map((a) => a.label)).toEqual([
      'Add the Proxmox server at 10.0.0.240',
      'Add the Proxmox server at 10.0.0.241',
    ]);
    const five = findActions([
      ha,
      unifi,
      debian,
      find('plex', '10.0.0.9', 32400),
      find('pihole', '10.0.0.3', 80),
    ]);
    expect(five).toHaveLength(4);
    expect(five.at(-1)).toMatchObject({
      id: 'see_all',
      label: 'See all 5',
      href: expect.stringContaining('found=1'),
    });
    for (const a of five) expect(a.label.length).toBeLessThanOrEqual(40);
  });
});

describe('the welcome', () => {
  it('names the finds first, with a button each and nothing to answer, then offers mail', () => {
    const [found, mail] = post(welcomeSteps({ finds: [ha, unifi, debian], looking: false }));
    expect(found?.text).toContain('Mara');
    expect(found?.text).toContain('Dusty');
    expect(found?.text).toContain('Home Assistant, a UniFi gateway and a Debian server');
    const card = cardOf(found);
    expect(card).toMatchObject({ guide: 'welcome', node: 'found', state: 'done' });
    expect(actionsOf(card)).toHaveLength(3);
    expect(actionsOf(card).every((a) => a.href)).toBe(true);
    const mailCard = cardOf(mail);
    expect(mailCard).toMatchObject({ guide: 'welcome', node: 'mail', state: 'open' });
    expect(actionable(mailCard)).toBe(true);
    // Other email first, Google reachable after it.
    expect(actionsOf(mailCard).map((a) => a.id)).toEqual(['imap', 'google', 'later']);
    expect(actionsOf(mailCard)[0]).toMatchObject({ label: copy.MAIL_OTHER, href: IMAP_HREF });
    // Plain words on the button: no protocol name.
    expect(actionsOf(mailCard)[0]?.label).not.toMatch(/IMAP/);
  });

  it('says one find as it', () => {
    const [found] = post(welcomeSteps({ finds: [ha], looking: false }));
    expect(found?.text).toMatch(/look after it\?$/);
    expect(cardOf(found).body).toBe(copy.foundBody(true));
  });

  it('with nothing found yet says what it can do and that the finds come later; then mail', () => {
    const [hello, mail] = post(welcomeSteps({ finds: [], looking: true }));
    expect(hello?.card).toBeNull();
    expect(hello?.text).toContain('Dusty');
    expect(hello?.text).toContain('looking around your network');
    expect(cardOf(mail).node).toBe('mail');
    const [quiet] = post(welcomeSteps({ finds: [], looking: false }));
    expect(quiet?.text).not.toContain('looking around');
  });

  it('brings the finds that come later as one message with the same buttons', () => {
    expect(foundLaterSteps([])).toEqual([]);
    const [later] = post(foundLaterSteps([ha, debian]));
    expect(later?.text).toContain('Home Assistant and a Debian server');
    expect(later?.text).not.toContain('Mara');
    expect(actionsOf(cardOf(later)).map((a) => a.label)).toEqual([
      'Connect Home Assistant',
      'Add the Debian server',
    ]);
  });
});
