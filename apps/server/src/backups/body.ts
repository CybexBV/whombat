/**
 * Writing and reading a backup file's body (contracts CT-335): a ustar archive (`TarWriter` / `TarReader`) inside the
 * encrypted container (`container.ts`), streamed — an entry's bytes pass through, never the whole file. The writer
 * hashes what it writes (the file's sha256: ETag and `X-Whombat-Sha256`); the reader checks the entry order
 * (`BackupEntryOrder`) and hands each entry to a visitor, then insists on the archive's end and the last chunk.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  BACKUP_HEADER_BYTES,
  BACKUP_MANIFEST_MAX_BYTES,
  type BackupEntryKind,
  BackupEntryOrder,
  BackupFileError,
  type BackupFileKeys,
  BackupJsonlReader,
  parseBackupHeader,
  TarReader,
  TarWriter,
} from '@whombat/core';
import { NativeBackupDecoder, NativeBackupEncoder, unlockBackup } from './container';

/** Writes entries through the tar writer and the encoder into an open file. */
export class BodyWriter {
  private readonly tar = new TarWriter();
  private readonly encoder: NativeBackupEncoder;
  private readonly hash = createHash('sha256');
  /** Bytes of the file written so far. */
  written = 0;

  constructor(
    private readonly fh: FileHandle,
    keys: BackupFileKeys,
    private readonly mtime: number,
  ) {
    this.encoder = new NativeBackupEncoder(keys);
  }

  private async out(pieces: Buffer[]): Promise<void> {
    for (const p of pieces) {
      if (p.length === 0) continue;
      this.hash.update(p);
      this.written += p.length;
      await this.fh.write(p);
    }
  }

  private plain(data: Uint8Array): Promise<void> {
    return data.length ? this.out(this.encoder.push(data)) : Promise.resolve();
  }

  /** A small entry, whole. */
  async file(name: string, data: Uint8Array): Promise<void> {
    await this.plain(this.tar.file(name, data, this.mtime));
  }

  /** An entry of exactly `size` bytes from `source` (its bytes pass through). */
  async stream(
    name: string,
    size: number,
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<void> {
    await this.plain(this.tar.begin({ name, size, mtime: this.mtime }));
    for await (const chunk of source) await this.plain(this.tar.write(chunk));
    await this.plain(this.tar.end());
  }

  /** The archive's end and the last chunk; the file's size and sha256. */
  async finish(): Promise<{ size: number; sha256: string }> {
    await this.plain(this.tar.finish());
    await this.out(this.encoder.finish());
    return { size: this.written, sha256: this.hash.digest('hex') };
  }
}

/** What a reader does with each entry. Data views are only valid during the call (copy to keep). */
export interface BodyVisitor {
  /** Called once with the manifest's bytes (it is always first). */
  manifest(bytes: Buffer): void | Promise<void>;
  /** `directory.jsonl` and `<category>.jsonl`: each parsed line. */
  record(
    kind: Extract<BackupEntryKind, { kind: 'directory' | 'records' }>,
    value: unknown,
  ): void | Promise<void>;
  /** The start of a byte entry (blob, canvas, repository); return a sink for its bytes, or null to skip them. */
  bytes?(
    kind: Extract<BackupEntryKind, { kind: 'blob' | 'canvas' | 'repository' | 'hosts_backup' }>,
    size: number,
  ): ByteSink | null | Promise<ByteSink | null>;
}

export interface ByteSink {
  write(data: Uint8Array): void | Promise<void>;
  end(): void | Promise<void>;
}

/** Reads `path` to its end with the password: every chunk authenticated, every entry checked and visited. */
export async function readBackupBody(
  path: string,
  password: string,
  visitor: BodyVisitor,
  options: { onBytes?: (n: number) => void } = {},
): Promise<void> {
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  let head = Buffer.alloc(0);
  let decoder: NativeBackupDecoder | null = null;
  const tar = new TarReader();
  const order = new BackupEntryOrder();
  let current: {
    kind: BackupEntryKind;
    jsonl: BackupJsonlReader | null;
    manifest: Buffer[] | null;
    manifestBytes: number;
    sink: ByteSink | null;
  } | null = null;

  const onPlain = async (plain: Buffer) => {
    for (const ev of tar.push(plain)) {
      if (ev.type === 'entry') {
        const kind = order.next(ev.entry.name);
        current = { kind, jsonl: null, manifest: null, manifestBytes: 0, sink: null };
        if (kind.kind === 'manifest') {
          if (ev.entry.size > BACKUP_MANIFEST_MAX_BYTES)
            throw new BackupFileError('damaged', 'manifest too large');
          current.manifest = [];
        } else if (kind.kind === 'directory' || kind.kind === 'records')
          current.jsonl = new BackupJsonlReader();
        else current.sink = visitor.bytes ? await visitor.bytes(kind, ev.entry.size) : null;
      } else if (ev.type === 'data') {
        const c = current as typeof current & {};
        if (c.manifest) {
          c.manifest.push(Buffer.from(ev.data));
        } else if (c.jsonl) {
          for (const v of c.jsonl.push(ev.data))
            await visitor.record(c.kind as Extract<BackupEntryKind, { kind: 'directory' | 'records' }>, v);
        } else if (c.sink) await c.sink.write(ev.data);
      } else {
        const c = current as typeof current & {};
        if (c.manifest) await visitor.manifest(Buffer.concat(c.manifest));
        else if (c.jsonl) {
          for (const v of c.jsonl.finish())
            await visitor.record(c.kind as Extract<BackupEntryKind, { kind: 'directory' | 'records' }>, v);
        } else if (c.sink) await c.sink.end();
        current = null;
      }
    }
  };

  let unlocked = false;
  try {
    for await (const piece of stream) {
      const chunk = piece as Buffer;
      options.onBytes?.(chunk.length);
      if (!unlocked) {
        head = Buffer.concat([head, chunk]);
        if (head.length < BACKUP_HEADER_BYTES) {
          // Fail early on anything that isn't a backup file at all.
          if (head.length >= 12) parseHeaderPrefix(head);
          continue;
        }
        const header = parseBackupHeader(head);
        const keys = await unlockBackup(header, password);
        decoder = new NativeBackupDecoder(keys);
        unlocked = true;
        const rest = head.subarray(BACKUP_HEADER_BYTES);
        head = Buffer.alloc(0);
        for (const p of decoder.push(rest)) await onPlain(p);
        continue;
      }
      for (const p of (decoder as NativeBackupDecoder).push(chunk)) await onPlain(p);
    }
    if (!unlocked) {
      if (head.length === 0) throw new BackupFileError('not_backup_file', 'empty');
      parseHeaderPrefix(head);
      throw new BackupFileError('damaged', 'short file');
    }
    for (const p of (decoder as NativeBackupDecoder).finish()) await onPlain(p);
    tar.finish();
    if (current) throw new BackupFileError('damaged', 'entry incomplete');
  } finally {
    stream.destroy();
  }
}

/** Throws `not_backup_file` / `newer_format` / `damaged` for the first bytes of something that isn't ours. */
function parseHeaderPrefix(bytes: Buffer): void {
  try {
    parseBackupHeader(Buffer.concat([bytes, Buffer.alloc(Math.max(0, BACKUP_HEADER_BYTES - bytes.length))]));
  } catch (err) {
    if (err instanceof BackupFileError && err.code !== 'damaged') throw err;
  }
}
