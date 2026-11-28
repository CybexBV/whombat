/** Nginx Proxy Manager's page from real answers of 2.16.0 (service-dashboards.md SD-41, SD-S11). Pure. */
import { ThingPageKpi, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { OutboundError } from '../../../lib/outbound';
import { slotProblems } from '../slots';
import {
  NPM_DEAD_HOSTS,
  NPM_PROXY_HOSTS,
  NPM_REDIRECTS,
  NPM_ROOT,
  NPM_STREAMS,
} from './fixtures/nginx-proxy-manager';
import { buttonsOf } from './fixtures/row';
import {
  answerOf,
  askedDomain,
  certificatesOf,
  NPM_CHECKS,
  type NpmSnapshot,
  nginxError,
  npmDate,
  npmKpis,
  npmNotices,
  npmRows,
  npmSkipped,
  npmStatus,
  npmTracked,
  npmVersion,
  npmView,
  parseProxyHosts,
  parseRedirects,
  renewButton,
  type SiteAnswer,
} from './nginx-proxy-manager';

const NOW = new Date('2026-10-21T20:00:00Z');
const URL = 'http://192.168.1.2:81';

const snapshot: NpmSnapshot = {
  readAt: NOW,
  version: npmVersion(NPM_ROOT),
  sites: [...parseProxyHosts(NPM_PROXY_HOSTS), ...parseRedirects(NPM_REDIRECTS)],
  streams: NPM_STREAMS.length,
  dead: NPM_DEAD_HOSTS.length,
  created: {
    streams: NPM_STREAMS.map((x) => npmDate(x.created_on)),
    dead: NPM_DEAD_HOSTS.map((x) => npmDate(x.created_on)),
  },
};
const answers = new Map<string, SiteAnswer>([
  ['app.example.com', { state: 'ok', status: 200 }],
  ['www.example.com', { state: 'down', why: 'network' }],
]);
const manager = buttonsOf('nginx_proxy_manager');

describe('nginx proxy manager', () => {
  it('reads hosts, their certificate and nginx’s complaint', () => {
    expect(snapshot.version).toBe('2.16.0');
    const [app, broken, old, www] = snapshot.sites;
    expect(app).toMatchObject({
      id: 'p1',
      domains: ['app.example.com'],
      target: 'http://192.168.1.20:8080',
      enabled: true,
      online: true,
      certificate: { id: 1, provider: 'other', expires: new Date('2026-11-10T19:46:00Z') },
    });
    expect(broken).toMatchObject({
      id: 'p3',
      online: false,
      error: '[emerg] unknown directive "this_is_not_a_directive"',
    });
    expect(old).toMatchObject({ id: 'p2', enabled: false });
    expect(www).toMatchObject({ id: 'r1', kind: 'redirect', target: 'https://example.com' });
    expect(npmDate('2026-11-10 19:46:00')?.toISOString()).toBe('2026-11-10T19:46:00.000Z');
    expect(nginxError('')).toBeNull();
  });

  it('asks only switched-on sites that loaded, by a plain name', () => {
    expect(snapshot.sites.map(askedDomain)).toEqual(['app.example.com', null, null, 'www.example.com']);
    expect(askedDomain({ ...(snapshot.sites[0] as NpmSite), domains: ['*.example.com'] })).toBeNull();
  });

  it('counts any answer under 500 as answering', () => {
    expect(answerOf({ status: 401 })).toEqual({ state: 'ok', status: 401 });
    expect(answerOf({ status: 502 })).toEqual({ state: 'error', status: 502 });
    expect(answerOf({ error: new OutboundError('timeout', 'x') })).toEqual({ state: 'down', why: 'timeout' });
    expect(answerOf({ error: new OutboundError('untrusted_certificate', 'x') })).toMatchObject({
      why: 'certificate',
    });
    expect(answerOf({ error: new OutboundError('destination', 'x') })).toEqual({ state: 'unchecked' });
    expect(answerOf({ error: new Error('reset') })).toMatchObject({ state: 'down', why: 'network' });
  });

  it('has four figures', () => {
    const kpis = npmKpis(snapshot, answers, NOW);
    for (const k of kpis) ThingPageKpi.parse(k);
    expect(kpis.map((k) => [k.key, k.value, k.tone ?? null])).toEqual([
      ['sites', '3', null],
      ['certificates', '1', null],
      ['ending', '1', null],
      ['answering', '1', 'warn'],
    ]);
    expect(npmKpis(snapshot, null, NOW).map((k) => k.key)).not.toContain('answering');
  });

  it('says what is worth a look', () => {
    const notices = npmNotices(snapshot, answers, NOW, URL);
    for (const n of notices) ThingPageNotice.parse(n);
    expect(notices.map((n) => [n.id, n.tone])).toEqual([
      ['not-answering-r1', 'warn'],
      ['config-p3', 'warn'],
      ['switched-off', 'info'],
    ]);
    expect(notices.map((n) => [n.check, n.nature, n.subject?.id, n.ignore?.lifts])).toEqual([
      ['nginx_proxy_manager.site', 'problem', 'site:r1', 'fixed'],
      ['nginx_proxy_manager.config', 'problem', 'site:p3', 'fixed'],
      ['nginx_proxy_manager.switched_off', 'fyi', undefined, 'newer'],
    ]);
    // Asked once from the box: it counts after two passes.
    expect(notices[0]).toMatchObject({
      confirm: 2,
      link: { kind: 'ask' },
      badge: 'www.example.com not answering',
    });
    for (const n of notices) expect(NPM_CHECKS.map((c) => c.check)).toContain(n.check);
    expect(notices[1]?.detail).not.toContain('/data/');
    const later = new Date('2026-11-01T00:00:00Z');
    expect(npmNotices(snapshot, answers, later, URL).find((n) => n.id === 'cert-ending-1')?.tone).toBe(
      'warn',
    );
    const after = new Date('2026-11-11T00:00:00Z');
    // An own certificate is a person's to replace; ending and expired are one check, its end date the episode.
    expect(npmNotices(snapshot, answers, after, URL)[0]).toMatchObject({
      id: 'cert-expired-1',
      tone: 'bad',
      nature: 'you',
      check: 'nginx_proxy_manager.cert',
      subject: { id: 'cert:1' },
      episode: '2026-11-10T19:46:00.000Z',
      ignore: { lifts: 'newer' },
      link: { kind: 'url' },
    });
    // The lines decide warn and bad (QN-S30).
    expect(npmStatus(snapshot)).toEqual({ status: 'ok', badge: '3 sites' });
  });

  it('makes a Let’s Encrypt certificate that doesn’t renew a problem, and says what it couldn’t read', () => {
    const le = {
      ...snapshot,
      sites: snapshot.sites.map((x) =>
        x.certificate ? { ...x, certificate: { ...x.certificate, provider: 'letsencrypt' } } : x,
      ),
    };
    const later = new Date('2026-11-01T00:00:00Z');
    const line = npmNotices(le, answers, later, URL, manager).find(
      (n) => n.check === 'nginx_proxy_manager.cert',
    );
    expect(line).toMatchObject({ nature: 'problem', link: { kind: 'ask' }, action: { action: 'renew' } });
    expect(npmSkipped(snapshot, answers)).toEqual([]);
    expect(npmSkipped(snapshot, null)).toEqual(['nginx_proxy_manager.site']);
    expect(npmSkipped({ ...snapshot, redirectsUnread: true }, answers)).toContain('nginx_proxy_manager.cert');
  });

  it('draws the sites with problems first', () => {
    const rows = npmRows(snapshot, answers, NOW, 'Europe/Amsterdam', manager);
    expect(rows.map((r) => [r.id, r.cells.answering?.text])).toEqual([
      ['p3', 'Config error'],
      ['r1', 'Not answering'],
      ['p1', 'Answering'],
      ['p2', 'Switched off'],
    ]);
    expect(rows[2]?.cells.certificate).toMatchObject({ text: '20 days', note: 'until 10 Nov' });
    const view = npmView({ snapshot, answers, now: NOW, timeZone: 'UTC', url: URL, ...manager });
    for (const p of view.panels) ThingPagePanel.parse(p);
    // A Let’s Encrypt certificate ending: Renew✱ beside its site and on its Worth a look line.
    const le: NpmSnapshot = {
      ...snapshot,
      sites: snapshot.sites.map((x) =>
        x.certificate ? { ...x, certificate: { ...x.certificate, provider: 'letsencrypt' } } : x,
      ),
    };
    const later = new Date('2026-11-01T00:00:00Z');
    const leView = npmView({ snapshot: le, answers, now: later, timeZone: 'UTC', url: URL, ...manager });
    const sites = leView.tabs[0]?.panels.find((p) => p.id === 'sites');
    expect(
      sites?.kind === 'table' && sites.rows.find((r) => r.id === 'p1')?.cells.renew?.action,
    ).toMatchObject({
      action: 'renew',
      target: '1',
    });
    expect(leView.notices.find((n) => n.id === 'cert-ending-1')?.action?.action).toBe('renew');
  });

  it('is in slots: each site now beside the hosts and certificates it holds, every site in its tab', () => {
    const view = npmView({ snapshot, answers, now: NOW, timeZone: 'UTC', url: URL, ...manager });
    for (const p of view.panels) ThingPagePanel.parse(p);
    expect(slotProblems(view)).toEqual([]);
    expect(view.kpis).toEqual([]);
    expect(view.panels.map((p) => p.id)).toEqual(['answering', 'inventory']);
    const live = view.panels[0];
    if (live?.kind !== 'list') throw new Error('live');
    // Problems first, the switched-off site last; where each forwards, and its answer on the right.
    expect(live.items.map((i) => [i.title, i.right ?? null, i.tone ?? null])).toEqual([
      ['broken.example.com', 'Config error', 'bad'],
      ['www.example.com', 'Not answering', 'bad'],
      ['app.example.com', 'Answering', 'ok'],
      ['old.example.com', 'Switched off', null],
    ]);
    expect(live.items[2]?.detail).toBe('192.168.1.20:8080 · certificate ends in 20 days');
    expect(live.items[1]?.detail).toBe('Redirect to example.com');
    expect(live.items[0]?.detail).toContain('unknown directive');
    expect(live.meta).toBe('1 of 2 not answering');
    const inv = view.panels[1];
    if (inv?.kind !== 'list') throw new Error('inventory');
    // Everything was added on the day the answers were recorded: this week.
    expect(inv.items.map((i) => [i.id, i.figure?.value, i.figure?.note ?? null, i.detail ?? null])).toEqual([
      ['proxy-hosts', '3', '+3 this week', '1 switched off'],
      ['redirects', '1', '+1 this week', null],
      ['streams', '1', '+1 this week', null],
      ['dead-hosts', '1', '+1 this week', null],
      ['certificates', '1', '1 ending soon', null],
    ]);
    const later = new Date('2026-11-21T00:00:00Z');
    const quiet = npmView({ snapshot, answers, now: later, timeZone: 'UTC', url: URL, ...manager });
    const inv2 = quiet.panels[1];
    expect(inv2?.kind === 'list' && inv2.items.map((i) => i.figure?.note ?? null)).toEqual([
      null,
      null,
      null,
      null,
      '1 expired',
    ]);
    expect(view.slots?.machine).toEqual([
      { id: 'npm-version', label: 'Nginx Proxy Manager', value: '2.16.0', pct: null },
    ]);
    expect(view.tabs.map((t) => [t.key, t.count])).toEqual([['sites', 4]]);
    // The card keeps its figures.
    expect(npmKpis(snapshot, answers, NOW).map((k) => k.key)).toEqual([
      'sites',
      'certificates',
      'ending',
      'answering',
    ]);
  });

  it('offers Renew only on a Let’s Encrypt certificate within 30 days', () => {
    const [own] = certificatesOf(snapshot);
    if (!own) throw new Error('no certificate');
    expect(renewButton(manager, own, NOW, 'app.example.com')).toBeNull();
    const le = { ...own, provider: 'letsencrypt' };
    expect(renewButton(manager, le, NOW, 'app.example.com')).toMatchObject({
      action: 'renew',
      target: '1',
      allowed: true,
    });
    expect(renewButton(manager, le, new Date('2026-09-01T00:00:00Z'), 'app.example.com')).toBeNull();
  });
});

type NpmSite = NpmSnapshot['sites'][number];

describe('what the change log keeps of Nginx Proxy Manager (outside-changes.md)', () => {
  it('keeps its version and where each proxy host points, a switched-off one marked', () => {
    const tracked = npmTracked(snapshot);
    expect(tracked.version).toBe('2.16.0');
    expect(tracked.routes?.via).toBe('proxy');
    const proxies = snapshot.sites.filter((s) => s.kind === 'proxy');
    expect(Object.keys(tracked.routes?.map ?? {})).toHaveLength(proxies.length);
    const off = proxies.find((s) => !s.enabled);
    if (off?.domains[0]) expect(tracked.routes?.map[off.domains[0]]).toMatch(/^off:/);
  });
});
