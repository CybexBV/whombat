import { describe, expect, it } from 'vitest';
import { describeActivity } from '../domain/activity.js';
import { Attachment } from '../domain/message.js';
import {
  ALL_ENDPOINTS,
  api,
  DEFAULT_UPLOAD_MAX_BYTES,
  DispatchContext,
  DispatchFiles,
  FILES_DISPATCH_MAX,
  FileEntry,
  FilesFolder,
  filesFolderKey,
  MCP_TOOLS,
  normalizeFilesFolder,
  REALTIME_EVENT_TOPICS,
  RealtimeEvent,
  SaveFileBody,
  sameFilesFolder,
  UpdateFileBody,
} from './index.js';

const SHA = 'a'.repeat(64);
const ref = (n: number) => ({
  id: `att_file${String(n).padStart(8, '0')}`,
  name: `f${n}.skp`,
  contentType: 'application/octet-stream',
  size: 1,
  kind: 'file' as const,
  sha256: SHA,
  folder: 'Drawings',
  messageId: null,
  addedAt: '2026-10-05T10:00:00Z',
});

describe('Files folders (FS-03)', () => {
  it('normalizes what people type', () => {
    expect(normalizeFilesFolder('')).toBe('');
    expect(normalizeFilesFolder('  ')).toBe('');
    expect(normalizeFilesFolder('/')).toBe('');
    expect(normalizeFilesFolder('Drawings')).toBe('Drawings');
    expect(normalizeFilesFolder('/Drawings/')).toBe('Drawings');
    expect(normalizeFilesFolder(' Drawings // 2024 ')).toBe('Drawings/2024');
    expect(normalizeFilesFolder('Pool   plans\t2024')).toBe('Pool plans 2024');
    expect(normalizeFilesFolder('.hidden/a')).toBe('hidden/a');
    expect(normalizeFilesFolder('. .x')).toBe('x');
    expect(normalizeFilesFolder('a‮b/c\u0000d')).toBe('ab/cd');
    expect(normalizeFilesFolder('Café')).toBe('Café');
    expect(normalizeFilesFolder('A/B/C/D')).toBe('A/B/C/D');
    expect(normalizeFilesFolder('Drawings/Pool')).toBe('Drawings/Pool');
  });

  it('refuses what can’t be a folder', () => {
    expect(normalizeFilesFolder('.')).toBeNull();
    expect(normalizeFilesFolder('..')).toBeNull();
    expect(normalizeFilesFolder('a/../b')).toBeNull();
    expect(normalizeFilesFolder('a/./b')).toBeNull();
    expect(normalizeFilesFolder('...')).toBeNull();
    expect(normalizeFilesFolder('a\\b')).toBeNull();
    expect(normalizeFilesFolder('​')).toBeNull();
    expect(normalizeFilesFolder('A/B/C/D/E')).toBeNull();
    expect(normalizeFilesFolder('x'.repeat(65))).toBeNull();
    expect(normalizeFilesFolder('x'.repeat(64))).toBe('x'.repeat(64));
  });

  it('is idempotent, and the schema takes exactly the normalized folders', () => {
    for (const raw of ['', ' a / b ', '. .x/y', 'Café', 'A/B/C/D', 'é'.repeat(64)]) {
      const once = normalizeFilesFolder(raw);
      expect(once).not.toBeNull();
      expect(normalizeFilesFolder(once as string)).toBe(once);
      expect(FilesFolder.safeParse(once).success).toBe(true);
    }
    for (const bad of ['/a', 'a/', 'a//b', ' a', '..', 'A/B/C/D/E', '.x']) {
      expect(FilesFolder.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('compares case-insensitively and keeps the case', () => {
    expect(normalizeFilesFolder('Drawings/POOL')).toBe('Drawings/POOL');
    expect(sameFilesFolder('Drawings/Pool', 'drawings/pool')).toBe(true);
    expect(sameFilesFolder('Drawings', 'Drawings/Pool')).toBe(false);
    expect(filesFolderKey('Ä/B')).toBe('ä/b');
  });
});

describe('Files contracts (CT-274…CT-279)', () => {
  it('registers the five operations', () => {
    expect(Object.values(api.files).map((e) => e.id)).toEqual([
      'files.summary',
      'files.list',
      'files.save',
      'files.update',
      'files.remove',
    ]);
    expect(ALL_ENDPOINTS).toEqual(expect.arrayContaining(Object.values(api.files)));
    expect(api.files.list.query.parse({})).toEqual({ limit: 100 });
    expect(api.files.list.query.safeParse({ limit: '201' }).success).toBe(false);
    expect(api.files.save.body.parse({ attachmentId: 'att_abcdefghijkl' })).toEqual({
      attachmentId: 'att_abcdefghijkl',
      folder: '',
    });
    expect(UpdateFileBody.safeParse({}).success).toBe(false);
    expect(UpdateFileBody.safeParse({ folder: '' }).success).toBe(true);
    expect(UpdateFileBody.safeParse({ name: 'pool.skp' }).success).toBe(true);
    expect(UpdateFileBody.safeParse({ folder: 'a/' }).success).toBe(false);
  });

  it('describes a file as the viewer may act on it', () => {
    const entry = FileEntry.parse({
      attachment: {
        id: 'att_abcdefghijkl',
        name: '1904Technischmodel.skp',
        contentType: 'application/octet-stream',
        size: 142_606_336,
        url: '/api/v1/burrows/hq/attachments/att_abcdefghijkl',
      },
      conversationId: 'cnv_private',
      folder: '',
      uploadedById: 'prn_john',
      addedAt: '2026-10-05T10:00:00Z',
      messageId: 'msg_abcdefghijkl',
      threadRootId: null,
    });
    expect(entry.attachment.kind).toBe('file');
  });

  it('tells members that a conversation’s Files changed, on their own topic', () => {
    const ev = RealtimeEvent.parse({ type: 'files.changed', conversationId: 'cnv_private' });
    expect(ev.type).toBe('files.changed');
    expect(REALTIME_EVENT_TOPICS['files.changed']).toEqual(['me']);
  });

  it('gives a dispatch its conversation’s Files, null for none', () => {
    const files = DispatchFiles.parse({
      conversationId: 'cnv_private',
      count: 1,
      totalBytes: 1,
      truncated: false,
      entries: [ref(1)],
    });
    expect(files.entries[0]?.folder).toBe('Drawings');
    expect(
      DispatchFiles.safeParse({
        ...files,
        entries: Array.from({ length: FILES_DISPATCH_MAX + 1 }, (_, i) => ref(i)),
      }).success,
    ).toBe(false);
    expect(DispatchContext.shape.files.safeParse(undefined).success).toBe(false);
    expect(DispatchContext.shape.files.safeParse(null).success).toBe(true);
  });

  it('lets agents list files; only people save into Files (FS-11, CT-312)', () => {
    expect(MCP_TOOLS.list_files.readOnly).toBe(true);
    expect(MCP_TOOLS.list_files.input.parse({})).toEqual({});
    expect(MCP_TOOLS.list_files.input.safeParse({ folder: '../x' }).success).toBe(false);
    // An older caller's `saveToFiles` and `folder` are dropped, not refused.
    const upload = MCP_TOOLS.upload_file.input.parse({
      conversationId: 'cnv_private',
      name: 'pool.obj',
      text: 'v 0 0 0',
      saveToFiles: true,
      folder: 'Exports',
    });
    expect(upload).toEqual({ conversationId: 'cnv_private', name: 'pool.obj', text: 'v 0 0 0' });
    expect(MCP_TOOLS.upload_file.description).toContain('Save to Files');
    const row = {
      kind: 'whombat',
      tool: 'whombat.list_files',
      object: null,
      exitCode: null,
      failure: null,
      keyNeeded: null,
    } as const;
    expect(describeActivity({ ...row, status: 'running' }).title).toBe('Listing files');
    expect(describeActivity({ ...row, status: 'done' })).toMatchObject({
      title: 'Listed files',
      important: false,
    });
  });

  it('allows 250 MiB uploads by default (FS-13)', () => {
    expect(DEFAULT_UPLOAD_MAX_BYTES).toBe(250 * 1024 * 1024);
  });

  it('says whether a message’s file is in Files, absent from older servers (CT-312)', () => {
    const file = {
      id: 'att_abcdefghijkl',
      name: 'render.png',
      contentType: 'image/png',
      size: 2048,
      url: '/api/v1/burrows/hq/attachments/att_abcdefghijkl',
      kind: 'image' as const,
    };
    expect(Attachment.parse(file).inFiles).toBeUndefined();
    expect(Attachment.parse({ ...file, inFiles: false }).inFiles).toBe(false);
    expect(SaveFileBody.parse({ attachmentId: file.id })).toEqual({ attachmentId: file.id, folder: '' });
    expect(api.files.save.method).toBe('POST');
  });
});
