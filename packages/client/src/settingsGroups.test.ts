import { describe, expect, it } from 'vitest';
import {
  advancedRows,
  advancedRowsHere,
  agentPartPlace,
  isMovedAdvancedPart,
  MOVED_ADVANCED_PARTS,
  SETTINGS_GROUP_TEXT,
  SETTINGS_GROUPS,
  settingsPlaceTitle,
  whombatSectionPlace,
  youParts,
} from './settingsGroups';

describe('Settings in six groups', () => {
  it('names the groups, the assistant by its name', () => {
    const names = SETTINGS_GROUP_TEXT.groups('neo');
    expect(SETTINGS_GROUPS.map((g) => names[g])).toEqual([
      'You',
      'Neo',
      'Connections',
      'This Whombat',
      'News and weather',
      'Advanced',
    ]);
    expect(SETTINGS_GROUP_TEXT.agent('neo').may).toBe('What Neo may do');
  });

  it('shows Devices and Shared links only on a box', () => {
    expect(youParts({ managed: true })).toEqual(['profile', 'notifications', 'devices', 'links', 'prompts']);
    expect(youParts({ managed: false })).toEqual(['profile', 'notifications', 'prompts']);
  });

  it('keeps every expert page in Advanced, in its fold', () => {
    const rows = advancedRows('Dusty');
    expect(rows.map((r) => r.key)).toEqual([
      'model',
      'ai',
      'spend',
      'running',
      'skills',
      'audit',
      'diagnostics',
    ]);
    expect(rows.find((r) => r.key === 'skills')?.section).toBe('work');
    expect(new Set(rows.map((r) => r.section))).toEqual(new Set(['ai', 'work', 'whombat']));
    // The Spend report is called Usage; what moved out (Connections, GitHub, the keys, schedules…) has no row here.
    expect(rows.find((r) => r.key === 'spend')?.title).toBe('Usage');
    for (const moved of MOVED_ADVANCED_PARTS)
      expect(rows.find((r) => (r.key as string) === moved)).toBeUndefined();
    expect(isMovedAdvancedPart('keys')).toBe(true);
    expect(isMovedAdvancedPart('model')).toBe(false);
    expect(rows.find((r) => r.key === 'model')?.line).toContain('Dusty');
  });

  it('leaves out what a Whombat doesn’t have', () => {
    const keys = advancedRowsHere('Dusty', { managed: false, services: false, spend: false }).map(
      (r) => r.key,
    );
    expect(keys).not.toContain('running');
    expect(keys).not.toContain('spend');
    expect(keys).not.toContain('diagnostics');
    expect(advancedRowsHere('Dusty', { managed: true }).map((r) => r.key)).toContain('diagnostics');
  });

  it('sends the old Agent parts and This Whombat parts to their new places', () => {
    expect(agentPartPlace('notes')).toEqual({ group: 'agent', part: 'memory' });
    expect(agentPartPlace('keys')).toEqual({ group: 'agent', part: 'may' });
    expect(agentPartPlace('schedules')).toEqual({ group: 'advanced', part: 'schedules' });
    expect(agentPartPlace('services')).toEqual({ group: 'advanced', part: 'running' });
    expect(agentPartPlace('spend')).toEqual({ group: 'advanced', part: 'spend' });
    expect(agentPartPlace(undefined)).toEqual({ group: 'agent' });
    expect(whombatSectionPlace('devices')).toEqual({ group: 'you', part: 'devices' });
    expect(whombatSectionPlace('access')).toEqual({ group: 'agent', part: 'may' });
    expect(whombatSectionPlace('backups')).toBeNull();
  });

  it('titles a place for a back link', () => {
    expect(settingsPlaceTitle({ group: 'advanced', part: 'spend' }, 'Dusty')).toBe('Advanced · Usage');
    expect(settingsPlaceTitle({ group: 'agent' }, 'dusty')).toBe('Dusty');
  });
});
