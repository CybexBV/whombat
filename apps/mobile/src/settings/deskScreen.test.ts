import { DEFAULT_DESK_SETTINGS, DEFAULT_DESK_SHOW, type DeskScreen } from '@whombat/client/desk';
import { createFakeDesk, fakeDeskApi } from '@whombat/client/desk/fake';
import { describe, expect, it } from 'vitest';
import {
  deskDragPlaces,
  deskMoveServer,
  deskNameToGive,
  deskPreviewSpoken,
  deskScenarioOptions,
  deskScreenParts,
  deskShowsView,
  deskTryLabel,
  resolveDeskScreenPart,
} from './deskScreen';

const paired = { personId: 'p', name: 'Mara', pairedAt: '2026-10-01T10:00:00Z', hasPin: true, self: false };

describe('Settings → Screen parts', () => {
  it('has none until paired, What it shows only where the box lists choices', () => {
    expect(deskScreenParts({ paired: null, showOptions: [] })).toEqual([]);
    expect(deskScreenParts({ paired, showOptions: [] } as unknown as DeskScreen)).toEqual([
      'shows',
      'lock',
      'night',
      'talk',
    ]);
    expect(deskScreenParts({ paired } as unknown as DeskScreen)).toEqual(['lock', 'night', 'talk']);
  });

  it('opens the part a link names when the screen has it', () => {
    expect(resolveDeskScreenPart('night', ['shows', 'lock', 'night', 'talk'])).toBe('night');
    expect(resolveDeskScreenPart('shows', ['lock', 'night', 'talk'])).toBe('lock');
    expect(resolveDeskScreenPart(undefined, [])).toBeNull();
  });
});

const viewer = { personId: 'prn_mara0001', name: 'Mara' };
/** The demo world's screen, paired with the viewer: the mockups' eight servers and connections. */
const fakeApi = () =>
  fakeDeskApi(
    createFakeDesk({
      now: () => Date.parse('2026-10-27T13:34:00Z'),
      initial: {
        paired: { ...viewer, pairedAt: '2026-10-20T12:00:00Z', pin: '246810' },
        settings: DEFAULT_DESK_SETTINGS,
      },
    }),
    viewer,
  );

describe('What it shows', () => {
  it('groups the choices and keeps the servers in the strip’s order', async () => {
    const api = fakeApi();
    const screen = await api.update({
      show: { order: ['nas'], items: { 'server:backup-box': 'off', 'connection:con_plex': 'always' } },
    });
    const show = screen.settings.show;
    const view = deskShowsView(screen.showOptions ?? [], show, 'Neo');
    expect(view.bar.map((r) => [r.item, r.level])).toEqual([
      ['network', 'always'],
      ['internet', 'always'],
      ['battery', 'always'],
      ['updates', 'matters'],
    ]);
    expect(view.middle.map((g) => g.group)).toEqual(['assistant', 'connection', 'widget']);
    expect(view.middle[0]?.title).toBe('Neo');
    // The assistant's rows take their name and line from Settings' words.
    expect(view.middle[0]?.rows[0]).toMatchObject({ key: 'work', name: 'Neo’s work' });
    expect(view.middle[0]?.rows[0]?.line).toContain('Neo');
    expect(view.middle[1]?.rows.find((r) => r.key === 'connection:con_plex')?.level).toBe('always');
    expect(view.middle[2]?.rows[0]?.level).toBe('off');
    expect(view.servers[0]?.id).toBe('nas');
    expect(view.servers.find((s) => s.id === 'backup-box')?.level).toBe('off');
    expect(view.servers.find((s) => s.id === 'pve-01')?.level).toBe('always');
    expect(view.box?.key).toBe('box');
  });
});

describe('the strip’s order', () => {
  const ids = ['a', 'b', 'c', 'd'];
  it('moves a server up, down and by a drag, the whole list becoming the order', () => {
    expect(deskMoveServer(ids, 'c', -1)).toEqual(['a', 'c', 'b', 'd']);
    expect(deskMoveServer(ids, 'a', 1)).toEqual(['b', 'a', 'c', 'd']);
    expect(deskMoveServer(ids, 'b', 5)).toEqual(['a', 'c', 'd', 'b']);
  });
  it('doesn’t move past the ends or what isn’t there', () => {
    expect(deskMoveServer(ids, 'a', -1)).toBeNull();
    expect(deskMoveServer(ids, 'd', 1)).toBeNull();
    expect(deskMoveServer(ids, 'x', 1)).toBeNull();
  });
  it('changes places after half a row of drag', () => {
    expect(deskDragPlaces(20, 60)).toBe(0);
    expect(deskDragPlaces(31, 60)).toBe(1);
    expect(deskDragPlaces(-95, 60)).toBe(-2);
    expect(deskDragPlaces(50, 0)).toBe(0);
  });
});

describe('the preview', () => {
  it('names the scenarios and Try it with the assistant', () => {
    expect(deskScenarioOptions('Neo').map((o) => o.value)).toEqual(['now', 'wrong', 'busy']);
    expect(deskScenarioOptions('Neo')[2]?.label).toContain('Neo');
    expect(deskTryLabel('wrong', 'Neo')).toContain('Something’s wrong');
  });
  it('reads the name, the sentence and the hero', async () => {
    const api = fakeApi();
    await api.setName('Home');
    const preview = await api.preview({ scenario: 'wrong', show: DEFAULT_DESK_SHOW });
    const spoken = deskPreviewSpoken(preview);
    expect(spoken).toContain('Home');
    expect(spoken).toContain(preview.calm.headline.text);
    expect(preview.calm.hero).toBeDefined();
    expect(spoken).toContain(preview.calm.hero?.title ?? '?');
  });
});

describe('the Whombat’s name for the top bar', () => {
  it('gives the phone’s name when the box keeps another', () => {
    expect(deskNameToGive('Home', { whombatName: null })).toBe('Home');
    expect(deskNameToGive('Home', { whombatName: 'Office' })).toBe('Home');
  });
  it('gives nothing when it is the same, unknown, or the box keeps no name', () => {
    expect(deskNameToGive('Home', { whombatName: 'Home' })).toBeNull();
    expect(deskNameToGive(null, { whombatName: null })).toBeNull();
    expect(deskNameToGive('Home', {})).toBeNull();
    expect(deskNameToGive('Home', undefined)).toBeNull();
  });
  it('makes it one line the top bar takes', () => {
    expect(deskNameToGive('  Home\n office ', { whombatName: null })).toBe('Home office');
    expect(deskNameToGive('x'.repeat(60), { whombatName: null })).toHaveLength(40);
    expect(deskNameToGive(' ​ ', { whombatName: null })).toBeNull();
  });
});
