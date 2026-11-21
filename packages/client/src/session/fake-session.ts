/**
 * Fixture worlds on the session fake (hermes-engine-app.md AP-5303). The app has one transport, the secure session, so
 * fixture mode, Storybook, the demo world and tests talk to an in-memory box too: `createFakeSession` opens a real
 * `createSecureSession` on a `createFakeAppliance`, and every call crosses the session protocol's codec as a box's
 * would.
 *
 * The fixture worlds are written as REST handlers (a method and an API path in, a `Response` out: `@whombat/fixtures`,
 * the web's `fixtureFetch`, the phone's fixture server). `restHandler` answers the fake's operations with one and
 * `restResources` its attachment, picture and backup-file downloads. Nothing here touches a network.
 */
import {
  type AnyEndpoint,
  api,
  attachmentThumbnailUrl,
  backupDownloadUrl,
  buildPath,
  thingImagePath,
  toQueryString,
} from '@whombat/core/contracts';
import { createFakeAppliance, type FakeAppliance, type FakeApplianceOptions, type FakeHandler } from './fake';
import { createSecureSession, type SecureSessionOptions } from './secure';
import type { ApplianceSession, ResourceRef } from './types';

/** A REST fixture world: what `fetch` would do against a Whombat's API (it never leaves the process). */
export type RestFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The origin fixture URLs are built on (never reached). */
export const FAKE_ORIGIN = 'http://fixtures.whombat.local';

const API_BY_ID = new Map<string, AnyEndpoint>();
for (const group of Object.values(api as unknown as Record<string, Record<string, AnyEndpoint>>))
  for (const ep of Object.values(group)) API_BY_ID.set(ep.id, ep);

/** The endpoint a handler's op names (an API endpoint's id, or one of `extra`'s). */
export function endpointOf(op: string, extra?: ReadonlyMap<string, AnyEndpoint>): AnyEndpoint | null {
  return API_BY_ID.get(op) ?? extra?.get(op) ?? null;
}

/** `{params, query, body}` of an operation as the path, query string and JSON body its REST call has. */
export function restRequest(
  ep: AnyEndpoint,
  input: unknown,
  origin: string = FAKE_ORIGIN,
): { url: string; init: RequestInit } {
  const parts = (input ?? {}) as { params?: unknown; query?: unknown; body?: unknown };
  const path = buildPath(ep.path, (parts.params ?? {}) as Record<string, string>);
  const query = toQueryString((parts.query ?? {}) as Record<string, unknown>);
  return {
    url: `${origin}${ep.base}${path}${query}`,
    init: {
      method: ep.method,
      headers: { 'content-type': 'application/json' },
      ...(ep.method === 'GET' || parts.body === undefined ? {} : { body: JSON.stringify(parts.body) }),
    },
  };
}

/** A REST answer's status and parsed body (JSON, else the text as it came). */
export async function restAnswer(res: Response): Promise<{ status: number; body: unknown }> {
  const text = await res.text();
  if (!text) return { status: res.status, body: undefined };
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/**
 * The fake's operations answered by a REST fixture world; an op that is no endpoint is not found, and a world that
 * throws answers `unavailable`.
 */
export function restHandler(
  fetch: RestFetch,
  options: { origin?: string; endpoints?: readonly AnyEndpoint[] } = {},
): FakeHandler {
  const extra = new Map((options.endpoints ?? []).map((ep) => [ep.id, ep] as const));
  return async (op, input) => {
    const ep = endpointOf(op, extra);
    if (!ep)
      return { status: 404, body: { error: { code: 'not_found', message: `Nothing answers ${op}.` } } };
    const { url, init } = restRequest(ep, input, options.origin);
    try {
      return await restAnswer(await fetch(url, init));
    } catch {
      // A world that throws (a test's dropped request): the box couldn't answer.
      return {
        status: 503,
        body: { error: { code: 'unavailable', message: 'The Whombat couldn’t answer.' } },
      };
    }
  };
}

/** The REST path of a download (an attachment, a thing's picture, a backup file); null for anything else. */
function resourcePath(ref: ResourceRef): string | null {
  if (ref.kind === 'attachment')
    return `/api/v1/burrows/${encodeURIComponent(ref.burrow)}/attachments/${encodeURIComponent(ref.attachmentId)}${ref.download ? '?download=1' : ''}`;
  if (ref.kind === 'thing-image') return thingImagePath(ref.burrow, ref.thing, ref.ref);
  if (ref.kind === 'backup-file') return backupDownloadUrl(ref.burrow, ref.backupFileId);
  return null;
}

/** The fake's downloads read from a REST fixture world (null, not found, where it has no such file). */
export function restResources(
  fetch: RestFetch,
  origin: string = FAKE_ORIGIN,
): NonNullable<FakeApplianceOptions['resources']> {
  return async (ref) => {
    const path = resourcePath(ref);
    if (!path) return null;
    // A file's `preview` (its thumbnail, CT-298) as the server serves it, where the world has one; else the file.
    const thumbnail =
      ref.kind === 'attachment' && ref.variant === 'preview'
        ? await fetch(`${origin}${attachmentThumbnailUrl(ref.burrow, ref.attachmentId)}`, { method: 'GET' })
        : null;
    const res = thumbnail?.ok ? thumbnail : await fetch(`${origin}${path}`, { method: 'GET' });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const disposition = res.headers.get('content-disposition') ?? '';
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
    return {
      meta: {
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        size: bytes.byteLength,
        name: named ? decodeURIComponent(named) : null,
        sha256: res.headers.get('x-whombat-sha256'),
      },
      bytes,
    };
  };
}

export interface FakeSessionOptions extends FakeApplianceOptions {
  /** More of the session's options (backoff, clocks). The connection race and stall pings are off by default. */
  session?: Partial<Omit<SecureSessionOptions, 'connector'>>;
  platform?: 'web' | 'android' | 'ios';
}

/** A secure session on an in-memory box: `createSecureSession` over `createFakeAppliance`. */
export function createFakeSession(options: FakeSessionOptions): {
  session: ApplianceSession;
  appliance: FakeAppliance;
} {
  const { session: sessionOptions, platform = 'web', ...applianceOptions } = options;
  const appliance = createFakeAppliance(applianceOptions);
  const session = createSecureSession({
    connector: appliance.connector,
    client: { build: 'fake', platform },
    raceAfterMs: 0,
    stallMs: 0,
    ...sessionOptions,
  });
  return { appliance, session };
}
