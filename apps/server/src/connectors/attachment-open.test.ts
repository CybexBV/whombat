import { ATTACHMENT_TEXT_CAP, type ConnectorBinary } from '@whombat/core';
import { PNG } from 'pngjs';
import { describe, expect, it, vi } from 'vitest';
import type { ImageJob, ImageRunner } from '../feedback/image-pool';
import { minimalPdf } from '../test/pdf';
import { ATTACHMENT_PICTURE_EDGE, openAttachment } from './attachment-open';
import { readPdf } from './pdf-read';

const file = (bytes: Buffer, name: string, mimeType = 'application/octet-stream'): ConnectorBinary => ({
  name,
  mimeType,
  contentBase64: bytes.toString('base64'),
});

const png = (width: number, height: number) => {
  const p = new PNG({ width, height });
  p.data.fill(200);
  return PNG.sync.write(p);
};

/** A stand-in for the image worker: says what it was asked and hands back a small picture. */
function images(): ImageRunner & { jobs: ImageJob[] } {
  const jobs: ImageJob[] = [];
  return {
    jobs,
    async run(job) {
      jobs.push(job);
      return { bytes: png(8, 4), width: 8, height: 4 };
    },
  };
}

const LETTER = ['Hondsrug College', 'Payment notice: EUR 45.00', 'Pay by 12 December 2026'];

describe('reading a PDF in a worker of its own', () => {
  it('gives its text, page by page', async () => {
    const read = await readPdf(minimalPdf(LETTER), ATTACHMENT_TEXT_CAP);
    expect(read).toMatchObject({ ok: true, pages: 1, truncated: false });
    expect(read.ok && read.text).toContain('EUR 45.00');
    expect(read.ok && read.text.split('\n')).toEqual(LETTER);
  });

  it('cuts the text where it is asked to', async () => {
    const read = await readPdf(minimalPdf(LETTER), 20);
    expect(read).toMatchObject({ ok: true, truncated: true });
    expect(read.ok && read.text.length).toBe(20);
  });

  it('tells a damaged file, and one that takes too long, as unreadable', async () => {
    expect(await readPdf(Buffer.from('%PDF-1.4 not really'), 1000)).toEqual({ ok: false, why: 'broken' });
    expect(await readPdf(minimalPdf(LETTER), 1000, { timeoutMs: 1 })).toEqual({ ok: false, why: 'too_slow' });
  });
});

describe('opening a mail attachment', () => {
  it('reads a PDF by its bytes, whatever it was called', async () => {
    const opened = await openAttachment(file(minimalPdf(LETTER), 'betaalverzoek'), { images: images() });
    expect(opened.picture).toBeNull();
    expect(opened.attachment).toMatchObject({
      shows: 'text',
      pages: 1,
      truncated: false,
      name: 'betaalverzoek',
    });
    expect(opened.attachment.text).toContain('Pay by 12 December 2026');
  });

  it('says why a PDF has nothing to read', async () => {
    const readPdf = vi.fn(async () => ({ ok: true as const, pages: 2, text: '', truncated: false }));
    const scan = await openAttachment(file(minimalPdf([]), 'scan.pdf', 'application/pdf'), {
      images: images(),
      readPdf,
    });
    expect(scan.attachment).toMatchObject({ shows: 'none', text: null, pages: 2 });
    expect(scan.attachment.reason).toMatch(/scan/);
    const locked = await openAttachment(file(minimalPdf(LETTER), 'a.pdf'), {
      images: images(),
      readPdf: async () => ({ ok: false, why: 'password' }),
    });
    expect(locked.attachment).toMatchObject({ shows: 'none' });
    expect(locked.attachment.reason).toMatch(/password/);
  });

  it('sends a small picture as it is, and a large one made smaller', async () => {
    const small = png(40, 30);
    const runner = images();
    const opened = await openAttachment(file(small, 'ticket.png', 'image/png'), { images: runner });
    expect(opened.attachment).toMatchObject({ shows: 'picture', text: null });
    expect(opened.picture).toEqual({ data: small.toString('base64'), mimeType: 'image/png' });
    expect(runner.jobs).toHaveLength(0);

    const large = await openAttachment(file(png(ATTACHMENT_PICTURE_EDGE + 10, 20), 'scan.png'), {
      images: runner,
    });
    expect(runner.jobs).toHaveLength(1);
    expect(runner.jobs[0]?.thumbnailMaxEdge).toBe(ATTACHMENT_PICTURE_EDGE);
    expect(large.picture?.data).toBe(png(8, 4).toString('base64'));
  });

  it('gives a text or HTML file’s words, and says when it can’t open a kind of file', async () => {
    const html = await openAttachment(
      file(
        Buffer.from('<html><body><p>Due <b>12 December</b></p><script>x()</script></body></html>'),
        'n.html',
        'text/html',
      ),
      { images: images() },
    );
    expect(html.attachment).toMatchObject({ shows: 'text', text: 'Due 12 December' });
    const csv = await openAttachment(file(Buffer.from('a,b\r\n1,2\r\n'), 'x.csv', 'text/csv'), {
      images: images(),
    });
    expect(csv.attachment.text).toBe('a,b\n1,2\n');
    const zip = await openAttachment(
      file(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0xff, 0xfe]), 'x.zip'),
      {
        images: images(),
      },
    );
    expect(zip.attachment).toMatchObject({ shows: 'none', text: null });
    const empty = await openAttachment(file(Buffer.alloc(0), 'x.pdf'), { images: images() });
    expect(empty.attachment).toMatchObject({ shows: 'none' });
  });

  it('cuts long text at the cap', async () => {
    const opened = await openAttachment(
      file(Buffer.from('x'.repeat(ATTACHMENT_TEXT_CAP + 5)), 'long.txt', 'text/plain'),
      {
        images: images(),
      },
    );
    expect(opened.attachment).toMatchObject({ shows: 'text', truncated: true });
    expect(opened.attachment.text).toHaveLength(ATTACHMENT_TEXT_CAP);
  });
});
