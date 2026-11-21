/**
 * Settings → Skills over the session (contracts 0.92.0, CT-415, CT-418; since 2.0 Hermes's skills, hub and guard,
 * CT-1418, CT-1430…CT-1432; since 3.0 one list without sharing, CT-1572).
 */
import { SkillLibraryItem } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { utf8ByteLength } from '../bytes.js';
import { SESSION_MAX_RESULT_BYTES } from '../limits.js';
import { APP_ERROR_CODES } from './errors.js';
import * as session from './index.js';
import { UploadTarget } from './messages.js';
import { operationSafety } from './operation-safety.js';
import { API_OPERATIONS, createOperationAllowlist, EXPORT_OPS, EXPORT_READ_OPS } from './operations.js';

describe('Settings → Skills over the session (CT-415, CT-418, CT-1431)', () => {
  it('carries the library’s ops and Hermes’s hub, and no imports or staging', () => {
    const allow = createOperationAllowlist();
    for (const op of [
      'skills.library',
      'skills.hubSearch',
      'skills.hubPreview',
      'skills.hubInstall',
      'skills.hubUpdates',
      'skills.hubUpdate',
    ])
      expect(allow.has(op), op).toBe(true);
    for (const op of [
      'skills.importPreview',
      'skills.importCommit',
      'skills.stage',
      'skills.libraryShare',
      'skills.shareRequest',
    ])
      expect(allow.has(op), op).toBe(false);
    expect(
      UploadTarget.safeParse({ type: 'skill-archive', burrow: 'b', stagedArchiveId: 'pst_12345678' }).success,
    ).toBe(false);
    for (const name of [
      'SkillsStageInput',
      'SkillStagedUploadOutput',
      'StagedArchiveId',
      'SKILL_ARCHIVE_MAX_BYTES',
    ])
      expect(name in session, name).toBe(false);
    expect(
      Object.keys(APP_ERROR_CODES)
        .filter((c) => c.startsWith('skill_'))
        .sort(),
    ).toEqual(['skill_blocked', 'skill_exists', 'skill_hub_unavailable']);
  });

  it('reads what can outgrow a CONTROL message through an export stream, and has no export ops (CT-1418)', () => {
    expect(EXPORT_OPS).toEqual([]);
    for (const op of EXPORT_READ_OPS) {
      const spec = API_OPERATIONS.get(op);
      expect([spec?.mutating, spec?.exportable, spec?.exportOp], op).toEqual([false, true, false]);
    }
    expect(EXPORT_READ_OPS).toEqual(
      expect.arrayContaining([
        'skills.library',
        'skills.librarySkill',
        'skills.hubSearch',
        'skills.hubPreview',
      ]),
    );
  });

  it('answers each change in one row, well inside one CONTROL message', () => {
    const at = '2026-10-24T10:00:00.000Z';
    const item = SkillLibraryItem.parse({
      name: 'x'.repeat(64),
      description: '€'.repeat(2000),
      category: 'c'.repeat(64),
      origin: 'hub',
      hub: { source: 'github', identifier: `o/${'x'.repeat(298)}`, trust: 'trusted', updateAvailable: true },
      enabled: true,
      changed: true,
      originalChanged: true,
      status: 'on',
      needs: {
        env: Array.from({ length: 16 }, (_, i) => ({ name: `V${'A'.repeat(76)}${i}`.slice(0, 80) })),
        commands: Array.from({ length: 16 }, () => 'c'.repeat(64)),
        files: Array.from({ length: 16 }, () => 'f'.repeat(200)),
      },
      version: '0123456789abcdef',
      updatedAt: at,
      can: { edit: true, switch: true, remove: true, restore: true, update: true },
    });
    for (const op of ['skills.libraryEdit', 'skills.hubInstall', 'skills.hubUpdate']) {
      const output = { item };
      expect(API_OPERATIONS.get(op)?.output.safeParse(output).success, op).toBe(true);
      const message = { t: 'result', id: 'req_0123456789abcdef', kind: 'ok', output };
      expect(utf8ByteLength(JSON.stringify(message)), op).toBeLessThan(SESSION_MAX_RESULT_BYTES / 2);
    }
  });

  it('never resends a removal, an install or an update by itself, and reads freely', () => {
    expect(operationSafety('skills.libraryRemove')).toMatchObject({ destructive: true });
    expect(operationSafety('skills.library')).toMatchObject({ destructive: false, retry: 'safe' });
    expect(operationSafety('skills.hubPreview')).toMatchObject({ retry: 'safe' });
    expect(operationSafety('skills.libraryEdit')).toMatchObject({ retry: 'receipt' });
    expect(operationSafety('skills.hubInstall')).toEqual({ destructive: false, retry: 'never' });
    expect(operationSafety('skills.hubUpdate')).toEqual({ destructive: false, retry: 'never' });
  });
});
