/**
 * A service's page on the phone (Whombat service-dashboards.md SD-06…SD-11; app service-dashboards.md AP-4630…AP-4649):
 * what the stacked renderer draws from contracts 0.121's galleries, controls and buttons, as plain data — a gallery's
 * layout at phone width (posters in a row that scrolls, snapshots two by two, thumbnails three by three), each item's
 * words, picture, progress, link and buttons; a control tile's look, whether it is lit and how TalkBack reads it; a
 * button's hint (why it can't be pressed, or the question it asks first). The shared client decides what a button sends
 * and how a picture, a switch or a stepper behaves (`@whombat/client`, AP-4530…AP-4540); this only arranges it for a
 * narrow screen. Pure; the renderer is `screens/thing/Gallery.tsx`, `Controls.tsx` and `ThingButton.tsx`.
 */
import {
  doneWhen,
  type ThingButtonView,
  type ThingControlLook,
  type ThingGalleryPanel,
  thingControlLook,
  thingGalleryWords,
  thingImageInitial,
  thingItemLink,
  thingProgressPct,
} from '@whombat/client';
import type {
  ThingControl,
  ThingControlIcon,
  ThingImage,
  ThingImageShape,
  ThingPageButton,
  ThingTone,
} from '@whombat/core';
import { mobileTranslator } from '../i18n/translate';
import type { LinkRun } from './thingPage';

export function serviceCopy(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    /** A link to the service's own page (TalkBack's hint). */
    opensBrowser: t('data.servicePanels.opensBrowser'),
    /** A link to another page of the app. */
    opensPage: t('data.servicePanels.opensPage'),
    /** A press whose answer had no words of its own. */
    failed: t('data.servicePanels.failed'),
    /** A stepper's − and + for TalkBack. */
    lower: (label: string) => t('data.servicePanels.lower', { label }),
    raise: (label: string) => t('data.servicePanels.raise', { label }),
  } as const;
}
export const SERVICE_COPY = serviceCopy();

/* Galleries (CT-1004) ---------------------------------------------------------------------------------------------- */

/**
 * How a gallery sits at phone width: posters in one row that scrolls sideways (each `width` dp), snapshots two by two,
 * thumbnails three by three.
 */
export type GalleryLayout = { kind: 'row'; width: number } | { kind: 'grid'; columns: 2 | 3 };

/** A poster's width in the row: two and a bit show at 368dp, so the row says it scrolls. */
export const POSTER_WIDTH = 116;

export function galleryLayout(shape: ThingImageShape): GalleryLayout {
  switch (shape) {
    case 'poster':
      return { kind: 'row', width: POSTER_WIDTH };
    case 'wide':
      return { kind: 'grid', columns: 2 };
    case 'square':
      return { kind: 'grid', columns: 3 };
  }
}

export interface GalleryItemView {
  id: string;
  title: string;
  /** `sub`, else when it happened (“14:05”, “Tue”). */
  sub: string | null;
  badge: { text: string; tone: ThingTone } | null;
  /** The progress bar's fill, 0…100; null without one. */
  pct: number | null;
  note: string | null;
  /** Greyed: an offline camera. */
  muted: boolean;
  image: ThingImage | null;
  /** The letter an empty box shows. */
  initial: string;
  /** Where the picture and its words lead: a page of the app, or the service's own page in the browser. */
  link: LinkRun | null;
  /** TalkBack's hint for the link. */
  linkHint: string | null;
  /** The item read as one: “Dune: Part Two · 2024 · Asked by Anna · Converting · 63 % · 12 min left”. */
  spoken: string;
  actions: readonly ThingPageButton[];
}

export function galleryItems(
  panel: Pick<ThingGalleryPanel, 'items'>,
  now: Date | number,
  timeZone: string,
  locale?: string,
): GalleryItemView[] {
  const SERVICE_COPY = serviceCopy(locale);
  return panel.items.map((item) => {
    const sub = item.sub?.trim() || (item.at ? doneWhen(item.at, now, timeZone, locale) : null);
    const to = thingItemLink(item);
    const link: LinkRun | null = to
      ? to.kind === 'href'
        ? { kind: 'href', href: to.href }
        : { kind: 'url', url: to.url }
      : null;
    return {
      id: item.id,
      title: item.title,
      sub,
      badge: item.badge ?? null,
      pct: thingProgressPct(item.progress),
      note: item.note?.trim() || null,
      muted: !!item.muted,
      image: item.image ?? null,
      initial: thingImageInitial(item.title),
      link,
      linkHint: link ? (link.kind === 'url' ? SERVICE_COPY.opensBrowser : SERVICE_COPY.opensPage) : null,
      spoken: thingGalleryWords({ ...item, sub: sub ?? undefined }),
      actions: item.actions ?? [],
    };
  });
}

/** Items in rows of `n` (a grid, or tiles two by two); the last row may be short. */
export function rowsOf<T>(items: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** A small picture before a list line's words (CT-1002): a poster 30 wide, a thumbnail 38, a snapshot 64 (AP-4569). */
export const LINE_PICTURE_WIDTH: Record<ThingImageShape, number> = { poster: 30, square: 38, wide: 64 };

/* Controls (CT-1005) ----------------------------------------------------------------------------------------------- */

export interface ControlTileView {
  id: string;
  label: string;
  icon: ThingControlIcon | null;
  look: ThingControlLook;
  /** The state words (“On · 80 %”, “21.5 °C”, “Locked”), in their tone when it is warn or bad. */
  state: string | null;
  stateTone: 'warn' | 'bad' | null;
  /** Lit in the second chart colour: it is on (a switch as the person just set it). */
  lit: boolean;
  /** TalkBack's name for a tile that isn't a switch: “Front door, Locked”. A switch says its state as checked. */
  spoken: string;
}

/** A control's tile; `on` is what its switch shows now (the page's, or the person's guess while it settles). */
export function controlTile(control: ThingControl, on: boolean): ControlTileView {
  const look = thingControlLook(control);
  const state = control.state?.trim() || null;
  return {
    id: control.id,
    label: control.label,
    icon: control.icon ?? null,
    look,
    state,
    stateTone: control.tone === 'warn' || control.tone === 'bad' ? control.tone : null,
    lit: look === 'switch' ? on : !!control.on,
    spoken: state ? `${control.label}, ${state}` : control.label,
  };
}

/* Buttons (CT-1001) ------------------------------------------------------------------------------------------------ */

/**
 * TalkBack's hint for a button: why it can't be pressed (the server's reason; pressing it shows the same words), or the
 * question it asks first.
 */
export function buttonHint(
  view: Pick<ThingButtonView, 'disabled' | 'reason' | 'confirm'>,
): string | undefined {
  if (view.disabled) return view.reason ?? undefined;
  return view.confirm?.title;
}

/** The words a press leaves in the toast: the server's, or plain ones when a failure came without any. */
export function pressNote(message: string, outcome: 'done' | 'failed', locale?: string): string | null {
  const text = message.trim();
  if (text) return text;
  return outcome === 'failed' ? serviceCopy(locale).failed : null;
}
