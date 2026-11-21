/**
 * Pictures of what changed as a card draws them (Whombat council.md; delegate.md): each screen's
 * picture, before on top and after below, the message's attachment it is, and its numbered notes. A council's final
 * card and a delegation task's row draw them alike (`ui/cardPictures.tsx`). Pure.
 */
import type { Attachment, CouncilShot } from '@whombat/core';

/** One screen that changed: its picture (before on top, after below), its numbered notes. */
export interface CardPicture {
  /** The screen's name (“Settings · light”). */
  view: string;
  /** The message's attachment the picture is; null while the message doesn't carry it. */
  attachment: Attachment | null;
  /** Width over height, from the card (the picture's own size). */
  aspect: number;
  notes: { n: number; text: string }[];
  /** For screen readers: the screen's name and how to read the picture. */
  label: string;
}

/** The card's shots with the message's attachments they are; `hint` says how to read a picture. */
export function cardPictures(
  shots: readonly CouncilShot[],
  attachments: readonly Attachment[],
  hint: string,
): CardPicture[] {
  return shots.map((shot) => ({
    view: shot.view,
    attachment: attachments.find((a) => a.id === shot.attachmentId) ?? null,
    aspect: shot.width / shot.height,
    notes: [...shot.notes].sort((a, b) => a.n - b.n),
    label: `${shot.view}. ${hint}`,
  }));
}
