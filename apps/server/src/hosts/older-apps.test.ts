import { HOST_MONITORING_MINOR } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { hostAnswerFor, needsHostMonitoring } from './older-apps';

describe('hosts monitoring on older apps', () => {
  const older = HOST_MONITORING_MINOR - 1;

  it('gates limit changes, single-check reads and ownership on creation', () => {
    for (const [op, body] of [
      ['things.setWatchLimit', { limit: 95 }],
      ['hosts.getCheck', undefined],
      ['hosts.createCheck', { owner: 'whombat:connection:example' }],
    ] as const) {
      expect(needsHostMonitoring(op, body, older)).toBe(true);
      expect(needsHostMonitoring(op, body, HOST_MONITORING_MINOR)).toBe(false);
    }
    expect(needsHostMonitoring('hosts.createCheck', { name: 'Example' }, older)).toBe(false);
  });

  it('keeps the last result and old watch fields', () => {
    const check = {
      id: 'example',
      stale: true,
      owner: 'whombat:connection:example',
      last: { at: 'yesterday' },
    };
    const listed = { checks: [check] };
    expect(hostAnswerFor('hosts.listChecks', listed, older)).toEqual({
      checks: [{ id: 'example', last: { at: 'yesterday' } }],
    });
    expect(hostAnswerFor('hosts.listChecks', listed, HOST_MONITORING_MINOR)).toBe(listed);
    const watch = {
      checks: [{ check: 'host.disk.space_high', on: true, limit: { value: 95 } }],
      mayChange: true,
    };
    expect(hostAnswerFor('things.watch', watch, older)).toEqual({
      checks: [{ check: 'host.disk.space_high', on: true }],
      mayChange: true,
    });
  });
});
