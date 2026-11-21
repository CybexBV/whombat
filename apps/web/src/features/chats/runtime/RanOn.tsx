import { type RanOnSwitch, ranOnMark, ranOnMarked, ranOnNotes } from '@whombat/client';
import { useChatRuntime } from '@whombat/client/react';
import type { Message } from '@whombat/core';
import { Zap } from 'lucide-react';
import { createContext, type ReactNode, useContext } from 'react';
import { Icon } from '../../../components/Icon';
import styles from './ChatRuntime.module.css';
import { ProviderMark } from './ChatRuntimeButton';

/** Whether this room's replies show their provider's mark (`ranOnMarked`): only where more than one AI can answer. */
const RanOnMarked = createContext(false);

export function RanOnMarkedProvider({
  burrow,
  enabled,
  children,
}: {
  burrow: string;
  /** Only Chat's replies carry what answered them; another room asks nothing. */
  enabled: boolean;
  children: ReactNode;
}) {
  const { data } = useChatRuntime(burrow, null, { enabled });
  return <RanOnMarked.Provider value={enabled && ranOnMarked(data)}>{children}</RanOnMarked.Provider>;
}

/**
 * What answered an assistant's reply in Chat (Whombat chat-runtime.md CR-07; AP-2695): the provider's mark and name
 * after the time, the whole line (“Claude · Opus · High effort · Fast”) on hover and for screen readers — only on a reply
 * that ran on something else than the thread's reply before it (`changed`), and only where more than one AI can answer
 * (docs/decisions/ui-refresh-chat.md). On every other reply the line is the time's hover (`ranOnTitle`).
 */
export function RanOnMark({ message, changed }: { message: Pick<Message, 'ranOn'>; changed: boolean }) {
  const marked = useContext(RanOnMarked);
  const mark = ranOnMark(message);
  if (!mark || !marked || !changed) return null;
  return (
    <span className={styles.by} title={mark.title} data-ran-on={mark.provider}>
      <ProviderMark provider={mark.provider} size={12} />
      <span aria-hidden="true">{mark.label}</span>
      <span className={styles.srOnly}>{mark.title}</span>
    </span>
  );
}

/** The whole line of what answered a reply (“Claude · Opus · High effort”), for the hover of its time; else none. */
export function ranOnTitle(message: Pick<Message, 'ranOn'>): string | undefined {
  return ranOnMark(message)?.title;
}

const SWITCHED = 'Switched to ';

/**
 * The quiet divider before a reply that ran on something else than the thread's previous reply (CR-07; AP-2696):
 * “Switched to ChatGPT · High effort”, the new provider's mark first and what changed first in bold, as the mock.
 */
export function RanOnDivider({ change }: { change: RanOnSwitch }) {
  const rest = change.text.startsWith(SWITCHED) ? change.text.slice(SWITCHED.length) : null;
  const [first, ...more] = rest ? rest.split(' · ') : [];
  return (
    <div className={styles.switchLine} data-run-switch="">
      <ProviderMark provider={change.provider} size={13} />
      <span>
        {rest ? (
          <>
            {SWITCHED}
            <b>{first}</b>
            {more.length ? ` · ${more.join(' · ')}` : ''}
          </>
        ) : (
          change.text
        )}
      </span>
    </div>
  );
}

/** The quiet lines under a reply when fast replies or the model asked for didn't happen (CR-08; AP-2697). */
export function RanOnNotes({ message }: { message: Pick<Message, 'ranOn'> }) {
  const notes = ranOnNotes(message.ranOn);
  if (!notes.length) return null;
  return (
    <>
      {notes.map((n) => (
        <div key={n.kind} className={styles.quiet} data-ran-on-note={n.kind}>
          <Icon icon={Zap} size={13} />
          <span>{n.text}</span>
        </div>
      ))}
    </>
  );
}
