/**
 * Open to the internet (`things.exposure`, Whombat internet-exposure.md): the page's words in a locale and how a
 * press of This is meant changes the page before the box answers. The box says what each opening is, how it is
 * protected and what each place could read, in the person's language; the page adds only its own labels. Pure, for
 * the web and the phone alike.
 */
import type { ExposureOpening, ExposureView } from '@whombat/core';
import { interpolate } from '@whombat/core/i18n';
import { clientTree } from '../i18n/catalog';
import { EXPOSURE_PAGE_WORDS } from '../i18n/messages/exposure';

/** Where the page is, in the web app and in the phone's links. */
export const EXPOSURE_PATH = '/internet';

/** The page's words, in a locale (English when none is given). */
export function exposureText(locale?: string | null) {
  const w = clientTree(locale, EXPOSURE_PAGE_WORDS);
  return {
    ...w,
    open: (name: string) => interpolate(w.open, { name }),
    meantDone: (address: string) => interpolate(w.meantDone, { address }),
    pointedOut: (address: string) => interpolate(w.pointedOut, { address }),
  };
}

export type ExposureText = ReturnType<typeof exposureText>;

/**
 * The page after This is meant (`meant` true) or Point it out again (false) on one opening: meant takes its New and its
 * Worth a look away, as the box does; pointing it out again brings back only what the next read says, so until then
 * the row just loses Meant.
 */
export function withMeant(view: ExposureView, id: string, meant: boolean): ExposureView {
  let changed = false;
  const openings = view.openings.map((o): ExposureOpening => {
    if (o.id !== id || o.meant === meant) return o;
    changed = true;
    if (!meant) return { ...o, meant: false };
    const { risk: _risk, ...rest } = o;
    return { ...rest, meant: true, isNew: false };
  });
  return changed ? { ...view, openings } : view;
}

/** The chat subject an opening's question is about: the place whose settings opened it. */
export function exposureAskSubject(
  o: Pick<ExposureOpening, 'sourceThing' | 'sourceName'>,
): { kind: 'connection'; id: string; name: string } | null {
  const m = /^connection:(.+)$/.exec(o.sourceThing);
  return m?.[1] ? { kind: 'connection', id: m[1], name: o.sourceName.slice(0, 120) || m[1] } : null;
}
