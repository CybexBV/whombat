/**
 * What changed before it broke (docs/decisions/outside-changes.md), migration 0044: the changes Whombat saw on a thing
 * between two reads (kept 90 days), what it read last of each thing to compare the next read with, and the settings
 * copies it keeps of a few services, sealed with the master key, with how their last tries went.
 */
import type { ThingChangeBy, ThingChangeKind } from '@whombat/core';
import { index, integer, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { bytea, ts } from './common';
import { catalogConnections } from './connections-catalog';
import { burrows } from './tenancy';

/**
 * What a change was, kept as facts so its words are said in the reader's language when it is read
 * (`changes/words.ts`): never words of the service's own beyond names and versions.
 */
export type ChangeFact =
  /** A service's own version (“Immich went from 2.3.0 to 2.4.0”). */
  | { k: 'version'; name: string; from: string; to: string }
  /** One container's image: a new tag, or the same tag with a new image. */
  | { k: 'image'; name: string; from: string; to: string }
  /** Several containers' images in one pass (their names, at most a few). */
  | { k: 'images'; names: string[]; count: number }
  /** The server restarted, with its new kernel when it changed. */
  | { k: 'restart'; kernel: string | null }
  /** The kernel changed without a restart Whombat saw. */
  | { k: 'kernel'; to: string }
  /** The operating system's own version (“Proxmox VE 9.0.10” to “9.0.11”). */
  | { k: 'os'; from: string; to: string }
  /** Waiting updates went without a package task of Whombat's: they were installed. */
  | { k: 'packages'; count: number }
  /** A device's firmware. */
  | { k: 'firmware'; device: string; from: string; to: string }
  /** Several devices' firmware in one pass. */
  | { k: 'firmwares'; devices: string[]; count: number; to: string | null }
  /**
   * A proxy host or tunnel route added (`from` null), removed (`to` null) or pointed elsewhere. `via`: Nginx Proxy
   * Manager's proxy hosts or a Cloudflare tunnel.
   */
  | { k: 'route'; via: 'proxy' | 'tunnel'; host: string; from: string | null; to: string | null }
  /** Several routes in one pass. */
  | { k: 'routes'; via: 'proxy' | 'tunnel'; added: number; removed: number; changed: number; hosts: string[] }
  /** A service's settings, compared between two settings copies: each part and how many of its items changed. */
  | { k: 'settings'; service: string; parts: SettingsPartChange[] };

/** One part of a service's settings in a `settings` change (“firewall rules”, 2 added). */
export interface SettingsPartChange {
  /** The part's key in `changes/words.ts` (`filter`, `dhcp`, `lists`, `other`). */
  part: string;
  added: number;
  removed: number;
  changed: number;
}

export const thingChanges = pgTable(
  'thing_changes',
  {
    /** `och_…`. */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    /** The thing's id (`server:pve-02`, `connection:con_…`). */
    thingId: text('thing_id').notNull(),
    kind: text('kind').$type<ThingChangeKind>().notNull(),
    /** The item it is about ('' the thing as a whole): a container, a device, a host name. Bursts merge by it. */
    subject: text('subject').notNull().default(''),
    fact: jsonb('fact').$type<ChangeFact>().notNull(),
    by: text('by').$type<ThingChangeBy>().notNull(),
    /** When Whombat saw it. */
    seenAt: ts('seen_at').notNull(),
    /** The read before, when it happened at the earliest. */
    since: ts('since'),
  },
  (t) => [
    index('thing_changes_thing_idx').on(t.burrowId, t.thingId, t.seenAt),
    index('thing_changes_burrow_idx').on(t.burrowId, t.seenAt),
  ],
);

export type ThingChangeRow = typeof thingChanges.$inferSelect;

/** What Whombat read last of a thing from one source (`service`, `server`, `containers`), to compare the next read. */
export const changeBaselines = pgTable(
  'change_baselines',
  {
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    thingId: text('thing_id').notNull(),
    source: text('source').notNull(),
    state: jsonb('state').$type<Record<string, unknown>>().notNull(),
    readAt: ts('read_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.burrowId, t.thingId, t.source] })],
);

/**
 * A copy of a service's settings, as the service exports it (OPNsense's `config.xml`, Pi-hole's Teleporter file, Nginx
 * Proxy Manager's hosts), sealed with the master key (`settings_copy:<id>`) so it rides in the box's own backups like
 * every secret. A new row only when the settings differ from the newest; `checked_at` moves when a night's copy was the
 * same. `summary` is the cleaned map the next copy is compared with: no secrets, no values worth hiding.
 */
export const settingsCopies = pgTable(
  'settings_copies',
  {
    /** `scp_…`. */
    id: text('id').primaryKey(),
    burrowId: text('burrow_id')
      .notNull()
      .references(() => burrows.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => catalogConnections.id, { onDelete: 'cascade' }),
    madeAt: ts('made_at').notNull(),
    checkedAt: ts('checked_at').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    sealed: bytea('sealed').notNull(),
    summary: jsonb('summary').$type<Record<string, string>>().notNull(),
  },
  (t) => [index('settings_copies_connection_idx').on(t.connectionId, t.madeAt)],
);

export type SettingsCopyRow = typeof settingsCopies.$inferSelect;

/** How a connection's settings copies went: the last try, the last that worked, and since when they fail. */
export const settingsCopyStates = pgTable('settings_copy_states', {
  connectionId: text('connection_id')
    .primaryKey()
    .references(() => catalogConnections.id, { onDelete: 'cascade' }),
  burrowId: text('burrow_id')
    .notNull()
    .references(() => burrows.id, { onDelete: 'cascade' }),
  triedAt: ts('tried_at'),
  okAt: ts('ok_at'),
  /** The first of the tries that failed in a row; null when the last try worked. */
  failedSince: ts('failed_since'),
  /** Why the last try didn't work, in plain words. */
  problem: text('problem'),
  failures: integer('failures').notNull().default(0),
});

export type SettingsCopyStateRow = typeof settingsCopyStates.$inferSelect;
