import { describe, expect, it } from 'vitest';
import { Attachment } from '../domain/message.js';
import {
  attachmentUrl,
  formatFileSize,
  runnerAttachmentPath,
  safeDisplayName,
  UploadReserveBody,
  uploadContentUrl,
} from './attachments.js';
import { SendMessageBody } from './conversations.js';

describe('attachment contracts', () => {
  it('keeps only a safe last path segment as the name', () => {
    expect(safeDisplayName('../../etc/passwd')).toBe('passwd');
    expect(safeDisplayName('C:\\Users\\mara\\report.pdf')).toBe('report.pdf');
    expect(safeDisplayName('in\u0007voice\u202e.pdf')).toBe('invoice.pdf');
    expect(safeDisplayName('  ..hidden  ')).toBe('hidden');
    expect(safeDisplayName('a   b\n\tc.txt')).toBe('a b c.txt');
    expect(safeDisplayName('/')).toBe('file');
    const long = `${'x'.repeat(400)}.markdown`;
    const safe = safeDisplayName(long);
    expect([...safe]).toHaveLength(255);
    expect(safe.endsWith('.markdown')).toBe(true);
  });

  it('formats sizes for chips', () => {
    expect(formatFileSize(1)).toBe('1 byte');
    expect(formatFileSize(812)).toBe('812 bytes');
    expect(formatFileSize(2_500)).toBe('2.4 KB');
    expect(formatFileSize(25 * 1024 * 1024)).toBe('25 MB');
    expect(formatFileSize(3 * 1024 ** 3)).toBe('3 GB');
  });

  it('builds stable relative paths', () => {
    expect(attachmentUrl('burrow-hq', 'att_1')).toBe('/api/v1/burrows/burrow-hq/attachments/att_1');
    expect(uploadContentUrl('burrow-hq', 'att_1')).toBe('/api/v1/burrows/burrow-hq/uploads/att_1/content');
    expect(runnerAttachmentPath('dsp_1', 'att_1')).toBe(
      '/internal/runner/dispatches/dsp_1/attachments/att_1',
    );
  });

  it('allows a message with files and no text, never an empty one', () => {
    expect(SendMessageBody.safeParse({ text: '', attachmentIds: ['att_abcdefghijkl'] }).success).toBe(true);
    expect(SendMessageBody.safeParse({ attachmentIds: ['att_abcdefghijkl'] }).success).toBe(false);
    expect(SendMessageBody.safeParse({ text: '  ' }).success).toBe(false);
    expect(SendMessageBody.safeParse({ text: '', attachmentIds: [] }).success).toBe(false);
  });

  it('reservations need a conversation and a positive size; old attachments parse with defaults', () => {
    expect(UploadReserveBody.safeParse({ conversationId: 'cnv_general', name: 'a', size: 0 }).success).toBe(
      false,
    );
    expect(UploadReserveBody.parse({ conversationId: 'cnv_general', name: 'a', size: 3 }).contentType).toBe(
      '',
    );
    expect(
      Attachment.parse({ id: 'att_abcdefghijkl', name: 'a', contentType: 'x/y', size: 1, url: '/a' }),
    ).toMatchObject({ kind: 'file', width: null, height: null });
  });
});
