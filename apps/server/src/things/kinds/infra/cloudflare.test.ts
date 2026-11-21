/** Cloudflare's page from documented API v4 answers (service-dashboards.md SD-43, SD-S16). Pure. */
import { ThingPageKpi, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { slotProblems } from '../slots';
import {
  type CfSnapshot,
  type CfZone,
  CLOUDFLARE_CHECKS,
  cloudflareCardView,
  cloudflareKpis,
  cloudflareNotices,
  cloudflareSkipped,
  cloudflareStatus,
  cloudflareView,
  compact,
  markDegraded,
  parseCertificatePacks,
  parseConnections,
  parseTraffic,
  parseTunnels,
  parseZones,
  purgeButton,
  SUMMARY_SITES,
  signInView,
  trafficHours,
  viaToken,
  zoneRows,
} from './cloudflare';
import {
  CF_CERTIFICATE_PACKS,
  CF_CONNECTIONS,
  CF_GRAPHQL_ADAPTIVE,
  CF_GRAPHQL_HOURLY,
  CF_GRAPHQL_REFUSED,
  CF_TUNNELS,
  CF_ZONES,
} from './fixtures/cloudflare';
import { buttonsOf } from './fixtures/row';

const NOW = new Date('2026-10-21T11:30:00Z');
const ZONE = '023e105f4ecef8ad9ca31a8372d0c353';
const ACCOUNT = '01a7362d577a6c3019a474fd6f485823';

function snapshot(): CfSnapshot {
  const { zones, total } = parseZones(CF_ZONES);
  const tunnels = parseTunnels(CF_TUNNELS, ACCOUNT);
  Object.assign(tunnels[0] as object, parseConnections(CF_CONNECTIONS));
  return {
    readAt: NOW,
    zones,
    zonesTotal: total,
    traffic: parseTraffic(CF_GRAPHQL_HOURLY, NOW),
    tunnels,
    certificates: [parseCertificatePacks(CF_CERTIFICATE_PACKS, ZONE)].filter((c) => c !== null),
  };
}

describe('cloudflare reading', () => {
  it('reads zones, tunnels and their connections', () => {
    const s = snapshot();
    expect(s.zones.map((z) => [z.name, z.status, z.plan])).toEqual([
      ['example.com', 'active', 'Free Website'],
      ['example.org', 'pending', 'Free Website'],
    ]);
    expect(s.tunnels?.map((t) => [t.name, t.status, t.connections])).toEqual([
      ['home', 'healthy', 3],
      ['office', 'down', null],
      ['test', 'inactive', null],
    ]);
    expect(s.tunnels?.[0]?.colos).toEqual(['AMS01', 'AMS08', 'FRA08']);
    expect(s.certificates?.[0]?.expires?.toISOString()).toBe('2026-10-30T00:00:00.000Z');
  });

  it('lays traffic on the last 24 hours, or falls back when refused', () => {
    const hours = trafficHours(NOW);
    expect(hours).toHaveLength(24);
    expect(new Date(hours[23] as number).toISOString()).toBe('2026-10-21T11:00:00.000Z');
    const t = parseTraffic(CF_GRAPHQL_HOURLY, NOW)?.get(ZONE);
    expect(t).toMatchObject({ requests: 2000, cached: 1400, threats: 4 });
    expect(t?.hourly.slice(-2)).toEqual([1200, 800]);
    expect(parseTraffic(CF_GRAPHQL_REFUSED, NOW)).toBeNull();
    const adaptive = parseTraffic(CF_GRAPHQL_ADAPTIVE, NOW)?.get(ZONE);
    expect(adaptive).toMatchObject({ requests: 1000, cached: 600, threats: null });
  });
});

describe('cloudflare page', () => {
  it('has four figures', () => {
    const kpis = cloudflareKpis(snapshot());
    for (const k of kpis) ThingPageKpi.parse(k);
    expect(kpis.map((k) => [k.key, k.value, k.rest ?? null, k.tone ?? null])).toEqual([
      ['requests', '2,000', 'in 24 h', null],
      ['cached', '70 %', null, null],
      ['threats', '4', 'in 24 h', null],
      ['tunnels', '1', 'of 2 healthy', 'bad'],
    ]);
    expect(compact(12_400)).toBe('12.4 k');
    expect(compact(1_250_000)).toBe('1.3 M');
  });

  it('says what is worth a look', () => {
    const notices = cloudflareNotices(snapshot(), NOW);
    for (const n of notices) ThingPageNotice.parse(n);
    expect(notices.map((n) => [n.id.split('-').slice(0, 2).join('-'), n.tone])).toEqual([
      ['tunnel-down', 'bad'],
      [`cert-${ZONE}`, 'warn'],
      ['zone-9a7806061c88ada191ed06f989cc3dac', 'warn'],
    ]);
    expect(notices.map((n) => [n.check, n.nature, n.subject?.id.split(':')[0], n.ignore?.lifts])).toEqual([
      ['cloudflare.tunnel_down', 'problem', 'tunnel', 'fixed'],
      ['cloudflare.cert', 'problem', 'site', 'newer'],
      ['cloudflare.zone', 'you', 'site', 'newer'],
    ]);
    expect(notices[0]).toMatchObject({ badge: 'Tunnel office down', link: { kind: 'ask' } });
    // The certificate's end date is its episode: a renewed one is news.
    expect(notices[1]?.episode).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(notices[2]).toMatchObject({ episode: 'pending', link: { kind: 'url' } });
    // The lines decide warn and bad (QN-S30): the head only counts the sites.
    expect(cloudflareStatus(snapshot())).toEqual({ status: 'ok', badge: '2 sites' });
    for (const n of notices) expect(CLOUDFLARE_CHECKS.map((c) => c.check)).toContain(n.check);
  });

  it('calls a tunnel down for a month retired, and a short degradation a heads-up', () => {
    const s = snapshot();
    const office = s.tunnels?.find((t) => t.status === 'down');
    if (!office) throw new Error('tunnel');
    office.inactiveAt = new Date(NOW.getTime() - 40 * 86_400_000);
    expect(cloudflareNotices(s, NOW)[0]).toMatchObject({
      nature: 'fyi',
      tone: 'info',
      link: { kind: 'url' },
    });
    const degraded = { ...office, id: 'deg', name: 'lab', status: 'degraded' as const, inactiveAt: null };
    markDegraded('con_cf', [degraded], new Date(NOW.getTime() - 10 * 60_000));
    const short = cloudflareNotices({ ...s, tunnels: [degraded] }, NOW);
    expect(short[0]).toMatchObject({ check: 'cloudflare.tunnel_degraded', nature: 'fyi', tone: 'info' });
    markDegraded('con_cf', [degraded], NOW);
    const later = cloudflareNotices({ ...s, tunnels: [degraded] }, new Date(NOW.getTime() + 25 * 60_000));
    expect(later[0]).toMatchObject({ nature: 'problem', tone: 'warn', link: { kind: 'ask' } });
    // Healthy again: forgotten, so the next time starts over.
    markDegraded('con_cf', [{ ...degraded, status: 'healthy' }], NOW);
    markDegraded('con_cf', [degraded], NOW);
    expect(degraded.degradedSince).toEqual(NOW);
  });

  it('says which checks it couldn’t read', () => {
    const s = snapshot();
    expect(cloudflareSkipped(s)).toEqual([]);
    expect(cloudflareSkipped({ ...s, domainExpirations: null })).toEqual(['cloudflare.domain_expiring']);
    expect(cloudflareSkipped({ ...s, domainExpirationsPartial: true })).toEqual(['cloudflare.domain_expiring']);
    expect(cloudflareSkipped({ ...s, tunnels: null, certificatesPartial: true, zonesTotal: 40 })).toEqual([
      'cloudflare.tunnel_down',
      'cloudflare.tunnel_degraded',
      'cloudflare.cert',
      'cloudflare.cert',
      'cloudflare.domain_expiring',
      'cloudflare.zone',
      'cloudflare.paused',
    ]);
  });

  it('warns when a domain registration is expiring via RDAP and starts off by default', () => {
    const check = CLOUDFLARE_CHECKS.find((c) => c.check === 'cloudflare.domain_expiring');
    expect(check).toMatchObject({ nature: 'you', perItem: true, startsOn: false });

    const s = snapshot();
    const soon = new Date(NOW.getTime() + 12 * 86_400_000);
    const expired = new Date(NOW.getTime() - 2 * 86_400_000);
    const far = new Date(NOW.getTime() + 90 * 86_400_000);

    const warnNotices = cloudflareNotices(
      { ...s, domainExpirations: new Map([['example.com', soon], ['example.org', far]]) },
      NOW,
    ).filter((n) => n.check === 'cloudflare.domain_expiring');
    expect(warnNotices).toHaveLength(1);
    for (const n of warnNotices) ThingPageNotice.parse(n);
    expect(warnNotices[0]).toMatchObject({
      tone: 'warn',
      nature: 'you',
      subject: { id: `site:${ZONE}`, name: 'example.com' },
      episode: soon.toISOString(),
      ignore: { lifts: 'newer' },
    });
    expect(warnNotices[0]?.title).toContain('example.com');
    expect(warnNotices[0]?.detail).toContain('registrar');

    const badNotices = cloudflareNotices(
      { ...s, domainExpirations: new Map([['example.com', expired]]) },
      NOW,
    ).filter((n) => n.check === 'cloudflare.domain_expiring');
    expect(badNotices[0]).toMatchObject({ tone: 'bad', check: 'cloudflare.domain_expiring' });

    // Moved zones are skipped.
    const moved = { ...s, zones: s.zones.map((z) => ({ ...z, status: 'moved' })) };
    expect(
      cloudflareNotices({ ...moved, domainExpirations: new Map([['example.com', soon]]) }, NOW).filter(
        (n) => n.check === 'cloudflare.domain_expiring',
      ),
    ).toEqual([]);
  });

  it('has Clear cache✱ per site', () => {
    const rows = zoneRows(snapshot(), buttonsOf('cloudflare'));
    expect(rows[0]?.cells.purge?.action).toMatchObject({ action: 'purge', target: ZONE, allowed: true });
    expect(rows[0]?.cells.requests?.spark).toHaveLength(24);
    const z = snapshot().zones[0];
    if (!z) throw new Error('zone');
    expect(purgeButton(buttonsOf('cloudflare'), z).confirm).toBeDefined();
  });

  it('builds its Summary in slots: tunnels now, sites, the last 24 hours', () => {
    const view = cloudflareView({
      snapshot: snapshot(),
      now: NOW,
      timeZone: 'UTC',
      ...buttonsOf('cloudflare'),
    });
    for (const p of view.panels) ThingPagePanel.parse(p);
    expect(slotProblems(view)).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['tunnels', 'inventory', 'requests', 'tunnels-unused']);
    // A cloud service: no machine card.
    expect(view.slots?.machine).toEqual([]);
    const live = view.panels[0];
    if (live?.kind !== 'list') throw new Error('live');
    // Down first, with its words; the healthy one says where it lands and how many connections it has.
    expect(live.items.map((i) => [i.title, i.figure?.value, i.figure?.note, i.figure?.tone ?? null])).toEqual(
      [
        ['office', '0', 'Down', 'bad'],
        ['home', '3', 'connections', null],
      ],
    );
    expect(live.items[1]?.detail).toContain('AMS01');
    // Its words on the right, its state as the line's colour.
    expect(live.items.map((i) => [i.right, i.tone])).toEqual([
      ['Down', 'bad'],
      ['3 connections', 'ok'],
    ]);
    expect(live.meta).toBe('1 down · 1 healthy');
    const sites = view.panels[1];
    if (sites?.kind !== 'list') throw new Error('sites');
    expect(sites.items.map((i) => [i.title, i.figure?.value, i.figure?.note])).toEqual([
      ['example.com', '2,000', 'requests'],
      ['example.org', '—', 'Waiting for name servers'],
    ]);
    expect(sites.items[0]?.detail).toBe('70 % from cache · 4 threats');
    expect(sites.items[0]?.actions?.[0]).toMatchObject({ action: 'purge', target: ZONE });
    const week = view.panels[2];
    if (week?.kind !== 'chart') throw new Error('trend');
    expect(week.labels).toHaveLength(week.timestamps.length);
    expect(week.labels?.at(-1)).toBe('Now');
    expect(week.series[0]?.values.reduce<number>((a, b) => a + (b ?? 0), 0)).toBe(2000);
    expect(week.figure).toEqual({ value: '2,000', rest: 'requests' });
    expect(week.stats?.map((l) => l.map((x) => x.text).join(''))).toEqual([
      '70 % from cache',
      '4 threats stopped',
    ]);
    expect(view.tabs).toEqual([]);
    expect(view.kpis).toEqual([]);
  });

  it('keeps the figures on the card and leaves empty slots out', () => {
    const s = snapshot();
    expect(
      cloudflareCardView({ snapshot: s, now: NOW, ...buttonsOf('cloudflare') }).kpis?.map((k) => k.key),
    ).toEqual(['requests', 'cached', 'threats', 'tunnels']);
    // Only DNS, no tunnels and no traffic read: the sites alone.
    const bare = cloudflareView({
      snapshot: { ...s, tunnels: null, traffic: null },
      now: NOW,
      ...buttonsOf('cloudflare'),
    });
    expect(slotProblems(bare)).toEqual([]);
    expect(bare.panels.map((p) => p.id)).toEqual(['inventory']);
    // Many sites: the busiest six on the Summary, every one in the Sites tab.
    const many = Array.from({ length: 9 }, (_, i) => ({
      ...(s.zones[0] as CfZone),
      id: `z${i}`,
      name: `site${i}.com`,
    }));
    const lots = cloudflareView({
      snapshot: { ...s, zones: many, zonesTotal: 9 },
      now: NOW,
      ...buttonsOf('cloudflare'),
    });
    const inv = lots.panels.find((p) => p.id === 'inventory');
    expect(inv?.kind === 'list' && inv.items.length).toBe(SUMMARY_SITES);
    expect(inv?.kind === 'list' && inv.link).toMatchObject({ kind: 'tab', tab: 'sites' });
    expect(lots.tabs.map((t) => [t.key, t.panels[0]?.id])).toEqual([['sites', 'sites']]);
  });

  it('asks an MCP connection for a token in a calm line', () => {
    expect(viaToken({ signIn: 'token' })).toBe(true);
    expect(viaToken({ signIn: 'mcp_oauth' })).toBe(false);
    const view = signInView();
    expect(view.notices).toHaveLength(1);
    expect(view.notices[0]).toMatchObject({
      tone: 'info',
      nature: 'fyi',
      check: 'cloudflare.token_hint',
      link: { kind: 'tab', tab: 'settings' },
    });
    expect(view.problem).toBeUndefined();
  });
});
