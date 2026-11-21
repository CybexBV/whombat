/**
 * GitHub owners' pictures (automation-list.md AL-S05…AL-S08): raster images by their bytes only, redirects only to
 * GitHub's avatar host, no more than the limit read, and the in-memory cache (a day, an hour, one fetch, bounded). No
 * network: the transport is injected.
 */
import { GITHUB_AVATAR_MAX_BYTES, GitHubAvatar } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { GhAvatar } from './adapter';
import {
  AVATAR_HIT_MS,
  AVATAR_MISS_MS,
  avatarDataUrl,
  fetchOwnerAvatar,
  isAvatarUrl,
  OwnerAvatars,
  sniffImage,
} from './avatar';
import { FAKE_AVATAR_PNG } from './fake';

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => new TextEncoder().encode(s);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const GIF = ascii('GIF89a\x01\x00\x01\x00');
const WEBP = new Uint8Array([...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBPVP8 ')]);
const SVG = ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

describe('what a picture is, by its bytes', () => {
  it('knows PNG, JPEG, GIF and WebP', () => {
    expect(sniffImage(FAKE_AVATAR_PNG)).toBe('image/png');
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(GIF)).toBe('image/gif');
    expect(sniffImage(ascii('GIF87a\x01\x00'))).toBe('image/gif');
    expect(sniffImage(WEBP)).toBe('image/webp');
  });

  it('never SVG, HTML, another RIFF, a cut-off header or nothing', () => {
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(ascii('<!doctype html><html></html>'))).toBeNull();
    expect(sniffImage(new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]))).toBeNull();
    expect(sniffImage(ascii('GIF88a'))).toBeNull();
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });

  it('answers a data URL the contract takes, typed from the bytes and not from what GitHub said', () => {
    const url = avatarDataUrl({ contentType: 'image/svg+xml', bytes: JPEG });
    expect(url).toBe(`data:image/jpeg;base64,${Buffer.from(JPEG).toString('base64')}`);
    expect(
      GitHubAvatar.parse({
        owner: 'octocat',
        image: avatarDataUrl({ contentType: '', bytes: FAKE_AVATAR_PNG }),
      }),
    ).toBeTruthy();
    expect(avatarDataUrl({ contentType: 'image/png', bytes: SVG })).toBeNull();
    expect(avatarDataUrl(null)).toBeNull();
  });

  it('leaves out a picture over the limit, keeps one at it', () => {
    const at = new Uint8Array(GITHUB_AVATAR_MAX_BYTES);
    at.set(FAKE_AVATAR_PNG);
    const url = avatarDataUrl({ contentType: 'image/png', bytes: at });
    expect(url).not.toBeNull();
    expect(GitHubAvatar.safeParse({ owner: 'octocat', image: url }).success).toBe(true);
    const over = new Uint8Array(GITHUB_AVATAR_MAX_BYTES + 1);
    over.set(FAKE_AVATAR_PNG);
    expect(avatarDataUrl({ contentType: 'image/png', bytes: over })).toBeNull();
  });
});

describe('where a redirect may lead', () => {
  it('only https on avatars.githubusercontent.com', () => {
    expect(isAvatarUrl(new URL('https://avatars.githubusercontent.com/u/583231?size=88&v=4'))).toBe(true);
    expect(isAvatarUrl(new URL('https://avatars.githubusercontent.com:443/u/1'))).toBe(true);
    for (const url of [
      'http://avatars.githubusercontent.com/u/1',
      'https://avatars.githubusercontent.com:8443/u/1',
      'https://avatars.githubusercontent.com.evil.example/u/1',
      'https://evil.example/avatars.githubusercontent.com/u/1',
      'https://user:pw@avatars.githubusercontent.com/u/1',
      'https://github.com/octocat.png',
      'https://127.0.0.1/u/1',
    ])
      expect(isAvatarUrl(new URL(url)), url).toBe(false);
  });
});

/** A transport answering by URL, recording what was asked. */
function transport(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    asked.push(url);
    const answer = answers[url];
    if (!answer) throw new TypeError(`fetch failed: ${url}`);
    return answer();
  }) as typeof fetch;
  return { fetchImpl, asked };
}

const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const image =
  (body: Uint8Array, type = 'image/png') =>
  () =>
    new Response(body, { status: 200, headers: { 'content-type': type } });

describe('fetching an owner’s picture', () => {
  const START = 'https://github.com/octocat.png?size=88';
  const AVATAR = 'https://avatars.githubusercontent.com/u/583231?size=88&v=4';

  it('follows GitHub’s redirect to its avatar host', async () => {
    const t = transport({ [START]: redirect(AVATAR), [AVATAR]: image(FAKE_AVATAR_PNG) });
    const got = await fetchOwnerAvatar('octocat', 88, { fetch: t.fetchImpl });
    expect(got?.contentType).toBe('image/png');
    expect(Buffer.from(got?.bytes ?? []).equals(FAKE_AVATAR_PNG)).toBe(true);
    expect(t.asked).toEqual([START, AVATAR]);
  });

  it('refuses a redirect anywhere else, and never fetches it', async () => {
    for (const elsewhere of [
      'https://evil.example/u/1',
      'http://avatars.githubusercontent.com/u/1',
      'https://github.com/login',
      '/login',
    ]) {
      const t = transport({ [START]: redirect(elsewhere), [elsewhere]: image(FAKE_AVATAR_PNG) });
      expect(await fetchOwnerAvatar('octocat', 88, { fetch: t.fetchImpl }), elsewhere).toBeNull();
      expect(t.asked).toEqual([START]);
    }
  });

  it('stops after a few redirects', async () => {
    const hop = (n: number) => `https://avatars.githubusercontent.com/u/${n}`;
    const t = transport({
      [START]: redirect(hop(1)),
      [hop(1)]: redirect(hop(2)),
      [hop(2)]: redirect(hop(3)),
      [hop(3)]: redirect(hop(4)),
      [hop(4)]: image(FAKE_AVATAR_PNG),
    });
    expect(await fetchOwnerAvatar('octocat', 88, { fetch: t.fetchImpl })).toBeNull();
    expect(t.asked).not.toContain(hop(4));
  });

  it('no picture: a 404; GitHub failing or unreachable throws', async () => {
    const missing = transport({ [START]: () => new Response('Not Found', { status: 404 }) });
    expect(await fetchOwnerAvatar('octocat', 88, { fetch: missing.fetchImpl })).toBeNull();
    const failing = transport({ [START]: () => new Response('oops', { status: 503 }) });
    await expect(fetchOwnerAvatar('octocat', 88, { fetch: failing.fetchImpl })).rejects.toThrow(/503/);
    await expect(fetchOwnerAvatar('octocat', 88, { fetch: transport({}).fetchImpl })).rejects.toThrow(
      /fetch failed/,
    );
  });

  it('reads no further than the limit, whether or not the size is said', async () => {
    const big = new Uint8Array(GITHUB_AVATAR_MAX_BYTES + 10);
    big.set(FAKE_AVATAR_PNG);
    const said = transport({
      [START]: () =>
        new Response(big, { status: 200, headers: { 'content-length': String(big.byteLength) } }),
    });
    expect(await fetchOwnerAvatar('octocat', 88, { fetch: said.fetchImpl })).toBeNull();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 100) throw new Error('read on and on');
        controller.enqueue(new Uint8Array(16 * 1024));
      },
    });
    const unsaid = transport({ [START]: () => new Response(stream, { status: 200 }) });
    expect(await fetchOwnerAvatar('octocat', 88, { fetch: unsaid.fetchImpl })).toBeNull();
    expect(pulled).toBeLessThanOrEqual(Math.ceil(GITHUB_AVATAR_MAX_BYTES / (16 * 1024)) + 2);
  });

  it('gives up after the timeout', async () => {
    const hanging = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
      )) as typeof fetch;
    await expect(fetchOwnerAvatar('octocat', 88, { fetch: hanging, timeoutMs: 20 })).rejects.toThrow();
  });

  it('asks only for logins (it is part of the URL)', async () => {
    const t = transport({});
    expect(await fetchOwnerAvatar('../evil', 88, { fetch: t.fetchImpl })).toBeNull();
    expect(t.asked).toEqual([]);
  });
});

describe('the cache of pictures', () => {
  const PNG: GhAvatar = { contentType: 'image/png', bytes: FAKE_AVATAR_PNG };

  function cache(answer: (owner: string) => Promise<GhAvatar | null>, maxOwners?: number) {
    let now = 0;
    const loads: string[] = [];
    const errors: string[] = [];
    const avatars = new OwnerAvatars(
      (owner) => {
        loads.push(owner);
        return answer(owner);
      },
      {
        clock: () => now,
        ...(maxOwners ? { maxOwners } : {}),
        onError: (_err, owner) => errors.push(owner),
      },
    );
    return {
      avatars,
      loads,
      errors,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('keeps a picture for a day, per owner whatever the case', async () => {
    const c = cache(async () => PNG);
    const first = await c.avatars.image('OctoCat');
    expect(first).toMatch(/^data:image\/png;base64,/);
    expect(await c.avatars.image('octocat')).toBe(first);
    c.advance(AVATAR_HIT_MS - 1);
    expect(await c.avatars.image('OCTOCAT')).toBe(first);
    expect(c.loads).toEqual(['octocat']);
    c.advance(1);
    await c.avatars.image('octocat');
    expect(c.loads).toEqual(['octocat', 'octocat']);
  });

  it('keeps a miss and a failure for an hour', async () => {
    let fail = true;
    const c = cache(async (owner) => {
      if (owner === 'down' && fail) throw new Error('offline');
      return owner === 'nopicture' ? null : PNG;
    });
    expect(await c.avatars.image('nopicture')).toBeNull();
    expect(await c.avatars.image('down')).toBeNull();
    expect(c.errors).toEqual(['down']);
    fail = false;
    c.advance(AVATAR_MISS_MS - 1);
    expect(await c.avatars.image('down')).toBeNull();
    expect(c.loads).toEqual(['nopicture', 'down']);
    c.advance(1);
    expect(await c.avatars.image('down')).toMatch(/^data:image\/png/);
    expect(await c.avatars.image('nopicture')).toBeNull();
    expect(c.loads).toEqual(['nopicture', 'down', 'down', 'nopicture']);
  });

  it('shares one fetch between concurrent asks', async () => {
    let release: (v: GhAvatar) => void = () => {};
    const c = cache(() => new Promise<GhAvatar>((resolve) => (release = resolve)));
    const asks = [c.avatars.image('octocat'), c.avatars.image('Octocat'), c.avatars.image('OCTOCAT')];
    release(PNG);
    const [a, b, d] = await Promise.all(asks);
    expect(a).toMatch(/^data:image\/png/);
    expect(b).toBe(a);
    expect(d).toBe(a);
    expect(c.loads).toEqual(['octocat']);
  });

  it('keeps a bounded number of owners, the oldest out first', async () => {
    const c = cache(async () => PNG, 3);
    for (const owner of ['a', 'b', 'c', 'd']) await c.avatars.image(owner);
    expect(c.avatars.size).toBe(3);
    await c.avatars.image('b');
    await c.avatars.image('a');
    expect(c.loads).toEqual(['a', 'b', 'c', 'd', 'a']);
  });
});
