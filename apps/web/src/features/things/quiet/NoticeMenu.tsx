/**
 * A Worth a look line's ⋯ menu and a quiet line's Undo (Whombat quiet-notices.md QN-10, QN-14; app quiet-notices.md
 * AP-4822, AP-4823; the quiet mock's panel 1): the app's menu button opening Ignore (with when you'll hear again under
 * it), Remind me tomorrow and, apart, the line's own extras (a server check's Change the limit)
 * and Stop watching {item} (with what that means). Only on a line with Ignore's words (who may manage the thing) and
 * actions (a Whombat with `things.quiet`); a quiet line has Undo instead. A line quiet because the whole thing is kept
 * quiet has End now instead of Undo, and one quiet because of its cause neither.
 */
import { heldLine, KEEP_QUIET_WORDS, type QuietLine, quietMenu, quietUndo } from '@whombat/client';
import type { QuietActions } from '@whombat/client/react';
import { MoreHorizontal } from 'lucide-react';
import type { ContextMenuItem } from '../../../app/shell/ContextMenu';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { MenuButton } from '../manage/MenuButton';
import styles from './Quiet.module.css';

/** Wide enough for “Until there’s a newer version.” on one line under Ignore. */
const MENU_WIDTH = 264;

export function NoticeMenu({
  line,
  actions,
  extra,
  className,
}: {
  line: QuietLine;
  actions: QuietActions | null | undefined;
  /** More of the line's own, before Stop watching (Change the limit). */
  extra?: readonly ContextMenuItem[] | null;
  className?: string;
}) {
  const menu = actions ? quietMenu(line) : null;
  if (!menu || !actions) return null;
  const items: ContextMenuItem[] = [
    { label: menu.ignore.label, description: menu.ignore.words, onSelect: () => actions.ignore(line) },
    { label: menu.snooze.label, onSelect: () => actions.snooze(line) },
    // Its own (Change the limit) before Stop watching: the gentler way to hear less.
    ...(extra ?? []),
    {
      label: menu.stop.label,
      description: menu.stop.words,
      separated: true,
      onSelect: () => actions.stop(line),
    },
  ];
  return (
    <MenuButton
      label={menu.label}
      items={items}
      width={MENU_WIDTH}
      className={cx(styles.more, className)}
      disabled={actions.busy(menu.ref)}
    >
      <Icon icon={MoreHorizontal} size={16} />
    </MenuButton>
  );
}

/**
 * Undo on a quiet line, for who may quiet it; End now on a line quiet because the thing is kept quiet (`onEnd`: the
 * line's own Undo can't end the window, so without it there is no button); nothing on a line quiet because of its cause
 * (it lifts when the cause is back).
 */
export function QuietUndo({
  line,
  actions,
  onEnd,
  ending = false,
  className,
}: {
  line: QuietLine;
  actions: QuietActions | null | undefined;
  /** End now: `things.endQuiet` for the whole thing. */
  onEnd?: (() => void) | null;
  ending?: boolean;
  className?: string;
}) {
  if (!actions || !quietUndo(line) || !line.check) return null;
  const ref = line.subject ? { check: line.check, subject: line.subject.id } : { check: line.check };
  const held = heldLine(line);
  if (held === 'cause') return null;
  if (held === 'window')
    return onEnd ? (
      <button
        type="button"
        className={cx(styles.undo, className)}
        disabled={ending || actions.busy(ref)}
        aria-label={`${KEEP_QUIET_WORDS.endNow}: ${line.title}`}
        onClick={onEnd}
      >
        {KEEP_QUIET_WORDS.endNow}
      </button>
    ) : null;
  return (
    <button
      type="button"
      className={cx(styles.undo, className)}
      disabled={actions.busy(ref)}
      aria-label={`Undo: ${line.title}`}
      onClick={() => actions.undo(ref)}
    >
      Undo
    </button>
  );
}
