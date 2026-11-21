/**
 * The service pages' routes over the Fetch API (contracts 0.121.0, CT-1011): `things.page`, `things.action` and the
 * picture route `things.image` (`THING_IMAGE_TRANSFER`) for the things of `createServicePages()`, for the web's fixture
 * layer; since 0.122 (CT-1067) also `things.quiet`, `things.watch` and `things.setWatch`. Exported from
 * `@whombat/fixtures/fetch` (it needs the DOM's `Request`/`Response`).
 *
 * ```ts
 * const services = createServicePages({ now: () => Date.now() });
 * const answer = await handleServicePagesRequest(services, req);
 * if (answer) return answer; // else the next layer
 * ```
 */
import { API_PREFIX, QuietNoticeBody, SetThingWatchBody, ThingActionBody } from '@whombat/core/contracts';
import type { ServicePages } from './servicePages.js';

const ROUTE = /^\/burrows\/[^/]+\/things\/([^/]+)(?:\/(actions|quiet|watch)|\/images\/([^/]+))?$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The answer to a body that parses, or the server's 400. */
function parsed<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  raw: unknown,
  answer: (body: T) => { status: number; body: unknown } | null,
): { status: number; body: unknown } | null {
  const r = schema.safeParse(raw);
  if (!r.success)
    return {
      status: 400,
      body: { error: { code: 'validation_failed', message: 'That isn’t a line of this page.' } },
    };
  return answer(r.data);
}

/**
 * The answer to one of the routes for one of the pages' things, or null (another layer answers): a page
 * (`GET …/things/:thing`), a pressed button (`POST …/actions`, 202 with `ThingActionResponse`), a picture
 * (`GET`/`HEAD …/images/:ref`, `image/png`, 404 for any other ref), a quieted line (`POST …/quiet`) or What Whombat
 * watches (`GET`/`POST …/watch`).
 */
export async function handleServicePagesRequest(pages: ServicePages, req: Request): Promise<Response | null> {
  const url = new URL(req.url, 'http://fixtures.local');
  if (!url.pathname.startsWith(`${API_PREFIX}/`)) return null;
  const m = ROUTE.exec(url.pathname.slice(API_PREFIX.length));
  if (!m) return null;
  const thing = decodeURIComponent(m[1] as string);
  if (m[3] !== undefined) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    // Only the pages' own things answer pictures here; another layer's thing has none.
    if (!pages.page(thing)) return null;
    const picture = pages.image(decodeURIComponent(m[3]));
    if (!picture) return new Response(null, { status: 404 });
    return new Response(req.method === 'HEAD' ? null : (picture.bytes.slice().buffer as ArrayBuffer), {
      status: 200,
      headers: {
        'content-type': picture.contentType,
        'content-length': String(picture.bytes.length),
        'cache-control': 'private, max-age=300',
      },
    });
  }
  if (m[2] === 'watch' && req.method === 'GET') {
    const watch = pages.watch(thing);
    return watch ? json(watch) : null;
  }
  if (m[2] === 'quiet' || m[2] === 'watch') {
    if (req.method !== 'POST') return null;
    const raw = await req.json().catch(() => null);
    const answer =
      m[2] === 'quiet'
        ? parsed(QuietNoticeBody, raw, (body) => pages.quiet(thing, body))
        : parsed(SetThingWatchBody, raw, (body) => pages.setWatch(thing, body));
    return answer ? json(answer.body, answer.status) : null;
  }
  if (m[2] !== undefined) {
    if (req.method !== 'POST') return null;
    const parsed = ThingActionBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return json(
        { error: { code: 'validation_failed', message: 'That isn’t a button of this page.' } },
        400,
      );
    const answer = pages.action(thing, parsed.data);
    return answer ? json(answer.body, answer.status) : null;
  }
  if (req.method !== 'GET') return null;
  const page = pages.page(thing);
  return page ? json(page) : null;
}
