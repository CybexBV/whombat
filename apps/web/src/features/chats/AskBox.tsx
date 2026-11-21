import { startedChatPath } from '@whombat/client';
import { useChatRooms, useSendMessage, useStartChat, useTheAgent } from '@whombat/client/react';
import { type ChatSubject, chatThreadHref } from '@whombat/core';
import { type FormEvent, useEffect, useState } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { cx } from '../../components/cx';
import { useToast } from '../../components/Toast';
import { Composer } from '../messaging/Composer';
import { useUploads } from '../messaging/useUploads';
import styles from './AskBox.module.css';

export interface AskBoxProps {
  burrow: string;
  /** Chips under the box; a tap puts the words in the box. */
  suggestions?: readonly string[];
  /** What the new chat is about (a thing's page: “Ask about pve-02”). */
  subject?: ChatSubject | null;
  /** Default: “Ask Neo to check, change or set up anything…” (the assistant's name, AP-1504). */
  placeholder?: string;
  /** Focus the box when it shows (the new-chat page, “Ask Neo”). */
  autoFocus?: boolean;
  /** Words put in the box and focused, unsent, each time `key` changes (Automations' “Ask Neo” about a list that didn't load). */
  fill?: { text: string; key: number } | null;
  className?: string;
}

const NO_ONE = [] as const;
const DIDNT_START = 'That chat didn’t start. Try again in a moment.';

/**
 * The Ask box (Automations; one-whombat.md ONE-05, ONE-06): the one composer of Chat and its threads with its own words,
 * where one sentence starts a thread in the person's Chat (`chats.start`) and opens it. Files go with the question as
 * Chat's own first message (`messages.send` in the Chat room, which is what carries files). Enter sends, Shift+Enter
 * starts a new line, the mic is voice typing (docs/decisions/dictation.md DT-01); the chips under it fill the box.
 */
export function AskBox({
  burrow,
  suggestions = [],
  subject,
  placeholder,
  autoFocus,
  fill,
  className,
}: AskBoxProps) {
  const { words } = useTheAgent(burrow);
  const prompt = placeholder ?? words.askPlaceholder;
  const navigateHref = useNavigateHref();
  const toast = useToast();
  const start = useStartChat(burrow);
  const chatId = useChatRooms(burrow).chat?.id ?? '';
  // Its own chips, apart from the Chat room's composer: a file picked here goes with this question only.
  const uploads = useUploads(burrow, chatId, 'ask');
  const sendWithFiles = useSendMessage({ burrow, conversationId: chatId });
  const [text, setText] = useState('');
  useEffect(() => {
    if (!fill) return;
    setText(fill.text);
    setFocusKey(fill.key);
  }, [fill]);
  const [focusKey, setFocusKey] = useState<number | undefined>(autoFocus ? 0 : undefined);
  const busy = start.isPending || sendWithFiles.isPending;

  const send = async (typed: string) => {
    const question = typed.trim();
    const files = uploads.readyIds;
    if ((!question && !files.length) || busy) return;
    try {
      if (files.length) {
        const result = await sendWithFiles.mutateAsync({ text: question, attachmentIds: files });
        if (result.status !== 'ok') {
          toast.show(DIDNT_START);
          return;
        }
        uploads.clearSent(files);
        setText('');
        navigateHref(chatThreadHref('chat', result.data.message.id));
        return;
      }
      const result = await start.mutateAsync({ text: question, subject: subject ?? null });
      if (result.status !== 'ok') {
        toast.show(DIDNT_START);
        return;
      }
      setText('');
      navigateHref(startedChatPath(result.data));
    } catch {
      toast.show(DIDNT_START);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send(text);
  };

  return (
    <form className={cx(styles.ask, className)} onSubmit={onSubmit} aria-label={words.ask}>
      <Composer
        variant="chat"
        place="page"
        placeholder={prompt}
        value={text}
        onValueChange={setText}
        onSubmit={(typed) => void send(typed)}
        mentionables={NO_ONE}
        commandTool={false}
        // A subject goes only with `chats.start`, which carries no files.
        onPickFiles={chatId && !subject ? uploads.pick : null}
        attachments={uploads.attachments}
        onRemoveAttachment={uploads.remove}
        onRetryAttachment={uploads.retry}
        focusKey={focusKey}
        burrow={burrow}
        voiceKey={`ask:${subject?.kind ?? ''}:${subject?.name ?? ''}`}
      />
      {suggestions.length > 0 && (
        <div className={styles.chips}>
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className={styles.chip}
              onClick={() => {
                setText(s);
                setFocusKey(Date.now());
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
