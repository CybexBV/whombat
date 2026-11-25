/**
 * Tracker drivers installed on this Whombat (docs/decisions/report-trackers.md): `$WHOMBAT_HOME/plugins/<id>/plugin.mjs`,
 * one ES module each, put there by the person who runs the box (never an agent, never the apps). The server imports
 * each at start, in its own process: a driver is owner-trusted code with the server's rights, not sandboxed. What it
 * says about itself is checked (`TrackerDriverInfo`, interface version 1, its folder named after its id); one that
 * doesn't load is left out and said in the log, and its connections say they can't be read.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TRACKER_DRIVER_API, type TrackerDriver, TrackerDriverInfo } from './driver';

/** The file a driver's folder holds. */
export const PLUGIN_FILE = 'plugin.mjs';

/** The calls every driver has (the optional ones are checked where they are used). */
const REQUIRED_CALLS = ['check', 'health', 'poll', 'item', 'diagnostics', 'write', 'send'] as const;
/** The calls a driver may leave out. */
const OPTIONAL_CALLS = ['grant', 'read', 'revoke', 'prLine', 'prMatch', 'erasures'] as const;

/**
 * How long a driver may take to load and start, together, before the server goes on without it. Only waiting is cut
 * off: the driver runs in the server's own process, so code that blocks synchronously (a busy loop at its import)
 * can't be stopped and holds the start; an import or a start that waits on something gives up in time.
 */
export const PLUGIN_LOAD_DEADLINE_MS = 15_000;

/** `work`, or a plain refusal once `ms` passed (the work itself can't be stopped; the server just stops waiting). */
async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`it took longer than ${Math.round(ms / 1000)} s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A driver module that can't be used, in plain words. */
export class DriverLoadError extends Error {
  override name = 'DriverLoadError';
}

/**
 * The driver a module file exports (its default export: a `TrackerDriver`, or a function that returns one), checked.
 * Throws `DriverLoadError` saying why it can't be used. `folder`: the plugin folder's name, which must be its id.
 */
export async function loadDriverModule(
  file: string,
  folder?: string,
  options: { deadlineMs?: number } = {},
): Promise<TrackerDriver> {
  // One deadline for loading and starting together.
  const until = Date.now() + (options.deadlineMs ?? PLUGIN_LOAD_DEADLINE_MS);
  const left = () => Math.max(0, until - Date.now());
  let mod: { default?: unknown };
  try {
    // The file's time in the URL: a driver replaced on disk is imported anew by the next start of a test or a reload.
    const stamp = existsSync(file) ? statSync(file).mtimeMs : 0;
    mod = (await withinDeadline(import(`${pathToFileURL(file).href}?v=${stamp}`), left())) as {
      default?: unknown;
    };
  } catch (err) {
    throw new DriverLoadError(`It couldn’t be loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
  let exported = mod.default;
  if (typeof exported === 'function') {
    try {
      exported = await withinDeadline(Promise.resolve((exported as () => unknown)()), left());
    } catch (err) {
      throw new DriverLoadError(`It failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const driver = exported as Partial<TrackerDriver> | null | undefined;
  if (!driver || typeof driver !== 'object') throw new DriverLoadError('It exports no driver.');
  const api = (driver.info as { api?: unknown } | undefined)?.api;
  if (api !== TRACKER_DRIVER_API)
    throw new DriverLoadError(
      `It was written for driver interface ${String(api)}; this Whombat speaks interface ${TRACKER_DRIVER_API}.`,
    );
  const info = TrackerDriverInfo.safeParse(driver.info);
  if (!info.success)
    throw new DriverLoadError(
      `What it says about itself isn’t right: ${info.error.issues[0]?.message ?? 'invalid'}.`,
    );
  if (folder !== undefined && folder !== info.data.id)
    throw new DriverLoadError(`It calls itself ${info.data.id}, but its folder is ${folder}.`);
  for (const call of REQUIRED_CALLS)
    if (typeof driver[call] !== 'function') throw new DriverLoadError(`It has no ${call} call.`);
  // Its calls bound to it, so a driver written as a class keeps its own methods and state.
  const out: Record<string, unknown> = { info: info.data };
  for (const call of [...REQUIRED_CALLS, ...OPTIONAL_CALLS]) {
    const fn = (driver as Record<string, unknown>)[call];
    if (typeof fn === 'function') out[call] = fn.bind(driver);
  }
  return out as unknown as TrackerDriver;
}

/** What loading the plugins folder found: the drivers by id, and the folders that didn't load. */
export interface LoadedPlugins {
  drivers: Map<string, TrackerDriver>;
  failed: { folder: string; reason: string }[];
}

/**
 * The first of `paths` its group or anyone else may write, or null. A driver runs with the server's rights, so only
 * the person who runs the box may change it: on an appliance the folder is root's (`pnpm ship` of the driver's
 * repository), the agents' commands and Hermes run as another user that can't enter the server's home, and nothing in
 * the server writes there.
 */
function changeableByOthers(paths: readonly string[]): string | null {
  for (const path of paths) if ((statSync(path).mode & 0o022) !== 0) return path;
  return null;
}

/** Every driver in `<home>/plugins`, loaded and checked; a folder without `plugin.mjs` is skipped. */
export async function loadPlugins(
  home: string,
  options: { deadlineMs?: number } = {},
): Promise<LoadedPlugins> {
  const root = join(home, 'plugins');
  const out: LoadedPlugins = { drivers: new Map(), failed: [] };
  let folders: string[];
  try {
    folders = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return out;
  }
  for (const folder of folders) {
    const file = join(root, folder, PLUGIN_FILE);
    if (!existsSync(file)) continue;
    try {
      const changeable = changeableByOthers([root, join(root, folder), file]);
      if (changeable)
        throw new DriverLoadError(
          `Someone other than its owner can change ${changeable}: make it writable by its owner only (chmod go-w).`,
        );
      const driver = await loadDriverModule(file, folder, options);
      out.drivers.set(driver.info.id, driver);
    } catch (err) {
      out.failed.push({ folder, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
