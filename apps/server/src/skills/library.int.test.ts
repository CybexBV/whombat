/**
 * Settings → Skills on Hermes's skills (contracts 2.0 CT-1410…CT-1419; hermes-skills.md HSK-02…HSK-12), through REST
 * and the runner's Hermes-home service on a throwaway root, Hermes's own steps replaced by the runner's fake plugin:
 * Hermes's built-ins and what the agent learned in one list (one-person.md OP-08), the person's edit (Hermes's scan
 * first), switch, remove and restore, and Hermes's hub: search, preview, install, update and uninstall, the person only.
 * Needs Postgres: routes and the audit log.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hermesPersonProfile } from '@whombat/agent-runtime';
import { api, buildPath } from '@whombat/core';
import { type FakeHermesSkills, fakeHermesSkills, HermesHomeService } from '@whombat/runner';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { events } from '../db/schema/index';
import { useHermesHome } from '../hermes-home/service';
import { IDS } from '../seed/test-world';
import { useTestServer } from '../test/harness';
import { sessionFor } from '../test/tokens';

const t = useTestServer({ seed: true, app: true });
let root = '';
let shared = '';
let fake: FakeHermesSkills;

const md = (name: string, body: string, meta = '') =>
  `---\nname: ${name}\ndescription: Use when ${name} needs doing.\n${meta}---\n# ${name}\n\n${body}\n`;

/** A skill the agent learned: in the person's profile's skills, beside Hermes's (OP-08). */
function learned(path: string, text: string) {
  const dir = join(hermesPersonProfile(root), 'skills', path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), text);
}

async function call(
  who: string,
  ep: (typeof api.skills)[keyof typeof api.skills],
  opts: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {},
) {
  const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : '';
  const res = await t.api.inject({
    method: ep.method,
    url: `${ep.base}${buildPath(ep.path, { burrow: 'burrow-hq', ...(opts.params ?? {}) })}${qs}`,
    headers: { cookie: (await sessionFor(t.services, who)).cookie },
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
  return { status: res.statusCode, body: res.json() };
}

interface Row {
  name: string;
  status: string;
  origin: string;
  category: string | null;
  changed: boolean;
  version: string;
  needs: { env: { name: string }[] };
  hub: { identifier: string; updateAvailable: boolean } | null;
  can: Record<string, boolean>;
}
const items = async (who: string) => (await call(who, api.skills.library)).body.items as Row[];
const row = async (who: string, name: string) => (await items(who)).find((i) => i.name === name);
const eventTypes = async () =>
  (await t.services.db.select({ type: events.type }).from(events)).map((e) => e.type);

beforeAll(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'wb-skills-library-')), 'hermes');
  fake = fakeHermesSkills({
    builtins: [
      {
        path: 'productivity/notion',
        files: { 'SKILL.md': md('notion', 'Use the API.', 'prerequisites:\n  env_vars: [NOTION_API_KEY]\n') },
      },
      { path: 'creative/humanizer', files: { 'SKILL.md': md('humanizer', 'Write like a person.') } },
      { path: 'autonomous-ai-agents/codex', files: { 'SKILL.md': md('codex', 'Drive Codex.') } },
    ],
    hub: [
      {
        identifier: 'official/productivity/memento-flashcards',
        source: 'official',
        trust: 'builtin',
        name: 'memento-flashcards',
        description: 'Flashcards.',
        category: 'productivity',
        files: { 'SKILL.md': md('memento-flashcards', 'Make cards.') },
        newer: { 'SKILL.md': md('memento-flashcards', 'Make cards, then review them.') },
      },
      {
        identifier: 'skills-sh/someone/tools/port-scan',
        source: 'skills-sh',
        trust: 'community',
        name: 'port-scan',
        description: 'Scans ports.',
        files: { 'SKILL.md': md('port-scan', 'CAUTION: opens sockets.') },
      },
    ],
  });
  const home = new HermesHomeService({ root, bin: '/bin/false', skillsSteps: fake });
  useHermesHome(t.services, home);
  shared = home.ctx.skillsDir;
  await home.handle({ id: 'sync', method: 'skills.sync', params: {} });
  learned('finance/invoices', md('invoices', 'Match invoices by amount.'));
});

describe('Settings → Skills', () => {
  it('shows Hermes’s skills and what the agent learned in one list (OP-08)', async () => {
    const library = (await call(IDS.mara, api.skills.library)).body;
    const mara = library.items as Row[];
    expect(mara.find((i) => i.name === 'notion')).toMatchObject({
      origin: 'builtin',
      category: 'productivity',
      status: 'on',
      needs: { env: [{ name: 'NOTION_API_KEY' }] },
    });
    // HSK-04: another agent's command line starts off.
    expect(mara.find((i) => i.name === 'codex')).toMatchObject({ status: 'off', can: { switch: true } });
    expect(mara.find((i) => i.name === 'invoices')).toMatchObject({ origin: 'learned' });
    expect(mara.filter((i) => i.name === 'invoices')).toHaveLength(1);
    expect(library.categories).toContainEqual(
      expect.objectContaining({ category: 'productivity', title: 'Productivity' }),
    );
    expect((await call(IDS.mara, api.skills.librarySkill, { query: { name: 'nothing-here' } })).status).toBe(
      404,
    );
  });

  it('lets the person change a built-in, compare it with Hermes’s, switch it off, remove and restore it', async () => {
    const ref = { name: 'humanizer' };
    const before = await call(IDS.mara, api.skills.librarySkill, { query: ref });
    expect(before.body.text).not.toMatch(/^---/);
    const edited = await call(IDS.mara, api.skills.libraryEdit, {
      body: { name: 'humanizer', body: '# Humanizer\n\nPlain words, short sentences.\n' },
    });
    expect(edited.body.item).toMatchObject({ changed: true, origin: 'builtin', can: { restore: true } });
    expect((await readFile(join(shared, 'creative/humanizer/SKILL.md'), 'utf8')).split('\n')[1]).toBe(
      'name: humanizer',
    );
    const now = await call(IDS.mara, api.skills.librarySkill, { query: ref });
    expect(now.body.original).toMatchObject({ text: before.body.text, changes: [{ path: 'SKILL.md' }] });
    const off = await call(IDS.mara, api.skills.librarySwitch, { body: { name: 'humanizer', on: false } });
    expect(off.body.item).toMatchObject({ status: 'off', enabled: false });
    await call(IDS.mara, api.skills.librarySwitch, { body: { name: 'humanizer', on: true } });
    const restored = await call(IDS.mara, api.skills.libraryRestore, { body: { name: 'humanizer' } });
    expect(restored.body.item).toMatchObject({ changed: false, status: 'on' });
    const removed = await call(IDS.mara, api.skills.libraryRemove, { body: ref });
    expect(removed.body.item).toMatchObject({ status: 'removed', can: { restore: true, edit: false } });
    await call(IDS.mara, api.skills.libraryRestore, { body: { name: 'humanizer' } });
    for (const type of ['skill.changed', 'skill.switched', 'skill.removed', 'skill.reset'])
      expect(await eventTypes()).toContain(type);
  });

  it('refuses an edit Hermes’s scan finds dangerous, and says why in its code', async () => {
    const res = await call(IDS.mara, api.skills.libraryEdit, {
      body: { name: 'notion', body: '# Notion\n\nDANGEROUS: wipe everything first.\n' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'not_allowed',
      details: { code: 'skill_blocked', verdict: 'dangerous', trust: 'agent-created' },
    });
    expect(await readFile(join(shared, 'productivity/notion/SKILL.md'), 'utf8')).not.toContain('DANGEROUS');
  });
});

describe('Hermes’s hub (HSK-06…HSK-09)', () => {
  it('lets the person search, preview and install a skill', async () => {
    const found = await call(IDS.mara, api.skills.hubSearch, { query: { q: 'cards' } });
    expect(found.body.results).toEqual([
      expect.objectContaining({ identifier: 'official/productivity/memento-flashcards', installed: false }),
    ]);
    const identifier = 'official/productivity/memento-flashcards';
    const preview = await call(IDS.mara, api.skills.hubPreview, { query: { identifier } });
    expect(preview.body).toMatchObject({
      result: { name: 'memento-flashcards', trust: 'builtin' },
      scan: { verdict: 'safe', findingsTotal: 0 },
      policy: { decision: 'allow' },
      nameTaken: false,
    });
    const installed = await call(IDS.mara, api.skills.hubInstall, { body: { identifier } });
    expect(installed.status).toBe(201);
    expect(installed.body.item).toMatchObject({
      origin: 'hub',
      category: 'productivity',
      hub: { source: 'official', identifier, trust: 'builtin', updateAvailable: false },
    });
    const again = await call(IDS.mara, api.skills.hubInstall, { body: { identifier } });
    expect(again.body.error).toMatchObject({ code: 'conflict', details: { code: 'skill_exists' } });
    const [event] = await t.services.db.select().from(events).where(eq(events.type, 'skill.installed'));
    expect(event?.payload).toMatchObject({ name: 'memento-flashcards', identifier, verdict: 'safe' });
  });

  it('refuses what Hermes’s policy blocks, and sources outside the three, before asking anyone', async () => {
    const blocked = await call(IDS.mara, api.skills.hubInstall, {
      body: { identifier: 'skills-sh/someone/tools/port-scan' },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.details).toMatchObject({ code: 'skill_blocked' });
    const preview = await call(IDS.mara, api.skills.hubPreview, {
      query: { identifier: 'skills-sh/someone/tools/port-scan' },
    });
    expect(preview.body).toMatchObject({ scan: { verdict: 'caution' }, policy: { decision: 'block' } });
    const asked = fake.calls.length;
    const clawhub = await call(IDS.mara, api.skills.hubPreview, {
      query: { identifier: 'clawhub/some-skill' },
    });
    expect(clawhub.status).toBe(400);
    expect(fake.calls.length).toBe(asked);
  });

  it('checks for updates at most once an hour, updates through the same scan, and uninstalls the Hermes way', async () => {
    const updates = await call(IDS.mara, api.skills.hubUpdates);
    expect(updates.body).toMatchObject({ available: ['memento-flashcards'] });
    const checks = fake.calls.filter((c) => c.step === 'hub-check').length;
    await call(IDS.mara, api.skills.hubUpdates);
    expect(fake.calls.filter((c) => c.step === 'hub-check').length).toBe(checks);
    expect(await row(IDS.mara, 'memento-flashcards')).toMatchObject({
      hub: { updateAvailable: true },
      can: { update: true },
    });
    const updated = await call(IDS.mara, api.skills.hubUpdate, { body: { name: 'memento-flashcards' } });
    expect(updated.body.item).toMatchObject({ hub: { updateAvailable: false }, can: { update: false } });
    expect(await eventTypes()).toContain('skill.updated');
    const removed = await call(IDS.mara, api.skills.libraryRemove, {
      body: { name: 'memento-flashcards' },
    });
    expect(removed.body.item).toBeNull();
    expect(fake.calls.some((c) => c.step === 'hub-uninstall')).toBe(true);
  });

  it('says when Hermes’s hub doesn’t answer', async () => {
    fake.down.add('hub-search');
    try {
      const res = await call(IDS.mara, api.skills.hubSearch, { query: { q: 'pdf' } });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({
        code: 'unavailable',
        details: { code: 'skill_hub_unavailable' },
      });
    } finally {
      fake.down.delete('hub-search');
    }
  });
});
