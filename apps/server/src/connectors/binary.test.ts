import { describe, expect, it } from 'vitest';
import { attachmentDigest, boundedBytes } from './binary';
import { buildRawMessage } from './mime';

describe('connector binary transfers', () => {
  it('bounds streamed responses even without Content-Length', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
          controller.enqueue(new Uint8Array(5));
          controller.close();
        },
      }),
    );
    await expect(boundedBytes(response, 8)).rejects.toThrow('transfer limit');
  });
  it('binds an attachment approval to its bytes', () => {
    const a = {
      name: 'invoice.pdf',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from('first').toString('base64'),
    };
    expect(attachmentDigest(a).sha256).not.toBe(
      attachmentDigest({ ...a, contentBase64: Buffer.from('other').toString('base64') }).sha256,
    );
  });
  it('builds a multipart email with Unicode filenames and isolated attachment bytes', () => {
    const raw = buildRawMessage({
      to: ['a@example.com'],
      cc: [],
      bcc: [],
      subject: 'Invoice',
      body: 'Attached.',
      attachments: [{ name: 'factuur café.pdf', mimeType: 'application/pdf', contentBase64: 'JVBERg==' }],
    });
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain("filename*=UTF-8''factuur%20caf%C3%A9.pdf");
    expect(raw).toContain('\r\nJVBERg==\r\n');
  });
});
