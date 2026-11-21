/**
 * Screens of widgets over the session (3.6; Whombat docs/decisions/desk-display.md DK-126…DK-149).
 *
 * The person's, on the `app` channel behind feature `desk` (Settings → Screens and the editor):
 * - `desk.screens` → `DeskScreensList`: every screen, the box's own first.
 * - `desk.screen.get {screen}` → `DeskScreenDetail`: one with its layout and choices.
 * - `desk.screen.update {screen, name?, popups?, layout?, show?}` → `DeskScreenDetail`: any of them; a layout whole
 *   (`deskLayoutProblem` must find nothing: `bad_layout`), `show` as `desk.update`'s (`applyDeskShowPatch`). The box's
 *   own screen keeps its name (the Whombat's).
 * - `desk.screen.views {screen, widgets, scenario?}` → `DeskScreenViews`: the views of any widgets as that screen would
 *   draw them now (the editor's live preview, a draft's widgets included), with the calm glance and what needs the
 *   person; `scenario` as Settings' preview (`deskPreviewInput`). Unlocked, as the person at the screen sees it.
 * - `desk.screen.try {screen, layout}` → `{until}`: that screen shows the draft for `DESK_TRY_S`, then its own again.
 * - `desk.screen.add {code, name, popups, start}` (secret) → `DeskScreenDetail`: the device showing these six letters
 *   becomes a screen (DK-146); `copy` starts it with the box's layout, `empty` with one empty page.
 * - `desk.screen.remove {screen}` → `{ok}`: a device's screen ends at once (its endpoint is revoked); a monitor's forgets
 *   its layout. The box's own can't be removed.
 * - `desk.widgets {screen, thing?}` → `DeskCatalog`: *Add a widget* — Whombat's own, the servers, the things with
 *   their widgets; with `thing`, that thing's widgets only (its page read now).
 *
 * A device becoming a screen, on the `enroll` channel (unenrolled, rate- and size-bounded):
 * - `enroll.display.request {endpoint}` (ephemeral) → `{requestId, code, expiresAt}`: the six letters it shows.
 * - `enroll.display.status {requestId}` → `{state, enrolled?, screen?}`: `added` once the person typed the letters; the
 *   endpoint is then a screen's. Reconnect to get the `screen` channel.
 *
 * A screen elsewhere, on the `screen` channel (only a screen's endpoint; nothing else is open to it):
 * - `screen.state {size, known?}` → `ScreenState`, or `{same, etag}` when nothing changed since `known`. Its size keeps
 *   Settings' picture of it right.
 * - `screen.unlock {pin}` (secret) → `ScreenLock`; `screen.lock` → `ScreenLock`. Unlocked it shows what *A summary*
 *   hides; it never answers questions or takes a look's step (on the phone or the box's own screen).
 * - `screen.image {thing, ref}` → `ScreenImage`: a picture one of its views names.
 *
 * Every change answers `desk.changed` (topic `me`), as the other `desk.*` ops.
 */
import {
  DESK_SCREEN_VIEWS_MAX,
  DeskAttention,
  DeskCalm,
  DeskGrid,
  DeskLayout,
  DeskLockedView,
  DeskPopups,
  DeskPreviewScenario,
  DeskScreenCode,
  DeskScreenId,
  DeskScreenSize,
  DeskShowPatch,
  DeskWidgetRef,
  DeskWidgetSpec,
  DeskWidgetView,
  displayLine,
  Timestamp,
} from '@whombat/core/domain';
import { z } from 'zod';
import { EnrolledOutput, NewEndpoint, PairingId } from './enrollment.js';

const Name = displayLine(40);

export const DeskScreensInput = z.strictObject({});
export const DeskScreenGetInput = z.strictObject({ screen: DeskScreenId });
export const DeskScreenUpdateInput = z.strictObject({
  screen: DeskScreenId,
  name: Name.optional(),
  popups: DeskPopups.optional(),
  layout: DeskLayout.optional(),
  show: DeskShowPatch.optional(),
});
export type DeskScreenUpdateInput = z.infer<typeof DeskScreenUpdateInput>;

export const DeskScreenViewsInput = z.strictObject({
  screen: DeskScreenId,
  widgets: z.array(DeskWidgetSpec).max(DESK_SCREEN_VIEWS_MAX),
  scenario: DeskPreviewScenario.optional(),
});
export type DeskScreenViewsInput = z.infer<typeof DeskScreenViewsInput>;
/** The editor's live preview: the top bar's name, the calm glance, the views asked for, what needs the person. */
export const DeskScreenViews = z.object({
  name: Name,
  calm: DeskCalm,
  views: z.array(DeskWidgetView).max(DESK_SCREEN_VIEWS_MAX),
  attention: DeskAttention,
});
export type DeskScreenViews = z.infer<typeof DeskScreenViews>;

export const DeskScreenTryInput = z.strictObject({ screen: DeskScreenId, layout: DeskLayout });
export const DeskScreenTryOutput = z.object({ until: Timestamp });

export const DESK_SCREEN_STARTS = ['copy', 'empty'] as const;
export const DeskScreenAddInput = z.strictObject({
  code: DeskScreenCode,
  name: Name,
  popups: DeskPopups,
  start: z.enum(DESK_SCREEN_STARTS),
});
export type DeskScreenAddInput = z.infer<typeof DeskScreenAddInput>;
export const DeskScreenRemoveInput = z.strictObject({ screen: DeskScreenId });

export const DeskWidgetsInput = z.strictObject({ screen: DeskScreenId, thing: DeskWidgetRef.optional() });

/* A device becoming a screen ------------------------------------------------------------------------------------- */

export const EnrollDisplayRequestInput = z.strictObject({ endpoint: NewEndpoint });
export const EnrollDisplayRequestOutput = z.object({
  requestId: PairingId,
  code: DeskScreenCode,
  expiresAt: Timestamp,
});
export const EnrollDisplayStatusInput = z.strictObject({ requestId: PairingId });
export const EnrollDisplayStatusOutput = z.object({
  state: z.enum(['waiting', 'added', 'expired']),
  /** When added: the account this endpoint is bound to, as a screen's. Reconnect to get the `screen` channel. */
  enrolled: EnrolledOutput.optional(),
  screen: z.object({ id: DeskScreenId, name: Name }).optional(),
});

/* A screen elsewhere --------------------------------------------------------------------------------------------- */

export const ScreenStateInput = z.strictObject({
  size: DeskScreenSize,
  /** The `etag` of the state it has: nothing changed, `{same: true}`. */
  known: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
});

/**
 * A screen's lock (DK-138): `locked` shows what `view` lets show, `unlocked` (with the PIN, until `until` unless
 * touched) shows everything, `backoff` after too many wrong PINs until `retryAt`. `hasPin` false: the person chose no
 * PIN, so it can't be unlocked here.
 */
export const ScreenLock = z.object({
  state: z.enum(['locked', 'unlocked', 'backoff']),
  view: DeskLockedView,
  hasPin: z.boolean(),
  until: Timestamp.optional(),
  retryAt: Timestamp.optional(),
  triesLeft: z.number().int().min(0).max(5).optional(),
});
export type ScreenLock = z.infer<typeof ScreenLock>;

/**
 * What a screen elsewhere draws: its own name and pop-ups, the Whombat's name for the top bar, its lock, the calm glance
 * and its grid (both null while the lock shows *Only the time*).
 */
export const ScreenState = z.object({
  etag: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  now: Timestamp,
  screen: z.object({ id: DeskScreenId, name: Name, popups: DeskPopups }),
  whombat: Name,
  /** The assistant's name, for Whombat's own widgets' words (“Dusty’s work”); absent: “Your assistant”. */
  assistant: Name.optional(),
  lock: ScreenLock,
  calm: DeskCalm.nullable(),
  grid: DeskGrid.nullable(),
});
export type ScreenState = z.infer<typeof ScreenState>;
export const ScreenStateOutput = z.union([
  ScreenState,
  z.object({ same: z.literal(true), etag: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
]);
export type ScreenStateOutput = z.infer<typeof ScreenStateOutput>;

export const ScreenUnlockInput = z.strictObject({ pin: z.string().regex(/^[0-9]{4,6}$/) });
export const ScreenLockInput = z.strictObject({});

export const ScreenImageInput = z.strictObject({
  thing: DeskWidgetRef,
  ref: z
    .string()
    .min(16)
    .max(600)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
});
/** A picture, base64; pictures are 480 px on their longest side at most, so this stays small. */
export const ScreenImage = z.object({
  type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  data: z
    .string()
    .max(4_500_000)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type ScreenImage = z.infer<typeof ScreenImage>;
