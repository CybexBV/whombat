import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentMcp, parseMcpHttpAnswer } from './agent-turn.ts';
import { fakeHaAnswer, isRfc1918, pickPrivateIpv4, startFakeHomeAssistant } from './fake-home-assistant.ts';
import { plaintextNeedles } from './feedback-site.ts';
import { needleHits, scanCommand } from './secret-scan.ts';

const v4 = (address: string, internal = false) => ({
  address,
  family: 'IPv4' as const,
  internal,
  netmask: '255.255.255.0',
  mac: '00:00:00:00:00:00',
  cidr: `${address}/24`,
});

describe('scenario p kit', () => {
  it('picks a private IPv4 of a physical interface, never loopback, public or shared space', () => {
    expect(['10.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.1.7'].every(isRfc1918)).toBe(true);
    expect(
      ['127.0.0.1', '172.32.0.1', '100.64.0.1', '8.8.8.8', '192.169.0.1', '10.0.0'].some(isRfc1918),
    ).toBe(false);
    expect(
      pickPrivateIpv4({
        lo: [v4('127.0.0.1', true)],
        docker0: [v4('172.17.0.1')],
        tailscale0: [v4('100.101.1.2')],
        eth0: [v4('10.1.2.3'), v4('203.0.113.9')],
      }),
    ).toEqual({ address: '10.1.2.3', iface: 'eth0' });
    expect(pickPrivateIpv4({ docker0: [v4('172.17.0.1')], lo: [v4('127.0.0.1', true)] })).toEqual({
      address: '172.17.0.1',
      iface: 'docker0',
    });
    expect(pickPrivateIpv4({ lo: [v4('127.0.0.1', true)], eth0: [v4('203.0.113.9')] })).toBeNull();
  });

  it('the fake never repeats what it received, in results or errors', () => {
    const call = (name: string, args: Record<string, unknown>) =>
      JSON.stringify(
        fakeHaAnswer({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      );
    expect(fakeHaAnswer({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    for (const answer of [
      call('HassTurnOn', { name: 'Kitchen light' }),
      call('HassTurnOn', { name: 'nowhere' }),
      call('GetLiveContext', {}),
      call('GetLiveContext', { area: 'nowhere' }),
      call('Nothing', {}),
    ])
      expect(answer).not.toContain('tok');
    expect(call('HassTurnOn', { name: 'Kitchen light' })).toContain('Turned on Kitchen light.');
    expect(call('HassTurnOn', { name: 'nowhere' })).toContain('"isError":true');
    expect(call('GetLiveContext', { area: 'nowhere' })).toContain('"code":-32602');
  });

  it('reads JSON and SSE answers', () => {
    const one = { jsonrpc: '2.0', id: 1, result: { ok: true } };
    expect(parseMcpHttpAnswer('application/json', JSON.stringify(one))).toEqual([one]);
    expect(parseMcpHttpAnswer('application/json', JSON.stringify([one, one]))).toHaveLength(2);
    expect(
      parseMcpHttpAnswer('text/event-stream', `event: message\ndata: ${JSON.stringify(one)}\n\n`),
    ).toEqual([one]);
    expect(parseMcpHttpAnswer('application/json', '')).toEqual([]);
  });

  it('serves MCP over streamable HTTP to a client with the token, and refuses one without', async () => {
    const token = randomBytes(16).toString('hex');
    const fake = await startFakeHomeAssistant('127.0.0.1', token);
    try {
      const transcript: string[] = [];
      const mcp = await agentMcp(fake.url, token, transcript);
      expect((await mcp.listTools()).map((t) => t.name)).toEqual(['HassTurnOn', 'GetLiveContext']);
      const on = await mcp.callTool('HassTurnOn', { name: 'Kitchen light' });
      expect(on.content?.[0]?.text).toBe('Turned on Kitchen light.');
      expect(JSON.stringify(on)).not.toContain(token);
      // As Hermes reaches an MCP entry's server: with the headers the turn's keys carry (CT-1241).
      const asHermes = await agentMcp(fake.url, { authorization: `Bearer ${token}` }, transcript);
      await asHermes.callTool('GetLiveContext', {});
      expect(fake.requests.map((r) => r.rpc.join(','))).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/call',
        'initialize',
        'notifications/initialized',
        'tools/call',
      ]);
      expect(fake.requests.every((r) => r.bearerOk)).toBe(true);
      expect(fake.requests.at(-1)?.tools).toEqual(['GetLiveContext']);
      await expect(agentMcp(fake.url, 'wrong', [])).rejects.toThrow(/401/);
      expect(fake.requests.at(-1)).toMatchObject({ status: 401, bearerOk: false, hadAuthorization: true });
      const get = await fetch(fake.url, { headers: { authorization: `Bearer ${token}` } });
      expect(get.status).toBe(405);
    } finally {
      await fake.close();
    }
  });

  it('finds a canary in any encoding, also split between two chunks of a stream', async () => {
    const canary = `ha${randomBytes(20).toString('hex')}`;
    const needles = plaintextNeedles('canary', canary);
    expect(needleHits('x', 'nothing here', needles)).toEqual([]);
    expect(needleHits('x', `{"authorization":"Bearer ${canary}"}`, needles)).toEqual(['x: canary (bytes)']);
    expect(needleHits('x', `id ${Buffer.from(`--${canary}`).toString('base64')}`, needles)).toContain(
      'x: canary (base64, offset 2)',
    );
    const half = canary.length >> 1;
    const script = `process.stdout.write('a'.repeat(70000) + ${JSON.stringify(canary.slice(0, half))}); setTimeout(() => process.stdout.write(${JSON.stringify(canary.slice(half))} + 'z'), 50);`;
    const streamed = await scanCommand('dump', process.execPath, ['-e', script], needles);
    expect(streamed).toMatchObject({ code: 0, hits: ['dump: canary (bytes)'] });
  });
});
