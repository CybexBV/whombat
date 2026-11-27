/**
 * Files on the phone, the hooks (files-space.md FS-04, FS-07; AP-772…): whether Files is here at all, and uploads into
 * a conversation's Files.
 *
 * `useFilesSpace`: the Whombat has `files.space`, and this isn't the demo world — it has no file access (no token)
 * and no uploads, so its Files would be a list nothing in opens; there Files stays hidden.
 *
 * Uploads into a conversation's Files on the phone (files-space.md FS-04 `files.save`; AP-772…): the shared state
 * machine (`filesUploadsReducer`) and `uploadToFiles` (reserve → bytes → save into the folder), the picked file
 * streamed as the composer streams it (bp-attachments.md BP-A17: one native PUT on a legacy server, chunks by offset
 * through the session on a managed Whombat). Once a reservation has said how large a file this Whombat takes, larger
 * picks are refused before anything is sent (`tooLargeText`). × cancels a row in flight and discards what was reserved;
 * Retry after a failed save only saves again. Saved rows leave a few seconds after the last one is done; leaving the
 * screen stops what is still going.
 *
 * `useMessageFiles`: “Save to Files” on a message's files (contracts 0.59 CT-312, files-space.md AP-840), as on the web.
 */
import {
  type FilesUpload,
  filesErrorText,
  filesUploading,
  filesUploadsReducer,
  type SaveToFilesAction,
  saveActionOf,
  saveToFilesFailed,
  tooLargeText,
  UploadError,
  uploadErrorText,
  uploadToFiles,
} from '@whombat/client';
import { useInvalidateFiles, useSaveMessageFile, useWhombat } from '@whombat/client/react';
import type { Attachment } from '@whombat/core';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { expoFileApi } from '../managed/expoFiles';
import { fileChunkSource } from '../managed/files';
import type { PickedFile } from './attachments';
import { useBurrowBase } from './BurrowProvider';
import { filesCopy } from './filesCopy';

/** Files is on this Whombat for this app (`files.space`; never in the demo world). */
export function useFilesSpace(): boolean {
  const { mode } = useBurrowBase();
  return mode !== 'fixtures';
}

/** What a message's files offer besides Download (AP-840); `MessageAttachmentsView` draws it. */
export interface MessageFileActions {
  /** “Save to Files”, “In Files” or nothing for this file (`saveActionOf`). */
  actionOf: (attachment: Attachment) => SaveToFilesAction | null;
  /** Saves on their way (the button says so). */
  busy: ReadonlySet<string>;
  /** In Files at once, back with the Whombat's words when it refuses. */
  save: (attachment: Attachment) => void;
  /** The conversation's Files. */
  open: () => void;
}

/**
 * Save to Files for one conversation's messages (contracts 0.59 CT-312, `files.save_from_messages`; AP-840): null where
 * the Whombat can't (or in the demo world, which has no Files). `notice` says “Saved to Files” or why it didn't go.
 */
export function useMessageFiles(
  conversationId: string | null,
  { onOpen, notice }: { onOpen: (conversationId: string) => void; notice: (text: string) => void },
): MessageFileActions | null {
  const { slug, mode } = useBurrowBase();
  const { rawLocale } = useI18n();
  const saves = mode !== 'fixtures' && !!conversationId;
  const { mutateAsync } = useSaveMessageFile(slug);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const latest = useRef({ onOpen, notice, locale: rawLocale });
  latest.current = { onOpen, notice, locale: rawLocale };
  const save = useCallback(
    (attachment: Attachment) => {
      const id = attachment.id;
      setBusy((b) => new Set(b).add(id));
      // One promise per tap (`mutate`'s own callbacks hear only the latest of two saves at once).
      void mutateAsync({ attachmentId: id })
        .then(
          () => latest.current.notice(filesCopy(latest.current.locale).savedNote),
          (error: unknown) =>
            latest.current.notice(filesErrorText(error, saveToFilesFailed(latest.current.locale))),
        )
        .finally(() =>
          setBusy((b) => {
            const next = new Set(b);
            next.delete(id);
            return next;
          }),
        );
    },
    [mutateAsync],
  );
  return useMemo(
    () =>
      saves && conversationId
        ? {
            actionOf: (attachment: Attachment) => saveActionOf(attachment),
            busy,
            save,
            open: () => latest.current.onOpen(conversationId),
          }
        : null,
    [saves, conversationId, busy, save],
  );
}

let counter = 0;
const localId = () => `fls_${Date.now().toString(36)}_${(counter++).toString(36)}`;

/** How long the last “Saved · 2.4 MB” rows stay. */
const SAVED_LINGER_MS = 4000;

export function useFilesUploads(burrow: string, conversationId: string | null) {
  const { client } = useWhombat();
  const { rawLocale } = useI18n();
  const locale = useRef(rawLocale);
  locale.current = rawLocale;
  const invalidate = useInvalidateFiles();
  const [items, dispatch] = useReducer(filesUploadsReducer, []);
  const files = useRef(new Map<string, PickedFile>());
  const aborts = useRef(new Map<string, AbortController>());
  const reserved = useRef(new Map<string, string>());
  /** This Whombat's per-file limit, once a reservation has said it. */
  const maxBytes = useRef<number | null>(null);
  const latest = useRef(items);
  latest.current = items;

  const discard = useCallback(
    (id: string) => {
      const attachmentId = reserved.current.get(id);
      reserved.current.delete(id);
      if (attachmentId) void client.uploads.discard({ params: { burrow, attachmentId } }).catch(() => {});
    },
    [client, burrow],
  );

  const start = useCallback(
    (id: string, folder: string) => {
      const file = files.current.get(id);
      if (!file || !conversationId) return;
      const uploaded = latest.current.find((i) => i.localId === id)?.attachment ?? undefined;
      const controller = new AbortController();
      aborts.current.set(id, controller);
      void (async () => {
        // Chunks read by offset through the session (AP-13).
        const source = fileChunkSource(expoFileApi, file, locale.current);
        try {
          await uploadToFiles(client, {
            burrow,
            conversationId,
            folder,
            file: { name: file.name, type: file.type, size: file.size, read: source.read },
            ...(uploaded ? { uploaded } : {}),
            signal: controller.signal,
            onProgress: (progress) => dispatch({ type: 'progress', localId: id, progress }),
            onReserved: (attachmentId, limit) => {
              reserved.current.set(id, attachmentId);
              if (limit > 0) maxBytes.current = limit;
            },
            onUploaded: (attachment) => dispatch({ type: 'uploaded', localId: id, attachment }),
          });
          // Saved into Files: no longer an unsent upload to discard.
          reserved.current.delete(id);
          files.current.delete(id);
          dispatch({ type: 'saved', localId: id });
          invalidate(conversationId);
        } catch (err) {
          if (err instanceof UploadError && err.cancelled) return;
          dispatch({ type: 'failed', localId: id, error: uploadErrorText(err, locale.current) });
        } finally {
          source?.close();
          if (aborts.current.get(id) === controller) aborts.current.delete(id);
        }
      })();
    },
    [client, burrow, conversationId, invalidate],
  );

  /** Picked files go up into `folder`; one larger than this Whombat takes is refused at once. */
  const add = useCallback(
    (picked: readonly PickedFile[], folder: string) => {
      dispatch({ type: 'clearSaved' });
      for (const file of picked) {
        const id = localId();
        const item = { localId: id, name: file.name, size: file.size, folder };
        const limit = maxBytes.current;
        if (limit !== null && file.size > limit) {
          dispatch({ type: 'refuse', item, error: tooLargeText(file.name, limit, locale.current) });
          continue;
        }
        files.current.set(id, file);
        dispatch({ type: 'add', item });
        start(id, folder);
      }
    },
    [start],
  );

  /** × on a row: cancels it in flight and discards what was reserved (a saved file stays saved). */
  const dismiss = useCallback(
    (id: string) => {
      const item = latest.current.find((i) => i.localId === id);
      aborts.current.get(id)?.abort();
      if (item?.state !== 'saved') discard(id);
      files.current.delete(id);
      dispatch({ type: 'dismiss', localId: id });
    },
    [discard],
  );

  /** Try again: the save alone when the bytes are up, else the whole upload. */
  const retry = useCallback(
    (id: string) => {
      const item = latest.current.find((i) => i.localId === id);
      if (item?.state !== 'failed' || !files.current.has(id)) return;
      if (!item.attachment) discard(id);
      dispatch({ type: 'retry', localId: id });
      start(id, item.folder);
    },
    [discard, start],
  );

  /** Whether a failed row offers Try again (a refused one has nothing to send). */
  const canRetry = useCallback((item: FilesUpload) => files.current.has(item.localId), []);

  // The last saved rows leave a moment after everything is done.
  const busy = filesUploading(items);
  const anySaved = items.some((i) => i.state === 'saved');
  useEffect(() => {
    if (busy || !anySaved) return;
    const timer = setTimeout(() => dispatch({ type: 'clearSaved' }), SAVED_LINGER_MS);
    return () => clearTimeout(timer);
  }, [busy, anySaved]);

  // Another conversation, or leaving: stop what is in flight and discard what it reserved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs again for every conversation
  useEffect(() => {
    const inFlight = aborts.current;
    const held = reserved.current;
    return () => {
      for (const c of inFlight.values()) c.abort();
      inFlight.clear();
      for (const attachmentId of held.values())
        void client.uploads.discard({ params: { burrow, attachmentId } }).catch(() => {});
      held.clear();
      files.current.clear();
      for (const i of latest.current) dispatch({ type: 'dismiss', localId: i.localId });
    };
  }, [conversationId]);

  return { items, add, dismiss, retry, canRetry, busy };
}
