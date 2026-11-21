/**
 * What a chat row's long press and swipe offer, kept per message. Pure (no React Native imports) so it is unit-tested
 * in Node.
 *
 * The list asks for every row it draws whenever anything a row shows changes — an agent's activity, a busy button, a
 * new reply elsewhere — and building a row's menu, iOS's menu description and its swipe each time cost more than the
 * row itself. A row's answer stays the same object while its message (the same object while it says the same) and the
 * few things that decide its menu are unchanged.
 */
import type { Message, MessageViewer } from '@whombat/core';
import {
  type MessageMenu,
  type MessageMenuOptions,
  type MessageSwipe,
  messageMenu,
  messageSwipe,
} from './messageActions';
import { nativeMenuSpec } from './nativeMenu';
import { quickReactions } from './reactions';
import type { SettleOffer } from './threadSettle';

export interface RowMenu {
  /** The message's menu; null while it is being sent (no menu yet). */
  menu: MessageMenu | null;
  /** iOS's own menu, as the native view takes it (JSON); null where the app's sheet opens instead. */
  spec: string | null;
  swipe: MessageSwipe;
}

export interface RowMenuInput {
  viewer: MessageViewer;
  /** The screen's menu options, without the per-thread settle offer (that is `offer`). */
  options: Omit<MessageMenuOptions, 'settle'>;
  /** What the message's thread offers in a room now (`settleOffer`); null outside a room's top level. */
  offer: SettleOffer;
  /** What answered it, shown in iOS's menu (`ChatItem.ranOn.text`). */
  ranOn: string | null;
  /** A room's top level, where a thread's first message swipes. */
  roomTop: boolean;
}

interface Kept extends RowMenuInput {
  value: RowMenu;
}

/** `(message, input) => RowMenu`, the same object while nothing that decides it changed. */
export function createRowMenus(native: boolean): (message: Message, input: RowMenuInput) => RowMenu {
  const kept = new WeakMap<Message, Kept>();
  return (message, input) => {
    const before = kept.get(message);
    if (
      before &&
      before.viewer === input.viewer &&
      before.options === input.options &&
      before.offer === input.offer &&
      before.ranOn === input.ranOn &&
      before.roomTop === input.roomTop
    )
      return before.value;
    const menu = messageMenu(message, input.viewer, { ...input.options, settle: () => input.offer });
    const value: RowMenu = {
      menu,
      spec:
        native && menu
          ? JSON.stringify(
              nativeMenuSpec(menu, menu.react ? quickReactions(message.reactions) : null, input.ranOn),
            )
          : null,
      swipe: messageSwipe(menu, input.roomTop),
    };
    kept.set(message, { ...input, value });
    return value;
  };
}
