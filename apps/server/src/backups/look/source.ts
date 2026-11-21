/**
 * A backup opened for reading as the collectors' source (backup-look.md): its attachments are the file store's copy in
 * `home/files/`, its canvases' states are in its database, and its Hermes homes are packed from `hermes/` here. Nothing
 * of the running Whombat is read and nothing of the backup is written.
 */
import type { HermesHomeRef } from '@whombat/core';
import { initialCanvasState } from '../../collab/document';
import { loadCanvasState } from '../../collab/store';
import type { Db } from '../../db/client';
import type { canvases } from '../../db/schema/index';
import { loadPlan } from '../../read/work';
import type { CollectSource } from '../collect/source';
import { packPeekHome, peekHomeSegments } from './hermes-pack';
import { dirInside, filesUnder, readInside } from './inside';

type CanvasRow = typeof canvases.$inferSelect;

/** A file store key: `sha256/ab/cd/<sha256>`. */
const BLOB_KEY = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

/** Where a blob is in the backup's folders (its `home/files/` is the file store's directory), or null. */
export function peekBlobSegments(key: string): string[] | null {
  const m = BLOB_KEY.exec(key);
  if (!m || !(m[3] as string).startsWith(`${m[1]}${m[2]}`)) return null;
  return ['home', 'files', ...key.split('/')];
}

export function peekSource(db: Db, root: string, scratch: string): CollectSource {
  return {
    async openBlob(key) {
      const segments = peekBlobSegments(key);
      if (!segments) return null;
      return (await readInside(root, segments))?.stream ?? null;
    },
    async canvasState(row: CanvasRow) {
      const stored = await loadCanvasState(db, row.id);
      if (stored.state) return stored.state;
      // Never stored: what a first opening would make of it (nothing is written to the backup).
      const plan = row.planId ? ((await loadPlan(db, row.planId)) ?? null) : null;
      return initialCanvasState(row.markdown, { title: row.title, plan });
    },
    async hermesArchive(home: HermesHomeRef) {
      return packPeekHome(root, home, scratch);
    },
    async skillsCount() {
      const dir = await dirInside(root, peekHomeSegments({ kind: 'skills' }));
      return dir ? skillFolders(dir) : null;
    },
  };
}

/** Skills in a skills folder: the folders holding a `SKILL.md`, at any depth (Hermes groups them by category). */
async function skillFolders(dir: string): Promise<number> {
  const files = await filesUnder(dir, (rel) => rel === 'SKILL.md' || rel.endsWith('/SKILL.md'));
  return files.length;
}
