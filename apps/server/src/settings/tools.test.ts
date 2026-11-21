import { createOperationAllowlist } from '@whombat/protocol/session';
import { describe, expect, it } from 'vitest';
import { type ServedSelection, servesTool } from '../mcp/served';
import { alwaysAsks, changeTier, previewLines } from './command';
import { clipValue, inputSchemaOf, openLabel, VALUE_MAX, withBurrow } from './tools';

const allowlist = createOperationAllowlist();
const spec = (op: string) => {
  const s = allowlist.get(op);
  if (!s) throw new Error(op);
  return s;
};

describe('a settings change’s tier', () => {
  it('follows the key, asks at most for what always asks, and nothing without the key', () => {
    expect(changeTier('can', 'me.updateProfile')).toBe('can');
    expect(changeTier('ask', 'me.updateProfile')).toBe('ask');
    expect(changeTier('can', 'host.cable.set')).toBe('ask');
    expect(changeTier('can', 'widgets.remove')).toBe('ask');
    expect(changeTier(null, 'me.updateProfile')).toBe('cannot');
    expect(changeTier('cannot', 'host.cable.set')).toBe('cannot');
    expect(alwaysAsks('backups.remove')).toBe(true);
    expect(alwaysAsks('me.updateProfile')).toBe(false);
  });

  it('asks at most when the input sets a part that always asks', () => {
    const off = { params: { checkId: 'chk_1' }, body: { enabled: false } };
    expect(changeTier('can', 'hosts.updateCheck', off)).toBe('ask');
    expect(
      changeTier('can', 'hosts.updateCheck', { params: { checkId: 'chk_1' }, body: { name: 'Site' } }),
    ).toBe('can');
    expect(alwaysAsks('hosts.updateCheck', off)).toBe(true);
  });
});

describe('the card’s lines', () => {
  it('show what it sets without the Whombat’s slug, values cut short', () => {
    const lines = previewLines({
      params: { burrow: 'garden', id: 'scr_1' },
      body: { title: 'x'.repeat(100), on: true },
    });
    expect(lines[0]).toBe('id: scr_1');
    expect(lines[1]?.length).toBeLessThanOrEqual(70);
    expect(lines).toContain('on: true');
    expect(lines.join(' ')).not.toContain('garden');
    expect(previewLines({ use: 'wifi' })).toEqual(['use: wifi']);
  });
});

describe('an op’s input', () => {
  it('gets the Whombat’s slug where its endpoint takes one, and nowhere else', () => {
    expect(withBurrow(spec('burrows.get'), {}, 'garden')).toEqual({ params: { burrow: 'garden' } });
    expect(withBurrow(spec('host.cable.set'), { use: 'wifi' }, 'garden')).toEqual({ use: 'wifi' });
  });

  it('is described without the slug', () => {
    const schema = inputSchemaOf(spec('burrows.get'));
    expect(JSON.stringify(schema)).not.toContain('"burrow"');
    expect(JSON.stringify(inputSchemaOf(spec('host.cable.set')))).toContain('wifi');
  });

  it('comes back cut short when long', () => {
    expect(clipValue({ a: 1 })).toEqual({ value: { a: 1 }, truncated: false });
    const long = clipValue({ a: 'x'.repeat(VALUE_MAX) });
    expect(long.truncated).toBe(true);
  });
});

describe('the page card', () => {
  it('opens the page by its last part', () => {
    expect(openLabel('Settings → This Whombat → Backups')).toBe('Open Backups');
    expect(openLabel('Vault')).toBe('Open Vault');
  });
});

describe('who is served the settings tools', () => {
  const sel = (over: Partial<ServedSelection> = {}): ServedSelection => ({
    turn: {
      personal: true,
      teamWork: false,
      answer: false,
      run: false,
      outside: false,
    } as ServedSelection['turn'],
    usable: [],
    browser: 'none',
    connections: false,
    ...over,
  });
  it('the person’s own turns, never an automation’s step', () => {
    expect(servesTool('settings_change', sel())).toBe(true);
    expect(servesTool('settings_change', sel({ automationStep: true }))).toBe(false);
    expect(servesTool('settings_find', sel({ automationStep: true }))).toBe(false);
    expect(
      servesTool(
        'settings_read',
        sel({ turn: { ...sel().turn, personal: false } as ServedSelection['turn'] }),
      ),
    ).toBe(false);
  });
});
