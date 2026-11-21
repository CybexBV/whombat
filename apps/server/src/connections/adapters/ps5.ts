import { randomBytes } from 'node:crypto';
import {
  PS5_KEEP_RUNNING,
  PS5_MANAGER_ID,
  PS5_OFFICIAL_REPOSITORY,
  PS5_POWER_HELPER,
  PS5_WEBKIT_INSTALLER,
  Ps5AutoloadArgs,
  Ps5Config,
  Ps5EjectArgs,
  Ps5GameArgs,
  Ps5GameInfo,
  Ps5Games,
  Ps5History,
  Ps5InstallArgs,
  Ps5LogArgs,
  Ps5Logs,
  Ps5NoArgs,
  Ps5Payloads,
  Ps5Processes,
  Ps5RebootArgs,
  Ps5RunArgs,
  Ps5ShadowLog,
  Ps5ShadowLogArgs,
  Ps5StopArgs,
  Ps5Storage,
  Ps5StorageJob,
  Ps5UpdateArgs,
  Ps5WebkitArgs,
  ps5AllUpdates,
  ps5AutoloadList,
  ps5FileVersion,
  ps5FirmwareFits,
  ps5FirmwareRange,
  ps5ReleaseFor,
  ps5SlotOfPath,
  ps5VersionOrder,
} from '@whombat/core';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { catalogConnections } from '../../db/schema/index';
import type { Services } from '../../services';
import {
  firmwareOf,
  PS5_WEBKIT_AT_FIELD,
  PS5_WEBKIT_VERSION_FIELD,
  Ps5ApiError,
  type Ps5Context,
  ps5OfficialReleases,
  ps5ServiceUrl,
  readPs5,
  readPs5Console,
  readPs5Power,
  readPs5Snapshot,
} from '../ps5-api';
import { ps5PowerArtifact } from '../ps5-power-artifact';
import { ConnectionArgumentError } from '../request';
import { type Adapter, type AdapterContext, type AdapterTool, jsonOutput } from './types';

function args<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ConnectionArgumentError(
      'Those choices don’t fit this PS5 action. Read the tool’s fields and try again.',
    );
  return parsed.data;
}

async function action(
  ctx: Ps5Context,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<string> {
  const url = new URL(ps5ServiceUrl(ctx.baseUrl, ctx.fields, 'payloads', path));
  if (query) url.search = new URLSearchParams(query).toString();
  const res = await ctx.send({
    url: url.toString(),
    method: 'POST',
    headers: { 'X-PLDMGR-Request': '1', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status < 200 || res.status >= 300)
    throw new ConnectionArgumentError(
      'The PS5 couldn’t make that change. Check Payload Manager before trying again.',
    );
  return res.body.toString('utf8');
}

/** One of ShadowMountPlus's changes: its status and JSON answer (it has no request marker). */
async function shadowAction(
  ctx: Ps5Context,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; answer: Record<string, unknown> }> {
  const res = await ctx.send({
    url: ps5ServiceUrl(ctx.baseUrl, ctx.fields, 'shadowmount', path),
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let answer: unknown = null;
  try {
    answer = JSON.parse(res.body.toString('utf8'));
  } catch {
    // An answer that isn't JSON is judged by its status alone.
  }
  return {
    status: res.status,
    answer: answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {},
  };
}

async function officialPayloads(ctx: Ps5Context) {
  try {
    return await ps5OfficialReleases(ctx);
  } catch (err) {
    if (err instanceof Ps5ApiError) throw new ConnectionArgumentError(err.message);
    throw err;
  }
}

/** The approved release, as the Official Repository still lists it; throws when it changed. */
async function approvedRelease(ctx: Ps5Context, input: z.infer<typeof Ps5InstallArgs>) {
  const releases = await officialPayloads(ctx);
  const candidates = releases.filter((p) => p.id === input.id);
  const release = candidates.length === 1 ? candidates[0] : undefined;
  if (
    !release ||
    release.version !== input.version ||
    release.checksum.toLowerCase() !== input.checksum.toLowerCase()
  )
    throw new ConnectionArgumentError(
      'That release changed. Check the available version and checksum and ask again.',
    );
  return { release, releases };
}

/** Asks Payload Manager to download a release by id; throws unless it confirms. */
async function download(ctx: Ps5Context, id: string): Promise<void> {
  const result = await action(ctx, '/repository_install', undefined, {
    id,
    source_url: PS5_OFFICIAL_REPOSITORY,
  });
  let answer: unknown;
  try {
    answer = JSON.parse(result);
  } catch {
    throw new ConnectionArgumentError(
      'Payload Manager didn’t confirm the download. Check it before trying again.',
    );
  }
  if (!z.object({ ok: z.literal(true) }).safeParse(answer).success)
    throw new ConnectionArgumentError(
      'Payload Manager couldn’t download that release. Check it on your PS5.',
    );
}

/** The one installed slot holding exactly the approved release from the Official Repository, or null. */
function storedSlot(inventory: Ps5Payloads, input: z.infer<typeof Ps5InstallArgs>): string | null {
  const installed = inventory.items.filter(
    (p) =>
      p.id === input.id &&
      p.source_url === PS5_OFFICIAL_REPOSITORY &&
      p.version === input.version &&
      p.checksum?.toLowerCase() === input.checksum.toLowerCase(),
  );
  return installed.length === 1 && installed[0] ? installed[0].slot : null;
}

/** Check what was approved again before downloading, then check what the manager actually stored. */
async function installExact(ctx: Ps5Context, input: z.infer<typeof Ps5InstallArgs>) {
  await approvedRelease(ctx, input);
  if (input.id !== PS5_MANAGER_ID) {
    const existing = storedSlot(await readPs5(ctx, '/list_payloads', Ps5Payloads), input);
    if (existing) return { slot: existing, version: input.version, pending: false, reused: true };
  }
  await download(ctx, input.id);
  const inventory = await readPs5(ctx, '/list_payloads', Ps5Payloads);
  if (input.id === PS5_MANAGER_ID) {
    if (inventory.self.pending_version.replace(/^v/, '') !== input.version.replace(/^v/, ''))
      throw new ConnectionArgumentError(
        'Payload Manager hasn’t confirmed that update. Check it on your PS5.',
      );
    return { slot: null, version: input.version, pending: true };
  }
  const slot = storedSlot(inventory, input);
  if (!slot)
    throw new ConnectionArgumentError(
      'The downloaded payload doesn’t match the approved release. Whombat didn’t run it.',
    );
  return { slot, version: input.version, pending: false, reused: false };
}

/**
 * Runs an installed slot (checked again first) and tells whether Payload Manager's launch history now starts with it:
 * the loader's OK means it received the whole file, the history that Payload Manager counted it as launched.
 */
async function launch(
  ctx: Ps5Context,
  slot: string,
  expected?: z.infer<typeof Ps5InstallArgs>,
  expectedFilename?: string,
): Promise<{ confirmed: boolean }> {
  const inventory = await readPs5(ctx, '/list_payloads', Ps5Payloads);
  const installed = inventory.items.find((p) => p.slot === slot);
  if (!installed)
    throw new ConnectionArgumentError(
      'That payload isn’t installed any more. Read the payload list and choose it again.',
    );
  if (expectedFilename && installed.filename !== expectedFilename)
    throw new ConnectionArgumentError('The uploaded helper changed before launch. Whombat didn’t run it.');
  if (
    expected &&
    (installed.id !== expected.id ||
      installed.version !== expected.version ||
      installed.checksum?.toLowerCase() !== expected.checksum.toLowerCase() ||
      installed.source_url !== PS5_OFFICIAL_REPOSITORY)
  )
    throw new ConnectionArgumentError('That payload changed after downloading. Whombat didn’t run it.');
  const answer = await action(ctx, `/loadpayload:${encodeURIComponent(slot)}`);
  if (answer.trim() !== 'OK')
    throw new ConnectionArgumentError(
      'The loader didn’t confirm that payload. Check Payload Manager before trying again.',
    );
  const history = await readPs5(ctx, '/history_list', Ps5History).catch(() => null);
  const first = history?.history[0];
  return { confirmed: !!first && ps5SlotOfPath(first) === slot };
}

/** Startup's three fields are as they were read: nobody changed them since. */
const sameStartup = (a: z.infer<typeof Ps5Config>, b: z.infer<typeof Ps5Config>) =>
  a.AUTOLOAD_LIST === b.AUTOLOAD_LIST &&
  a.AUTOLOAD_ENABLED === b.AUTOLOAD_ENABLED &&
  a.AUTOLOAD_DELAY === b.AUTOLOAD_DELAY;

/** Writes only startup's three fields and reads them back; throws when the PS5 doesn't confirm them. */
async function writeStartup(ctx: Ps5Context, next: z.infer<typeof Ps5Config>) {
  await action(ctx, '/set_config', {
    AUTOLOAD_ENABLED: next.AUTOLOAD_ENABLED,
    AUTOLOAD_LIST: next.AUTOLOAD_LIST,
    AUTOLOAD_DELAY: next.AUTOLOAD_DELAY,
  });
  const saved = await readPs5(ctx, '/get_config', Ps5Config);
  if (!sameStartup(saved, next))
    throw new ConnectionArgumentError(
      'The PS5 didn’t confirm those startup settings. Read them again before trying another change.',
    );
  return saved;
}

/** Keeps a few facts on the connection (the WebKit installer Whombat ran); a failure to keep them changes nothing else. */
export async function keepPs5Fields(
  services: Services,
  connectionId: string,
  values: Record<string, string>,
): Promise<void> {
  try {
    await services.pipeline.transactAccount((tx) =>
      tx
        .update(catalogConnections)
        .set({
          fields: sql`${catalogConnections.fields} || ${JSON.stringify(values)}::jsonb`,
          updatedAt: services.clock(),
        })
        .where(eq(catalogConnections.id, connectionId)),
    );
  } catch (err) {
    services.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'ps5: record not kept');
  }
}

/** What an update keeps on the connection; nothing when the caller has nowhere to keep it (tests). */
export type Ps5Keep = (values: Record<string, string>) => Promise<void>;

function remember(ctx: AdapterContext): Ps5Keep {
  const call = ctx.call;
  return call ? (values) => keepPs5Fields(call.services, call.connectionId, values) : async () => {};
}

function output(value: unknown) {
  return jsonOutput(value, { status: 200, body: Buffer.from(JSON.stringify(value)) });
}

/** A payload's version as it reports it, else as its file name carries it (one uploaded by hand reports none). */
function withVersions(inventory: Ps5Payloads) {
  return {
    ...inventory,
    items: inventory.items.map((p) => {
      if (p.version) return p;
      const file = ps5FileVersion(p.filename);
      return file ? { ...p, version: file.version, versionFrom: 'file name' } : p;
    }),
  };
}

/**
 * Replaces an installed payload with the approved Official Repository release (the assistant's tool and the page's
 * Update): the release checked again, a stored copy reused, what was stored checked. A payload uploaded by hand gets a
 * slot of its own; startup moves to it only if nobody changed startup meanwhile, and the old copy stays.
 */
export async function ps5UpdatePayload(ctx: Ps5Context, chosen: z.infer<typeof Ps5UpdateArgs>) {
  if (chosen.id === PS5_WEBKIT_INSTALLER || chosen.id === PS5_MANAGER_ID)
    throw new ConnectionArgumentError(
      chosen.id === PS5_MANAGER_ID
        ? 'Payload Manager updates itself: use ps5_install_payload.'
        : 'Use ps5_update_webkit for WebKit Autoloader.',
    );
  const { slot, ...release } = chosen;
  const { releases } = await approvedRelease(ctx, release);
  const [inventory, before] = await Promise.all([
    readPs5(ctx, '/list_payloads', Ps5Payloads),
    readPs5(ctx, '/get_config', Ps5Config),
  ]);
  const item = inventory.items.find((p) => p.slot === slot);
  if (!item)
    throw new ConnectionArgumentError(
      'That payload isn’t installed any more. Read the payload list and choose it again.',
    );
  if (ps5ReleaseFor(item, releases)?.id !== release.id)
    throw new ConnectionArgumentError('That slot holds another payload. Read ps5_payload_updates again.');
  const current = item.version || ps5FileVersion(item.filename)?.version;
  if (current && (ps5VersionOrder(release.version, current) ?? 1) <= 0)
    throw new ConnectionArgumentError('That payload already has this version or a newer one.');
  let updated = storedSlot(inventory, release);
  const reused = updated !== null;
  if (!updated) {
    await download(ctx, release.id);
    updated = storedSlot(await readPs5(ctx, '/list_payloads', Ps5Payloads), release);
  }
  if (!updated)
    throw new ConnectionArgumentError(
      'The downloaded payload doesn’t match the approved release. Startup wasn’t changed.',
    );
  const entries = before.AUTOLOAD_LIST.split(',');
  let startup: 'unchanged' | 'switched' | 'not_switched' = 'unchanged';
  // A payload uploaded by hand gets a new slot: startup moves to it, and the old copy stays to go back to.
  if (updated !== slot && entries.includes(slot)) {
    const now = await readPs5(ctx, '/get_config', Ps5Config);
    if (sameStartup(now, before)) {
      await writeStartup(ctx, {
        ...before,
        AUTOLOAD_LIST: entries.map((e) => (e === slot ? updated : e)).join(','),
      });
      startup = 'switched';
    } else startup = 'not_switched';
  }
  const name = item.name || ps5FileVersion(item.filename)?.name || release.id;
  return {
    name,
    slot: updated,
    previous: updated === slot ? null : slot,
    version: release.version,
    startup,
    reused,
    message:
      startup === 'not_switched'
        ? 'The new version is downloaded, but startup changed in the meantime, so it still starts the old copy.'
        : `${name} ${release.version} is downloaded. It takes effect the next time it starts.${updated === slot ? '' : ` The old copy stays in ${slot}.`}`,
  };
}

/**
 * Downloads (or reuses) the approved WebKit Autoloader installer and runs it, after checking the release supports the
 * console's firmware; keeps which version Whombat ran and when.
 */
export async function ps5UpdateWebkit(
  ctx: Ps5Context,
  chosen: z.infer<typeof Ps5WebkitArgs>,
  keep: Ps5Keep,
  now: Date,
) {
  const approved = { ...chosen, id: PS5_WEBKIT_INSTALLER };
  const [{ release }, seen] = await Promise.all([approvedRelease(ctx, approved), readPs5Console(ctx)]);
  const firmware = firmwareOf(seen);
  const range = ps5FirmwareRange(`${release.description} ${release.release_notes ?? ''}`);
  if (ps5FirmwareFits(firmware, range) === false)
    throw new ConnectionArgumentError(
      `This release supports firmware ${range?.from} to ${range?.to}; your PS5 runs ${firmware}. Whombat didn’t download it.`,
    );
  let slot = storedSlot(await readPs5(ctx, '/list_payloads', Ps5Payloads), approved);
  const reused = slot !== null;
  if (!slot) {
    await download(ctx, approved.id);
    slot = storedSlot(await readPs5(ctx, '/list_payloads', Ps5Payloads), approved);
  }
  if (!slot)
    throw new ConnectionArgumentError(
      'The downloaded payload doesn’t match the approved release. Whombat didn’t run it.',
    );
  await launch(ctx, slot, approved);
  await keep({ [PS5_WEBKIT_VERSION_FIELD]: approved.version, [PS5_WEBKIT_AT_FIELD]: now.toISOString() });
  return {
    version: approved.version,
    firmware,
    reused,
    message:
      'The loader accepted the WebKit Autoloader installer. Wait for the PS5 to confirm caching finished, then reboot and open WebKit Autoloader. Whombat hasn’t verified the cached version.',
  };
}

/** Downloads the approved Payload Manager update; it waits for Payload Manager to start again. */
export async function ps5UpdateManager(ctx: Ps5Context, chosen: z.infer<typeof Ps5WebkitArgs>) {
  return installExact(ctx, { ...chosen, id: PS5_MANAGER_ID });
}

const handlers: Adapter = {
  async ps5_power_status(ctx, input) {
    args(Ps5NoArgs, input);
    return output(await readPs5Power(ctx));
  },
  async ps5_enable_remote_reboot(ctx, input) {
    args(Ps5NoArgs, input);
    if (!ctx.line) throw new ConnectionArgumentError('Remote reboot isn’t available here.');
    const ready = await readPs5Power(ctx);
    if (ready.ready) return output({ ...ready, message: 'Remote reboot is already ready.' });
    const before = await readPs5(ctx, '/list_payloads', Ps5Payloads);
    const bytes = await ps5PowerArtifact(ctx);
    // A new slot retains every existing payload and startup choice, including a prior helper copy.
    const filename = `whombat-power-${randomBytes(6).toString('hex')}.elf`;
    const url = new URL(ps5ServiceUrl(ctx.baseUrl, ctx.fields, 'payloads', '/manage:upload'));
    url.searchParams.set('filename', filename);
    url.searchParams.set('mode', 'new');
    const res = await ctx.send({
      url: url.toString(),
      method: 'POST',
      headers: { 'X-PLDMGR-Request': '1', 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (res.status !== 200 || res.body.toString('utf8').trim() !== 'OK')
      throw new ConnectionArgumentError(
        'Payload Manager didn’t confirm the helper upload. Check it before trying again.',
      );
    const after = await readPs5(ctx, '/list_payloads', Ps5Payloads);
    const slots = after.items.filter(
      (p) => p.filename === filename && !before.items.some((old) => old.slot === p.slot),
    );
    const stored = slots.length === 1 ? slots[0] : undefined;
    if (!stored?.slot.startsWith('local/'))
      throw new ConnectionArgumentError(
        'Payload Manager didn’t identify the uploaded helper. Whombat didn’t run it.',
      );
    await launch(ctx, stored.slot, undefined, filename);
    const status = await readPs5Power(ctx);
    return output({
      ...status,
      slot: stored.slot,
      version: PS5_POWER_HELPER.version,
      message: status.ready
        ? 'Remote reboot is ready. It stops games and homebrew; open WebKit Autoloader again after restarting. The helper hasn’t been added to startup.'
        : 'The loader accepted the reboot helper, but it hasn’t answered yet. Read ps5_power_status before trying setup again, and check that port 9112 is allowed.',
    });
  },
  async ps5_reboot(ctx, input) {
    const { expectedPid } = args(Ps5RebootArgs, input);
    const status = await readPs5Power(ctx);
    if (!status.ready || !ctx.line)
      throw new ConnectionArgumentError(
        status.ready ? 'Remote reboot isn’t available here.' : status.message,
      );
    if (status.pid !== expectedPid)
      throw new ConnectionArgumentError(
        'The reboot helper changed since you looked. Read ps5_power_status and ask again.',
      );
    const job = await readPs5(ctx, '/api/v1/games/storage/status', Ps5StorageJob, true).catch(() => null);
    if (job?.active)
      throw new ConnectionArgumentError(
        'A storage job is still running. Wait for it to finish before rebooting.',
      );
    const reply = await ctx.line(PS5_POWER_HELPER.port, 'REBOOT\n', false);
    if (reply !== 'OK rebooting\n')
      throw new ConnectionArgumentError(
        'The helper didn’t confirm the reboot request. Check your PS5 before trying again.',
      );
    return output({
      accepted: true,
      completed: false,
      message:
        'The PS5 helper accepted the reboot request. Whombat hasn’t confirmed it restarted. Open WebKit Autoloader again afterwards to bring homebrew back.',
    });
  },
  async ps5_status(ctx, input) {
    args(Ps5NoArgs, input);
    return output(await readPs5Snapshot(ctx));
  },
  async ps5_payloads(ctx, input) {
    args(Ps5NoArgs, input);
    return output(withVersions(await readPs5(ctx, '/list_payloads', Ps5Payloads)));
  },
  async ps5_processes(ctx, input) {
    args(Ps5NoArgs, input);
    return output(await readPs5(ctx, '/processes_list', Ps5Processes));
  },
  async ps5_games(ctx, input) {
    args(Ps5NoArgs, input);
    return output(await readPs5(ctx, '/api/v1/games', Ps5Games, true));
  },
  async ps5_game_info(ctx, input) {
    const { titleId } = args(Ps5GameArgs, input);
    return output(await readPs5(ctx, '/api/v1/games/info', Ps5GameInfo, true, { title_id: titleId }));
  },
  async ps5_storage(ctx, input) {
    args(Ps5NoArgs, input);
    const [storage, job] = await Promise.all([
      readPs5(ctx, '/api/v1/storage', Ps5Storage, true),
      readPs5(ctx, '/api/v1/games/storage/status', Ps5StorageJob, true).catch(() => null),
    ]);
    return output({ ...storage, job: job && job.state !== 'idle' ? job : null });
  },
  async ps5_logs(ctx, input) {
    const { lines } = args(Ps5LogArgs, input);
    const { logs } = await readPs5(ctx, '/log', Ps5Logs);
    return output({ logs: logs.slice(-lines) });
  },
  async ps5_shadowmount_logs(ctx, input) {
    const { log, kilobytes } = args(Ps5ShadowLogArgs, input);
    const read = await readPs5(ctx, `/api/v1/${log}-log`, Ps5ShadowLog, true, {
      max_bytes: kilobytes * 1024,
    });
    return output({ log, content: read.content, truncated: read.truncated ?? false });
  },
  async ps5_payload_updates(ctx, input) {
    args(Ps5NoArgs, input);
    const [releases, inventory, config, seen] = await Promise.all([
      officialPayloads(ctx),
      readPs5(ctx, '/list_payloads', Ps5Payloads),
      readPs5(ctx, '/get_config', Ps5Config).catch(() => null),
      readPs5Console(ctx),
    ]);
    const firmware = firmwareOf(seen);
    return output({
      source: 'Official Repository',
      firmware,
      updates: ps5AllUpdates(inventory, releases, config?.AUTOLOAD_LIST ?? '', firmware),
      releases: releases.map(({ release_notes: _notes, ...r }) => ({
        ...r,
        firmware: ps5FirmwareRange(r.description),
      })),
    });
  },
  async ps5_install_payload(ctx, input) {
    const result = await installExact(ctx, args(Ps5InstallArgs, input));
    return output({
      ...result,
      message: result.pending
        ? 'The Payload Manager update is downloaded. It takes effect when Payload Manager starts again.'
        : 'The payload is downloaded. It hasn’t been run.',
    });
  },
  async ps5_update_payload(ctx, input) {
    return output(await ps5UpdatePayload(ctx, args(Ps5UpdateArgs, input)));
  },
  async ps5_run_payload(ctx, input) {
    const { slot } = args(Ps5RunArgs, input);
    const { confirmed } = await launch(ctx, slot);
    return output({
      slot,
      started: confirmed,
      message: confirmed
        ? 'The PS5 received the payload and started it. Check its process or log to see whether it’s still running.'
        : 'The loader accepted the payload. Check its process or log to see whether it finished.',
    });
  },
  async ps5_update_webkit(ctx, input) {
    return output(
      await ps5UpdateWebkit(
        ctx,
        args(Ps5WebkitArgs, input),
        remember(ctx),
        ctx.call?.services.clock() ?? new Date(),
      ),
    );
  },
  async ps5_set_autoload(ctx, input) {
    const chosen = args(Ps5AutoloadArgs, input);
    const current = await readPs5(ctx, '/get_config', Ps5Config);
    if (!sameStartup(current, chosen.expectedConfig))
      throw new ConnectionArgumentError(
        'Startup changed since you looked. Read it again before changing it.',
      );
    const inventory = await readPs5(ctx, '/list_payloads', Ps5Payloads);
    for (const e of chosen.entries) {
      if (!('slot' in e)) continue;
      const payload = inventory.items.find((p) => p.slot === e.slot);
      if (!payload || /install/i.test(`${payload.id ?? ''} ${payload.filename}`))
        throw new ConnectionArgumentError(
          'Choose installed homebrew payloads for startup. Installers can’t run automatically.',
        );
    }
    const saved = await writeStartup(ctx, {
      AUTOLOAD_ENABLED: chosen.enabled,
      AUTOLOAD_LIST: ps5AutoloadList(chosen),
      AUTOLOAD_DELAY: chosen.delaySeconds,
    });
    return output({ message: 'Your homebrew startup settings are saved.', config: saved });
  },
  async ps5_rescan_games(ctx, input) {
    args(Ps5NoArgs, input);
    const { status, answer } = await shadowAction(ctx, '/api/v1/scan', { reset_attempts: false });
    if (status < 200 || status >= 300 || answer.status !== 0)
      throw new ConnectionArgumentError('ShadowMountPlus couldn’t start a scan. Check it on your PS5.');
    const reason = typeof answer.scan_deferred_reason === 'string' ? answer.scan_deferred_reason : '';
    return output({
      queued: answer.scan_queued === true,
      deferred: answer.scan_deferred === true,
      message:
        answer.scan_deferred === true
          ? `ShadowMountPlus will scan when it can${reason === 'game_active' ? ', after the game closes' : reason === 'rest_mode' ? ', after rest mode' : ''}.`
          : 'ShadowMountPlus is scanning your games. Read ps5_games in a minute to see what it found.',
    });
  },
  async ps5_eject_usb(ctx, input) {
    const { mountPoint } = args(Ps5EjectArgs, input);
    const storage = await readPs5(ctx, '/api/v1/storage', Ps5Storage, true);
    const mount = storage.mounts.find((m) => m.mount_point === mountPoint);
    if (!mount?.ejectable || !mount.source || !mount.mount_id)
      throw new ConnectionArgumentError(
        'That drive isn’t connected or can’t be ejected. Read ps5_storage again.',
      );
    const { status, answer } = await shadowAction(ctx, '/api/v1/storage/eject', {
      path: mount.mount_point,
      source: mount.source,
      mount_id: mount.mount_id,
    });
    if (status === 409)
      throw new ConnectionArgumentError(
        'That drive changed or is busy. Read ps5_storage again before ejecting.',
      );
    if (status < 200 || status >= 300)
      throw new ConnectionArgumentError('ShadowMountPlus couldn’t eject that drive. Check it on your PS5.');
    return output({
      jobId: typeof answer.job_id === 'number' ? answer.job_id : null,
      message:
        'ShadowMountPlus is ejecting the drive. Read ps5_storage: it’s safe to unplug once the job says completed.',
    });
  },
  async ps5_stop_payload(ctx, input) {
    const { pid, name } = args(Ps5StopArgs, input);
    const { processes } = await readPs5(ctx, '/processes_list', Ps5Processes);
    const target = processes.find((p) => p.pid === pid);
    if (!target || target.name !== name)
      throw new ConnectionArgumentError('That process isn’t running any more. Read ps5_processes again.');
    if (!target.is_daemon || !/\.elf$/i.test(name) || (PS5_KEEP_RUNNING as readonly string[]).includes(name))
      throw new ConnectionArgumentError(
        'Only a homebrew payload can be stopped here, not the loader, the jailbreak or Payload Manager.',
      );
    const answer = await action(ctx, '/process_kill', undefined, { pid: String(pid) });
    if (!z.object({ ok: z.literal(true) }).safeParse(JSON.parse(answer || 'null')).success)
      throw new ConnectionArgumentError('The PS5 couldn’t stop it. Check Payload Manager.');
    const after = await readPs5(ctx, '/processes_list', Ps5Processes).catch(() => null);
    const stopped = after ? !after.processes.some((p) => p.pid === pid && p.name === name) : null;
    return output({
      stopped,
      message:
        stopped === false
          ? `${name} was asked to stop but is still running.`
          : `${name} is stopped. It starts again with homebrew startup if it’s in it.`,
    });
  },
};

/** Translate protocol failures into the connection tool's readable error. Network policy errors keep their type. */
function readableErrors(run: AdapterTool): AdapterTool {
  return async (ctx, input) => {
    try {
      return await run(ctx, input);
    } catch (error) {
      if (error instanceof Ps5ApiError) throw new ConnectionArgumentError(error.message);
      if (error instanceof SyntaxError)
        throw new ConnectionArgumentError('The PS5 answered with something Whombat can’t read.');
      throw error;
    }
  };
}
export const PS5_ADAPTER: Adapter = Object.fromEntries(
  Object.entries(handlers).map(([name, run]) => [name, readableErrors(run)]),
);
