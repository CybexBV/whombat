import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actorHeaders, HostsClient, HostsError, HostsUnavailable, headerText, withQuery } from './client';
import { HostsEventStream, type HostsSseEvent, SseParser } from './events';
import { type FakeHostsService, startFakeHosts } from './testing/fake';

describe('hosts client headers', () => {
  it('cleans the actor and sends its UTF-8 bytes', () => {
    const h = actorHeaders({ id: 'prn_mara', name: 'José | Ñ\nx', role: 'operator', clientIp: '10.0.0.5' });
    expect(Buffer.from(h['X-Whombat-Actor'] as string, 'latin1').toString('utf8')).toBe('prn_mara|José Ñ x');
    expect(h['X-Whombat-Role']).toBe('operator');
    expect(h['X-Whombat-Client-IP']).toBe('10.0.0.5');
    expect(actorHeaders({ id: 'prn_x', name: '', clientIp: 'not an ip' })).toEqual({
      'X-Whombat-Actor': 'prn_x|Someone',
    });
    expect(headerText('a'.repeat(100), 10)).toBe('aaaaaaaaaa');
    // Whole characters within the byte limit: “é” is two bytes.
    expect(Buffer.from(headerText('éééé', 5), 'latin1').toString('utf8')).toBe('éé');
    expect(actorHeaders({ id: 'prn x/1', name: 'A' })['X-Whombat-Actor']).toBe('prn_x_1|A');
  });

  it('builds queries without the empty values', () => {
    expect(withQuery('/x', { range: '24h', group: '', a: null, b: undefined, n: 3 })).toBe(
      '/x?range=24h&n=3',
    );
    expect(withQuery('/x', undefined)).toBe('/x');
  });
});

describe('SSE parsing', () => {
  it('reads events across chunks, ids, retry and comments', () => {
    const p = new SseParser();
    expect(p.push('retry: 5000\n\n: keepalive\n\nid: 7\nevent: server.online\nda')).toEqual([]);
    expect(p.push('ta: {"id":"basalt"}\n\n')).toEqual([
      { id: '7', event: 'server.online', data: '{"id":"basalt"}' },
    ]);
    expect(p.retryMs).toBe(5000);
    expect(p.push('event: resync\r\ndata: {}\r\n\r\n')).toEqual([{ id: '7', event: 'resync', data: '{}' }]);
  });
});

describe('hosts client against the fake service', () => {
  let fake: FakeHostsService;
  let client: HostsClient;

  beforeAll(async () => {
    fake = await startFakeHosts();
    client = new HostsClient({ socket: fake.socket, tokenFile: fake.tokenFile });
  });
  afterAll(() => fake.stop());

  it('reads JSON with the token and the actor', async () => {
    const fleet = await client.json<{ servers: unknown[] }>({
      path: '/api/v1/fleet',
      actor: { id: 'prn_mara', name: 'Mara', role: 'viewer' },
    });
    expect(fleet.servers.length).toBe(10);
    const call = fake.calls('GET', '/api/v1/fleet').at(-1);
    expect(call?.actor).toBe('prn_mara|Mara');
    expect(call?.role).toBe('viewer');
    expect(await client.healthy()).toEqual({ ok: true, reason: null });
  });

  it('turns problems into HostsError with the code and field errors', async () => {
    const err = await client
      .json({ path: '/api/v1/servers/nope' })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostsError);
    expect((err as HostsError).code).toBe('server_not_found');
    expect((err as HostsError).status).toBe(404);
    fake.on('PUT', '/api/v1/servers/*/guests/*/config', () => ({
      status: 400,
      body: { code: 'invalid_value', detail: 'Bad.', field_errors: { memory: 'a number' } },
    }));
    const bad = (await client
      .json({
        method: 'PUT',
        path: '/api/v1/servers/shale/guests/pve:100/config',
        body: { set: { memory: 'x' } },
      })
      .catch((e: unknown) => e)) as HostsError;
    expect(bad.fieldErrors).toEqual({ memory: 'a number' });
  });

  it('reads the token again after a 401 (a rotated file)', async () => {
    const other = await startFakeHosts({ token: 'old-token' });
    const c = new HostsClient({ socket: other.socket, tokenFile: other.tokenFile });
    await c.json({ path: '/api/v1/servers' });
    // The service now expects a new token, written to the same file with the same mtime granularity.
    (other as unknown as { token: string }).token = 'new-token';
    writeFileSync(other.tokenFile, 'new-token\n');
    await expect(c.json({ path: '/api/v1/servers' })).resolves.toBeTruthy();
    await other.stop();
  });

  it('says the service is unavailable when there is no socket or token', async () => {
    const none = new HostsClient({ socket: join(fake.dir, 'missing.sock'), tokenFile: fake.tokenFile });
    const err = (await none.json({ path: '/healthz' }).catch((e: unknown) => e)) as HostsUnavailable;
    expect(err).toBeInstanceOf(HostsUnavailable);
    expect(err.reason).toBe('not_running');
    const noToken = new HostsClient({ socket: fake.socket, tokenFile: join(fake.dir, 'no-token') });
    const e2 = (await noToken.json({ path: '/healthz' }).catch((e: unknown) => e)) as HostsUnavailable;
    expect(e2.reason).toBe('no_token');
  });

  it('follows the event stream and resumes with Last-Event-ID', async () => {
    const seen: HostsSseEvent[] = [];
    const states: boolean[] = [];
    const stream = new HostsEventStream(client, {
      onEvent: (e) => seen.push(e),
      onState: (up) => states.push(up),
      minDelayMs: 20,
      maxDelayMs: 50,
    });
    stream.start();
    await waitFor(() => fake.streams === 1);
    fake.emit('server.online', { id: 'basalt', at: 'now' });
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ event: 'server.online', data: { id: 'basalt' } });
    const lastId = seen[0]?.id;
    fake.dropStreams();
    await waitFor(() => fake.streams === 1);
    const resumed = fake.calls('GET', '/api/v1/events').at(-1);
    expect(resumed?.headers['last-event-id']).toBe(lastId);
    fake.emit('alert.opened', { id: 'al_9' });
    await waitFor(() => seen.length === 2);
    expect(states).toEqual([true, false, true]);
    stream.close();
  });
});

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
