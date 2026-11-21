/**
 * The composer's mentions in any letter case (Whombat messaging.md MS-C01…MS-C03; docs/decisions/app-managed.md
 * AP-607): one model for every place a message is typed, on the web and Android. Core decides what a mention is
 * (`autocorrectMentionAt`, `canonicalizeMentions`); this decides when the composer applies it.
 */
import {
  autocorrectMentionAt,
  canonicalizeMentions,
  type MentionTarget,
  type Principal,
} from '@whombat/core';

/** One change to a composer's text, as the field reports it. */
export interface ComposerEdit {
  /** The text before the change. */
  previous: string;
  /** The text after it. */
  next: string;
  /**
   * The caret after the change (the web's `selectionStart`). Omitted where the field doesn't say it with the change
   * (Android's `onChangeText`): then it is where the inserted text ends.
   */
  caret?: number;
  /** The web's `InputEvent.inputType` (`insertText`, `deleteContentBackward`, …), when known. */
  inputType?: string;
  /** An IME composition is still open: nothing is corrected until it is committed. */
  composing?: boolean;
}

/**
 * Who `@Name` can mean in a composer: the agent and the person (system actors are nobody's `@Name`). `viewerId` is
 * kept for the callers' sake.
 */
export function composerMentionTargets(
  principals: readonly Principal[],
  _viewerId?: string | null,
): MentionTarget[] {
  const targets: MentionTarget[] = [];
  for (const p of principals) {
    if (p.kind === 'system') continue;
    const shortName = p.kind === 'person' ? p.shortName : undefined;
    targets.push({ id: p.id, kind: p.kind, name: p.name, ...(shortName ? { shortName } : {}) });
  }
  return targets;
}

/** Lengths of the common prefix and suffix of two strings, the prefix taken first or the suffix taken first. */
function commonEnds(a: string, b: string, prefixFirst: boolean): { prefix: number; suffix: number } {
  const max = Math.min(a.length, b.length);
  const prefixOf = (limit: number) => {
    let i = 0;
    while (i < limit && a[i] === b[i]) i++;
    return i;
  };
  const suffixOf = (limit: number) => {
    let i = 0;
    while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  };
  if (prefixFirst) {
    const prefix = prefixOf(max);
    return { prefix, suffix: suffixOf(max - prefix) };
  }
  const suffix = suffixOf(max);
  return { prefix: prefixOf(max - suffix), suffix };
}

/**
 * Did the change insert text (typing, a line break, a paste, a replaced selection)? Deletions never auto-correct:
 * backspacing over `@banjo hi` to `@banjo ` leaves it as it is.
 */
export function isInsertion(edit: ComposerEdit): boolean {
  if (edit.inputType) return edit.inputType.startsWith('insert');
  const { prefix, suffix } = commonEnds(edit.previous, edit.next, true);
  return edit.next.length - prefix - suffix > 0;
}

/**
 * The composer's auto-correct after a change (MS-C03): when the character just inserted ended an `@word` that names a
 * target in another letter case (`@banjo ` → `@Banjo `), the text with that word in its canonical form, caret kept.
 * Null when there is nothing to correct: a deletion, an open IME composition, an unknown word, an email, code.
 */
export function autocorrectComposerMention(
  edit: ComposerEdit,
  targets: readonly MentionTarget[],
): { text: string; caret: number } | null {
  if (edit.composing || !edit.next.includes('@') || targets.length === 0) return null;
  if (!isInsertion(edit)) return null;
  if (edit.caret !== undefined) return autocorrectMentionAt(edit.next, edit.caret, targets);
  // Without a caret it is where the inserted text ends. A character typed beside the same character can be read two
  // ways (`@banjo␣x` + `␣`): try both ends.
  const carets = new Set<number>();
  for (const prefixFirst of [true, false]) {
    const { prefix, suffix } = commonEnds(edit.previous, edit.next, prefixFirst);
    if (edit.next.length - prefix - suffix > 0) carets.add(edit.next.length - suffix);
  }
  for (const caret of carets) {
    const hit = autocorrectMentionAt(edit.next, caret, targets);
    if (hit) return hit;
  }
  return null;
}

/** The text a composer sends or saves: every mention in its canonical form (MS-C02), the rest as typed. */
export function composerText(text: string, targets: readonly MentionTarget[]): string {
  return canonicalizeMentions(text, targets);
}
