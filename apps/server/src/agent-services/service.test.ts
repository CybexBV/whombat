/**
 * The agent's services against an in-process engine (one-person.md OP-19, OP-S44…OP-S46): only labelled containers with
 * a port of 20000–20099, at most five, in port order, with the box's home-network address; Podman's states in the
 * person's words; Stop through the engine; unavailable without an engine or when it doesn't answer; a change is told.
 */
import { join } from 'node:path';
import { SERVICES_NOT_HERE } from '@whombat/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SocketEngine } from './engine';
import {
  AgentServices,
  SERVICES_MAX,
  SERVICES_NOT_ANSWERING,
  ServiceNotFound,
  serviceState,
  servicesOf,
  serviceUrl,
  toAgentService,
} from './service';
import { FakeEngine, serviceContainer } from './testing';

const hex = (c: string) => c.repeat(64);

describe('a container as a service', () => {
  it('needs the label and a port in the range', () => {
    expect(toAgentService(serviceContainer(), '192.168.1.20')).toEqual({
      id: hex('a'),
      name: 'invoice-site',
      port: 20_000,
      url: 'http://192.168.1.20:20000',
      state: 'running',
      startedAt: new Date(1_790_000_100_000).toISOString(),
      image: 'node:24-alpine',
    });
    expect(toAgentService(serviceContainer({ Labels: {} }), null)).toBeNull();
    expect(toAgentService(serviceContainer({ Labels: { 'whombat.service': '0' } }), null)).toBeNull();
    expect(toAgentService(serviceContainer({ port: 8080 }), null)).toBeNull();
    expect(toAgentService(serviceContainer({ port: 20_100 }), null)).toBeNull();
    expect(toAgentService(serviceContainer({ Id: 'not-hex' }), null)).toBeNull();
    // A UDP port isn't the service's address.
    expect(
      toAgentService(
        serviceContainer({ Ports: [{ PublicPort: 20_001, PrivatePort: 53, Type: 'udp' }] }),
        null,
      ),
    ).toBeNull();
    expect(toAgentService(serviceContainer({ Names: [] }), null)?.name).toBe('aaaaaaaaaaaa');
    expect(toAgentService(serviceContainer(), null)?.url).toBeNull();
  });

  it('reads the engine’s state as the person does', () => {
    expect(serviceState({ State: 'running' })).toBe('running');
    expect(serviceState({ State: 'created' })).toBe('starting');
    expect(serviceState({ State: 'restarting' })).toBe('starting');
    expect(serviceState({ State: 'exited', Status: 'Exited (0) 2 minutes ago' })).toBe('stopped');
    expect(serviceState({ State: 'exited', Status: 'Exited (143) 2 minutes ago' })).toBe('stopped');
    expect(serviceState({ State: 'exited', Status: 'Exited (1) 2 minutes ago' })).toBe('failed');
    expect(serviceState({ State: 'dead' })).toBe('failed');
  });

  it('brackets an IPv6 address', () => {
    expect(serviceUrl('fd00::5', 20_003)).toBe('http://[fd00::5]:20003');
  });

  it('counts at most five, in port order', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      serviceContainer({ Id: hex(String(i)), Names: [`/s${i}`], port: 20_010 - i }),
    );
    const listed = servicesOf(many, '10.0.0.2');
    expect(listed).toHaveLength(SERVICES_MAX);
    expect(listed.map((s) => s.port)).toEqual([20_004, 20_005, 20_006, 20_007, 20_008]);
  });
});

describe('the services through the engine’s socket', () => {
  const fake = new FakeEngine();
  let services: AgentServices;

  beforeAll(async () => {
    await fake.start();
  });
  afterAll(async () => {
    await fake.close();
  });
  beforeEach(() => {
    fake.containers = [
      serviceContainer(),
      serviceContainer({ Id: hex('b'), Names: ['/grafana'], port: 20_001, Image: 'grafana/grafana:11' }),
      // Not one of the agent's services: no label.
      serviceContainer({ Id: hex('c'), Labels: { other: '1' }, port: 20_002 }),
    ];
    fake.failWith = null;
    services = new AgentServices({ engine: new SocketEngine(fake.socket), address: () => '192.168.1.20' });
  });

  it('lists only the labelled ones, asking the engine with the label filter', async () => {
    const out = await services.list();
    expect(out.available).toBe(true);
    expect(out.services.map((s) => s.name)).toEqual(['invoice-site', 'grafana']);
    const asked = new URL(fake.requests.at(-1)?.url ?? '', 'http://engine');
    expect(asked.pathname).toBe('/v1.41/containers/json');
    expect(asked.searchParams.get('all')).toBe('1');
    expect(JSON.parse(asked.searchParams.get('filters') ?? '')).toEqual({ label: ['whombat.service=1'] });
  });

  it('stops one; a stopped one stays as it is; one that isn’t there is not found', async () => {
    const stopped = await services.stop(hex('a'));
    expect(stopped).toMatchObject({ id: hex('a'), state: 'stopped' });
    expect(
      fake.requests.some(
        (r) => r.method === 'POST' && r.url.startsWith(`/v1.41/containers/${hex('a')}/stop`),
      ),
    ).toBe(true);
    expect((await services.stop(hex('a'))).state).toBe('stopped');
    await expect(services.stop(hex('d'))).rejects.toBeInstanceOf(ServiceNotFound);
  });

  it('tells a change, not a list that stayed the same', async () => {
    const seen: number[] = [];
    const off = services.onChange((l) => seen.push(l.services.length));
    await services.list();
    await services.list();
    expect(seen).toEqual([]);
    fake.containers.pop();
    fake.containers.pop();
    await services.list();
    expect(seen).toEqual([1]);
    off();
  });

  it('isn’t available while the engine is in trouble, or not there at all', async () => {
    fake.failWith = 500;
    expect(await services.list()).toEqual({ available: false, reason: SERVICES_NOT_ANSWERING, services: [] });
    const gone = new AgentServices({ engine: new SocketEngine(join(fake.dir, 'missing.sock')) });
    expect((await gone.list()).reason).toBe(SERVICES_NOT_ANSWERING);
    const none = AgentServices.fromConfig({ WHOMBAT_CONTAINERS_SOCKET: undefined });
    expect(none.hostStatus()).toEqual({ available: false, reason: SERVICES_NOT_HERE });
    expect(await none.list()).toEqual({ available: false, reason: SERVICES_NOT_HERE, services: [] });
    await expect(none.stop(hex('a'))).rejects.toBeInstanceOf(ServiceNotFound);
  });
});
