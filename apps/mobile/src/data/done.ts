/**
 * Everything I did's words on the phone (Whombat home-redesign HR-24; home-redesign-mobile.md AP-2259…AP-2261; Home's
 * card is gone, home-simplify.md AP-2269). What Undo did is the shared `undoOutcome`. Pure; the parts are
 * `screens/home/DoneParts.tsx` and `screens/DoneScreen.tsx`.
 */
import { mobileTranslator } from '../i18n/translate';

export function doneCopy(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    screenTitle: t('data.done.screenTitle'),
    intro: (name: string) => t('data.done.intro', { name }),
    screenEmpty: (name: string) => t('data.done.screenEmpty', { name }),
    failed: t('data.done.failed'),
    showOlder: t('data.done.showOlder'),
    undo: t('data.done.undo'),
    review: t('data.done.review'),
    undone: t('data.done.undone'),
    /** Opens the chat where the assistant puts a change back (contracts 0.91 `requested`). */
    openChat: t('data.done.openChat'),
  } as const;
}
export const DONE_COPY = doneCopy();
