/**
 * GitHub owners' pictures for the Automations list (docs/decisions/automation-list.md AL-S05…AL-S08, contracts CT-328
 * `github.avatar`): the Whombat fetches them, never the browser or the phone (the strict CSP, offline boxes), and passes
 * them on as `data:` URLs.
 *
 * - `fetchOwnerAvatar`: an unauthenticated GET of `https://github.com/<owner>.png?size=<n>` — pictures are public, so it
 *   works without anyone's GitHub sign-in —, following redirects only to `https://avatars.githubusercontent.com/`,
 *   5 s for all of it, reading no more than `GITHUB_AVATAR_MAX_BYTES`.
 * - `avatarDataUrl`: PNG, JPEG, GIF or WebP by their magic numbers, never by what the server says (so never SVG).
 * - `OwnerAvatars`: kept in memory per owner (lowercase), a picture for a day and a miss for an hour, one fetch per owner
 *   at a time, the oldest out past 500 owners. A cache, not a domain write: nothing reaches the database.
 */
import { GITHUB_AVATAR_MAX_BYTES, GitHubLogin } from '@whombat/core';
import { type GhAvatar, GitHubError } from './adapter';

/** How long a picture is kept. */
export const AVATAR_HIT_MS = 24 * 60 * 60_000;
/** How long an owner without one (or a fetch that failed) is left alone. */
export const AVATAR_MISS_MS = 60 * 60_000;
/** Owners kept at most; the oldest kept goes first. */
export const AVATAR_CACHE_OWNERS = 500;
/** The only place a redirect may lead. */
export const GITHUB_AVATARS_ORIGIN = 'https://avatars.githubusercontent.com';
const AVATAR_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

export type AvatarType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** What the bytes are, by their magic numbers; null for anything else (SVG, HTML, an empty answer). */
export function sniffImage(bytes: Uint8Array): AvatarType | null {
  const has = (signature: readonly number[], at = 0) => signature.every((b, i) => bytes[at + i] === b);
  if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (has([0xff, 0xd8, 0xff])) return 'image/jpeg';
  // GIF87a, GIF89a.
  if (has([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61)
    return 'image/gif';
  // RIFF….WEBP
  if (has([0x52, 0x49, 0x46, 0x46]) && has([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/** The picture as `github.avatar` answers it: a `data:` URL of a raster image within the limit, else null. */
export function avatarDataUrl(picture: GhAvatar | null): string | null {
  if (!picture || picture.bytes.byteLength > GITHUB_AVATAR_MAX_BYTES) return null;
  const type = sniffImage(picture.bytes);
  return type ? `data:${type};base64,${Buffer.from(picture.bytes).toString('base64')}` : null;
}

/** Whether a redirect may be followed: https on GitHub's avatar host, its default port, no credentials. */
export function isAvatarUrl(url: URL): boolean {
  return url.origin === GITHUB_AVATARS_ORIGIN && !url.username && !url.password;
}

export interface AvatarFetchOptions {
  /** Tests inject the transport. */
  fetch?: typeof fetch;
  /** `https://github.com` */
  webUrl?: string;
  /** For the whole fetch, redirects and body included. */
  timeoutMs?: number;
}

/** The body, or null once it is larger than `max` (read no further). */
async function readAtMost(res: Response, max: number): Promise<Uint8Array | null> {
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > max) return null;
      parts.push(chunk.value);
    }
    return Buffer.concat(parts);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * An owner's public picture, `size` pixels square, as GitHub sent it. Null when GitHub has none (404), sends it from
 * anywhere but its avatar host, or it is too large; throws when GitHub couldn't be reached in time or answered with an
 * error.
 */
export async function fetchOwnerAvatar(
  owner: string,
  size: number,
  options: AvatarFetchOptions = {},
): Promise<GhAvatar | null> {
  // It becomes part of a URL.
  if (!GitHubLogin.safeParse(owner).success) return null;
  const fetchImpl = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? AVATAR_TIMEOUT_MS);
  let url = new URL(`${(options.webUrl ?? 'https://github.com').replace(/\/$/, '')}/${owner}.png`);
  url.searchParams.set('size', String(size));
  for (let hops = 0; ; hops++) {
    const res = await fetchImpl(url, {
      redirect: 'manual',
      signal,
      headers: { accept: 'image/png, image/jpeg, image/gif, image/webp', 'user-agent': 'whombat-server' },
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const location = res.headers.get('location');
      const next = location && URL.canParse(location, url) ? new URL(location, url) : null;
      if (!next || !isAvatarUrl(next) || hops >= MAX_REDIRECTS) return null;
      url = next;
      continue;
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new GitHubError(`GitHub answered ${res.status} for ${owner}’s picture.`, res.status);
    }
    const bytes = await readAtMost(res, GITHUB_AVATAR_MAX_BYTES);
    return bytes ? { contentType: res.headers.get('content-type') ?? '', bytes } : null;
  }
}

export interface OwnerAvatarsOptions {
  /** Epoch ms (the services' clock). */
  clock?: () => number;
  maxOwners?: number;
  /** A fetch that failed: it counts as a miss. */
  onError?: (err: unknown, owner: string) => void;
}

/** Owners' pictures as `data:` URLs, kept in memory (AL-S07). */
export class OwnerAvatars {
  private readonly kept = new Map<string, { image: string | null; until: number }>();
  private readonly loading = new Map<string, Promise<string | null>>();
  private readonly clock: () => number;

  constructor(
    private readonly load: (owner: string) => Promise<GhAvatar | null>,
    private readonly options: OwnerAvatarsOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
  }

  /** How many owners are kept (tests). */
  get size(): number {
    return this.kept.size;
  }

  /** The owner's picture, or null (none, unreachable, unusable). Concurrent asks for one owner share one fetch. */
  async image(owner: string): Promise<string | null> {
    const key = owner.toLowerCase();
    const kept = this.kept.get(key);
    if (kept && kept.until > this.clock()) return kept.image;
    let loading = this.loading.get(key);
    if (!loading) {
      loading = this.fetch(key).finally(() => this.loading.delete(key));
      this.loading.set(key, loading);
    }
    return loading;
  }

  private async fetch(key: string): Promise<string | null> {
    let image: string | null = null;
    try {
      image = avatarDataUrl(await this.load(key));
    } catch (err) {
      this.options.onError?.(err, key);
    }
    // Kept again as the newest; the oldest kept go first past the bound.
    this.kept.delete(key);
    this.kept.set(key, { image, until: this.clock() + (image ? AVATAR_HIT_MS : AVATAR_MISS_MS) });
    const max = this.options.maxOwners ?? AVATAR_CACHE_OWNERS;
    for (const oldest of this.kept.keys()) {
      if (this.kept.size <= max) break;
      this.kept.delete(oldest);
    }
    return image;
  }
}
