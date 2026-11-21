import { describe, expect, it } from 'vitest';
import { renameValue, thingRenameTarget } from './rename';

describe('thingRenameTarget', () => {
  it('renames servers and the connections Whombat keeps', () => {
    expect(thingRenameTarget({ id: 'server:the-titan', name: 'the-titan' })).toMatchObject({
      kind: 'server',
      id: 'the-titan',
      name: 'the-titan',
      max: 60,
    });
    expect(thingRenameTarget({ id: 'connection:con_abc', name: 'Plex' })).toMatchObject({
      kind: 'connection',
      id: 'con_abc',
      max: 80,
    });
  });

  it('leaves GitHub, accounts and devices alone', () => {
    expect(thingRenameTarget({ id: 'connection:github', name: 'GitHub' })).toBeNull();
    expect(thingRenameTarget({ id: 'device:con_heat-pump', name: 'Heat pump' })).toBeNull();
    expect(thingRenameTarget({ id: 'nonsense', name: 'x' })).toBeNull();
  });
});

describe('renameValue', () => {
  const server = { kind: 'server' as const, id: 'the-titan', name: 'the-titan', max: 60 };
  const connection = { kind: 'connection' as const, id: 'con_abc', name: 'Plex', max: 80 };

  it('sends the typed name, one line, trimmed and cut to the limit', () => {
    expect(renameValue(server, '  The   Titan ')).toEqual({ name: 'The Titan' });
    expect(renameValue(server, 'x'.repeat(70))?.name).toHaveLength(60);
  });

  it('sends nothing when nothing changed', () => {
    expect(renameValue(server, 'the-titan ')).toBeNull();
    expect(renameValue(connection, 'Plex')).toBeNull();
  });

  it('puts a server’s id back on an empty box, and keeps a connection’s name', () => {
    expect(renameValue({ ...server, name: 'The Titan' }, '  ')).toEqual({ name: null });
    expect(renameValue(connection, '')).toBeNull();
  });
});
