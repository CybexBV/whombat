import type { Attachment, Bootstrap, FileEntry } from '@whombat/core';
import { bootstrap as fixtureBootstrap } from '@whombat/fixtures';
import { describe, expect, it, vi } from 'vitest';
import {
  allFolders,
  childFolder,
  conversationFilesPath,
  existingFolderSpelling,
  type FilesUpload,
  fileMessageLink,
  fileOriginText,
  filesAtFolder,
  filesConversationId,
  filesConversationRows,
  filesCountText,
  filesPath,
  filesUploading,
  filesUploadStatusText,
  filesUploadsReducer,
  folderCrumbs,
  folderExists,
  folderNameProblem,
  folderPathProblem,
  inFilesLabel,
  pendingPlaces,
  removeFileText,
  SAVE_FAILED,
  saveActionOf,
  saveToFilesLabel,
  showsFiles,
  tooLargeText,
  uploadedText,
  uploadToFiles,
  withInFiles,
} from './files';
import type { WhombatClient } from './http/client';
import { ApiError } from './http/errors';
import { UploadError } from './uploads';

const att = (id: string, size = 1024, name = `${id}.pdf`): Attachment => ({
  id,
  name,
  contentType: 'application/pdf',
  size,
  url: `/api/v1/burrows/burrow-hq/attachments/${id}`,
  kind: 'document',
  width: null,
  height: null,
});

const entry = (id: string, folder: string, addedAt: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  attachment: att(id),
  conversationId: 'cnv_general',
  folder,
  uploadedById: 'prn_mara',
  addedAt,
  messageId: null,
  threadRootId: null,
  ...extra,
});

const files = [
  entry('att_a', '', '2026-10-05T09:00:00.000Z'),
  entry('att_b', 'Drawings', '2026-10-05T10:00:00.000Z'),
  entry('att_c', 'drawings/2024', '2026-10-05T08:00:00.000Z'),
  entry('att_d', 'Photos', '2026-10-04T08:00:00.000Z'),
  entry('att_e', '', '2026-10-05T11:00:00.000Z'),
];

describe('folders (FS-03)', () => {
  it('groups one folder: its folders by name first (with what is below them), then its files newest first', () => {
    const top = filesAtFolder(files, '');
    expect(top.folders.map((f) => [f.path, f.count, f.bytes, f.lastAddedAt])).toEqual([
      ['Drawings', 2, 2048, '2026-10-05T10:00:00.000Z'],
      ['Photos', 1, 1024, '2026-10-04T08:00:00.000Z'],
    ]);
    expect(top.files.map((f) => f.attachment.id)).toEqual(['att_e', 'att_a']);
  });

  it('compares folders case-insensitively, keeping the newest spelling', () => {
    const drawings = filesAtFolder(files, 'DRAWINGS');
    expect(drawings.files.map((f) => f.attachment.id)).toEqual(['att_b']);
    expect(drawings.folders).toEqual([
      {
        path: 'DRAWINGS/2024',
        name: '2024',
        count: 1,
        bytes: 1024,
        lastAddedAt: '2026-10-05T08:00:00.000Z',
        empty: false,
      },
    ]);
    expect(allFolders(files)).toEqual(['Drawings', 'Drawings/2024', 'Photos']);
  });

  it('shows a client’s new folder as an empty place until a file is in it', () => {
    const view = filesAtFolder(files, '', ['Contracts', 'drawings', 'Contracts/Signed']);
    expect(view.folders.map((f) => [f.name, f.empty])).toEqual([
      ['Contracts', true],
      ['Drawings', false],
      ['Photos', false],
    ]);
    expect(folderExists(files, 'Contracts/Signed', ['Contracts/Signed'])).toBe(true);
    expect(folderExists(files, 'Gone')).toBe(false);
    expect(pendingPlaces(files, ['Contracts', 'Drawings/2024', 'Photos/New'])).toEqual([
      'Contracts',
      'Photos/New',
    ]);
  });

  it('breadcrumbs lead down to the folder', () => {
    expect(folderCrumbs('')).toEqual([]);
    expect(folderCrumbs('Drawings/2024')).toEqual([
      { name: 'Drawings', path: 'Drawings' },
      { name: '2024', path: 'Drawings/2024' },
    ]);
  });

  it('says why a typed folder name can’t be one', () => {
    expect(folderNameProblem('', '')).toBe('Give the folder a name.');
    expect(folderNameProblem('a/b', '')).toMatch(/can’t hold a \//);
    expect(folderNameProblem('..', '')).toMatch(/can’t be called/);
    expect(folderNameProblem('x'.repeat(65), '')).toBe('A folder name is at most 64 characters.');
    expect(folderNameProblem('E', 'A/B/C/D')).toBe('Folders go at most 4 levels deep.');
    expect(folderNameProblem('  Drawings  ', '')).toBeNull();
    expect(childFolder('Drawings', ' 2025 ')).toBe('Drawings/2025');
    expect(folderPathProblem('/Drawings//2024/')).toBeNull();
    expect(folderPathProblem('A/B/C/D/E')).toBe('Folders go at most 4 levels deep.');
    expect(folderPathProblem('A/../B')).toMatch(/1–64 characters/);
  });

  it('takes over an existing folder’s spelling', () => {
    expect(existingFolderSpelling('drawings/2025', ['Drawings', 'Drawings/2024'])).toBe('Drawings/2025');
    expect(existingFolderSpelling('', ['Drawings'])).toBe('');
  });
});

describe('conversations with files (FS-07)', () => {
  const bootstrap: Bootstrap = fixtureBootstrap();
  const dm = bootstrap.sidebar.dms[0];
  const branch = bootstrap.sidebar.branchRooms[0];

  it('Files shows only while the viewer can see at least one file', () => {
    expect(showsFiles(undefined)).toBe(false);
    expect(showsFiles({ conversations: [] })).toBe(false);
    expect(
      showsFiles({
        conversations: [{ conversationId: 'c', count: 1, bytes: 9, lastAddedAt: '2026-10-05T09:00:00.000Z' }],
      }),
    ).toBe(true);
  });

  it('names the person’s rooms and branch rooms as the sidebar does, newest activity first', () => {
    if (!dm || !branch) throw new Error('fixture world changed');
    const rows = filesConversationRows(
      {
        conversations: [
          { conversationId: branch.id, count: 12, bytes: 4096, lastAddedAt: '2026-10-04T09:00:00.000Z' },
          { conversationId: dm.id, count: 1, bytes: 10, lastAddedAt: '2026-10-05T09:00:00.000Z' },
          { conversationId: 'cnv_archived', count: 2, bytes: 10, lastAddedAt: '2026-10-01T09:00:00.000Z' },
        ],
      },
      bootstrap,
    );
    expect(rows.map((r) => [r.kind, r.label])).toEqual([
      ['dm', dm.title],
      ['branch', branch.title],
      ['unknown', ''],
    ]);
    expect(filesPath(rows[0]?.link ?? { type: 'dm' })).toBe('/files/dm/chat');
  });

  it('reads a Files address back to its conversation', () => {
    if (!dm || !branch) throw new Error('fixture world changed');
    expect(filesConversationId({ type: 'dm', room: 'chat' }, bootstrap)).toBe(dm.id);
    expect(filesConversationId({ type: 'direct', id: 'cnv_x' }, bootstrap)).toBe('cnv_x');
    expect(filesConversationId({ type: 'pr', number: 99_999 }, bootstrap)).toBeNull();
    expect(filesPath({ type: 'pr', number: 4, repo: 'a/b' })).toBe('/files/pr/4?repo=a%2Fb');
    expect(filesPath({ type: 'dm', room: 'feedback' })).toBe('/files/dm/feedback');
  });

  it('opens a message’s file at its message, or its thread for a reply', () => {
    const where = { type: 'dm' as const, room: 'chat' as const };
    expect(fileMessageLink({ messageId: null, threadRootId: null }, where)).toBeNull();
    expect(fileMessageLink({ messageId: 'msg_1', threadRootId: null }, where)).toEqual({
      type: 'message',
      in: where,
      messageId: 'msg_1',
    });
    expect(fileMessageLink({ messageId: 'msg_2', threadRootId: 'msg_1' }, where)).toMatchObject({
      threadRootId: 'msg_1',
    });
  });

  it('words', () => {
    expect(filesCountText(1)).toBe('1 file');
    expect(filesCountText(12)).toBe('12 files');
    expect(fileOriginText({ messageId: 'msg_1' })).toBe('In a message');
    expect(fileOriginText({ messageId: null })).toBe('Saved to Files');
    expect(uploadedText(3, 'Drawings/2024')).toBe('Saved 3 files to 2024.');
    expect(uploadedText(1, '')).toBe('Saved 1 file to Files.');
    expect(removeFileText({ messageId: null }, '#private')).toMatch(/deleted from #private/);
    expect(removeFileText({ messageId: 'msg_1' }, '#private')).toMatch(/stays on its message/);
    expect(tooLargeText('model.skp', 250 * 1024 * 1024)).toBe(
      'model.skp is larger than 250 MB, the most this Whombat takes.',
    );
  });
});

describe('Save to Files on a message’s file (CT-312, AP-834)', () => {
  it('offers Save while the file isn’t in Files, In Files once it is, nothing outside a message', () => {
    expect(saveActionOf({ inFiles: false })).toBe('save');
    expect(saveActionOf({ inFiles: true })).toBe('saved');
    // A file outside a message (no `inFiles`): Download only.
    expect(saveActionOf({})).toBeNull();
  });

  it('names the buttons with the file', () => {
    expect(saveToFilesLabel('plan.pdf')).toBe('Save plan.pdf to Files');
    expect(inFilesLabel('plan.pdf')).toBe('plan.pdf is in Files. Open Files');
  });

  it('marks one file of a message, and leaves everything else as it was', () => {
    const message = {
      id: 'msg_1',
      attachments: [{ ...att('att_a'), inFiles: false }, { ...att('att_b'), inFiles: true }, att('att_c')],
    };
    const saved = withInFiles(message, 'att_a', true);
    expect(saved.attachments.map((a) => a.inFiles)).toEqual([true, true, undefined]);
    expect(saved.attachments[1]).toBe(message.attachments[1]);
    expect(message.attachments[0]?.inFiles).toBe(false);
    // Nothing to change: the same message (the cache keeps its references).
    expect(withInFiles(message, 'att_b', true)).toBe(message);
    expect(withInFiles(message, 'att_x', true)).toBe(message);
    // A file whose server doesn't say stays so.
    expect(withInFiles(message, 'att_c', true)).toBe(message);
    expect(withInFiles(saved, 'att_a', false).attachments[0]?.inFiles).toBe(false);
  });

  it('opens the conversation’s Files, or the list of them for a conversation the sidebar doesn’t list', () => {
    const bootstrap: Bootstrap = fixtureBootstrap();
    const branch = bootstrap.sidebar.branchRooms[0];
    const dm = bootstrap.sidebar.dms[0];
    if (!branch || !dm) throw new Error('fixture world changed');
    expect(conversationFilesPath(branch.id, bootstrap)).toMatch(/^\/files\/pr\//);
    expect(conversationFilesPath(dm.id, bootstrap)).toBe('/files/dm/chat');
    expect(conversationFilesPath('cnv_archived', bootstrap)).toBe('/files');
    expect(conversationFilesPath('cnv_x', undefined)).toBe('/files');
  });
});

describe('uploads into Files', () => {
  const item = { localId: 'l1', name: 'model.skp', size: 2048, folder: 'Drawings' };

  it('goes uploading → saving → saved, with progress and a status line', () => {
    let s: FilesUpload[] = filesUploadsReducer([], { type: 'add', item });
    s = filesUploadsReducer(s, { type: 'progress', localId: 'l1', progress: 0.42 });
    expect(filesUploadStatusText(s[0] as FilesUpload)).toBe('Uploading 42%');
    s = filesUploadsReducer(s, { type: 'uploaded', localId: 'l1', attachment: att('att_up', 2048) });
    expect(s[0]?.state).toBe('saving');
    expect(filesUploading(s)).toBe(true);
    // A late progress frame changes nothing once the bytes are there.
    s = filesUploadsReducer(s, { type: 'progress', localId: 'l1', progress: 0.5 });
    expect(s[0]?.progress).toBe(1);
    s = filesUploadsReducer(s, { type: 'saved', localId: 'l1' });
    expect(filesUploadStatusText(s[0] as FilesUpload)).toBe('Saved · 2 KB');
    expect(filesUploading(s)).toBe(false);
    expect(filesUploadsReducer(s, { type: 'clearSaved' })).toEqual([]);
  });

  it('a failed save retries only the save; a failed upload starts over; a refused file never starts', () => {
    let s = filesUploadsReducer([], { type: 'add', item });
    s = filesUploadsReducer(s, { type: 'uploaded', localId: 'l1', attachment: att('att_up') });
    s = filesUploadsReducer(s, { type: 'failed', localId: 'l1', error: SAVE_FAILED });
    s = filesUploadsReducer(s, { type: 'retry', localId: 'l1' });
    expect(s[0]).toMatchObject({ state: 'saving', error: null });
    let t = filesUploadsReducer([], { type: 'add', item });
    t = filesUploadsReducer(t, { type: 'failed', localId: 'l1', error: 'Network' });
    t = filesUploadsReducer(t, { type: 'retry', localId: 'l1' });
    expect(t[0]).toMatchObject({ state: 'uploading', progress: 0 });
    const r = filesUploadsReducer([], { type: 'refuse', item, error: 'too big' });
    expect(r[0]).toMatchObject({ state: 'failed', error: 'too big' });
    expect(filesUploadsReducer(r, { type: 'dismiss', localId: 'l1' })).toEqual([]);
  });

  function fakeClient(save: () => Promise<unknown>) {
    const create = vi.fn(async () => ({
      status: 'ok',
      data: {
        attachment: att('att_new', 3),
        uploadUrl: '/api/v1/burrows/burrow-hq/uploads/att_new/content',
        method: 'PUT',
        headers: {},
        maxBytes: 9999,
      },
    }));
    const upload = vi.fn(async () => ({ attachment: { ...att('att_new', 3) } }));
    const client = {
      uploads: { create },
      files: { save: vi.fn(save) },
      session: { transport: 'secure', upload },
    } as unknown as WhombatClient;
    return { client, create, upload };
  }

  it('reserves, sends the bytes and saves into the folder', async () => {
    const saved = { file: entry('att_new', 'Drawings', '2026-10-05T12:00:00.000Z') };
    const { client } = fakeClient(async () => ({ status: 'ok', data: saved }));
    const reserved = vi.fn();
    const out = await uploadToFiles(client, {
      burrow: 'burrow-hq',
      conversationId: 'cnv_general',
      folder: 'Drawings',
      file: { name: 'a.pdf', type: 'application/pdf', size: 3, body: new ArrayBuffer(3) },
      onReserved: reserved,
    });
    expect(out).toEqual(saved.file);
    expect(reserved).toHaveBeenCalledWith('att_new', 9999);
    expect(client.files.save).toHaveBeenCalledWith({
      params: { burrow: 'burrow-hq' },
      body: { attachmentId: 'att_new', folder: 'Drawings' },
    });
  });

  it('a refused save is said in the Whombat’s words; a retry with the upload only saves', async () => {
    const { client, create } = fakeClient(async () => {
      throw new ApiError(400, 'validation_failed', 'That folder can’t be used.', null, 'files.save');
    });
    await expect(
      uploadToFiles(client, {
        burrow: 'burrow-hq',
        conversationId: 'cnv_general',
        folder: '',
        file: { name: 'a.pdf', type: '', size: 3, body: new ArrayBuffer(3) },
        uploaded: att('att_new', 3),
      }),
    ).rejects.toEqual(new UploadError('That folder can’t be used.', 400));
    expect(create).not.toHaveBeenCalled();
  });
});
