/**
 * A server's or a machine's power counts only once the hosts service said how it ended (docs/decisions/
 * direct-automations.md): listening starts before the call, a refusal is a refusal, and no word in time is unknown.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostsChange } from '../hosts/service';
import { listenForPowerFinish, powerSettle, withNames } from './direct-action';
import { stepsActed } from './steps/post-message';

function fakeHosts() {
  const listeners = new Set<(change: HostsChange) => void>();
  return {
    onChange(listener: (change: HostsChange) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    finish(actionId: string, data: Record<string, unknown> = {}) {
      for (const l of listeners)
        l({
          kind: 'task',
          serverId: 'nas-01',
          guestId: null,
          data: {
            event: 'action.finished',
            action_id: actionId,
            result: 'ok',
            noop: false,
            code: null,
            ...data,
          },
        });
    },
    get listening() {
      return listeners.size;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('listenForPowerFinish', () => {
  it('hears an action that ended before its id was known, and one that ends later', async () => {
    const hosts = fakeHosts();
    const listening = listenForPowerFinish(hosts);
    hosts.finish('act_early', { noop: true });
    await expect(listening.wait('act_early', 1000)).resolves.toEqual({ ok: true, noop: true, code: null });
    const later = listening.wait('act_later', 1000);
    hosts.finish('act_other', { result: 'error' });
    hosts.finish('act_later', { result: 'error', code: 'remote_control_disabled' });
    await expect(later).resolves.toEqual({ ok: false, noop: false, code: 'remote_control_disabled' });
    listening.stop();
    expect(hosts.listening).toBe(0);
  });

  it('gives up after its time, and knows nothing without an id', async () => {
    vi.useFakeTimers();
    const listening = listenForPowerFinish(fakeHosts());
    const waiting = listening.wait('act_silent', 5000);
    vi.advanceTimersByTime(5000);
    await expect(waiting).resolves.toBeNull();
    await expect(listening.wait(null, 5000)).resolves.toBeNull();
    listening.stop();
  });
});

describe('powerSettle', () => {
  const server = { thing: 'server:nas-01', action: 'shut_down' as const };
  const machine = { thing: 'server:nas-01', target: 'pve:110', action: 'stop' as const };

  it('is done only when the server said it went well', () => {
    expect(powerSettle(server, { ok: true, noop: false, code: null })).toEqual({
      kind: 'done',
      outcome: { kind: 'done', result: 'switching_off' },
    });
    expect(powerSettle(server, { ok: false, noop: false, code: 'remote_control_disabled' })).toEqual({
      kind: 'refused',
      code: 'remote_control_disabled',
    });
    expect(powerSettle(server, null)).toEqual({ kind: 'unknown' });
  });

  it('says a machine already so is a quiet no-op', () => {
    expect(powerSettle(machine, { ok: true, noop: true, code: null })).toEqual({
      kind: 'done',
      outcome: { kind: 'noop', already: 'stopped' },
    });
    expect(powerSettle({ ...machine, action: 'start' }, { ok: true, noop: true, code: null })).toMatchObject({
      outcome: { kind: 'noop', already: 'running' },
    });
  });
});

describe('withNames', () => {
  it('replaces the names a step was saved with, and drops a target name Whombat couldn’t read', () => {
    const saved = {
      id: 'off',
      kind: 'run_action' as const,
      thing: 'server:nas-01',
      thingName: 'plex box',
      target: 'pve:110',
      targetName: 'plex',
      action: 'shut_down' as const,
      otherwise: 'fail' as const,
      retries: 0,
    };
    expect(withNames(saved, { thingName: 'nas-01', targetName: 'nextcloud' })).toMatchObject({
      thingName: 'nas-01',
      targetName: 'nextcloud',
    });
    expect(withNames(saved, { thingName: 'nas-01' })).not.toHaveProperty('targetName');
  });
});

describe('stepsActed', () => {
  it('counts an action that may have happened, so a quiet window never hides it', () => {
    expect(stepsActed([{ output: { ran: false, text: 'x' } }, { output: {} }])).toBe(false);
    expect(stepsActed([{ output: { ran: false, noop: true } }])).toBe(false);
    expect(stepsActed([{ output: { ran: true } }])).toBe(true);
    expect(stepsActed([{ output: { ran: false, unconfirmed: true } }])).toBe(true);
  });
});
