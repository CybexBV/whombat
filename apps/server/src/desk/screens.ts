/**
 * The screens of widgets in the database (`screens`, migration 0013; docs/decisions/desk-display.md DK-126…DK-149,
 * desk-display-server.md “Screens of widgets”): the box's own display, each monitor plugged into the box and each tablet
 * or computer that became a screen, each with its name, pop-ups, layout and choices. Read here; written only through
 * the commit pipeline by the commands below.
 *
 * - **The box's own** (`box`) has no row until someone changes it or the box says its size: until then it is
 *   `deskDefaultLayout()` with pop-ups *Questions and problems*. Its name is always *This Whombat’s screen*, and its
 *   *What’s going on* and *Servers* choices stay where the paired screen keeps them (`desk_screens.show`).
 * - **A monitor** (`out_<output>`) gets its row the first time the box's page reports it, pop-ups *Problems only*, and
 *   keeps it after it's unplugged, for the next time; *Remove* forgets it.
 * - **A device** (`scr_…`) is written by its enrolment's commit (`addDevice`), with its endpoint.
 *
 * A layout that was never arranged is kept as `{}` and reads as the default, so a better default reaches every screen
 * nobody arranged; a layout an older or newer runtime wrote that this one can't read is the default too.
 */
import { randomBytes } from 'node:crypto';
import {
  DESK_DEFAULT_SHAPE,
  DESK_SCREEN_BOX,
  DESK_SCREEN_WORDS,
  DESK_SCREENS_MAX,
  DESK_WORDS,
  DeskDoorbell,
  type DeskLayout,
  DeskLayout as DeskLayoutSchema,
  DeskPopups,
  DeskScreenId,
  type DeskScreenKind,
  type DeskScreenSize,
  DeskShow,
  deskDefaultLayout,
  deskEmptyPage,
  deskLayoutProblem,
  parseDeskShapeKey,
} from '@whombat/core';
import { DESK_ERROR_STATUS } from '@whombat/protocol/session';
import { sizeOf } from '@whombat/screen';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import { principals, screens } from '../db/schema/index';
import { SYSTEM_SERVERS, serversPrincipal } from '../hosts/principal';
import { forbidden } from '../lib/errors';
import { revokeScreenKey } from '../managed/display';
import { SessionOpError } from '../managed/session-error';
import type { Services } from '../services';
import { loadDeskRow, showOf } from './store';
import type { ScreenRecord } from './widgets/types';

export type ScreenRow = typeof screens.$inferSelect;

/** What a layout nobody arranged is kept as: it reads as the default (`layoutOf`). */
export const NOT_ARRANGED = {};

/** A screen that said its size within this long is showing now (DK-128's list). */
export const SCREEN_ONLINE_MS = 2 * 60_000;
/** A screen's size and when it was seen are written at most this often, unless the size changed. */
export const SCREEN_SEEN_EVERY_MS = 60_000;

/* Refusals (CT-525: the generic code, the desk's own in `details.code`) ------------------------------------------- */

export const unknownScreen = () =>
  new SessionOpError(DESK_ERROR_STATUS.unknown_screen, DESK_WORDS.errors.unknown_screen, {
    code: 'unknown_screen',
  });
export const screensFull = () =>
  new SessionOpError(DESK_ERROR_STATUS.screens_full, DESK_WORDS.errors.screens_full, {
    code: 'screens_full',
  });
export const badLayout = (why?: string) =>
  new SessionOpError(DESK_ERROR_STATUS.bad_layout, DESK_WORDS.errors.bad_layout, {
    code: 'bad_layout',
    ...(why ? { why } : {}),
  });

/* Reading ---------------------------------------------------------------------------------------------------------- */

/** A kept layout as the screen draws it: the default when it was never arranged or can't be read. */
export function layoutOf(stored: unknown): DeskLayout {
  const parsed = DeskLayoutSchema.safeParse(stored);
  if (!parsed.success || deskLayoutProblem(parsed.data) !== null) return deskDefaultLayout();
  return parsed.data;
}

/** What kind of screen an id names. */
export function screenKind(id: string): DeskScreenKind {
  if (id === DESK_SCREEN_BOX) return 'box';
  return id.startsWith('out_') ? 'output' : 'device';
}

/** A monitor's screen id from its output (`hdmi-a-1` → `out_hdmi-a-1`), or null for a name the id can't carry. */
export function outputScreenId(key: string): string | null {
  const id = `out_${key.toLowerCase()}`;
  return DeskScreenId.safeParse(id).success ? id : null;
}

/** A device's new screen id: `scr_` and 16 random characters. */
export function newDeviceScreenId(random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  return `scr_${Buffer.from(random(12)).toString('base64url')}`;
}

const popupsOf = (stored: string, kind: DeskScreenKind) => {
  const parsed = DeskPopups.safeParse(stored);
  return parsed.success ? parsed.data : kind === 'box' ? 'all' : 'problems';
};

/** A row as the runtime uses it; the box's choices are the paired screen's (`boxShow`). */
export function recordOf(row: ScreenRow, boxShow: DeskShow | null = null): ScreenRecord {
  const kind = screenKind(row.id);
  return {
    id: row.id,
    burrowId: row.burrowId,
    kind,
    // The box's own keeps its name; a monitor without one is *Monitor on this Whombat*.
    name: kind === 'box' ? DESK_SCREEN_WORDS.box : row.name || DESK_SCREEN_WORDS[kind],
    popups: popupsOf(row.popups, kind),
    doorbell: row.doorbell === 'off' ? 'off' : 'big',
    layout: layoutOf(row.layout),
    show: kind === 'box' && boxShow ? boxShow : showOf(row.show),
    endpointId: row.endpointId,
    personId: row.personId,
    device: row.device,
    size: row.width !== null && row.height !== null ? { width: row.width, height: row.height } : null,
    lastSeenAt: row.lastSeenAt,
  };
}

/** The box's own before anyone changed it or it said its size. */
export function defaultBoxRecord(burrowId: string, show: DeskShow, personId: string | null): ScreenRecord {
  return {
    id: DESK_SCREEN_BOX,
    burrowId,
    kind: 'box',
    name: DESK_SCREEN_WORDS.box,
    popups: 'all',
    doorbell: 'big',
    layout: deskDefaultLayout(),
    show,
    endpointId: null,
    personId,
    device: null,
    size: null,
    lastSeenAt: null,
  };
}

/** The box's own choices: the paired screen's when it's paired in this burrow, else the defaults. */
async function boxShowOf(db: Db, burrowId: string): Promise<{ show: DeskShow; personId: string | null }> {
  const desk = await loadDeskRow(db);
  return desk && desk.burrowId === burrowId
    ? { show: showOf(desk.show), personId: desk.personId }
    : { show: DeskShow.parse({}), personId: null };
}

const KIND_ORDER: Record<DeskScreenKind, number> = { box: 0, output: 1, device: 2 };

/** Every screen of the burrow: the box's own first (a default one when it has no row), then monitors, then devices. */
export async function loadScreens(db: Db, burrowId: string): Promise<ScreenRecord[]> {
  const [rows, box] = await Promise.all([
    db.select().from(screens).where(eq(screens.burrowId, burrowId)).orderBy(asc(screens.createdAt)),
    boxShowOf(db, burrowId),
  ]);
  const records = rows.map((row) => recordOf(row, box.show));
  if (!records.some((r) => r.kind === 'box'))
    records.unshift(defaultBoxRecord(burrowId, box.show, box.personId));
  return records.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** One screen of the burrow, the box's own always; null for an id it doesn't have. */
export async function loadScreen(db: Db, burrowId: string, id: string): Promise<ScreenRecord | null> {
  const [row] = await db
    .select()
    .from(screens)
    .where(and(eq(screens.burrowId, burrowId), eq(screens.id, id)));
  if (row) return recordOf(row, row.id === DESK_SCREEN_BOX ? (await boxShowOf(db, burrowId)).show : null);
  if (id !== DESK_SCREEN_BOX) return null;
  const box = await boxShowOf(db, burrowId);
  return defaultBoxRecord(burrowId, box.show, box.personId);
}

/** The screen a device's endpoint is (null: none, or not a device's). */
export async function loadScreenByEndpoint(db: Db, endpointId: string): Promise<ScreenRecord | null> {
  const [row] = await db.select().from(screens).where(eq(screens.endpointId, endpointId));
  return row && screenKind(row.id) === 'device' ? recordOf(row) : null;
}

/** Screens besides the box's own (the limit counts these). */
async function othersCount(db: Db, burrowId: string): Promise<number> {
  const rows = await db.select({ id: screens.id }).from(screens).where(eq(screens.burrowId, burrowId));
  return rows.filter((r) => r.id !== DESK_SCREEN_BOX).length;
}

/* Checks ----------------------------------------------------------------------------------------------------------- */

/**
 * Why a layout can't be kept, or null: the contract's rules (`deskLayoutProblem`), and every widget within its own
 * smallest and largest size (`@whombat/screen`), a panel's by the view it draws when known (`viewOf`).
 */
export function layoutRefusal(
  layout: DeskLayout,
  viewOf: (widgetId: string) => string | undefined = () => undefined,
): string | null {
  const problem = deskLayoutProblem(layout);
  if (problem) return problem;
  for (const page of layout.pages)
    for (const [shape, widgets] of Object.entries(page.layouts)) {
      const grid = parseDeskShapeKey(shape);
      for (const w of widgets) {
        const size = sizeOf(w, viewOf(w.id));
        // A grid smaller than a widget's smallest size takes it as small as the grid is.
        const minW = Math.min(size.min[0], grid?.cols ?? size.min[0]);
        const minH = Math.min(size.min[1], grid?.rows ?? size.min[1]);
        if (w.w < minW || w.h < minH) return `${w.id} smaller than it can be`;
        if (w.w > size.max[0] || w.h > size.max[1]) return `${w.id} larger than it can be`;
      }
    }
  return null;
}

/* Writing ---------------------------------------------------------------------------------------------------------- */

/** Who may write a screen: the person, or Whombat itself for what the box reports (its sizes, a monitor appearing). */
async function checkWriter(tx: Tx, actor: { id: string; kind: string }, system: boolean): Promise<void> {
  if (actor.kind === 'person' && !system) return;
  const [row] = await tx
    .select({ system: principals.system })
    .from(principals)
    .where(eq(principals.id, actor.id));
  if (system && (row?.system === SYSTEM_SERVERS || actor.kind === 'person')) return;
  throw forbidden('Only you can change a screen.');
}

const Name = z.string().regex(/^(?:[^\p{Cc}\p{Cf}\p{Cs}\p{Z}]| ){1,40}$/u);

/**
 * The person changes a screen (DK-128, DK-143, DK-144, DK-137): its name (not the box's own), pop-ups, what it
 * does when the doorbell rings, layout (checked before by the service: `layoutRefusal`), choices (a monitor's or a
 * device's; the box's own go through `update_desk`). The box's own row is written now if it had none. Signed without
 * words, as a setting is.
 */
export const updateScreen = defineCommand({
  name: 'update_screen',
  schema: z.object({
    id: DeskScreenId,
    name: Name.optional(),
    popups: DeskPopups.optional(),
    doorbell: DeskDoorbell.optional(),
    layout: DeskLayoutSchema.optional(),
    show: DeskShow.optional(),
  }),
  async apply(tx, ctx, input) {
    await checkWriter(tx, ctx.actor, false);
    const [row] = await tx
      .select()
      .from(screens)
      .where(and(eq(screens.burrowId, ctx.burrow.id), eq(screens.id, input.id)));
    const box = input.id === DESK_SCREEN_BOX;
    if (!row && !box) throw unknownScreen();
    if (input.layout && deskLayoutProblem(input.layout))
      throw badLayout(deskLayoutProblem(input.layout) ?? '');
    const changed = {
      ...(input.name !== undefined && !box ? { name: input.name.trim() } : {}),
      ...(input.popups ? { popups: input.popups } : {}),
      ...(input.doorbell ? { doorbell: input.doorbell } : {}),
      ...(input.layout ? { layout: input.layout } : {}),
      ...(input.show && !box ? { show: input.show } : {}),
    };
    if (!row)
      await tx.insert(screens).values({
        id: DESK_SCREEN_BOX,
        burrowId: ctx.burrow.id,
        kind: 'box',
        name: DESK_SCREEN_WORDS.box,
        popups: 'all',
        layout: NOT_ARRANGED,
        personId: ctx.actor.kind === 'person' ? ctx.actor.id : null,
        createdAt: ctx.now,
        updatedAt: ctx.now,
        ...changed,
      });
    else if (Object.keys(changed).length > 0)
      await tx
        .update(screens)
        .set({ ...changed, updatedAt: ctx.now })
        .where(and(eq(screens.burrowId, ctx.burrow.id), eq(screens.id, input.id)));
    await ctx.emit({
      type: 'desk.screen_updated',
      kind: 'System',
      text: null,
      where: null,
      payload: { screen: input.id, changed: Object.keys(changed) },
    });
    return { ok: true as const };
  },
});

/**
 * *Remove* on a monitor's screen (DK-147): its layout and choices are forgotten; plugged in again, it starts over. A
 * device's row goes when its endpoint is revoked (`revokeScreenDevice`); Whombat itself may write that too.
 */
export const forgetScreen = defineCommand({
  name: 'forget_screen',
  schema: z.object({ id: DeskScreenId }),
  async apply(tx, ctx, input) {
    await checkWriter(tx, ctx.actor, true);
    if (input.id === DESK_SCREEN_BOX) throw forbidden('This Whombat’s own screen can’t be removed.');
    const gone = await tx
      .delete(screens)
      .where(and(eq(screens.burrowId, ctx.burrow.id), eq(screens.id, input.id)))
      .returning({ id: screens.id, name: screens.name });
    if (gone.length === 0) throw unknownScreen();
    await ctx.emit({
      type: 'desk.screen_removed',
      kind: 'System',
      text: null,
      where: null,
      payload: { screen: input.id },
    });
    return { ok: true as const };
  },
});

const ReportedOutput = z.object({
  id: DeskScreenId,
  main: z.boolean(),
  name: z.string().max(60).nullable(),
  width: z.number().int().min(200).max(16_384),
  height: z.number().int().min(200).max(16_384),
});

/**
 * What the box's page reported (DK-129, DK-147): the main output's size is the box's own screen's (its row written
 * now if it had none, still unarranged); every other output is a monitor's screen, made the first time it's seen
 * (unarranged, *Problems only*, the monitor's name), its size and name kept. By Whombat itself, without an event.
 */
export const reportOutputs = defineCommand({
  name: 'report_screen_outputs',
  schema: z.object({ outputs: z.array(ReportedOutput).min(1).max(8) }),
  async apply(tx, ctx, input) {
    await checkWriter(tx, ctx.actor, true);
    const rows = await tx.select().from(screens).where(eq(screens.burrowId, ctx.burrow.id));
    const have = new Map(rows.map((r) => [r.id, r]));
    let others = rows.filter((r) => r.id !== DESK_SCREEN_BOX).length;
    const made: string[] = [];
    for (const o of input.outputs) {
      const kind = screenKind(o.id);
      const named = o.name?.trim() ? o.name.trim().slice(0, 40) : null;
      const row = have.get(o.id);
      if (row) {
        await tx
          .update(screens)
          .set({
            width: o.width,
            height: o.height,
            lastSeenAt: ctx.now,
            ...(kind === 'output' && named ? { device: named } : {}),
          })
          .where(and(eq(screens.burrowId, ctx.burrow.id), eq(screens.id, o.id)));
        continue;
      }
      // A monitor beyond the limit isn't kept: it shows the box's default until one is removed.
      if (kind === 'output' && others >= DESK_SCREENS_MAX) continue;
      if (kind === 'device') continue;
      await tx.insert(screens).values({
        id: o.id,
        burrowId: ctx.burrow.id,
        kind,
        name: kind === 'box' ? DESK_SCREEN_WORDS.box : (named ?? DESK_SCREEN_WORDS.output),
        popups: kind === 'box' ? 'all' : 'problems',
        layout: NOT_ARRANGED,
        device: kind === 'output' ? named : null,
        width: o.width,
        height: o.height,
        lastSeenAt: ctx.now,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      });
      if (kind === 'output') others++;
      made.push(o.id);
    }
    return { made };
  },
});

/** A device's screen said its size (`ScreensApi.seen`): kept with when. By Whombat itself, without an event. */
export const seeScreen = defineCommand({
  name: 'see_screen',
  schema: z.object({
    id: DeskScreenId,
    width: z.number().int().min(200).max(16_384),
    height: z.number().int().min(200).max(16_384),
  }),
  async apply(tx, ctx, input) {
    await checkWriter(tx, ctx.actor, true);
    await tx
      .update(screens)
      .set({ width: input.width, height: input.height, lastSeenAt: ctx.now })
      .where(and(eq(screens.burrowId, ctx.burrow.id), eq(screens.id, input.id)));
    return { ok: true as const };
  },
});

export const SCREEN_COMMANDS = [updateScreen, forgetScreen, reportOutputs, seeScreen];

/**
 * A device becomes a screen (DK-146), inside its enrolment's commit: its row with its endpoint, who added it, its
 * name, pop-ups and a layout — the box's own as it is (each shape rearranges it, DK-132) or one empty page.
 * `screens_full` beyond `DESK_SCREENS_MAX` besides the box's own.
 */
export async function addDeviceScreen(
  tx: Tx,
  input: {
    burrowId: string;
    personId: string;
    endpointId: string;
    name: string;
    popups: 'all' | 'problems' | 'none';
    start: 'copy' | 'empty';
    device: string | null;
  },
  now: Date,
  random?: (n: number) => Uint8Array,
): Promise<ScreenRecord> {
  if ((await othersCount(tx, input.burrowId)) >= DESK_SCREENS_MAX) throw screensFull();
  const layout =
    input.start === 'copy'
      ? ((await loadScreen(tx, input.burrowId, DESK_SCREEN_BOX))?.layout ?? deskDefaultLayout())
      : {
          pages: [deskEmptyPage('p_first', DESK_SCREEN_WORDS.firstPage, DESK_DEFAULT_SHAPE)],
          turn: 'touch' as const,
          size: 'normal' as const,
        };
  const [row] = await tx
    .insert(screens)
    .values({
      id: newDeviceScreenId(random),
      burrowId: input.burrowId,
      kind: 'device',
      name: input.name.trim() || DESK_SCREEN_WORDS.device,
      popups: input.popups,
      layout,
      show: {},
      endpointId: input.endpointId,
      personId: input.personId,
      device: input.device ? input.device.slice(0, 80) : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error('screens: the device’s screen wasn’t written');
  return recordOf(row);
}

/**
 * *Remove* on a device's screen (DK-146): it ends at once. Its key is revoked and its row deleted in one commit
 * (`managed/display.ts`), its open sessions close and control hears; `by` the person who removed it, with the device
 * they did it on for the signed event. A row whose key isn't a screen's (none should be) is only forgotten, as a
 * monitor's is: Screens never revokes one of the person's own devices. True when it was removed now.
 */
export async function revokeScreenDevice(
  services: Services,
  record: ScreenRecord,
  by?: { id: string; burrowId: string; endpointId?: string | null },
): Promise<boolean> {
  if (record.endpointId && (await revokeScreenKey(services, record.endpointId, by?.endpointId ?? null)))
    return true;
  if (!(await loadScreen(services.db, record.burrowId, record.id))) return false;
  const actor = by?.burrowId === record.burrowId ? by.id : await systemActor(services, record.burrowId);
  await services.pipeline.commit(
    forgetScreen,
    { id: record.id },
    { burrowId: record.burrowId, actorId: actor },
  );
  return true;
}

/** The burrow's Whombat signer, for what the box does by itself. */
function systemActor(services: Services, burrowId: string): Promise<string> {
  return serversPrincipal(services, burrowId);
}

/* The store -------------------------------------------------------------------------------------------------------- */

/**
 * The screens as the runtime keeps them (`ScreensApi`'s store part): reads, a device added in its enrolment's commit,
 * and sizes said — written at most once a minute per screen unless the size changed.
 */
export class ScreenStore {
  /** When each screen's size was last written, and which. */
  readonly #seen = new Map<string, { at: number; width: number; height: number }>();

  constructor(private readonly services: Services) {}

  list(burrowId: string): Promise<ScreenRecord[]> {
    return loadScreens(this.services.db, burrowId);
  }

  get(burrowId: string, id: string): Promise<ScreenRecord | null> {
    return loadScreen(this.services.db, burrowId, id);
  }

  byEndpoint(endpointId: string): Promise<ScreenRecord | null> {
    return loadScreenByEndpoint(this.services.db, endpointId);
  }

  addDevice(tx: unknown, input: Parameters<typeof addDeviceScreen>[1]): Promise<ScreenRecord> {
    return addDeviceScreen(tx as Tx, input, this.services.clock());
  }

  /** A device's screen said its size: kept at most once a minute unless it changed. */
  async seen(id: string, size: DeskScreenSize, at: Date): Promise<void> {
    const last = this.#seen.get(id);
    const same = last && last.width === size.width && last.height === size.height;
    if (same && at.getTime() - last.at < SCREEN_SEEN_EVERY_MS) return;
    const [row] = await this.services.db
      .select({ burrowId: screens.burrowId })
      .from(screens)
      .where(eq(screens.id, id));
    if (!row) return;
    if (this.#seen.size >= 64) this.#seen.clear();
    this.#seen.set(id, { at: at.getTime(), ...size });
    await this.services.pipeline.commit(
      seeScreen,
      { id, ...size },
      { burrowId: row.burrowId, actorId: await systemActor(this.services, row.burrowId), now: at },
    );
  }

  /** The box's page reported its outputs: the box's own size, each monitor's screen made or seen (DK-147). */
  async reportOutputs(
    burrowId: string,
    outputs: readonly { id: string; main: boolean; name: string | null; size: DeskScreenSize }[],
  ): Promise<string[]> {
    const res = await this.services.pipeline.commit(
      reportOutputs,
      {
        outputs: outputs.map((o) => ({
          id: o.id,
          main: o.main,
          name: o.name,
          width: o.size.width,
          height: o.size.height,
        })),
      },
      { burrowId, actorId: await systemActor(this.services, burrowId) },
    );
    return res.status === 'ok' ? (res.result as { made: string[] }).made : [];
  }
}

/** Whether a screen is showing now (DK-128's list): the box's own while it's on, others when seen lately. */
export function screenOnline(record: ScreenRecord, now: number, boxOn: boolean): boolean {
  if (record.kind === 'box') return boxOn;
  return record.lastSeenAt !== null && now - record.lastSeenAt.getTime() < SCREEN_ONLINE_MS;
}
