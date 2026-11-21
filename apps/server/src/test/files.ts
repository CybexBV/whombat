/**
 * Test helpers for attachments: tiny real PNGs, and reserving + uploading as a person (the in-process caller,
 * `test/api.ts`: the reserve endpoint, then the bytes as a session's upload stream carries them).
 */
import { crc32, deflateSync } from 'node:zlib';
import { api, buildPath } from '@whombat/core';
import type { InProcessApi } from './api';

/** Who uploads: the in-process caller (`t.api`, `inProcessApi`). */
type Caller = Pick<InProcessApi, 'inject'>;

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid RGB PNG of the given size, filled with one color. */
export function makePng(
  width: number,
  height: number,
  rgb: [number, number, number] = [200, 120, 40],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const BURROW = 'burrow-hq';

export function uploadsPath(): string {
  return `${api.uploads.create.base}${buildPath(api.uploads.create.path, { burrow: BURROW })}`;
}

/** Reserves an upload as `auth` (cookie or bearer header). Returns the raw response. */
export async function reserve(
  app: Caller,
  auth: Record<string, string>,
  body: { conversationId: string; name: string; contentType?: string; size: number },
) {
  return app.inject({ method: 'POST', url: uploadsPath(), headers: auth, payload: body });
}

/** Reserve + PUT: the ready attachment (throws on any failure). */
export async function upload(
  app: Caller,
  auth: Record<string, string>,
  conversationId: string,
  name: string,
  bytes: Buffer,
  contentType = 'application/octet-stream',
) {
  const res = await reserve(app, auth, { conversationId, name, contentType, size: bytes.length });
  if (res.statusCode !== 201) throw new Error(`reserve ${res.statusCode}: ${res.body}`);
  const reserved = res.json() as { attachment: { id: string; url: string }; uploadUrl: string };
  const put = await app.inject({
    method: 'PUT',
    url: reserved.uploadUrl,
    headers: { ...auth, 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
  if (put.statusCode !== 200) throw new Error(`put ${put.statusCode}: ${put.body}`);
  return (
    put.json() as {
      attachment: {
        id: string;
        url: string;
        kind: string;
        contentType: string;
        width: number | null;
        height: number | null;
        thumbnailUrl?: string | null;
        thumbnailWidth?: number | null;
        thumbnailHeight?: number | null;
      };
    }
  ).attachment;
}
