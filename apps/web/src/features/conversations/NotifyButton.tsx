import { useSetNotify } from '@whombat/client/react';
import {
  type ConversationKind,
  defaultNotifyLevel,
  type NotifyLevel,
  notifyLevelLabels,
  notifyLevelOf,
} from '@whombat/core';
import { Bell, BellOff, BellRing, type LucideIcon } from 'lucide-react';
import { type ContextMenuItem, useRowMenu } from '../../app/shell/ContextMenu';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { currentLocale } from '../../i18n/provider';
import headerStyles from '../messaging/ConversationHeader.module.css';

export const NOTIFY_LEVELS: readonly NotifyLevel[] = ['all', 'mentions', 'none'];

/** The line under each choice in the bell's menu (AP-469). */
export const NOTIFY_LEVEL_HINTS: Record<NotifyLevel, string> = {
  all: 'Every new message',
  mentions: '@you, @channel, @here and your threads',
  none: 'Only what needs you',
};

const NOTIFY_ICONS: Record<NotifyLevel, LucideIcon> = { all: BellRing, mentions: Bell, none: BellOff };

/** “Notifications: Mentions”, the bell's name and tooltip. */
export function notifyButtonLabel(level: NotifyLevel): string {
  const NOTIFY_LEVEL_LABELS = notifyLevelLabels(currentLocale());
  return `Notifications: ${NOTIFY_LEVEL_LABELS[level]}`;
}

/** The bell menu's choices: the level in effect ticked, the kind's default marked; the default is stored as null. */
export function notifyMenuItems(
  kind: ConversationKind,
  level: NotifyLevel,
  onChange: (notify: NotifyLevel | null) => void,
): ContextMenuItem[] {
  const NOTIFY_LEVEL_LABELS = notifyLevelLabels(currentLocale());
  const fallback = defaultNotifyLevel(kind);
  return NOTIFY_LEVELS.map((l) => ({
    label: l === fallback ? `${NOTIFY_LEVEL_LABELS[l]} (default)` : NOTIFY_LEVEL_LABELS[l],
    description: NOTIFY_LEVEL_HINTS[l],
    checked: l === level,
    onSelect: () => onChange(l === fallback ? null : l),
  }));
}

/** Change the level with the optimistic hook; a failure says so in a toast (the cache is refetched). */
export function useNotifyChange(burrow: string, conversation: { id: string; kind: ConversationKind }) {
  const set = useSetNotify(burrow);
  const toast = useToast();
  return (notify: NotifyLevel | null) =>
    set.mutate(
      { conversationId: conversation.id, kind: conversation.kind, notify },
      {
        onSuccess: (result) => {
          if (result.status !== 'ok') toast.show('Couldn’t change notifications here. Try again.');
        },
        onError: () => toast.show('Couldn’t change notifications here. Try again.'),
      },
    );
}

export interface NotifyButtonProps {
  burrow: string;
  conversation: { id: string; kind: ConversationKind; notify?: NotifyLevel | null };
}

/**
 * The conversation header's bell (AP-469): All / Mentions / Nothing through `conversations.setNotify`, the level in
 * effect as its icon and name.
 */
export function NotifyButton({ burrow, conversation }: NotifyButtonProps) {
  const menu = useRowMenu();
  const change = useNotifyChange(burrow, conversation);
  const level = notifyLevelOf(conversation);
  const key = `notify:${conversation.id}`;
  const label = notifyButtonLabel(level);
  return (
    <>
      <button
        type="button"
        className={cx(headerStyles.iconAction, menu.openKey === key && headerStyles.iconActionOpen)}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={menu.openKey === key}
        data-header-bell=""
        data-level={level}
        onClick={(e) =>
          menu.openFrom(
            e.currentTarget,
            key,
            'Notifications',
            notifyMenuItems(conversation.kind, level, change),
            'end',
          )
        }
      >
        <Icon icon={NOTIFY_ICONS[level]} size={17} />
      </button>
      {menu.element}
    </>
  );
}
