import { describe, expect, it } from 'vitest';
import {
  aiLine,
  assistantLine,
  demoApplianceLine,
  managedApplianceLine,
  type SettingsFacts,
  settingsRows,
  settingsTabDot,
} from './list';

const base: SettingsFacts = { mode: 'managed' };
const dusty = { name: 'Dusty', provider: 'claude' as const };
const claude = { name: 'Claude Code', tone: 'ok' as const, status: 'Signed in', trouble: false };
const chatgpt = { name: 'ChatGPT', tone: 'mut' as const, status: 'Not signed in', trouble: false };

describe('the Settings list in five groups', () => {
  it('has the assistant, Connections, This Whombat and Advanced under the theme', () => {
    expect(settingsRows(base).map((r) => r.key)).toEqual(['agent', 'connections', 'appliance', 'advanced']);
    expect(settingsRows({ ...base, mode: 'fixtures' }).map((r) => r.key)).toEqual([
      'agent',
      'connections',
      'appliance',
      'advanced',
    ]);
    // Connections says what needs you there (sidebar-tabs.md).
    expect(
      settingsRows({ ...base, connections: { value: 'Hetzner Cloud needs you', tone: 'warn' } }).find(
        (r) => r.key === 'connections',
      ),
    ).toMatchObject({ title: 'Connections', tone: 'warn', label: 'Connections, Hetzner Cloud needs you' });
  });

  it('calls the assistant by its name, and says what it runs on', () => {
    const row = settingsRows({ ...base, agent: dusty }).find((r) => r.key === 'agent');
    expect(row).toMatchObject({
      title: 'Dusty',
      value: 'Claude Code',
      tone: null,
      label: 'Dusty, Claude Code',
    });
    // Until the bootstrap has it, no name is made up.
    expect(settingsRows(base).find((r) => r.key === 'agent')).toMatchObject({
      title: 'Your agent',
      value: null,
    });
  });

  it('puts an AI sign-in in trouble on the assistant’s row', () => {
    const row = settingsRows({
      ...base,
      agent: dusty,
      ai: [claude, { ...chatgpt, tone: 'bad', status: 'Sign-in expired', trouble: true }],
    }).find((r) => r.key === 'agent');
    expect(row).toMatchObject({ tone: 'bad', value: expect.stringContaining('ChatGPT') });
    // Someone signed in is no news: the row says what it runs on.
    expect(assistantLine({ agent: dusty, ai: [claude, chatgpt] })).toEqual({
      value: 'Claude Code',
      tone: null,
    });
    expect(assistantLine({ agent: dusty, ai: [chatgpt] })).toMatchObject({ tone: 'warn' });
  });

  it('has the box’s screen beside This Whombat only where it has one (AP-5860), Screens with widgets (AP-6000)', () => {
    const rows = settingsRows({ ...base, screen: { value: 'Built-in screen', tone: null } });
    expect(rows.map((r) => r.key)).toEqual(['agent', 'connections', 'appliance', 'screen', 'advanced']);
    expect(rows.find((r) => r.key === 'screen')?.label).toContain('Built-in screen');
    const screens = settingsRows({ ...base, screen: { value: '3 screens', tone: null }, screens: true });
    expect(screens.find((r) => r.key === 'screen')).toMatchObject({
      title: 'Screens',
      label: 'Screens, 3 screens',
    });
  });

  it('says what Advanced holds, and This Whombat how it is', () => {
    const rows = settingsRows({ ...base, appliance: { value: 'Backups are off', tone: 'warn' } });
    expect(rows.find((r) => r.key === 'advanced')?.value).toMatch(/Model.*keys.*skills.*usage/);
    expect(rows.find((r) => r.key === 'appliance')).toMatchObject({ title: 'This Whombat', tone: 'warn' });
  });
});

describe('each row’s line (AP-2623)', () => {
  it('ai: a sign-in in trouble, none signed in, else who is', () => {
    expect(aiLine([claude, chatgpt])).toEqual({ value: 'Claude Code signed in', tone: null });
    expect(aiLine([chatgpt])).toMatchObject({ tone: 'warn' });
    expect(
      aiLine([claude, { ...chatgpt, tone: 'warn', trouble: true, status: 'Sign-in expired' }]),
    ).toMatchObject({
      tone: 'warn',
      value: expect.stringContaining('ChatGPT'),
    });
    expect(aiLine([])).toBeNull();
  });

  it('this Whombat: what needs the viewer, else update and backups', () => {
    expect(
      managedApplianceLine({
        needsYou: [],
        glance: [
          { key: 'update', dot: 'ok', title: 'About', state: 'Up to date' },
          { key: 'backups', dot: 'ok', title: 'Backed up' },
        ],
      }),
    ).toEqual({ value: 'Up to date · Backed up', tone: null });
    // A failed update says so, not the name of the page it opens.
    expect(
      managedApplianceLine({
        needsYou: [],
        glance: [{ key: 'update', dot: 'bad', title: 'About', state: 'The last update didn’t work' }],
      }),
    ).toEqual({ value: 'The last update didn’t work', tone: 'bad' });
    expect(
      managedApplianceLine({ needsYou: [{ dot: 'warn', title: 'Backups are off' }], glance: [] }),
    ).toEqual({ value: 'Backups are off', tone: 'warn' });
    expect(demoApplianceLine('managed')).toBeNull();
    expect(demoApplianceLine('fixtures')?.value).toBeTruthy();
  });

  it('says “Update ready” once while an update waits for the owner, and opens About', () => {
    const waiting = {
      needsYou: [],
      glance: [
        { key: 'update', dot: 'warn' as const, title: 'About', state: 'Update ready' },
        { key: 'backups', dot: 'ok' as const, title: 'Backed up' },
      ],
    };
    const line = managedApplianceLine(waiting, '0.312.0');
    expect(line).toEqual({ value: 'Update ready', tone: 'warn', opens: 'about' });
    const row = settingsRows({ ...base, appliance: line }).find((r) => r.key === 'appliance');
    expect(row).toMatchObject({ value: 'Update ready', tone: 'warn', opens: 'about' });
    expect(row?.label).toBe('This Whombat, Update ready');
    // Before anything that merely waits, after anything broken.
    expect(
      managedApplianceLine({ ...waiting, needsYou: [{ dot: 'warn', title: 'Backups are off' }] }, '0.312.0'),
    ).toMatchObject({ value: 'Update ready', opens: 'about' });
    expect(
      managedApplianceLine(
        { ...waiting, needsYou: [{ dot: 'bad', title: 'The last backup failed' }] },
        '0.312.0',
      ),
    ).toEqual({ value: 'The last backup failed', tone: 'bad' });
    // Without a release waiting for the owner the line and the row are as before.
    expect(managedApplianceLine(waiting)).toEqual({ value: 'Update ready', tone: 'warn' });
    expect(settingsRows({ ...base, appliance: managedApplianceLine(waiting) })[2]).not.toHaveProperty(
      'opens',
    );
  });
});

describe('the Settings tab’s dot (AP-2624)', () => {
  it('shows what needs the viewer before a newer app', () => {
    expect(settingsTabDot({ agent: null, appliance: null, update: false })).toBeNull();
    expect(settingsTabDot({ agent: null, appliance: null, update: true })).toBe('ok');
    expect(settingsTabDot({ agent: { value: 'x', tone: 'warn' }, appliance: null, update: true })).toBe(
      'warn',
    );
    expect(
      settingsTabDot({
        agent: { value: 'x', tone: 'warn' },
        appliance: { value: 'y', tone: 'bad' },
        update: false,
      }),
    ).toBe('bad');
  });

  it('takes the AI sign-in’s trouble from the assistant’s line', () => {
    const agent = assistantLine({
      agent: dusty,
      ai: [{ ...claude, tone: 'bad', trouble: true, status: 'Signed out' }],
    });
    expect(settingsTabDot({ agent, appliance: null, update: false })).toBe('bad');
  });
});
