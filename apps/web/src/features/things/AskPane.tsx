/**
 * “Ask about <server>” beside a thing's page (one Whombat mock 2, ONE-06; Whombat chat-channel.md CHT-23; app
 * chat-channel.md AP-2412): a thread of Chat whose subject is the thing, so the assistant has its sensors, guests and
 * history without being told — the newest thread about it (`chats.threads` by subject), with “New thread”; with none,
 * its box starts one (`chats.start` with the subject). `?chat=` is the thread's first message. The same thread is in
 * Chat, so nothing is said twice in two places. Closed until asked for (`?ask=1`, the head's “Ask Neo”): the server's
 * tables need the width. Every word that means the assistant says its name (Whombat assistant-name.md AN-01;
 * assistant-name-web.md AP-1505).
 */
import { useQueryClient } from '@tanstack/react-query';
import { hostErrorInfo } from '@whombat/client/hosts';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation, useChatRooms, useChatThreads, useTheAgent } from '@whombat/client/react';
import type { ChatSubject } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { ArrowUp, MessageCircle, Plus, X } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { SidePane } from '../../components/SidePane';
import { currentLocale } from '../../i18n/provider';
import { CHAT_WORDS } from '../../i18n/shared';
import { ThreadPane } from '../messaging/ThreadPane';
import { useComposerVoice } from '../voice/useComposerVoice';
import { MicButton, VoiceBar, voiceBarShown } from '../voice/VoiceBar';
import styles from './AskPane.module.css';
import { useThingSearch } from './search';
import thingStyles from './Things.module.css';

/** The first chat's lead: what one might ask about a server, a connection or a device. */
export function askIntro(kind: ChatSubject['kind'], name: string, Name: string): string {
  const what =
    kind === 'server'
      ? 'why it’s warm, what uses its memory, whether it can take another guest'
      : kind === 'device'
        ? 'what its readings mean, why one is off, what it may change'
        : 'why something doesn’t work, what fills it up, whether it needs an update';
  return `Ask anything about ${name}: ${what}. ${Name} asks before changing anything.`;
}

/** The line under “Ask about pve-02”: “Neo sees this server’s sensors, guests and history”. */
export function seesLine(kind: ChatSubject['kind'], Name: string): string {
  switch (kind) {
    case 'server':
      return `${Name} sees this server’s sensors, guests and history`;
    case 'connection':
      return `${Name} sees what this connection reads and what it may change`;
    case 'device':
      return `${Name} sees this device’s readings and what it may change`;
  }
}

export interface AskPaneProps {
  burrow: string;
  subject: ChatSubject;
  /** The chat shown (`?chat=`): a conversation id, `new`, or the newest about the subject. */
  chatId?: string;
  onChat: (chatId: string | undefined) => void;
  onClose: () => void;
  /**
   * A question ready to send in a new chat (a notice's “Look into it” on a connection's page, connection-pages.md
   * CP-17): shown in the box, sent only when the person sends it.
   */
  draft?: string | null;
}

/** Whether the Ask pane is open: only when asked for, so a server's page has the whole width by default. */
export function isAskOpen(search: { ask?: string }): boolean {
  return search.ask === '1';
}

/** “Ask Neo” in a server's or a guest's head while the pane is closed: opens it. */
/** Ask {assistant}: the first button of every server's, machine's and connection's head, the primary one. */
export function AskButton({ burrow }: { burrow: string }) {
  const { words } = useTheAgent(burrow);
  const [search, set] = useThingSearch();
  if (isAskOpen(search)) return null;
  return (
    <Button
      variant="primary"
      className={thingStyles.btn}
      iconStart={<Icon icon={MessageCircle} size={15} />}
      onClick={() => set({ ask: '1' }, { replace: true })}
    >
      {words.ask}
    </Button>
  );
}

export function AskPane(props: AskPaneProps) {
  return <ThreadAskPane {...props} />;
}

/** The pane's head: “Ask about pve-02”, what the assistant sees, “New chat” or “New thread”, and Close. */
function AskHead({
  burrow,
  subject,
  newLabel,
  onNew,
  onClose,
}: {
  burrow: string;
  subject: ChatSubject;
  /** “New chat”, “New thread”; null while there is nothing to start anew from. */
  newLabel: string | null;
  onNew: () => void;
  onClose: () => void;
}) {
  const { words } = useTheAgent(burrow);
  return (
    <header className={styles.head}>
      <div className={styles.headText}>
        <h2>Ask about {subject.name}</h2>
        <p>{seesLine(subject.kind, words.Name)}</p>
      </div>
      <div className={styles.headActions}>
        {newLabel ? (
          <button
            type="button"
            className={styles.icon}
            aria-label={newLabel}
            title={newLabel}
            onClick={onNew}
          >
            <Icon icon={Plus} size={16} />
          </button>
        ) : null}
        <button type="button" className={styles.icon} aria-label="Close" title="Close" onClick={onClose}>
          <Icon icon={X} size={16} />
        </button>
      </div>
    </header>
  );
}

/**
 * The Chat shell's pane (AP-2412): the thread shown — `?chat=` (its first message), else the newest about the thing — in
 * the thread pane's own view under the pane's head, or the box that starts one.
 */
function ThreadAskPane({ burrow, subject, chatId, onChat, onClose, draft }: AskPaneProps) {
  const rooms = useChatRooms(burrow);
  const threads = useChatThreads(burrow, 'chat', {
    subject,
    conversationId: rooms.chat?.id,
    limit: 5,
  });
  const asked = chatId?.startsWith('msg_') ? chatId : null;
  const current = chatId === 'new' ? null : (asked ?? threads.threads[0]?.rootId ?? null);
  const header = (
    <AskHead
      burrow={burrow}
      subject={subject}
      newLabel={current ? CHAT_WORDS.newThread : null}
      onNew={() => onChat('new')}
      onClose={onClose}
    />
  );
  return (
    <SidePane
      width="thread"
      aria-label={`Ask about ${subject.name}`}
      takeFocus={false}
      className={styles.pane}
    >
      {current ? (
        <ThreadPane
          key={current}
          burrow={burrow}
          threadId={current}
          onClose={onClose}
          header={header}
          chatRoom="chat"
        />
      ) : threads.isLoading && chatId !== 'new' ? (
        <>
          {header}
          <div className={styles.body} aria-busy="true" />
        </>
      ) : (
        <NewChat
          burrow={burrow}
          subject={subject}
          header={header}
          draft={draft ?? null}
          onStarted={(started) => onChat(started.message.id)}
        />
      )}
    </SidePane>
  );
}

/** No chat about it yet: a short line and a box that starts one with the first message. */
function NewChat({
  burrow,
  subject,
  header,
  draft,
  onStarted,
}: {
  burrow: string;
  subject: ChatSubject;
  header: ReactNode;
  draft: string | null;
  /** `chats.start`'s answer: the new task chat, or with Chat the Chat and the new thread's first message. */
  onStarted: (started: { conversation: { id: string }; message: { id: string } }) => void;
}) {
  const { words } = useTheAgent(burrow);
  const [text, setText] = useState(draft ?? '');
  const input = useRef<HTMLTextAreaElement>(null);
  // A notice's question arrives while the pane is open: it replaces what the box holds, ready to send.
  useEffect(() => {
    if (!draft) return;
    setText(draft);
    input.current?.focus();
  }, [draft]);
  // The box grows with what it holds (a notice's question is longer than a line), up to its most.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the words change
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const [error, setError] = useState<string | null>(null);
  // Voice typing (docs/decisions/dictation.md DT-01): the words go into the box, never sent by themselves.
  const voice = useComposerVoice({
    burrow,
    ownerKey: `ask:${subject.kind}:${subject.name}`,
    value: text,
    onValueChange: setText,
    inputRef: input,
  });
  const listening = voiceBarShown(voice);
  const qc = useQueryClient();
  const start = useApiMutation(api.chats.start);
  const send = async () => {
    const t = text.trim();
    if (!t || start.isPending || listening) return;
    setError(null);
    try {
      const r = await start.mutateAsync({ params: { burrow }, body: { text: t, subject } });
      if (r.status !== 'ok') {
        setError(r.status === 'pending_approval' ? 'That needs an approval first.' : r.message);
        return;
      }
      void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.list') });
      void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.threads') });
      setText('');
      onStarted(r.data);
    } catch (err) {
      setError(hostErrorInfo(err, currentLocale()).message);
    }
  };
  return (
    <>
      {header}
      <div className={styles.body}>
        <p className={styles.intro}>{askIntro(subject.kind, subject.name, words.Name)}</p>
      </div>
      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {error || voice.error ? (
          <p className={styles.error} role="alert">
            {error ?? voice.error}
          </p>
        ) : null}
        <div className={styles.box}>
          <textarea
            ref={input}
            hidden={listening || undefined}
            className={styles.input}
            value={text}
            rows={1}
            placeholder={`Ask about ${subject.name}…`}
            aria-label={`Ask about ${subject.name}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {listening ? (
            <VoiceBar voice={voice} size="chat" />
          ) : (
            <>
              <MicButton voice={voice} size="chat" />
              <button
                type="submit"
                className={styles.send}
                aria-label="Send"
                disabled={!text.trim() || start.isPending}
              >
                <Icon icon={ArrowUp} size={15} />
              </button>
            </>
          )}
        </div>
      </form>
    </>
  );
}
