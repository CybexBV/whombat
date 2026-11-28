/**
 * Pictures on thing pages (service-dashboards.md SD-06, SD-S03, SD-S09): signed refs (what they may name, refused when
 * tampered with, expired or signed with another key; one ref per picture per day, a snapshot's every 5 seconds), what is served
 * (JPEG, PNG, WebP by their bytes; large ones made smaller by the worker), the memory cache, and TMDB's public-only rule.
 */
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { ImageJob, ImageRunner } from '../feedback/image-pool';
import { KeyCustody } from '../keys/custody';
import { OutboundError } from '../lib/outbound';
import type { Services } from '../services';
import {
  fromTmdb,
  IMAGE_LARGE_EDGE,
  IMAGE_MAX_EDGE,
  IMAGE_REF_MAX,
  imagePathProblem,
  imageRef,
  largeImageRef,
  type Picture,
  PictureCache,
  pictureFor,
  readImageRef,
  refExpiry,
  servedPicture,
  thingImage,
  useImageFetcherForTests,
  webUrlProblem,
} from './images';

const custody = new KeyCustody(Buffer.alloc(32, 7).toString('base64'));
const services = { custody } as unknown as Services;
const now = new Date('2026-10-21T12:34:56Z');
const row = { id: 'con_sabnzbd_1' };
const ctx = { services, row, now };

function png(width: number, height: number): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(200);
  return PNG.sync.write(image);
}

/** A WebP's header (VP8X) with its size: enough for the sniffer. */
function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

describe('refs (SD-S03)', () => {
  it('names a path on the connection, signed, until the end of the next UTC day', () => {
    const ref = imageRef(ctx, { path: '/library/metadata/12/thumb/1699?width=300' });
    expect(ref.length).toBeLessThanOrEqual(IMAGE_REF_MAX);
    expect(ref).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    const payload = readImageRef(custody, ref, now);
    expect(payload).toMatchObject({ c: row.id, s: 'c', p: '/library/metadata/12/thumb/1699?width=300' });
    expect(payload?.w).toBeUndefined();
    expect(readImageRef(custody, ref, new Date(now.getTime() + 23 * 3600_000))).not.toBeNull();
    expect(readImageRef(custody, ref, new Date(now.getTime() + 36 * 3600_000))).toBeNull();
  });

  it('keeps one ref per picture all day; a snapshot’s changes every 5 seconds', () => {
    const at = (iso: string) => ({ ...ctx, now: new Date(iso) });
    const ref = (iso: string) => imageRef(at(iso), { path: '/p.jpg' });
    expect(ref('2026-10-21T00:00:01Z')).toBe(ref('2026-10-21T23:59:59Z'));
    expect(ref('2026-10-22T00:00:01Z')).not.toBe(ref('2026-10-21T23:59:59Z'));
    // Good for 24 hours at least, 48 at most.
    expect(refExpiry(new Date('2026-10-21T23:59:59Z'), false) * 1000).toBe(
      Date.parse('2026-10-23T00:00:00Z'),
    );
    const snap = (when: Date) => imageRef({ ...ctx, now: when }, { path: '/snap', snapshot: true });
    expect(snap(new Date(now.getTime() + 6_000))).not.toBe(snap(now));
    expect(readImageRef(custody, snap(now), now)?.w).toBe(0);
    expect(refExpiry(now, true) % 5).toBe(0);
  });

  it('refuses a ref that was changed, signed with another key, or is no ref at all', () => {
    const ref = imageRef(ctx, { path: '/poster.jpg' });
    const [body, sig] = ref.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), p: '/admin' }),
    ).toString('base64url');
    expect(readImageRef(custody, `${forged}.${sig}`, now)).toBeNull();
    expect(readImageRef(custody, `${body}.${sig.slice(0, -2)}AA`, now)).toBeNull();
    const other = new KeyCustody(Buffer.alloc(32, 8).toString('base64'));
    expect(readImageRef(other, ref, now)).toBeNull();
    expect(readImageRef(custody, 'not-a-ref', now)).toBeNull();
    expect(readImageRef(custody, `${body}`, now)).toBeNull();
  });

  it('names a large picture for a photo view, signed like the rest', () => {
    const large = imageRef(ctx, { path: '/api/assets/a1/thumbnail?size=preview', large: true });
    expect(readImageRef(custody, large, now)).toMatchObject({
      c: row.id,
      p: '/api/assets/a1/thumbnail?size=preview',
      l: 1,
    });
    // Asking for the large one by changing a page's ref breaks its signature.
    const small = imageRef(ctx, { path: '/p.jpg' });
    const [body, sig] = small.split('.') as [string, string];
    const bigger = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), l: 1 }),
    ).toString('base64url');
    expect(readImageRef(custody, `${bigger}.${sig}`, now)).toBeNull();
    // Only the runtime makes one, from a good ref: the same picture, the same day.
    const made = largeImageRef(custody, small, now);
    expect(readImageRef(custody, made, now)).toEqual({ ...readImageRef(custody, small, now), l: 1 });
    expect(largeImageRef(custody, made, now)).toBe(made);
    expect(largeImageRef(custody, `${bigger}.${sig}`, now)).toBe('');
    expect(largeImageRef(custody, small, new Date(now.getTime() + 3 * 86_400_000))).toBe('');
    // A camera's snapshot stays one.
    const snap = imageRef(ctx, { path: '/snap', snapshot: true, large: true });
    expect(readImageRef(custody, snap, now)?.l).toBeUndefined();
    expect(largeImageRef(custody, snap, now)).toBe(snap);
  });

  it('names TMDB posters by their file only, and nothing that leaves the connection', () => {
    expect(imagePathProblem('t', '/kqjL17yufvn9OVLyXYpvtyrFfak.jpg')).toBeNull();
    expect(imagePathProblem('t', '/../secret.jpg')).not.toBeNull();
    expect(imagePathProblem('t', 'https://evil.example/x.jpg')).not.toBeNull();
    expect(imagePathProblem('c', '//evil.example/x.jpg')).not.toBeNull();
    expect(imagePathProblem('c', 'http://evil.example/x.jpg')).not.toBeNull();
    expect(imagePathProblem('c', '/a/../../etc/passwd')).not.toBeNull();
    expect(imagePathProblem('c', '/a b')).not.toBeNull();
    expect(imagePathProblem('c', '/a\\b')).not.toBeNull();
    expect(imagePathProblem('c', '/x#frag')).not.toBeNull();
    expect(imagePathProblem('c', '/api/v3/MediaCover/1/poster.jpg?lastWrite=1')).toBeNull();
    expect(imageRef(ctx, { path: 'https://evil.example/x.jpg' })).toBe('');
    expect(imageRef(ctx, { path: `/${'a'.repeat(400)}` })).toBe('');
  });

  it('gives a page’s picture only for a ref', () => {
    expect(thingImage('', 'Dune', 'poster')).toBeUndefined();
    const ref = imageRef(ctx, { path: '/poster.jpg', source: 't' });
    expect(thingImage(ref, 'x'.repeat(200), 'poster')).toMatchObject({ ref, shape: 'poster' });
    expect(thingImage(ref, 'x'.repeat(200), 'poster')?.alt).toHaveLength(120);
  });
});

describe('what is served (SD-S03)', () => {
  const jobs: ImageJob[] = [];
  const runner: ImageRunner = {
    async run(job) {
      jobs.push(job);
      return {
        bytes: png(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE / 2),
        width: IMAGE_MAX_EDGE,
        height: IMAGE_MAX_EDGE / 2,
      };
    },
  };
  const withWorker = { feedback: { images: runner } } as unknown as Services;

  it('keeps a small PNG as it is and makes a large one smaller in the worker', async () => {
    const small = png(100, 150);
    expect(await servedPicture(withWorker, small, false)).toMatchObject({
      contentType: 'image/png',
      bytes: small,
      snapshot: false,
    });
    expect(jobs).toHaveLength(0);
    const large = await servedPicture(withWorker, png(960, 480), true);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      contentType: 'image/png',
      width: 960,
      height: 480,
      thumbnailMaxEdge: 480,
    });
    expect(large).toMatchObject({ contentType: 'image/png', snapshot: true });
  });

  it('makes a large picture 1280 px at most, and keeps one under that as it is', async () => {
    jobs.length = 0;
    const under = png(960, 480);
    expect(await servedPicture(withWorker, under, false, true)).toMatchObject({ bytes: under });
    expect(jobs).toHaveLength(0);
    await servedPicture(withWorker, png(1600, 900), false, true);
    expect(jobs[0]).toMatchObject({ width: 1600, thumbnailMaxEdge: IMAGE_LARGE_EDGE });
  });

  it('keeps a large picture apart from the small one of the same path', async () => {
    jobs.length = 0;
    const kept = {
      custody,
      clock: () => now,
      feedback: { images: runner },
    } as unknown as Services;
    let fetched = 0;
    useImageFetcherForTests(kept, async () => {
      fetched++;
      return png(1600, 900);
    });
    const path = '/api/assets/a1/thumbnail?size=preview';
    const read = (large: boolean) =>
      readImageRef(custody, imageRef(ctx, { path, large }), now) as NonNullable<
        ReturnType<typeof readImageRef>
      >;
    const conn = { id: row.id } as Parameters<typeof pictureFor>[1];
    await pictureFor(kept, conn, read(false));
    await pictureFor(kept, conn, read(true));
    await pictureFor(kept, conn, read(true));
    expect(fetched).toBe(2);
    expect(jobs.map((j) => j.thumbnailMaxEdge)).toEqual([IMAGE_MAX_EDGE, IMAGE_LARGE_EDGE]);
    useImageFetcherForTests(kept, null);
  });

  it('serves a WebP as it came, and nothing that isn’t JPEG, PNG or WebP', async () => {
    expect(await servedPicture(withWorker, webp(1200, 800), false)).toMatchObject({
      contentType: 'image/webp',
    });
    expect(
      await servedPicture(withWorker, Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), false),
    ).toBeNull();
    expect(await servedPicture(withWorker, Buffer.from('<svg xmlns="x"></svg>'), false)).toBeNull();
    expect(await servedPicture(withWorker, Buffer.from('{"error":"nope"}'), false)).toBeNull();
    expect(await servedPicture(withWorker, Buffer.alloc(0), false)).toBeNull();
  });

  it('gives nothing when the worker can’t read it', async () => {
    const broken = {
      feedback: { images: { run: () => Promise.reject(new Error('bad')) } },
    } as unknown as Services;
    expect(await servedPicture(broken, png(900, 900), false)).toBeNull();
  });

  it('asks TMDB only on a public address', async () => {
    await expect(
      fromTmdb('/poster.jpg', { resolve: async () => [{ address: '10.0.0.7', family: 4 }] }),
    ).rejects.toBeInstanceOf(OutboundError);
    expect(await fromTmdb('/../x.jpg')).toBeNull();
  });
});

describe('the memory cache', () => {
  const picture = (n: number): Picture => ({
    bytes: Buffer.alloc(n),
    contentType: 'image/png',
    etag: 'e',
    snapshot: false,
  });

  it('lets the least recently used go first when it is full', () => {
    const cache = new PictureCache(100);
    cache.set('a', picture(40), 0, 60_000);
    cache.set('b', picture(40), 0, 60_000);
    expect(cache.get('a', 1)).toBeTruthy();
    cache.set('c', picture(40), 2, 60_000);
    expect(cache.get('b', 3)).toBeUndefined();
    expect(cache.get('a', 3)).toBeTruthy();
    expect(cache.get('c', 3)).toBeTruthy();
    expect(cache.bytes).toBe(80);
  });

  it('forgets a picture past its time and remembers a failure for its own', () => {
    const cache = new PictureCache();
    cache.set('snap', picture(10), 0, 5_000);
    cache.set('broken', null, 0, 60_000);
    expect(cache.get('snap', 4_000)).toBeTruthy();
    expect(cache.get('snap', 6_000)).toBeUndefined();
    expect(cache.get('broken', 30_000)).toBeNull();
    expect(cache.get('broken', 61_000)).toBeUndefined();
    expect(cache.bytes).toBe(0);
  });

  it('shares one fetch between those who ask at once', async () => {
    const cache = new PictureCache();
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = async () => {
      loads++;
      await gate;
      return picture(5);
    };
    const first = cache.through(
      'k',
      () => 0,
      load,
      () => 60_000,
    );
    const second = cache.through(
      'k',
      () => 0,
      load,
      () => 60_000,
    );
    release();
    expect(await first).toBe(await second);
    expect(loads).toBe(1);
    expect(
      await cache.through(
        'k',
        () => 1,
        load,
        () => 60_000,
      ),
    ).toBeTruthy();
    expect(loads).toBe(1);
  });
});

describe('webUrlProblem', () => {
  it('takes http and https on their standard ports only', () => {
    expect(webUrlProblem('https://example.com/a')).toBeNull();
    expect(webUrlProblem('http://example.com:80/a')).toBeNull();
    expect(webUrlProblem('https://example.com:443/a')).toBeNull();
    expect(webUrlProblem('https://example.com:8443/a')).toMatch(/8443/);
    expect(webUrlProblem('http://example.com:443/a')).toMatch(/443/);
    expect(webUrlProblem('ftp://example.com/a')).toMatch(/ftp/);
    expect(webUrlProblem('https://user:pw@example.com/')).toMatch(/credentials/);
    expect(webUrlProblem('nonsense')).not.toBeNull();
  });
});
