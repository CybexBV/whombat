/** Renaming a server or a connection where it is listed: the row's menu, its picks and the name a row shows. */
import { thingRenameTarget } from '@whombat/client';
import { describe, expect, it } from 'vitest';
import { isOwnId, parseThingRowPick, savedName, serverHeadMenu, shownName, thingRowMenu } from './rename';

const server = thingRenameTarget({ id: 'server:the-titan', name: 'the-titan' });
const connection = thingRenameTarget({ id: 'connection:con_ha', name: 'Home Assistant' });

describe('a held row’s menu', () => {
  it('offers Open then Rename under the name, and reads its picks back', () => {
    const spec = thingRowMenu('the-titan');
    expect(spec.title).toBe('the-titan');
    expect(spec.sections.flat().map((i) => i.id)).toEqual(['open', 'rename']);
    for (const item of spec.sections.flat()) expect(parseThingRowPick(item.id)).toBe(item.id);
    expect(parseThingRowPick('delete')).toBeNull();
  });

  it('puts Rename in a server page’s ⋯', () => {
    expect(
      serverHeadMenu()
        .sections.flat()
        .map((i) => i.id),
    ).toEqual(['rename']);
  });

  it('is only for servers and connections Whombat keeps', () => {
    expect(server?.kind).toBe('server');
    expect(connection?.kind).toBe('connection');
    expect(thingRenameTarget({ id: 'device:dev_heat', name: 'Heat pump' })).toBeNull();
  });
});

describe('the name a row shows', () => {
  it('is what was typed, tidied, or a server’s id for an empty box', () => {
    if (!server || !connection) throw new Error('no target');
    expect(savedName(server, '  The   Titan ')).toBe('The Titan');
    expect(savedName(server, '')).toBe('the-titan');
    expect(savedName(server, 'the-titan')).toBeNull();
    // A connection always has a name: an empty box changes nothing.
    expect(savedName(connection, '  ')).toBeNull();
    expect(savedName(connection, 'House')).toBe('House');
  });

  it('keeps the saved name until the list says something else', () => {
    const saved = new Map([['server:the-titan', { name: 'The Titan', was: 'the-titan' }]]);
    expect(shownName(saved, 'server:the-titan', 'the-titan')).toBe('The Titan');
    expect(shownName(saved, 'server:the-titan', 'The Titan')).toBe('The Titan');
    expect(shownName(saved, 'server:the-titan', 'Tiny Titan')).toBe('Tiny Titan');
    expect(shownName(saved, 'server:pve-01', 'pve-01')).toBe('pve-01');
  });

  it('sets a name that is only its id written otherwise as an id', () => {
    expect(isOwnId('BlackBox', 'blackbox')).toBe(true);
    expect(isOwnId('The Titan', 'the-titan')).toBe(false);
  });
});
