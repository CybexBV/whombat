/**
 * Saving a ready backup file on the web (backup-file.md AP-1190): a file can be gigabytes, so it never sits whole in the
 * page's memory where the browser offers anything better.
 *
 * The bytes come through the session:
 *
 * - `picker` — a browser with the File System Access API
 *   (`showSaveFilePicker`, Chromium): the person picks where it goes and every chunk is written there as it arrives.
 * - `private` — the same elsewhere (Firefox, Safari): every chunk is written to the origin's private file system
 *   (`navigator.storage.getDirectory()`), then that disk-backed file is handed to the browser as a download. The copy is
 *   cleared before the next download (the browser may still be reading it from there).
 * - `memory` — a browser with neither: the chunks are kept in memory and saved at the end; fine for the sizes people
 *   usually choose (no messages or files), and the only way left.
 */
import type { BackupFileSink } from '@whombat/client';
import { BACKUP_FILE_CONTENT_TYPE, BACKUP_FILE_EXTENSION } from '@whombat/core/backup';
import { saveBlob } from '../../lib/saveBlob';

export type BackupSaveMethod = 'picker' | 'private' | 'memory';

interface Writable {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface FileHandle {
  createWritable(): Promise<Writable>;
  getFile(): Promise<File>;
}

interface Directory {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
  keys?(): AsyncIterable<string>;
}

type PickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileHandle>;
};

/** How this browser saves a backup file from this session (see the module's notes). */
export function backupSaveMethod(input: { win?: Window } = {}): BackupSaveMethod {
  const win = (input.win ?? window) as PickerWindow;
  if (typeof win.showSaveFilePicker === 'function') return 'picker';
  const storage = win.navigator?.storage as (StorageManager & { getDirectory?: unknown }) | undefined;
  const handle = (win as unknown as { FileSystemFileHandle?: { prototype: object } }).FileSystemFileHandle;
  if (typeof storage?.getDirectory === 'function' && handle && 'createWritable' in handle.prototype)
    return 'private';
  return 'memory';
}

const PRIVATE_PREFIX = 'whombat-backup-';

/**
 * A sink for one download by `method` (not `link`). `picker` asks where to save first — call it straight from the click,
 * before anything else is awaited — and throws `AbortError` when the person closes the picker.
 */
export async function openBackupSink(
  method: BackupSaveMethod,
  name: string,
  win: Window = window,
): Promise<BackupFileSink> {
  if (method === 'picker') {
    const picker = (win as PickerWindow).showSaveFilePicker as NonNullable<
      PickerWindow['showSaveFilePicker']
    >;
    const handle = await picker({
      suggestedName: name,
      types: [
        {
          description: 'Whombat backup file',
          accept: { [BACKUP_FILE_CONTENT_TYPE]: [BACKUP_FILE_EXTENSION] },
        },
      ],
    });
    const out = await handle.createWritable();
    return {
      write: (chunk) => out.write(chunk),
      close: () => out.close(),
      abort: () => out.abort(),
    };
  }
  if (method === 'private') {
    const dir = await (
      win.navigator.storage as unknown as { getDirectory(): Promise<Directory> }
    ).getDirectory();
    // An earlier download's copy (the browser has long finished reading it).
    if (dir.keys)
      for await (const key of dir.keys())
        if (key.startsWith(PRIVATE_PREFIX)) await dir.removeEntry(key).catch(() => {});
    const entry = `${PRIVATE_PREFIX}${Date.now()}${BACKUP_FILE_EXTENSION}`;
    const handle = await dir.getFileHandle(entry, { create: true });
    const out = await handle.createWritable();
    return {
      write: (chunk) => out.write(chunk),
      close: async () => {
        await out.close();
        saveBlob(await handle.getFile(), name, win.document);
      },
      abort: async () => {
        await out.abort().catch(() => {});
        await dir.removeEntry(entry).catch(() => {});
      },
    };
  }
  const parts: Uint8Array[] = [];
  return {
    write: (chunk) => {
      parts.push(chunk.slice());
    },
    close: () =>
      saveBlob(new Blob(parts as BlobPart[], { type: 'application/octet-stream' }), name, win.document),
    abort: () => {
      parts.length = 0;
    },
  };
}
