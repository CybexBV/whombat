/**
 * What changed before it broke (Whombat outside-changes.md): Whombat compares what it already reads of a thing on every
 * pass (a service's version, a server's kernel, boot and waiting updates, a container's image, devices' firmware, proxy
 * hosts and tunnel routes) and keeps what changed, 90 days, in the thing's History beside its outages. Each change says
 * when Whombat saw it, what changed in plain words and whether Whombat did it itself. Changes never alert.
 *
 * Settings copies: for a few services whose settings are precious (OPNsense, Pi-hole, Nginx Proxy Manager) Whombat keeps
 * a copy of their settings every night on the box, sealed like its other secrets, and offers the newest for download on
 * the service's page. Consecutive copies are compared into a change of the kind `settings`.
 */
import { z } from 'zod';
import { Timestamp } from './common.js';

/** How long changes are kept. */
export const CHANGES_KEEP_DAYS = 90;

/**
 * What changed: a service's own version, a container's image, the server's system (its operating system or waiting
 * updates installed), a restart (with a new kernel when there was one), a device's firmware, a proxy host or tunnel
 * route, and settings from a settings copy.
 */
export const THING_CHANGE_KINDS = [
  'version',
  'image',
  'system',
  'restart',
  'firmware',
  'route',
  'settings',
] as const;
export const ThingChangeKind = z.enum(THING_CHANGE_KINDS);
export type ThingChangeKind = z.infer<typeof ThingChangeKind>;

/** `whombat`: it matches something Whombat did there itself shortly before; `outside`: made outside Whombat. */
export const ThingChangeBy = z.enum(['whombat', 'outside']);
export type ThingChangeBy = z.infer<typeof ThingChangeBy>;

/** One change as the apps list it in a thing's History. */
export const ThingChange = z.object({
  /** `och_…`. */
  id: z.string().min(1).max(80),
  kind: ThingChangeKind,
  /** What changed, in Whombat's words in the reader's language: “Immich went from 2.3.0 to 2.4.0”. */
  words: z.string().min(1).max(300),
  /** When Whombat saw it. */
  at: Timestamp,
  /** The read before it, when the change happened at the earliest; absent when not known. */
  since: Timestamp.optional(),
  by: ThingChangeBy,
});
export type ThingChange = z.infer<typeof ThingChange>;

/** How many settings copies are kept of one connection: the newest, and the different ones before it. */
export const SETTINGS_COPIES_KEPT = 10;

/**
 * A service's settings copy on its page: when the newest copy was made or last found unchanged, whether it can be
 * downloaded, and why the last try didn't work. Restoring one is the service's own (its backup import).
 */
export const SettingsCopyView = z.object({
  /** The service's name (“OPNsense”). */
  service: z.string().min(1).max(80),
  /** “Settings copy · last night”, “Settings copy · Tue 25 Nov”, “No settings copy yet”. */
  title: z.string().min(1).max(120),
  /** One plain line under it: what the copy holds, or why the last try didn't work and what to do. */
  detail: z.string().max(300).optional(),
  /** The newest copy's id, for Download; absent: there is none yet. */
  copyId: z.string().min(1).max(80).optional(),
  /** Its file name and size, for the download. */
  fileName: z.string().min(1).max(120).optional(),
  size: z.number().int().min(0).optional(),
  /** When the newest copy was made or last found unchanged. */
  at: Timestamp.optional(),
  /** How many copies are kept. */
  kept: z.number().int().min(0).max(SETTINGS_COPIES_KEPT),
  /** The last try didn't work: its words are in `detail`. */
  failing: z.boolean(),
});
export type SettingsCopyView = z.infer<typeof SettingsCopyView>;

/** `things.settingsCopy`'s query: one copy by its id; absent: the newest. */
export const SettingsCopyQuery = z.object({ copy: z.string().min(1).max(80).optional() });
export type SettingsCopyQuery = z.infer<typeof SettingsCopyQuery>;

/** A settings copy's bytes for Download, as base64 (read through an export stream: it is larger than a message). */
export const SettingsCopyFile = z.object({
  fileName: z.string().min(1).max(120),
  contentType: z.string().min(1).max(120),
  size: z.number().int().min(0),
  /** When it was made. */
  madeAt: Timestamp,
  base64: z.string(),
});
export type SettingsCopyFile = z.infer<typeof SettingsCopyFile>;
