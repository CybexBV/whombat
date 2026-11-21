import { LINK_OFFER_TEXT, LINK_PRICE_TEXT, LINK_PRICE_YEAR_TEXT } from '@whombat/protocol';
import { TAILSCALE_OFF } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { OperationError } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import type { KnownAppliance } from './registry';
import {
  addressRowView,
  BOX_APP_STEPS,
  boxClaimSteps,
  boxSetupAiKicker,
  boxSetupSteps,
  CHANNEL_TEXT,
  channelErrorText,
  channelView,
  KNOWN_BOXES_TEXT,
  knownBoxRows,
  knownSummaries,
  type LinkSummary,
  linkBannerView,
  linkPageText,
  linkPollMs,
  linkRowView,
  REACH_CHOICE_TEXT,
  REACH_TEXT,
  readReach,
  tailscalePageName,
  tailscaleRowView,
  timeLeft,
  whombatLinkErrorText,
} from './whombat-link';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const SINCE = '2026-11-18T11:00:00Z';
const TS_ON = { ...TAILSCALE_OFF, state: 'on' as const, name: 'home.tail1234.ts.net', https: true };

const link = (over: Partial<LinkSummary>): LinkSummary => ({ state: 'off', since: SINCE, ...over });

function sessionAnswering(status: number, body: unknown): ApplianceSession {
  return { invoke: async () => ({ status, body }) } as unknown as ApplianceSession;
}

describe('readReach', () => {
  it('reads null from a box before Link', async () => {
    const s = sessionAnswering(404, { error: { code: 'unknown_op', message: 'No operation reach.get' } });
    await expect(readReach(s)).resolves.toBeNull();
  });
  it('throws anything else', async () => {
    const s = sessionAnswering(500, { error: { code: 'failed', message: 'x' } });
    await expect(readReach(s)).rejects.toBeInstanceOf(OperationError);
  });
  it('reads the answer', async () => {
    const s = sessionAnswering(200, { link: link({ state: 'on' }), ownAddress: null, tailscale: null });
    await expect(readReach(s)).resolves.toMatchObject({ link: { state: 'on' } });
  });
});

describe('linkRowView', () => {
  it('offers turning Link on when off, but not on the iPhone', () => {
    const off = linkRowView(link({}), { offerLink: true, now: NOW });
    expect(off).toMatchObject({ tone: 'mut', title: REACH_TEXT.link.off, action: 'on', more: true });
    expect(off.meta).toBe(LINK_OFFER_TEXT);
    const ios = linkRowView(link({}), { offerLink: false, now: NOW });
    expect(ios.action).toBeNull();
    expect(ios.meta).not.toMatch(/app\.whombat\.com|€/);
    // What Link gives is no price: the iPhone says it too.
    expect(ios.more).toBe(true);
    expect(linkRowView(link({ state: 'on' }), { offerLink: true, now: NOW }).more).toBe(false);
  });

  it('shows the code and where to type it while Link starts', () => {
    const v = linkRowView(
      link({
        state: 'starting',
        pending: {
          code: 'ABCD-EFGH',
          url: 'https://app.whombat.com/link',
          expiresAt: '2026-11-18T12:10:00Z',
        },
      }),
      { offerLink: true, now: NOW },
    );
    expect(v.code).toMatchObject({
      code: 'ABCD-EFGH',
      where: 'app.whombat.com/link',
      url: 'https://app.whombat.com/link?code=ABCD-EFGH',
      left: '10:00',
    });
    expect(v.meta).toContain('Open app.whombat.com/link and enter ABCD-EFGH.');
    expect(v.action).toBe('cancel');
  });

  it('asks for a new code once it ran out', () => {
    const v = linkRowView(
      link({
        state: 'starting',
        pending: {
          code: 'ABCD-EFGH',
          url: 'https://app.whombat.com/link',
          expiresAt: '2026-11-18T11:59:00Z',
        },
      }),
      { offerLink: true, now: NOW },
    );
    expect(v.action).toBe('newCode');
    expect(v.code?.left).toBeNull();
  });

  it('says it waits for an address when the day ran out', () => {
    const v = linkRowView(link({ state: 'starting', waitingForAddress: true }), {
      offerLink: true,
      now: NOW,
    });
    expect(v.title).toBe(REACH_TEXT.link.waitingAddress);
    expect(v.action).toBeNull();
  });

  it('never shows the code on the iPhone', () => {
    const v = linkRowView(
      link({
        state: 'starting',
        pending: {
          code: 'ABCD-EFGH',
          url: 'https://app.whombat.com/link',
          expiresAt: '2026-11-18T12:10:00Z',
        },
      }),
      { offerLink: false, now: NOW },
    );
    expect(v.code).toBeNull();
    expect(v.meta).not.toContain('app.whombat.com');
  });

  it('says the free month while it runs', () => {
    const v = linkRowView(
      link({ state: 'on', trialEndsAt: '2026-12-18T12:00:00Z', email: 'mara@example.com' }),
      {
        offerLink: true,
        now: NOW,
      },
    );
    expect(v).toMatchObject({ tone: 'ok', action: 'off' });
    expect(v.meta).toContain('18 Dec');
    expect(v.meta).toContain('mara@example.com');
  });

  it('says when Link ends and what still works', () => {
    const grace = linkRowView(link({ state: 'grace', graceEndsAt: '2026-11-25T12:00:00Z' }), {
      offerLink: true,
      now: NOW,
    });
    expect(grace.title).toContain('25 Nov');
    expect(grace.tone).toBe('warn');
    const ended = linkRowView(link({ state: 'ended' }), { offerLink: false, now: NOW });
    expect(ended).toMatchObject({ tone: 'bad', title: REACH_TEXT.link.ended, action: null });
    expect(ended.meta).toContain('Tailscale');
    expect(ended.meta).not.toContain('app.whombat.com');
  });
});

describe('linkBannerView', () => {
  it('shows nothing while Link is on or off', () => {
    expect(linkBannerView({ link: link({ state: 'on' }), tailscale: TAILSCALE_OFF })).toBeNull();
    expect(linkBannerView({ link: null, tailscale: TAILSCALE_OFF })).toBeNull();
    expect(linkBannerView(null)).toBeNull();
  });
  it('offers Tailscale in grace and after', () => {
    const grace = linkBannerView({
      link: link({ state: 'grace', graceEndsAt: '2026-11-25T12:00:00Z' }),
      tailscale: TAILSCALE_OFF,
    });
    expect(grace).toMatchObject({ tone: 'warn', tailscale: true });
    expect(grace?.text).toContain('25 Nov');
    expect(linkBannerView({ link: link({ state: 'ended' }), tailscale: TAILSCALE_OFF })).toMatchObject({
      tone: 'bad',
      tailscale: true,
    });
  });
  it('drops the offer once Tailscale is on, or where there is none', () => {
    expect(linkBannerView({ link: link({ state: 'ended' }), tailscale: TS_ON })?.tailscale).toBe(false);
    expect(linkBannerView({ link: link({ state: 'ended' }), tailscale: null })?.tailscale).toBe(false);
  });
});

describe('words and small parts', () => {
  it('says Easy and Expert as the installer does, the price from the one offer sentence', () => {
    const { easy, expert } = REACH_CHOICE_TEXT;
    expect(easy.label).toBe(`${easy.kind} · ${easy.name}`);
    expect(expert.label).toBe(`${expert.kind} · ${expert.name}`);
    expect(easy.price).toBe(LINK_OFFER_TEXT);
    expect(easy.price).toContain(LINK_PRICE_TEXT);
    expect(easy.price).toContain(LINK_PRICE_YEAR_TEXT);
    expect(easy.points).toHaveLength(6);
    expect(expert.points).toHaveLength(2);
    expect([...easy.points, ...expert.points, expert.line].join(' ')).not.toMatch(/€/);
    // The setup's one-time card is Easy's.
    expect(REACH_TEXT.offer).toMatchObject({ title: easy.label, tag: easy.tag, price: LINK_OFFER_TEXT });
  });
  it('reads link errors', () => {
    const e = (code: string) => new OperationError('link.on', 409, 'conflict', 'x', { code });
    expect(whombatLinkErrorText(e('whombat_link_busy'))).toBe(REACH_TEXT.link.errors.busy);
    expect(whombatLinkErrorText(e('control_unreachable'))).toBe(REACH_TEXT.link.errors.unreachable);
    expect(whombatLinkErrorText(new Error('x'))).toBe(REACH_TEXT.link.errors.failed);
    expect(channelErrorText(e('update_channel_unavailable'))).toMatch(/can’t choose/);
  });
  it('polls only while Link starts', () => {
    expect(linkPollMs(link({ state: 'starting' }))).toBe(3_000);
    expect(linkPollMs(link({ state: 'starting', waitingForAddress: true }))).toBe(60_000);
    expect(linkPollMs(link({ state: 'on' }))).toBeNull();
  });
  it('reads Tailscale, the link page and the time left', () => {
    expect(tailscaleRowView(TS_ON)).toMatchObject({ on: true, tone: 'ok' });
    expect(tailscaleRowView(TAILSCALE_OFF)).toMatchObject({ on: false, tone: 'mut' });
    expect(tailscaleRowView(null)).toBeNull();
    expect(linkPageText('https://app.whombat.com/link')).toBe('app.whombat.com/link');
    expect(timeLeft('2026-11-18T12:00:05Z', NOW)).toBe('0:05');
    expect(timeLeft('2026-11-18T11:00:00Z', NOW)).toBeNull();
  });
  it('says when a switch to Production waits', () => {
    expect(channelView({ channel: 'production', staysOn: 'whombat-20261118.2' }).meta).toContain(
      'whombat-20261118.2',
    );
    expect(channelView({ channel: 'development' }).channel).toBe('development');
  });
  it('calls the development channel Beta; the wire name stays', () => {
    expect(CHANNEL_TEXT.development).toBe('Beta');
    expect(CHANNEL_TEXT.switched('development')).toContain('Beta');
    expect(CHANNEL_TEXT.switched('production')).toContain('Production');
    expect(
      Object.values(CHANNEL_TEXT)
        .filter((w) => typeof w === 'string')
        .join(' '),
    ).not.toContain('Development');
  });
});

describe('the setup', () => {
  it('makes the passkey at the address and asks about reach elsewhere', () => {
    expect(boxSetupSteps({ atAddress: true })).toEqual([
      'claim',
      'account',
      'passkey',
      'backups',
      'name',
      'ai',
      'agent',
    ]);
    expect(boxSetupSteps({ atAddress: false }).slice(0, 4)).toEqual(['claim', 'account', 'reach', 'backups']);
  });
  it('counts on into the app’s setup: one count from the claim to the agent', () => {
    expect(boxSetupSteps({ atAddress: true })).toEqual([
      ...boxClaimSteps({ atAddress: true }),
      ...BOX_APP_STEPS,
    ]);
    expect(boxSetupAiKicker()).toBe('STEP 6 OF 7');
  });
  it('knows a Tailscale page', () => {
    expect(tailscalePageName('home.tail1234.ts.net')).toBe('home.tail1234.ts.net');
    expect(tailscalePageName('abcd.box.whombat.app')).toBeNull();
  });
});

describe('knownBoxRows', () => {
  const box = (device: string, over: Partial<KnownAppliance> = {}): KnownAppliance => ({
    device,
    orgId: 'community',
    name: null,
    peerId: device,
    pinSource: 'add-link',
    enrolled: true,
    kitPending: false,
    ...over,
  });
  it('lists this device’s boxes, the open one first, with where each opens', () => {
    const rows = knownBoxRows(
      [
        box('b', { name: 'Zoo', ownAddress: 'https://zoo1.box.whombat.app/' }),
        box('a', { name: 'Home' }),
        box('c', { name: 'Cabin', enrolled: false }),
      ],
      'a',
    );
    expect(rows.map((r) => r.device)).toEqual(['a', 'c', 'b']);
    expect(rows[0]?.meta).toBe(KNOWN_BOXES_TEXT.here);
    expect(rows[1]?.meta).toBe(KNOWN_BOXES_TEXT.notIn);
    expect(rows[2]).toMatchObject({ web: 'https://zoo1.box.whombat.app/', meta: 'zoo1.box.whombat.app' });
  });
});

describe('addressRowView', () => {
  it('says the address is coming while Link runs, and that it comes with Link otherwise', () => {
    const base = { ownAddress: null, tailscale: null };
    expect(addressRowView({ ...base, link: link({ state: 'on' }) })?.title).toBe(REACH_TEXT.address.coming);
    expect(addressRowView({ ...base, link: link({ state: 'off' }) })?.title).toBe(REACH_TEXT.address.none);
    expect(addressRowView({ ...base, link: null })).toBeNull();
  });

  it('leaves out “it comes with Link” where Link isn’t offered (the iPhone)', () => {
    const base = { ownAddress: null, tailscale: null };
    const plain = { offerLink: false };
    expect(addressRowView({ ...base, link: link({ state: 'off' }) }, plain)).toBeNull();
    expect(addressRowView({ ...base, link: link({ state: 'ended' }) }, plain)).toBeNull();
    expect(addressRowView({ ...base, link: link({ state: 'starting' }) }, plain)?.title).toBe(
      REACH_TEXT.address.coming,
    );
  });
});

describe('the switcher from this device’s boxes (LNK-43)', () => {
  it('lists the boxes it is let in to, each saying where it opens', async () => {
    const { switcherRows } = await import('./switcher');
    const known: KnownAppliance[] = [
      {
        device: 'a',
        orgId: 'community',
        name: 'Home',
        peerId: 'a',
        pinSource: 'add-link',
        enrolled: true,
        kitPending: false,
      },
      {
        device: 'b',
        orgId: 'community',
        name: 'Cabin',
        peerId: 'b',
        pinSource: 'box',
        enrolled: true,
        kitPending: false,
        ownAddress: 'https://maple-otter-river.box.whombat.app/',
      },
      {
        device: 'c',
        orgId: 'community',
        name: 'Old',
        peerId: 'c',
        pinSource: 'box',
        enrolled: false,
        kitPending: false,
      },
    ];
    const list = knownSummaries(known);
    expect(list.map((a) => a.device)).toEqual(['a', 'b']);
    const rows = switcherRows(list, {
      current: 'a',
      known: (d) => known.find((k) => k.device === d),
      local: true,
    });
    expect(rows.map((r) => [r.name, r.meta])).toEqual([
      ['Home', 'This Whombat'],
      ['Cabin', 'maple-otter-river.box.whombat.app'],
    ]);
  });
});
