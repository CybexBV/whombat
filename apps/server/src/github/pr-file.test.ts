/** A pull request's file, whole (pr-file-view.md PF-02, PF-05): the base it is read at and the view. */
import { PR_FILE_MAX_BYTES, PR_FILE_MAX_LINES, PrFileView } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { buildFileView, type FileSource, type FileVersion, prBaseSha } from './pr-file';

const file = (text: string): FileVersion => ({ kind: 'file', bytes: new TextEncoder().encode(text) });
const shas = { baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40) };

describe('the file view of two versions', () => {
  it('lays out a modified file: every line, removed before added, numbered in its version', () => {
    const view = buildFileView({
      path: 'a.ts',
      ...shas,
      base: file('one\ntwo\nthree\n'),
      head: file('one\n2\nthree\nfour\n'),
    });
    expect(PrFileView.parse(view)).toEqual(view);
    expect(view).toMatchObject({ status: 'modified', shown: 'text', add: 2, del: 1 });
    expect(view.lines).toEqual([
      { kind: 'context', old: 1, new: 1, text: 'one' },
      { kind: 'del', old: 2, new: null, text: 'two' },
      { kind: 'add', old: null, new: 2, text: '2' },
      { kind: 'context', old: 3, new: 3, text: 'three' },
      { kind: 'add', old: null, new: 4, text: 'four' },
    ]);
  });

  it('an added and a deleted file', () => {
    const added = buildFileView({
      path: 'n.ts',
      baseSha: null,
      headSha: shas.headSha,
      base: null,
      head: file('x\ny\n'),
    });
    expect(added).toMatchObject({ status: 'added', shown: 'text', add: 2, del: 0, baseSha: null });
    const deleted = buildFileView({ path: 'o.ts', ...shas, base: file('x\n'), head: null });
    expect(deleted).toMatchObject({ status: 'deleted', shown: 'text', add: 0, del: 1 });
    expect(deleted.lines).toEqual([{ kind: 'del', old: 1, new: null, text: 'x' }]);
  });

  it('binary when either version has a NUL; too large above the bytes or the lines; never any lines then', () => {
    const binary = { kind: 'file', bytes: new Uint8Array([0x89, 0x50, 0, 1]) } as const;
    expect(buildFileView({ path: 'p.png', ...shas, base: file('text\n'), head: binary })).toMatchObject({
      status: 'modified',
      shown: 'binary',
      add: 0,
      del: 0,
      lines: [],
    });
    expect(
      buildFileView({
        path: 'big',
        ...shas,
        base: { kind: 'too_large', size: PR_FILE_MAX_BYTES + 1 },
        head: file('x\n'),
      }),
    ).toMatchObject({ shown: 'too_large', lines: [] });
    const many = 'line\n'.repeat(PR_FILE_MAX_LINES / 2 + 1);
    expect(
      buildFileView({ path: 'long', ...shas, base: file(many), head: file(`${many}more\n`) }).shown,
    ).toBe('text');
    const other = 'other\n'.repeat(PR_FILE_MAX_LINES / 2 + 1);
    expect(buildFileView({ path: 'long', ...shas, base: file(many), head: file(other) })).toMatchObject({
      shown: 'too_large',
      lines: [],
    });
  });
});

describe('the commit the base version is read at (PF-02)', () => {
  const source = (mergeBase: string | null, parents: Record<string, string> = {}): FileSource => ({
    mergeBase: async () => mergeBase,
    commitParent: async (sha) => parents[sha] ?? null,
    fileAt: async () => null,
  });
  const pr = { baseBranch: 'main', headSha: 'head' };

  it('the merge base of the base branch and the head', async () => {
    expect(await prBaseSha(source('fork'), pr, 'c1')).toBe('fork');
  });

  it('once the head is in the base (a merge commit): the parent of the first commit, else the merge base', async () => {
    expect(await prBaseSha(source('head', { c1: 'start' }), pr, 'c1')).toBe('start');
    expect(await prBaseSha(source('head', { head: 'start' }), pr, 'head')).toBe('start');
    expect(await prBaseSha(source('head'), pr, 'c1')).toBe('head');
    expect(await prBaseSha(source('head'), pr, null)).toBe('head');
    expect(await prBaseSha(source(null, { c1: 'start' }), pr, 'c1')).toBe('start');
    expect(await prBaseSha(source(null), pr, null)).toBeNull();
  });
});
