import { TailnetDevicesOutput } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../mcp/tools';
import { silentLogger } from '../services';
import { FakeTailscale, setTailscaleFor, TailscaleService } from './direct/tailscale';
import { tailnetDevicesTool } from './tailnet-tool';

const PEERS = [
  {
    name: 'blackbox.tail1234.ts.net',
    addresses: ['100.64.12.11'],
    os: 'linux',
    online: false,
    lastSeen: '2026-10-30T15:21:30Z',
    routes: ['10.100.0.0/23'],
    exitNode: false,
  },
  {
    name: 'ha.tail1234.ts.net',
    addresses: ['100.64.12.10'],
    os: 'linux',
    online: true,
    lastSeen: null,
    routes: [],
    exitNode: false,
  },
];

function world() {
  const fake = new FakeTailscale();
  fake.peers = PEERS;
  const tailscale = new TailscaleService(fake, silentLogger);
  const services = { log: silentLogger };
  setTailscaleFor(services, tailscale);
  const ctx = { services } as unknown as ToolContext;
  return { fake, tailscale, ctx };
}

describe('tailnet_devices', () => {
  it('lists the tailnet’s devices by short and full name, online first, while Tailscale is on', async () => {
    const { fake, tailscale, ctx } = world();
    await tailscale.turnOn();
    fake.completeSignIn();
    const out = TailnetDevicesOutput.parse(await tailnetDevicesTool(ctx, {}));
    expect(out).toMatchObject({ status: 'ok', self: 'box.tail0000.ts.net' });
    if (out.status !== 'ok') throw new Error(out.status);
    expect(out.devices.map((d) => [d.name, d.dnsName, d.online])).toEqual([
      ['ha', 'ha.tail1234.ts.net', true],
      ['blackbox', 'blackbox.tail1234.ts.net', false],
    ]);
    expect(out.devices[1]?.routes).toEqual(['10.100.0.0/23']);
    const online = await tailnetDevicesTool(ctx, { online: true });
    expect(online.status === 'ok' && online.devices.map((d) => d.name)).toEqual(['ha']);
  });

  it('says off, signed out or unavailable instead of a list', async () => {
    const { fake, tailscale, ctx } = world();
    expect((await tailnetDevicesTool(ctx, {})).status).toBe('off');
    await tailscale.turnOn();
    expect(await tailnetDevicesTool(ctx, {})).toMatchObject({
      status: 'off',
      message: expect.stringContaining('Settings'),
    });
    expect(fake.calls).not.toContain('peers');
    const none = { services: { log: silentLogger } } as unknown as ToolContext;
    expect((await tailnetDevicesTool(none, {})).status).toBe('unavailable');
    fake.completeSignIn();
    fake.tailscalePeers = async () => {
      throw new Error('503 unavailable');
    };
    expect((await tailnetDevicesTool(ctx, {})).status).toBe('unavailable');
  });
});
