import { describe, expect, it } from 'vitest';
import type { SkillHubPreview, SkillLibrary } from './contract';
import { createSkillLibraryWorld } from './fixtures';
import {
  hubPreviewModel,
  hubRefusalWords,
  hubResultMeta,
  hubUnreachableWords,
  matchesSkillQuery,
  removeAsk,
  skillErrorCode,
  skillLibraryView,
  skillPanel,
  splitSkillText,
  withoutNameHeading,
} from './model';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const TZ = 'Europe/Amsterdam';
const world = () => createSkillLibraryWorld({ agentName: 'Neo', now: NOW });
const view = (library: SkillLibrary, more: Partial<Parameters<typeof skillLibraryView>[1]> = {}) =>
  skillLibraryView(library, { now: NOW, timeZone: TZ, ...more });
const groupRows = (v: ReturnType<typeof view>) => v.groups.flatMap((g) => g.rows);
const allRows = (v: ReturnType<typeof view>) => [...v.groups, ...v.folds].flatMap((g) => g.rows);
const ctx = (w: ReturnType<typeof world>, more = {}) => ({
  now: NOW,
  timeZone: TZ,
  categories: w.library().categories,
  agent: 'Neo',
  ...more,
});

describe('the skill library list (HSK-12, HSK-13, CT-1410; AP-5522)', () => {
  it('shows one list: Hermes’s categories, then added and learned ones, folding off and removed', () => {
    const v = view(world().library());
    expect(v.groups.map((g) => g.label)).toEqual([
      'Creative',
      'Email',
      'Media',
      'Note taking',
      'Productivity',
      'Research',
      'Software development',
      'Web',
      'Added by you',
      'Learned by Neo',
    ]);
    // Hermes's own words describe a category; one without a DESCRIPTION.md has none.
    expect(v.groups.find((g) => g.id === 'category:email')?.description).toContain('email');
    expect(v.groups.find((g) => g.id === 'category:software-development')?.description).toBeNull();
    expect(v.folds.map((f) => f.id)).toEqual(['off', 'removed']);
    expect(v.groups.find((g) => g.id === 'learned')?.rows.map((r) => r.item.name)).toEqual([
      'how-whombat-website-deploys',
      'menerga-heat-pump',
      'unifi-network-backup',
    ]);
  });

  it('puts a hub skill in the category Hermes installed it into, saying where it came from', () => {
    const v = view(world().library());
    const productivity = v.groups.find((g) => g.id === 'category:productivity');
    const canvas = productivity?.rows.find((r) => r.item.name === 'canvas');
    expect(canvas?.origin).toBe('Added from Hermes');
    expect(productivity?.rows.find((r) => r.item.name === 'xlsx')?.origin).toBeNull();
    const added = v.groups.find((g) => g.id === 'added');
    expect(added?.rows.map((r) => [r.item.name, r.origin])).toEqual([['skill-creator', 'Added from GitHub']]);
    expect(v.groups.find((g) => g.id === 'learned')?.rows[0]?.origin).toBe('Learned by Neo');
  });

  it('keys a row by its name', () => {
    expect(groupRows(view(world().library())).find((r) => r.item.name === 'pdf')?.key).toBe('pdf');
  });

  it('says on, off and removed, a newer version, a change and what a skill needs', () => {
    const v = view(world().library());
    const row = (name: string) => allRows(v).find((r) => r.item.name === name);
    expect(row('obsidian')).toMatchObject({
      status: 'Changed · original changed',
      tone: 'warn',
      canSwitch: true,
    });
    expect(row('skill-creator')).toMatchObject({ status: 'Update available', tone: 'warn' });
    expect(row('notion')).toMatchObject({ status: 'Needs NOTION_API_KEY', tone: 'mut', on: true });
    expect(row('himalaya')?.status).toBe('Needs the himalaya command');
    expect(row('pdf')).toMatchObject({ status: 'On', tone: 'ok', on: true });
    expect(row('claude-code')).toMatchObject({ status: 'Off', on: false, tone: 'mut' });
    expect(row('gif-search')).toMatchObject({ status: 'Removed', on: false, canSwitch: false });
    expect(row('menerga-heat-pump')?.status).toBe('Learned today');
    expect(row('menerga-heat-pump')?.canSwitch).toBe(true);
  });

  it('marks an update Hermes’s check found before the library knows of it', () => {
    const v = view(world().library(), { updates: new Set(['canvas']) });
    expect(allRows(v).find((r) => r.item.name === 'canvas')?.status).toBe('Update available');
  });

  it('counts the skills there are', () => {
    const library = world().library();
    const live = library.items.filter((i) => i.status !== 'removed').length;
    expect(view(library)).toMatchObject({ count: live, title: `Skills · ${live}` });
  });

  it('narrows by search, the folds open', () => {
    const library = world().library();
    const found = view(library, { query: 'heat MODBUS' });
    expect(groupRows(found).map((r) => r.item.name)).toEqual(['menerga-heat-pump']);
    const off = view(library, { query: 'delegate' });
    expect(off).toMatchObject({ filtering: true });
    expect(off.folds.map((f) => f.id)).toEqual(['off']);
    expect(view(library, { query: 'kubernetes' }).nothingMatches).toBe(true);
    expect(matchesSkillQuery({ name: 'xlsx', description: 'Excel workbooks' }, 'excel')).toBe(true);
  });

  it('says so while the agent has no skills', () => {
    const library = world().library();
    expect(view({ ...library, items: [] }).empty).toContain('Neo');
    expect(view(library).empty).toBeNull();
  });
});

describe('the open skill (CT-1410…CT-1415; AP-5522)', () => {
  it('marks a changed built-in, says Hermes’s version moved on, and offers Compare and Restore', () => {
    const w = world();
    const detail = w.skill('obsidian');
    if (!detail) throw new Error('no obsidian');
    const panel = skillPanel(detail, ctx(w));
    expect(panel.tag).toBe('Note taking · Changed');
    expect(panel.originalChanged).not.toBeNull();
    expect(panel).toMatchObject({
      canCompare: true,
      canEdit: true,
      canRestore: true,
      canUpdate: false,
      removeKind: 'builtin',
    });
    expect(panel.shownBody.startsWith('Notes are Markdown files')).toBe(true);
  });

  it('offers Update on a hub skill with a newer version, and Remove that uninstalls it', () => {
    const w = world();
    const detail = w.skill('skill-creator');
    if (!detail) throw new Error('no skill-creator');
    const panel = skillPanel(detail, ctx(w));
    expect(panel).toMatchObject({ canUpdate: true, canRestore: false, canCompare: false, removeKind: 'hub' });
    expect(panel.tag).toBe('Added from GitHub');
    expect(removeAsk('hub', 'skill-creator', 'Neo')).toContain('Add skills');
    const canvas = w.skill('canvas');
    if (!canvas) throw new Error('no canvas');
    expect(skillPanel(canvas, ctx(w)).lines[0]).toBe('Needs CANVAS_API_TOKEN and CANVAS_BASE_URL');
    expect(skillPanel(canvas, ctx(w, { updates: new Set(['canvas']) })).canUpdate).toBe(true);
  });

  it('brings back a removed built-in, nothing to compare', () => {
    const w = world();
    const detail = w.skill('gif-search');
    if (!detail) throw new Error('no gif-search');
    expect(skillPanel(detail, ctx(w))).toMatchObject({
      canRestore: true,
      canCompare: false,
      canEdit: false,
      removeKind: null,
    });
  });

  it('says a learned skill is the agent’s, and forgets it on Remove', () => {
    const w = world();
    const detail = w.skill('menerga-heat-pump');
    if (!detail) throw new Error('no menerga-heat-pump');
    expect(skillPanel(detail, ctx(w))).toMatchObject({
      tag: 'Learned by Neo',
      canEdit: true,
      canSwitch: true,
      canCompare: false,
      removeKind: 'learned',
    });
    expect(removeAsk('learned', 'menerga-heat-pump', 'Neo')).toContain('Neo');
  });

  it('splits the front matter off the body, and the heading that repeats the name', () => {
    expect(splitSkillText('---\nname: a\ndescription: b\n---\n\n# A\n\nbody')).toEqual({
      frontMatter: 'name: a\ndescription: b',
      body: '# A\n\nbody',
    });
    expect(splitSkillText('# Just a body').body).toBe('# Just a body');
    expect(withoutNameHeading('# GIF search\n\nTenor.', 'gif-search')).toBe('Tenor.');
    expect(withoutNameHeading('# Steps\n\nOne.', 'gif-search')).toBe('# Steps\n\nOne.');
  });
});

describe('Hermes’s hub (HSK-06…HSK-09, CT-1413…CT-1415; AP-5526)', () => {
  const get = async (w: ReturnType<typeof world>, path: string) =>
    (await w.handle(new Request(`http://x/api/v1/burrows/burrow-hq/skills/hub/${path}`)))?.json();
  const post = (w: ReturnType<typeof world>, path: string, body: object) =>
    w.handle(
      new Request(`http://x/api/v1/burrows/burrow-hq/skills/hub/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );

  it('says a result’s source and trust in words, with installs when known', async () => {
    const found = await get(world(), 'search');
    const meta = (name: string) =>
      hubResultMeta(found.results.find((r: { name: string }) => r.name === name));
    expect(meta('canvas')).toBe('From Hermes');
    expect(meta('webapp-testing')).toBe('GitHub · Trusted');
    expect(meta('frontend-design')).toBe('skills.sh · Trusted · 12.4k installs');
    expect(meta('clipboard-sync')).toBe('skills.sh · Community · 412 installs');
    expect(found.results.find((r: { name: string }) => r.name === 'canvas').installed).toBe(true);
    expect(hubUnreachableWords(['skills-sh'])).toBe('skills.sh didn’t answer, so its skills are missing.');
    expect(hubUnreachableWords([])).toBeNull();
  });

  it('previews an allowed skill with Install, and a blocked one with Hermes’s reason and no Install', async () => {
    const w = world();
    const open = async (id: string) =>
      hubPreviewModel((await get(w, `preview?identifier=${encodeURIComponent(id)}`)) as SkillHubPreview);
    const hue = await open('official/smart-home/openhue');
    expect(hue).toMatchObject({
      canInstall: true,
      blocked: false,
      verdictTone: 'ok',
      platforms: 'Runs on Linux and macOS',
    });
    expect(hue.needs).toEqual(['Needs the openhue command']);
    expect(hue.body.startsWith('Turn lights on')).toBe(true);
    const caution = await open('anthropics/skills/skills/webapp-testing');
    expect(caution).toMatchObject({ canInstall: true, verdictTone: 'warn' });
    expect(caution.reason).toContain('trusts');
    expect(caution.findings[0]).toMatchObject({
      kind: 'Runs code',
      where: 'scripts/with_server.py, line 42',
    });
    const blocked = await open('skills-sh/someone/agent-tricks/clipboard-sync');
    expect(blocked).toMatchObject({ canInstall: false, blocked: true, notInstallable: null });
    expect(blocked.findings.map((f) => f.kind)).toEqual(['Exposes passwords or keys', 'Sends data out']);
    const taken = await open('anthropics/skills/skills/pdf');
    expect(taken).toMatchObject({ canInstall: false, blocked: false });
    expect(taken.notInstallable).toContain('pdf');
  });

  it('installs an allowed skill, and refuses a blocked one or a taken name', async () => {
    const w = world();
    const install = async (identifier: string) => {
      const r = await post(w, 'install', { identifier });
      return { status: r?.status, body: await r?.json() };
    };
    const hue = await install('official/smart-home/openhue');
    expect(hue.status).toBe(201);
    expect(hue.body.item).toMatchObject({ name: 'openhue', origin: 'hub', category: 'smart-home' });
    expect(view(w.library()).groups.map((g) => g.label)).toContain('Smart home');
    const blocked = (await install('skills-sh/someone/agent-tricks/disk-cleaner')).body.error;
    expect(skillErrorCode(blocked)).toBe('skill_blocked');
    expect(hubRefusalWords(blocked, 'disk-cleaner')).toContain('dangerous');
    const taken = (await install('anthropics/skills/skills/pdf')).body.error;
    expect(skillErrorCode(taken)).toBe('skill_exists');
    expect(skillErrorCode({ code: 'skill_hub_unavailable' })).toBe('skill_hub_unavailable');
  });

  it('answers the update check and updates a hub skill', async () => {
    const w = world();
    expect((await get(w, 'updates')).available).toEqual(['skill-creator']);
    const r = await (await post(w, 'update', { name: 'skill-creator' }))?.json();
    expect(r.item).toMatchObject({ hub: { updateAvailable: false }, can: { update: false } });
    expect((await get(w, 'updates')).available).toEqual([]);
  });
});

describe('the world answers writes by name (CT-1211, CT-1571; AP-5524)', () => {
  const post = (w: ReturnType<typeof world>, path: string, body: object) =>
    w.handle(
      new Request(`http://x/api/v1/burrows/burrow-hq/skills/library/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  const row = (w: ReturnType<typeof world>, name: string) => w.library().items.find((i) => i.name === name);

  it('edits a built-in into a changed one and restores Hermes’s', async () => {
    const w = world();
    await post(w, 'edit', { name: 'xlsx', body: '# xlsx\n\nOurs.' });
    expect(row(w, 'xlsx')).toMatchObject({ origin: 'builtin', changed: true, can: { restore: true } });
    expect(w.skill('xlsx')?.original?.changes).toEqual([{ path: 'SKILL.md', status: 'modified' }]);
    const restored = await (await post(w, 'restore', { name: 'xlsx' }))?.json();
    expect(restored.item).toMatchObject({ name: 'xlsx', changed: false });
  });

  it('uninstalls a hub skill, and keeps a removed built-in to restore', async () => {
    const w = world();
    const gone = await post(w, 'remove', { name: 'canvas' });
    expect((await gone?.json())?.item).toBeNull();
    expect(row(w, 'canvas')).toBeUndefined();
    const removed = await (await post(w, 'remove', { name: 'pdf' }))?.json();
    expect(removed.item).toMatchObject({ status: 'removed', can: { restore: true } });
  });

  it('forgets a learned skill', async () => {
    const w = world();
    expect((await (await post(w, 'remove', { name: 'menerga-heat-pump' }))?.json())?.item).toBeNull();
    expect(row(w, 'menerga-heat-pump')).toBeUndefined();
  });
});
