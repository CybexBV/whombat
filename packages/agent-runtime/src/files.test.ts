import type { DispatchFiles, FileRef } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { attachmentSection, type PlannedAttachment } from './attachments';
import { FILES_HOME_LINE, filesTurnLines, planTurnFiles } from './files';

const MB = 1024 * 1024;

function file(id: string, size: number, addedAt: string, extra: Partial<FileRef> = {}): FileRef {
  return {
    id,
    name: `${id}.bin`,
    contentType: 'application/octet-stream',
    size,
    kind: 'file',
    sha256: 'a'.repeat(64),
    folder: '',
    messageId: null,
    addedAt,
    ...extra,
  };
}

function files(entries: FileRef[], extra: Partial<DispatchFiles> = {}): DispatchFiles {
  return {
    conversationId: 'cnv_1',
    count: entries.length,
    totalBytes: entries.reduce((n, e) => n + e.size, 0),
    truncated: false,
    entries,
    ...extra,
  };
}

describe('planTurnFiles (FS-09)', () => {
  it('takes the newest first, each up to the per-file bound and all up to the total', () => {
    const plan = planTurnFiles(
      files([
        file('att_old', 40 * MB, '2026-10-01T10:00:00.000Z'),
        file('att_big', 300 * MB, '2026-10-05T10:00:00.000Z'),
        file('att_new', 70 * MB, '2026-10-04T10:00:00.000Z'),
        file('att_mid', 50 * MB, '2026-10-03T10:00:00.000Z'),
      ]),
      { fileBytes: 250 * MB, totalBytes: 100 * MB },
    );
    expect(plan?.included.map((r) => r.id)).toEqual(['att_new']);
    // A file that doesn't fit leaves room for an older smaller one.
    expect(plan?.left.map((l) => [l.ref.id, l.why])).toEqual([
      ['att_big', 'too_large'],
      ['att_mid', 'over_total'],
      ['att_old', 'over_total'],
    ]);
  });

  it('uses the contract’s bounds by default: 250 MiB a file, 2 GiB in all', () => {
    const plan = planTurnFiles(
      files([
        file('att_a', 250 * MB, '2026-10-05T10:00:00.000Z'),
        file('att_b', 250 * MB + 1, '2026-10-04T10:00:00.000Z'),
      ]),
    );
    expect(plan?.included.map((r) => r.id)).toEqual(['att_a']);
    expect(plan?.left[0]?.why).toBe('too_large');
  });

  it('counts the files the dispatch didn’t list, and is null without Files', () => {
    const plan = planTurnFiles(
      files([file('att_a', 1, '2026-10-05T10:00:00.000Z')], {
        count: 620,
        totalBytes: 5 * MB,
        truncated: true,
      }),
    );
    expect(plan).toMatchObject({ count: 620, totalBytes: 5 * MB, notListed: 619 });
    expect(planTurnFiles(null)).toBeNull();
  });
});

describe('filesTurnLines (FS-10)', () => {
  const two = planTurnFiles(
    files([
      file('att_a', 2 * MB, '2026-10-05T10:00:00.000Z', { name: 'plan.skp', folder: 'Drawings' }),
      file('att_b', 300 * MB, '2026-10-04T10:00:00.000Z', { name: '1904Technischmodel.skp' }),
    ]),
  );

  it('a commands turn: what is at ~/files, and what isn’t with why', () => {
    expect(filesTurnLines(two, 'home', { count: 1, bytes: 2 * MB, unavailable: [] })).toEqual([
      'This conversation’s Files: 2 files, 302 MB; 1 file (2 MB) is at ~/files.',
      'Not there in this turn: 1904Technischmodel.skp (300 MB, larger than the 250 MB a turn copies). list_files lists every file; say so when one you need isn’t there, and don’t guess what it contains.',
    ]);
  });

  it('one that couldn’t be fetched is named', () => {
    const one = planTurnFiles(
      files([file('att_a', 2 * MB, '2026-10-05T10:00:00.000Z', { name: 'q3.xlsx' })]),
    );
    expect(filesTurnLines(one, 'home', { count: 1, bytes: 2 * MB, unavailable: [] })[0]).toContain(
      'all at ~/files',
    );
    const [, left] = filesTurnLines(one, 'home', {
      count: 0,
      bytes: 0,
      unavailable: one?.included ?? [],
    });
    expect(left).toContain('q3.xlsx (2 MB, it couldn’t be fetched)');
  });

  it('another turn is told to use list_files and read_attachment; nothing without Files', () => {
    expect(filesTurnLines(two, null)).toEqual([
      'This conversation’s Files hold 2 files, 302 MB: list_files lists them and read_attachment reads text ones. Other types can’t be opened in this turn; say so if one matters.',
    ]);
    expect(filesTurnLines(planTurnFiles(files([])), 'home')).toEqual([]);
    expect(filesTurnLines(null, null)).toEqual([]);
  });

  it('counts what it doesn’t name, and the files beyond the dispatch’s list', () => {
    const many = planTurnFiles(
      files(
        Array.from({ length: 15 }, (_, i) =>
          file(`att_${i}`, 300 * MB, `2026-10-05T10:${String(59 - i).padStart(2, '0')}:00.000Z`),
        ),
        { count: 20, totalBytes: 20 * 300 * MB, truncated: true },
      ),
    );
    const [, left] = filesTurnLines(many, 'home', { count: 0, bytes: 0, unavailable: [] });
    expect(left).toContain('att_11.bin (300 MB, larger than the 250 MB a turn copies); and 8 more.');
    expect(filesTurnLines(many, 'home', null)[0]).toBe(
      'This conversation’s Files: 20 files, 5.9 GB; none of them is at ~/files.',
    );
  });

  it('the system prompt’s lines are static: no count, size or name', () => {
    expect(FILES_HOME_LINE).toContain('~/files, read-only');
    expect(FILES_HOME_LINE).toContain('upload_file');
    expect(FILES_HOME_LINE).not.toMatch(/\d|computer/);
  });
});

describe('the attachments section with the conversation’s Files (FS-10)', () => {
  const skp: PlannedAttachment = {
    ref: {
      id: 'att_skp',
      messageId: 'msg_1',
      name: '1904Technischmodel.skp',
      contentType: 'application/octet-stream',
      size: 136 * MB,
      kind: 'file',
      sha256: 'b'.repeat(64),
      width: null,
      height: null,
    } as PlannedAttachment['ref'],
    delivery: { mode: 'note', why: 'type' },
  };

  it('names the file at ~/files instead of “you can’t open this type”', () => {
    const section = attachmentSection(
      [skp],
      [],
      new Map(),
      new Map([['att_skp', '~/files/1904Technischmodel.skp']]),
    );
    expect(section).toContain('att_skp · 1904Technischmodel.skp');
    expect(section).toContain('it is at ~/files/1904Technischmodel.skp: open it with your commands');
    expect(section).not.toContain('can’t open');
  });

  it('without ~/files it stays honest', () => {
    expect(attachmentSection([skp], [], new Map())).toContain('you can’t open this type');
  });
});
