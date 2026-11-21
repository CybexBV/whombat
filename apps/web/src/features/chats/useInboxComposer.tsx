import { useTheAgent } from '@whombat/client/react';
import type { ChatRuntime, Message } from '@whombat/core';
import { type ReactNode, useMemo } from 'react';
import { Composer } from '../messaging/Composer';
import { draftKey, readDraft, useDraft } from '../messaging/drafts';
import { useBurrowContext, useSend } from '../messaging/useRoom';
import { useSkillCommands } from '../messaging/useSkillCommands';
import { useStableCallback } from '../messaging/useStableCallback';
import { useUploads } from '../messaging/useUploads';
import { useComposerPrompts } from '../prompts/useComposerPrompts';

export interface InboxComposerOptions {
  burrow: string;
  /** The room's conversation; null until it is known. */
  conversationId: string | null;
  /** Chat offers the person's prompts after `/`; Feedback doesn't. */
  prompts: boolean;
  placeholder: string;
  /** A new question went through (the server's message), or a prompt posted one: its thread opens. */
  onStarted: (rootId: string) => void;
  /** What answers the next question in Chat: the composer's button and the choice the question carries. */
  runtimeTool?: ReactNode;
  runtime?: ChatRuntime;
  /** A new value puts the cursor in the box; undefined leaves the focus where it is. */
  focusKey?: unknown;
}

/**
 * The box of Chat's and Feedback's new chat (Whombat chat-inbox.md; app chat-inbox-web.md): the one composer
 * (`variant="chat"`), its draft kept per room as before, files, the agent's skills and the person's prompts after `/`.
 * Each question starts a thread, which opens. The list doesn't load the room's messages, so this is the room's composer
 * without its timeline. The draft and the files stay while the box isn't on screen.
 */
export function useInboxComposer({
  burrow,
  conversationId,
  prompts: promptsHere,
  placeholder,
  onStarted,
  runtimeTool = null,
  runtime,
  focusKey,
}: InboxComposerOptions): { element: ReactNode; pickFiles: ((files: File[]) => void) | null } {
  const { principals, me } = useBurrowContext(burrow);
  const { agent } = useTheAgent(burrow);
  const mentionables = useMemo(() => principals.filter((p) => p.kind !== 'system'), [principals]);
  // In the person's own room the agent is addressed without a mention; its skills are offered at once.
  const { skills } = useSkillCommands(burrow, true);
  const onSent = useStableCallback((m: Message) => {
    if (!m.threadRootId) onStarted(m.id);
  });
  const sender = useSend({
    burrow,
    conversationId: conversationId ?? undefined,
    principals,
    meId: me?.id,
    skills,
    agentId: agent?.id ?? null,
    onSent,
  });
  const uploads = useUploads(burrow, conversationId ?? '');
  const onPosted = useStableCallback(({ rootId }: { rootId: string }) => onStarted(rootId));
  const offer = useComposerPrompts({
    burrow,
    conversationId: promptsHere ? conversationId : null,
    onPosted,
  });
  const key = draftKey(burrow, conversationId ?? '-');
  const [draft, setDraft] = useDraft(key);

  const submit = async (text: string) => {
    const previous = draft;
    const files = uploads.readyIds;
    setDraft('');
    const ok = await sender.submit(text, files, runtime ? { runtime } : {});
    // Sent files leave the box; after a refusal the draft and the files stay for another try.
    if (ok) uploads.clearSent(files);
    else if (!readDraft(key)) setDraft(previous);
  };

  const element = (
    <Composer
      placeholder={placeholder}
      value={draft}
      onValueChange={(v) => {
        setDraft(v);
        if (sender.notice) sender.clearNotice();
        if (offer.notice) offer.clearNotice();
      }}
      onSubmit={(text) => void submit(text)}
      mentionables={mentionables}
      viewerId={me?.id}
      onPickFiles={conversationId ? uploads.pick : null}
      attachments={uploads.attachments}
      onRemoveAttachment={uploads.remove}
      onRetryAttachment={uploads.retry}
      notice={sender.notice ?? offer.notice ?? null}
      skills={skills}
      prompts={offer.prompts}
      variant="chat"
      place="page"
      runtimeTool={runtimeTool}
      burrow={burrow}
      voiceKey={`room:${conversationId ?? ''}`}
      focusKey={focusKey}
    />
  );
  return { element, pickFiles: conversationId ? uploads.pick : null };
}
