import { createFakeDesk, fakeDeskApi } from '@whombat/client/desk/fake';
import { describe, expect, it } from 'vitest';
import { DESK_FIXTURE_VIEWER, deskSeed } from '../../app/deskFixtures';
import {
  deskNameToGive,
  moveServer,
  placeServer,
  scenarioName,
  screenPartOpen,
  screenParts,
  screenTabShown,
  serverIdOf,
  showGroups,
  stripOrder,
  validateScreenPart,
} from './screenTab';

const paired = { personId: 'p', name: 'Mara', pairedAt: '2026-10-25T08:00:00Z', hasPin: true, you: true };

describe('the tab and its parts', () => {
  it('shows where a screen is connected or paired', () => {
    const display = { connected: false, real: false, builtIn: false, name: null };
    expect(screenTabShown({ paired: null, display })).toBe(false);
    expect(screenTabShown({ paired: null, display: { ...display, connected: true } })).toBe(true);
    expect(screenTabShown({ paired: paired as never, display })).toBe(true);
    expect(screenTabShown(undefined)).toBe(false);
  });

  it('has no parts until paired, and What it shows only where the runtime lists the choices', () => {
    expect(screenParts({ paired: null, showOptions: [] })).toEqual([]);
    expect(screenParts({ paired: paired as never })).toEqual(['lock', 'night', 'talk']);
    expect(screenParts({ paired: paired as never, showOptions: [] })).toEqual([
      'shows',
      'lock',
      'night',
      'talk',
    ]);
  });

  it('opens the part asked for when it shows, else the first', () => {
    expect(screenPartOpen(['shows', 'lock'], 'lock')).toBe('lock');
    expect(screenPartOpen(['lock', 'night'], 'shows')).toBe('lock');
    expect(screenPartOpen([], 'talk')).toBeNull();
    expect(validateScreenPart('night')).toBe('night');
    expect(validateScreenPart('shows')).toBeUndefined();
    expect(validateScreenPart('keys')).toBeUndefined();
  });

  it('names the scenarios with the assistant', () => {
    expect(scenarioName('busy', 'Neo')).toBe('Neo at work');
    expect(scenarioName('now', 'Neo')).toBe('Now');
  });
});

describe('the choices', () => {
  it('groups them as What it shows lists them, servers in the strip’s order', async () => {
    const api = fakeDeskApi(createFakeDesk(deskSeed('pinned', Date.now())), DESK_FIXTURE_VIEWER);
    const screen = await api.update({ show: { order: ['nas', 'pve-02'] } });
    const groups = showGroups(screen.showOptions ?? []);
    expect(groups.assistant.map((o) => o.key)).toEqual(['work', 'coming']);
    expect(groups.connection.map((o) => o.key)).toContain('connection:con_plex');
    expect(groups.widget.map((o) => o.key)).toEqual(['widget:wdg_living']);
    expect(groups.server.slice(0, 3).map((o) => serverIdOf(o.key))).toEqual(['nas', 'pve-02', 'pve-01']);
    expect(groups.box?.key).toBe('box');
  });

  it('moves a server up and down, and stays put at the ends', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveServer(ids, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveServer(ids, 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveServer(ids, 'a', -1)).toEqual(ids);
    expect(moveServer(ids, 'c', 1)).toEqual(ids);
    expect(moveServer(ids, 'x', 1)).toEqual(ids);
  });

  it('drops a dragged server at its place among the others', () => {
    expect(placeServer(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(placeServer(['a', 'b', 'c', 'd'], 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(placeServer(['a', 'b'], 'a', 9)).toEqual(['b', 'a']);
  });

  it('puts the person’s order first, skipping servers that are gone, then the rest as listed', () => {
    expect(stripOrder(['a', 'b', 'c', 'd'], ['c', 'gone', 'a', 'c'])).toEqual(['c', 'a', 'b', 'd']);
    expect(stripOrder(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

describe('the Whombat’s name for the top bar', () => {
  it('gives a name only to a runtime that knows names, and only when it differs', () => {
    expect(deskNameToGive('Home', {})).toBeNull();
    expect(deskNameToGive('Home', { whombatName: null })).toBe('Home');
    expect(deskNameToGive('Home', { whombatName: 'Office' })).toBe('Home');
    expect(deskNameToGive('Home', { whombatName: 'Home' })).toBeNull();
    expect(deskNameToGive(null, { whombatName: null })).toBeNull();
    expect(deskNameToGive('   ', { whombatName: null })).toBeNull();
  });

  it('puts it on one line of at most 40 characters', () => {
    expect(deskNameToGive('  The   attic\tbox ', { whombatName: null })).toBe('The attic box');
    const long = deskNameToGive('A'.repeat(50), { whombatName: null }) as string;
    expect([...long]).toHaveLength(40);
    expect(long.endsWith('…')).toBe(true);
  });
});
