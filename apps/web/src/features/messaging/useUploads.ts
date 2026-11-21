/**
 * `+ file`, paste and drop (docs/decisions/bp-attachments.md BP-A12): each file becomes a chip that uploads
 * right away with progress (`uploadFile` in @whombat/client: reserve → PUT), can be cancelled, retried or
 * removed, and is sent with the message once ready. Chips belong to their conversation and live outside the
 * component (like drafts), so switching rooms neither loses them nor carries them to another room.
 */
import {
  anyUploading,
  readyAttachmentIds,
  type UploadAction,
  UploadError,
  type UploadItem,
  uploadErrorText,
  uploadFile,
  uploadsReducer,
  type WhombatClient,
} from '@whombat/client';
import { useWhombat } from '@whombat/client/react';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

interface Entry {
  items: UploadItem[];
  files: Map<string, File>;
  aborts: Map<string, AbortController>;
  /** Server ids of reservations, so a cancelled or removed chip can be discarded there too. */
  reserved: Map<string, string>;
}

const rooms = new Map<string, Entry>();
const listeners = new Set<() => void>();
const EMPTY: UploadItem[] = [];

function entry(place: string): Entry {
  let e = rooms.get(place);
  if (!e) {
    e = { items: [], files: new Map(), aborts: new Map(), reserved: new Map() };
    rooms.set(place, e);
  }
  return e;
}

function dispatch(place: string, action: UploadAction) {
  const e = entry(place);
  e.items = uploadsReducer(e.items, action);
  for (const l of listeners) l();
}

let counter = 0;
const localId = () => `upl_${Date.now().toString(36)}_${(counter++).toString(36)}`;

function discard(client: WhombatClient, burrow: string, attachmentId: string) {
  void client.uploads.discard({ params: { burrow, attachmentId } }).catch(() => {});
}

function start(client: WhombatClient, burrow: string, conversationId: string, place: string, id: string) {
  const e = entry(place);
  const file = e.files.get(id);
  if (!file) return;
  const controller = new AbortController();
  e.aborts.set(id, controller);
  uploadFile(client, {
    burrow,
    conversationId,
    file: { name: file.name, type: file.type, size: file.size, body: file },
    signal: controller.signal,
    onProgress: (progress) => dispatch(place, { type: 'progress', localId: id, progress }),
    onReserved: (attachmentId) => e.reserved.set(id, attachmentId),
  })
    .then((attachment) => dispatch(place, { type: 'ready', localId: id, attachment }))
    .catch((err: unknown) => {
      if (err instanceof UploadError && err.cancelled) return;
      dispatch(place, { type: 'failed', localId: id, error: uploadErrorText(err) });
    })
    .finally(() => {
      if (e.aborts.get(id) === controller) e.aborts.delete(id);
    });
}

/** Test hook: forget every room's uploads. */
export function resetUploads() {
  for (const e of rooms.values()) for (const c of e.aborts.values()) c.abort();
  rooms.clear();
  for (const l of listeners) l();
}

/**
 * The chips of a conversation's composer, or of one of its threads' reply box (`threadRootId`, WX-04): each place has
 * its own, uploaded to the conversation.
 */
export function useUploads(burrow: string, conversationId: string, threadRootId?: string | null) {
  const { client } = useWhombat();
  const place = threadRootId ? `${conversationId}#${threadRootId}` : conversationId;
  const subscribe = useCallback((l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const attachments = useSyncExternalStore(
    subscribe,
    () => rooms.get(place)?.items ?? EMPTY,
    () => EMPTY,
  );

  const pick = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const id = localId();
        const e = entry(place);
        e.files.set(id, file);
        dispatch(place, {
          type: 'add',
          item: { localId: id, name: file.name || 'pasted file', size: file.size, mediaType: file.type },
        });
        start(client, burrow, conversationId, place, id);
      }
    },
    [client, burrow, conversationId, place],
  );

  /** × on a chip: stops an upload in flight, and discards it on the server when it was reserved. */
  const remove = useCallback(
    (id: string) => {
      const e = entry(place);
      e.aborts.get(id)?.abort();
      const reserved = e.reserved.get(id);
      if (reserved) discard(client, burrow, reserved);
      e.files.delete(id);
      e.reserved.delete(id);
      dispatch(place, { type: 'remove', localId: id });
    },
    [client, burrow, place],
  );

  const retry = useCallback(
    (id: string) => {
      const e = entry(place);
      const reserved = e.reserved.get(id);
      if (reserved) discard(client, burrow, reserved);
      e.reserved.delete(id);
      dispatch(place, { type: 'retry', localId: id });
      start(client, burrow, conversationId, place, id);
    },
    [client, burrow, conversationId, place],
  );

  /** After a send went through: the sent chips go (their files are on the message now). */
  const clearSent = useCallback(
    (sentIds: readonly string[]) => {
      const e = entry(place);
      for (const item of e.items) {
        if (item.attachment && sentIds.includes(item.attachment.id)) {
          e.files.delete(item.localId);
          e.reserved.delete(item.localId);
          dispatch(place, { type: 'remove', localId: item.localId });
        }
      }
    },
    [place],
  );

  const readyIds = useMemo(() => readyAttachmentIds(attachments), [attachments]);
  return {
    attachments,
    pick,
    remove,
    retry,
    clearSent,
    readyIds,
    uploading: anyUploading(attachments),
  };
}
