import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hermesConfig } from './config';
import { disabledSkills, hermesSkillsDir, parseSkillsState, skillFolders, skillNameOf } from './skills';

function skill(root: string, rel: string, body = 'Check first.\n', extra: Record<string, string> = {}) {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  const name = rel.split('/').pop();
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Use when testing.\n---\n${body}`);
  for (const [path, text] of Object.entries(extra)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

describe('skills in the profile, in Hermes’s layout (OP-08)', () => {
  it('the profile’s own skills folder, no external directory, and nothing of a repository’s own', () => {
    const config = hermesConfig({ runtime: 'claude_directsdk', model: null, effort: null });
    expect(config.skills).toEqual({
      project_discovery: false,
      inline_shell: false,
      guard_agent_created: true,
    });
    expect(hermesSkillsDir('/r')).toBe('/r/skills');
  });

  it('lists skill folders, not below a skill and not in a dot folder (Hermes’s bookkeeping)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-hs-'));
    skill(root, 'servers/proxmox', 'x', { 'references/SKILL.md': 'nested' });
    skill(root, 'mine');
    skill(root, '.archive/servers/truenas');
    skill(root, '.hub/quarantine/pdf');
    expect(await skillFolders(root)).toEqual(['mine', 'servers/proxmox']);
  });

  it('switches off in a turn what the person switched off', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-hs-'));
    const dir = hermesSkillsDir(root);
    skill(dir, 'productivity/notion');
    mkdirSync(join(dir, '.whombat'), { recursive: true });
    writeFileSync(
      join(dir, '.whombat', 'skills.json'),
      JSON.stringify({ v: 2, off: ['notion', 'codex'], defaults: ['codex'], skills: {} }),
    );
    expect(await disabledSkills(dir)).toEqual(['codex', 'notion']);
    expect(await disabledSkills(join(root, 'none'))).toEqual([]);
    const config = hermesConfig({
      runtime: 'claude_directsdk',
      model: null,
      effort: null,
      disabledSkills: ['codex'],
    });
    expect(config.skills).toMatchObject({ disabled: ['codex'] });
  });

  it('reads only the bookkeeping it knows: an earlier version switches nothing off', () => {
    expect(parseSkillsState({ v: 1, skills: { 'a/b': { origin: 'shipped' } }, removed: [] })).toEqual({
      v: 2,
      off: [],
      defaults: [],
      skills: {},
    });
    expect(
      parseSkillsState({
        v: 2,
        off: ['b', 'a', 'a', 3],
        defaults: [],
        skills: { 'x/y': { added: { by: 'acc_1', at: '2026-10-24T00:00:00.000Z' }, changed: 'no' } },
      }),
    ).toEqual({
      v: 2,
      off: ['a', 'b'],
      defaults: [],
      skills: { 'x/y': { added: { by: 'acc_1', at: '2026-10-24T00:00:00.000Z' }, changed: null } },
    });
    expect(skillNameOf("---\nname: 'pdf'\n---\n", 'other')).toBe('pdf');
    expect(skillNameOf('# no front matter', 'folder')).toBe('folder');
  });
});
