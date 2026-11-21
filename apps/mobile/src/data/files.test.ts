import { FILES_COPY, filesConversationRows } from '@whombat/client';
import type { ConversationSummary, FileEntry } from '@whombat/core';
import { bootstrap, SEED_NOW } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import {
  canRename,
  fileActions,
  fileRowView,
  filesKicker,
  filesListRow,
  filesPlaceOf,
  filesRowFor,
  filesTargetId,
  filesWhere,
  folderRowMeta,
  moveChoices,
  newFolder,
  reachableFolder,
  removeConfirm,
  renameProblem,
  typedFolder,
} from './files';

const minutesBefore = (m: number) => new Date(SEED_NOW.getTime() - m * 60_000).toISOString();

function entry(over: Partial<FileEntry> & { name?: string; size?: number } = {}): FileEntry {
  const { name = 'plan.pdf', size = 2_516_582, ...rest } = over;
  return {
    attachment: {
      id: `att_${name}`,
      name,
      contentType: 'application/pdf',
      size,
      url: `/api/v1/burrows/burrow-hq/attachments/att_${name}`,
      kind: 'document',
      width: null,
      height: null,
    },
    conversationId: 'cnv_pr482',
    folder: '',
    uploadedById: 'prn_dusty',
    addedAt: minutesBefore(2),
    messageId: 'msg_1',
    threadRootId: null,
    ...rest,
  };
}

const summary = {
  conversations: [
    { conversationId: 'cnv_dm-dusty', count: 3, bytes: 1_572_864, lastAddedAt: minutesBefore(1) },
    { conversationId: 'cnv_pr482', count: 12, bytes: 4_299_161, lastAddedAt: minutesBefore(60) },
    { conversationId: 'cnv_feedback-mara', count: 0, bytes: 0, lastAddedAt: minutesBefore(90) },
  ],
};

describe('the Files list', () => {
  const ctx = worldContext();
  const rows = filesConversationRows(summary, bootstrap());

  it('names the person’s Chat and a branch room by their titles, newest first, without empty ones', () => {
    const shown = rows.map((r) => filesListRow(r, ctx));
    expect(shown.map((r) => r.row.conversationId)).toEqual(['cnv_dm-dusty', 'cnv_pr482']);
    const [chat, branch] = shown;
    expect(chat?.title).toBe('Chat');
    expect(chat?.meta).toMatch(/^3 files · 1\.5 MB · Last added \d+ \w+ \d\d:\d\d$/);
    expect(branch?.title).toBe('feat/invoice-pdf');
    expect(branch?.accessibilityLabel).toContain('branch room');
  });

  it('names a conversation the sidebar doesn’t list from the conversation itself', () => {
    const chat = bootstrap().sidebar.dms[0] as ConversationSummary;
    const task = { ...chat, id: 'cnv_task', title: 'Plex keeps buffering' } as ConversationSummary;
    const row = filesRowFor(task, { count: 4, bytes: 10, lastAddedAt: minutesBefore(5) });
    expect(row).toMatchObject({ kind: 'dm', label: 'Plex keeps buffering', count: 4, bytes: 10 });
  });

  it('says where a file is in a sentence and as a kicker', () => {
    const [chat, branch] = rows;
    expect(filesWhere(chat)).toBe('your Chat');
    expect(filesWhere(branch)).toBe('feat/invoice-pdf');
    expect(filesWhere(null)).toBe('this conversation');
    expect(filesKicker(chat)).toBe('Chat');
    expect(filesKicker(branch)).toBe('feat/invoice-pdf');
  });
});

describe('a file and its actions (FS-05, FS-06)', () => {
  const ctx = worldContext();

  it('shows the name, size, who, when and where it came from', () => {
    const view = fileRowView(entry(), ctx);
    expect(view).toMatchObject({
      name: 'plan.pdf',
      size: '2.4 MB',
      uploader: 'Dusty',
      origin: 'In a message',
    });
    expect(view.accessibilityLabel).toBe(`plan.pdf, 2.4 MB, Dusty, ${view.time}, In a message`);
    expect(fileRowView(entry({ messageId: null }), ctx).origin).toBe(FILES_COPY.savedToFiles);
  });

  it('offers Rename only on a file saved into Files, Move and Remove always, Remove last', () => {
    expect(fileActions(entry()).map((a) => a.label)).toEqual([
      'Download',
      'Open message',
      'Move to folder…',
      'Remove from Files',
    ]);
    expect(fileActions(entry()).at(-1)?.destructive).toBe(true);
    expect(fileActions(entry({ messageId: null })).map((a) => a.kind)).toEqual([
      'download',
      'rename',
      'move',
      'remove',
    ]);
  });

  it('asks before removing: a message’s file only leaves Files, a saved one is deleted', () => {
    const fromMessage = removeConfirm(entry(), 'feat/invoice-pdf');
    expect(fromMessage.title).toContain('plan.pdf');
    expect(fromMessage.body).toContain('feat/invoice-pdf');
    expect(fromMessage.cta).toBe('Remove');
    const saved = removeConfirm(entry({ messageId: null }), 'your Chat');
    expect(saved.title).toContain('plan.pdf');
    expect(saved.body).toContain('your Chat');
    expect(saved.cta).toBe('Delete');
  });

  it('saves a new name only when it differs and can be one', () => {
    expect(renameProblem('  ')).toBe('Give the file a name.');
    expect(renameProblem('a/b.pdf')).toMatch(/can’t hold a \//);
    expect(canRename('plan.pdf', 'plan.pdf')).toBe(false);
    expect(canRename(' plan v2.pdf ', 'plan.pdf')).toBe(true);
  });
});

describe('folders (FS-03)', () => {
  const entries = [
    entry({ name: 'a.pdf', folder: 'Drawings/2024', addedAt: minutesBefore(1) }),
    entry({ name: 'b.pdf', folder: 'Drawings', addedAt: minutesBefore(3) }),
    entry({ name: 'c.pdf', folder: '', addedAt: minutesBefore(5) }),
  ];

  it('lists the top and every folder for Move, the file’s own checked', () => {
    expect(moveChoices(entries, ['Photos'], 'Drawings')).toEqual([
      { path: '', label: 'Top of Files', depth: 0, current: false },
      { path: 'Drawings', label: 'Drawings', depth: 0, current: true },
      { path: 'Drawings/2024', label: '2024', depth: 1, current: false },
      { path: 'Photos', label: 'Photos', depth: 0, current: false },
    ]);
  });

  it('takes a typed path in the spelling the space has, or says why it can’t be one', () => {
    expect(typedFolder('drawings/2025', entries, [])).toEqual({ folder: 'Drawings/2025' });
    expect(typedFolder('  ', entries, [])).toEqual({ folder: '' });
    expect(typedFolder('a/../b', entries, [])).toHaveProperty('problem');
    expect(typedFolder('a/b/c/d/e', entries, [])).toEqual({ problem: 'Folders go at most 4 levels deep.' });
  });

  it('makes a new folder inside the one on screen', () => {
    expect(newFolder('Site photos', 'Drawings', entries, [])).toEqual({ folder: 'Drawings/Site photos' });
    expect(newFolder('2024', 'drawings', entries, [])).toEqual({ folder: 'Drawings/2024' });
    expect(newFolder('', '', entries, [])).toEqual({ problem: 'Give the folder a name.' });
    expect(newFolder('a/b', '', entries, [])).toHaveProperty('problem');
  });

  it('goes up from a folder that is gone', () => {
    expect(reachableFolder(entries, 'Drawings/2024', [])).toBe('Drawings/2024');
    expect(reachableFolder(entries, 'Drawings/2023/old', [])).toBe('Drawings');
    expect(reachableFolder(entries, 'Gone', [])).toBe('');
    expect(reachableFolder(entries, 'Photos', ['Photos'])).toBe('Photos');
  });

  it('says what a folder holds; a new place holds nothing yet', () => {
    expect(folderRowMeta({ count: 2, bytes: 5_033_165, empty: false })).toBe('2 files · 4.8 MB');
    expect(folderRowMeta({ count: 0, bytes: 0, empty: true })).toBe('0 files');
  });
});

describe('which conversation a Files screen names', () => {
  const b = bootstrap();

  it('by id, by room, by pull request; null when the sidebar doesn’t know it', () => {
    expect(filesTargetId({ conversationId: 'cnv_x' }, b)).toBe('cnv_x');
    expect(filesTargetId({ room: 'chat' }, b)).toBe('cnv_dm-dusty');
    expect(filesTargetId({ room: 'feedback' }, b)).toBe('cnv_feedback-mara');
    expect(filesTargetId({ room: 'general' }, b)).toBeNull();
    expect(filesTargetId({ prNumber: 482 }, b)).toBe('cnv_pr482');
    expect(filesPlaceOf({ prNumber: 482, repo: 'acme/web' })).toEqual({
      type: 'pr',
      number: 482,
      repo: 'acme/web',
    });
    expect(filesPlaceOf({ conversationId: 'cnv_x' })).toBeNull();
  });
});
