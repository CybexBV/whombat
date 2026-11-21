/**
 * The server's native container (backup-file.md BF-D02) is core's byte for byte (contracts CT-335): what one seals the
 * other opens, a changed or cut file is `damaged`, and the body reader checks the password and the archive.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BackupFileDecoder,
  BackupFileEncoder,
  BackupFileError,
  backupEntryName,
  encodeBackupLine,
  isBackupFileError,
} from '@whombat/core';
import { afterAll, describe, expect, it } from 'vitest';
import { BodyWriter, readBackupBody } from './body';
import { NativeBackupDecoder, NativeBackupEncoder, newBackupKeys } from './container';
import { Spool, spooledLines } from './spool';

const SMALL = { memoryKiB: 64, passes: 1, parallelism: 1 };
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'whombat-backup-unit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const keys = () =>
  newBackupKeys('a password long enough', {
    params: SMALL,
    chunkBytes: 1024,
    salt: new Uint8Array(16).fill(7),
    noncePrefix: new Uint8Array(16).fill(9),
  });

const join8 = (parts: Uint8Array[]) => Buffer.concat(parts.map((p) => Buffer.from(p)));

describe('the native container', () => {
  it('seals exactly what core seals, and each opens the other', async () => {
    const k = await keys();
    for (const size of [0, 1, 1024, 2500, 10_000]) {
      const plain = Buffer.alloc(size, 0x5a);
      const native = new NativeBackupEncoder(k);
      const core = new BackupFileEncoder(k);
      const a = join8([...native.push(plain), ...native.finish()]);
      const b = join8([...core.push(plain), ...core.finish()]);
      expect(a.equals(b), `size ${size}`).toBe(true);
      const body = a.subarray(110);
      const coreDec = new BackupFileDecoder(k);
      expect(join8([...coreDec.push(body), ...coreDec.finish()]).equals(plain)).toBe(true);
      const nativeDec = new NativeBackupDecoder(k);
      expect(join8([...nativeDec.push(body), ...nativeDec.finish()]).equals(plain)).toBe(true);
    }
  });

  it('finds a changed byte and a cut-off end damaged', async () => {
    const k = await keys();
    const enc = new NativeBackupEncoder(k);
    const file = join8([...enc.push(Buffer.alloc(5000, 1)), ...enc.finish()]);
    const changed = Buffer.from(file.subarray(110));
    changed[2000] = (changed[2000] as number) ^ 1;
    expect(() => {
      const d = new NativeBackupDecoder(k);
      d.push(changed);
      d.finish();
    }).toThrow(BackupFileError);
    const cut = file.subarray(110, file.length - 1040);
    try {
      const d = new NativeBackupDecoder(k);
      d.push(cut);
      d.finish();
      throw new Error('opened');
    } catch (err) {
      expect(isBackupFileError(err) && err.code).toBe('damaged');
    }
  });
});

describe('the body', () => {
  async function write(path: string) {
    const k = await newBackupKeys('a password long enough', { params: SMALL });
    const fh = await open(path, 'w');
    const w = new BodyWriter(fh, k, 0);
    await w.file(backupEntryName.manifest, Buffer.from('{"format":"whombat.backup-file/1"}'));
    await w.file(backupEntryName.directory, encodeBackupLine({ type: 'burrow', id: 'bur_a' }));
    await w.file(backupEntryName.records('agents'), encodeBackupLine({ type: 'agent', id: 'prn_a' }));
    const blob = Buffer.from('bytes of a file');
    const sha = (await import('node:crypto')).createHash('sha256').update(blob).digest('hex');
    await w.stream(backupEntryName.blob(sha), blob.length, [blob]);
    const out = await w.finish();
    await fh.close();
    return { out, sha };
  }

  it('reads back what was written, entry by entry', async () => {
    const path = join(dir, 'a.wbk');
    const { sha } = await write(path);
    const seen: string[] = [];
    let blob = '';
    await readBackupBody(path, 'a password long enough', {
      manifest: (b) => {
        seen.push(`manifest:${b.toString()}`);
      },
      record: (kind, v) => {
        seen.push(`${kind.kind}:${JSON.stringify(v)}`);
      },
      bytes: (kind) =>
        kind.kind === 'blob' && kind.sha256 === sha
          ? {
              write: (d) => {
                blob += Buffer.from(d).toString();
              },
              end: () => {},
            }
          : null,
    });
    expect(seen).toEqual([
      'manifest:{"format":"whombat.backup-file/1"}',
      'directory:{"type":"burrow","id":"bur_a"}',
      'records:{"type":"agent","id":"prn_a"}',
    ]);
    expect(blob).toBe('bytes of a file');
  });

  it('tells a wrong password, another file and an empty one apart', async () => {
    const path = join(dir, 'b.wbk');
    await write(path);
    const codeOf = async (p: string, pw = 'a password long enough') => {
      try {
        await readBackupBody(p, pw, { manifest: () => {}, record: () => {} });
        return 'ok';
      } catch (err) {
        return isBackupFileError(err) ? err.code : String(err);
      }
    };
    expect(await codeOf(path, 'not this password')).toBe('wrong_password');
    writeFileSync(
      join(dir, 'c.wbk'),
      'just some text, not a backup file at all, long enough to have a header',
    );
    expect(await codeOf(join(dir, 'c.wbk'))).toBe('not_backup_file');
    writeFileSync(join(dir, 'd.wbk'), '');
    expect(await codeOf(join(dir, 'd.wbk'))).toBe('not_backup_file');
  });
});

describe('a spool', () => {
  it('keeps lines encrypted on disk and gives them back, even split inside a character', async () => {
    const spool = await Spool.create(join(dir, 'lines.jsonl'));
    const line = encodeBackupLine({ type: 'note', text: 'Grüße — ✓' });
    await spool.write(line.subarray(0, 12));
    await spool.write(line.subarray(12));
    await spool.write(encodeBackupLine({ type: 'note', text: 'second' }));
    await spool.close();
    const raw = (await import('node:fs')).readFileSync(join(dir, 'lines.jsonl'));
    expect(raw.includes(Buffer.from('Grüße'))).toBe(false);
    const back: unknown[] = [];
    for await (const v of spooledLines(spool)) back.push(v);
    expect(back).toEqual([
      { type: 'note', text: 'Grüße — ✓' },
      { type: 'note', text: 'second' },
    ]);
    await spool.remove();
  });
});
