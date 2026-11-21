/**
 * AI clients (SUB-09, CT-72): the Claude Code and Codex CLIs the agent runs on, installed on demand at the latest
 * version Whombat has tested and updated automatically to newer tested versions: the box's manager installs the signed
 * client bundle (`@whombat/control-contracts/local`, `@whombat/release` client channel).
 */
import { z } from 'zod';
import { Timestamp } from './common.js';
import { LiveProvider } from './providers.js';

/** A client version as its publisher names it (`2.1.278`, `0.157.0`). */
export const ClientVersion = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/);

/**
 * - `not_installed`: nothing installed (`installed` is null).
 * - `installing`: the first install runs (`progress`).
 * - `installed`: `installed` runs; when `latest` is newer, the automatic update is waiting (no turn may be cut off).
 * - `updating`: a newer tested version is being installed next to `installed`, which keeps running until the switch.
 * - `failed`: the last install or update failed (`error`); `installed` is what still runs, if anything.
 */
export const ClientState = z.enum(['not_installed', 'installing', 'installed', 'updating', 'failed']);
export type ClientState = z.infer<typeof ClientState>;

/** One client as Settings and onboarding show it. */
export const ClientStatus = z.object({
  provider: LiveProvider,
  /** What runs now, installed and kept up to date by Whombat; null: nothing installed. */
  installed: z.object({ version: ClientVersion, installedAt: Timestamp }).nullable(),
  /** The latest version Whombat has tested for this machine (null: none known yet, or none for this platform). */
  latest: z.object({ version: ClientVersion, publishedAt: Timestamp }).nullable(),
  state: ClientState,
  /** `installing`/`updating`: percent done, when known. */
  progress: z.number().int().min(0).max(100).nullable(),
  /** `failed`: the `client.*` code and the explanation people see. */
  error: z.object({ code: z.string().max(64), message: z.string().max(500) }).nullable(),
});
export type ClientStatus = z.infer<typeof ClientStatus>;
