import { describe, expect, it } from 'vitest';
import { MaintenanceGate } from './maintenance';

describe('a command at the drain gate', () => {
  it('goes through at once when nothing drains, and when only a write barrier is held', async () => {
    const gate = new MaintenanceGate();
    expect(await gate.opened()).toBe(true);
    gate.drain('backup', new Date(), { requestId: 'backup-1', scope: 'writes', leaseMs: 60_000 });
    expect(await gate.opened()).toBe(true);
    gate.resume('backup-1');
  });

  it('waits for a short drain to end', async () => {
    const gate = new MaintenanceGate();
    gate.drain('update', new Date(), { requestId: 'drain-1', leaseMs: 60_000 });
    const waiting = gate.opened();
    gate.resume('drain-1');
    expect(await waiting).toBe(true);
  });

  it('is turned away when the drain outlasts settleMs', async () => {
    const gate = new MaintenanceGate();
    gate.settleMs = 10;
    gate.drain('update', new Date(), { requestId: 'drain-1', leaseMs: 60_000 });
    expect(await gate.opened()).toBe(false);
    gate.resume('drain-1');
  });
});
