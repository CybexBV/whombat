/**
 * What needs the person, as the screen shows it (DK-135, DK-136), pure: the modal opens for what pops and wasn't put
 * away, in the planner's order; *Not now* puts the shown ones away (the host keeps their keys); it opens again only for
 * a new key and closes when its items are gone. The pill counts everything and opens the modal with all of it.
 */
import type { DeskAttention, DeskAttentionItem, DeskAttentionTone } from './types';
import { fillWords, screenWords } from './words';

/** `pops` the modal opened by itself, `all` the pill opened it with everything. */
export type ModalMode = 'pops' | 'all';

export interface ModalState {
  /** Opened from the pill, with everything; false while it opens only by itself. */
  pill: boolean;
  /** The item shown, by key, so it stays shown while the list changes around it. */
  shown: string | null;
}

export const MODAL_CLOSED: ModalState = { pill: false, shown: null };

export interface ModalView {
  open: boolean;
  mode: ModalMode;
  items: DeskAttentionItem[];
  index: number;
  item: DeskAttentionItem | null;
}

/** What pops on this screen and wasn't put away. */
export function popping(attention: DeskAttention, away: ReadonlySet<string>): DeskAttentionItem[] {
  return attention.items.filter((i) => i.pops && !away.has(i.key));
}

export function modalView(attention: DeskAttention, away: ReadonlySet<string>, state: ModalState): ModalView {
  const items = state.pill ? attention.items : popping(attention, away);
  const at = state.shown === null ? -1 : items.findIndex((i) => i.key === state.shown);
  const index = at < 0 ? 0 : at;
  const item = items[index] ?? null;
  return { open: item !== null, mode: state.pill ? 'all' : 'pops', items, index, item };
}

/** “1 of 3”'s arrows: the item before or after, kept by key. */
export function modalStep(view: ModalView, by: -1 | 1): ModalState {
  const next = view.items[Math.max(0, Math.min(view.items.length - 1, view.index + by))];
  return { pill: view.mode === 'all', shown: next?.key ?? null };
}

/** *Not now*: the keys to put away (everything the modal shows) and the modal closed. */
export function notNow(view: ModalView): { away: string[]; state: ModalState } {
  return { away: view.items.map((i) => i.key), state: MODAL_CLOSED };
}

/** The pill (DK-136): its words and colour while anything needs the person; null otherwise. */
export function pill(
  attention: DeskAttention,
  locale?: string | null,
): { text: string; tone: DeskAttentionTone } | null {
  const n = attention.items.length + attention.more;
  if (n === 0) return null;
  const tone = attention.tone ?? (attention.items.some((i) => i.tone === 'bad') ? 'bad' : 'warn');
  const words = screenWords(locale).pill;
  return {
    text: n === 1 ? words.one : fillWords(words.many, { n }),
    tone,
  };
}

/** The thin edge along the top (DK-135): while an outage or a question pops here, put away or not. */
export function edgeTone(attention: DeskAttention): DeskAttentionTone | null {
  const pops = attention.items.filter((i) => i.pops);
  if (pops.length === 0) return null;
  return pops.some((i) => i.tone === 'bad') ? 'bad' : 'warn';
}
