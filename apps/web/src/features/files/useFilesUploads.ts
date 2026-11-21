/**
 * Uploads into a conversation's Files (docs/decisions/files-space.md AP-775): Upload and drag and drop pick files; each
 * becomes a row that reserves (`uploads.create`), sends its bytes with progress and is saved into the folder that was
 * open (`files.save`) — `uploadToFiles` in @whombat/client. A file larger than the Whombat takes is refused before it
 * starts once a reservation has said the limit (`maxBytes`). Rows belong to their conversation and live outside the
 * component, like the composer's chips, so opening a folder or another page doesn't lose them; saved rows leave after
 * a moment, failed ones stay with Retry and ×.
 */
import {
  type FilesUpload,
  type FilesUploadAction,
  filesUploading,
  filesUploadsReducer,
  tooLargeText,
  UploadError,
  uploadErrorText,
  uploadToFiles,
  type WhombatClient,
} from '@whombat/client';
import { useInvalidateFiles, useWhombat } from '@whombat/client/react';
import { useCallback, useSyncExternalStore } from 'react';

interface Entry {
  items: FilesUpload[];
  files: Map<string, File>;
  aborts: Map<string, AbortController>;
  reserved: Map<string, string>;
}

const spaces = new Map<string, Entry>();
const listeners = new Set<() => void>();
const EMPTY: FilesUpload[] = [];
/** This Whombat's per-file limit, per burrow, once a reservation has said it. */
const limits = new Map<string, number>();
/** How long a saved row stays before it leaves. */
export const SAVED_ROW_MS = 4000;

function entry(conversationId: string): Entry {
  let e = spaces.get(conversationId);
  if (!e) {
    e = { items: [], files: new Map(), aborts: new Map(), reserved: new Map() };
    spaces.set(conversationId, e);
  }
  return e;
}

function dispatch(conversationId: string, action: FilesUploadAction) {
  const e = entry(conversationId);
  e.items = filesUploadsReducer(e.items, action);
  for (const l of listeners) l();
}

let counter = 0;
const localId = () => `fup_${Date.now().toString(36)}_${(counter++).toString(36)}`;

function start(
  client: WhombatClient,
  burrow: string,
  conversationId: string,
  id: string,
  onSaved: () => void,
) {
  const e = entry(conversationId);
  const file = e.files.get(id);
  const item = e.items.find((i) => i.localId === id);
  if (!file || !item) return;
  const controller = new AbortController();
  e.aborts.set(id, controller);
  uploadToFiles(client, {
    burrow,
    conversationId,
    folder: item.folder,
    file: { name: file.name, type: file.type, size: file.size, body: file },
    signal: controller.signal,
    ...(item.attachment && { uploaded: item.attachment }),
    onProgress: (progress) => dispatch(conversationId, { type: 'progress', localId: id, progress }),
    onReserved: (attachmentId, maxBytes) => {
      e.reserved.set(id, attachmentId);
      limits.set(burrow, maxBytes);
    },
    onUploaded: (attachment) => dispatch(conversationId, { type: 'uploaded', localId: id, attachment }),
  })
    .then(() => {
      dispatch(conversationId, { type: 'saved', localId: id });
      e.files.delete(id);
      e.reserved.delete(id);
      onSaved();
      setTimeout(() => dispatch(conversationId, { type: 'dismiss', localId: id }), SAVED_ROW_MS);
    })
    .catch((err: unknown) => {
      if (err instanceof UploadError && err.cancelled) return;
      dispatch(conversationId, { type: 'failed', localId: id, error: uploadErrorText(err) });
    })
    .finally(() => {
      if (e.aborts.get(id) === controller) e.aborts.delete(id);
    });
}

/** Test hook: forget every space's uploads and the known limits. */
export function resetFilesUploads() {
  for (const e of spaces.values()) for (const c of e.aborts.values()) c.abort();
  spaces.clear();
  limits.clear();
  for (const l of listeners) l();
}

export function useFilesUploads(burrow: string, conversationId: string) {
  const { client } = useWhombat();
  const invalidate = useInvalidateFiles();
  const subscribe = useCallback((l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const items = useSyncExternalStore(
    subscribe,
    () => spaces.get(conversationId)?.items ?? EMPTY,
    () => EMPTY,
  );
  const onSaved = useCallback(() => invalidate(conversationId), [invalidate, conversationId]);

  /** Upload `files` into `folder`. */
  const pick = useCallback(
    (files: readonly File[], folder: string) => {
      const max = limits.get(burrow);
      for (const file of files) {
        const id = localId();
        const item = { localId: id, name: file.name || 'file', size: file.size, folder };
        if (max !== undefined && file.size > max) {
          dispatch(conversationId, { type: 'refuse', item, error: tooLargeText(item.name, max) });
          continue;
        }
        entry(conversationId).files.set(id, file);
        dispatch(conversationId, { type: 'add', item });
        start(client, burrow, conversationId, id, onSaved);
      }
    },
    [client, burrow, conversationId, onSaved],
  );

  /** × on a row: stops one in flight and discards its reservation; a failed or saved one just goes. */
  const dismiss = useCallback(
    (id: string) => {
      const e = entry(conversationId);
      const item = e.items.find((i) => i.localId === id);
      e.aborts.get(id)?.abort();
      const reserved = e.reserved.get(id);
      if (reserved && item?.state !== 'saved')
        void client.uploads.discard({ params: { burrow, attachmentId: reserved } }).catch(() => {});
      e.files.delete(id);
      e.reserved.delete(id);
      dispatch(conversationId, { type: 'dismiss', localId: id });
    },
    [client, burrow, conversationId],
  );

  const retry = useCallback(
    (id: string) => {
      dispatch(conversationId, { type: 'retry', localId: id });
      start(client, burrow, conversationId, id, onSaved);
    },
    [client, burrow, conversationId, onSaved],
  );

  /** A refused file (too large) can't be tried again; anything else can. */
  const retryable = useCallback(
    (item: FilesUpload) => !!item.attachment || entry(conversationId).files.has(item.localId),
    [conversationId],
  );

  return { items, pick, dismiss, retry, retryable, uploading: filesUploading(items) };
}
