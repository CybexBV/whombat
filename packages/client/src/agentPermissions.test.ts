import { describe, expect, it } from 'vitest';
import { connectionPermission, keysSummary, PERMISSION_WORDS, serverPermission } from './agentPermissions';

describe('What the assistant may do, in three words', () => {
  it('has one vocabulary', () => {
    expect(Object.values(PERMISSION_WORDS)).toEqual(['Just watch', 'Ask me first', 'Go ahead']);
  });

  it('reads a server from its switches and its choice', () => {
    const on = { console: true, power: true, manage: true, hostShell: true };
    expect(
      serverPermission({ id: 's1', name: 'pve-01', remoteControl: on, asksFirst: 'risky' }, 'Neo').word,
    ).toBe('ask');
    expect(
      serverPermission({ id: 's1', name: 'pve-01', remoteControl: on, asksFirst: 'never' }, 'Neo').word,
    ).toBe('go');
    // No choice made is the default: Whombat goes ahead (SA-10).
    expect(serverPermission({ id: 's1', name: 'pve-01', remoteControl: on }, 'Neo').word).toBe('go');
    const watched = { console: false, power: false, manage: false, hostShell: false };
    expect(serverPermission({ id: 's2', name: 'nas', remoteControl: watched }, 'Neo').word).toBe('watch');
  });

  it('says the server this Whombat runs on always asks before restarting', () => {
    const row = serverPermission(
      { id: 's1', name: 'thetitan', asksFirst: 'never', hostsThisWhombat: true },
      'Neo',
    );
    expect(row.line).toContain('always asks');
    expect(row.line).toContain('thetitan');
  });

  it('reads a connection from Look only or Manage', () => {
    expect(connectionPermission({ id: 'c1', name: 'UniFi', access: 'read' }, 'Neo').word).toBe('watch');
    expect(connectionPermission({ id: 'c2', name: 'Home Assistant' }, 'Neo').word).toBe('go');
  });

  it('sums the keys up by word, asking first', () => {
    expect(
      keysSummary([
        { label: 'Deploy', tier: 'ask' },
        { label: 'Push to main', tier: 'cannot' },
        { label: 'Merge into main', tier: 'ask' },
      ]),
    ).toEqual([
      { word: 'ask', labels: ['Deploy', 'Merge into main'] },
      { word: 'watch', labels: ['Push to main'] },
    ]);
  });

  it('leaves the code keys out where nothing developer is connected', () => {
    const rows = [
      { label: 'Deploy', tier: 'ask' as const, row: 'deploy' },
      { label: 'Money', tier: 'ask' as const, row: 'refunds.issue' },
    ];
    expect(keysSummary(rows, { developer: false })).toEqual([{ word: 'ask', labels: ['Money'] }]);
    expect(keysSummary(rows)).toEqual([{ word: 'ask', labels: ['Deploy', 'Money'] }]);
  });
});
