/**
 * Drop mode (Whombat `docs/decisions/feedback-drop.md` FD-27, FD-28): the card is verified against the pin before
 * anything renders, Send waits for the loader, a retry sends the identical envelope, every answer of control's drop
 * has its message, screenshots are checked as the runtime checks them, and the frame never touches storage.
 */
import { CONTROL_PREFIX, feedbackDropApi } from '@whombat/control-contracts';
import type { FeedbackSiteCard } from '@whombat/core/domain';
import { FEEDBACK_IMAGE_MAX_PIXELS, FEEDBACK_IMAGE_MAX_SIDE } from '@whombat/core/domain';
import { WIDGET_ATTRIBUTES } from '@whombat/core/feedback';
import {
  dropEnvelopeCap,
  FEEDBACK_DROP_SUITE,
  FEEDBACK_SITE_KEY_PATTERN,
  feedbackReferenceFor,
  generateDropKeyPair,
  generateSiteSigningKey,
  openDropEnvelope,
  signSiteCard,
} from '@whombat/core/feedback/drop';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTRS, type FrameMessage, SITE_KEY } from '../shared/protocol';
import { WIDGET_VERSION } from '../version';
import { FrameApp } from './app';
import type { FrameParams } from './bridge';
import { ancestorOriginsOf, cardPath, controlOrigin, dropPath, loadCard, postDrop } from './drop';
import { CONFIG, CONTEXT } from './fixtures';
import { IMAGE_MAX_PIXELS, IMAGE_MAX_SIDE } from './images';
import type { FetchLike } from './submit';

const SITE = 'fbs_abcdefghijklmnopqrstuvwx';
const PARENT = 'https://shop.example.com';
const CONTROL = 'https://api.whombat.example';
const signing = generateSiteSigningKey();
const other = generateSiteSigningKey();
const encryption = generateDropKeyPair();

function card(over: Partial<FeedbackSiteCard> = {}): FeedbackSiteCard {
  return {
    purpose: 'whombat-feedback-site-card',
    v: 1,
    site: SITE,
    seq: 17,
    issuedAt: 1_790_467_200,
    expiresAt: 1_790_467_200 + 14 * 86_400,
    allowedOrigins: [PARENT],
    config: CONFIG,
    limits: {
      maxEnvelopeBytes: dropEnvelopeCap(4 * 1024 * 1024),
      reportsPerHour: 30,
      reportsPerDay: 200,
      perSourcePerHour: 5,
    },
    encryption: { suite: FEEDBACK_DROP_SUITE, kid: encryption.kid, publicKey: encryption.publicKeyB64 },
    signingKey: signing.publicKey,
    ...over,
  } as FeedbackSiteCard;
}

const signed = (c = card(), seed = signing.seed) => signSiteCard(c, seed);

const params: FrameParams = {
  site: SITE,
  parent: PARENT,
  theme: 'auto',
  instance: 'AAAAAAAAAAAAAAAAAAAAAA',
  key: signing.fingerprint,
};

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | 'network';

interface Drop {
  url: string;
  init: RequestInit;
  bytes: Uint8Array;
}

let cardAnswer: Answer;
let answers: Answer[];
let drops: Drop[];
let requests: { url: string; init: RequestInit }[];
let posted: FrameMessage[];
let app: FrameApp;

function respond(a: Answer): Response {
  if (a === 'network') throw new TypeError('Failed to fetch');
  return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
    status: a.status,
    headers: { 'content-type': 'application/json', ...a.headers },
  });
}

const TOKEN = `fbrs_${'D'.repeat(43)}`;

const fetchMock: FetchLike = async (url, init) => {
  requests.push({ url, init });
  if (url.endsWith('/card')) return respond(cardAnswer);
  if (url.endsWith('/reporter/code')) return respond({ status: 202, body: { ok: true } });
  if (url.endsWith('/reporter/session'))
    return init.method === 'DELETE'
      ? respond({ status: 204 })
      : respond({
          status: 200,
          body: { token: TOKEN, email: 'ann@example.com', expiresAt: '2099-01-01T00:00:00.000Z' },
        });
  if (url.endsWith('/reporter/reports'))
    return respond({ status: 200, body: { email: 'ann@example.com', reports: [] } });
  drops.push({ url, init, bytes: new Uint8Array(init.body as Uint8Array) });
  return respond(answers.shift() ?? { status: 202, body: { receivedAt: '2026-09-27T10:15:02.114Z' } });
};

async function start(
  over: { params?: Partial<FrameParams>; ancestors?: string[] | null; control?: string | null } = {},
): Promise<FrameApp> {
  const root = document.createElement('div');
  document.body.append(root);
  app = new FrameApp({
    params: { ...params, ...over.params },
    bridge: { post: (m) => posted.push(m), close() {} },
    fetch: fetchMock,
    baseUrl: 'https://embed.whombat.example/embed/v1/frame.html?site=x',
    root,
    drop: {
      control: over.control === undefined ? CONTROL : over.control,
      ancestorOrigins: over.ancestors === undefined ? [PARENT] : over.ancestors,
    },
  });
  await app.load();
  return app;
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel) as T;
function type(sel: string, value: string) {
  const el = $<HTMLInputElement | HTMLTextAreaElement>(sel);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const send = () => $<HTMLButtonElement>('.foot button[type=submit]');

async function openFrom(origin = PARENT) {
  app.handle({ type: 'open', payload: { context: CONTEXT } }, origin);
}

async function plaintextOf(bytes: Uint8Array) {
  const opened = await openDropEnvelope(
    bytes,
    (kid) => (kid === encryption.kid ? encryption.privateKey : null),
    { site: SITE },
  );
  return JSON.parse(opened.plaintextJson);
}

beforeEach(() => {
  cardAnswer = { status: 200, body: signed() };
  answers = [];
  drops = [];
  requests = [];
  posted = [];
  URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
  vi.restoreAllMocks();
});

describe('the contracts the frame repeats without Zod', () => {
  it('paths, the key pattern, the attribute and the image limits equal the contracts', () => {
    expect(`${CONTROL_PREFIX}${feedbackDropApi.card.path}`.replace(':site', SITE)).toBe(cardPath(SITE));
    expect(`${CONTROL_PREFIX}${feedbackDropApi.drop.path}`.replace(':site', SITE)).toBe(dropPath(SITE));
    expect(SITE_KEY.source).toBe(FEEDBACK_SITE_KEY_PATTERN.source);
    expect(ATTRS.key).toBe(WIDGET_ATTRIBUTES.key);
    expect(IMAGE_MAX_SIDE).toBe(FEEDBACK_IMAGE_MAX_SIDE);
    expect(IMAGE_MAX_PIXELS).toBe(FEEDBACK_IMAGE_MAX_PIXELS);
  });

  it('reads control’s origin from frame.html and the ancestors from location', () => {
    expect(controlOrigin(document)).toBeNull();
    const meta = document.createElement('meta');
    meta.name = 'whombat-control';
    meta.content = 'https://api.whombat.example';
    document.head.append(meta);
    expect(controlOrigin(document)).toBe('https://api.whombat.example');
    meta.content = 'http://api.whombat.example';
    expect(controlOrigin(document)).toBeNull();
    expect(ancestorOriginsOf({})).toBeNull();
    const nine = Array.from({ length: 9 }, (_, i) => `https://a${i}.example`);
    expect(ancestorOriginsOf({ ancestorOrigins: nine })).toEqual(nine.slice(0, 8));
  });
});

describe('the card (FD-28 (1), (2))', () => {
  it('is fetched from control without credentials, referrer or redirects, and verified against the pin', async () => {
    const loaded = await loadCard(fetchMock, params, { control: CONTROL, ancestorOrigins: [PARENT] });
    expect(loaded?.card.seq).toBe(17);
    expect(loaded?.config.productLabel).toBe('Shop');
    expect(requests[0]?.url).toBe(`${CONTROL}/v1/feedback/sites/${SITE}/card`);
    expect(requests[0]?.init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  });

  const failures: [string, () => void, Parameters<typeof start>[0]?][] = [
    [
      'another signing key (not the pinned one)',
      () => (cardAnswer = { status: 200, body: signed(card({ signingKey: other.publicKey }), other.seed) }),
    ],
    [
      'a bad signature',
      () => {
        const s = signed();
        cardAnswer = { status: 200, body: { ...s, card: { ...s.card, seq: 18 } } };
      },
    ],
    [
      'a card for another site',
      () => (cardAnswer = { status: 200, body: signed(card({ site: 'fbs_zzzzzzzzzzzzzzzzzzzzzzzz' })) }),
    ],
    [
      'a parent the card doesn’t allow',
      () =>
        (cardAnswer = { status: 200, body: signed(card({ allowedOrigins: ['https://other.example.com'] })) }),
    ],
    ['an ancestor that isn’t the parent', () => {}, { ancestors: ['https://evil.example.com', PARENT] }],
    [
      'a config the frame can’t show',
      () => (cardAnswer = { status: 200, body: signed(card({ config: { ...CONFIG, reportTypes: [] } })) }),
    ],
    [
      'no card (404)',
      () => (cardAnswer = { status: 404, body: { error: { code: 'unavailable', message: 'x' } } }),
    ],
    ['control unreachable', () => (cardAnswer = 'network')],
    ['a frame.html without control’s origin', () => {}, { control: null }],
  ];
  for (const [name, arrange, over] of failures)
    it(`${name} → unavailable, nothing rendered or sent`, async () => {
      arrange();
      await start(over);
      expect(app.view).toBe('unavailable');
      expect(document.querySelector('form')).toBeNull();
      expect($('.notice').textContent).toBe('Feedback isn’t available on this site right now.');
      expect(posted).toContainEqual({ type: 'unavailable', payload: {} });
      expect(drops).toHaveLength(0);
    });

  it('browsers without ancestorOrigins rely on the card and the bridge', async () => {
    await start({ ancestors: null });
    expect(app.view).toBe('form');
  });
});

describe('sending (FD-28 (3), (5), (6))', () => {
  async function fill() {
    await start();
    type('#wb-description', 'The invoice total is wrong');
  }

  it('keeps Send disabled until the loader’s message arrived', async () => {
    await fill();
    expect(send().disabled).toBe(true);
    expect(await app.submit()).toBeNull();
    expect(drops).toHaveLength(0);
    await openFrom();
    expect(send().disabled).toBe(false);
    expect(app.bridgeOrigin).toBe(PARENT);
  });

  it('seals the submission with the frame’s evidence and shows the derived reference', async () => {
    await fill();
    await openFrom();
    const outcome = await app.submit();
    expect(outcome?.kind).toBe('received');
    expect(drops).toHaveLength(1);
    const drop = drops[0] as Drop;
    expect(drop.url).toBe(`${CONTROL}/v1/feedback/sites/${SITE}/drops`);
    expect(drop.init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      credentials: 'omit',
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    const pt = await plaintextOf(drop.bytes);
    expect(pt.v).toBe(1);
    expect(pt.frame).toEqual({
      bridgeOrigin: PARENT,
      ancestorOrigins: [PARENT],
      widget: WIDGET_VERSION,
      cardSeq: 17,
    });
    expect(pt.submission).toMatchObject({
      parentOrigin: PARENT,
      type: 'bug',
      description: 'The invoice total is wrong',
      context: { custom: { plan: 'pro' } },
    });
    const reference = feedbackReferenceFor(SITE, pt.submission.submissionId);
    expect(app.view).toBe('receipt');
    expect($('#wb-reference').textContent).toBe(reference);
    expect(posted).toContainEqual({ type: 'submitted', payload: { reference } });
    // Nothing but the envelope went to control: no plaintext in the request.
    expect(new TextDecoder().decode(drop.bytes)).not.toContain('invoice');
  });

  it('a retry resends the identical bytes; an edit seals a new report with a new id', async () => {
    await fill();
    await openFrom();
    answers = [
      { status: 500, body: {} },
      'network',
      { status: 200, body: { receivedAt: '2026-09-27T10:00:00Z' } },
    ];
    await app.submit();
    const id = app.submitter.submissionId;
    await app.submit();
    await app.submit();
    expect(drops).toHaveLength(3);
    expect(drops[1]?.bytes).toEqual(drops[0]?.bytes);
    expect(drops[2]?.bytes).toEqual(drops[0]?.bytes);
    expect(app.view).toBe('receipt');
    expect($('#wb-reference').textContent).toBe(feedbackReferenceFor(SITE, id));

    app.startNewDraft(false);
    type('#wb-description', 'First version');
    answers = [{ status: 500, body: {} }];
    await app.submit();
    const first = app.submitter.submissionId;
    type('#wb-description', 'Second version');
    await app.submit();
    expect(app.submitter.submissionId).not.toBe(first);
    expect(drops[4]?.bytes).not.toEqual(drops[3]?.bytes);
    expect((await plaintextOf(drops[4]?.bytes as Uint8Array)).submission.description).toBe('Second version');
  });

  const statuses: [string, Answer, string][] = [
    [
      '404',
      { status: 404, body: { error: { code: 'unavailable', message: 'x' } } },
      'Feedback isn’t available on this site right now.',
    ],
    [
      '413',
      { status: 413, body: { error: { code: 'too_large', message: 'x' } } },
      'The screenshots are too large to send together. Remove one and try again.',
    ],
    [
      '429 (body)',
      { status: 429, body: { error: { code: 'rate_limited', message: 'x', retryAfter: 120 } } },
      'Too many reports were sent from here recently. Try again in 2 minutes.',
    ],
    [
      '429 (header)',
      { status: 429, body: {}, headers: { 'retry-after': '30' } },
      'Too many reports were sent from here recently. Try again in a minute.',
    ],
    [
      '400',
      { status: 400, body: { error: { code: 'invalid', message: 'x' } } },
      'Something went wrong on our side, so your report wasn’t sent. Please try again.',
    ],
    [
      '500',
      { status: 500, body: {} },
      'Something went wrong on our side, so your report wasn’t sent. Please try again.',
    ],
    [
      'a 202 without a receipt',
      { status: 202, body: { nope: 1 } },
      'Something went wrong on our side, so your report wasn’t sent. Please try again.',
    ],
    ['no answer', 'network', 'Your report wasn’t sent. Check your connection and try again.'],
  ];
  for (const [name, answer, message] of statuses)
    it(`${name} → “${message}”`, async () => {
      await fill();
      await openFrom();
      answers = [answer];
      await app.submit();
      expect(app.view).toBe('form');
      expect($('.alert').textContent).toContain(message);
    });

  it('an envelope over the card’s limit is refused without a request', async () => {
    cardAnswer = {
      status: 200,
      body: signed(card({ limits: { ...card().limits, maxEnvelopeBytes: 4100 } })),
    };
    await fill();
    await openFrom();
    type('#wb-description', 'x'.repeat(40));
    await app.submit();
    expect(drops).toHaveLength(0);
    expect($('.alert').textContent).toContain('too large to send together');
  });
});

/** A PNG header with the given dimensions (signature and IHDR; enough for the header check). */
function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

describe('screenshots (FD-28 (4))', () => {
  it('sends a valid one and refuses what the runtime would refuse, naming the file', async () => {
    await start();
    await openFrom();
    type('#wb-description', 'See the screenshot');
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 10, 0, 20, 3]);
    app.addChosen([
      new File([png(20, 10)], 'ok.png', { type: 'image/png' }),
      new File([jpeg], 'really-a-jpeg.png', { type: 'image/png' }),
    ]);
    await app.submit();
    expect(drops).toHaveLength(0);
    expect(app.errors['attachments.1']).toMatch(/couldn’t be used/);
    expect(app.errors['attachments.0']).toBeUndefined();
    expect($('.alert').textContent).toContain('One screenshot couldn’t be used. Remove it and try again.');
    app.removeFile(app.values.files[1]?.key as string);
    app.addChosen([new File([png(9000, 10)], 'wide.png', { type: 'image/png' })]);
    await app.submit();
    expect(drops).toHaveLength(0);
    expect(app.errors['attachments.1']).toBeDefined();
    app.removeFile(app.values.files[1]?.key as string);
    await app.submit();
    expect(drops).toHaveLength(1);
    const pt = await plaintextOf(drops[0]?.bytes as Uint8Array);
    expect(pt.submission.attachments).toEqual([
      { name: 'ok.png', contentType: 'image/png', data: Buffer.from(png(20, 10)).toString('base64') },
    ]);
  });
});

describe('storage (FD-28 (7))', () => {
  it('without sign-in, a whole drop, retries and a second report included, never touches cookies or storage', async () => {
    const touched: string[] = [];
    const trap = (target: object, name: string) => {
      const owner = Object.getOwnPropertyDescriptor(target, name) ? target : Object.getPrototypeOf(target);
      const original = Object.getOwnPropertyDescriptor(owner, name);
      Object.defineProperty(target, name, {
        configurable: true,
        get() {
          touched.push(name);
          throw new Error(`the frame used ${name}`);
        },
        set() {
          touched.push(name);
          throw new Error(`the frame used ${name}`);
        },
      });
      return () => {
        if (owner === target && original) Object.defineProperty(target, name, original);
        else delete (target as Record<string, unknown>)[name];
      };
    };
    const restore = [
      trap(window, 'localStorage'),
      trap(window, 'sessionStorage'),
      trap(window, 'indexedDB'),
      trap(window, 'caches'),
      trap(document, 'cookie'),
      trap(navigator, 'serviceWorker'),
    ];
    try {
      // The traps work: any use fails the test.
      for (const use of [
        () => window.localStorage,
        () => window.sessionStorage,
        () => window.indexedDB,
        () => document.cookie,
      ])
        expect(use).toThrow(/the frame used/);
      touched.length = 0;
      await start();
      await openFrom();
      type('#wb-description', 'Nothing stored');
      app.addChosen([new File([png(4, 4)], 'a.png', { type: 'image/png' })]);
      answers = ['network'];
      await app.submit();
      await app.submit();
      app.startNewDraft(false);
      type('#wb-description', 'Again');
      await app.submit();
      expect(drops).toHaveLength(3);
    } finally {
      for (const r of restore) r();
    }
    expect(touched).toEqual([]);
  });
});

describe('reporter sign-in in drop mode (CT-164, AP-429)', () => {
  it('uses control’s routes with CORS, attests the drop with the bearer and stores one key from one module', async () => {
    const touched: string[] = [];
    const keys = new Set<string>();
    const fromOutside: string[] = [];
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => {
        keys.add(k);
        return store.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        keys.add(k);
        store.set(k, v);
      },
      removeItem: (k: string) => {
        keys.add(k);
        store.delete(k);
      },
    };
    const define = (target: object, name: string, get: () => unknown) => {
      const own = Object.getOwnPropertyDescriptor(target, name);
      Object.defineProperty(target, name, { configurable: true, get, set: get });
      return () => {
        if (own) Object.defineProperty(target, name, own);
        else delete (target as Record<string, unknown>)[name];
      };
    };
    const banned = (name: string) => () => {
      touched.push(name);
      throw new Error(`the frame used ${name}`);
    };
    const restore = [
      define(window, 'localStorage', () => {
        const stack = new Error().stack ?? '';
        if (!stack.includes('reporter-store')) fromOutside.push(stack.split('\n')[2] ?? '');
        return fake;
      }),
      define(window, 'sessionStorage', banned('sessionStorage')),
      define(window, 'indexedDB', banned('indexedDB')),
      define(window, 'caches', banned('caches')),
      define(document, 'cookie', banned('cookie')),
      define(navigator, 'serviceWorker', banned('serviceWorker')),
    ];
    const flush = async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    };
    try {
      cardAnswer = {
        status: 200,
        body: signed(card({ config: { ...CONFIG, reporters: true, trail: true } })),
      };
      await start();
      await openFrom();
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent === 'Sign in to follow your reports')
        ?.click();
      type('#wb-signin-email', 'ann@example.com');
      $<HTMLFormElement>('#wb-signin').requestSubmit();
      await flush();
      type('#wb-signin-code', '123456');
      $<HTMLFormElement>('#wb-signin').requestSubmit();
      await flush();
      expect(app.session?.token).toBe(TOKEN);
      type('#wb-description', 'Signed in');
      await app.submit();
      await app.showReports();
      await app.signOut();
    } finally {
      for (const r of restore) r();
    }
    expect(touched).toEqual([]);
    expect(fromOutside).toEqual([]);
    expect([...keys]).toEqual([`whombat-feedback:${SITE}`]);
    const byPath = (end: string) => requests.filter((r) => r.url.endsWith(end));
    expect(byPath('/reporter/code')[0]?.url).toBe(`${CONTROL}/v1/feedback/sites/${SITE}/reporter/code`);
    for (const r of [
      ...byPath('/reporter/code'),
      ...byPath('/reporter/session'),
      ...byPath('/reporter/reports'),
    ])
      expect(r.init).toMatchObject({ mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(byPath('/reporter/reports')[0]?.init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(byPath('/reporter/session').map((r) => r.init.method)).toEqual(['POST', 'DELETE']);
    expect(drops).toHaveLength(1);
    expect(drops[0]?.init.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      authorization: `Bearer ${TOKEN}`,
    });
    const pt = await plaintextOf(drops[0]?.bytes as Uint8Array);
    expect(pt.submission.reporter.email).toBe('ann@example.com');
  });
});

describe('postDrop', () => {
  it('sends the bytes as they are', async () => {
    const envelope = new Uint8Array([1, 2, 3]);
    const outcome = await postDrop(fetchMock, `${CONTROL}${dropPath(SITE)}`, {
      envelope,
      reference: 'FB-AAAA-AAAA',
    });
    expect(outcome).toEqual({
      kind: 'received',
      receipt: { reference: 'FB-AAAA-AAAA', receivedAt: '2026-09-27T10:15:02.114Z' },
    });
    expect(drops[0]?.bytes).toEqual(envelope);
  });
});
