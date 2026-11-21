/**
 * The runner's Hermes-home service (contracts 0.125, CT-1220; since 2.0 the skills steps on Hermes's own skills, hub and
 * guard, CT-1420…CT-1429; since 3.0 the person's profile only, CT-1576…CT-1580; Whombat hermes-engine.md HE-38,
 * hermes-skills.md HSK-02…HSK-10, one-person.md OP-08, OP-17).
 */
import { describe, expect, it } from 'vitest';
import { MEMORY_ENTRY_SEPARATOR, MEMORY_FILE_LIMITS } from '../domain/memory.js';
import * as hermesHome from './hermes-home.js';
import {
  HERMES_HOME_METHODS,
  HERMES_HOME_PROFILES,
  HERMES_HOMES,
  HERMES_MEMORY_DELIMITER,
  HERMES_MEMORY_LIMITS,
  HERMES_SESSIONS_LIST_MAX,
  HermesHomeAnswer,
  HermesHomeErrorCode,
  HermesHomeRef,
  HermesHomeRequest,
  HermesSessionListing,
  HermesSkillPath,
  HermesSkillSummary,
  SKILLS_METHODS,
} from './hermes-home.js';
import { ALL_ENDPOINTS, runnerApi } from './index.js';

describe('the Hermes-home service', () => {
  it('is polled and answered by the runner', () => {
    expect(runnerApi.hermesPoll).toMatchObject({ id: 'hermes.poll', method: 'POST', path: '/hermes/poll' });
    expect(runnerApi.hermesAnswer).toMatchObject({ id: 'hermes.answer', path: '/hermes/answer' });
    expect(runnerApi.hermesPoll.base).toBe('/internal/runner');
    expect(runnerApi.hermesPoll.auth).toBe('runner');
    const ids = ALL_ENDPOINTS.map((e) => e.id);
    expect(ids).toContain('hermes.poll');
    expect(ids).toContain('hermes.answer');
  });

  it('runs memory, session, archive and skill steps', () => {
    for (const method of [
      'memory.read',
      'sessions.delete',
      'sessions.list',
      'home.exportBegin',
      'skills.list',
    ])
      expect(method in HERMES_HOME_METHODS, method).toBe(true);
    const params = HERMES_HOME_METHODS['memory.write'].params.parse({
      file: 'user',
      entries: ['Prefers short answers.'],
    });
    expect(params.file).toBe('user');
    expect(
      HERMES_HOME_METHODS['sessions.delete'].params.safeParse({ home: 'person', sessions: [] }).success,
    ).toBe(false);
    expect(HermesHomeRequest.safeParse({ id: 'r1', method: 'memory.read', params: {} }).success).toBe(true);
    expect(HermesHomeRequest.safeParse({ id: 'r1', method: 'memory.list', params: {} }).success).toBe(false);
    expect(
      HermesHomeAnswer.parse({ id: 'r1', ok: false, code: 'busy', error: 'A turn holds it.' }),
    ).toMatchObject({ code: 'busy' });
  });

  it('names the two homes, and only the session steps take one (CT-1576, CT-1577)', () => {
    expect(HERMES_HOMES).toEqual(['person', 'outside']);
    expect(HERMES_HOME_PROFILES).toEqual({ person: 'default', outside: '_feedback' });
    const withHome = ['sessions.delete', 'sessions.pending', 'sessions.list'];
    for (const [method, step] of Object.entries(HERMES_HOME_METHODS)) {
      const keys = Object.keys((step.params as unknown as { shape: Record<string, unknown> }).shape);
      expect(keys, method).not.toContain('account');
      expect(keys, method).not.toContain('profile');
      expect(keys, method).not.toContain('scope');
      if (!method.startsWith('home.')) expect(keys.includes('home'), method).toBe(withHome.includes(method));
    }
    for (const name of ['HermesProfileRef', 'HermesSkillScope']) expect(name in hermesHome, name).toBe(false);
  });

  it('archives the profile and its skills folder apart (CT-1578)', () => {
    expect(HermesHomeRef.parse({ kind: 'profile', home: 'person' })).toEqual({
      kind: 'profile',
      home: 'person',
    });
    expect(HermesHomeRef.parse({ kind: 'profile', home: 'outside' }).kind).toBe('profile');
    expect(HermesHomeRef.parse({ kind: 'skills' })).toEqual({ kind: 'skills' });
    expect(HermesHomeRef.safeParse({ kind: 'profile' }).success).toBe(false);
    expect(HermesHomeRef.safeParse({ kind: 'profile', home: 'acc_mara' }).success).toBe(false);
  });

  it('lists one list of skills, three origins (CT-1579)', () => {
    const list = SKILLS_METHODS['skills.list'].result;
    expect(Object.keys(list.shape).sort()).toEqual(['categories', 'skills']);
    expect(HermesSkillSummary.shape.origin.options).toEqual(['builtin', 'hub', 'learned']);
    for (const key of ['scope', 'overrides']) expect(key in HermesSkillSummary.shape, key).toBe(false);
  });

  it('runs Hermes’s own skills steps, and no import put or share (CT-1420…CT-1426, CT-1579)', () => {
    expect(Object.keys(SKILLS_METHODS).sort()).toEqual([
      'skills.export',
      'skills.hubCheck',
      'skills.hubInspect',
      'skills.hubInstall',
      'skills.hubSearch',
      'skills.hubUninstall',
      'skills.hubUpdate',
      'skills.list',
      'skills.read',
      'skills.readFile',
      'skills.remove',
      'skills.restore',
      'skills.scan',
      'skills.setOff',
      'skills.sync',
      'skills.write',
    ]);
    expect(HermesHomeErrorCode.options).toEqual(
      expect.arrayContaining(['unavailable', 'blocked', 'conflict', 'not_found']),
    );
    for (const path of ['pdf', 'productivity/notion', 'mlops/training/axolotl'])
      expect(HermesSkillPath.safeParse(path).success, path).toBe(true);
    for (const path of ['a/b/c/d', '../x', 'a//b'])
      expect(HermesSkillPath.safeParse(path).success, path).toBe(false);
  });

  it('lists a hub skill with Hermes’s lock entry and its front-matter needs', () => {
    const summary = HermesSkillSummary.parse({
      path: 'productivity/pdf',
      name: 'pdf',
      description: 'PDFs.',
      version: '0123456789abcdef',
      updatedAt: '2026-10-24T08:00:00.000Z',
      files: 2,
      bytes: 4096,
      state: 'on',
      origin: 'hub',
      added: { by: 'acc_mara', at: '2026-10-24T08:00:00.000Z' },
      hub: {
        source: 'github',
        identifier: 'anthropics/skills/skills/pdf',
        trust: 'trusted',
        verdict: 'safe',
        installedAt: '2026-10-24T08:00:00.000Z',
        updatedAt: '2026-10-24T08:00:00.000Z',
      },
      changed: null,
      originalChanged: false,
      needs: { commands: ['qpdf'] },
    });
    expect(summary.needs).toEqual({ env: [], commands: ['qpdf'], files: [] });
    expect(HermesSkillSummary.safeParse({ ...summary, origin: 'imported' }).success).toBe(false);
    expect('requires' in HermesSkillSummary.shape).toBe(false);
  });

  it('reports a sync by name, and a scan with Hermes’s own decision', () => {
    const synced = SKILLS_METHODS['skills.sync'].result.parse({
      added: ['notion'],
      updated: [],
      kept: ['pdf'],
      removed: [],
    });
    expect(synced.kept).toEqual(['pdf']);
    const scan = SKILLS_METHODS['skills.scan'].result.parse({
      trust: 'agent-created',
      verdict: 'dangerous',
      findings: [],
      findingsTotal: 3,
      decision: 'ask',
    });
    expect(scan.decision).toBe('ask');
    expect(
      SKILLS_METHODS['skills.hubSearch'].params.safeParse({ query: '', source: 'clawhub', limit: 20 })
        .success,
    ).toBe(false);
    expect(
      SKILLS_METHODS['skills.hubInstall'].params.safeParse({
        identifier: 'official/email/agentmail',
        by: null,
      }).success,
    ).toBe(true);
  });

  it('lists a home’s conversations for a prune, bounded under the answer route (CT-1453)', () => {
    const step = HERMES_HOME_METHODS['sessions.list'];
    expect(step.params.parse({ home: 'outside' })).toEqual({ home: 'outside' });
    expect(step.params.safeParse({}).success).toBe(false);
    expect(
      HermesHomeRequest.safeParse({ id: 'r1', method: 'sessions.list', params: { home: 'person' } }).success,
    ).toBe(true);

    const listing = {
      id: '20261025_101500_ab12cd',
      source: 'acp',
      lastActiveAt: '2026-10-25T10:15:00.000Z',
    };
    const result = step.result.parse({ sessions: [listing], more: false });
    expect(result.sessions[0]).toEqual(listing);
    expect(step.result.safeParse({ sessions: [listing] }).success).toBe(false);
    expect(HermesSessionListing.safeParse({ ...listing, id: 'not/an id' }).success).toBe(false);
    expect(HermesSessionListing.safeParse({ ...listing, lastActiveAt: 'yesterday' }).success).toBe(false);
    expect(HermesSessionListing.safeParse({ ...listing, source: '' }).success).toBe(false);

    const many = (n: number) => Array.from({ length: n }, () => listing);
    expect(step.result.safeParse({ sessions: many(HERMES_SESSIONS_LIST_MAX), more: true }).success).toBe(
      true,
    );
    expect(step.result.safeParse({ sessions: many(HERMES_SESSIONS_LIST_MAX + 1), more: true }).success).toBe(
      false,
    );
    // The longest answer stays well under the 2 MiB the runner's answer route takes.
    const longest = { id: 'a'.repeat(128), source: 's'.repeat(40), lastActiveAt: '2026-10-25T10:15:00.000Z' };
    const answer = JSON.stringify({
      id: 'r1',
      ok: true,
      result: { sessions: many(HERMES_SESSIONS_LIST_MAX).map(() => longest), more: true },
    });
    expect(answer.length).toBeLessThan(1.5 * 1024 * 1024);
  });

  it('agrees with the memory people see on Hermes’s separator and limits', () => {
    expect(HERMES_MEMORY_DELIMITER).toBe(MEMORY_ENTRY_SEPARATOR);
    expect(HERMES_MEMORY_LIMITS).toEqual(MEMORY_FILE_LIMITS);
  });
});
