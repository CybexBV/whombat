/**
 * Names without addresses and a write's title (docs/decisions/home-redesign.md HR-02, HR-07).
 */
import { catalogEntry } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { changeTitle, genericChangeTitle, prepareConnectionChange } from './changes';
import { automaticLabel, nameWithoutAddress } from './labels';

const ha = catalogEntry('homeassistant');
const api = catalogEntry('custom_api');
const fields = { url: 'http://10.100.0.5:8123' };

describe('a new connection’s name', () => {
  it('is the service’s name, with the address only beside another of the same service', () => {
    if (!ha) throw new Error('no entry');
    expect(automaticLabel(ha, fields, false)).toBe('Home Assistant');
    expect(automaticLabel(ha, fields, true)).toBe('Home Assistant · 10.100.0.5:8123');
  });

  it('a custom API keeps its address', () => {
    if (!api) throw new Error('no entry');
    expect(automaticLabel(api, { url: 'https://erp.lan' }, false)).toContain('erp.lan');
  });
});

describe('names in a change’s words', () => {
  it('drop the address Whombat added, and keep a name a person gave', () => {
    expect(nameWithoutAddress('Home Assistant · 10.100.0.5:8123', ha ?? null, fields)).toBe('Home Assistant');
    expect(nameWithoutAddress('Kitchen', ha ?? null, fields)).toBe('Kitchen');
    expect(nameWithoutAddress('Home Assistant · ha.lan', ha ?? null, fields)).toBe('Home Assistant · ha.lan');
  });

  it('the generic title names the connection', () => {
    expect(genericChangeTitle('request', 'Home Assistant')).toBe('Changed something in Home Assistant');
  });
});

describe('a write’s title', () => {
  const undo = { connectionId: 'con_1', tool: 'request', args: {} };
  const generic = 'Changed something in Home Assistant';

  it('Whombat’s own words with an Undo come first', () => {
    expect(
      changeTitle({ title: 'Turned off Hallway light', undo }, 'Switched the light off', generic),
    ).toEqual({
      title: 'Turned off Hallway light',
      undo,
    });
  });

  it('then the agent’s words, then Whombat’s words without an Undo, then the generic title', () => {
    expect(
      changeTitle({ title: 'Switched Kitchen', undo: null }, ' Removed 14 old\nZonneplan entities ', generic),
    ).toEqual({ title: 'Removed 14 old Zonneplan entities', undo: null });
    expect(changeTitle({ title: 'Switched Kitchen', undo: null }, null, generic).title).toBe(
      'Switched Kitchen',
    );
    expect(changeTitle(null, '', generic).title).toBe(generic);
  });
});

describe('Todoist’s own words (SG-20)', () => {
  const todoist = catalogEntry('todoist');
  const row = { id: 'con_1', label: 'Todoist', fields: {} } as never;
  const tool = (origin: string) => ({ name: 'tasks_update', access: 'write', origin, tier: 'on' }) as never;
  const prepare = async (origin: string) => {
    let read = 0;
    const change = await prepareConnectionChange(
      {} as never,
      row,
      todoist as never,
      tool(origin),
      { id: 't1', content: 'Buy milk' },
      async () => {
        read++;
        return { content: '{"tasks":[]}', isError: false } as never;
      },
    );
    return { change, read };
  };

  it('describe its typed tools, never a same-named tool of its MCP server', async () => {
    const typed = await prepare('adapter');
    expect(typed.change?.title).toContain('Buy milk');
    expect(typed.read).toBe(1);
    const mcp = await prepare('mcp');
    expect(mcp.read).toBe(0);
    expect(mcp.change?.title).not.toContain('Buy milk');
  });
});
