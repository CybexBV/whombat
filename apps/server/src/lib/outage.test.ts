/**
 * A dependency down for a while, in the log (box-health.md BH-09, BH-10): info while the outage is young, one warning
 * once it lasts, debug for the retries between, one info line with how long when it is back.
 */
import { describe, expect, it } from 'vitest';
import { ManagerCallError, managerUnreachable } from '../managed/ports';
import { relayUnreachable } from '../managed/session/relay-client';
import { Outage, outageDuration } from './outage';

function recorder() {
  const lines: string[] = [];
  const at = (level: string) => (obj: object, msg: string) =>
    lines.push(
      `${level} ${msg}${'downForMs' in obj ? ` (${(obj as { downForMs: number }).downForMs})` : ''}`,
    );
  return { lines, log: { info: at('info'), warn: at('warn'), debug: at('debug') } };
}

describe('an outage in the log (BH-09)', () => {
  it('is info for the first five minutes, one warning after, and says how long when it is back', () => {
    let now = 1_000_000;
    const { lines, log } = recorder();
    const reach = new Outage({
      what: 'relay: the control plane',
      log: () => log,
      graceMs: 300_000,
      now: () => now,
    });
    reach.ok();
    expect(lines).toEqual([]);
    for (let i = 0; i < 4; i++) {
      reach.failed(new Error('Unexpected server response: 502'));
      now += 60_000;
    }
    expect(reach.down).toBe(true);
    for (let i = 0; i < 5; i++) {
      reach.failed(new Error('Unexpected server response: 502'));
      now += 30_000;
    }
    reach.ok();
    expect(lines).toEqual([
      'info relay: the control plane isn’t reachable; retrying',
      'debug relay: the control plane still isn’t reachable; retrying (60000)',
      'debug relay: the control plane still isn’t reachable; retrying (120000)',
      'debug relay: the control plane still isn’t reachable; retrying (180000)',
      'debug relay: the control plane still isn’t reachable; retrying (240000)',
      'debug relay: the control plane still isn’t reachable; retrying (270000)',
      'warn relay: the control plane still isn’t reachable after 5 min; retrying (300000)',
      'debug relay: the control plane still isn’t reachable; retrying (330000)',
      'debug relay: the control plane still isn’t reachable; retrying (360000)',
      'info relay: the control plane is reachable again after 6 min 30 s (390000)',
    ]);
    // A short one: info and back.
    lines.length = 0;
    reach.failed(new Error('connect ENOENT /run/whombat-manager/api.sock'));
    now += 12_000;
    reach.ok();
    expect(lines).toEqual([
      'info relay: the control plane isn’t reachable; retrying',
      'info relay: the control plane is reachable again after 12 s (12000)',
    ]);
  });

  it('counts the grace from a fixed moment when given one: the start of the server (BH-10)', () => {
    let now = 0;
    const { lines, log } = recorder();
    const reach = new Outage({
      what: 'feedback drop: the control plane',
      log: () => log,
      graceMs: 120_000,
      since: 0,
      now: () => now,
    });
    now = 5_000;
    reach.failed(new Error('the control plane isn’t reachable (connect ECONNREFUSED 127.0.0.1:443)'));
    now = 9_000;
    reach.ok();
    // Later, the control plane going away is news at once.
    now = 600_000;
    reach.failed(new Error('the control plane isn’t reachable'));
    expect(lines).toEqual([
      'info feedback drop: the control plane isn’t reachable; retrying',
      'info feedback drop: the control plane is reachable again after 4 s (4000)',
      'warn feedback drop: the control plane isn’t reachable; retrying',
    ]);
  });

  it('reads durations plainly', () => {
    expect(outageDuration(400)).toBe('0 s');
    expect(outageDuration(42_000)).toBe('42 s');
    expect(outageDuration(180_000)).toBe('3 min');
    expect(outageDuration(3_725_000)).toBe('1 h 2 min');
    expect(outageDuration(7_200_000)).toBe('2 h');
  });

  it('only a manager or relay that can’t be reached is an outage; a refusal stays an error', () => {
    const control = new ManagerCallError(
      '/v1/runtime/ticket',
      503,
      'unavailable',
      'manager /v1/runtime/ticket: 503 {"error":{"code":"unavailable","message":"control unavailable: control HTTP 502"}}',
    );
    expect(managerUnreachable(control)).toBe(true);
    expect(
      managerUnreachable(
        new ManagerCallError('/v1/runtime/feedback/pull', 0, 'unreachable', 'connect ENOENT'),
      ),
    ).toBe(true);
    expect(managerUnreachable(new ManagerCallError('/v1/runtime/ticket', 403, 'forbidden', 'refused'))).toBe(
      false,
    );
    expect(managerUnreachable(new Error('manager /v1/runtime/ticket: not JSON'))).toBe(false);
    expect(relayUnreachable(new Error('Unexpected server response: 502'))).toBe(true);
    expect(relayUnreachable(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(
      true,
    );
    expect(relayUnreachable(new Error('Unexpected server response: 401'))).toBe(false);
    expect(relayUnreachable(new Error('Invalid WebSocket frame'))).toBe(false);
  });
});
