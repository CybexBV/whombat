/**
 * The box's own screen paired to one person (docs/decisions/desk-display.md DK-02…DK-09, DK-16…DK-21;
 * desk-display-server.md DK-S01…), migrations 0122…0126 and 0010. At most one row each (`id` = 1): no `desk_screens` row means
 * nobody paired the screen, no `desk_display` row that the person hasn't chosen whether it shows Whombat. Written
 * only through the commit pipeline (`desk/store.ts`). The pairing letters and whether the screen is unlocked live in
 * memory; only the boot an unlock that stays was made on is kept (DK-75), so an update on the same boot keeps it.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, pgTable, smallint, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './common';
import { applianceEndpoints } from './managed';
import { principals } from './principals';
import { burrows } from './tenancy';

/** How the screen came to be paired: the letters and a PIN (DK-02), by itself (DK-17), or the switch (DK-20). */
export type DeskPairedVia = 'letters' | 'itself' | 'switch';

export const deskScreens = pgTable(
  'desk_screens',
  {
    /** Always 1: one screen per box. */
    id: integer('id').primaryKey(),
    /** The paired person's burrow: what the screen shows. */
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    /** `scrypt$N$r$p$salt$hash` (base64url), the PIN of 4 to 6 digits (DK-S04, DK-26); null until one is chosen (DK-18). */
    pinHash: text('pin_hash'),
    /** The PIN's length, 4 to 6, written with its hash (DK-26); null: six digits (a PIN from before 0124), or no PIN. */
    pinDigits: smallint('pin_digits'),
    pairedVia: text('paired_via').$type<DeskPairedVia>().notNull().default('letters'),
    lockedView: text('locked_view').$type<'time' | 'summary' | 'everything'>().notNull().default('summary'),
    quietEnabled: boolean('quiet_enabled').notNull().default(true),
    quietStart: text('quiet_start').notNull().default('23:00'),
    quietEnd: text('quiet_end').notNull().default('07:00'),
    night: text('night').$type<'dim' | 'black'>().notNull().default('dim'),
    voice: boolean('voice').notNull().default(true),
    /** *Stay unlocked while you’re here* (DK-28): the camera keeps an unlock while it sees a face. */
    presence: boolean('presence').notNull().default(false),
    /** The voice the screen answers with (DK-50), a `DeskVoiceName` the voice service listed; `heart` until chosen. */
    speechVoice: text('speech_voice').notNull().default('heart'),
    /** *Lock again: When you press Lock* (DK-74): an unlock lasts until Lock; wins over `presence` (DK-76). */
    stayUnlocked: boolean('stay_unlocked').notNull().default(false),
    /** *Use the camera to see when you’re here* (DK-72): the camera looks by day, locked or unlocked. */
    cameraWake: boolean('camera_wake').notNull().default(false),
    /** The boot id (`/proc/sys/kernel/random/boot_id`) an unlock that stays was made on (DK-75); null while none stays. */
    unlockedBoot: text('unlocked_boot'),
    /**
     * What the screen shows (`DeskShow` of core, desk-display.md DK-102): only what the person changed, read through
     * `DeskShow` so an older or unknown part reads as its default (migration 0010).
     */
    show: jsonb('show').notNull().default({}),
    pairedAt: ts('paired_at').notNull(),
    /** Wrong PINs since the last right one (DK-04). */
    wrongPins: integer('wrong_pins').notNull().default(0),
    /** After five wrong PINs: when the screen takes the next one. */
    retryAt: ts('retry_at'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    check('desk_screens_one', sql`${t.id} = 1`),
    check('desk_screens_locked_view', sql`${t.lockedView} IN ('time', 'summary', 'everything')`),
    check('desk_screens_night', sql`${t.night} IN ('dim', 'black')`),
    check(
      'desk_screens_quiet',
      sql`${t.quietStart} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND ${t.quietEnd} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
    ),
    check('desk_screens_paired_via', sql`${t.pairedVia} IN ('letters', 'itself', 'switch')`),
    check('desk_screens_pin_digits', sql`${t.pinDigits} BETWEEN 4 AND 6`),
    check('desk_screens_speech_voice', sql`${t.speechVoice} ~ '^[a-z][a-z0-9-]{0,31}$'`),
    check('desk_screens_unlocked_boot', sql`${t.unlockedBoot} ~ '^[A-Za-z0-9-]{1,64}$'`),
  ],
);

/** *Show Whombat on this screen* (DK-20): what the person chose; no row (or null) while nobody chose. */
export const deskDisplay = pgTable(
  'desk_display',
  {
    /** Always 1. */
    id: integer('id').primaryKey(),
    screenOn: boolean('screen_on'),
    /**
     * The Whombat's name for the screen's top bar (DK-119), as the app last gave it (`desk.setName`); the box's, so it
     * outlives an unpairing (migration 0010). Null until given: the org's name.
     */
    whombatName: text('whombat_name'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [check('desk_display_one', sql`${t.id} = 1`)],
);

/**
 * The screens of widgets (docs/decisions/desk-display.md DK-126…DK-149; migration 0013): the box's own display (`box`,
 * written the first time someone changes it), each monitor on the box (`out_<output>`, while seen and after) and each
 * tablet or computer that became a screen (`scr_…`, with its endpoint), each with its layout and choices. Written only
 * through the commit pipeline (`desk/screens.ts`). The box's own *What’s going on* and *Servers* choices stay in
 * `desk_screens.show`; other screens keep theirs here.
 */
export const screens = pgTable(
  'screens',
  {
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'box' | 'output' | 'device'>().notNull(),
    name: text('name').notNull(),
    popups: text('popups').$type<'all' | 'problems' | 'none'>().notNull(),
    /** When the doorbell rings (desk-display.md): `big` shows it big for a minute, `off` doesn't. */
    doorbell: text('doorbell').$type<'big' | 'off'>().notNull().default('big'),
    /** `DeskLayout` (core), read through it: a bad or older value reads as the default layout. */
    layout: jsonb('layout').notNull(),
    /** `DeskShow` (core), only what the person changed; unused for the box's own (`desk_screens.show`). */
    show: jsonb('show').notNull().default({}),
    /** A device's endpoint: removing the screen revokes it; a revoked endpoint takes its screen with it. */
    endpointId: text('endpoint_id').references(() => applianceEndpoints.id, { onDelete: 'cascade' }),
    /** Who added it. */
    personId: text('person_id').references(() => principals.id, { onDelete: 'set null' }),
    /** What it is (“iPad · Safari”, the monitor's name). */
    device: text('device'),
    /** Its size in logical pixels as it last said. */
    width: integer('width'),
    height: integer('height'),
    lastSeenAt: ts('last_seen_at'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('screens_endpoint_idx').on(t.endpointId),
    check('screens_kind', sql`${t.kind} IN ('box', 'output', 'device')`),
    check('screens_popups', sql`${t.popups} IN ('all', 'problems', 'none')`),
    check('screens_doorbell', sql`${t.doorbell} IN ('big', 'off')`),
    check('screens_id', sql`${t.id} ~ '^(box|out_[a-z0-9-]{1,40}|scr_[A-Za-z0-9_-]{8,40})$'`),
    check('screens_size', sql`(${t.width} IS NULL) = (${t.height} IS NULL)`),
  ],
);
