/**
 * People's photos in the fixture worlds (contracts CT-265, docs/decisions/person-avatars.md PA-07): `me.setAvatar`
 * (`PUT /me/avatar`) answered as the runtime does — the bytes sniffed (JPEG, PNG or WebP), at most `AVATAR_MAX_BYTES`,
 * a `ProfileResponse` back — and every person in every answer carrying their `avatarUrl`. The fixture world (legacy
 * mode, `<img>` loads the URL itself) keeps the photo as an object URL; the fake managed world stores it as an
 * attachment its session streams (`world.ts`), with this module's checks and decoration.
 */
import { AVATAR_MAX_BYTES, type Person, type ProfileResponse } from '@whombat/core';
import { mara } from '@whombat/fixtures';

type PhotoType = 'image/jpeg' | 'image/png' | 'image/webp';

/** The photo's type from its first bytes (never the name or a declared type; SVG never). */
export function sniffPhotoType(bytes: Uint8Array): PhotoType | null {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function fromBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A `me.setAvatar` body checked as the runtime checks it: the photo, nothing (remove), or why it is refused. */
export function readPhotoBody(
  body: unknown,
): { image: null } | { image: { bytes: Uint8Array; type: PhotoType; base64: string } } | { refused: string } {
  const image = (body as { image?: unknown } | null)?.image;
  if (image === null) return { image: null };
  if (typeof image !== 'string') return { refused: 'Send a photo or null.' };
  const bytes = fromBase64(image);
  if (!bytes) return { refused: 'That photo isn’t valid base64.' };
  if (bytes.byteLength > AVATAR_MAX_BYTES) return { refused: 'That photo is too large.' };
  const type = sniffPhotoType(bytes);
  if (!type) return { refused: 'That photo isn’t a JPEG, PNG or WebP.' };
  return { image: { bytes, type, base64: image } };
}

/** The refusal as the contract's error body. */
export function photoRefusal(message: string): { status: number; body: unknown } {
  return {
    status: 400,
    body: { error: { code: 'validation_failed', message, fields: { image: [message] } } },
  };
}

/** Puts each person's photo on every person object in `body` (bootstrap, members, messages' authors, profiles…). */
export function withPhotos<T>(body: T, photos: ReadonlyMap<string, string>): T {
  if (photos.size === 0) return body;
  const seen = new Set<object>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === 'person' && typeof record.id === 'string' && photos.has(record.id))
      record.avatarUrl = photos.get(record.id);
    for (const child of Object.values(record)) walk(child);
  };
  walk(body);
  return body;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Where the fixture world keeps a photo: an object URL in the browser (`Person.avatarUrl` is at most 300 characters,
 * like the runtime's attachment URLs), a `data:` URL where it can't make one (tests under jsdom).
 */
function photoUrl(image: { bytes: Uint8Array; type: PhotoType; base64: string }): string {
  try {
    return URL.createObjectURL(new Blob([image.bytes as BlobPart], { type: image.type }));
  } catch {
    return `data:${image.type};base64,${image.base64}`;
  }
}

/**
 * The fixture world's photos (legacy mode): Mara (the viewer) sets or removes hers; the photo is an object URL, which
 * an `<img>` loads without a server.
 */
export function createAvatarFixtures(account: ProfileResponse['account']) {
  const photos = new Map<string, string>();
  const viewer = (): Person => {
    const url = photos.get(mara.id);
    return { ...mara, ...(url ? { avatarUrl: url } : { avatarUrl: null }) };
  };
  return {
    photos,
    /** `PUT /me/avatar`, or null for anything else. */
    async handle(req: Request): Promise<Response | null> {
      const url = new URL(req.url, 'http://fixtures.local');
      if (req.method !== 'PUT' || url.pathname.replace(/^\/api\/v1/, '') !== '/me/avatar') return null;
      const read = readPhotoBody(await req.json().catch(() => null));
      if ('refused' in read) {
        const r = photoRefusal(read.refused);
        return json(r.body, r.status);
      }
      const before = photos.get(mara.id);
      if (before?.startsWith('blob:')) URL.revokeObjectURL(before);
      if (read.image) photos.set(mara.id, photoUrl(read.image));
      else photos.delete(mara.id);
      const profile: ProfileResponse = { account, people: [viewer()] };
      return json(profile);
    },
    /** Every JSON answer with the photos on its people. */
    async decorate(res: Response): Promise<Response> {
      if (photos.size === 0 || !res.headers.get('content-type')?.includes('application/json')) return res;
      const body = withPhotos(await res.json(), photos);
      return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
    },
  };
}
