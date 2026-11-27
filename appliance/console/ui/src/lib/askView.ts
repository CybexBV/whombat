/**
 * A question in the screen of widgets' pop-up (Whombat desk-display.md DK-151; CG-397): what the ask's card shows, as the
 * pop-up's words and buttons, so the person answers where they see it. The same rules as the card (`askShown`, CG-50):
 * locked, no words and no answers, only the unlock; an ask only the phone may approve says so; a risky one asks for the
 * PIN first. The pop-up adds its own *Not now* (put away on this screen).
 */

import type { AskButton, AskView } from '@whombat/screen/react';
import { english, type Translate } from '../i18n/translate';
import type { Decision } from './decide';
import type { ChoiceScope, DeskAsk } from './desk';
import { deskCopy, deskWordsCopy, fill } from './deskCopy';
import { askShown } from './deskScene';

export interface AskViewCtx {
  unlocked: boolean;
  /** Talk is on: a question is answered in Talk, an approval can be asked about. */
  voice: boolean;
  /** An answer is on its way. */
  busy: boolean;
  /** What went wrong with the last answer, if anything. */
  note: string | null;
  assistant: string;
  /** Approve or Deny, at once. */
  decide: (number: number, decision: Decision) => void;
  /** An answer behind the PIN: a risky ask's Approve (`null`) or one of its wider choices. */
  withPin: (number: number, scope: ChoiceScope | null) => void;
  /** Answer, or ask about it, in Talk. */
  talk: (ask: DeskAsk) => void;
  /** The PIN pad. */
  unlock: () => void;
}

/** The pop-up's view of `ask`; null when the page doesn't have it (the pop-up then offers its card). */
export function askViewOf(ask: DeskAsk | undefined, c: AskViewCtx, t: Translate = english): AskView | null {
  const DESK_WORDS = deskWordsCopy(t);
  const DESK = deskCopy(t);

  if (!ask) return null;
  const { ask: shown, actions, talk } = askShown(ask, { unlocked: c.unlocked, gone: false, voice: c.voice });
  const n = ask.number;
  const why = shown.phoneReason
    ? fill(DESK_WORDS.phoneReasons[shown.phoneReason], { assistant: c.assistant })
    : null;
  const buttons: AskButton[] = [];
  let note: AskView['note'];
  // One the screen may only deny, or approve with the PIN (DK-61, DK-62).
  const risky = actions === 'phone' && ask.deny === true;
  const approve = shown.approveLabel ?? DESK_WORDS.approve;
  const choices = (shown.choices ?? []).map(
    (ch): AskButton => ({
      key: ch.scope,
      label: ch.label,
      lock: true,
      onPress: () => c.withPin(n, ch.scope),
    }),
  );
  const deny: AskButton[] = ask.deny
    ? [{ key: 'deny', label: DESK_WORDS.deny, onPress: () => c.decide(n, 'deny') }]
    : [];
  // A risky one may still be asked about in Talk, as on its card.
  const talkHere = risky ? c.voice && c.unlocked : talk;
  const askAbout: AskButton[] = talkHere
    ? [{ key: 'ask', label: DESK_WORDS.ask, onPress: () => c.talk(ask) }]
    : [];
  const unlock: AskButton = { key: 'unlock', label: DESK.unlockButton, primary: true, onPress: c.unlock };

  if ((risky || actions === null) && !c.unlocked) {
    // Locked: what unlocking is for, in place of the words and the answers (CG-50).
    buttons.push(unlock);
    note = { text: DESK.unlockToAnswer, icon: 'lock' };
  } else if (risky && ask.approveWithPin) {
    buttons.push({
      key: 'approve',
      label: approve,
      primary: true,
      lock: true,
      onPress: () => c.withPin(n, null),
    });
    buttons.push(...choices, ...deny, ...askAbout);
    if (why) note = { text: why, icon: 'lock' };
  } else if (risky) {
    buttons.push(...deny, ...askAbout);
    note = { text: why ? `${DESK_WORDS.approveOnPhone} ${why}` : DESK_WORDS.approveOnPhone, icon: 'phone' };
  } else if (actions === 'phone') {
    note = { text: why ? `${DESK_WORDS.onPhone} ${why}` : DESK_WORDS.onPhone, icon: 'phone' };
  } else if (actions === 'question') {
    if (talk) buttons.push({ key: 'answer', label: DESK.answer, primary: true, onPress: () => c.talk(ask) });
    else note = { text: DESK_WORDS.onPhone, icon: 'phone' };
  } else if (actions === 'approval') {
    buttons.push({ key: 'approve', label: approve, primary: true, onPress: () => c.decide(n, 'approve') });
    buttons.push(...choices, ...deny, ...askAbout);
  }
  if (c.note) note = { text: c.note };
  return {
    ...(shown.detail ? { quote: shown.detail } : {}),
    ...(shown.facts.length > 0 ? { facts: shown.facts } : {}),
    ...(ask.from ? { from: ask.from } : {}),
    buttons,
    ...(note ? { note } : {}),
    busy: c.busy,
  };
}
