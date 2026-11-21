import type { HostAddressChange, HostRepoint } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import { repointRequested, repointRowLabel, repointRows, repointView } from './repoint';

const change: HostAddressChange = {
  from: '10.100.1.160',
  to: '10.100.1.158',
  changedAt: '2026-10-21T10:00:00.000Z',
  waiting: [
    { id: 'pve-01', name: 'pve-01', address: '10.100.1.20' },
    { id: 'blackbox', name: 'blackbox', address: null },
  ],
};

const job = (over: Partial<HostRepoint> = {}): HostRepoint => ({
  id: 'rpt_aaaaaaaaaaaa',
  to: '10.100.1.158',
  state: 'running',
  servers: [
    { id: 'pve-01', name: 'pve-01', address: '10.100.1.20', state: 'pointed', error: null },
    { id: 'blackbox', name: 'blackbox', address: null, state: 'pointing', error: null },
  ],
  startedAt: '2026-10-21T10:06:00.000Z',
  finishedAt: null,
  ...over,
});

describe('Point them here (BF-15, BF-16; AP-4415)', () => {
  it('opens on ?repoint=1', () => {
    expect(repointRequested({ repoint: '1' })).toBe(true);
    expect(repointRequested({ add: '1' })).toBe(false);
  });

  it('asks with the address change and its waiting servers', () => {
    const v = repointView(change, null);
    expect(v.step).toBe('ask');
    expect(v.title).toBe('Point them here');
    expect(v.lead).toContain('10.100.1.160');
    expect(v.lead).toContain('10.100.1.158');
    expect(v.servers).toEqual(['pve-01', 'blackbox']);
    expect(v.rows.map((r) => [r.name, r.address, r.state])).toEqual([
      ['pve-01', '10.100.1.20', null],
      ['blackbox', null, null],
    ]);
    expect(repointView({ ...change, waiting: [change.waiting[0] as never] }, null).title).toBe(
      'Point it here',
    );
  });

  it('waits for the read and says when nothing is left to point', () => {
    expect(repointView(undefined, null).step).toBe('loading');
    const nothing = repointView(null, null);
    expect(nothing).toMatchObject({ step: 'nothing', rows: [], servers: [] });
    expect(nothing.lead).toBeTruthy();
    expect(repointView({ ...change, waiting: [] }, null).step).toBe('nothing');
  });

  it('follows the job server by server, and offers Add a server where a password is needed', () => {
    const running = repointView(change, job());
    expect(running.step).toBe('running');
    expect(running.rows.map((r) => [r.id, r.stateText, r.tone])).toEqual([
      ['pve-01', 'Pointed here', 'ok'],
      ['blackbox', 'Pointing it here…', 'mut'],
    ]);
    expect(running.outcome).toBeNull();
    const done = repointView(
      null,
      job({
        state: 'done',
        finishedAt: '2026-10-21T10:07:00.000Z',
        servers: [
          { id: 'pve-01', name: 'pve-01', address: '10.100.1.20', state: 'pointed', error: null },
          { id: 'pve-02', name: 'pve-02', address: '10.100.1.21', state: 'no_key', error: null },
          {
            id: 'blackbox',
            name: 'blackbox',
            address: null,
            state: 'failed',
            error: { code: 'sign_in_failed', message: 'blackbox didn’t take that key.' },
          },
        ],
      }),
    );
    expect(done.step).toBe('done');
    expect(done.outcome).toContain('Pointed 1 server');
    const [pointed, noKey, failed] = done.rows;
    expect(pointed?.addServer).toBeNull();
    expect(noKey).toMatchObject({
      stateText: 'Needs a password',
      tone: 'warn',
      addServer: { address: '10.100.1.21' },
    });
    expect(noKey?.line).toContain('Vault');
    expect(failed).toMatchObject({
      tone: 'bad',
      line: 'blackbox didn’t take that key.',
      addServer: { address: '' },
    });
    expect(repointRowLabel(noKey as never)).toContain('pve-02, 10.100.1.21');
  });

  it('lists the waiting servers before a job, the job’s after', () => {
    expect(repointRows(change, null)).toHaveLength(2);
    expect(repointRows(null, job({ servers: [] }))).toEqual([]);
  });
});
