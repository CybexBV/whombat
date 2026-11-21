/**
 * A backup's copy of a Hermes home, packed the way the runner packs a running one (hermes-engine.md HE-S114;
 * backup-look.md): the same manifest, the same `home/` prefix and the same files (`hermesArchiveIncludes`), so the backup
 * file's restorer hands it to the runner (`fill`: only what is missing here is added). The backup service keeps the
 * Hermes root under `hermes/`: the person's home is the root itself, the outsiders' `profiles/_feedback`, the skills
 * `skills/`. Read without following a symlink, written into the look's scratch.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import {
  HERMES_FEEDBACK_PROFILE,
  HERMES_HOME_ENTRIES,
  HERMES_HOME_FORMAT,
  HERMES_HOME_MANIFEST,
  HERMES_HOME_PREFIX,
  HERMES_PIN,
  type HermesHomeManifest,
  hermesArchiveIncludes,
} from '@whombat/agent-runtime';
import { HERMES_HOME_ARCHIVE_MAX_BYTES, type HermesHomeRef } from '@whombat/core';
import { isSafeTarPath, TarWriter } from '@whombat/core/backup';
import type { HermesArchiveSource } from '../collect/source';
import { dirInside, filesUnder, openInside } from './inside';

/** Where a home is inside the backup's `hermes/` folder. */
export function peekHomeSegments(home: HermesHomeRef): string[] {
  if (home.kind === 'skills') return ['hermes', 'skills'];
  return home.home === 'person' ? ['hermes'] : ['hermes', 'profiles', HERMES_FEEDBACK_PROFILE];
}

/** The files of a home in the backup that its archive takes; empty when the backup has none of it. */
export async function peekHomeFiles(root: string, home: HermesHomeRef) {
  const dir = await dirInside(root, peekHomeSegments(home));
  if (!dir) return { dir: null, files: [] };
  const kind = home.kind;
  const files = await filesUnder(
    dir,
    (rel) => hermesArchiveIncludes(kind, rel) && isSafeTarPath(`${HERMES_HOME_PREFIX}${rel}`),
    // A profile's archive holds only its own entries (never the skills folder or the outsiders' profile inside it).
    (rel) => kind === 'skills' || HERMES_HOME_ENTRIES.includes(rel.split('/')[0] ?? ''),
  );
  return { dir, files };
}

/** Packs a home of the backup into `scratch`; its archive, read once. */
export async function packPeekHome(
  root: string,
  home: HermesHomeRef,
  scratch: string,
): Promise<HermesArchiveSource> {
  const { dir, files } = await peekHomeFiles(root, home);
  const name = home.kind === 'skills' ? 'skills' : home.home;
  const path = join(scratch, `hermes-${name}.tgz`);
  const manifest: HermesHomeManifest = {
    format: HERMES_HOME_FORMAT,
    kind: home.kind,
    hermes: HERMES_PIN.version,
    exec: files.filter((f) => f.exec).map((f) => f.rel),
  };
  const tar = new TarWriter();
  async function* body(): AsyncGenerator<Uint8Array> {
    yield tar.file(
      HERMES_HOME_MANIFEST,
      new TextEncoder().encode(JSON.stringify(manifest)),
      Math.floor(Date.now() / 1000),
    );
    for (const f of files) {
      const fh = dir ? await openInside(dir, f.rel.split('/')) : null;
      if (!fh) throw new Error(`${f.rel} went away while it was packed`);
      try {
        yield tar.begin({ name: `${HERMES_HOME_PREFIX}${f.rel}`, size: f.size, mtime: f.mtime });
        let n = 0;
        for await (const chunk of fh.createReadStream({ autoClose: false }) as AsyncIterable<Buffer>) {
          n += chunk.length;
          if (n > f.size) throw new Error(`${f.rel} is longer than it was`);
          yield tar.write(chunk);
        }
        if (n !== f.size) throw new Error(`${f.rel} is shorter than it was`);
        yield tar.end();
      } finally {
        await fh.close();
      }
    }
    yield tar.finish();
  }
  const hash = createHash('sha256');
  let bytes = 0;
  async function* counted(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > HERMES_HOME_ARCHIVE_MAX_BYTES) throw new Error('the home is too large to bring back');
      hash.update(chunk);
      yield chunk;
    }
  }
  await pipeline(body, createGzip(), counted, createWriteStream(path, { mode: 0o600 }));
  const discard = () => rm(path, { force: true }).catch(() => {});
  return {
    sha256: hash.digest('hex'),
    bytes,
    files: files.length,
    read: () => createReadStream(path) as AsyncIterable<Uint8Array>,
    discard,
  };
}
