/** Pure parts of Whombat Feedback intake: sanitizing, the idempotency hash, strict base64 and the image pipeline. */
import { DEFAULT_FEEDBACK_LIMITS, FeedbackIntegrationSettings, FeedbackSubmission } from '@whombat/core';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  GIF,
  interlacedPng,
  makeJpeg,
  pngClaiming,
  pngWithMetadata,
  SITE_ORIGIN,
  SVG,
  submission,
} from '../test/feedback';
import { makePng } from '../test/files';
import { FeedbackPublicFailure } from './errors';
import { ImageJobError, ImagePool } from './image-pool';
import { checkInterlacedPng, decodeScreenshots, pngThroughIend, processScreenshots } from './images';
import { normalizeSubmission } from './intake';
import { checkStructure, SUBMISSION_BOUNDS, scanJsonShape } from './structure';
import { bodyCapOf } from './submission';

const settings = FeedbackIntegrationSettings.parse({
  name: 'Lumio',
  productLabel: 'Lumio',
  allowedOrigins: [SITE_ORIGIN],
  channelId: 'cnv_billing-v2',
  agentId: null,
  repoId: null,
  reportTypes: ['bug', 'feature'],
  contextKeys: ['plan'],
  redactPaths: ['/customers/*'],
});

const limits = { maxAttachments: 3, maxAttachmentBytes: 3 * 1024 * 1024 };

function failure(fn: () => unknown): FeedbackPublicFailure {
  try {
    fn();
  } catch (err) {
    if (err instanceof FeedbackPublicFailure) return err;
    throw err;
  }
  throw new Error('did not fail');
}

describe('normalizeSubmission', () => {
  it('re-sanitizes context and drops contact fields that are off', () => {
    const parsed = FeedbackSubmission.parse(submission());
    const out = normalizeSubmission(parsed, {
      ...settings,
      contactFields: { name: 'off', email: 'optional' },
    });
    expect(out.reporterName).toBeNull();
    expect(out.reporterEmail).toBe('ada@example.com');
    expect(out.context.page?.url).toBe(`${SITE_ORIGIN}/customers/:id/invoices`);
    expect(out.context.custom).toEqual({ plan: 'pro' });
    expect(out.context.references).toEqual(['req_123']);
  });
});

describe('decodeScreenshots', () => {
  it('accepts canonical base64 only', () => {
    const png = makePng(2, 2);
    const ok = decodeScreenshots(
      [{ name: 'a', contentType: 'image/png', data: png.toString('base64') }],
      limits,
    );
    expect(ok[0]?.bytes.equals(png)).toBe(true);
    const bad = failure(() =>
      decodeScreenshots(
        [{ name: 'a', contentType: 'image/png', data: `${png.toString('base64')}\n` }],
        limits,
      ),
    );
    expect(bad.code).toBe('invalid');
    expect(bad.extra.fields).toEqual(['attachments.0.data']);
  });

  it('enforces the count and the byte limit', () => {
    const one = { name: 'a', contentType: 'image/png' as const, data: makePng(2, 2).toString('base64') };
    expect(failure(() => decodeScreenshots([one, one], { ...limits, maxAttachments: 1 })).code).toBe(
      'invalid',
    );
    const big = { ...one, data: Buffer.alloc(100_000).toString('base64') };
    expect(failure(() => decodeScreenshots([big], { ...limits, maxAttachmentBytes: 65_536 })).code).toBe(
      'too_large',
    );
  });
});

describe('processScreenshots', () => {
  const pool = new ImagePool();
  afterAll(() => pool.close());
  const run = (bytes: Buffer, declaredType: 'image/png' | 'image/jpeg') =>
    processScreenshots([{ index: 0, bytes, sha256: 'x', declaredType }], pool);

  it('re-encodes PNG without metadata or trailing bytes', async () => {
    const [out] = await run(pngWithMetadata(makePng(5, 3), 'HIDDEN'), 'image/png');
    expect(out?.name).toBe('screenshot-1.png');
    expect(out?.bytes.includes(Buffer.from('HIDDEN'))).toBe(false);
    expect(PNG.sync.read(out?.bytes as Buffer).width).toBe(5);
  });

  it('re-encodes JPEG without EXIF', async () => {
    const [out] = await run(makeJpeg(10, 10, 'GPS-SECRET'), 'image/jpeg');
    expect(out?.contentType).toBe('image/jpeg');
    expect(out?.bytes.includes(Buffer.from('Exif'))).toBe(false);
    expect(out?.bytes.includes(Buffer.from('GPS-SECRET'))).toBe(false);
  });

  it.each([
    ['SVG', SVG, 'image/png'],
    ['GIF', GIF, 'image/png'],
    ['a bomb header', pngClaiming(makePng(1, 1), 30_000, 30_000), 'image/png'],
    ['a truncated PNG', makePng(30, 30).subarray(0, 50), 'image/png'],
    ['a JPEG declared PNG', makeJpeg(4, 4), 'image/png'],
  ] as const)('refuses %s', async (_what, bytes, type) => {
    await expect(run(bytes, type)).rejects.toMatchObject({
      code: 'unsupported_attachment',
      extra: { fields: ['attachments.0'] },
    });
  });

  it('decodes a real interlaced PNG, refuses an interlaced inflate bomb', async () => {
    // 1×1 Adam7: only the first pass has a pixel (filter byte + RGB).
    const [one] = await run(interlacedPng(1, 1, Buffer.from([0, 10, 20, 30])), 'image/png');
    expect(PNG.sync.read(one?.bytes as Buffer).data.subarray(0, 3)).toEqual(Buffer.from([10, 20, 30]));
    // The cap stops the inflate itself (pngjs would inflate an interlaced PNG without a limit).
    expect(() => checkInterlacedPng(interlacedPng(100, 100, Buffer.alloc(5_000_000)))).toThrow(RangeError);
    expect(() => checkInterlacedPng(interlacedPng(1, 1, Buffer.from([0, 1, 2, 3])))).not.toThrow();
    await expect(run(interlacedPng(100, 100, Buffer.alloc(5_000_000)), 'image/png')).rejects.toMatchObject({
      code: 'unsupported_attachment',
    });
  });

  it('pngThroughIend cuts after IEND and refuses a PNG without one', () => {
    const png = makePng(2, 2);
    expect(pngThroughIend(Buffer.concat([png, Buffer.from('tail')])).equals(png)).toBe(true);
    expect(() => pngThroughIend(png.subarray(0, png.length - 12))).toThrow();
  });
});

describe('the image worker (R1-3)', () => {
  const job = (bytes: Buffer, contentType: 'image/png' | 'image/jpeg' = 'image/png') => {
    const png = PNG.sync.read(bytes);
    return { bytes, contentType, width: png.width, height: png.height, maxPixels: 16_000_000 };
  };
  /** A stand-in worker module (data: URL): what the real one does when it hangs, crashes or can't load. */
  const standIn = (source: string) =>
    new URL(
      `data:text/javascript,${encodeURIComponent(`import { parentPort } from 'node:worker_threads';\n${source}`)}`,
    );

  it('a malformed image fails as unsupported and the worker keeps serving', async () => {
    const pool = new ImagePool();
    try {
      const truncated = { ...job(makePng(4, 4)), bytes: makePng(4, 4).subarray(0, 40) };
      await expect(pool.run(truncated)).rejects.toBeInstanceOf(ImageJobError);
      await expect(pool.run(truncated)).rejects.toMatchObject({ kind: 'unsupported' });
      expect((await pool.run(job(makePng(4, 4)))).width).toBe(4);
      expect(pool.started).toBe(1);
    } finally {
      await pool.close();
    }
  });

  it('a job over the timeout fails as unsupported; the stuck worker is replaced', async () => {
    const pool = new ImagePool({ timeoutMs: 200, url: standIn('parentPort.postMessage({ ready: true });') });
    try {
      const started = Date.now();
      await expect(pool.run(job(makePng(2, 2)))).rejects.toMatchObject({ kind: 'unsupported' });
      expect(Date.now() - started).toBeLessThan(2000);
      await expect(pool.run(job(makePng(2, 2)))).rejects.toMatchObject({ kind: 'unsupported' });
      expect(pool.started).toBe(2);
    } finally {
      await pool.close();
    }
  });

  it('a worker that runs out of its heap fails the job as unsupported, and the server lives on', async () => {
    const hog = `parentPort.postMessage({ ready: true });
parentPort.on('message', () => { const keep = []; for (;;) keep.push(new Array(100000).fill({ x: 1 })); });`;
    const pool = new ImagePool({
      url: standIn(hog),
      resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
    });
    try {
      const heap = process.memoryUsage().heapUsed;
      await expect(pool.run(job(makePng(2, 2)))).rejects.toMatchObject({
        kind: 'unsupported',
        message: expect.stringContaining('ERR_WORKER_OUT_OF_MEMORY'),
      });
      expect(process.memoryUsage().heapUsed - heap).toBeLessThan(64 * 1024 * 1024);
    } finally {
      await pool.close();
    }
  });

  it('a worker that crashes on a job fails it as unsupported; one that cannot load is internal', async () => {
    const crashing = new ImagePool({
      url: standIn(
        "parentPort.postMessage({ ready: true }); parentPort.on('message', () => process.exit(3));",
      ),
    });
    const broken = new ImagePool({ url: standIn("throw new Error('cannot load');") });
    const failures: string[] = [];
    const missing = new ImagePool({
      url: new URL('file:///nonexistent/image-worker.mjs'),
      onWorkerFailure: (info) => failures.push(info.reason),
    });
    try {
      await expect(crashing.run(job(makePng(2, 2)))).rejects.toMatchObject({ kind: 'unsupported' });
      await expect(broken.run(job(makePng(2, 2)))).rejects.toMatchObject({ kind: 'internal' });
      await expect(missing.run(job(makePng(2, 2)))).rejects.toMatchObject({ kind: 'internal' });
      expect(failures).toEqual(['start']);
    } finally {
      await Promise.all([crashing.close(), broken.close(), missing.close()]);
    }
  });

  it('close fails what is waiting; the pool starts a new worker afterwards', async () => {
    const pool = new ImagePool({ url: standIn('parentPort.postMessage({ ready: true });') });
    const waiting = expect(pool.run(job(makePng(2, 2)))).rejects.toMatchObject({ kind: 'internal' });
    await pool.close();
    await waiting;
    const real = new ImagePool();
    try {
      await real.close();
      expect((await real.run(job(makePng(3, 3)))).width).toBe(3);
    } finally {
      await real.close();
    }
  });
});

describe('bodyCapOf', () => {
  it('derives from the attachment limits and never passes the hard cap', () => {
    const base = { ...settings, limits: DEFAULT_FEEDBACK_LIMITS };
    expect(bodyCapOf({ ...base, limits: { ...DEFAULT_FEEDBACK_LIMITS, maxAttachments: 0 } })).toBe(64 * 1024);
    expect(bodyCapOf(base)).toBeGreaterThan(3 * 4 * 1024 * 1024);
    expect(
      bodyCapOf({ ...base, limits: { ...DEFAULT_FEEDBACK_LIMITS, maxAttachmentBytes: 8 * 1024 * 1024 } }),
    ).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});

describe('submission structure bounds (R1-1)', () => {
  const _ordinary = {
    ...submission(),
    attachments: [{ name: 'a.png', contentType: 'image/png', data: 'x'.repeat(4_000_000) }],
  };
  const json = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));

  it('the raw scan counts tokens and depth outside strings only', () => {
    // Commas, brackets and escaped quotes inside strings are text, not structure.
    const text = `{"a":"${'[,{'.repeat(5000)}\\\\\\"]]]]"}`;
    expect(JSON.parse(text)).toBeTruthy();
    expect(scanJsonShape(json(text))).toBe(true);
    expect(scanJsonShape(json(`[${'0,'.repeat(SUBMISSION_BOUNDS.nodes)}0]`))).toBe(false);
    expect(scanJsonShape(json(`${'['.repeat(7)}${']'.repeat(7)}`))).toBe(false);
    expect(scanJsonShape(json(`${'['.repeat(6)}${']'.repeat(6)}`))).toBe(true);
    expect(scanJsonShape(json('{"a":"unterminated'))).toBe(false);
    expect(scanJsonShape(json('{"a":"ends in an escaped quote\\"}'))).toBe(false);
  });

  it('names known arrays over their cap, and the body for anything else', () => {
    expect(checkStructure({ attachments: [1, 2, 3, 4] })).toBe('attachments');
    expect(checkStructure({ context: { references: ['1', '2', '3', '4', '5', '6'] } })).toBe(
      'context.references',
    );
    expect(checkStructure({ context: { custom: { a: new Array(21).fill(0) } } })).toBe('body');
    expect(
      checkStructure({ custom: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`k${i}`, 1])) }),
    ).toBe('body');
    expect(checkStructure({ a: [[[[[[1]]]]]] })).toBe('body');
    expect(checkStructure({ description: 'x'.repeat(10_001) })).toBe('body');
    expect(checkStructure({ ['k'.repeat(10_001)]: 1 })).toBe('body');
    // Only a screenshot's data may be long; the same length elsewhere is refused.
    expect(checkStructure({ attachments: [{ data: 'x'.repeat(20_000) }] })).toBeNull();
    expect(checkStructure({ attachments: [{ name: 'x'.repeat(20_000) }] })).toBe('body');
    expect(
      checkStructure({ attachments: [{ data: 'x'.repeat(SUBMISSION_BOUNDS.attachmentData + 1) }] }),
    ).toBe('body');
  });
});
