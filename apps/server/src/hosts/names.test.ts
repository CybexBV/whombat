import { afterEach, describe, expect, it } from 'vitest';
import { NAME_TAKEN_TEXT, nameClash, renamedText } from './names';
import { givenServerName, knownServer, noteSelfServers, noteServerNames, serverLabel } from './self';

const fleet = {
  servers: [
    { id: 'the-titan', hostname: 'the-titan' },
    { id: 'blackbox', hostname: 'BlackBox' },
    { id: 'pve-02' },
  ],
};

describe('nameClash', () => {
  const names = new Map([['pve-02', 'Attic']]);

  it('refuses another server’s id, host name or name, ignoring case', () => {
    expect(nameClash(fleet, names, 'the-titan', 'PVE-02')).toBe(NAME_TAKEN_TEXT);
    expect(nameClash(fleet, names, 'the-titan', 'blackbox')).toBe(NAME_TAKEN_TEXT);
    expect(nameClash(fleet, names, 'the-titan', 'attic')).toBe(NAME_TAKEN_TEXT);
  });

  it('allows a new name and the server’s own', () => {
    expect(nameClash(fleet, names, 'the-titan', 'The Titan')).toBeNull();
    expect(nameClash(fleet, names, 'pve-02', 'ATTIC')).toBeNull();
    expect(nameClash(fleet, names, 'the-titan', 'THE-TITAN')).toBeNull();
  });
});

describe('the names in memory', () => {
  afterEach(() => {
    noteServerNames(new Map());
    noteSelfServers({ servers: [] });
  });

  it('call a server by its given name, else its host name’s capitals, else its id', () => {
    noteSelfServers(fleet);
    noteServerNames(new Map([['the-titan', 'The Titan']]));
    expect(serverLabel('the-titan')).toBe('The Titan');
    expect(serverLabel('THE-TITAN')).toBe('The Titan');
    expect(serverLabel('blackbox')).toBe('BlackBox');
    expect(serverLabel('pve-02')).toBe('pve-02');
    expect(serverLabel('unknown')).toBe('unknown');
    expect(givenServerName('pve-02')).toBeNull();
  });

  it('find a server by its given name, after its id', () => {
    noteServerNames(new Map([['the-titan', 'The Titan']]));
    noteSelfServers(fleet);
    expect(knownServer('the titan')).toMatchObject({ id: 'the-titan', name: 'The Titan' });
    expect(knownServer('the-titan')?.id).toBe('the-titan');
  });

  it('words a rename', () => {
    expect(renamedText('the-titan', 'The Titan')).toContain('The Titan');
  });
});
