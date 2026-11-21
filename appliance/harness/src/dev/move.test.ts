import { describe, expect, it } from 'vitest';
import {
  boxLines,
  freezeRecord,
  installPlan,
  internalOnlyOpen,
  leasedSetup,
  type MoveDevice,
  type MoveRollout,
  offeredToAll,
  REHEARSAL_HOLD_S,
  reachesTarget,
  recordedReleases,
  rolloutEnd,
  settle,
} from './move.ts';
import { REHEARSAL, wavesFor } from './publish-release.ts';

const NOW = 1_800_000_000_000;
const seen = (agoS: number) => NOW / 1000 - agoS;
const home = (release: string, state = 'Healthy', extra: Partial<MoveDevice> = {}): MoveDevice => ({
  device: 'wb-home',
  name: 'Home',
  state: 'claimed',
  lastSeenAt: seen(60),
  status: { release, update: { state } },
  ...extra,
});
const completed = (release: string, createdAt: number): MoveRollout => ({
  rollout: `ro_${createdAt}`,
  release,
  state: 'completed',
  createdAt,
  waves: [{ cohorts: ['internal', 'pilot', 'canary', 'general'] }],
});

describe('the freeze settles the boxes before the move records them', () => {
  const rollouts = [
    completed('whombat-dev-20261118.10', 10),
    completed('whombat-dev-20261118.11', 11),
    { rollout: 'ro_s', release: 'whombat-dev-20261118.12', state: 'stopped', createdAt: 12 },
  ];

  it('knows the release DEV control offers every box: the newest completed rollout’s, not a stopped one', () => {
    expect(offeredToAll(rollouts)).toBe('whombat-dev-20261118.11');
    expect(offeredToAll([])).toBeNull();
  });

  it('is settled only with no open rollout and every box steady on what it is offered', () => {
    const ok = settle([home('whombat-dev-20261118.11')], rollouts, NOW);
    expect(ok.settled).toBe(true);
    expect(ok.boxes[0]).toMatchObject({ release: 'whombat-dev-20261118.11', settled: true });

    // An open rollout (a candidate that finished publishing while the freeze waited) is not settled.
    const open = settle(
      [home('whombat-dev-20261118.11')],
      [...rollouts, { rollout: 'ro_o', release: 'whombat-dev-20261118.13', state: 'active', createdAt: 13 }],
      NOW,
    );
    expect(open.settled).toBe(false);
    expect(open.open).toEqual(['ro_o (whombat-dev-20261118.13, active)']);

    // Healthy on the previous release while the newest completed one is offered: it would take it at its next check.
    const behind = settle([home('whombat-dev-20261118.10')], rollouts, NOW);
    expect(behind.settled).toBe(false);
    expect(behind.boxes[0]?.why).toContain('whombat-dev-20261118.11 is offered');

    // Under way, or not heard from: not settled.
    expect(settle([home('whombat-dev-20261118.10', 'Staged')], rollouts, NOW).settled).toBe(false);
    expect(
      settle([home('whombat-dev-20261118.11', 'Healthy', { lastSeenAt: seen(7200) })], rollouts, NOW).boxes[0]
        ?.why,
    ).toContain('not heard from');

    // Back on its known-good release after a failed one: steady, control doesn't offer it again.
    expect(settle([home('whombat-dev-20261118.10', 'RolledBack')], rollouts, NOW).settled).toBe(true);
    // A device the operator vouched for, and one not claimed, don't count.
    const quiet = { ...home('whombat-dev-20261001.1', 'Healthy', { lastSeenAt: null }), device: 'wb-quiet' };
    expect(settle([home('whombat-dev-20261118.11'), quiet], rollouts, NOW, ['wb-quiet']).settled).toBe(true);
    expect(settle([{ ...quiet, state: 'retired' }], rollouts, NOW).settled).toBe(true);
  });

  it('records each box’s release under the freeze’s reason, the list the carry takes', () => {
    const s = settle([home('whombat-dev-20261118.11')], rollouts, NOW);
    const file = freezeRecord('the move to GitHub, 2026-11-19\n', s.boxes);
    expect(file.split('\n')[0]).toBe('the move to GitHub, 2026-11-19');
    expect(recordedReleases(file)).toEqual({ 'wb-home': 'whombat-dev-20261118.11' });
    expect(boxLines(s.boxes)).toEqual(['Home (wb-home): whombat-dev-20261118.11, Healthy']);
  });
});

describe('the bridge rehearsal reaches the VM only', () => {
  it('holds the internal wave a week, so control can’t complete it and offer it to every box', () => {
    expect(wavesFor('rehearsal', 'wb-vm')).toBe(REHEARSAL);
    expect(REHEARSAL).toHaveLength(1);
    expect(REHEARSAL[0]?.cohorts).toEqual(['internal']);
    expect(REHEARSAL[0]?.minObservationS).toBe(REHEARSAL_HOLD_S);
    expect(REHEARSAL_HOLD_S).toBeGreaterThanOrEqual(7 * 24 * 3600);
    expect(() => wavesFor('rehearsal', null)).toThrow(/--rollout/);
  });

  it('is stopped whatever happened; a failure elsewhere stays paused for a look', () => {
    expect(rolloutEnd('rehearsal', false)).toBe('stop');
    expect(rolloutEnd('rehearsal', true)).toBe('stop');
    expect(rolloutEnd('default', false)).toBe('stop');
    expect(rolloutEnd('default', true)).toBe('pause');
  });

  it('finds an open rollout to the internal cohort, which retiring the VM would complete', () => {
    const rehearsal: MoveRollout = {
      rollout: 'ro_r',
      release: 'whombat-dev-20261119.1',
      state: 'paused',
      waves: [{ cohorts: ['internal'] }],
    };
    const everyone: MoveRollout = { ...completed('whombat-dev-20261118.11', 1), state: 'active' };
    expect(internalOnlyOpen([rehearsal, everyone]).map((r) => r.rollout)).toEqual(['ro_r']);
    expect(internalOnlyOpen([{ ...rehearsal, state: 'stopped' }])).toEqual([]);
  });
});

describe('the VM starts where Home is', () => {
  const runtimeOnly = { class: 'runtime', tuple: { host: { version: 'whombat-dev-20261118.8' } } };

  it('installs a runtime-only release’s host, then takes the release from DEV control', () => {
    expect(installPlan('whombat-dev-20261118.11', runtimeOnly, null)).toEqual({
      iso: 'whombat-dev-20261118.8',
      target: 'whombat-dev-20261118.11',
    });
    expect(
      installPlan(
        'whombat-dev-20261118.11',
        { class: 'runtime', tuple: { host: 'whombat-dev-20261118.8' } },
        null,
      ).iso,
    ).toBe('whombat-dev-20261118.8');
    expect(installPlan('whombat-dev-20261118.8', { class: 'host' }, null)).toEqual({
      iso: 'whombat-dev-20261118.8',
      target: 'whombat-dev-20261118.8',
    });
    expect(installPlan('whombat-dev-20261118.11', null, 'whombat-dev-20261117.2').iso).toBe(
      'whombat-dev-20261117.2',
    );
    expect(() => installPlan('whombat-dev-20261118.11', null, null)).toThrow(/--from/);
  });

  it('only when DEV control offers every box that release and no rollout is open', () => {
    const offered = [completed('whombat-dev-20261118.11', 11)];
    expect(reachesTarget('whombat-dev-20261118.8', 'whombat-dev-20261118.11', offered)).toBeNull();
    expect(reachesTarget('whombat-dev-20261118.11', 'whombat-dev-20261118.11', [])).toBeNull();
    expect(
      reachesTarget('whombat-dev-20261118.8', 'whombat-dev-20261118.11', [
        completed('whombat-dev-20261118.10', 10),
      ]),
    ).toContain('offers every box whombat-dev-20261118.10');
    expect(
      reachesTarget('whombat-dev-20261118.8', 'whombat-dev-20261118.11', [
        ...offered,
        { rollout: 'ro_b', release: 'whombat-dev-20261119.1', state: 'paused' },
      ]),
    ).toContain('a rollout is open');
  });

  it('under a lease, makes the empty VM the lease launched the DEV box’s', () => {
    const cmds = leasedSetup({
      vm: 'ar-1234-abcd',
      rawQemu: '-monitor tcp:127.0.0.1:5801,server=on,wait=off',
      path: '/run/current-system/sw/bin',
      disk: '128GiB',
      pool: 'scratch',
      isoVolume: 'whombat-dev-box-installer',
    });
    expect(cmds[0]).toEqual(['stop', 'ar-1234-abcd', '--force']);
    expect(cmds).toContainEqual(['config', 'set', 'ar-1234-abcd', 'security.secureboot=false']);
    expect(cmds).toContainEqual(['config', 'device', 'override', 'ar-1234-abcd', 'root', 'size=128GiB']);
    expect(cmds.at(-1)).toEqual(
      expect.arrayContaining(['add', 'installer', 'pool=scratch', 'source=whombat-dev-box-installer']),
    );
    // Nothing that makes or deletes an instance: the lease does both.
    expect(cmds.flat()).not.toContain('init');
    expect(cmds.flat()).not.toContain('delete');
  });
});
