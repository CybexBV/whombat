/**
 * A job's scratch file whose bytes are encrypted with a one-time key that never leaves memory (docs/decisions/
 * backup-file.md BF-D04): records hold sign-ins in the clear (BF-06), so while a file is made (or restored) they wait on
 * disk only like this — AES-256-GCM under a random key, the tag checked when read back. A crash leaves bytes nobody can
 * read; the sweeper removes them.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type FileHandle, open, rm } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

export class Spool {
  private readonly key = randomBytes(32);
  private readonly iv = randomBytes(12);
  private readonly cipher = createCipheriv('aes-256-gcm', this.key, this.iv);
  private fh: FileHandle | null = null;
  private tag: Buffer | null = null;
  /** Plaintext bytes written. */
  size = 0;

  private constructor(readonly path: string) {}

  static async create(path: string): Promise<Spool> {
    const spool = new Spool(path);
    spool.fh = await open(path, 'wx', 0o600);
    return spool;
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.fh || this.tag) throw new Error('spool: closed');
    if (data.length === 0) return;
    this.size += data.length;
    const out = this.cipher.update(data);
    if (out.length) await this.fh.write(out);
  }

  /** Ends writing (keeps the tag in memory). */
  async close(): Promise<void> {
    if (this.tag || !this.fh) return;
    const out = this.cipher.final();
    if (out.length) await this.fh.write(out);
    this.tag = this.cipher.getAuthTag();
    await this.fh.close();
    this.fh = null;
  }

  /** The plaintext, in pieces; throws at the end when the bytes on disk aren't what was written. */
  async *read(): AsyncGenerator<Buffer> {
    if (!this.tag) throw new Error('spool: still open');
    const d = createDecipheriv('aes-256-gcm', this.key, this.iv);
    d.setAuthTag(this.tag);
    for await (const chunk of createReadStream(this.path, { highWaterMark: 256 * 1024 })) {
      const out = d.update(chunk as Buffer);
      if (out.length) yield out;
    }
    const last = d.final();
    if (last.length) yield last;
  }

  async remove(): Promise<void> {
    await this.fh?.close().catch(() => {});
    this.fh = null;
    this.key.fill(0);
    await rm(this.path, { force: true });
  }
}

/** Splits spooled `.jsonl` bytes back into parsed lines (one record per line). */
export async function* spooledLines(spool: Spool): AsyncGenerator<unknown> {
  let rest = '';
  const utf8 = new StringDecoder('utf8');
  for await (const chunk of spool.read()) {
    const text = rest + utf8.write(chunk);
    const lines = text.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
  }
  rest += utf8.end();
  if (rest.trim()) yield JSON.parse(rest);
}
