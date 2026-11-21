/**
 * Buttons, galleries and controls on a thing's page (contracts 0.121, CT-1000…CT-1014; Whombat service-dashboards.md
 * SD-06…SD-11; app service-dashboards.md AP-4530…AP-4545): what a button sends and whether it may be pressed, a
 * switch's and a stepper's next value, what a control shows while its change is on its way, how often a live page
 * reads again, and how a gallery's pictures, progress and links are shaped. Pure; web and phone share it.
 */
import type {
  ThingButtonIcon,
  ThingButtonValue,
  ThingControl,
  ThingControlStepper,
  ThingGalleryItem,
  ThingImageShape,
  ThingPage,
  ThingPageButton,
  ThingPageConfirm,
  ThingPagePanel,
} from '@whombat/core';
import type { ThingActionBody } from '@whombat/core/contracts';

/** A gallery panel (CT-1004) and a controls panel (CT-1005), as the clients draw them. */
export type ThingGalleryPanel = Extract<ThingPagePanel, { kind: 'gallery' }>;
export type ThingControlsPanel = Extract<ThingPagePanel, { kind: 'controls' }>;

/* Buttons (AP-4530, AP-4531) ---------------------------------------------------------------------- */

/** A button as the clients draw it: its words, icon and tone, whether it may be pressed (and why not), its question. */
export interface ThingButtonView {
  /** Stable for the button and what it sends: which one runs, a list's React key. */
  key: string;
  label: string;
  icon: ThingButtonIcon | null;
  tone: 'primary' | 'danger' | null;
  /** Drawn disabled: the viewer may not (Look only, not theirs to manage). */
  disabled: boolean;
  /** Why not, as the server says it: the disabled button's tooltip and description. */
  reason: string | null;
  /** The question before it runs (doors, locks, alarms, covers, power, anything for everyone). */
  confirm: ThingPageConfirm | null;
}

/** A button's key: its action, target and value (a switch's key includes the value it would send). */
export function thingButtonKey(
  button: Pick<ThingPageButton, 'action' | 'target' | 'value'>,
  value: ThingButtonValue | undefined = button.value,
): string {
  return `${button.action}|${button.target ?? ''}|${value === undefined ? '' : JSON.stringify(value)}`;
}

export function thingButtonView(button: ThingPageButton): ThingButtonView {
  return {
    key: thingButtonKey(button),
    label: button.label,
    icon: button.icon ?? null,
    tone: button.tone ?? null,
    disabled: !button.allowed,
    reason: button.allowed ? null : button.reason?.trim() || null,
    confirm: button.confirm ?? null,
  };
}

/**
 * What `things.action` gets for a button (CT-1006): its action and target, and its value — or `value` when the client
 * chose one (a switch's `!on`, a stepper's new figure).
 */
export function thingActionBody(button: ThingPageButton, value?: ThingButtonValue): ThingActionBody {
  const v = value ?? button.value;
  return {
    action: button.action,
    ...(button.target !== undefined ? { target: button.target } : {}),
    ...(v !== undefined ? { value: v } : {}),
  };
}

/* Switches and steppers (AP-4532, AP-4533) -------------------------------------------------------- */

/** What a control's tile draws (CT-1005): its switch, its stepper, its buttons, its picture, or its value only. */
export type ThingControlLook = 'switch' | 'stepper' | 'buttons' | 'image' | 'value';

export function thingControlLook(control: ThingControl): ThingControlLook {
  if (control.toggle) return 'switch';
  if (control.stepper) return 'stepper';
  if (control.buttons?.length) return 'buttons';
  if (control.image) return 'image';
  return 'value';
}

/** A switch sends the state it isn't in (`value: !on`, CT-1005). */
export function switchValue(on: boolean | undefined): boolean {
  return !on;
}

/** How long a stepper waits after the last press before it sends its figure (a few presses send once). */
export const STEPPER_SEND_MS = 700;

/** Decimals a step needs (`0.5` → 1, `1` → 0, `0.25` → 2). */
function stepDecimals(step: number): number {
  const s = String(step);
  const e = /e-(\d+)$/.exec(s);
  if (e) return Number(e[1]);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** The figure on the stepper's grid (from `min`, by `step`) nearest `v`, within `min`…`max`. */
export function stepperClamp(stepper: Pick<ThingControlStepper, 'min' | 'max' | 'step'>, v: number): number {
  const d = stepDecimals(stepper.step);
  const onGrid = stepper.min + Math.round((v - stepper.min) / stepper.step) * stepper.step;
  const clamped = Math.min(stepper.max, Math.max(stepper.min, onGrid));
  return Number(clamped.toFixed(d));
}

/** One step up (`1`) or down (`-1`) from `from`, kept within `min`…`max`. */
export function stepperNext(
  stepper: Pick<ThingControlStepper, 'min' | 'max' | 'step'>,
  from: number,
  dir: 1 | -1,
): number {
  return stepperClamp(stepper, from + dir * stepper.step);
}

/** Whether a step that way is possible from `value`. */
export function stepperCan(
  stepper: Pick<ThingControlStepper, 'min' | 'max'>,
  value: number,
  dir: 1 | -1,
): boolean {
  return dir > 0 ? value < stepper.max : value > stepper.min;
}

/** The stepper's figure in words, as many decimals as its step has: “21.5 °C”, “21.0 °C”, “40 %”. */
export function stepperWords(stepper: Pick<ThingControlStepper, 'step' | 'unit'>, value: number): string {
  const n = value.toFixed(stepDecimals(stepper.step));
  return stepper.unit ? `${n} ${stepper.unit}` : n;
}

/* What a control shows while its change is on its way (AP-4534) ---------------------------------- */

/**
 * A switch's or stepper's state as the person set it, shown until the page is read again after the server answered
 * (CT-1005: “optimistic, settles on the next read”). `answeredAt` is null while the action runs.
 */
export interface ControlGuess {
  value: boolean | number;
  answeredAt: number | null;
}

/** Guesses by control id. */
export type ControlGuesses = Readonly<Record<string, ControlGuess>>;

/** The guesses a read at `readAt` (ms; the page's `dataUpdatedAt`) leaves standing: one answered before it settled. */
export function settleGuesses(guesses: ControlGuesses, readAt: number): ControlGuesses {
  let out: Record<string, ControlGuess> | null = null;
  for (const [id, g] of Object.entries(guesses)) {
    if (g.answeredAt !== null && g.answeredAt <= readAt) {
      out ??= { ...guesses };
      delete out[id];
    }
  }
  return out ?? guesses;
}

/** Whether a switch shows on: the guess while it stands, else the page's `on`. */
export function guessedOn(control: Pick<ThingControl, 'id' | 'on'>, guesses: ControlGuesses): boolean {
  const g = guesses[control.id];
  return typeof g?.value === 'boolean' ? g.value : !!control.on;
}

/** A stepper's figure: the guess while it stands, else the page's. */
export function guessedStep(
  control: Pick<ThingControl, 'id'> & { stepper: Pick<ThingControlStepper, 'value'> },
  guesses: ControlGuesses,
): number {
  const g = guesses[control.id];
  return typeof g?.value === 'number' ? g.value : control.stepper.value;
}

/* Live pages (AP-4535) ----------------------------------------------------------------------------- */

/** How often an open page reads again when it doesn't say (CP-04, SD-09). */
export const THING_PAGE_REFRESH_S = 60;
/** Never more often than this, whatever a page says (CT-1010). */
export const THING_PAGE_REFRESH_MIN_S = 5;

/** How often an open, shown page reads again, in ms: its `refreshS` (at least 5 s), else a minute. */
export function thingRefreshMs(page: Pick<ThingPage, 'refreshS'> | null | undefined): number {
  return Math.max(THING_PAGE_REFRESH_MIN_S, page?.refreshS ?? THING_PAGE_REFRESH_S) * 1000;
}

/** A page that shows something moving (it asks to be read more often than the minute). */
export function thingPageIsLive(page: Pick<ThingPage, 'refreshS'> | null | undefined): boolean {
  return thingRefreshMs(page) < THING_PAGE_REFRESH_S * 1000;
}

/* Galleries and pictures (AP-4536, AP-4537) ------------------------------------------------------- */

/** A picture's box, width over height: posters 2:3, snapshots 16:9, thumbnails 1:1 (CT-1000). */
export const THING_IMAGE_ASPECT: Record<ThingImageShape, number> = {
  poster: 2 / 3,
  wide: 16 / 9,
  square: 1,
};

/** The box as CSS's `aspect-ratio` says it: `2 / 3`, `16 / 9`, `1 / 1`. */
export const THING_IMAGE_RATIO: Record<ThingImageShape, string> = {
  poster: '2 / 3',
  wide: '16 / 9',
  square: '1 / 1',
};

/** Where a gallery item leads: another page of the app (wins), the service's own page in a new tab, or nowhere. */
export type ThingItemLink = { kind: 'href'; href: string } | { kind: 'url'; url: string } | null;

export function thingItemLink(item: Pick<ThingGalleryItem, 'href' | 'url'>): ThingItemLink {
  if (item.href) return { kind: 'href', href: item.href };
  if (item.url) return { kind: 'url', url: item.url };
  return null;
}

/** A progress bar's fill in whole percent (0…100), or null without one. */
export function thingProgressPct(progress: number | null | undefined): number | null {
  if (progress === null || progress === undefined || !Number.isFinite(progress)) return null;
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}

/** The letter an empty picture box shows: the title's first letter or digit (“Dune” → “D”, “’71” → “7”). */
export function thingImageInitial(title: string): string {
  const m = /[\p{L}\p{N}]/u.exec(title);
  return m ? m[0].toLocaleUpperCase() : '';
}

/**
 * A gallery item's name for screen readers when its parts are read as one (a link or a tile): the title, `sub`, the
 * badge, and the note under its progress, in that order.
 */
export function thingGalleryWords(
  item: Pick<ThingGalleryItem, 'title' | 'sub' | 'badge' | 'note' | 'progress'>,
): string {
  const pct = thingProgressPct(item.progress);
  return [item.title, item.sub, item.badge?.text, item.note ?? (pct === null ? undefined : `${pct} %`)]
    .filter((p): p is string => !!p)
    .join(' · ');
}
