/**
 * The locked copy next to the backups (backup-passkey.md) against a fake backup app with rest-server 0.14.0's rules as
 * checked in a container: uploads are POST, names are the body's SHA-256 in lowercase hex, the same name again is 403,
 * private repositories, `config` readable only by its user.
 */
import { createHash } from 'node:crypto';
import {
  PLACE_KIT_PASSWORD,
  PLACE_KIT_RECORD_KIND,
  PLACE_KIT_USER,
  type PlaceKitRecord,
} from '@whombat/core/backup';
import { describe, expect, it } from 'vitest';
import {
  findKitsOn,
  findRepositoryOn,
  hasKitUser,
  type KitFetch,
  kitFileBody,
  kitFileName,
  newestKits,
  PLACE_PORTS,
  readKitFiles,
  restTarget,
  writeKitFiles,
} from './kit-copy';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** One backup app: its users, and its repositories' files (repo → type → name → body). */
interface FakeApp {
  users: Record<string, string>;
  files: Map<string, Map<string, string>>;
  configs: Set<string>;
}

function app(users: Record<string, string>): FakeApp {
  return { users, files: new Map(), configs: new Set() };
}

/** A network of fake apps by `host:port`; anything else refuses the connection. */
function network(apps: Record<string, FakeApp>): { fetch: KitFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: KitFetch = async (url, init) => {
    const u = new URL(url);
    const a = apps[`${u.hostname}:${u.port}`];
    calls.push(`${init.method} ${u.host}${u.pathname}`);
    if (!a) throw new TypeError('fetch failed');
    const auth = String((init.headers as Record<string, string>).authorization ?? '');
    const [user, password] = Buffer.from(auth.replace(/^Basic /, ''), 'base64')
      .toString()
      .split(':');
    const parts = u.pathname.split('/').filter(Boolean);
    const repo = parts[0] ?? '';
    const reply = (status: number, body = '') => new Response(status === 204 ? null : body, { status });
    if (!user || a.users[user] !== password || user !== repo) return reply(401);
    if (parts.length === 1 && init.method === 'POST' && u.search === '?create=true') {
      if (!a.files.has(repo)) a.files.set(repo, new Map());
      return reply(200);
    }
    if (parts.length === 2 && parts[1] === 'config') return reply(a.configs.has(repo) ? 200 : 404);
    const files = a.files.get(repo);
    if (parts.length === 2 && parts[1] === 'keys' && init.method === 'GET') {
      if (!files) return reply(404);
      return reply(200, JSON.stringify([...files].map(([name, body]) => ({ name, size: body.length }))));
    }
    if (parts.length === 3 && parts[1] === 'keys') {
      const name = parts[2] as string;
      if (!/^[0-9a-f]{64}$/.test(name)) return reply(404);
      if (init.method === 'HEAD') return reply(files?.has(name) ? 200 : 404);
      if (init.method === 'GET') return files?.has(name) ? reply(200, files.get(name)) : reply(404);
      if (init.method === 'POST') {
        const body = String(init.body);
        if (files?.has(name)) return reply(403);
        if (sha(body) !== name) return reply(400);
        files?.set(name, body);
        return reply(200);
      }
      if (init.method === 'DELETE') return reply(403);
    }
    return reply(405);
  };
  return { fetch: fetchFn, calls };
}

const KIT_USERS = { [PLACE_KIT_USER]: PLACE_KIT_PASSWORD, 'home-3fkq': 'client-secret' };
const OLD = '12D3KooWBdXx3Cq9hpm8vNrLy8kgLe7Hx1WXDf5wSZ6aw9PUVQhE';

function record(over: Partial<PlaceKitRecord> = {}): PlaceKitRecord {
  return {
    kind: PLACE_KIT_RECORD_KIND,
    appliance: OLD,
    applianceName: 'Home',
    credentialId: 'Y3JlZA',
    salt: '2RI2EH8wqFcj9KLMi35oIHhH2q4fWvGu-Czr0iSrw-Y',
    envelope: 'wbkit1.oKGio6SlpqeoqaqrrK2ur7CxsrO0tba3.PCcUYiW45pIXAPRmQggriWSM',
    generation: 3,
    createdAt: '2026-11-04T10:00:00.000Z',
    ...over,
  };
}

describe('writing and reading the envelope files', () => {
  it('names each file by its SHA-256, writes it once, and reads it back', async () => {
    const nas = app(KIT_USERS);
    const net = network({ '192.168.1.40:8747': nas });
    const body = kitFileBody(record());
    expect(kitFileName(body)).toBe(sha(body));
    expect(await writeKitFiles('http://192.168.1.40:8747', [body], net.fetch)).toBe('written');
    expect([...(nas.files.get(PLACE_KIT_USER)?.keys() ?? [])]).toEqual([sha(body)]);
    // Again: a HEAD finds it, nothing is posted.
    net.calls.length = 0;
    expect(await writeKitFiles('http://192.168.1.40:8747', [body], net.fetch)).toBe('written');
    expect(net.calls.filter((c) => c.startsWith('POST') && c.includes('/keys/'))).toEqual([]);
    expect(await readKitFiles('http://192.168.1.40:8747', net.fetch)).toEqual([record()]);
    expect(await hasKitUser('http://192.168.1.40:8747', net.fetch)).toBe(true);
  });

  it('says when the app has no kit user, or doesn’t answer', async () => {
    const net = network({ '192.168.1.40:8747': app({ 'home-3fkq': 'client-secret' }) });
    const body = kitFileBody(record());
    expect(await writeKitFiles('http://192.168.1.40:8747', [body], net.fetch)).toBe('no_kit_user');
    expect(await hasKitUser('http://192.168.1.40:8747', net.fetch)).toBe(false);
    expect(await writeKitFiles('http://192.168.1.41:8747', [body], net.fetch)).toBe('unreachable');
    expect(await hasKitUser('http://192.168.1.41:8747', net.fetch)).toBe(null);
  });

  it('leaves out a file whose bytes aren’t its name, and one that isn’t an envelope', async () => {
    const nas = app(KIT_USERS);
    const net = network({ '192.168.1.40:8747': nas });
    const good = kitFileBody(record());
    const other = kitFileBody(record({ credentialId: 'b3RoZXI' }));
    const junk = JSON.stringify({ kind: 'something else' });
    await writeKitFiles('http://192.168.1.40:8747', [good, other, junk], net.fetch);
    nas.files.get(PLACE_KIT_USER)?.set(sha(other), other.replace('Home', 'Evil'));
    expect(await readKitFiles('http://192.168.1.40:8747', net.fetch)).toEqual([record()]);
  });
});

describe('finding envelopes on this network', () => {
  it('looks at the backup apps’ ports of every host and keeps the newest per Whombat and passkey', async () => {
    const nas = app(KIT_USERS);
    const net = network({ '192.168.1.40:8749': nas });
    const older = record({ generation: 2, createdAt: '2026-11-01T10:00:00.000Z' });
    await writeKitFiles('http://192.168.1.40:8749', [kitFileBody(older), kitFileBody(record())], net.fetch);
    const found = await findKitsOn(['192.168.1.40', '192.168.1.41'], net.fetch);
    expect(found.places).toBe(1);
    expect(found.kits).toEqual([{ ...record(), at: '192.168.1.40:8749' }]);
    expect(PLACE_PORTS).toHaveLength(20);
    expect(PLACE_PORTS[0]).toBe(8747);
    expect(PLACE_PORTS.at(-1)).toBe(8766);
  });

  it('orders the newest first', () => {
    const a = record({ credentialId: 'YQ', createdAt: '2026-11-01T00:00:00.000Z' });
    const b = record({ credentialId: 'Yg', createdAt: '2026-11-03T00:00:00.000Z' });
    expect(newestKits([a, b]).map((r) => r.credentialId)).toEqual(['Yg', 'YQ']);
  });
});

describe('a place that moved', () => {
  const material = {
    repository: 'rest:http://192.168.1.40:8747/home-3fkq/',
    restUser: 'home-3fkq',
    restPassword: 'client-secret',
  };

  it('is found by its repository’s config, which only its own user reads', async () => {
    const moved = app(KIT_USERS);
    moved.configs.add('home-3fkq');
    const stranger = app({ 'home-3fkq': 'another-password' });
    stranger.configs.add('home-3fkq');
    const net = network({ '192.168.1.52:8747': stranger, '192.168.1.53:8748': moved });
    expect(await findRepositoryOn(material, ['192.168.1.52', '192.168.1.53'], net.fetch)).toBe(
      'rest:http://192.168.1.53:8748/home-3fkq/',
    );
  });

  it('stays where the kit says when it answers there, and isn’t looked for without REST credentials', async () => {
    const here = app(KIT_USERS);
    here.configs.add('home-3fkq');
    const net = network({ '192.168.1.40:8747': here });
    expect(await findRepositoryOn(material, ['192.168.1.40'], net.fetch)).toBe(null);
    expect(
      await findRepositoryOn({ ...material, restPassword: undefined }, ['192.168.1.40'], net.fetch),
    ).toBe(null);
    expect(await findRepositoryOn(material, [], network({}).fetch)).toBe(null);
  });
});

describe('restTarget', () => {
  it('takes plain http only to a private address', () => {
    expect(restTarget('rest:http://192.168.1.40:8747/home-3fkq/')).toEqual({
      origin: 'http://192.168.1.40:8747',
      host: '192.168.1.40',
      port: 8747,
      path: '/home-3fkq/',
    });
    expect(restTarget('rest:http://8.8.8.8:8747/x/')).toBe(null);
    expect(restTarget('rest:https://backup.example.com/x')?.path).toBe('/x/');
    expect(restTarget('rest:http://u:p@192.168.1.40:8747/x/')).toBe(null);
    expect(restTarget('sftp:nas:/backups')).toBe(null);
  });
});
