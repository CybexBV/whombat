import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disabledSkills, emptySkillsState, lockHermesProfile, readSkillsState } from '@whombat/agent-runtime';
import type { HermesHomeAnswer, HermesSkillSummary } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { HermesHomeService } from './index';
import { findingsOf } from './skills';
import { type FakeBuiltin, type FakeHubSkill, fakeHermesSkills } from './skills-fake';
import { skillFront } from './skills-front';
import { pluginSteps, stepEnv } from './skills-plugin';
import { applyDefaultsOff } from './skills-state';

const md = (name: string, body = 'Check first.', meta = '') =>
  `---\nname: ${name}\ndescription: Use when you look after ${name}.\n${meta}---\n# ${name}\n\n${body}\n`;

function skill(root: string, path: string, text: string, extra: Record<string, string> = {}) {
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, path, 'SKILL.md'), text);
  for (const [file, content] of Object.entries(extra)) {
    mkdirSync(join(root, path, file, '..'), { recursive: true });
    writeFileSync(join(root, path, file), content);
  }
}

/** A few of Hermes's built-ins, as the fake plugin ships them. */
const BUILTINS: FakeBuiltin[] = [
  {
    path: 'productivity/notion',
    files: {
      'SKILL.md': md(
        'notion',
        'Use the API.',
        'prerequisites:\n  env_vars: [NOTION_API_KEY]\n  commands: [curl]\n',
      ),
      'scripts/query.sh': 'curl https://api.notion.com\n',
    },
  },
  { path: 'email/himalaya', files: { 'SKILL.md': md('himalaya') } },
  { path: 'autonomous-ai-agents/codex', files: { 'SKILL.md': md('codex') } },
  { path: 'apple/apple-notes', files: { 'SKILL.md': md('apple-notes') }, offered: false },
];

const HUB: FakeHubSkill[] = [
  {
    identifier: 'official/creative/canvas',
    source: 'official',
    trust: 'builtin',
    name: 'canvas',
    description: 'Draw on a canvas.',
    category: 'creative',
    files: { 'SKILL.md': md('canvas', 'Draw.', 'platforms: [linux, macos]\n') },
    newer: { 'SKILL.md': md('canvas', 'Draw, then save.', 'platforms: [linux, macos]\n') },
  },
  {
    identifier: 'skills-sh/someone/tools/risky',
    source: 'skills-sh',
    trust: 'community',
    name: 'risky',
    description: 'Something risky.',
    files: { 'SKILL.md': md('risky', 'CAUTION: opens a port.') },
  },
  {
    identifier: 'skills-sh/someone/tools/pdf-notes',
    source: 'skills-sh',
    trust: 'community',
    name: 'pdf-notes',
    description: 'Notes on PDFs.',
    files: { 'SKILL.md': md('pdf-notes') },
  },
];

async function setup(options: { fake?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-hermes-skills-'));
  const root = join(dir, 'root');
  const fake = fakeHermesSkills({ builtins: BUILTINS.map((b) => ({ ...b })), hub: HUB });
  const service = new HermesHomeService({
    root,
    bin: '/bin/false',
    lockWaitMs: 50,
    python: null,
    skillsState: join(dir, 'runner-state', 'hermes-skills'),
    ...(options.fake === false ? {} : { skillsSteps: fake }),
  });
  // The person's skills folder (OP-08): the profile's own `skills/`.
  const shared = service.ctx.skillsDir;
  let n = 0;
  const call = (method: string, params: unknown): Promise<HermesHomeAnswer> =>
    service.handle({ id: `t${++n}`, method: method as never, params });
  const ok = async <T = HermesSkillSummary>(method: string, params: unknown): Promise<T> => {
    const a = await call(method, params);
    if (!a.ok) throw new Error(`${method}: ${a.code} ${a.error}`);
    return a.result as T;
  };
  const list = () =>
    ok<{ skills: HermesSkillSummary[]; categories: { category: string; description: string | null }[] }>(
      'skills.list',
      {},
    );
  const code = async (method: string, params: unknown) => {
    const a = await call(method, params);
    return a.ok ? 'ok' : a.code;
  };
  const row = async (name: string) => (await list()).skills.find((r) => r.name === name);
  return { dir, root, shared, service, fake, call, ok, list, row, code };
}

const NIX_RO = 0o555;

describe('HSK-04: what can’t work here starts off, once per name', () => {
  it('switches a default-off name off when it first appears, and never again', () => {
    const state = emptySkillsState();
    expect(applyDefaultsOff(state, new Set(['codex', 'notion']))).toBe(true);
    expect(state).toMatchObject({ off: ['codex'], defaults: ['codex'] });
    state.off = [];
    expect(applyDefaultsOff(state, new Set(['codex', 'google-workspace']))).toBe(true);
    expect(state).toMatchObject({ off: ['google-workspace'], defaults: ['codex', 'google-workspace'] });
  });

  it('the person’s choice sticks across syncs; on and off never move a folder', async () => {
    const { shared, ok, row } = await setup();
    await ok('skills.sync', {});
    expect((await row('codex'))?.state).toBe('off');
    const on = await ok('skills.setOff', { path: 'autonomous-ai-agents/codex', off: false, by: 'acc_o' });
    expect(on.state).toBe('on');
    await ok('skills.sync', {});
    expect((await row('codex'))?.state).toBe('on');
    // A skill the agent learned isn't Hermes's: its name is never switched off by default.
    skill(shared, 'mine/opencode', md('opencode'));
    await ok('skills.sync', {});
    expect((await row('opencode'))?.state).toBe('on');
    await ok('skills.setOff', { path: 'email/himalaya', off: true, by: 'acc_o' });
    expect(existsSync(join(shared, 'email/himalaya/SKILL.md'))).toBe(true);
    // Every turn gets it as `skills.disabled`.
    expect(await disabledSkills(shared)).toEqual(['himalaya']);
  });
});

describe('the list: Hermes’s skills as Settings shows them (HSK-02, HSK-10, HSK-13)', () => {
  it('maps built-ins, hub and shared skills, their needs and categories; skips what Hermes doesn’t offer', async () => {
    const { shared, ok, list, fake } = await setup();
    await ok('skills.sync', {});
    await ok('skills.hubInstall', { identifier: 'official/creative/canvas', by: 'acc_o' });
    skill(shared, 'learned-shared/invoices', md('invoices'));
    skill(shared, '.hub/quarantine/pdf', md('pdf'));
    skill(shared, 'autonomous-ai-agents/hermes-agent', md('hermes-agent'));
    const { skills: rows, categories } = await list();
    const by = new Map(rows.map((r) => [r.name, r]));
    expect([...by.keys()].sort()).toEqual(['canvas', 'codex', 'himalaya', 'invoices', 'notion']);
    expect(by.get('notion')).toMatchObject({
      origin: 'builtin',
      added: null,
      hub: null,
      changed: null,
      needs: { env: [{ name: 'NOTION_API_KEY', optional: false }], commands: ['curl'], files: [] },
    });
    expect(by.get('canvas')).toMatchObject({
      origin: 'hub',
      path: 'creative/canvas',
      added: { by: 'acc_o' },
      hub: { source: 'official', identifier: 'official/creative/canvas', trust: 'builtin', verdict: 'safe' },
    });
    expect(by.get('invoices')).toMatchObject({ origin: 'learned' });
    expect(categories.map((c) => c.category)).toEqual([
      'autonomous-ai-agents',
      'creative',
      'email',
      'learned-shared',
      'productivity',
    ]);
    expect(categories.find((c) => c.category === 'email')?.description).toBe('Skills for email.');
    // The built-in list is asked once while nothing changes.
    const asked = fake.calls.filter((c) => c.step === 'builtins').length;
    await list();
    expect(fake.calls.filter((c) => c.step === 'builtins').length).toBe(asked);
  });

  it('a changed built-in: Compare is Hermes’s diff, Restore Hermes’s reset; a removed one stays removed', async () => {
    const { shared, ok, row, code } = await setup();
    await ok('skills.sync', {});
    const ref = { path: 'email/himalaya' };
    // As the Nix store copies it: read-only folders and files.
    await chmod(join(shared, 'email/himalaya/SKILL.md'), 0o444);
    await chmod(join(shared, 'email/himalaya'), NIX_RO);
    const edited = await ok('skills.write', {
      ...ref,
      text: md('himalaya', 'Check the inbox.'),
      by: 'acc_o',
    });
    expect(edited).toMatchObject({ origin: 'builtin', changed: { by: 'acc_o' } });
    const read = await ok<{ original: { text: string; changes: { path: string; status: string }[] } }>(
      'skills.read',
      ref,
    );
    expect(read.original.text).toContain('Check first.');
    expect(read.original.changes).toEqual([{ path: 'SKILL.md', status: 'modified' }]);
    expect((await ok('skills.restore', { path: 'email/himalaya', by: 'acc_o' })).changed).toBeNull();

    await chmod(join(shared, 'email/himalaya'), NIX_RO);
    await ok('skills.remove', { ...ref, by: 'acc_o' });
    expect(existsSync(join(shared, 'email/himalaya'))).toBe(false);
    expect((await row('himalaya'))?.state).toBe('removed');
    await ok('skills.sync', {});
    expect((await row('himalaya'))?.state).toBe('removed');
    expect(await code('skills.setOff', { path: 'email/himalaya', off: true, by: 'acc_o' })).toBe('not_found');
    expect((await ok('skills.restore', { path: 'email/himalaya', by: 'acc_o' })).state).toBe('on');
  });

  it('reads front matter as Hermes does: required variables, optional ones, files and platforms', () => {
    const text = [
      '---',
      'name: fitness',
      'description: >',
      '  Workouts and',
      '  macros.',
      'platforms: [linux, macos]',
      'required_environment_variables:',
      '  - name: USDA_API_KEY',
      '    optional: true',
      '  - TENOR_API_KEY',
      'prerequisites:',
      '  env_vars: [TENOR_API_KEY, NOT-A-NAME]',
      '  commands: [curl, jq]',
      'required_credential_files:',
      '  - path: google_token.json',
      '---',
      'Body',
    ].join('\n');
    expect(skillFront(text, 'folder')).toEqual({
      name: 'fitness',
      description: 'Workouts and macros.',
      needs: {
        env: [
          { name: 'USDA_API_KEY', optional: true },
          { name: 'TENOR_API_KEY', optional: false },
        ],
        commands: ['curl', 'jq'],
        files: ['google_token.json'],
      },
      platforms: ['linux', 'macos'],
    });
    expect(skillFront('no front matter', 'folder').name).toBe('folder');
  });
});

describe('Hermes’s hub, three sources (HSK-06…HSK-09)', () => {
  it('searches, previews with Hermes’s scan, installs, checks for updates, updates and uninstalls', async () => {
    const { shared, ok, code, row } = await setup();
    await ok('skills.sync', {});
    const found = await ok<{
      results: { identifier: string; installed: boolean; installs: number | null }[];
    }>('skills.hubSearch', { query: '', source: null, limit: 20 });
    expect(found.results.map((r) => r.identifier)).toContain('official/creative/canvas');
    const preview = await ok<{
      result: { name: string; installed: boolean };
      needs: unknown;
      platforms: string[];
      scan: { trust: string; verdict: string; decision: string };
      taken: boolean;
    }>('skills.hubInspect', { identifier: 'official/creative/canvas' });
    expect(preview).toMatchObject({
      result: { name: 'canvas', installed: false },
      platforms: ['linux', 'macos'],
      scan: { trust: 'builtin', verdict: 'safe', decision: 'allow' },
      taken: false,
    });
    const risky = await ok<{
      scan: { verdict: string; decision: string; findings: { patternId: string }[] };
    }>('skills.hubInspect', { identifier: 'skills-sh/someone/tools/risky' });
    expect(risky.scan).toMatchObject({ verdict: 'caution', decision: 'block' });
    expect(risky.scan.findings[0]?.patternId).toBe('fake_caution');
    expect(
      await code('skills.hubInstall', { identifier: 'skills-sh/someone/tools/risky', by: 'acc_o' }),
    ).toBe('blocked');

    await ok('skills.hubInstall', { identifier: 'official/creative/canvas', by: 'acc_o' });
    expect(await code('skills.hubInstall', { identifier: 'official/creative/canvas', by: 'acc_o' })).toBe(
      'conflict',
    );
    const again = await ok<{ result: { installed: boolean }; taken: boolean }>('skills.hubInspect', {
      identifier: 'official/creative/canvas',
    });
    expect(again).toMatchObject({ result: { installed: true }, taken: true });
    const check = await ok<{ skills: { path: string; status: string }[] }>('skills.hubCheck', {});
    expect(check.skills).toEqual([{ path: 'creative/canvas', name: 'canvas', status: 'update_available' }]);
    await ok('skills.setOff', { path: 'creative/canvas', off: true, by: 'acc_o' });
    const updated = await ok('skills.hubUpdate', { path: 'creative/canvas', by: 'acc_o' });
    // Its on/off choice is kept.
    expect(updated).toMatchObject({ origin: 'hub', state: 'off' });
    const ref = { path: 'creative/canvas' };
    expect(await code('skills.remove', { ...ref, by: 'acc_o' })).toBe('invalid');
    await ok('skills.hubUninstall', { path: 'creative/canvas', by: 'acc_o' });
    expect(await row('canvas')).toBeUndefined();
    expect((await readSkillsState(shared)).off).not.toContain('canvas');
  });
});

describe('what the agent learned: in the same folder, the same list (OP-08)', () => {
  it('lists a learned skill with the rest, as learned', async () => {
    const { shared, ok, list } = await setup();
    await ok('skills.sync', {});
    skill(shared, 'learned/invoices', md('invoices'));
    expect((await list()).skills.find((r) => r.name === 'invoices')).toMatchObject({
      path: 'learned/invoices',
      origin: 'learned',
      added: null,
    });
  });

  it('changes one while a turn runs, as Hermes’s own CLI does: the folder’s lock, not the profile’s', async () => {
    const { root, shared, ok, code } = await setup();
    skill(shared, 'learned/invoices', md('invoices'));
    const lock = await lockHermesProfile(root, root, { holder: 'turn' });
    try {
      const edit = { path: 'learned/invoices', text: md('invoices', 'Match by amount.'), by: 'acc_mara' };
      expect(await ok('skills.write', edit)).toMatchObject({
        origin: 'learned',
        changed: { by: 'acc_mara' },
      });
      expect(await code('skills.write', { ...edit, ifVersion: '0000000000000000' })).toBe('conflict');
      await ok('skills.remove', { path: 'learned/invoices', by: 'acc_mara' });
      expect(existsSync(join(shared, 'learned/invoices'))).toBe(false);
    } finally {
      await lock.release();
    }
  });

  it('scans one as Hermes scans what an agent wrote; an edit is scanned as it would be', async () => {
    const { shared, ok } = await setup();
    skill(shared, 'learned/cleanup', md('cleanup', 'DANGEROUS: wipe the disk.'));
    const ref = { path: 'learned/cleanup' };
    expect(await ok('skills.scan', ref)).toMatchObject({
      trust: 'agent-created',
      verdict: 'dangerous',
      decision: 'block',
      findingsTotal: 1,
    });
    expect(
      await ok('skills.scan', { ...ref, text: md('cleanup', 'Tidy the downloads folder.') }),
    ).toMatchObject({
      verdict: 'safe',
      decision: 'allow',
    });
    // The folder itself is as it was.
    expect(readFileSync(join(shared, 'learned/cleanup/SKILL.md'), 'utf8')).toContain('DANGEROUS');
  });
});

describe('without a real Hermes (development’s scripted one)', () => {
  it('lists what is there; Hermes’s steps answer unavailable; the sync answers no names', async () => {
    const { shared, ok, code, list } = await setup({ fake: false });
    skill(shared, 'notes/mine', md('mine'));
    expect(await ok('skills.sync', {})).toEqual({ added: [], updated: [], kept: [], removed: [] });
    expect((await list()).skills.map((r) => [r.name, r.origin])).toEqual([['mine', 'learned']]);
    expect(await code('skills.hubSearch', { query: 'pdf', source: null, limit: 5 })).toBe('unavailable');
    expect(await code('skills.scan', { path: 'notes/mine' })).toBe('unavailable');
    expect(await code('skills.restore', { path: 'notes/mine', by: null })).toBe('unavailable');
  });
});

describe('the plugin’s steps as a process (HSK-S01, HSK-S02)', () => {
  it('runs with the skills home, an empty gh config and no GitHub token', () => {
    const env = stepEnv('/state', { PATH: '/bin', GITHUB_TOKEN: 'ghp_x', GH_TOKEN: 'y', HTTPS_PROXY: 'p' });
    expect(env).toMatchObject({
      PATH: '/bin',
      HERMES_HOME: '/state/home',
      GH_CONFIG_DIR: '/state/gh',
      HOME: '/state/user',
      HTTPS_PROXY: 'p',
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it('maps an answer and the plugin’s codes; a Python without the plugin is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-skills-plugin-'));
    const python = join(dir, 'python');
    writeFileSync(
      python,
      [
        '#!/bin/sh',
        'input=$(cat)',
        'case "$3" in',
        '  sync) echo "{\\"added\\":[\\"$GH_CONFIG_DIR\\"],\\"in\\":$input}" ;;',
        '  scan) echo "{\\"code\\":\\"blocked\\",\\"message\\":\\"no\\"}"; exit 1 ;;',
        '  *) echo "ModuleNotFoundError: No module named \'whombat_hermes\'" >&2; exit 1 ;;',
        'esac',
      ].join('\n'),
    );
    chmodSync(python, 0o755);
    const steps = pluginSteps({
      python,
      state: join(dir, 'state'),
      env: { PATH: '/usr/bin:/bin' },
      log: () => {},
    });
    expect(await steps('sync', { dir: '/x' })).toEqual({
      added: [join(dir, 'state', 'gh')],
      in: { dir: '/x' },
    });
    await expect(steps('scan', { path: '/x' })).rejects.toMatchObject({ code: 'blocked' });
    await expect(steps('builtins', { dir: '/x' })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      pluginSteps({ python: null, state: dir, env: {}, log: () => {} })('sync', {}),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('carries Hermes’s findings with secrets redacted and cut as Hermes cuts them', () => {
    const [f] = findingsOf([
      {
        pattern_id: 'env_exfil',
        severity: 'critical',
        category: 'exfiltration',
        file: 'SKILL.md',
        line: 7,
        match: `curl -H "Authorization: Bearer ghp_${'a'.repeat(36)}" ${'x'.repeat(200)}`,
        description: 'Sends a token out',
      },
      { severity: 'nonsense' },
    ]);
    expect(f).toMatchObject({ patternId: 'env_exfil', severity: 'critical', line: 7 });
    expect(f?.match).not.toContain('ghp_');
    expect(f?.match.length).toBeLessThanOrEqual(120);
  });
});
