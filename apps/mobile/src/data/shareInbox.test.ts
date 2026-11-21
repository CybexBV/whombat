import { afterEach, describe, expect, it } from 'vitest';
import {
  clearShare,
  currentShare,
  isShareUrl,
  MAX_SHARED_FILES,
  putShare,
  type SharedFileIn,
  sharedFiles,
  shareNote,
  sharePayload,
  shareSummary,
  shareText,
  subscribeShare,
} from './shareInbox';

const NOW = new Date(2026, 9, 4, 21, 4);
const file = (over: Partial<SharedFileIn> = {}): SharedFileIn => ({
  path: 'file:///data/cache/report.pdf',
  mimeType: 'application/pdf',
  fileName: 'report.pdf',
  size: 2048,
  ...over,
});

describe('the iPhone share extension’s link (AP-6322)', () => {
  it('is told apart from the app’s own links', () => {
    expect(isShareUrl('whombat://dataUrl=whombatShareKey?nonce=7#media')).toBe(true);
    expect(isShareUrl('whombat://dataUrl=whombatShareKey#weburl')).toBe(true);
    expect(isShareUrl('whombat://chat')).toBe(false);
    expect(isShareUrl('https://app.whombat.com/dataUrl=x')).toBe(false);
    expect(isShareUrl(null)).toBe(false);
  });
});

describe('a share’s text', () => {
  it('puts a page’s title above its link, and leaves text that already says it', () => {
    expect(shareText({ text: 'https://whombat.com/blog', meta: { title: 'Whombat blog' } })).toBe(
      'Whombat blog\nhttps://whombat.com/blog',
    );
    expect(
      shareText({ text: 'Read Whombat blog https://whombat.com', meta: { title: 'Whombat blog' } }),
    ).toBe('Read Whombat blog https://whombat.com');
    expect(shareText({ text: '  just text  ', meta: null })).toBe('just text');
    expect(shareText({ text: null, meta: { title: 'Subject only' } })).toBe('Subject only');
    expect(shareText({})).toBe('');
  });
});

describe('a share’s files', () => {
  it('keeps real names, names numbered photos as the photo picker does', () => {
    const { files } = sharedFiles(
      [
        file(),
        file({ path: 'file:///c/19.png', mimeType: 'image/png', fileName: '19.png', size: 10 }),
        file({ path: 'file:///c/IMG_1.jpg', mimeType: 'image/jpeg', fileName: 'IMG_1.jpg', size: 10 }),
        file({ path: 'file:///c/x', mimeType: 'image/jpeg', fileName: null, size: 10 }),
        file({ path: 'file:///c/y', mimeType: null, fileName: null, size: 10 }),
      ],
      NOW,
    );
    expect(files.map((f) => f.name)).toEqual([
      'report.pdf',
      'Photo 2026-10-04 21.04 (2).png',
      'IMG_1.jpg',
      'Photo 2026-10-04 21.04 (4).jpg',
      'file',
    ]);
    expect(files[0]).toEqual({
      uri: 'file:///data/cache/report.pdf',
      name: 'report.pdf',
      type: 'application/pdf',
      size: 2048,
    });
    expect(files[4]?.type).toBe('');
  });

  it('counts files it can’t read and those past the limit', () => {
    const many = Array.from({ length: MAX_SHARED_FILES + 2 }, (_, i) => file({ fileName: `f${i}.pdf` }));
    const got = sharedFiles([...many, file({ path: null }), file({ size: null }), file({ size: 0 })], NOW);
    expect(got.files).toHaveLength(MAX_SHARED_FILES);
    expect(got.dropped).toBe(2);
    expect(got.unreadable).toBe(3);
    expect(shareNote(got)).toBe(
      'Only the first 10 files are added. 3 files couldn’t be read from the other app.',
    );
    expect(shareNote({ dropped: 0, unreadable: 1 })).toBe('1 file couldn’t be read from the other app.');
    expect(shareNote({ dropped: 0, unreadable: 0 })).toBeNull();
  });
});

describe('a share’s payload and summary', () => {
  it('is null for a share that carries nothing', () => {
    expect(sharePayload({ text: '  ', files: [] }, NOW)).toBeNull();
    expect(sharePayload({ text: null, files: null }, NOW)).toBeNull();
    // A file the phone couldn't hand over still opens the screen, which says so.
    expect(sharePayload({ files: [file({ path: null })] }, NOW)).toMatchObject({ text: '', unreadable: 1 });
  });

  it('says what is being shared', () => {
    const photo = { uri: 'u', name: 'a.jpg', type: 'image/jpeg', size: 1 };
    const pdf = { uri: 'u', name: 'a.pdf', type: 'application/pdf', size: 1 };
    expect(shareSummary({ text: 'https://whombat.com/x?y=1', files: [] })).toBe('A link');
    expect(shareSummary({ text: 'Title\nhttps://whombat.com', files: [] })).toBe('Text');
    expect(shareSummary({ text: '', files: [photo, photo, pdf] })).toBe('2 photos · 1 file');
    expect(shareSummary({ text: 'look', files: [photo] })).toBe('1 photo · Text');
    expect(shareSummary({ text: '', files: [] })).toBe('Nothing to send');
  });
});

describe('the pending share', () => {
  afterEach(() => {
    const share = currentShare();
    if (share) clearShare(share.id);
  });

  it('holds the newest share until that one is cleared, and tells listeners', () => {
    let calls = 0;
    const off = subscribeShare(() => calls++);
    expect(putShare(null)).toBeNull();
    expect(calls).toBe(0);
    const first = putShare({ text: 'one', files: [], dropped: 0, unreadable: 0 });
    const second = putShare({ text: 'two', files: [], dropped: 0, unreadable: 0 });
    expect(second?.id).toBeGreaterThan(first?.id ?? 0);
    expect(currentShare()?.text).toBe('two');
    // The first share's screen going away never clears the newer one.
    clearShare(first?.id ?? 0);
    expect(currentShare()?.text).toBe('two');
    clearShare(second?.id ?? 0);
    expect(currentShare()).toBeNull();
    expect(calls).toBe(3);
    off();
    putShare({ text: 'three', files: [], dropped: 0, unreadable: 0 });
    expect(calls).toBe(3);
  });
});
