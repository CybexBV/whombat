/** Files rules without a database (docs/decisions/files-space.md FS-03, FS-05, FS-06, FS-14…FS-17). */
import { describe, expect, it } from 'vitest';
import {
  canonicalFolder,
  canRenameFile,
  canTidyFile,
  decodeFilesCursor,
  encodeFilesCursor,
  messageFileInFiles,
  removalOf,
} from './space';

const mara = { id: 'p_mara', kind: 'person' as const };
const agent = { id: 'a_dusty', kind: 'agent' as const };
const filed = { uploadedById: 'a_dusty', messageId: null, filedAt: new Date('2026-10-05T10:00:00Z') };
const sent = { uploadedById: 'a_dusty', messageId: 'm_1', filedAt: null };

describe('who may change a file (FS-05; one-person.md OP-S07)', () => {
  it('lets the person move and remove any file, in a room or their chat', () => {
    expect(canTidyFile(filed, 'branch', mara)).toBe(true);
    expect(canTidyFile(filed, 'dm', mara)).toBe(true);
    expect(canTidyFile(sent, 'dm', mara)).toBe(true);
  });

  it('never lets an agent tidy, even its own upload', () => {
    expect(canTidyFile(filed, 'dm', agent)).toBe(false);
    expect(canRenameFile(filed, 'dm', agent)).toBe(false);
  });

  it('renames only files saved straight into Files', () => {
    expect(canRenameFile(filed, 'branch', mara)).toBe(true);
    expect(canRenameFile(sent, 'branch', mara)).toBe(false);
    // Saved into Files, then sent on a message: it keeps the name it was sent with.
    expect(canRenameFile({ ...filed, messageId: 'm_2' }, 'dm', mara)).toBe(false);
  });

  it('deletes a file only in Files and unlists a message’s file (FS-06); un-saves an agent’s (FS-17)', () => {
    expect(removalOf(filed)).toBe('delete');
    expect(removalOf(sent)).toBe('unlist');
    expect(removalOf(sent, 'person')).toBe('unlist');
    expect(removalOf(sent, 'agent')).toBe('unsave');
    expect(removalOf(filed, 'agent')).toBe('delete');
  });
});

describe('a message’s file in Files (FS-14)', () => {
  const file = { state: 'ready' as const, conversationId: 'c_1', filesRemovedAt: null, filedAt: null };

  it('is in Files when a person sent it, an agent’s only once saved', () => {
    expect(messageFileInFiles(file, 'person')).toBe(true);
    expect(messageFileInFiles(file, 'agent')).toBe(false);
    expect(messageFileInFiles({ ...file, filedAt: new Date() }, 'agent')).toBe(true);
    // The uploader is gone: only a save keeps it in Files.
    expect(messageFileInFiles(file, null)).toBe(false);
  });

  it('is not once removed from Files, or before it is ready', () => {
    expect(messageFileInFiles({ ...file, filesRemovedAt: new Date() }, 'person')).toBe(false);
    expect(messageFileInFiles({ ...file, filedAt: new Date(), filesRemovedAt: new Date() }, 'agent')).toBe(
      false,
    );
    expect(messageFileInFiles({ ...file, state: 'reserved' }, 'person')).toBe(false);
    expect(messageFileInFiles({ ...file, conversationId: null }, 'person')).toBe(false);
  });
});

describe('folder spelling (FS-03)', () => {
  it('keeps the spelling of folders already there, part by part', () => {
    const existing = ['Drawings', 'Drawings/Pool', 'photos'];
    expect(canonicalFolder('drawings', existing)).toBe('Drawings');
    expect(canonicalFolder('DRAWINGS/pool', existing)).toBe('Drawings/Pool');
    expect(canonicalFolder('drawings/New', existing)).toBe('Drawings/New');
    expect(canonicalFolder('Photos/2026', existing)).toBe('photos/2026');
    expect(canonicalFolder('Other', existing)).toBe('Other');
    expect(canonicalFolder('', existing)).toBe('');
  });

  it('matches a deeper part only under the same parent', () => {
    expect(canonicalFolder('b/pool', ['A/Pool', 'B'])).toBe('B/pool');
  });
});

describe('listing cursors', () => {
  it('round-trips and refuses anything else', () => {
    const c = { at: new Date('2026-10-05T10:00:00.123Z'), id: 'att_123' };
    expect(decodeFilesCursor(encodeFilesCursor(c))).toEqual(c);
    expect(decodeFilesCursor('nonsense')).toBeNull();
    expect(decodeFilesCursor(Buffer.from('x|att_1').toString('base64url'))).toBeNull();
    expect(decodeFilesCursor(Buffer.from('2026-10-05T10:00:00Z|a b').toString('base64url'))).toBeNull();
  });
});
