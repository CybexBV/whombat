import { runnerTmpRoot } from '@whombat/agent-runtime/host';
import { describe, expect, it } from 'vitest';
import { hostPathIssues, hostPaths } from './host-paths';

describe('host paths', () => {
  it('defaults: WHOMBAT_HOME is ~/.whombat, the workspaces in it', () => {
    expect(hostPaths({}, '/home/mara')).toEqual({
      home: '/home/mara',
      whombatHome: '/home/mara/.whombat',
      workspaces: '/home/mara/.whombat/workspaces',
      runnerTmp: runnerTmpRoot(),
    });
    expect(hostPaths({ WHOMBAT_WORKSPACES: '/persist/whombat/workspaces' }, '/home/mara').workspaces).toBe(
      '/persist/whombat/workspaces',
    );
  });

  it('reports a relative WHOMBAT_HOME as a configuration problem', () => {
    expect(hostPathIssues({ WHOMBAT_HOME: 'whombat' })).toEqual([
      { path: ['WHOMBAT_HOME'], message: 'Use a full path, starting with / or ~/.' },
    ]);
    expect(hostPathIssues({ WHOMBAT_HOME: '~/.whombat' })).toEqual([]);
  });
});
