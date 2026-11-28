/**
 * Pieces a message row and a thread reply share (docs/decisions/essentials-messages.md): the hover toolbar, reaction
 * pills, “(edited)”, the pin marker, the tombstone, what the Vault took and the inline editor.
 */
import { Link } from '@tanstack/react-router';
import { composerText, vaultSavedRows } from '@whombat/client';
import {
  emojiByChar,
  formatClock,
  formatReaction,
  MESSAGE_DELETED_TEXT,
  MESSAGE_EDITED_LABEL,
  type MentionTarget,
  type Message,
  type Principal,
  type Reaction,
  shortNameOf,
} from '@whombat/core';
import { CircleCheck, Lock } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useWebI18n, type WebTranslator, webTranslator } from '../../i18n/provider';
import { SETTLE_WORDS } from '../../i18n/shared';
import styles from './MessageParts.module.css';
import { messageFits, TOO_LONG_NOTE } from './messageLimit';
import { useMentionAutocorrect } from './useMentionAutocorrect';

/* Toolbar ------------------------------------------------------------------------------------------ */

export interface MessageToolbarProps {
  /** The author's name, for the buttons' accessible names (“More actions for Mara’s message”). */
  name: string;
  /** The viewer's own message: “your message” (their name isn't shown on it). */
  self?: boolean;
  /** “Settle thread”, first: a thread's first message in Chat or Feedback that may settle now (chat-settle.md AP-6150). */
  onSettle?: (() => void) | undefined;
  onReplyInThread?: (() => void) | undefined;
  onMenu?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  /** The menu or the reaction picker is open for this message: the toolbar stays. */
  open?: boolean;
  menuOpen?: boolean;
  pickerOpen?: boolean;
}

/**
 * Settle thread (on a thread's first message in Chat and Feedback, AP-6150), Reply in thread and More actions at the
 * row's top right (AP-440): shown while the pointer is over the row or focus is
 * in it, and while its menu or picker is open. The keyboard reaches them through More actions, whose menu has Reply in
 * thread too. Add reaction lives in that menu only: a reaction button on every hover was noise in a chat with one
 * assistant. No Ask an agent (one-agent.md AP-4949).
 */
export function MessageToolbar({
  name,
  self = false,
  onSettle,
  onReplyInThread,
  onMenu,
  open = false,
  menuOpen = false,
  pickerOpen = false,
}: MessageToolbarProps) {
  const { t } = useWebI18n();
  if (!onSettle && !onReplyInThread && !onMenu) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a set of buttons, not form fields (a fieldset would be read as a form)
    <div
      className={cx(styles.toolbar, (open || menuOpen || pickerOpen) && styles.toolbarOpen)}
      role="group"
      aria-label={self ? t('chat.message.actionsOwn') : t('chat.message.actions', { name })}
      data-message-toolbar=""
    >
      {onSettle && (
        // Settling a finished thread, first (AP-6150): the keyboard has it in More actions, as Reply in thread.
        <button
          type="button"
          className={cx(styles.tool, styles.settleTool, onMenu && styles.inMenu)}
          aria-label={SETTLE_WORDS.settleThread}
          title={SETTLE_WORDS.settleThread}
          tabIndex={onMenu ? -1 : undefined}
          onClick={onSettle}
          data-settle-tool=""
        >
          <Icon icon={CircleCheck} size={16} />
        </button>
      )}
      {onReplyInThread && (
        <button
          type="button"
          className={cx(styles.tool, onMenu && styles.inMenu)}
          aria-label={t('chat.message.replyInThread')}
          title={t('chat.message.replyInThread')}
          tabIndex={onMenu ? -1 : undefined}
          onClick={onReplyInThread}
        >
          <Icon name="reply" size={16} />
        </button>
      )}
      {onMenu && (
        <button
          type="button"
          className={styles.tool}
          aria-label={self ? t('chat.message.moreActionsOwn') : t('chat.message.moreActionsFor', { name })}
          title={t('chat.message.moreActions')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={onMenu}
        >
          <Icon name="more" size={16} />
        </button>
      )}
    </div>
  );
}

/* Reactions --------------------------------------------------------------------------------------- */

/** “Mara, Neo reacted with 👍” (the pill's tooltip). */
export function reactionTitle(
  r: Reaction,
  lookup: (id: string) => Principal | undefined,
  words: WebTranslator = webTranslator(null),
): string {
  const names = r.principalIds.map((id) => {
    const p = lookup(id);
    return p ? shortNameOf(p) : words.t('chat.message.someone');
  });
  return names.length
    ? words.t('chat.message.reactedBy', { names: names.join(', '), emoji: r.value })
    : words.t('chat.message.reacted', { emoji: r.value });
}

export interface ReactionPillsProps {
  reactions: readonly Reaction[];
  lookup: (id: string) => Principal | undefined;
  onToggle?: ((reaction: Reaction) => void) | undefined;
  className?: string;
}

/** The mock's sf2 mono pills (“finally · 4”); an emoji reads “👍 · 3”. */
export function ReactionPills({ reactions, lookup, onToggle, className }: ReactionPillsProps) {
  const words = useWebI18n();
  if (reactions.length === 0) return null;
  return (
    <div className={cx(styles.reactions, className)}>
      {reactions.map((r) => (
        <button
          key={r.value}
          type="button"
          className={styles.reaction}
          aria-pressed={r.mine}
          aria-label={words.tp(r.mine ? 'chat.message.reactionsMine' : 'chat.message.reactions', r.count, {
            emoji: r.value,
          })}
          title={reactionTitle(r, lookup, words)}
          onClick={() => onToggle?.(r)}
        >
          {emojiByChar(r.value) ? (
            <>
              <span className={styles.emoji}>{r.value}</span>
              {formatReaction(r).slice(r.value.length)}
            </>
          ) : (
            formatReaction(r)
          )}
        </button>
      ))}
    </div>
  );
}

/* Meta ----------------------------------------------------------------------------------------------- */

/** “(edited)” beside the time; its tooltip says when. */
export function EditedLabel({ at, timeZone }: { at: string; timeZone: string }) {
  const { t } = useWebI18n();
  return (
    <span className={styles.edited} title={t('chat.message.editedAt', { time: formatClock(at, timeZone) })}>
      {MESSAGE_EDITED_LABEL}
    </span>
  );
}

/** The pin marker in the meta line: “Pinned”, and who pinned it in the tooltip and for screen readers. */
export function PinnedMarker({ by }: { by: Principal | undefined }) {
  const { t } = useWebI18n();
  const title = by ? t('chat.message.pinnedBy', { name: by.name }) : t('chat.message.pinned');
  return (
    <span className={styles.pinned} title={title} aria-label={title} role="img" data-pinned="">
      <Icon name="pin" size={12} />
      <span aria-hidden="true">{t('chat.message.pinned')}</span>
    </span>
  );
}

/** What a deleted thread root shows (CT-173): “This message was deleted.” */
export function DeletedText({ className }: { className?: string }) {
  return <p className={cx(styles.deleted, className)}>{MESSAGE_DELETED_TEXT}</p>;
}

/** The tombstone's avatar slot: a quiet circle with a bin (no author: the message is gone). */
export function DeletedAvatar({ size }: { size: 32 | 40 }) {
  return (
    <span className={styles.deletedAvatar} style={{ width: size, height: size }} aria-hidden="true">
      <Icon name="delete" size={size === 40 ? 18 : 15} />
    </span>
  );
}

/* What the Vault took ------------------------------------------------------------------------------------ */

/**
 * The lines under a message whose secret the Vault took (Whombat vault-self-serve.md VS-07, VS-11; AP-4007): a lock and
 * core's words, quiet, one per item, each opening its entry in the Vault — the saved login, or the SSH key a password
 * put on a server. The text itself shows `••••••`
 * where the secret was, as text.
 */
export function VaultSavedLines({ message }: { message: Pick<Message, 'vaultSaved'> }) {
  const rows = vaultSavedRows(message);
  if (!rows.length) return null;
  return (
    <div className={styles.vaultSaved}>
      {rows.map((row) => (
        <span key={row.key} className={styles.vaultSavedLine} data-vault-saved="">
          <Icon icon={Lock} size={13} />
          <Link to="/vault" search={{ entry: row.entryId }} className={styles.vaultSavedLink}>
            {row.text}
          </Link>
        </span>
      ))}
    </div>
  );
}

/* Inline editor ------------------------------------------------------------------------------------------ */

export interface MessageEditorProps {
  initial: string;
  /** An attachment-only message may be saved without text (the server checks too). */
  allowEmpty?: boolean;
  pending?: boolean;
  error?: string | null;
  onSave: (text: string) => void;
  onCancel: () => void;
  /** Thread replies use the pane's smaller text. */
  compact?: boolean;
  /** Who `@Name` means: `@banjo ` is corrected to `@Banjo ` as it is typed, and saved so (AP-607). */
  mentionTargets?: readonly MentionTarget[];
}

const NO_TARGETS: readonly MentionTarget[] = [];

/**
 * Editing your message in place (AP-441): the text in a box that grows, Enter saves, Shift+Enter adds a line, Esc
 * cancels (and doesn't close the pane behind it). Unchanged text just closes; the box keeps the text while the server
 * answers, and after a refusal with the reason.
 */
export function MessageEditor({
  initial,
  allowEmpty = false,
  pending = false,
  error = null,
  onSave,
  onCancel,
  compact = false,
  mentionTargets = NO_TARGETS,
}: MessageEditorProps) {
  const { t } = useWebI18n();
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const autocorrect = useMentionAutocorrect(ref, mentionTargets, setText);
  const trimmed = text.trim();
  const tooLong = !messageFits(trimmed);
  const canSave = !pending && !tooLong && (trimmed.length > 0 || allowEmpty);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  });

  // Focus at the end of the text when the editor opens.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const save = () => {
    if (!canSave) return;
    const saved = composerText(trimmed, mentionTargets);
    if (saved === initial.trim()) onCancel();
    else onSave(saved);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      save();
    }
  };

  return (
    <div className={cx(styles.editor, compact && styles.editorCompact)} data-message-editor="">
      <textarea
        ref={ref}
        rows={1}
        className={styles.editorInput}
        value={text}
        aria-label={t('chat.message.edit')}
        onChange={(event) => {
          setText(event.target.value);
          autocorrect(event, text);
        }}
        onKeyDown={onKeyDown}
        disabled={pending}
      />
      <div className={styles.editorBar}>
        <span className={cx(styles.editorHint, (error || tooLong) && styles.editorError)} role="status">
          {error ?? (tooLong ? TOO_LONG_NOTE : t('chat.message.editHint'))}
        </span>
        <Button variant="secondary" size="xs" onClick={onCancel} disabled={pending}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" size="xs" onClick={save} disabled={!canSave}>
          {pending ? t('chat.message.saving') : t('common.save')}
        </Button>
      </div>
    </div>
  );
}
