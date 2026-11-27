import { usePins } from '@whombat/client/react';
import { formatRecent, type Message } from '@whombat/core';
import { useSearchUpdate } from '../../app/routing/navigation';
import { IconButton } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { EmptyNote, ErrorNote, SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { useWebI18n } from '../../i18n/provider';
import { useCurrentConversation } from '../plans';
import { messageExcerpt } from './messageActions';
import styles from './PinsPane.module.css';
import { PrincipalAvatar } from './PrincipalAvatar';
import { useBurrowContext, useNow } from './useRoom';

/** How long a message the pins pane jumps to stays highlighted. */
export const FLASH_MS = 1600;

/** Scrolls a message of the open conversation into view and highlights it briefly; false when it isn't loaded. */
export function flashMessage(messageId: string): boolean {
  const el = document.getElementById(messageId);
  if (!el?.closest('[data-conversation-scroll]')) return false;
  el.scrollIntoView?.({ block: 'center' });
  el.setAttribute('data-flash', '');
  window.setTimeout(() => el.removeAttribute('data-flash'), FLASH_MS);
  return true;
}

/** How many messages are pinned in a conversation, for the header's “Pinned · N” (AP-445); null while unknown. */
export function usePinnedCount(burrow: string, conversationId: string | undefined): number | null {
  const { data } = usePins(conversationId ? { params: { burrow, conversationId } } : null);
  return data ? data.messages.length : null;
}

/** The pins pane's address from a conversation (one pane at a time). */
export const PINS_SEARCH = {
  pins: 1,
  plans: undefined,
  plan: undefined,
  step: undefined,
  thread: undefined,
  focus: undefined,
} as const;

/**
 * The header's “Pinned · N” (AP-445): the conversation's pinned messages, newest pin first, each with its author, when
 * it was said, its first words and who pinned it. A click jumps to the message: scrolled into view and highlighted
 * when it is loaded, otherwise (older history, or a thread reply) opened in the thread pane.
 */
export function PinsPane({ burrow, onClose }: { burrow: string; onClose: () => void }) {
  const { tag: uiLocale } = useWebI18n();
  const conversation = useCurrentConversation(burrow);
  const { lookup, timeZone } = useBurrowContext(burrow);
  const now = useNow(60_000);
  const updateSearch = useSearchUpdate();
  const { data, error, refetch } = usePins(
    conversation ? { params: { burrow, conversationId: conversation.id } } : null,
  );
  const pins = data?.messages ?? [];

  const open = (m: Message) => {
    if (!m.threadRootId && flashMessage(m.id)) return;
    void updateSearch((s) => ({
      ...s,
      pins: undefined,
      plan: undefined,
      step: undefined,
      plans: undefined,
      thread: m.threadRootId ?? m.id,
    }));
  };

  return (
    <div className={styles.pane} data-screen="pins">
      <div className={styles.header}>
        <div className={styles.heading}>
          <h2 className={styles.title}>Pinned</h2>
          {conversation && <span className={styles.context}>{conversation.title}</span>}
        </div>
        <IconButton label="Close pinned messages" onClick={onClose}>
          <Icon name="close" size={16} />
        </IconButton>
      </div>
      <div className={styles.body}>
        {error && !data ? (
          <ErrorNote
            message="Couldn’t load the pinned messages. Try again in a moment."
            onRetry={() => void refetch()}
          />
        ) : !data ? (
          <SkeletonRows count={3} avatarSize={28} lines={2} />
        ) : pins.length === 0 ? (
          <EmptyNote>Nothing is pinned here yet. Pin a message from its menu to keep it at hand.</EmptyNote>
        ) : (
          <section className={styles.section} aria-label="Pinned messages">
            <SectionLabel as="h3">{`PINNED · ${pins.length}`}</SectionLabel>
            <ul className={styles.list}>
              {pins.map((m) => {
                const author = lookup(m.authorId);
                const by = m.pinnedById ? lookup(m.pinnedById) : undefined;
                const excerpt = messageExcerpt(m.text, 280);
                return (
                  <li key={m.id}>
                    <button type="button" className={styles.row} onClick={() => open(m)}>
                      <span className={styles.avatar}>
                        <PrincipalAvatar principal={author} size={28} />
                      </span>
                      <span className={styles.content}>
                        <span className={styles.meta}>
                          <span className={styles.name}>{author?.name ?? 'Someone'}</span>
                          <span className={styles.time}>
                            {formatRecent(m.createdAt, now, timeZone, uiLocale)}
                          </span>
                        </span>
                        <span className={styles.text}>
                          {excerpt ||
                            (m.attachments.length
                              ? m.attachments.map((a) => a.name).join(', ')
                              : m.card
                                ? 'A card'
                                : '')}
                        </span>
                        {m.pinnedAt && (
                          <span className={styles.pinnedBy}>
                            <Icon name="pin" size={11} />
                            {by ? `Pinned by ${by.name}` : 'Pinned'} ·{' '}
                            {formatRecent(m.pinnedAt, now, timeZone, uiLocale)}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
