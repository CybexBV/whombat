import { describe, expect, it } from 'vitest';
import { npmSummary } from './npm';
import { opnsenseSummary } from './opnsense';
import { piholeSummary } from './pihole';
import { copyDue } from './run';
import { cleaned, diffSummaries } from './summary';
import { copyWhen } from './view';
import { parseXml, xmlValue } from './xml';

const CONFIG = (rules: string, extra = '') => `<?xml version="1.0"?>
<opnsense>
  <!-- a comment -->
  <revision><username>root</username><time>1732700000</time></revision>
  <system>
    <hostname>gate</hostname>
    <user><name>root</name><password>$2y$10$hash</password><otp_seed>SEED</otp_seed></user>
    <apikeys><item><key>KEY</key><secret>$6$hashed</secret></item></apikeys>
  </system>
  <filter>${rules}</filter>
  <interfaces><lan><descr>LAN</descr><ipaddr>10.100.0.1</ipaddr></lan></interfaces>
  ${extra}
</opnsense>`;

const RULE = (uuid: string, descr: string, port = '443') =>
  `<rule uuid="${uuid}"><descr>${descr} &amp; more</descr><destination><port>${port}</port></destination><updated><time>1</time></updated></rule>`;

describe('OPNsense’s settings compared', () => {
  it('reads the parts and keys rules by uuid, leaving out times and secrets', () => {
    const a = opnsenseSummary(CONFIG(RULE('u1', 'Web') + RULE('u2', 'Mail')));
    expect(Object.keys(a)).toEqual(expect.arrayContaining(['filter/u1', 'filter/u2', 'interfaces/lan:LAN']));
    // A save that changed only OPNsense's own times changes nothing.
    const resaved = opnsenseSummary(
      CONFIG(RULE('u1', 'Web') + RULE('u2', 'Mail'))
        .replace('1732700000', '1732799999')
        .replace(/<time>1</g, '<time>2<'),
    );
    expect(diffSummaries(a, resaved)).toEqual([]);
    const b = opnsenseSummary(CONFIG(RULE('u1', 'Web', '8443') + RULE('u3', 'VPN')));
    expect(diffSummaries(a, b)).toEqual([{ part: 'filter', added: 1, removed: 1, changed: 1 }]);
  });

  it('doesn’t count a password that changed', () => {
    const a = opnsenseSummary(CONFIG(''));
    const b = opnsenseSummary(CONFIG('').replace('$2y$10$hash', '$2y$10$other'));
    expect(diffSummaries(a, b)).toEqual([]);
  });

  it('reads entities, CDATA and self-closing elements', () => {
    const doc = parseXml('<a x="1 &lt; 2"><b/><c><![CDATA[<raw>]]></c><d>&#65;&#x42;</d></a>');
    expect(xmlValue(doc.children[0] as never)).toEqual({ '@x': '1 < 2', b: '', c: '<raw>', d: 'AB' });
  });
});

describe('Pi-hole’s settings compared', () => {
  const read = {
    config: {
      config: {
        dns: { upstreams: ['9.9.9.9'], hosts: ['10.100.0.5 nas.lan'] },
        dhcp: { active: false, hosts: [] },
        webserver: { api: { pwhash: 'HASH', totp_secret: 'S', app_sudo: false } },
        files: { pid: '/run/pihole.pid' },
      },
    },
    lists: {
      lists: [
        { address: 'https://example.com/list', type: 'block', enabled: true, number: 1000, date_updated: 1 },
      ],
    },
    domains: { domains: [{ domain: 'ads.example.com', type: 'deny', kind: 'exact', enabled: true, id: 3 }] },
    groups: { groups: [{ name: 'Default', enabled: true }] },
    clients: { clients: [] },
  };

  it('counts records, lists and sites by part, not their own counts or secrets', () => {
    const a = piholeSummary(read);
    const counted = piholeSummary({
      ...read,
      lists: { lists: [{ ...read.lists.lists[0], number: 2000, date_updated: 2 }] },
      config: {
        config: {
          ...read.config.config,
          webserver: { api: { pwhash: 'OTHER', totp_secret: 'T', app_sudo: false } },
        },
      },
    });
    expect(diffSummaries(a, counted)).toEqual([]);
    const b = piholeSummary({
      ...read,
      config: {
        config: { ...read.config.config, dns: { upstreams: ['1.1.1.1'], hosts: ['10.100.0.6 nas.lan'] } },
      },
      domains: { domains: [] },
    });
    expect(diffSummaries(a, b)).toEqual([
      { part: 'dns', added: 0, removed: 0, changed: 1 },
      { part: 'records', added: 1, removed: 1, changed: 0 },
      { part: 'domains', added: 0, removed: 1, changed: 0 },
    ]);
  });
});

describe('Nginx Proxy Manager’s hosts compared', () => {
  const host = (domain: string, over: Record<string, unknown> = {}) => ({
    id: 1,
    domain_names: [domain],
    forward_host: '10.100.0.11',
    forward_port: 80,
    ssl_forced: true,
    modified_on: '2026-11-01',
    meta: { nginx_online: true },
    ...over,
  });
  const read = {
    proxyHosts: [host('a.example.com')],
    redirects: [],
    streams: [],
    deadHosts: [],
    accessLists: [],
  };

  it('leaves where a host points to the routes, and counts the rest', () => {
    const a = npmSummary(read);
    expect(
      diffSummaries(
        a,
        npmSummary({ ...read, proxyHosts: [host('a.example.com', { forward_host: '10.100.0.12' })] }),
      ),
    ).toEqual([]);
    expect(
      diffSummaries(
        a,
        npmSummary({
          ...read,
          proxyHosts: [host('a.example.com', { ssl_forced: false }), host('b.example.com')],
        }),
      ),
    ).toEqual([{ part: 'proxyHosts', added: 1, removed: 0, changed: 1 }]);
  });
});

describe('cleaning', () => {
  it('drops secret fields at any depth', () => {
    expect(cleaned({ a: 1, password: 'x', nested: { api_key: 'k', ok: true, privkey: 'p' } })).toEqual({
      a: 1,
      nested: { ok: true },
    });
  });
});

describe('when a copy is due', () => {
  const zone = 'Europe/Amsterdam';
  const at = (iso: string) => new Date(iso);

  it('makes the first soon, then one in the night, and tries a failed one again after an hour', () => {
    expect(copyDue(null, at('2026-11-28T14:00:00Z'), zone)).toBe(true);
    const ok = { triedAt: at('2026-11-28T02:30:00Z'), failedSince: null, failures: 0 };
    expect(copyDue(ok, at('2026-11-28T14:00:00Z'), zone)).toBe(false);
    // 03:30 at the box's clock, a day on.
    expect(copyDue(ok, at('2026-11-29T02:30:00Z'), zone)).toBe(true);
    const failed = {
      triedAt: at('2026-11-28T14:00:00Z'),
      failedSince: at('2026-11-28T14:00:00Z'),
      failures: 1,
    };
    expect(copyDue(failed, at('2026-11-28T14:30:00Z'), zone)).toBe(false);
    expect(copyDue(failed, at('2026-11-28T15:01:00Z'), zone)).toBe(true);
    expect(copyDue({ ...failed, failures: 3 }, at('2026-11-28T15:01:00Z'), zone)).toBe(false);
    // Missed nights: any time after a day and a half.
    expect(copyDue(ok, at('2026-11-29T15:00:00Z'), zone)).toBe(true);
  });

  it('says when the copy was made at the box’s clock', () => {
    const now = at('2026-11-28T10:00:00Z');
    expect(copyWhen(at('2026-11-28T02:30:00Z'), now, 'Europe/Amsterdam', 'en')).toBe('last night');
    expect(copyWhen(at('2026-11-28T08:15:00Z'), now, 'Europe/Amsterdam', 'en')).toContain('09:15');
    expect(copyWhen(at('2026-11-25T02:30:00Z'), now, 'Europe/Amsterdam', 'en')).toContain('25');
  });
});
