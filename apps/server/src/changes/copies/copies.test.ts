import { createHmac } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { npmSummary } from './npm';
import { opnsenseSummary } from './opnsense';
import { piholeSummary, teleporterFiles } from './pihole';
import { copyDue } from './run';
import {
  CONTENT_KEY,
  cleaned,
  copyHasher,
  diffSummaries,
  hasClearKeys,
  hashedSummary,
  MADE_KEY,
  plainKeyHasher,
  SECRET_FIELD,
  SummaryBuilder,
} from './summary';
import { copyWhen } from './view';
import { parseXml, xmlValue } from './xml';
import { zipFiles } from './zip';

/** A zip as an export makes one: each file deflated, or stored. */
function zip(files: Record<string, string | Buffer>, stored = false): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const packed = stored ? data : deflateRawSync(data);
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(n.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, n, packed);
    central.push(entry, n);
    offset += 30 + n.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

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
/** A summary's items' keys, without the content hash and the mark of how it was made. */
const items = (summary: Record<string, string>) => Object.keys(summary).filter((key) => key.includes('/'));

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
    files: {},
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

describe('Pi-hole’s Teleporter file compared', () => {
  const TOML = (when: string, upstream = '9.9.9.9') =>
    `# Pi-hole configuration file (v6.0)\n# Last updated on ${when}\n[dns]\n  upstreams = ["${upstream}"]\n`;
  const teleporter = (over: Record<string, string> = {}) =>
    zip({
      'etc/pihole/pihole.toml': TOML('2026-11-27 03:00:00 UTC'),
      'etc/hosts': '127.0.0.1 localhost\n10.100.0.5 nas.lan\n',
      'etc/pihole/dhcp.leases': '1764300000 aa:bb:cc:dd:ee:ff 10.100.0.50 phone *\n',
      'etc/pihole/gravity.db': 'SQLite format 3\u0000one',
      ...over,
    });
  const read = {
    config: { config: { dns: { upstreams: ['9.9.9.9'] } } },
    lists: { lists: [] },
    domains: { domains: [] },
    groups: { groups: [] },
    clients: { clients: [] },
  };
  const content = (bytes: Buffer) => piholeSummary({ ...read, files: teleporterFiles(bytes) })[CONTENT_KEY];

  it('reads the files of a zip, deflated or stored', () => {
    const files = zipFiles(zip({ 'a.txt': 'one', 'dir/': '', 'b.bin': Buffer.from([0, 1, 2]) }, true));
    expect([...(files?.keys() ?? [])]).toEqual(['a.txt', 'b.bin']);
    expect(
      zipFiles(zip({ 'a.txt': 'one'.repeat(100) }))
        ?.get('a.txt')
        ?.toString(),
    ).toBe('one'.repeat(100));
    expect(zipFiles(Buffer.from('<html>error</html>'))).toBeNull();
  });

  it('keeps a new copy when a file in it changed that Pi-hole’s API doesn’t show', () => {
    const a = content(teleporter());
    expect(a).toBeDefined();
    expect(content(teleporter({ 'etc/hosts': '127.0.0.1 localhost\n10.100.0.6 nas.lan\n' }))).not.toBe(a);
    expect(
      content(teleporter({ 'etc/pihole/pihole.toml': TOML('2026-11-27 03:00:00 UTC', '1.1.1.1') })),
    ).not.toBe(a);
    expect(
      content(teleporter({ 'etc/dnsmasq.d/02-own.conf': 'address=/printer.lan/10.100.0.9\n' })),
    ).not.toBe(a);
  });

  it('is the same copy when only what changes by itself changed', () => {
    const a = content(teleporter());
    expect(
      content(
        teleporter({
          'etc/pihole/pihole.toml': TOML('2026-11-28 03:00:00 UTC'),
          'etc/pihole/dhcp.leases': '1764400000 aa:bb:cc:dd:ee:ff 10.100.0.51 phone *\n',
          'etc/pihole/gravity.db': 'SQLite format 3\u0000two',
        }),
      ),
    ).toBe(a);
  });

  it('never calls a file it couldn’t read the same as another', () => {
    expect(teleporterFiles(Buffer.from('PK not really a zip'))).toBeNull();
    expect(piholeSummary({ ...read, files: null })[CONTENT_KEY]).toBeUndefined();
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

describe('a summary’s hashes', () => {
  const custody = (key: string) => ({
    custody: {
      mac: (purpose: string, message: string) =>
        createHmac('sha256', `${key}/${purpose}`).update(message).digest('base64url'),
    },
  });
  const build = (hasher?: ReturnType<typeof copyHasher>, port = 443) => {
    const b = new SummaryBuilder(hasher);
    b.add('filter', 'web', { port, enabled: true });
    b.content({ port, password: 'one' });
    return b.summary;
  };

  it('keys values and the content with the box’s key, not only the item’s key', () => {
    const plain = build();
    const box = build(copyHasher(custody('box-a') as never));
    const other = build(copyHasher(custody('box-b') as never));
    const values = (s: Record<string, string>) =>
      Object.entries(s)
        .filter(([k]) => k.includes('/'))
        .map(([, v]) => v);
    expect(values(box)).not.toEqual(values(plain));
    expect(values(box)).not.toEqual(values(other));
    expect(box[CONTENT_KEY]).not.toBe(plain[CONTENT_KEY]);
    expect(box[CONTENT_KEY]).not.toBe(other[CONTENT_KEY]);
    // The same settings on the same box compare the same, a changed one as changed.
    const hasher = copyHasher(custody('box-a') as never);
    expect(build(hasher)).toEqual(box);
    expect(diffSummaries(box, build(hasher, 8443))).toEqual([
      { part: 'filter', added: 0, removed: 0, changed: 1 },
    ]);
  });

  it('tells nothing changed against a summary made before, whose hashes can’t be compared', () => {
    const now = build(copyHasher(custody('box-a') as never));
    expect(now[MADE_KEY]).toBeDefined();
    const { [MADE_KEY]: _, ...before } = build();
    expect(diffSummaries(before, now)).toEqual([]);
    expect(before[CONTENT_KEY]).not.toBe(now[CONTENT_KEY]);
  });
});

describe('secret fields', () => {
  it('leaves out credentials, auth values, DSNs, webhooks, sessions and seeds, not their harmless neighbours', () => {
    for (const name of [
      'credentials',
      'aws_credential',
      'auth',
      'basic_auth',
      'basicAuth',
      'auth_pass',
      'authkey',
      'dsn',
      'sentry_dsn',
      'webhook',
      'webhook_url',
      'webhookUrl',
      'session_id',
      'sessionid',
      'session_cookie',
      'seed',
      'otp_seed',
      'seed_phrase',
    ])
      expect(SECRET_FIELD.test(name), name).toBe(true);
    for (const name of [
      'author',
      'authority',
      'authmode',
      'auth_method',
      'authserver',
      'pass_auth',
      'session',
      'session_timeout',
      'webhook_enabled',
      'credentials_file',
      'speed',
      'seeders',
      'hostname',
    ])
      expect(SECRET_FIELD.test(name), name).toBe(false);
  });
});

describe('a summary’s keys', () => {
  it('hashes each item’s key, a second of the same with its number', () => {
    const b = new SummaryBuilder();
    b.add('records', '10.100.0.5 nas.lan', 1);
    b.add('records', '10.100.0.5 nas.lan', 2);
    expect(items(b.summary)).toEqual([
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
    expect(Object.keys(rekeyed)).toEqual(items(now.summary));
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
