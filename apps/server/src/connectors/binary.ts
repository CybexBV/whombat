import { createHash } from 'node:crypto';
import { CONNECTOR_BINARY_MAX_BYTES, type ConnectorBinary, type MailAttachmentDigest } from '@whombat/core';
import { badRequest } from '../lib/errors';

export async function boundedBytes(response: Response, max = CONNECTOR_BINARY_MAX_BYTES): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel();
    throw badRequest('The file exceeds the 10 MB transfer limit.');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) throw badRequest('The file exceeds the 10 MB transfer limit.');
      parts.push(chunk.value);
    }
    return Buffer.concat(parts);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function attachmentDigest(file: ConnectorBinary): MailAttachmentDigest {
  const bytes = Buffer.from(file.contentBase64, 'base64');
  return {
    name: file.name,
    mimeType: file.mimeType,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function checkAttachmentTotal(files: readonly ConnectorBinary[]): void {
  if (
    files.length > 10 ||
    files.reduce((n, f) => n + Buffer.from(f.contentBase64, 'base64').length, 0) > CONNECTOR_BINARY_MAX_BYTES
  )
    throw badRequest('Attachments exceed the limit of 10 files and 10 MB.');
}
