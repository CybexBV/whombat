/**
 * Everything a message's toolbar and menu do (docs/decisions/essentials-messages.md AP-440…AP-445), shared by the
 * conversation and the thread pane: reactions with the picker, Reply in thread, Edit (inline, and ↑ from an empty
 * composer), Pin / Unpin and Delete with its dialog.
 * The caller renders `elements` once and passes the per-message callbacks to its rows.
 */
import {
  ApiError,
  type CommitResult,
  composerMentionTargets,
  composerText,
  OutcomeUnknownError,
  wentThrough,
} from '@whombat/client';
import { licenceRefusalText } from '@whombat/client/managed';
import { useDeleteMessage, useEditMessage, usePinMessage, useReaction } from '@whombat/client/react';
import type { Message } from '@whombat/core';
import { type MouseEvent, type ReactNode, useCallback, useMemo, useState } from 'react';
import { type ContextMenuItem, useRowMenu } from '../../app/shell/ContextMenu';
import { useToast } from '../../components/Toast';
import { currentLocale } from '../../i18n/provider';
import { DeleteMessageDialog } from './DeleteMessageDialog';
import { type EmojiAnchor, EmojiPicker } from './emoji/EmojiPicker';
import { rememberEmoji } from './emoji/recentEmoji';
import { lastEditable, type MessageAction, messageActions, messageViewer } from './messageActions';
import { commitDelete, setDeleteDismiss, settleDelete, stageDelete, undoDelete } from './pendingDeletes';
import { useBurrowContext } from './useRoom';
import { useStableCallback } from './useStableCallback';

export interface MessageActionsOptions {
  burrow: string;
  /** “#billing-v2”, “Banjo”: pin toasts and the delete dialog. */
  where: string;
  place: 'room' | 'thread';
  /** Opens the thread pane on a message (the conversation only). */
  onReplyInThread?: (messageId: string) => void;
  /** Items the caller puts first: “Settle thread” or “Open again” on a thread's first message in Chat (AP-6150). */
  leadItems?: (m: Message) => ContextMenuItem[];
  /** Items the caller adds before Delete: “Make a plan”. */
  extraItems?: (m: Message) => ContextMenuItem[];
  /** A message the viewer deleted is gone (no replies): the thread pane closes when it was its root. */
  onRemoved?: (m: Message) => void;
  /** After an edit is saved or cancelled: focus goes back to the composer (or the reply box). */
  onEditDone?: () => void;
  /** A message's permalink, for “Copy link” (WX-06); null while unknown (no item). */
  linkOf?: (m: Message) => string | null;
}

interface Editing {
  id: string;
  error: string | null;
}

export interface MessageActionsApi {
  /** The toolbar and menu entries this message offers (`messageActions`). */
  actionsFor: (m: Message) => MessageAction[];
  /** Opens the message's menu from “More actions” or a right-click. */
  onMenu: (event: MouseEvent<HTMLElement>, m: Message) => void;
  menuOpenId: string | null;
  pickerOpenId: string | null;
  /** Toggles the viewer's reaction (a pill, or a pick). */
  toggleReaction: (m: Message, value: string) => void;
  editingId: string | null;
  editError: string | null;
  editPending: boolean;
  startEdit: (m: Message) => void;
  cancelEdit: () => void;
  saveEdit: (m: Message, text: string) => void;
  /** ↑ in an empty composer: edit the viewer's newest editable message; false when there is none. */
  editLast: (messages: readonly Message[]) => boolean;
  /** The menu, the picker and the delete dialog (render once). */
  elements: ReactNode;
}

export function useMessageActions({
  burrow,
  where,
  place,
  onReplyInThread,
  leadItems,
  extraItems,
  onRemoved,
  onEditDone,
  linkOf,
}: MessageActionsOptions): MessageActionsApi {
  const { lookup, me, principals } = useBurrowContext(burrow);
  const menu = useRowMenu();
  const toast = useToast();
  const react = useReaction(burrow);
  const edit = useEditMessage(burrow);
  const remove = useDeleteMessage(burrow);
  const pin = usePinMessage(burrow);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<{ message: Message; error: string | null } | null>(null);
  const [picker, setPicker] = useState<{ message: Message; anchor: EmojiAnchor; opener: HTMLElement } | null>(
    null,
  );
  const viewer = useMemo(() => messageViewer(me), [me]);
  const context = { viewer, place } as const;
  const actionsFor = (m: Message) => messageActions(m, context);

  const toggleReaction = useCallback(
    (m: Message, value: string) => {
      const mine = m.reactions.some((r) => r.value === value && r.mine);
      if (!mine) rememberEmoji(value);
      react.mutate({ messageId: m.id, value, on: !mine });
    },
    [react],
  );

  const pickerAt = (m: Message, opener: HTMLElement) => {
    const r = opener.getBoundingClientRect();
    setPicker({ message: m, opener, anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } });
  };

  const startEdit = (m: Message) => {
    setEditing({ id: m.id, error: null });
    document.getElementById(m.id)?.scrollIntoView?.({ block: 'nearest' });
  };

  const togglePin = (m: Message) => {
    const pinned = !m.pinnedAt;
    pin.mutate(
      { messageId: m.id, pinned },
      {
        onSuccess: (result) => {
          if (result.status !== 'ok') toast.show(outcomeText(result));
          else toast.show(pinned ? `Pinned to ${where}.` : `Unpinned from ${where}.`);
        },
        // Done, its answer not kept (CT-195): said as done; the conversation is fetched again (AP-580).
        onError: (err) =>
          toast.show(
            wentThrough(err)
              ? pinned
                ? `Pinned to ${where}.`
                : `Unpinned from ${where}.`
              : errorText(err, pinned ? 'Couldn’t pin that. Try again.' : 'Couldn’t unpin that. Try again.'),
          ),
      },
    );
  };

  const onMenu = (event: MouseEvent<HTMLElement>, m: Message) => {
    const actions = actionsFor(m);
    const opener = event.currentTarget;
    const items: ContextMenuItem[] = actions.length ? [...(leadItems?.(m) ?? [])] : [];
    if (actions.includes('reply') && onReplyInThread)
      items.push({ label: 'Reply in thread', onSelect: () => onReplyInThread(m.id) });
    if (actions.includes('react')) items.push({ label: 'Add reaction', onSelect: () => pickerAt(m, opener) });
    const link = actions.length ? linkOf?.(m) : null;
    if (link) items.push({ label: COPY_LINK, onSelect: () => void copyLink(link) });
    if (actions.includes('edit')) items.push({ label: 'Edit message', onSelect: () => startEdit(m) });
    if (actions.includes('pin'))
      items.push({ label: 'Pin to this conversation', onSelect: () => togglePin(m) });
    if (actions.includes('unpin')) items.push({ label: 'Unpin', onSelect: () => togglePin(m) });
    items.push(...(extraItems?.(m) ?? []));
    if (actions.includes('delete'))
      items.push({
        label: 'Delete message',
        danger: true,
        // Your own message without replies goes at once, with Undo (WX-09); the dialog stays for a thread's replies
        // and for removing the agent's message (WX-13).
        onSelect: () => (deleteAsks(m, me?.id) ? setDeleting({ message: m, error: null }) : stage(m)),
      });
    // Opens with “Copy” alone when the viewer selected text in a message without other actions (AP-615).
    menu.open(event, m.id, 'Message actions', items);
  };

  const saveEdit = (m: Message, typed: string) => {
    setEditing({ id: m.id, error: null });
    // Saved with every mention in its canonical form, as the server stores it (MS-C02; AP-607).
    const text = composerText(typed, composerMentionTargets(principals, me?.id));
    edit.mutate(
      { messageId: m.id, text },
      {
        onSuccess: (result) => {
          if (result.status !== 'ok') return setEditing({ id: m.id, error: outcomeText(result) });
          setEditing(null);
          onEditDone?.();
        },
        onError: (err) => {
          if (!wentThrough(err))
            return setEditing({ id: m.id, error: errorText(err, 'Couldn’t save your edit. Try again.') });
          setEditing(null);
          onEditDone?.();
        },
      },
    );
  };

  const cancelEdit = () => {
    setEditing(null);
    onEditDone?.();
  };

  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      toast.show(LINK_COPIED);
    } catch {
      // Clipboard access can be denied (permissions, a non-secure origin): say so, with the link to copy by hand.
      toast.show(`Couldn’t copy the link: ${link}`);
    }
  };

  /** Sends a staged delete (its toast ended, or the conversation closed) and settles it with the answer. */
  const send = (m: Message) => {
    remove
      .mutateAsync({ messageId: m.id, conversationId: m.conversationId })
      .then((result) => {
        // Refused: the message shows again, with why.
        if (result.status !== 'ok') toast.show(outcomeText(result));
        settleDelete(m.id);
      })
      .catch((err: unknown) => {
        // Went through without its answer (CT-195): it stays hidden; the conversation is fetched again (AP-580).
        if (wentThrough(err)) return;
        toast.show(errorText(err, 'Couldn’t delete that. Try again.'));
        settleDelete(m.id);
      });
  };

  /** The message leaves the lists now; the delete goes when its toast ends, unless Undo (WX-09). */
  const stage = (m: Message) => {
    setDeleting(null);
    if (editing?.id === m.id) setEditing(null);
    stageDelete(m.id, { conversationId: m.conversationId, commit: () => send(m) });
    onRemoved?.(m);
    const toastId = toast.show(MESSAGE_DELETED, {
      action: { label: 'Undo', onAction: () => undoDelete(m.id) },
      onEnd: (how) => {
        if (how !== 'action') commitDelete(m.id);
      },
    });
    setDeleteDismiss(m.id, () => toast.dismiss(toastId));
  };

  const confirmDelete = () => {
    if (deleting) stage(deleting.message);
  };

  const author = deleting ? lookup(deleting.message.authorId) : undefined;
  const pickerMessage = picker?.message;
  const elements = (
    <>
      {menu.element}
      {picker && pickerMessage && (
        <EmojiPicker
          anchor={picker.anchor}
          label={pickerLabel(lookup(pickerMessage.authorId)?.name)}
          mine={pickerMessage.reactions.filter((r) => r.mine).map((r) => r.value)}
          onPick={(char) => toggleReaction(pickerMessage, char)}
          onClose={(restoreFocus) => {
            const opener = picker.opener;
            setPicker(null);
            if (restoreFocus && opener.isConnected) opener.focus();
          }}
        />
      )}
      <DeleteMessageDialog
        message={deleting?.message ?? null}
        authorName={author?.name ?? 'Someone'}
        viewerId={me?.id}
        where={where}
        pending={false}
        error={deleting?.error ?? null}
        onConfirm={confirmDelete}
        onClose={() => setDeleting(null)}
      />
    </>
  );

  // Stable handlers for the memoized rows (docs/decisions/web-messages.md WX-01).
  const stableMenu = useStableCallback(onMenu);
  const stableToggle = useStableCallback(toggleReaction);
  const stableSave = useStableCallback(saveEdit);
  const stableCancel = useStableCallback(cancelEdit);
  const stableStart = useStableCallback(startEdit);
  const stableEditLast = useStableCallback((messages: readonly Message[]) => {
    const m = lastEditable(messages, context);
    if (!m) return false;
    startEdit(m);
    return true;
  });

  return {
    actionsFor,
    onMenu: stableMenu,
    menuOpenId: menu.openKey,
    pickerOpenId: picker?.message.id ?? null,
    toggleReaction: stableToggle,
    editingId: editing?.id ?? null,
    editError: editing?.error ?? null,
    editPending: edit.isPending,
    startEdit: stableStart,
    cancelEdit: stableCancel,
    saveEdit: stableSave,
    editLast: stableEditLast,
    elements,
  };
}

/** The menu item and its toast (WX-06). */
export const COPY_LINK = 'Copy link';
export const LINK_COPIED = 'Message link copied.';
/** The delete's toast, with Undo (WX-09). */
export const MESSAGE_DELETED = 'Message deleted.';

/**
 * Whether Delete asks first (WX-13): when it takes more than the viewer's own words — a thread's replies go with it
 * (AP-553), or the message is the agent's. Anything else goes at once, with Undo.
 */
export function deleteAsks(
  m: Pick<Message, 'authorId' | 'replyCount'>,
  viewerId: string | undefined,
): boolean {
  return m.replyCount > 0 || m.authorId !== viewerId;
}

/** “Add a reaction to Dusty’s message”; without a known author, “Add a reaction”. */
function pickerLabel(name: string | undefined): string {
  return name ? `Add a reaction to ${name}’s message` : 'Add a reaction';
}

function outcomeText(result: Exclude<CommitResult<unknown>, { status: 'ok' }>): string {
  if (result.status === 'pending_approval') return 'That needs a person to approve it first. We’ve asked.';
  return `Blocked: that needs the “${result.keyNeeded.label}” key.`;
}

function errorText(err: unknown, fallback: string): string {
  // The connection dropped after the request left: it may have happened (AP-14). Nothing is retried by itself.
  if (err instanceof OutcomeUnknownError)
    return 'Not confirmed yet: the connection dropped. Check the conversation before trying again.';
  const licence = licenceRefusalText(err, currentLocale());
  if (licence) return licence;
  if (err instanceof ApiError) {
    if (err.status === 404 || err.status === 501) return 'That isn’t available here yet.';
    if (err.status === 403) return 'You can’t do that to this message.';
    return err.message || fallback;
  }
  return fallback;
}
