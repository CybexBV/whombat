import { describe, expect, it } from 'vitest';
import { advancedRoute, advancedRowsOnPhone, agentPartTarget, youLine, youPartsHere } from './groups';

const managed = { mode: 'managed' as const };
const demo = { mode: 'fixtures' as const };

describe('You on the phone', () => {
  it('holds your profile, and notifications and devices on a Whombat', () => {
    expect(youPartsHere(managed)).toEqual(['profile', 'notifications', 'devices', 'links', 'prompts']);
    // The demo world has no account to keep Do not disturb or devices.
    expect(youPartsHere(demo)).toEqual(['profile', 'prompts']);
  });

  it('leaves Prompts out where the Whombat doesn’t keep them', () => {
    expect(youPartsHere({ ...managed, prompts: false })).not.toContain('prompts');
    expect(youPartsHere({ ...demo, prompts: false })).toEqual(['profile']);
  });

  it('says what it holds under your name', () => {
    expect(youLine(youPartsHere(managed))).toBe(
      'Your photo, notifications, devices, shared links and prompts',
    );
    expect(youLine(youPartsHere({ ...demo, prompts: false }))).toBe('Your photo');
  });
});

describe('Advanced on the phone', () => {
  const keys = (rows: { key: string }[]) => rows.map((r) => r.key);

  it('lists the shared rows the phone has a screen for, in their order', () => {
    expect(keys(advancedRowsOnPhone('Dusty', managed))).toEqual([
      'model',
      'ai',
      'spend',
      'running',
      'skills',
      'audit',
      'diagnostics',
    ]);
    // Connections is a group on the Settings home; an old Advanced link still opens it.
    expect(advancedRoute('accounts', managed)).toEqual({ name: 'Connections' });
    // The diagnostics file is a Whombat's.
    expect(keys(advancedRowsOnPhone('Dusty', demo))).not.toContain('diagnostics');
  });

  it('leaves Running out where the host can’t run anything, and Spend where it is refused', () => {
    const rows = keys(advancedRowsOnPhone('Dusty', { ...managed, services: false, spend: false }));
    expect(rows).not.toContain('running');
    expect(rows).not.toContain('spend');
  });

  it('names the assistant in the rows and folds', () => {
    const rows = advancedRowsOnPhone('Rex', managed);
    expect(rows.find((r) => r.key === 'model')).toMatchObject({ section: 'ai', title: 'Model and effort' });
    expect(rows.find((r) => r.key === 'model')?.line).toContain('Rex');
    expect(rows.find((r) => r.key === 'running')?.label).toContain('Rex');
  });

  it('opens its own pages, or the screens the phone had', () => {
    expect(advancedRoute('keys', managed, 'deploy')).toEqual({
      name: 'SettingsAdvancedPart',
      params: { part: 'keys', key: 'deploy' },
    });
    expect(advancedRoute('model', managed, 'deploy')).toEqual({
      name: 'SettingsAdvancedPart',
      params: { part: 'model' },
    });
    expect(advancedRoute('spend', managed)).toEqual({ name: 'Spend' });
    expect(advancedRoute('skills', managed)?.name).toBe('Skills');
    expect(advancedRoute('github', managed)).toEqual({ name: 'ConnectAccount', params: { page: 'github' } });
    expect(advancedRoute('audit', managed)?.name).toBe('AuditLog');
    expect(advancedRoute('diagnostics', managed)?.name).toBe('WhombatAbout');
    // What moved out of Advanced: the home network ranges are the Vault's list, the schedules the Automations tab's.
    expect(advancedRoute('network', managed)).toEqual({ name: 'Vault' });
    expect(advancedRoute('schedules', managed)).toEqual({ name: 'Tabs', params: { screen: 'Automations' } });
  });
});

describe('the assistant’s page keeps its old links', () => {
  it('opens its own parts, and Name and face for anything else', () => {
    expect(agentPartTarget('may', managed)).toEqual({ kind: 'part', part: 'may' });
    expect(agentPartTarget('ai', managed)).toEqual({ kind: 'part', part: 'ai' });
    expect(agentPartTarget(undefined, managed)).toEqual({ kind: 'part', part: 'profile' });
    expect(agentPartTarget('Keys <b>', managed)).toEqual({ kind: 'part', part: 'profile' });
  });

  it('sends the old parts where they went', () => {
    // Notes is in Memory now.
    expect(agentPartTarget('notes', managed)).toEqual({ kind: 'part', part: 'memory' });
    expect(agentPartTarget('keys', managed, 'merge.main')).toEqual({
      kind: 'elsewhere',
      route: { name: 'SettingsAdvancedPart', params: { part: 'keys', key: 'merge.main' } },
    });
    expect(agentPartTarget('services', managed)).toMatchObject({
      route: { name: 'SettingsAdvancedPart', params: { part: 'running' } },
    });
    expect(agentPartTarget('schedules', managed)).toEqual({
      kind: 'elsewhere',
      route: { name: 'Tabs', params: { screen: 'Automations' } },
    });
    expect(agentPartTarget('spend', managed)).toEqual({ kind: 'elsewhere', route: { name: 'Spend' } });
    expect(agentPartTarget('skills', managed)).toEqual({ kind: 'elsewhere', route: { name: 'Skills' } });
  });
});
