import { describe, expect, it } from 'vitest';
import { npmSummary } from './npm';
import { opnsenseSummary } from './opnsense';
import { piholeSummary } from './pihole';
import { copyDue } from './run';
import {
  CONTENT_KEY,
  cleaned,
  diffSummaries,
  hasClearKeys,
  hashedSummary,
  plainKeyHasher,
  SummaryBuilder,
} from './summary';
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

/** An item's key as a summary keeps it. */
const k = (part: string, key: string) => `${part}/~${plainKeyHasher(key)}`;
const items = (summary: Record<string, string>) => Object.keys(summary).filter((key) => key !== CONTENT_KEY);

const RULE = (uuid: string, descr: string, port = '443') =>
  `<rule uuid="${uuid}"><descr>${descr} &amp; more</descr><destination><port>${port}</port></destination><updated><time>1</time></updated></rule>`;

describe('OPNsense’s settings compared', () => {
  it('reads the parts and keys rules by uuid, leaving out times and secrets', () => {
    const a = opnsenseSummary(CONFIG(RULE('u1', 'Web') + RULE('u2', 'Mail')));
    expect(Object.keys(a)).toEqual(
      expect.arrayContaining([k('filter', 'u1'), k('filter', 'u2'), k('interfaces', 'lan:LAN')]),
    );
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

  it('doesn’t count a password that changed, but the copy isn’t the same any more', () => {
    const a = opnsenseSummary(CONFIG(''));
    const b = opnsenseSummary(CONFIG('').replace('$2y$10$hash', '$2y$10$other'));
    expect(diffSummaries(a, b)).toEqual([]);
    expect(b[CONTENT_KEY]).not.toBe(a[CONTENT_KEY]);
    // A save that changed only OPNsense's own times is the same copy.
    expect(opnsenseSummary(CONFIG('').replace('1732700000', '1732799999'))[CONTENT_KEY]).toBe(a[CONTENT_KEY]);
  });

  it('never keeps a setting that is a secret itself', () => {
    const withSecret = (value: string) =>
      opnsenseSummary(
        CONFIG('').replace(
          '<hostname>gate</hostname>',
          `<hostname>gate</hostname><radius_secret>${value}</radius_secret>`,
        ),
      );
    const a = withSecret('one');
    expect(Object.keys(a)).not.toContain(k('system', 'radius_secret'));
    expect(Object.keys(a)).toContain(k('system', 'hostname'));
    expect(diffSummaries(a, withSecret('two'))).toEqual([]);
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

  it('keeps no line, address or name in the clear', () => {
    const summary = JSON.stringify(piholeSummary(read));
    for (const clear of ['nas.lan', '10.100.0.5', 'ads.example.com', 'example.com/list', 'Default'])
      expect(summary).not.toContain(clear);
    expect(hasClearKeys(piholeSummary(read))).toBe(false);
  });

  it('never keeps a setting that is a secret itself', () => {
    const withPassword = (password: string) =>
      piholeSummary({
        ...read,
        config: {
          config: { ...read.config.config, webserver: { ...read.config.config.webserver, password } },
        },
      });
    const a = withPassword('one');
    expect(Object.keys(a)).not.toContain(k('system', 'webserver.password'));
    expect(diffSummaries(a, withPassword('two'))).toEqual([]);
    expect(withPassword('two')[CONTENT_KEY]).not.toBe(a[CONTENT_KEY]);
  });

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
    const moved = npmSummary({
      ...read,
      proxyHosts: [host('a.example.com', { forward_host: '10.100.0.12' })],
    });
    expect(diffSummaries(a, moved)).toEqual([]);
    // The copy itself holds where it pointed: it is another copy.
    expect(moved[CONTENT_KEY]).not.toBe(a[CONTENT_KEY]);
    expect(
      npmSummary({ ...read, proxyHosts: [host('a.example.com', { modified_on: '2026-11-02' })] })[
        CONTENT_KEY
      ],
    ).toBe(a[CONTENT_KEY]);
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

describe('a summary’s keys', () => {
  it('hashes each item’s key, a second of the same with its number', () => {
    const b = new SummaryBuilder();
    b.add('records', '10.100.0.5 nas.lan', 1);
    b.add('records', '10.100.0.5 nas.lan', 2);
    expect(Object.keys(b.summary)).toEqual([
      k('records', '10.100.0.5 nas.lan'),
      k('records', '10.100.0.5 nas.lan#2'),
    ]);
  });

  it('reads one kept with its keys in the clear as one made now', () => {
    const before = {
      'records/10.100.0.5 nas.lan': 'h1',
      'records/10.100.0.5 nas.lan#2': 'h2',
      'domains/deny/exact:a': 'h3',
    };
    expect(hasClearKeys(before)).toBe(true);
    const now = new SummaryBuilder();
    now.add('records', '10.100.0.5 nas.lan', 1);
    now.add('records', '10.100.0.5 nas.lan', 2);
    now.add('domains', 'deny/exact:a', 3);
    const rekeyed = hashedSummary(before, plainKeyHasher);
    expect(Object.keys(rekeyed)).toEqual(Object.keys(now.summary));
    expect(hasClearKeys(rekeyed)).toBe(false);
    expect(hashedSummary(rekeyed, plainKeyHasher)).toEqual(rekeyed);
  });

  it('counts items only, never the copy’s content hash', () => {
    expect(
      diffSummaries(
        { [CONTENT_KEY]: 'a', [k('filter', 'u1')]: 'x' },
        { [CONTENT_KEY]: 'b', [k('filter', 'u1')]: 'x' },
      ),
    ).toEqual([]);
    expect(items({ [CONTENT_KEY]: 'a', [k('filter', 'u1')]: 'x' })).toHaveLength(1);
  });
});

describe('cleaning', () => {
  it('drops secret fields at any depth', () => {
    expect(cleaned({ a: 1, password: 'x', nested: { api_key: 'k', ok: true, privkey: 'p' } })).toEqual({
      a: 1,
      nested: { ok: true },
    });
  });

  it('drops SNMP communities, LDAP bind passwords, TLS and shared keys', () => {
    for (const field of [
      'community',
      'rocommunity',
      'ldap_bindpw',
      'bindpw',
      'tls',
      'sharedkey',
      'shared_key',
    ])
      expect(cleaned({ [field]: 'secret-value', name: 'x' }), field).toEqual({ name: 'x' });
    // Their neighbours that aren't secrets stay.
    expect(cleaned({ tls_type: 'auth', syslocation: 'attic' })).toEqual({
      tls_type: 'auth',
      syslocation: 'attic',
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
