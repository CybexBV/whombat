/**
 * Hermes's homes in a backup file (contracts 0.125, CT-1245; Whombat hermes-engine.md HE-38…HE-41): `memories` holds
 * each home as an archive and the agent's notes, `skills` the shared skills as one archive; schema version 5, and an
 * older file still parses with its old memory and skill records left out as unreadable.
 */
import { describe, expect, it } from 'vitest';
import {
  BACKUP_COUNTED_TYPES,
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  backupRecordCount,
  parseBackupFileManifest,
  parseBackupRecord,
} from './index.js';

const sha = (c: string) => c.repeat(64).slice(0, 64);

describe('Hermes homes in a backup file (CT-1245)', () => {
  it('is schema version 6 (3.0: one person, CT-1512)', () => {
    expect(BACKUP_SCHEMA_VERSION).toBe(6);
  });

  it('holds a home each for the person and the outside turns, and the skills, counted by home and by skill', () => {
    for (const home of ['person', 'outside'])
      expect(
        parseBackupRecord('memories', {
          type: 'hermes_home',
          home,
          archive: { sha256: sha('a'), size: 10, files: 2 },
        }).ok,
        home,
      ).toBe(true);
    const old = parseBackupRecord('memories', {
      type: 'hermes_home',
      person: 'prn_mara',
      archive: { sha256: sha('a'), size: 10, files: 2 },
    });
    expect(old.ok).toBe(false);
    const skills = { type: 'hermes_skills', skills: 23, archive: { sha256: sha('c'), size: 9, files: 40 } };
    expect(parseBackupRecord('skills', skills).ok).toBe(true);
    expect(backupRecordCount('skills', skills)).toBe(23);
    expect(backupRecordCount('memories', { type: 'agent_notes' })).toBe(0);
    expect(BACKUP_COUNTED_TYPES.memories).toEqual(['hermes_home']);
  });

  it('leaves the old memory and skill records out as unreadable, and keeps the notes bounded', () => {
    expect(parseBackupRecord('memories', { type: 'memory', id: 'mem_x' }).ok).toBe(false);
    expect(parseBackupRecord('memories', { type: 'profile', id: 'pfe_x' }).ok).toBe(false);
    expect(parseBackupRecord('skills', { type: 'skill', id: 'skl_x' }).ok).toBe(false);
    expect(parseBackupRecord('skills', { type: 'learned_skill', id: 'skp_x' }).ok).toBe(false);
    const notes = (text: string) =>
      parseBackupRecord('memories', { type: 'agent_notes', text, updatedAt: '2026-10-23T10:00:00Z' }).ok;
    expect(notes('x'.repeat(1500))).toBe(true);
    expect(notes('x'.repeat(1501))).toBe(false);
  });

  it('reads a version 4 file and refuses a newer one', () => {
    const manifest = (schemaVersion: number) => ({
      format: BACKUP_FORMAT,
      schemaVersion,
      createdAt: '2026-10-23T10:00:00Z',
      timeZone: 'Europe/Amsterdam',
      whombatVersion: '0.141.0',
      source: { burrowId: 'bur_lumio', name: 'Lumio BV', slug: 'lumio-bv' },
      madeBy: { name: 'Mara Oost', email: 'mara@lumio.example' },
      categories: [{ id: 'memories', count: 3, bytes: 10 }],
      includesSecrets: false,
    });
    const code = (v: unknown) => {
      try {
        parseBackupFileManifest(v);
        return 'ok';
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    expect(code(manifest(BACKUP_SCHEMA_VERSION + 1))).toBe('newer_format');
    expect(code(manifest(4))).toBe('ok');
  });
});
