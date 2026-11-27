/**
 * The composer's uploads on mobile (docs/decisions/bp-attachments.md BP-A14, BP-A17, BP-A18): the shared state
 * machine from @whombat/client, the picked file streamed from its URI by expo-file-system (never read into
 * JS) and PUT with the bearer token and progress (`uploadFile` over `FileUploadRequest`), cancel / retry /
 * remove per chip. On a managed Whombat (AP-13, AP-27) the same file goes through the appliance session instead:
 * read by offset through an expo-file-system handle, 256 KiB at a time, sha256-checked and resumable — never the
 * legacy HTTP path. Failures that can never succeed (too big, storage full, not an image we can show) offer
 * Remove only. One conversation's chips; a new conversation starts empty.
 */
import {
  readyAttachmentIds,
  UploadError,
  uploadErrorText,
  uploadFile,
  uploadsReducer,
} from '@whombat/client';
import { useWhombat } from '@whombat/client/react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { expoFileApi } from '../managed/expoFiles';
import { fileChunkSource } from '../managed/files';
import { type PickedFile, uploadRetryable } from './attachments';

let counter = 0;
const localId = () => `upl_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export function useComposerUploads(burrow: string, conversationId: string | null) {
  const { client } = useWhombat();
  const { rawLocale } = useI18n();
  const locale = useRef(rawLocale);
  locale.current = rawLocale;
  const [items, dispatch] = useReducer(uploadsReducer, []);
  // Chips whose failure a retry cannot fix (Remove only).
  const [final, setFinal] = useState<ReadonlySet<string>>(() => new Set());
  const files = useRef(new Map<string, PickedFile>());
  const aborts = useRef(new Map<string, AbortController>());
  const reserved = useRef(new Map<string, string>());

  const markFinal = useCallback((id: string, isFinal: boolean) => {
    setFinal((prev) => {
      if (prev.has(id) === isFinal) return prev;
      const next = new Set(prev);
      if (isFinal) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const discard = useCallback(
    (id: string) => {
      const attachmentId = reserved.current.get(id);
      reserved.current.delete(id);
      if (attachmentId) void client.uploads.discard({ params: { burrow, attachmentId } }).catch(() => {});
    },
    [client, burrow],
  );

  const start = useCallback(
    (id: string) => {
      const file = files.current.get(id);
      if (!file || !conversationId) return;
      const controller = new AbortController();
      aborts.current.set(id, controller);
      void (async () => {
        // Chunks read by offset through the session (AP-13).
        const source = fileChunkSource(expoFileApi, file, locale.current);
        try {
          const attachment = await uploadFile(client, {
            burrow,
            conversationId,
            file: { name: file.name, type: file.type, size: file.size, read: source.read },
            signal: controller.signal,
            onProgress: (progress) => dispatch({ type: 'progress', localId: id, progress }),
            onReserved: (attachmentId) => reserved.current.set(id, attachmentId),
          });
          dispatch({ type: 'ready', localId: id, attachment });
        } catch (err) {
          if (err instanceof UploadError && err.cancelled) return;
          markFinal(id, !uploadRetryable(err));
          dispatch({ type: 'failed', localId: id, error: uploadErrorText(err, locale.current) });
        } finally {
          source?.close();
          if (aborts.current.get(id) === controller) aborts.current.delete(id);
        }
      })();
    },
    [client, burrow, conversationId, markFinal],
  );

  const add = useCallback(
    (picked: readonly PickedFile[]) => {
      for (const file of picked) {
        const id = localId();
        files.current.set(id, file);
        dispatch({
          type: 'add',
          item: { localId: id, name: file.name, size: file.size, mediaType: file.type },
        });
        start(id);
      }
    },
    [start],
  );

  /** × on a chip: cancels an upload in flight and discards what the server reserved. */
  const remove = useCallback(
    (id: string) => {
      aborts.current.get(id)?.abort();
      discard(id);
      files.current.delete(id);
      markFinal(id, false);
      dispatch({ type: 'remove', localId: id });
    },
    [discard, markFinal],
  );

  const retry = useCallback(
    (id: string) => {
      discard(id);
      markFinal(id, false);
      dispatch({ type: 'retry', localId: id });
      start(id);
    },
    [discard, start, markFinal],
  );

  /** Whether a failed chip offers Retry (not for a file that can never go up as it is). */
  const canRetry = useCallback((id: string) => !final.has(id), [final]);

  /** After a send: the sent chips go. */
  const clearSent = useCallback(
    (ids: readonly string[]) => {
      for (const item of items)
        if (item.attachment && ids.includes(item.attachment.id)) {
          files.current.delete(item.localId);
          reserved.current.delete(item.localId);
          dispatch({ type: 'remove', localId: item.localId });
        }
    },
    [items],
  );

  // Another conversation: stop what is in flight here and start empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs again for every conversation
  useEffect(() => {
    const inFlight = aborts.current;
    return () => {
      for (const c of inFlight.values()) c.abort();
      inFlight.clear();
      files.current.clear();
      reserved.current.clear();
      setFinal(new Set());
      dispatch({ type: 'clear' });
    };
  }, [conversationId]);

  const readyIds = useMemo(() => readyAttachmentIds(items), [items]);
  return { items, add, remove, retry, canRetry, clearSent, readyIds };
}
