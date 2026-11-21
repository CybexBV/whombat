/**
 * The paired screen in the database (`desk_screens` and `desk_display`, migrations 0122…0126 and 0010;
 * docs/decisions/desk-display-server.md DK-S02, DK-S28, DK-S34, DK-S50, DK-S73, DK-S120, DK-S121): read here, written
 * only through the commit pipeline by the commands below. Pairing, pairing itself, the switch and a new PIN are signed events in the
 * burrow's log; a setting changed is signed without words; a wrong or right PIN only moves the counters, and an unlock
 * that stays only keeps its boot (no event: the screen isn't anyone, and the fifth wrong one is told to the person in
 * Chat).
 */
import {
  applyDeskSettingsPatch,
  DEFAULT_DESK_SETTINGS,
  DEFAULT_DESK_SHOW,
  DESK_WORDS,
  DeskPinDigits,
  type DeskSettings,
  DeskSettingsPatch,
  DeskShow,
  DeskWhombatName,
  fillDeskWords,
} from '@whombat/core';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand } from '../commit/types';
import type { Db, Tx } from '../db/client';
import {
  accounts,
  burrows,
  type DeskPairedVia,
  deskDisplay,
  deskScreens,
  principals,
} from '../db/schema/index';
import { SYSTEM_SERVERS } from '../hosts/principal';
import { conflict, forbidden, notFound } from '../lib/errors';
import { pinBackoffMs } from './pin';

export type DeskRow = typeof deskScreens.$inferSelect;

/** The only row's id: one screen per box. */
export const DESK_ID = 1;

export async function loadDeskRow(db: Db | Tx): Promise<DeskRow | null> {
  const [row] = await db.select().from(deskScreens).where(eq(deskScreens.id, DESK_ID));
  return row ?? null;
}

/** What the person chose for *Show Whombat on this screen* (DK-20): on, off, or null while nobody chose. */
export async function loadScreenChoice(db: Db | Tx): Promise<boolean | null> {
  const [row] = await db
    .select({ on: deskDisplay.screenOn })
    .from(deskDisplay)
    .where(eq(deskDisplay.id, DESK_ID));
  return row?.on ?? null;
}

/** The Whombat's name for the top bar (DK-119) as the app last gave it, or null (never given, or not one any more). */
export async function loadWhombatName(db: Db | Tx): Promise<string | null> {
  const [row] = await db
    .select({ name: deskDisplay.whombatName })
    .from(deskDisplay)
    .where(eq(deskDisplay.id, DESK_ID));
  const name = DeskWhombatName.safeParse(row?.name);
  return name.success ? name.data : null;
}

/**
 * The Whombat's own name as the box knows it: the one the person's app last gave (control's), else the name it was
 * given at its first start (its burrow's, which onboarding sets); null before either. What the box tells control and
 * writes next to its backups, so a bring back can say “Home” rather than a device id.
 */
export async function loadOwnName(db: Db | Tx): Promise<string | null> {
  const given = await loadWhombatName(db);
  if (given?.trim()) return given.trim();
  const [burrow] = await db
    .select({ name: burrows.name })
    .from(burrows)
    .orderBy(asc(burrows.createdAt), asc(burrows.id))
    .limit(1);
  return burrow?.name?.trim() || null;
}

async function chooseScreen(tx: Tx, on: boolean, now: Date): Promise<void> {
  await tx
    .insert(deskDisplay)
    .values({ id: DESK_ID, screenOn: on, updatedAt: now })
    .onConflictDoUpdate({ target: deskDisplay.id, set: { screenOn: on, updatedAt: now } });
}

/**
 * What the screen shows as kept (`desk_screens.show`): each part read on its own, so a part an older or newer runtime
 * wrote that this one can't read is its default and the others stay the person's.
 */
export function showOf(stored: unknown): DeskShow {
  const whole = DeskShow.safeParse(stored ?? {});
  if (whole.success) return whole.data;
  const parts = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(DeskShow.shape)) {
    const part = schema.safeParse(parts[key]);
    // Every part has a default.
    out[key] = part.success ? part.data : schema.parse(undefined);
  }
  return DeskShow.safeParse(out).data ?? DEFAULT_DESK_SHOW;
}

export function settingsOf(row: DeskRow | null): DeskSettings {
  if (!row) return DEFAULT_DESK_SETTINGS;
  return {
    ...DEFAULT_DESK_SETTINGS,
    lockedView: row.lockedView,
    quietHours: { enabled: row.quietEnabled, start: row.quietStart, end: row.quietEnd },
    night: row.night,
    voice: row.voice,
    presence: row.presence,
    speechVoice: row.speechVoice,
    stayUnlocked: row.stayUnlocked,
    cameraWake: row.cameraWake,
    show: showOf(row.show),
  };
}

/** Whether the account is there (the person's, one-person.md OP-S06). */
async function hasAccount(db: Db | Tx, accountId: string | null): Promise<boolean> {
  if (!accountId) return false;
  const [row] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId));
  return !!row;
}

async function accountOf(tx: Tx, principalId: string): Promise<string | null> {
  const [row] = await tx
    .select({ accountId: principals.accountId })
    .from(principals)
    .where(eq(principals.id, principalId));
  return row?.accountId ?? null;
}

/** A machine's boot id as the kernel gives it (a UUID; DK-75), the shape `unlocked_boot` keeps. */
export const DeskBootId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

const PinHash = z.string().regex(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);

/** A PIN as it is kept: its hash and its length (DK-26), never the digits. */
const NewPin = z.object({ pinHash: PinHash, pinDigits: DeskPinDigits });
type NewPin = z.infer<typeof NewPin>;

/** A new pairing's row: the person, how it was paired, their PIN (or none yet) and the default settings. */
function pairingRow(
  burrowId: string,
  personId: string,
  pairedVia: DeskPairedVia,
  pin: NewPin | null,
  now: Date,
): typeof deskScreens.$inferInsert {
  return {
    id: DESK_ID,
    burrowId,
    personId,
    pinHash: pin?.pinHash ?? null,
    pinDigits: pin?.pinDigits ?? null,
    pairedVia,
    lockedView: DEFAULT_DESK_SETTINGS.lockedView,
    quietEnabled: DEFAULT_DESK_SETTINGS.quietHours.enabled,
    quietStart: DEFAULT_DESK_SETTINGS.quietHours.start,
    quietEnd: DEFAULT_DESK_SETTINGS.quietHours.end,
    night: DEFAULT_DESK_SETTINGS.night,
    voice: DEFAULT_DESK_SETTINGS.voice,
    presence: DEFAULT_DESK_SETTINGS.presence,
    speechVoice: DEFAULT_DESK_SETTINGS.speechVoice,
    // Lock again and the camera start off (DK-74, DK-72), and no unlock of an earlier pairing stays (DK-75).
    stayUnlocked: DEFAULT_DESK_SETTINGS.stayUnlocked,
    cameraWake: DEFAULT_DESK_SETTINGS.cameraWake,
    unlockedBoot: null,
    // A new pairing starts with what shows by default (DK-105).
    show: {},
    pairedAt: now,
    wrongPins: 0,
    retryAt: null,
    updatedAt: now,
  };
}

/**
 * The person pairs the screen to themselves with its letters and a PIN (DK-02): a pairing before is replaced, and the
 * screen counts as turned on (the person chose it, DK-S28).
 */
export const pairDesk = defineCommand({
  name: 'pair_desk',
  schema: NewPin,
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can pair the screen.');
    if (!(await hasAccount(tx, await accountOf(tx, ctx.actor.id))))
      throw forbidden('Only you can pair the screen.');
    const before = await loadDeskRow(tx);
    const values = pairingRow(ctx.burrow.id, ctx.actor.id, 'letters', input, ctx.now);
    await tx.insert(deskScreens).values(values).onConflictDoUpdate({ target: deskScreens.id, set: values });
    await chooseScreen(tx, true, ctx.now);
    await ctx.emit({
      type: 'desk.paired',
      kind: 'System',
      text: 'Paired the screen of this Whombat',
      where: null,
      payload: { personId: ctx.actor.id, ...(before ? { replacedPersonId: before.personId } : {}) },
    });
    return { previousPersonId: before?.personId ?? null };
  },
});

/** The paired person's own row, or why not. */
async function ownRow(tx: Tx, actorId: string): Promise<DeskRow> {
  const row = await loadDeskRow(tx);
  if (!row) throw notFound('Paired screen');
  if (row.personId !== actorId) throw forbidden('Only the person the screen is paired with can change this.');
  return row;
}

/**
 * The paired person picks a new PIN, or the first one (DK-04, DK-18), its length with it (DK-26); the wrong ones
 * counted so far are forgotten.
 */
export const setDeskPin = defineCommand({
  name: 'set_desk_pin',
  schema: NewPin,
  async apply(tx, ctx, input) {
    const row = await ownRow(tx, ctx.actor.id);
    await tx
      .update(deskScreens)
      .set({
        pinHash: input.pinHash,
        pinDigits: input.pinDigits,
        wrongPins: 0,
        retryAt: null,
        updatedAt: ctx.now,
      })
      .where(eq(deskScreens.id, DESK_ID));
    await ctx.emit({
      type: 'desk.pin_changed',
      kind: 'System',
      text:
        row.pinHash === null
          ? 'Chose a PIN for this Whombat’s screen'
          : 'Changed the PIN of this Whombat’s screen',
      where: null,
      payload: {},
    });
    return { ok: true as const };
  },
});

/**
 * The paired person's settings (DK-03, DK-06, DK-09, DK-28, DK-50, DK-72, DK-74), and what the screen shows (DK-102):
 * `show` changes only the parts it names (`applyDeskSettingsPatch`). A voice is one the service listed:
 * the service checks that before (DK-52, DK-S51), as it is the box's, not the database's. *When you press Lock* turned
 * off forgets the boot of an unlock that stayed in the same transaction (DK-75).
 */
export const updateDesk = defineCommand({
  name: 'update_desk',
  schema: DeskSettingsPatch,
  async apply(tx, ctx, input) {
    const row = await ownRow(tx, ctx.actor.id);
    const next = applyDeskSettingsPatch(settingsOf(row), input);
    await tx
      .update(deskScreens)
      .set({
        lockedView: next.lockedView,
        quietEnabled: next.quietHours.enabled,
        quietStart: next.quietHours.start,
        quietEnd: next.quietHours.end,
        night: next.night,
        voice: next.voice,
        presence: next.presence,
        speechVoice: next.speechVoice,
        stayUnlocked: next.stayUnlocked,
        cameraWake: next.cameraWake,
        show: next.show,
        ...(next.stayUnlocked ? {} : { unlockedBoot: null }),
        updatedAt: ctx.now,
      })
      .where(eq(deskScreens.id, DESK_ID));
    await ctx.emit({
      type: 'desk.updated',
      kind: 'System',
      text: null,
      where: null,
      payload: { settings: next },
    });
    return next;
  },
});

/**
 * *Show Whombat on this screen* (DK-20), the person's: off ends the pairing (its PIN and settings with it) and keeps the
 * screen off, nothing pairs itself while it is; on pairs the screen to the person, without letters or a PIN (DK-18),
 * when nobody is paired — a pairing there is kept (*Pair to me instead* is the letters'). Whether a screen is connected
 * the service checks before. `desk.unpair` is off.
 */
export const setDeskScreen = defineCommand({
  name: 'set_desk_screen',
  schema: z.object({ on: z.boolean() }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can turn the screen on or off.');
    if (!(await hasAccount(tx, await accountOf(tx, ctx.actor.id))))
      throw forbidden('Only you can turn the screen on or off.');
    const before = await loadDeskRow(tx);
    await chooseScreen(tx, input.on, ctx.now);
    let personId = before?.personId ?? null;
    if (!input.on && before) {
      await tx.delete(deskScreens).where(eq(deskScreens.id, DESK_ID));
      personId = null;
    }
    if (input.on && !before) {
      await tx.insert(deskScreens).values(pairingRow(ctx.burrow.id, ctx.actor.id, 'switch', null, ctx.now));
      personId = ctx.actor.id;
    }
    await ctx.emit({
      type: 'desk.screen_set',
      kind: 'System',
      text: input.on ? 'Turned on this Whombat’s screen' : 'Turned off this Whombat’s screen',
      where: null,
      payload: {
        on: input.on,
        personId,
        ...(before && before.personId !== personId ? { unpairedPersonId: before.personId } : {}),
      },
    });
    return { personId, previousPersonId: before?.personId ?? null };
  },
});

/**
 * The screen pairs itself (DK-17), to the person: no letters, no PIN (DK-18). Signed by the burrow's Whombat
 * signer, not the person (they didn't do it); its words in the log say the screen did (DK-S29). Nothing when someone
 * is paired by now or the person turned the screen off meanwhile (`paired` false).
 */
export const pairDeskItself = defineCommand({
  name: 'pair_desk_itself',
  schema: z.object({ personId: z.string().min(1) }),
  async apply(tx, ctx, input) {
    const [signer] = await tx
      .select({ system: principals.system })
      .from(principals)
      .where(eq(principals.id, ctx.actor.id));
    if (signer?.system !== SYSTEM_SERVERS) throw forbidden('Only Whombat pairs the screen by itself.');
    const [person] = await tx
      .select({ name: principals.name, accountId: principals.accountId })
      .from(principals)
      .where(
        and(
          eq(principals.id, input.personId),
          eq(principals.burrowId, ctx.burrow.id),
          eq(principals.kind, 'person'),
          isNull(principals.system),
        ),
      );
    if (!person) throw notFound('Person');
    if (!(await hasAccount(tx, person.accountId)))
      throw conflict('The screen pairs itself only with the person.');
    if ((await loadDeskRow(tx)) || (await loadScreenChoice(tx)) === false) return { paired: false };
    await tx.insert(deskScreens).values(pairingRow(ctx.burrow.id, input.personId, 'itself', null, ctx.now));
    await ctx.emit({
      type: 'desk.paired',
      kind: 'System',
      text: fillDeskWords(DESK_WORDS.settings.pairedItself, { name: person.name }),
      where: null,
      payload: { personId: input.personId, via: 'itself' },
    });
    return { paired: true };
  },
});

/**
 * The Whombat's name for the screen's top bar (DK-119, DK-S121), from the person's app, which knows it from control's
 * directory: kept with the box (`desk_display`), paired or not, so it outlives an unpairing. Signed without words, as a
 * setting is; nothing changes when it is the same.
 */
export const setDeskName = defineCommand({
  name: 'set_desk_name',
  schema: z.object({ name: DeskWhombatName.refine((name) => name.trim().length > 0) }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only you can name the screen’s Whombat.');
    if (!(await hasAccount(tx, await accountOf(tx, ctx.actor.id))))
      throw forbidden('Only you can name the screen’s Whombat.');
    const name = input.name.trim();
    if ((await loadWhombatName(tx)) === name) return { name, changed: false };
    await tx
      .insert(deskDisplay)
      .values({ id: DESK_ID, screenOn: null, whombatName: name, updatedAt: ctx.now })
      .onConflictDoUpdate({ target: deskDisplay.id, set: { whombatName: name, updatedAt: ctx.now } });
    await ctx.emit({ type: 'desk.named', kind: 'System', text: null, where: null, payload: { name } });
    return { name, changed: true };
  },
});

/**
 * A wrong PIN on the screen (DK-04): counted, and from the fifth on the screen waits (`pinBackoffMs`). In the paired
 * person's burrow, as them, without an event.
 */
export const deskWrongPin = defineCommand({
  name: 'desk_wrong_pin',
  schema: z.object({}),
  async apply(tx, ctx) {
    const row = await ownRow(tx, ctx.actor.id);
    const wrongPins = row.wrongPins + 1;
    const wait = pinBackoffMs(wrongPins);
    const retryAt = wait > 0 ? new Date(ctx.now.getTime() + wait) : null;
    await tx.update(deskScreens).set({ wrongPins, retryAt }).where(eq(deskScreens.id, DESK_ID));
    return { wrongPins, retryAt };
  },
});

/** The right PIN after wrong ones: the count starts again. */
export const deskRightPin = defineCommand({
  name: 'desk_right_pin',
  schema: z.object({}),
  async apply(tx, ctx) {
    await ownRow(tx, ctx.actor.id);
    await tx.update(deskScreens).set({ wrongPins: 0, retryAt: null }).where(eq(deskScreens.id, DESK_ID));
    return { ok: true as const };
  },
});

/**
 * The boot an unlock that stays was made on, or null once it is locked (DK-75, DK-S73): in the paired person's burrow,
 * as them, without an event, so a runtime that starts again on the same boot is unlocked again. Kept only while the
 * choice is *When you press Lock*: a boot that arrives after the choice went off is written as null.
 */
export const deskUnlockedBoot = defineCommand({
  name: 'desk_unlocked_boot',
  schema: z.object({ boot: DeskBootId.nullable() }),
  async apply(tx, ctx, input) {
    const row = await ownRow(tx, ctx.actor.id);
    const boot = row.stayUnlocked ? input.boot : null;
    await tx.update(deskScreens).set({ unlockedBoot: boot }).where(eq(deskScreens.id, DESK_ID));
    return { boot };
  },
});

export const DESK_COMMANDS = [
  pairDesk,
  pairDeskItself,
  setDeskScreen,
  setDeskPin,
  updateDesk,
  setDeskName,
  deskWrongPin,
  deskRightPin,
  deskUnlockedBoot,
];
