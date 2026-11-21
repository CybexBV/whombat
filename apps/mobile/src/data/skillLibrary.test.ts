/** The agent's skills on the phone (Whombat all-skills.md SK-18, hermes-skills.md HSK-12; AP-2360…, AP-5273…, AP-5570…). */
import {
  skillLibraryEndpoints as E,
  type SkillLibrary,
  skillLibraryView,
  skillPanel,
} from '@whombat/client/skill-library';
import { createSkillLibraryWorld } from '@whombat/client/skill-library/fixtures';
import { createFixtureFetch } from '@whombat/fixtures/fetch';
import { describe, expect, it } from 'vitest';
import { demoClient } from '../demo/session';
import { createFixtureServer } from '../fixtures/fixture-server';
import { createClock } from '../lib/time';
import { RESTORE_WATCH, restorableRoute } from '../navigation/persist';
import { appScreenUrlForPath, LINKING_SCREENS } from '../navigation/routes';
import { minutesAfterSeed } from '../test/world';
import { removeConfirm, restoreConfirm, skillLibraryHere, skillRowLabel } from './skillLibrary';

const NOW = Date.UTC(2026, 9, 24, 12, 0);
const TZ = 'Europe/Amsterdam';
const world = () => createSkillLibraryWorld({ agentName: 'Neo', now: NOW });
const byName = (library: SkillLibrary, name: string) => {
  const item = library.items.find((i) => i.name === name);
  if (!item) throw new Error(`no ${name}`);
  return item;
};

describe('where the phone shows the library (AP-2360, AP-4150, AP-4967)', () => {
  it('needs the agent', () => {
    expect(skillLibraryHere({ agent: true })).toBe(true);
    expect(skillLibraryHere({ agent: false })).toBe(false);
  });
});

describe('links and restored places (AP-2361, AP-4150, AP-4967)', () => {
  it('opens the agent’s skills from the web’s addresses, the old Agent part too (AP-5571)', () => {
    expect(appScreenUrlForPath('/settings?tab=skills')).toBe('whombat://skills');
    expect(appScreenUrlForPath('/settings?tab=agent&part=skills')).toBe('whombat://skills');
    expect(appScreenUrlForPath('/settings/agent?part=skills')).toBe('whombat://skills');
    expect(appScreenUrlForPath('/settings?tab=agent&part=keys')).toBe('whombat://settings/advanced/keys');
    expect(appScreenUrlForPath('/settings?tab=advanced&part=skills')).toBe('whombat://skills');
    expect(appScreenUrlForPath('/burrow-hq/settings?tab=skills')).toBe('whombat://skills');
    expect(appScreenUrlForPath('/skills')).toBe('whombat://skills');
    expect(LINKING_SCREENS).toMatchObject({ Skills: 'skills', Skill: 'skills/:name' });
  });

  it('restores the list and a skill by its name', () => {
    const w = { sidebar: { branchRooms: [], dms: [] }, managed: false };
    expect(restorableRoute({ name: 'Skills' }, w)).toBe(true);
    expect(restorableRoute({ name: 'Skill', params: { name: 'notion' } }, w)).toBe(true);
    expect(restorableRoute({ name: 'Skill', params: {} }, w)).toBe(false);
    // A restored skill that is gone goes back to the tabs: its read is watched by its endpoint's id.
    expect(RESTORE_WATCH.Skill).toBe(E.skill.id);
  });
});

describe('a row and the open skill (AP-2362, AP-5274, AP-5275, AP-5572, AP-5573)', () => {
  const library = world().library();
  const view = skillLibraryView(library, { now: NOW, timeZone: TZ });
  const rows = [...view.groups, ...view.folds].flatMap((g) => g.rows);
  const rowOf = (name: string) => {
    const row = rows.find((r) => r.item.name === name);
    if (!row) throw new Error(`no row ${name}`);
    return row;
  };
  const panelOf = (name: string) => {
    const skill = world().skill(name);
    if (!skill) throw new Error(`no ${name}`);
    return skillPanel(skill, { now: NOW, timeZone: TZ, categories: library.categories, agent: 'Neo' });
  };

  it('says the name, what it does, where it came from and its status to TalkBack', () => {
    const row = rowOf('canvas');
    const label = skillRowLabel(row);
    expect(label).toContain('canvas');
    expect(row.origin).toBe('Added from Hermes');
    expect(label).toContain(row.origin as string);
    expect(label).toContain(row.status);
    expect(skillRowLabel(rowOf('notion'))).toContain('NOTION_API_KEY');
    expect(rowOf('xlsx').origin).toBeNull();
  });

  it('keys a row by its name, one list with the learned ones by the agent (AP-5765)', () => {
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('menerga-heat-pump');
    expect(rowOf('menerga-heat-pump').origin).toBe('Learned by Neo');
  });

  it('asks before restoring Hermes’s and before removing, by what removing does', () => {
    const obsidian = panelOf('obsidian');
    expect(obsidian).toMatchObject({ canRestore: true, removeKind: 'builtin' });
    expect(restoreConfirm(obsidian, false, 'Neo')).toMatchObject({
      action: 'Restore Hermes’s',
      destructive: true,
    });
    expect(restoreConfirm(panelOf('gif-search'), true, 'Neo').body).toContain('Neo');
    expect(removeConfirm(obsidian, 'Neo')).toMatchObject({ action: 'Remove', destructive: true });
    // A hub skill goes for good, and can be added again on the web.
    const canvas = panelOf('canvas');
    expect(canvas.removeKind).toBe('hub');
    expect(removeConfirm(canvas, 'Neo')?.body).toContain('Add skills');
    const learned = panelOf('menerga-heat-pump');
    expect(learned.removeKind).toBe('learned');
    // The question is the dialog's title, what follows it the message (Android shows two title lines at most).
    expect(removeConfirm(learned, 'Neo')?.title.endsWith('?')).toBe(true);
    expect(removeConfirm(learned, 'Neo')?.body).toContain('forgets');
    expect(removeConfirm({ ...obsidian, removeKind: null }, 'Neo')).toBeNull();
  });

  it('shows what a skill needs in its lines', () => {
    expect(panelOf('notion').lines).toContain('Needs NOTION_API_KEY');
    expect(panelOf('obsidian').tag).toBe('Note taking · Changed');
  });
});

describe('the demo world answers the library (AP-2365, AP-4155, AP-5575)', () => {
  const setup = () => {
    const server = createFixtureServer({
      inner: createFixtureFetch(),
      now: createClock(minutesAfterSeed(0), Date.now()),
      setTimer: () => {},
      assistant: true,
    });
    return demoClient(server.fetch);
  };
  const params = { burrow: 'burrow-hq' };
  const ok = <T>(result: { status: string; data?: T }): T => {
    if (result.status !== 'ok' || result.data === undefined) throw new Error(result.status);
    return result.data;
  };

  it('lists the agent’s skills with Hermes’s categories and switches one off by its name', async () => {
    const client = setup();
    const library = ok(await client.request(E.library, { params }));
    expect(library.agentName).toBeTruthy();
    expect(byName(library, 'xlsx')).toMatchObject({
      status: 'on',
      origin: 'builtin',
      category: 'productivity',
    });
    expect(library.categories.map((c) => c.category)).toContain('productivity');
    expect(library.items.some((i) => i.origin === 'learned')).toBe(true);

    const switched = ok(await client.request(E.switch, { params, body: { name: 'xlsx', on: false } }));
    expect(switched.item?.status).toBe('off');
    const again = ok(await client.request(E.library, { params }));
    expect(byName(again, 'xlsx').status).toBe('off');
  });

  it('opens a skill by its name, with its text', async () => {
    const client = setup();
    const skill = ok(await client.request(E.skill, { params, query: { name: 'xlsx' } }));
    expect(skill.item.name).toBe('xlsx');
    expect(skill.text.length).toBeGreaterThan(0);
  });

  it('restores a changed built-in to Hermes’s and uninstalls a hub skill', async () => {
    const client = setup();
    const restored = ok(await client.request(E.restore, { params, body: { name: 'obsidian' } }));
    expect(restored.item).toMatchObject({ name: 'obsidian', origin: 'builtin', changed: false });
    const removed = ok(await client.request(E.remove, { params, body: { name: 'canvas' } }));
    expect(removed.item).toBeNull();
  });
});
