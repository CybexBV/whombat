/**
 * The runner's side of the commands' wall: every opening it sends holds for a short while only, renewed with each
 * policy it sets, so the daemon closes it by itself when the runner stops; a removal the daemon didn't take is a
 * failure, not a success.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_POLICY, HeldPolicy, startControl } from '@whombat/agent-net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentNet, OPENING_LEASE_MS } from './net';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wb-net-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const server = { address: '203.0.113.10', port: 22 };

/** A daemon's control socket holding what it gets on a clock of its own. */
async function daemon() {
  let t = 1_000;
  const held = new HeldPolicy(() => t);
  const control = await startControl({
    path: join(root, 'control.sock'),
    apply: (p) => held.set(p),
    current: () => held.get() ?? EMPTY_POLICY,
  });
  return { held, control, advance: (ms: number) => (t += ms) };
}

describe('the runner’s openings', () => {
  it('sends every opening with a time limit no longer than the lease, and a “once” one until it closes', async () => {
    let clock = 50_000;
    const net = new AgentNet({ control: join(root, 'control.sock'), log: () => {}, now: () => clock });
    await net.open('dsp_a', [server]);
    await net.open('dsp_b', [{ ...server, port: 443 }], Number.POSITIVE_INFINITY);
    for (const o of net.policy().open) expect(o.ttlMs).toBe(OPENING_LEASE_MS);
    await net.closeAt('dsp_b', ['203.0.113.10:443'], clock + 20_000).catch(() => {});
    expect(net.policy().open.find((o) => o.port === 443)?.ttlMs).toBe(20_000);
    clock += 20_000;
    expect(net.policy().open).toEqual([{ ...server, ttlMs: OPENING_LEASE_MS }]);
  });

  it('says a removal failed when the daemon didn’t take it', async () => {
    const d = await daemon();
    const logs: string[] = [];
    const net = new AgentNet({ control: join(root, 'control.sock'), log: (_l, m) => logs.push(m) });
    await net.open('dsp_a', [server]);
    await net.open('dsp_b', [{ ...server, port: 443 }], Number.POSITIVE_INFINITY);
    expect(d.held.get()?.open).toHaveLength(2);
    await d.control.close();
    await expect(net.closeAt('dsp_b', ['203.0.113.10:443'], Date.now() + 60_000)).rejects.toThrow();
    await expect(net.drop('dsp_a')).rejects.toThrow();
    expect(logs.join('\n')).toMatch(/couldn't be set/);
  });

  it('lets the daemon close its openings once it stops renewing them', async () => {
    const d = await daemon();
    const net = new AgentNet({ control: join(root, 'control.sock'), log: () => {} });
    await net.open('dsp_a', [server]);
    // Renewed every half minute, the opening holds.
    for (let i = 0; i < 4; i++) {
      d.advance(30_000);
      await net.push();
      expect(d.held.get()?.open).toMatchObject([server]);
    }
    // The runner stops (crashed, hung, or every update fails): within the lease the opening is gone.
    net.close();
    d.advance(OPENING_LEASE_MS);
    expect(d.held.get()?.open).toEqual([]);
    await d.control.close();
  });
});
