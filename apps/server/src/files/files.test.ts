import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { durableIO } from '../test/durable-io';
import { makePng } from '../test/files';
import { attachmentHeaders, contentDisposition, notModified, parseRange } from './http';
import { sniffBuffer, textTypeFor } from './sniff';
import { blobKey, LocalFileStore, TooManyBytes } from './store';
import { wholeUtf8 } from './tools';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'whombat-store-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('sniffing', () => {
  it('reads image headers and sizes', () => {
    expect(sniffBuffer(makePng(12, 7), 'x.bin')).toEqual({
      ok: true,
      value: { contentType: 'image/png', kind: 'image', width: 12, height: 7 },
    });
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([10, 0, 20, 0]), Buffer.alloc(8)]);
    expect(sniffBuffer(gif, 'a.gif')).toMatchObject({
      ok: true,
      value: { kind: 'image', width: 10, height: 20 },
    });
    // JPEG: SOI, an APP0 segment, then SOF0 with height 300 and width 400.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90,
    ]);
    expect(sniffBuffer(jpeg, 'a.jpg')).toMatchObject({
      ok: true,
      value: { contentType: 'image/jpeg', width: 400, height: 300 },
    });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUIntLE(99, 24, 3);
    webp.writeUIntLE(49, 27, 3);
    expect(sniffBuffer(webp, 'a.webp')).toMatchObject({
      ok: true,
      value: { contentType: 'image/webp', width: 100, height: 50 },
    });
  });

  it('refuses damaged images and decompression bombs', () => {
    expect(sniffBuffer(Buffer.concat([makePng(1, 1).subarray(0, 8), Buffer.alloc(20)]), 'a.png')).toEqual({
      ok: false,
      reason: 'malformed_image',
    });
    const bomb = makePng(1, 1);
    bomb.writeUInt32BE(30_000, 16);
    expect(sniffBuffer(bomb, 'a.png')).toEqual({ ok: false, reason: 'image_too_large' });
    expect(sniffBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'a.jpg')).toMatchObject({ ok: false });
    // Fill bytes to the end: refused as a broken picture, not a crash.
    expect(sniffBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xff]), 'a.jpg')).toMatchObject({
      ok: false,
    });
  });

  it('labels an HTML page and a Mermaid file for previews, still text (CT-152, UI-R16)', () => {
    const page = '<!DOCTYPE html><html><head><title>Logo</title></head><body><svg></svg></body></html>';
    for (const name of ['logo.html', 'Logo.HTM'])
      expect(sniffBuffer(Buffer.from(page), name)).toMatchObject({
        ok: true,
        value: { kind: 'text', contentType: 'text/html' },
      });
    expect(sniffBuffer(Buffer.from('graph TD; A-->B'), 'flow.mmd')).toMatchObject({
      value: { kind: 'text', contentType: 'text/vnd.mermaid' },
    });
  });

  it('AVIF, audio and video are files with their media type when the bytes are that container', () => {
    const ftyp = (brand: string) =>
      Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from(`ftyp${brand}`), Buffer.alloc(40, 1)]);
    expect(sniffBuffer(ftyp('avif'), 'shot.avif')).toMatchObject({
      value: { kind: 'file', contentType: 'image/avif' },
    });
    expect(sniffBuffer(ftyp('isom'), 'shot.avif')).toMatchObject({
      value: { kind: 'file', contentType: 'application/octet-stream' },
    });
    expect(sniffBuffer(ftyp('isom'), 'demo.mp4')).toMatchObject({
      value: { kind: 'file', contentType: 'video/mp4' },
    });
    expect(sniffBuffer(ftyp('qt  '), 'demo.MOV')).toMatchObject({
      value: { contentType: 'video/quicktime' },
    });
    expect(sniffBuffer(ftyp('M4A '), 'song.m4a')).toMatchObject({ value: { contentType: 'audio/mp4' } });
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40, 0)]);
    expect(sniffBuffer(ogg, 'note.ogg')).toMatchObject({ value: { contentType: 'audio/ogg' } });
    expect(sniffBuffer(ogg, 'clip.ogv')).toMatchObject({ value: { contentType: 'video/ogg' } });
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40, 0)]);
    expect(sniffBuffer(webm, 'clip.webm')).toMatchObject({ value: { contentType: 'video/webm' } });
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4, 0),
      Buffer.from('WAVE'),
      Buffer.alloc(40, 0),
    ]);
    expect(sniffBuffer(wav, 'a.wav')).toMatchObject({ value: { contentType: 'audio/wav' } });
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0]), Buffer.alloc(40, 0)]);
    expect(sniffBuffer(mp3, 'a.mp3')).toMatchObject({ value: { contentType: 'audio/mpeg' } });
    // The extension alone never makes a media file.
    expect(sniffBuffer(mp3, 'a.mp4')).toMatchObject({ value: { contentType: 'application/octet-stream' } });
  });

  it('labels text by a short allowlist; an .svg that starts like SVG is labelled SVG text', () => {
    expect(
      sniffBuffer(Buffer.from('# Hi\n'), 'README.md').ok && sniffBuffer(Buffer.from('# Hi\n'), 'README.md'),
    ).toMatchObject({
      value: { kind: 'text', contentType: 'text/markdown' },
    });
    for (const name of ['logo.svgz', 'x.png', 'run.log'])
      expect(sniffBuffer(Buffer.from('<svg></svg>'), name)).toMatchObject({
        value: { kind: 'text', contentType: 'text/plain' },
      });
    // MPO-02: the label lets a client show it as an image; kind text keeps it a download served as text/plain.
    for (const text of ['<svg></svg>', '\uFEFF<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg>\n<svg\n/>'])
      expect(sniffBuffer(Buffer.from(text), 'Chart.SVG')).toMatchObject({
        value: { kind: 'text', contentType: 'image/svg+xml' },
      });
    expect(sniffBuffer(Buffer.from('<html><svg></svg></html>'), 'x.svg')).toMatchObject({
      value: { kind: 'text', contentType: 'text/plain' },
    });
    expect(textTypeFor('data.JSON')).toBe('application/json');
    expect(sniffBuffer(Buffer.from('\u001b[32mok\u001b[0m\tdone\r\n'), 'ci.log')).toMatchObject({
      value: { kind: 'text' },
    });
  });

  it('PDFs are documents; binary, NULs, invalid UTF-8 and control soup are files', () => {
    expect(sniffBuffer(Buffer.from('%PDF-1.7\n...'), 'a.pdf')).toMatchObject({
      value: { kind: 'document', contentType: 'application/pdf' },
    });
    expect(sniffBuffer(Buffer.from('ab\u0000cd'), 'a.txt')).toMatchObject({ value: { kind: 'file' } });
    expect(sniffBuffer(Buffer.from([0xc3, 0x28]), 'a.txt')).toMatchObject({ value: { kind: 'file' } });
    expect(sniffBuffer(Buffer.alloc(100, 7), 'a.txt')).toMatchObject({ value: { kind: 'file' } });
    expect(sniffBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]), 'a.zip')).toMatchObject({
      value: { contentType: 'application/zip' },
    });
  });
});

describe('response headers', () => {
  it('parses single byte ranges', () => {
    expect(parseRange(undefined, 10)).toEqual({ kind: 'none' });
    expect(parseRange('bytes=0-3', 10)).toEqual({ kind: 'range', start: 0, end: 3 });
    expect(parseRange('bytes=5-', 10)).toEqual({ kind: 'range', start: 5, end: 9 });
    expect(parseRange('bytes=-4', 10)).toEqual({ kind: 'range', start: 6, end: 9 });
    expect(parseRange('bytes=8-100', 10)).toEqual({ kind: 'range', start: 8, end: 9 });
    expect(parseRange('bytes=10-', 10)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-1,4-5', 10)).toEqual({ kind: 'none' });
    expect(parseRange('items=0-1', 10)).toEqual({ kind: 'none' });
  });

  it('only sniffed images show inline; names are quoted safely', () => {
    const base = {
      contentType: 'image/png',
      name: 'a "b".png',
      sha256: 'f'.repeat(64),
      forceDownload: false,
    };
    expect(attachmentHeaders({ ...base, kind: 'image' })['content-disposition']).toBe(
      `inline; filename="a _b_.png"; filename*=UTF-8''a%20%22b%22.png`,
    );
    expect(attachmentHeaders({ ...base, kind: 'image', forceDownload: true })['content-disposition']).toMatch(
      /^attachment/,
    );
    for (const contentType of ['text/plain', 'image/svg+xml', 'text/html'])
      expect(attachmentHeaders({ ...base, kind: 'text', contentType })).toMatchObject({
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': expect.stringMatching(/^attachment;/),
        'content-security-policy': "default-src 'none'; sandbox",
        'x-content-type-options': 'nosniff',
      });
    expect(attachmentHeaders({ ...base, kind: 'text', contentType: 'text/csv' })['content-type']).toBe(
      'text/csv; charset=utf-8',
    );
    expect(contentDisposition('attachment', 'Überblick.pdf')).toBe(
      `attachment; filename="_berblick.pdf"; filename*=UTF-8''%C3%9Cberblick.pdf`,
    );
    expect(notModified(`W/"${'a'.repeat(64)}", "x"`, 'a'.repeat(64))).toBe(true);
    expect(notModified('"x"', 'a'.repeat(64))).toBe(false);
  });
});

describe('LocalFileStore', () => {
  it(
    'stages, commits atomically by hash, dedupes, reads ranges and deletes',
    (context) =>
      durableIO(context, async (signal) => {
        // Three real sync boundaries; allow shared-storage contention without skipping durability.
        const root = join(tempDir(), 'files');
        const store = new LocalFileStore(root);
        const staged = await store.stage([Buffer.from('hello '), Buffer.from('world')], {
          maxBytes: 100,
          signal,
        });
        expect(staged.size).toBe(11);
        const key = blobKey(staged.sha256);
        signal.throwIfAborted();
        await store.commit(staged, key);
        signal.throwIfAborted();
        expect((await stat(root)).mode & 0o777).toBe(0o700);
        expect((await stat(join(root, ...key.split('/')))).mode & 0o777).toBe(0o600);
        const again = await store.stage([Buffer.from('hello world')], { maxBytes: 100, signal });
        await store.commit(again, key);
        signal.throwIfAborted();
        const chunks: Buffer[] = [];
        for await (const c of (await store.open(key, { start: 6, end: 10 })) ?? []) chunks.push(c as Buffer);
        expect(Buffer.concat(chunks).toString()).toBe('world');
        const listed: string[] = [];
        for await (const b of store.list()) listed.push(b.key);
        expect(listed).toEqual([key]);
        await store.delete(key);
        expect(await store.size(key)).toBeNull();
        await store.delete(key);
      }),
    15_000,
  );

  it('refuses oversize bodies and leaves nothing staged', async () => {
    const root = tempDir();
    const store = new LocalFileStore(root);
    await expect(store.stage([Buffer.alloc(10), Buffer.alloc(10)], { maxBytes: 15 })).rejects.toBeInstanceOf(
      TooManyBytes,
    );
    expect(await store.sweepStaging(0, Date.now() + 1000)).toBe(0);
  });

  it(
    'never follows a link planted in its tree, and refuses keys that are not hashes',
    (context) =>
      durableIO(context, async (signal) => {
        // Two real sync boundaries precede the security assertions.
        const root = tempDir();
        const store = new LocalFileStore(root);
        const staged = await store.stage([Buffer.from('x')], { maxBytes: 10, signal });
        const key = blobKey(staged.sha256);
        signal.throwIfAborted();
        await store.commit(staged, key);
        signal.throwIfAborted();
        const outside = join(tempDir(), 'secret');
        writeFileSync(outside, 'secret');
        const other = blobKey('b'.repeat(64));
        const path = join(root, ...other.split('/'));
        rmSync(join(root, 'sha256', 'bb'), { recursive: true, force: true });
        symlinkSync(join(outside, '..'), join(root, 'sha256', 'bb'));
        expect(await store.open(other)).toBeNull();
        expect(path).toContain(root);
        await expect(store.open('../../etc/passwd')).rejects.toThrow(/invalid file key/);
        expect(() => blobKey('nope')).toThrow();
      }),
    10_000,
  );
});

describe('read_attachment chunks', () => {
  it('never cuts a character in half', () => {
    const bytes = Buffer.from('añb€', 'utf8'); // a(1) ñ(2) b(1) €(3)
    expect(wholeUtf8(bytes.subarray(0, 6), false)).toEqual({ text: 'añb', used: 4 });
    expect(wholeUtf8(bytes, true)).toEqual({ text: 'añb€', used: 7 });
    expect(wholeUtf8(bytes.subarray(0, 2), false)).toEqual({ text: 'a', used: 1 });
  });
});
