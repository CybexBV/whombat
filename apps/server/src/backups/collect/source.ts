/**
 * Where the collectors read the bytes their records point to (docs/decisions/backup-file.md BF-05; backup-look.md): the
 * running Whombat — its file store, its canvases' live documents, its runner's Hermes homes — or a backup opened for
 * reading, whose copies of those sit in the backup's database and folders. The records themselves come from the scope's
 * database either way.
 */
import type { HermesHomeRef } from '@whombat/core';
import type { canvases } from '../../db/schema/index';
import { exportHome, hermesHome } from '../../hermes-home/service';
import type { Services } from '../../services';

type CanvasRow = typeof canvases.$inferSelect;

/** A Hermes home's archive (the runner's format), read once while the body is written. */
export interface HermesArchiveSource {
  sha256: string;
  bytes: number;
  /** Files in it besides its manifest (0: an empty home). */
  files: number;
  read(): AsyncIterable<Uint8Array>;
  /** Drops it without reading it. */
  discard(): Promise<void>;
}

export interface CollectSource {
  /** A blob's bytes by its file store key (`sha256/ab/cd/<sha256>`), or null when it isn't there. */
  openBlob(key: string): Promise<AsyncIterable<Uint8Array> | null>;
  /** A canvas's whole Yjs state. */
  canvasState(row: CanvasRow): Promise<Uint8Array>;
  /** A Hermes home's archive, or null when nothing here can pack it (the collector notes it as unreadable). */
  hermesArchive(home: HermesHomeRef): Promise<HermesArchiveSource | null>;
  /** How many skills the skills folder has, or null when unknown. */
  skillsCount(): Promise<number | null>;
}

/** The running Whombat's own bytes. */
export function liveSource(services: Services): CollectSource {
  return {
    async openBlob(key) {
      return ((await services.files.store.open(key)) as AsyncIterable<Uint8Array> | null) ?? null;
    },
    canvasState: (row) => services.collab.currentState(row),
    async hermesArchive(home) {
      const exec = hermesHome(services);
      // Without a runner to ask, the file leaves the home out and says so.
      if (!exec.runnerSeen) return null;
      return exportHome(exec, home);
    },
    async skillsCount() {
      const listed = await hermesHome(services)
        .call('skills.list', {})
        .catch(() => null);
      return listed ? listed.skills.length : null;
    },
  };
}
