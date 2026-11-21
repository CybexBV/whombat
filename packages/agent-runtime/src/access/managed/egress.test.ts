/**
 * The egress service's live policy (hermes-native.md HN-W15): a person's pod gets the grants of their live turns while
 * it runs, and what a policy allows is decided for every connection and name asked after the change.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type EgressService, joinPolicies, startEgress } from './egress';

const resolve = async (name: string) => {
  const table: Record<string, string> = { 'a.test': '93.184.215.14', 'b.test': '93.184.215.15' };
  const address = table[name];
  if (!address) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return [{ address, family: 4 }];
};

/** One name asked of the resolver's upstream, as the sandbox's DNS shim asks it. */
function ask(service: EgressService, name: string): Promise<{ rcode: string; addresses: string[] }> {
  return new Promise((done, fail) => {
    const socket = connect(service.dnsSocket);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`A ${name}\n`));
    socket.on('data', (d: string) => {
      buf += d;
    });
    socket.on('error', fail);
    socket.on('close', () => done(JSON.parse(buf)));
  });
}

describe('egress policy changes', () => {
  const dirs: string[] = [];
  const services: EgressService[] = [];
  afterEach(async () => {
    for (const s of services.splice(0)) await s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('decides with the newest policy, for the proxy and the resolver alike', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-egress-'));
    dirs.push(dir);
    const service = await startEgress({ dir: join(dir, 'net'), policy: { allow: ['a.test'] }, resolve });
    services.push(service);
    expect((await service.check('a.test', 443)).ok).toBe(true);
    expect((await service.check('b.test', 443)).ok).toBe(false);
    expect((await ask(service, 'b.test')).rcode).toBe('refused');

    service.setPolicy({ allow: ['b.test'] });
    expect((await service.check('a.test', 443)).ok).toBe(false);
    expect((await service.check('b.test', 443)).ok).toBe(true);
    expect(await ask(service, 'b.test')).toEqual({ rcode: 'ok', addresses: ['93.184.215.15'] });

    service.setPolicy({ allow: 'public' });
    expect((await service.check('a.test', 443)).ok).toBe(true);
  });

  it('joins policies: any public one opens every public host, hosts, grants and ports add up', () => {
    expect(joinPolicies([])).toEqual({ allow: [] });
    expect(joinPolicies([{ allow: ['a.test'] }, { allow: ['b.test', 'a.test'] }])).toEqual({
      allow: ['a.test', 'b.test'],
    });
    expect(
      joinPolicies([
        { allow: ['a.test'], grants: [{ cidr: '10.0.0.5/32', ports: [11434] }] },
        { allow: 'public' },
      ]),
    ).toEqual({ allow: 'public', grants: [{ cidr: '10.0.0.5/32', ports: [11434] }] });
    expect(joinPolicies([{ allow: ['a.test'] }, { allow: ['b.test'], ports: [8443] }]).ports).toEqual([
      443, 80, 8443,
    ]);
  });
});
