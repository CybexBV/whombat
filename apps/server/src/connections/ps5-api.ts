/** Shared PS5 reads, independent of the server registry so dashboards and tools can use them. */
import {
  PS5_DISCOVERY_PORT,
  PS5_DISCOVERY_REQUEST,
  PS5_OFFICIAL_REPOSITORY,
  PS5_POWER_HELPER,
  PS5_WEBKIT_INSTALLER,
  Ps5Config,
  type Ps5Console,
  Ps5Games,
  Ps5History,
  Ps5Logs,
  Ps5Payloads,
  type Ps5PowerStatus,
  Ps5Processes,
  type Ps5Release,
  Ps5Repository,
  Ps5ShadowVersion,
  Ps5Storage,
  parsePs5Discovery,
  parsePs5PowerStatus,
  ps5AllUpdates,
  ps5SlotOfPath,
  ps5StartupRun,
} from '@whombat/core';
import type { z } from 'zod';
import type { AdapterContext } from './adapters/types';
export class Ps5ApiError extends Error {}

export type Ps5Context = Pick<AdapterContext, 'baseUrl' | 'fields' | 'send' | 'datagram' | 'line'>;

/** The connection fields where Whombat keeps the WebKit Autoloader installer it ran: the version and when. */
export const PS5_WEBKIT_VERSION_FIELD = 'webkitVersion';
export const PS5_WEBKIT_AT_FIELD = 'webkitUpdatedAt';

/** Both services stay on the console's host; a field can only choose ShadowMount's port. */
export function ps5ServiceUrl(
  base: string,
  fields: Readonly<Record<string, string>>,
  service: 'payloads' | 'shadowmount',
  path: string,
): string {
  const url = new URL(base);
  if (service === 'shadowmount') {
    const port = fields.shadowmountPort || '10101';
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
      throw new Error('ShadowMountPlus needs a port from 1 to 65535.');
    url.port = port;
  }
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

const ICON_PATH = /^\/api\/v1\/games\/icon\?title_id=([A-Z]{4}\d{5})(?:&v=([A-Za-z0-9._-]{1,80}))?$/;

/** The picture path of a game's cover (ShadowMountPlus's `icon_url`, small), or null when it isn't one. */
export function ps5CoverPath(titleId: string, iconUrl?: string): string | null {
  if (!/^[A-Z]{4}\d{5}$/.test(titleId)) return null;
  const v = iconUrl ? /[?&]v=([A-Za-z0-9._-]{1,80})(?:&|$)/.exec(iconUrl)?.[1] : undefined;
  return `/api/v1/games/icon?title_id=${titleId}${v ? `&v=${v}` : ''}`;
}

/** Where a cover's path is fetched: ShadowMountPlus's own port on the console; null for any other path. */
export function ps5PictureUrl(
  base: string,
  fields: Readonly<Record<string, string>>,
  path: string,
): string | null {
  const m = ICON_PATH.exec(path);
  if (!m?.[1]) return null;
  const url = new URL(ps5ServiceUrl(base, fields, 'shadowmount', '/api/v1/games/icon'));
  url.searchParams.set('title_id', m[1]);
  if (m[2]) url.searchParams.set('v', m[2]);
  url.searchParams.set('size', 'thumb');
  return url.toString();
}

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Ps5ApiError('The PS5 answered with something Whombat can’t read.');
  return parsed.data;
}

/**
 * Only these fixed requests read ShadowMountPlus; its POST method alone does not mean a change. `body` is the read's
 * own JSON (a game's id, a log's length); absent, the fixed one.
 */
export async function readPs5<T>(
  ctx: Ps5Context,
  path: string,
  schema: z.ZodType<T>,
  shadow = false,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await ctx.send({
    url: ps5ServiceUrl(ctx.baseUrl, ctx.fields, shadow ? 'shadowmount' : 'payloads', path),
    method: shadow ? 'POST' : 'GET',
    headers: { Accept: 'application/json', ...(shadow ? { 'Content-Type': 'application/json' } : {}) },
    ...(shadow
      ? { body: body ? JSON.stringify(body) : path === '/api/v1/games' ? '{"include_size":false}' : '{}' }
      : {}),
  });
  if (res.status < 200 || res.status >= 300)
    throw new Ps5ApiError(
      shadow
        ? 'ShadowMountPlus isn’t ready. Open it on your PS5 and try again.'
        : 'Payload Manager isn’t ready. Open WebKit Autoloader on your PS5 and try again.',
    );
  let raw: unknown;
  try {
    raw = JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new Ps5ApiError('The PS5 answered with something Whombat can’t read.');
  }
  return checked(schema, raw);
}

/**
 * The console's own answer to Sony's discovery (awake or resting, its name and firmware); `silent` when it didn't
 * answer, which can't tell off from rest without networking or a blocked port; null when it can't be asked here.
 */
export async function readPs5Console(ctx: Ps5Context): Promise<Ps5Console | 'silent' | null> {
  if (!ctx.datagram) return null;
  try {
    // A console waking up has been seen to answer once with bytes that aren't its answer: it is asked once more.
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await ctx.datagram(PS5_DISCOVERY_PORT, Buffer.from(PS5_DISCOVERY_REQUEST));
      if (!answer) return 'silent';
      const seen = parsePs5Discovery(answer.toString('utf8'));
      if (seen) return seen;
    }
    return 'silent';
  } catch {
    // The address isn't allowed for this port (or the probe broke): nothing to say about the console.
    return null;
  }
}

/** The Official Repository's releases as Payload Manager lists them; throws when it isn't ready there. */
export async function ps5OfficialReleases(ctx: Ps5Context): Promise<Ps5Release[]> {
  const repo = await readPs5(ctx, '/repository_payloads', Ps5Repository);
  const sources = repo.sources.filter((s) => s.url === PS5_OFFICIAL_REPOSITORY && !s.error);
  if (sources.length !== 1)
    throw new Ps5ApiError(
      'The Official Repository isn’t ready in Payload Manager. Check it on your PS5 and try again.',
    );
  return sources[0]?.payloads ?? [];
}

/** The firmware the console reported, when it did. */
export const firmwareOf = (c: Ps5Console | 'silent' | null) => (c && c !== 'silent' ? c.firmware : null);

/** A missing optional helper is a capability to set up, not an availability alarm. */
export async function readPs5Power(ctx: Ps5Context): Promise<Ps5PowerStatus> {
  if (ctx.line) {
    try {
      const ready = parsePs5PowerStatus(await ctx.line(PS5_POWER_HELPER.port, 'STATUS\n', true));
      if (ready) return ready;
    } catch {
      // It may be absent, asleep or not allowed on this port; never infer console power from it.
    }
  }
  return {
    ready: false,
    message:
      'Remote reboot isn’t ready. Ask Whombat to enable it while Payload Manager is running; its helper needs port 9112 allowed on your home network.',
  };
}

/**
 * The WebKit Autoloader installer Whombat ran (its version and when), and whether homebrew has started again since:
 * Payload Manager's launch history starts empty when it starts, so an installer missing from it means it started anew.
 */
export function ps5WebkitRecord(
  fields: Readonly<Record<string, string>>,
  payloads: Ps5Payloads,
  history: Ps5History | null,
): { version: string; at: string; startedSince: boolean | null } | null {
  const version = fields[PS5_WEBKIT_VERSION_FIELD];
  const at = fields[PS5_WEBKIT_AT_FIELD];
  if (!version || !at) return null;
  const installer = payloads.items.find((p) => p.id === PS5_WEBKIT_INSTALLER)?.slot;
  const startedSince = history
    ? !history.history.some((path) => installer !== undefined && ps5SlotOfPath(path) === installer)
    : null;
  return { version, at, startedSince };
}

export async function readPs5Snapshot(ctx: Ps5Context) {
  const [payloads, config, processes, history, logs, releases, shadow, games, storage, discovery, power] =
    await Promise.allSettled([
      readPs5(ctx, '/list_payloads', Ps5Payloads),
      readPs5(ctx, '/get_config', Ps5Config),
      readPs5(ctx, '/processes_list', Ps5Processes),
      readPs5(ctx, '/history_list', Ps5History),
      readPs5(ctx, '/log', Ps5Logs),
      ps5OfficialReleases(ctx),
      readPs5(ctx, '/api/v1/version', Ps5ShadowVersion, true),
      readPs5(ctx, '/api/v1/games', Ps5Games, true),
      readPs5(ctx, '/api/v1/storage', Ps5Storage, true),
      readPs5Console(ctx),
      readPs5Power(ctx),
    ]);
  if (payloads.status === 'rejected') throw payloads.reason;
  const ok = <T>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);
  const cfg = ok(config);
  const seen = ok(discovery);
  const found = ok(releases);
  const kept = ok(history);
  return {
    payloads: payloads.value,
    config: cfg,
    processes: ok(processes),
    history: kept,
    startup: logs.status === 'fulfilled' ? ps5StartupRun(logs.value.logs) : null,
    releases: found,
    updates: found ? ps5AllUpdates(payloads.value, found, cfg?.AUTOLOAD_LIST ?? '', firmwareOf(seen)) : null,
    console: seen,
    power: ok(power),
    webkit: ps5WebkitRecord(ctx.fields, payloads.value, kept),
    shadow: ok(shadow),
    games: ok(games),
    storage: ok(storage),
    unavailable: [
      ...(config.status === 'rejected' ? ['Startup settings'] : []),
      ...(processes.status === 'rejected' ? ['Running homebrew'] : []),
      ...(releases.status === 'rejected' ? ['Homebrew releases'] : []),
      ...(shadow.status === 'rejected' || games.status === 'rejected' || storage.status === 'rejected'
        ? ['ShadowMountPlus']
        : []),
    ],
  };
}
export type Ps5Snapshot = Awaited<ReturnType<typeof readPs5Snapshot>>;
