/**
 * Reads the files in a zip (a service's own export, such as Pi-hole's Teleporter file) to compare what they hold. Only
 * what such an export uses: stored or deflated files, no encryption, no zip64. Anything else, or more than the limits
 * allow, is read as nothing (null), so a copy is never called the same as another on what couldn't be read.
 */
import { inflateRawSync } from 'node:zlib';

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The most files read from one zip, and the most bytes they may hold together. */
const FILES_MAX = 500;
const BYTES_MAX = 64 * 1024 * 1024;

/**
 * The files in `zip` by name (folders left out), each as its bytes. `skip` names files left out without being read (a
 * large one that is compared another way). Null when the zip can't be read whole.
 */
export function zipFiles(
  zip: Buffer,
  skip: (name: string) => boolean = () => false,
): Map<string, Buffer> | null {
  // The end record is the last thing in the file, after a comment of at most 65,535 bytes.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--)
    if (zip.readUInt32LE(i) === END) {
      end = i;
      break;
    }
  if (end < 0) return null;
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  if (count === 0xffff || count > FILES_MAX || at === 0xffffffff || at > end) return null;
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || zip.readUInt32LE(at) !== CENTRAL) return null;
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (name.endsWith('/') || skip(name)) continue;
    if (flags & 1 || (method !== 0 && method !== 8) || packed === 0xffffffff || size === 0xffffffff)
      return null;
    total += size;
    if (total > BYTES_MAX || local + 30 > zip.length || zip.readUInt32LE(local) !== LOCAL) return null;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + packed > zip.length) return null;
    const raw = zip.subarray(start, start + packed);
    let bytes: Buffer;
    try {
      bytes = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
    } catch {
      return null;
    }
    if (bytes.length !== size) return null;
    out.set(name, bytes);
  }
  return out;
}
