/**
 * Find My as a connection without Postgres (docs/decisions/findmy-connection.md): which servers are Macs, the `mac`
 * check against a stand-in hosts service, and how often a connection reads in the background. Made-up names only.
 */
import { describe, expect, it } from 'vitest';
import { HostsUnavailable } from './client';
import { FIND_MY_CONNECTION_TEXT, findMyPace, macCheckOf, macsOf, runMacCheck } from './findmy-connection';

const card = (id: string, mac = true) => ({
  id,
  hostname: id,
  ...(mac ? { os_family: 'macos', detail_view: 'macos' } : { os_family: 'linux', detail_view: 'standard' }),
});
const fleet = (...servers: ReturnType<typeof card>[]) => ({ servers });

describe('the Macs among the servers', () => {
  it('are the servers that run macOS, in the fleet’s order', () => {
    expect(macsOf(fleet(card('studio'), card('nas-01', false), card('mini')))).toEqual([
      { id: 'studio', name: 'studio' },
      { id: 'mini', name: 'mini' },
    ]);
    expect(macsOf({})).toEqual([]);
  });
});

describe('the mac check', () => {
  it('picks the only Mac, and leaves a choice of several to the person', () => {
    expect(macCheckOf(fleet(card('studio')), undefined, '1.1.0')).toMatchObject({
      mac: 'studio',
      problem: null,
    });
    const two = macCheckOf(fleet(card('studio'), card('mini')), undefined, null);
    expect(two).toMatchObject({ mac: null, problem: null });
    expect(two.macs.map((m) => m.id)).toEqual(['studio', 'mini']);
  });

  it('fails without a Mac, for a Mac that’s gone, a server that isn’t a Mac and an old helper', () => {
    expect(macCheckOf(fleet(card('nas-01', false)), undefined, null)).toMatchObject({
      code: 'no_mac',
      problem: FIND_MY_CONNECTION_TEXT.noMac,
    });
    const gone = macCheckOf(fleet(card('mini')), 'studio', null);
    expect(gone.code).toBe('gone');
    expect(gone.problem).toContain('studio');
    expect(macCheckOf(fleet(card('nas-01', false)), 'nas-01', null).code).toBe('not_mac');
    const old = macCheckOf(fleet(card('studio')), 'studio', '1.0.6');
    expect(old.code).toBe('helper_old');
    expect(old.problem).toContain('studio');
    // A helper that doesn't say isn't judged here: the read says why.
    expect(macCheckOf(fleet(card('studio')), 'Studio', null)).toMatchObject({ mac: 'studio', problem: null });
  });

  it('asks the hosts service for the fleet, then the Mac’s detail for its helper', async () => {
    const paths: string[] = [];
    const hosts = {
      present: true,
      fleetRaw: async () => fleet(card('studio')),
      call: async <T>(req: { path: string }) => {
        paths.push(req.path);
        return { macos: { helper: { version: '1.0.0' } } } as T;
      },
    };
    const found = await runMacCheck(hosts, 'studio');
    expect(found).toMatchObject({ code: 'helper_old', unanswered: false });
    expect(paths).toEqual(['/api/v1/servers/studio']);
  });

  it('says when the servers aren’t watched or don’t answer, and never asks for a detail then', async () => {
    const call = async () => {
      throw new Error('no detail');
    };
    expect(await runMacCheck({ present: false, fleetRaw: async () => ({}), call }, 'studio')).toMatchObject({
      unanswered: false,
    });
    const down = await runMacCheck(
      {
        present: true,
        fleetRaw: async () => {
          throw new HostsUnavailable('not_running', 'down');
        },
        call,
      },
      'studio',
    );
    expect(down.unanswered).toBe(true);
    expect(down.problem).toBeTruthy();
    // A detail that can't be read leaves the helper unjudged.
    expect(
      await runMacCheck({ present: true, fleetRaw: async () => fleet(card('studio')), call }, 'studio'),
    ).toMatchObject({ problem: null, mac: 'studio' });
  });
});

describe('how often a connection reads in the background', () => {
  it('follows its own setting, Off by default', () => {
    expect(findMyPace('off', null, 15)).toBeNull();
    expect(findMyPace(undefined, null, 15)).toBeNull();
    expect(findMyPace('30', null, 15)).toEqual({ everyMinutes: 30, automation: null });
  });

  it('reads at least every 15 minutes while an automation listens, named when that is why', () => {
    expect(findMyPace('off', 'Tell me when Mara gets home', 15)).toEqual({
      everyMinutes: 15,
      automation: 'Tell me when Mara gets home',
    });
    expect(findMyPace('60', 'Tell me when Mara gets home', 15)?.everyMinutes).toBe(15);
    // Its own setting is sooner: the setting is why.
    expect(findMyPace('5', 'Tell me when Mara gets home', 15)).toEqual({ everyMinutes: 5, automation: null });
  });

  it('reads at least every 15 minutes while it keeps a timeline, which is said when that is why', () => {
    expect(findMyPace('off', null, 15, true)).toEqual({ everyMinutes: 15, automation: null, timeline: true });
    expect(findMyPace('60', null, 15, true)).toEqual({ everyMinutes: 15, automation: null, timeline: true });
    expect(findMyPace('off', 'Tell me when Mara gets home', 15, true)).toMatchObject({
      automation: 'Tell me when Mara gets home',
      timeline: true,
    });
    // John's 5 minutes stays.
    expect(findMyPace('5', null, 15, true)).toEqual({ everyMinutes: 5, automation: null });
  });
});
