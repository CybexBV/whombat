/**
 * Skills on Hermes (contracts 0.125, CT-1210…CT-1216; since 2.0 Hermes's own skills, hub and guard, CT-1410…CT-1419;
 * since 3.0 one list, CT-1570…CT-1573; Whombat hermes-engine.md HE-41, hermes-skills.md HSK-05…HSK-13): the paths and
 * bodies you edit, Settings → Skills's one list and three origins, and Hermes's hub.
 */
import { describe, expect, it } from 'vitest';
import * as contracts from '../contracts/index.js';
import {
  api,
  LibrarySkillResponse,
  MCP_TOOLS,
  SKILL_STATUSES,
  SkillCan,
  SkillEditBody,
  SkillHubPreview,
  SkillHubResult,
  SkillHubSearchQuery,
  SkillHubSearchResponse,
  SkillHubUpdatesResponse,
  SkillLibraryItem,
  SkillLibraryResponse,
  SkillRefQuery,
} from '../contracts/index.js';
import { utf8ByteLength } from '../domain/signins.js';
import * as ids from '../ids.js';
import { KEY_CATALOG } from '../keys/catalog.js';
import { SKILL_LIMITS } from '../skills/files.js';
import { SKILL_ORIGINS, SkillName } from '../skills/skill.js';
import { CARD_KINDS } from './cards.js';
import { Message } from './message.js';
import {
  LibrarySkillBody,
  SKILL_FILE_DIRS,
  SkillDescription,
  SkillFilePath,
  skillFileDirProblem,
} from './skills.js';

const AT = '2026-10-23T10:00:00.000Z';
const CAN_NONE = { edit: false, switch: false, remove: false, restore: false, update: false };

const item: SkillLibraryItem = {
  name: 'grafana-billing-report',
  description: 'Writes the weekly billing report.',
  category: 'productivity',
  origin: 'learned',
  hub: null,
  enabled: true,
  changed: false,
  originalChanged: false,
  status: 'on',
  needs: { env: [{ name: 'GRAFANA_TOKEN', optional: false }], commands: ['curl'], files: [] },
  version: '7a0f3c5e9d2b1186',
  updatedAt: AT,
  can: { ...CAN_NONE, edit: true, switch: true, remove: true },
};

const hubItem: SkillLibraryItem = {
  ...item,
  name: 'pdf',
  description: 'Reads and fills PDF forms.',
  category: 'documents',
  origin: 'hub',
  hub: {
    source: 'github',
    identifier: 'anthropics/skills/skills/pdf',
    trust: 'trusted',
    updateAvailable: true,
  },
  needs: { env: [], commands: [], files: [] },
  can: { ...CAN_NONE, edit: true, switch: true, remove: true, update: true },
};

const result: SkillHubResult = {
  source: 'skills-sh',
  identifier: 'skills-sh/vercel-labs/agent-skills/web-design',
  name: 'web-design',
  description: 'Reviews a web page’s design.',
  trust: 'community',
  repo: 'vercel-labs/agent-skills',
  path: 'skills/web-design',
  installs: 1200,
  installed: false,
};

describe('a skill’s name, description, body and files (CT-1213)', () => {
  it('names skills as Hermes does: dots and underscores, never “..”', () => {
    for (const name of ['pdf', 'home-assistant', 'my_skill', 'v1.2', '0day'])
      expect(SkillName.safeParse(name).success, name).toBe(true);
    for (const name of ['', 'Upper', '-dash', '.hidden', 'a..b', 'a/b', 'x'.repeat(65)])
      expect(SkillName.safeParse(name).success, name).toBe(false);
  });

  it('keeps descriptions to Hermes’s 1,024 characters and bodies to the skill limit', () => {
    expect(SkillDescription.safeParse('x'.repeat(1024)).success).toBe(true);
    expect(SkillDescription.safeParse('x'.repeat(1025)).success).toBe(false);
    expect(LibrarySkillBody.safeParse('x'.repeat(SKILL_LIMITS.bodyBytes)).success).toBe(true);
    expect(LibrarySkillBody.safeParse('x'.repeat(SKILL_LIMITS.bodyBytes + 1)).success).toBe(false);
    expect(LibrarySkillBody.safeParse('é'.repeat(SKILL_LIMITS.bodyBytes / 2 + 1)).success).toBe(false);
    expect(LibrarySkillBody.safeParse('  ').success).toBe(false);
  });

  it('keeps files inside the skill, free of hooks, next to SKILL.md or in Hermes’s folders', () => {
    expect(SKILL_FILE_DIRS).toEqual(['references', 'templates', 'scripts', 'assets']);
    const ok = (path: string) => SkillFilePath.safeParse(path).success;
    for (const path of [
      'references/skills.md',
      'templates/SKILL-notes.md',
      'scripts/lib/util.py',
      'forms.md',
    ])
      expect(ok(path), path).toBe(true);
    for (const path of [
      '../escape.sh',
      'SKILL.md',
      'extra/SKILL.md',
      'hooks.json',
      '.claude-plugin/plugin.json',
      'docs/x.md',
      'references/2/3/4/5/6/x.md',
    ])
      expect(ok(path), path).toBe(false);
    expect(skillFileDirProblem('docs/x.md')).toContain('assets/');
    expect(skillFileDirProblem('x.md')).toBeNull();
  });
});

describe('Settings → Skills on Hermes’s skills (CT-1410…CT-1412)', () => {
  it('is on, off or removed; what a skill needs is a list, not a status', () => {
    expect(SKILL_STATUSES).toEqual(['on', 'off', 'removed']);
    expect(SkillLibraryItem.parse(item)).toEqual(item);
    for (const status of ['ready', 'needs_setup', 'hidden'])
      expect(SkillLibraryItem.safeParse({ ...item, status }).success, status).toBe(false);
    expect('missing' in SkillLibraryItem.shape).toBe(false);
    expect('source' in SkillLibraryItem.shape).toBe(false);
    expect('group' in SkillLibraryItem.shape).toBe(false);
  });

  it('is one list: three origins, no scope, nothing to share (CT-1570…CT-1572)', () => {
    expect(SKILL_ORIGINS).toEqual(['builtin', 'hub', 'learned']);
    expect(SkillLibraryItem.safeParse({ ...item, origin: 'shared' }).success).toBe(false);
    for (const key of ['scope', 'overrides', 'shareRequest'])
      expect(key in SkillLibraryItem.shape, key).toBe(false);
    expect('canAdd' in SkillLibraryResponse.shape).toBe(false);
    for (const name of [
      'SkillScope',
      'SKILL_SCOPES',
      'SkillShareBody',
      'SkillShareResponse',
      'SkillShareRequest',
    ])
      expect(name in contracts, name).toBe(false);
  });

  it('carries a hub skill’s source, identifier, trust and update', () => {
    expect(SkillLibraryItem.parse(hubItem).hub?.updateAvailable).toBe(true);
    expect(SkillLibraryItem.safeParse({ ...hubItem, origin: 'shipped' }).success).toBe(false);
    expect(
      SkillLibraryItem.safeParse({ ...hubItem, hub: { ...hubItem.hub, source: 'clawhub' } }).success,
    ).toBe(false);
    expect(Object.keys(SkillCan.shape)).toEqual(['edit', 'switch', 'remove', 'restore', 'update']);
  });

  it('describes Hermes’s categories with the library', () => {
    const library = SkillLibraryResponse.parse({
      agentName: 'Dusty',
      items: [item, hubItem],
      categories: [{ category: 'productivity', title: 'Productivity', description: 'Documents and notes.' }],
    });
    expect(library.categories[0]?.category).toBe('productivity');
  });

  it('names a skill by its name, and compares a changed built-in file by file', () => {
    expect(SkillRefQuery.parse({ name: 'pdf', scope: 'mine' })).toEqual({ name: 'pdf' });
    const read = LibrarySkillResponse.parse({
      item,
      text: '# x',
      files: [],
      original: { text: '# y', changes: [{ path: 'SKILL.md', status: 'modified' }] },
    });
    expect(read.original?.changes[0]?.status).toBe('modified');
    expect(
      LibrarySkillResponse.parse({ item, text: '# x', files: [], original: { text: '# y' } }).original
        ?.changes,
    ).toEqual([]);
  });

  it('serves these endpoints, and no imports, staging or link previews', () => {
    expect(Object.keys(api.skills).sort()).toEqual([
      'hubInstall',
      'hubPreview',
      'hubSearch',
      'hubUpdate',
      'hubUpdates',
      'library',
      'libraryEdit',
      'libraryRemove',
      'libraryRestore',
      'librarySkill',
      'librarySkillFile',
      'librarySwitch',
    ]);
    expect([api.skills.hubSearch.method, api.skills.hubPreview.method, api.skills.hubUpdates.method]).toEqual(
      ['GET', 'GET', 'GET'],
    );
    expect([api.skills.hubInstall.method, api.skills.hubUpdate.method]).toEqual(['POST', 'POST']);
    for (const name of [
      'SkillImportPreviewBody',
      'SkillImportPreview',
      'SkillImportCommitBody',
      'StagedArchiveId',
      'SKILL_HUBS',
      'SKILL_HUB_TRUST',
      'SKILL_IMPORT_MAX_BASE64',
    ])
      expect(name in contracts, name).toBe(false);
    expect('SkillImportId' in ids).toBe(false);
  });

  it('an edit may say which version it started from', () => {
    expect(SkillEditBody.parse({ name: 'pdf', body: '# PDF', ifVersion: 'abc' }).ifVersion).toBe('abc');
  });
});

describe('Hermes’s hub (CT-1413…CT-1415)', () => {
  it('browses without a query, searches with one, and narrows to one source', () => {
    expect(SkillHubSearchQuery.parse({})).toEqual({});
    expect(SkillHubSearchQuery.parse({ q: ' pdf ', source: 'official' })).toEqual({
      q: 'pdf',
      source: 'official',
    });
    expect(SkillHubSearchQuery.safeParse({ source: 'clawhub' }).success).toBe(false);
    const found = SkillHubSearchResponse.parse({ results: [result] });
    expect(found.unreachable).toEqual([]);
    expect(SkillHubResult.safeParse({ ...result, identifier: 'https://x/SKILL.md' }).success).toBe(false);
  });

  it('previews a skill with its scan and the policy’s decision', () => {
    const preview = SkillHubPreview.parse({
      result,
      text: '---\nname: web-design\n---\n# Web design\n',
      files: [{ path: 'SKILL.md', bytes: 40 }],
      needs: {},
      platforms: [],
      scan: {
        verdict: 'caution',
        findings: [
          {
            patternId: 'env_read',
            severity: 'high',
            category: 'credential_exposure',
            file: 'SKILL.md',
            line: 4,
            match: 'cat .env',
            description: 'reads .env',
          },
        ],
        findingsTotal: 1,
      },
      policy: { decision: 'block', reason: 'Hermes found something risky in it.' },
      nameTaken: false,
    });
    expect([preview.scan.verdict, preview.policy.decision]).toEqual(['caution', 'block']);
    expect(SkillHubPreview.safeParse({ ...preview, policy: { decision: 'ask', reason: 'x' } }).success).toBe(
      false,
    );
  });

  it('says when it last checked for updates and what it found', () => {
    const updates = SkillHubUpdatesResponse.parse({ checkedAt: AT, available: ['pdf'] });
    expect([updates.available, updates.unreachable]).toEqual([['pdf'], []]);
    expect(SkillHubUpdatesResponse.parse({ checkedAt: null, available: [] }).checkedAt).toBeNull();
  });

  it('answers one row for every change, small enough for one session message', () => {
    const big: SkillLibraryItem = {
      ...hubItem,
      name: 'x'.repeat(64),
      description: 'é'.repeat(2000),
      hub: { ...(hubItem.hub as NonNullable<SkillLibraryItem['hub']>), identifier: `o/${'x'.repeat(296)}` },
      needs: {
        env: Array.from({ length: 16 }, (_, i) => ({
          name: `${'V'.repeat(78)}${i}`.slice(0, 80),
          optional: false,
        })),
        commands: Array.from({ length: 16 }, () => 'c'.repeat(64)),
        files: Array.from({ length: 16 }, () => 'f'.repeat(200)),
      },
    };
    expect(SkillLibraryItem.safeParse(big).success).toBe(true);
    const answer = { kind: 'ok', output: { item: big } };
    expect(utf8ByteLength(JSON.stringify(answer))).toBeLessThan(16_384);
  });
});

describe('what went (CT-1216)', () => {
  it('no skill tools, card, hint or key', () => {
    for (const name of ['propose_skill', 'skill_write', 'read_skill', 'find_skill', 'skill_result'])
      expect(name in MCP_TOOLS, name).toBe(false);
    expect(CARD_KINDS as readonly string[]).not.toContain('skill');
    expect('skillHint' in Message.shape).toBe(false);
    expect('skills.propose' in KEY_CATALOG).toBe(false);
  });
});
