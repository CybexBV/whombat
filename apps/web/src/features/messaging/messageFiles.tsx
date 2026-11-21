/**
 * “Save to Files” on a message's files (contracts 0.59 CT-312, feature `files.save_from_messages`; docs/decisions/
 * files-space.md AP-834…): what a message's attachments need to offer it, from one place for the whole burrow — the
 * conversation list, the thread pane and a report's details all show messages. `MessageAttachments` reads it; outside
 * this provider (Files' own viewer, tests, stories) there is no Save to Files, only Download.
 */
import { conversationFilesPath, FILES_COPY, filesErrorText, SAVE_TO_FILES_FAILED } from '@whombat/client';
import { useBootstrap, useSaveMessageFile } from '@whombat/client/react';
import type { Attachment } from '@whombat/core';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { useToast } from '../../components/Toast';

export interface MessageFiles {
  /** Saves are on their way (the button says so, `aria-busy`). */
  busy: ReadonlySet<string>;
  /** “Save to Files”: the message says “In Files” at once, back with the Whombat's words in a toast if it refuses. */
  save: (attachment: Attachment, conversationId: string) => void;
  /** A conversation's Files (`/files/c/billing-v2`). */
  filesHref: (conversationId: string) => string;
  openFiles: (conversationId: string) => void;
}

const MessageFilesContext = createContext<MessageFiles | null>(null);

/** Save to Files for the messages shown here; null outside a burrow's screens. */
export function useMessageFiles(): MessageFiles | null {
  return useContext(MessageFilesContext);
}

/** Lets tests and stories give the attachments a hand-made `MessageFiles`. */
export const MessageFilesValue = MessageFilesContext.Provider;

export function MessageFilesProvider({ burrow, children }: { burrow: string; children: ReactNode }) {
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const navigate = useNavigateHref();
  const toast = useToast();
  const mutation = useSaveMessageFile(burrow);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  // The bootstrap changes with every sidebar bump: read it when asked, so the attachments don't draw again for it.
  const bootstrapRef = useRef(bootstrap);
  bootstrapRef.current = bootstrap;
  const filesHref = useCallback(
    (conversationId: string) => conversationFilesPath(conversationId, bootstrapRef.current),
    [],
  );
  const openFiles = useCallback(
    (conversationId: string) => navigate(filesHref(conversationId)),
    [navigate, filesHref],
  );
  // One promise per click (`mutate`'s own callbacks hear only the latest of two saves at once).
  const { mutateAsync } = mutation;
  const save = useCallback(
    (attachment: Attachment, conversationId: string) => {
      const id = attachment.id;
      setBusy((b) => new Set(b).add(id));
      void mutateAsync({ attachmentId: id })
        .then(
          () =>
            toast.show(FILES_COPY.savedNote, {
              action: { label: FILES_COPY.open, onAction: () => openFiles(conversationId) },
            }),
          (error: unknown) => toast.show(filesErrorText(error, SAVE_TO_FILES_FAILED)),
        )
        .finally(() =>
          setBusy((b) => {
            const next = new Set(b);
            next.delete(id);
            return next;
          }),
        );
    },
    [mutateAsync, toast, openFiles],
  );
  const value = useMemo(() => ({ busy, save, filesHref, openFiles }), [busy, save, filesHref, openFiles]);
  return <MessageFilesContext.Provider value={value}>{children}</MessageFilesContext.Provider>;
}
