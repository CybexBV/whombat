/**
 * A person's Hermes memory (hermes-engine.md HE-39, HE-S111): `memories/MEMORY.md` and `memories/USER.md` in their
 * profile, in Hermes's own format (`@whombat/core` `memoryEntries`). Reads need no lock (Hermes
 * replaces the files atomically); writes take the profile's lock, so no Hermes writes in between, and replace the file
 * the way Hermes does (a temporary file renamed over it).
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HERMES_MEMORY_DELIMITER,
  HERMES_MEMORY_LIMITS,
  type HermesHomeArgs,
  type HermesHomeResult,
  type HermesMemoryBoth,
  type HermesMemoryFile,
  type HermesMemoryState,
  memoryChars,
  memoryEntries,
  normalizeMemoryFile,
} from '@whombat/core';

/** What Hermes counts of a file with these entries (code points of the entries joined). */
const charsOf = (entries: readonly string[]) => memoryChars(entries.join(HERMES_MEMORY_DELIMITER));
/** The file's text for these entries, cleaned as Hermes loads them. */
const textOf = (entries: readonly string[]) => normalizeMemoryFile(entries.join(HERMES_MEMORY_DELIMITER));

import { type HermesHomeContext, HermesHomeError } from './context';
import type { AreaHandlers } from './handlers';

const FILE_NAMES: Record<HermesMemoryFile, string> = { memory: 'MEMORY.md', user: 'USER.md' };

/** Where a profile's memory file is. */
export function memoryPath(profile: string, file: HermesMemoryFile): string {
  return join(profile, 'memories', FILE_NAMES[file]);
}

const versionOf = (raw: Buffer) => createHash('sha256').update(raw).digest('hex').slice(0, 16);

/** One file as Hermes would load it now. */
export async function readMemoryFile(profile: string, file: HermesMemoryFile): Promise<HermesMemoryState> {
  const path = memoryPath(profile, file);
  const limit = HERMES_MEMORY_LIMITS[file];
  let raw: Buffer;
  let updatedAt: string;
  try {
    raw = await readFile(path);
    updatedAt = (await stat(path)).mtime.toISOString();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { file, entries: [], chars: 0, limit, version: '', updatedAt: null };
    throw new HermesHomeError('failed', `Can’t read ${FILE_NAMES[file]}.`);
  }
  // Hermes refuses a file that isn't UTF-8 rather than guessing; so does this.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let entries: string[];
  try {
    entries = memoryEntries(text.decode(raw));
  } catch {
    throw new HermesHomeError('failed', `${FILE_NAMES[file]} isn’t UTF-8 text.`);
  }
  return { file, entries, chars: charsOf(entries), limit, version: versionOf(raw), updatedAt };
}

async function readBoth(profile: string): Promise<HermesMemoryBoth> {
  return { memory: await readMemoryFile(profile, 'memory'), user: await readMemoryFile(profile, 'user') };
}

/**
 * Writes a memory file as Hermes does: a temporary file beside it, renamed over it (0600); none for no entries. The
 * temporary file has a name nobody can guess and is always a new one (`wx`): Hermes writes in that folder, and a file
 * or link already at the name would otherwise be written through. `tmp` is for tests.
 */
export async function writeMemoryFile(
  profile: string,
  file: HermesMemoryFile,
  entries: readonly string[],
  tmp = join(profile, 'memories', `.mem_whombat_${process.pid}_${randomBytes(8).toString('hex')}`),
): Promise<void> {
  const path = memoryPath(profile, file);
  const text = textOf(entries);
  if (!text) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(join(profile, 'memories'), { recursive: true, mode: 0o700 });
  await writeFile(tmp, text, { mode: 0o600, flag: 'wx' });
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function read(ctx: HermesHomeContext): Promise<HermesHomeResult<'memory.read'>> {
  return readBoth(ctx.profile);
}

async function write(
  ctx: HermesHomeContext,
  p: HermesHomeArgs<'memory.write'>,
): Promise<HermesHomeResult<'memory.write'>> {
  const entries = memoryEntries(textOf(p.entries));
  const limit = HERMES_MEMORY_LIMITS[p.file];
  if (charsOf(entries) > limit)
    throw new HermesHomeError('too_long', `${FILE_NAMES[p.file]} holds at most ${limit} characters.`);
  return ctx.withProfile(async (profile) => {
    if (p.ifVersion !== undefined) {
      const now = await readMemoryFile(profile, p.file);
      if (now.version !== p.ifVersion)
        throw new HermesHomeError('conflict', `${FILE_NAMES[p.file]} changed since it was read.`);
    }
    await writeMemoryFile(profile, p.file, entries);
    return readMemoryFile(profile, p.file);
  });
}

async function clear(
  ctx: HermesHomeContext,
  p: HermesHomeArgs<'memory.clear'>,
): Promise<HermesHomeResult<'memory.clear'>> {
  return ctx.withProfile(async (profile) => {
    for (const file of p.file ? [p.file] : (['memory', 'user'] as const))
      await rm(memoryPath(profile, file), { force: true });
    return readBoth(profile);
  });
}

export const memoryHandlers: AreaHandlers<'memory.read' | 'memory.write' | 'memory.clear'> = {
  'memory.read': read,
  'memory.write': write,
  'memory.clear': clear,
};
