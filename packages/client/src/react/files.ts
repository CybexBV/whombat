/**
 * Files (contracts 0.49.0 CT-274…, Whombat files-space.md FS-04, FS-07; docs/decisions/files-space.md AP-772…): which
 * conversations hold files the viewer may see, one conversation's Files (every page, so folders group whole), and
 * renaming, moving and removing. Writes put their answer into the list at once; `files.changed` refetches the rest.
 * “Save to Files” on a message's file (contracts 0.59 CT-312, AP-834) marks the message at once.
 */
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileEntry, FilesListResponse } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { SAVE_TO_FILES_FAILED, withInFiles } from '../files';
import type { CallInput, CommitResult, ResponseData } from '../http/types';
import { invalidateFiles, patchMessages } from '../query/apply';
import { patchEndpoint } from '../query/cache';
import { queryKeys } from '../query/keys';
import { useWhombat } from './context';
import { queryHook } from './queries';

/** The conversations with files the viewer may see, newest activity first (`files.summary`). */
export const useFilesSummary = queryHook(api.files.summary);

/** Most pages one space reads (200 files each): beyond 10,000 files the list says it stops there. */
export const FILES_PAGES_MAX = 50;

/** Every file of one conversation's Files (`files.list`, page after page), newest first; `truncated` past the cap. */
export interface FilesList {
  files: FileEntry[];
  truncated: boolean;
}

export function useFilesList(burrow: string, conversationId: string | null) {
  const { client } = useWhombat();
  const params = { burrow, conversationId: conversationId ?? '' };
  return useQuery<FilesList, Error>({
    queryKey: queryKeys.endpoint(api.files.list, { params }),
    enabled: !!conversationId,
    retry: false,
    queryFn: async ({ signal }) => {
      const files: FileEntry[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < FILES_PAGES_MAX; page += 1) {
        const data: FilesListResponse = await client.files.list({
          params,
          query: { limit: 200, ...(cursor ? { cursor } : {}) },
          signal,
        });
        files.push(...data.files);
        cursor = data.nextCursor;
        if (!cursor) return { files, truncated: false };
      }
      return { files, truncated: true };
    },
  });
}

/** The answer's entry in its conversation's list (renamed, moved). */
function putEntry(qc: QueryClient, entry: FileEntry) {
  patchEndpoint<FilesList>(qc, 'files.list', (d, key) => {
    if (key.params.conversationId !== entry.conversationId) return d;
    if (!d.files.some((f) => f.attachment.id === entry.attachment.id)) return d;
    return { ...d, files: d.files.map((f) => (f.attachment.id === entry.attachment.id ? entry : f)) };
  });
}

function dropEntry(qc: QueryClient, conversationId: string, attachmentId: string) {
  patchEndpoint<FilesList>(qc, 'files.list', (d, key) => {
    if (key.params.conversationId !== conversationId) return d;
    const files = d.files.filter((f) => f.attachment.id !== attachmentId);
    return files.length === d.files.length ? d : { ...d, files };
  });
}

/** Rename or move a file (`files.update`); refusals reject as `ApiError` with the Whombat's sentence. */
export function useFileUpdate() {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<
    CommitResult<ResponseData<typeof api.files.update>>,
    Error,
    CallInput<typeof api.files.update>
  >({
    mutationFn: (input) => client.request(api.files.update, input),
    onSuccess: (result) => {
      if (result.status !== 'ok') return;
      putEntry(qc, result.data.file);
      invalidateFiles(qc, result.data.file.conversationId);
    },
  });
}

/** Remove a file from Files (`files.remove`): a saved file is deleted, a message's file only leaves Files (FS-06). */
export function useFileRemove(conversationId: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<
    CommitResult<ResponseData<typeof api.files.remove>>,
    Error,
    CallInput<typeof api.files.remove>
  >({
    mutationFn: (input) => client.request(api.files.remove, input),
    onSuccess: (result, input) => {
      if (result.status !== 'ok') return;
      dropEntry(qc, conversationId, input.params.attachmentId);
      // A message's file is no longer in Files: its message offers Save to Files again (`message.updated` says so too).
      markInFiles(qc, input.params.attachmentId, false);
      invalidateFiles(qc, conversationId);
    },
  });
}

/** Every cached message carrying this file says whether it is in Files (lists, threads, single messages). */
function markInFiles(qc: QueryClient, attachmentId: string, inFiles: boolean) {
  patchMessages({ qc }, (m) => withInFiles(m, attachmentId, inFiles));
}

/**
 * “Save to Files” on a message's file (`files.save` with the message's attachment; contracts 0.59 CT-312, AP-834): the
 * message says “In Files” at once and goes back when the Whombat refuses (rejecting with its `ApiError`, or an `Error`
 * with `SAVE_TO_FILES_FAILED`); the answer refreshes Files. The server's `message.updated` follows for everyone.
 */
export function useSaveMessageFile(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<FileEntry, Error, { attachmentId: string }>({
    mutationFn: async ({ attachmentId }) => {
      const result = await client.files.save({ params: { burrow }, body: { attachmentId } });
      if (result.status !== 'ok') throw new Error(SAVE_TO_FILES_FAILED);
      return result.data.file;
    },
    onMutate: ({ attachmentId }) => markInFiles(qc, attachmentId, true),
    onError: (_error, { attachmentId }) => markInFiles(qc, attachmentId, false),
    onSuccess: (file) => invalidateFiles(qc, file.conversationId),
  });
}

/** After an upload saved into Files: the summary and the list read again. */
export function useInvalidateFiles() {
  const qc = useQueryClient();
  return (conversationId: string | null) => invalidateFiles(qc, conversationId);
}
