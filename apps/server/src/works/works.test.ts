import { describe, expect, it } from 'vitest';
import { ConnectionAuthError } from '../connections/types';
import { localizePhrase } from '../i18n/phrases';
import { VaultCallError } from '../vault/net';
import { NOT_RUN, WORKS_RUN, WORKS_WATCH, worksCard, worksMeta } from './page';
import { due, failing, fresh, type RunLike, runWords, seconds, worksNotice } from './rules';
import { testOnce } from './run';
import {
  fileFits,
  fileSignature,
  haSensors,
  jellyfinItem,
  jellyfinLibraries,
  newestAsset,
  newestDocument,
  parseDav,
  plexItem,
  plexLibraries,
  type TestAnswer,
  type TestFetch,
  type TestRequest,
} from './tests';

const NOW = new Date('2026-11-28T10:00:00Z');
const row = { baseUrl: 'https://cloud.example.com', fields: { username: 'mara' } };

/** A service's answer: JSON (with its type) for anything but text, the given type for text. */
function answer(status: number, body: unknown = '', type?: string): TestAnswer {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const contentType = type ?? (typeof body === 'string' ? undefined : 'application/json; charset=utf-8');
  return { status, body: Buffer.from(text), headers: contentType ? { 'content-type': contentType } : {} };
}

const LOGIN_PAGE =
  '<!DOCTYPE html><html><head><title>Sign in</title></head><body><form></form></body></html>';

/** A fake service: the first route whose test matches answers; the requests it saw are kept. */
function service(
  routes: [(req: TestRequest) => boolean, (req: TestRequest) => TestAnswer | Promise<TestAnswer>][],
) {
  const seen: TestRequest[] = [];
  const fetch: TestFetch = async (req) => {
    seen.push(req);
    const route = routes.find(([match]) => match(req));
    if (!route) return answer(404);
    return route[1](req);
  };
  return { fetch, seen };
}

const dav = (...entries: ([string, boolean] | [string, boolean, number, string])[]) =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries
    .map(
      ([href, folder, size, type]) =>
        `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${folder ? '<d:collection/>' : ''}</d:resourcetype>${size !== undefined ? `<d:getcontentlength>${size}</d:getcontentlength><d:getcontenttype>${type}</d:getcontenttype>` : ''}</d:prop></d:propstat></d:response>`,
    )
    .join('')}</d:multistatus>`;

const TOP = '/remote.php/dav/files/mara/';

describe('the tests only read', () => {
  it('Nextcloud opens the first bytes of a file, looking into a folder when the top has none', async () => {
    const { fetch, seen } = service([
      [
        (r) => r.method === 'PROPFIND' && r.path === TOP,
        () => answer(207, dav([TOP, true], [`${TOP}Photos/`, true])),
      ],
      [
        (r) => r.method === 'PROPFIND' && r.path === `${TOP}Photos/`,
        () => answer(207, dav([`${TOP}Photos/`, true], [`${TOP}Photos/a.jpg`, false])),
      ],
      [(r) => r.path === `${TOP}Photos/a.jpg`, () => answer(206, 'xx')],
    ]);
    const result = await testOnce('nextcloud', fetch, row, NOW);
    expect(result.outcome).toBe('ok');
    expect(seen.every((r) => (r.method ?? 'GET') === 'GET' || r.method === 'PROPFIND')).toBe(true);
    expect(seen.at(-1)?.firstBytes).toBe(2048);
    expect(seen.at(-1)?.headers?.Range).toBe('bytes=0-2047');
  });

  it('an empty Nextcloud passes as nothing to open yet', async () => {
    const { fetch } = service([[(r) => r.method === 'PROPFIND', () => answer(207, dav([TOP, true]))]]);
    expect((await testOnce('nextcloud', fetch, row, NOW)).outcome).toBe('empty');
  });

  it('a refused sign-in is the sign-in’s, not the service’s', async () => {
    const { fetch } = service([[() => true, () => answer(401)]]);
    expect(await testOnce('nextcloud', fetch, row, NOW)).toMatchObject({
      outcome: 'access',
      step: 'list',
      status: 401,
    });
    const auth: TestFetch = async () => {
      throw new ConnectionAuthError('expired');
    };
    expect(await testOnce('immich', auth, row, NOW)).toMatchObject({ outcome: 'access', step: 'find' });
  });

  it('an error code at a step is the service broken there', async () => {
    const { fetch } = service([
      [
        (r) => r.path === '/api/search/metadata',
        () => answer(200, { assets: { items: [{ id: 'aa11bb22-cc33' }] } }),
      ],
      [(r) => r.path.endsWith('/thumbnail'), () => answer(500)],
    ]);
    expect(await testOnce('immich', fetch, row, NOW)).toMatchObject({
      outcome: 'broken',
      step: 'open',
      reason: 'status',
      status: 500,
    });
  });

  it('no answer is down, a slow one is broken at the step it was at', async () => {
    const down: TestFetch = async () => {
      throw new VaultCallError('unreachable');
    };
    expect(await testOnce('paperless', down, row, NOW)).toMatchObject({ outcome: 'down', step: 'find' });
    const slow: TestFetch = () => new Promise(() => undefined);
    expect(await testOnce('paperless', slow, row, NOW, 20)).toMatchObject({
      outcome: 'broken',
      step: 'find',
      reason: 'timeout',
    });
    const late: TestFetch = async () => {
      throw new VaultCallError('timeout');
    };
    expect(await testOnce('paperless', late, row, NOW)).toMatchObject({
      outcome: 'broken',
      reason: 'timeout',
    });
  });

  it('Paperless opens the newest document’s first bytes', async () => {
    const { fetch, seen } = service([
      [(r) => r.path === '/api/documents/', () => answer(200, { results: [{ id: 42 }] })],
      [(r) => r.path === '/api/documents/42/download/', () => answer(206, '%PDF')],
    ]);
    expect((await testOnce('paperless', fetch, row, NOW)).outcome).toBe('ok');
    expect(seen[0]?.query).toMatchObject({ ordering: '-added', page_size: '1' });
  });

  it('Jellyfin opens the newest item of a library and keeps only the library’s name', async () => {
    const { fetch, seen } = service([
      [
        (r) => r.path === '/Library/VirtualFolders',
        () =>
          answer(200, [
            { Name: 'Books', ItemId: 'b1', CollectionType: 'books' },
            { Name: 'Movies', ItemId: 'm1', CollectionType: 'movies' },
          ]),
      ],
      [(r) => r.path === '/Items', () => answer(200, { Items: [{ Id: 'abcdef12', MediaType: 'Video' }] })],
      [(r) => r.path === '/Videos/abcdef12/stream', () => answer(206, 'x')],
    ]);
    const result = await testOnce('jellyfin', fetch, row, NOW);
    expect(result).toMatchObject({ outcome: 'ok', facts: { library: 'Movies' } });
    expect(seen[1]?.query?.ParentId).toBe('m1');
  });

  it('a Jellyfin without libraries is broken, not empty', async () => {
    const { fetch } = service([[(r) => r.path === '/Library/VirtualFolders', () => answer(200, [])]]);
    expect(await testOnce('jellyfin', fetch, row, NOW)).toMatchObject({
      outcome: 'broken',
      step: 'library',
      reason: 'missing',
    });
  });

  it('Plex opens an item’s details and its file', async () => {
    const { fetch, seen } = service([
      [
        (r) => r.path === '/library/sections',
        () => answer(200, { MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Films' }] } }),
      ],
      [
        (r) => r.path === '/library/sections/1/all',
        () => answer(200, { MediaContainer: { Metadata: [{ ratingKey: '77' }] } }),
      ],
      [
        (r) => r.path === '/library/metadata/77',
        () =>
          answer(200, {
            MediaContainer: {
              Metadata: [{ ratingKey: '77', Media: [{ Part: [{ key: '/library/parts/9/1/file.mkv' }] }] }],
            },
          }),
      ],
      [(r) => r.path === '/library/parts/9/1/file.mkv', () => answer(206, 'x')],
    ]);
    expect(await testOnce('plex', fetch, row, NOW)).toMatchObject({
      outcome: 'ok',
      facts: { library: 'Films' },
    });
    expect(seen).toHaveLength(4);
  });

  it('Home Assistant passes on a recent reading and is broken when nothing changed for an hour', async () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    const fresh = service([[(r) => r.path === '/api/template', () => answer(200, `12|${at(30_000)}`)]]);
    expect(await testOnce('homeassistant', fresh.fetch, row, NOW)).toMatchObject({
      outcome: 'ok',
      facts: { ageS: 30 },
    });
    const stale = service([
      [(r) => r.path === '/api/template', () => answer(200, `12|${at(2 * 3_600_000)}`)],
    ]);
    expect(await testOnce('homeassistant', stale.fetch, row, NOW)).toMatchObject({
      outcome: 'broken',
      step: 'fresh',
      reason: 'stale',
    });
  });

  it('Home Assistant’s readings are aged by its own clock, not the box’s', async () => {
    // Its clock is two hours behind the box's: its newest reading came 30 s ago by its own time.
    const haNow = new Date(NOW.getTime() - 2 * 3_600_000);
    const behind = new Date(haNow.getTime() - 30_000).toISOString();
    const skewed = service([
      [(r) => r.path === '/api/template', () => answer(200, `12|${behind}|${haNow.toISOString()}`)],
    ]);
    expect(await testOnce('homeassistant', skewed.fetch, row, NOW)).toMatchObject({
      outcome: 'ok',
      facts: { ageS: 30 },
    });
    expect(skewed.seen[0]?.body).toContain('now()');
  });

  it('an older Home Assistant is asked again with the attribute it knows', async () => {
    const { fetch, seen } = service([
      [(r) => r.path === '/api/template' && (r.body ?? '').includes('last_reported'), () => answer(400)],
      [(r) => r.path === '/api/template', () => answer(200, `3|${NOW.toISOString()}`)],
    ]);
    expect((await testOnce('homeassistant', fetch, row, NOW)).outcome).toBe('ok');
    expect(seen).toHaveLength(2);
  });
});

describe('a web page or another answer where the service’s data should be', () => {
  const photo = { assets: { items: [{ id: 'aa11bb22-cc33' }] } };

  it('a sign-in page in front of the service is never “it works”', async () => {
    const page = service([[() => true, () => answer(200, LOGIN_PAGE, 'text/html; charset=utf-8')]]);
    expect(await testOnce('immich', page.fetch, row, NOW)).toMatchObject({
      outcome: 'broken',
      step: 'find',
      reason: 'page',
    });
    // A page without a type is still a page.
    const untyped = service([[() => true, () => answer(200, LOGIN_PAGE)]]);
    expect(await testOnce('homeassistant', untyped.fetch, row, NOW)).toMatchObject({ reason: 'page' });
    // A redirect sends Whombat to another page (no redirect is followed).
    const moved = service([[() => true, () => answer(302)]]);
    expect(await testOnce('paperless', moved.fetch, row, NOW)).toMatchObject({
      outcome: 'broken',
      reason: 'page',
      status: 302,
    });
    // The photo's own picture answered by a page.
    const thumb = service([
      [(r) => r.path === '/api/search/metadata', () => answer(200, photo)],
      [(r) => r.path.endsWith('/thumbnail'), () => answer(200, LOGIN_PAGE, 'text/html')],
    ]);
    expect(await testOnce('immich', thumb.fetch, row, NOW)).toMatchObject({ step: 'open', reason: 'page' });
  });

  it('an answer that isn’t the service’s JSON is unreadable, never empty', async () => {
    const cases: [Parameters<typeof testOnce>[0], string, TestAnswer][] = [
      ['immich', 'find', answer(200, {})],
      ['immich', 'find', answer(200, JSON.stringify(photo), 'text/plain')],
      ['paperless', 'find', answer(200, { detail: 'Not found.' })],
      ['jellyfin', 'library', answer(200, { Items: [] })],
      ['plex', 'library', answer(200, { Directory: [] })],
    ];
    for (const [kind, step, said] of cases) {
      const { fetch } = service([[() => true, () => said]]);
      expect(await testOnce(kind, fetch, row, NOW)).toMatchObject({
        outcome: 'broken',
        step,
        reason: 'unreadable',
      });
    }
    const jellyfinItems = service([
      [
        (r) => r.path === '/Library/VirtualFolders',
        () => answer(200, [{ ItemId: 'm1', CollectionType: 'movies' }]),
      ],
      [(r) => r.path === '/Items', () => answer(200, {})],
    ]);
    expect(await testOnce('jellyfin', jellyfinItems.fetch, row, NOW)).toMatchObject({
      step: 'item',
      reason: 'unreadable',
    });
  });

  it('a file that opens with nothing in it didn’t open', async () => {
    const { fetch } = service([
      [(r) => r.path === '/api/documents/', () => answer(200, { results: [{ id: 42 }] })],
      [(r) => r.path === '/api/documents/42/download/', () => answer(200, '')],
    ]);
    expect(await testOnce('paperless', fetch, row, NOW)).toMatchObject({
      outcome: 'broken',
      step: 'open',
      reason: 'unreadable',
    });
  });

  it('a JSON answer where a file should be didn’t open it, even with 200', async () => {
    const error = () => answer(200, { error: 'Asset not found' });
    const found: [Parameters<typeof testOnce>[0], TestFetch][] = [
      [
        'immich',
        service([
          [(r) => r.path === '/api/search/metadata', () => answer(200, photo)],
          [(r) => r.path.endsWith('/thumbnail'), error],
        ]).fetch,
      ],
      [
        'paperless',
        service([
          [(r) => r.path === '/api/documents/', () => answer(200, { results: [{ id: 42 }] })],
          // Without a type, still JSON by its first bytes.
          [(r) => r.path.endsWith('/download/'), () => answer(200, '{"detail":"No file."}')],
        ]).fetch,
      ],
      [
        'jellyfin',
        service([
          [
            (r) => r.path === '/Library/VirtualFolders',
            () => answer(200, [{ ItemId: 'm1', CollectionType: 'movies' }]),
          ],
          [
            (r) => r.path === '/Items',
            () => answer(200, { Items: [{ Id: 'abcdef12', MediaType: 'Video' }] }),
          ],
          [(r) => r.path.endsWith('/stream'), error],
        ]).fetch,
      ],
    ];
    for (const [kind, fetch] of found)
      expect(await testOnce(kind, fetch, row, NOW), kind).toMatchObject({
        outcome: 'broken',
        step: 'open',
        reason: 'unreadable',
        status: 200,
      });
  });

  it('a photo’s preview is a picture and a film’s file is a film', () => {
    const file = (body: Buffer | string, type?: string): TestAnswer => ({
      status: 206,
      body: Buffer.isBuffer(body) ? body : Buffer.from(body),
      headers: type ? { 'content-type': type } : {},
    });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    const mkv = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00]);
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom')]);
    expect(fileSignature(jpeg)).toBe('image');
    expect(fileSignature(mkv)).toBe('media');
    expect(fileSignature(mp4)).toBe('media');
    expect(fileSignature(Buffer.from('%PDF-1.7'))).toBe('document');
    expect(fileFits(file(jpeg, 'image/jpeg'), { kind: 'image' })).toBe(true);
    expect(fileFits(file(jpeg), { kind: 'image' })).toBe(true);
    expect(fileFits(file('Not found', 'text/plain'), { kind: 'image' })).toBe(false);
    expect(fileFits(file(mkv, 'application/octet-stream'), { kind: 'media' })).toBe(true);
    expect(fileFits(file('x', 'video/x-matroska'), { kind: 'media' })).toBe(true);
    expect(fileFits(file('<MediaContainer size="0"/>', 'application/xml'), { kind: 'media' })).toBe(false);
    expect(fileFits(file('{"error":1}', 'application/json'), { kind: 'any' })).toBe(false);
    // A file that is JSON itself (Nextcloud's listing says so) opens as one.
    expect(fileFits(file('{"a":1}', 'application/json'), { kind: 'any', json: true })).toBe(true);
    expect(fileFits(file('{ notes', 'text/plain'), { kind: 'any' })).toBe(true);
  });

  it('Nextcloud lists files only with a WebDAV listing, and opens a file with bytes that isn’t a page', async () => {
    const page = service([[() => true, () => answer(200, LOGIN_PAGE, 'text/html')]]);
    expect(await testOnce('nextcloud', page.fetch, row, NOW)).toMatchObject({ step: 'list', reason: 'page' });
    const notDav = service([[() => true, () => answer(200, '<ok/>', 'application/xml')]]);
    expect(await testOnce('nextcloud', notDav.fetch, row, NOW)).toMatchObject({
      outcome: 'broken',
      step: 'list',
      reason: 'unreadable',
    });
    const { fetch, seen } = service([
      [
        (r) => r.method === 'PROPFIND',
        () =>
          answer(
            207,
            dav(
              [TOP, true],
              [`${TOP}a-empty.txt`, false, 0, 'text/plain'],
              [`${TOP}b-site.html`, false, 900, 'text/html'],
              [`${TOP}c.pdf`, false, 900, 'application/pdf'],
            ),
            'application/xml; charset=utf-8',
          ),
      ],
      [(r) => r.path === `${TOP}c.pdf`, () => answer(206, '%PDF', 'application/pdf')],
    ]);
    expect((await testOnce('nextcloud', fetch, row, NOW)).outcome).toBe('ok');
    expect(seen.at(-1)?.path).toBe(`${TOP}c.pdf`);
  });

  it('says a page plainly, in English and Dutch', () => {
    const en = runWords('immich', 'Immich', run(0, 'broken', { step: 'find', reason: 'page', status: 200 }));
    expect(en).toContain('web page');
    expect(en).toContain('find your newest photo');
    const nl = localizePhrase(en, 'nl');
    expect(nl).not.toBe(en);
    expect(nl).toContain('Immich');
    expect(nl).not.toContain('find your newest photo');
  });
});

describe('reading the services’ answers', () => {
  it('reads a WebDAV listing without the folder itself', () => {
    const entries = parseDav(dav([TOP, true], [`${TOP}b.txt`, false], [`${TOP}A/`, true]), TOP);
    expect(entries).toEqual([
      { path: `${TOP}A/`, folder: true },
      { path: `${TOP}b.txt`, folder: false },
    ]);
  });

  it('finds the newest photo, document and item, and skips what isn’t one', () => {
    expect(newestAsset({ assets: { items: [{ id: '../etc' }, { id: 'aa11bb22' }] } })).toBe('aa11bb22');
    expect(newestAsset({ assets: { items: [] } })).toBeNull();
    expect(newestDocument({ results: [{ id: 7 }] })).toBe(7);
    expect(newestDocument({ results: [] })).toBeNull();
    expect(jellyfinLibraries([{ ItemId: 'x', CollectionType: 'playlists' }])).toEqual([]);
    expect(jellyfinItem({ Items: [{ Id: 'abcdef12', MediaType: 'Audio' }] })).toEqual({
      id: 'abcdef12',
      audio: true,
    });
    expect(plexLibraries({ MediaContainer: { Directory: [{ key: '2', type: 'photo' }] } })).toEqual([]);
    expect(
      plexItem({
        MediaContainer: { Metadata: [{ ratingKey: '5', Media: [{ Part: [{ key: '/etc/x' }] }] }] },
      }),
    ).toEqual({ key: '5', part: null });
    expect(haSensors('0|')).toEqual({ count: 0, newest: null, now: null });
    expect(haSensors('<html>')).toBeNull();
  });
});

const run = (minutesAgo: number, outcome: RunLike['outcome'], more: Partial<RunLike> = {}): RunLike => ({
  at: new Date(NOW.getTime() - minutesAgo * 60_000),
  outcome,
  step: null,
  reason: null,
  status: null,
  ms: 400,
  facts: {},
  ...more,
});

describe('when a watched test runs and when it says something', () => {
  it('runs every 15 minutes, once more soon after a first failure, and after a change', () => {
    expect(due([], NOW)).toBe(true);
    expect(due([run(5, 'ok')], NOW)).toBe(false);
    expect(due([run(15, 'ok')], NOW)).toBe(true);
    // A first failure is checked again at the next pass; a second waits for the rhythm.
    expect(due([run(5, 'broken'), run(20, 'ok')], NOW)).toBe(true);
    expect(due([run(2, 'broken'), run(20, 'ok')], NOW)).toBe(false);
    expect(due([run(5, 'broken'), run(10, 'broken')], NOW)).toBe(false);
    // Something changed on the service since the last run: once it had two minutes to come back.
    const failed = [run(10, 'broken'), run(25, 'broken')];
    expect(due(failed, NOW)).toBe(false);
    expect(due(failed, NOW, new Date(NOW.getTime() - 3 * 60_000))).toBe(true);
    expect(due(failed, NOW, new Date(NOW.getTime() - 60_000))).toBe(false);
    expect(due([run(10, 'ok')], NOW, new Date(NOW.getTime() - 12 * 60_000))).toBe(false);
  });

  it('fails only after two failed runs in a row, and an empty service passes', () => {
    expect(failing([run(1, 'broken')])).toBe(false);
    expect(failing([run(1, 'broken'), run(16, 'down')])).toBe(true);
    expect(failing([run(1, 'broken'), run(16, 'ok')])).toBe(false);
    expect(failing([run(1, 'empty'), run(16, 'empty')])).toBe(false);
    expect(fresh([run(30, 'ok')], NOW)).toBe(true);
    expect(fresh([run(50, 'ok')], NOW)).toBe(false);
  });

  it('a broken service is a problem to look into, a refused sign-in is the person’s', () => {
    const broken = worksNotice(
      'immich',
      'Immich',
      [run(1, 'broken', { step: 'open', reason: 'status', status: 500 }), run(16, 'broken')],
      'UTC',
    );
    expect(broken).toMatchObject({
      tone: 'bad',
      nature: 'problem',
      check: 'works.test',
      link: { kind: 'ask' },
    });
    expect(broken?.title).toContain('500');
    const access = worksNotice(
      'immich',
      'Immich',
      [run(1, 'access', { step: 'find', status: 401 }), run(16, 'access', { step: 'find', status: 401 })],
      'UTC',
    );
    expect(access).toMatchObject({ tone: 'warn', nature: 'you', link: { kind: 'tab', tab: 'settings' } });
    expect(worksNotice('immich', 'Immich', [run(1, 'ok'), run(16, 'broken')], 'UTC')).toBeNull();
  });

  it('says where it got stuck, with the service’s name and code', () => {
    const words = runWords(
      'nextcloud',
      'Nextcloud',
      run(0, 'broken', { step: 'list', reason: 'status', status: 503 }),
    );
    expect(words).toContain('Nextcloud');
    expect(words).toContain('list your files');
    expect(words).toContain('503');
    expect(runWords('nextcloud', 'Nextcloud', run(0, 'access', { step: 'list', status: 401 }))).toContain(
      'sign-in',
    );
    expect(runWords('immich', 'Immich', run(0, 'ok', { ms: 420 }))).toContain('0.4');
    expect(runWords('homeassistant', 'Home', run(0, 'ok', { facts: { ageS: 12 } }))).toContain('12 s');
    expect(runWords('jellyfin', 'Jellyfin', run(0, 'ok', { facts: { library: 'Movies' } }))).toContain(
      'Movies',
    );
    expect(seconds(12_345)).toBe('12');
  });
});

describe('the card on the page', () => {
  const nc = { catalogId: 'nextcloud', label: 'Nextcloud', fields: {} };

  it('offers Run now and Watch it, and Stop watching once watched', () => {
    const off = worksCard(nc, [], false);
    expect(off?.buttons?.map((b) => [b.action, b.value, b.allowed])).toEqual([
      [WORKS_RUN, undefined, true],
      [WORKS_WATCH, true, true],
    ]);
    expect(off?.items[0]).toMatchObject({ tone: 'info', detail: NOT_RUN });
    const on = worksCard(
      nc,
      [{ ...run(1, 'broken'), id: 'wtr_1', burrowId: 'b', connectionId: 'c', by: 'watch' }],
      true,
    );
    expect(on?.buttons?.[1]).toMatchObject({ action: WORKS_WATCH, value: false });
    expect(on?.items[0]?.tone).toBe('bad');
    expect(worksCard({ ...nc, catalogId: 'radarr' }, [], false)).toBeNull();
  });

  it('says how often it runs and how the last runs went', () => {
    expect(worksMeta(true, [{ outcome: 'ok' }, { outcome: 'broken' }, { outcome: 'empty' }])).toContain(
      '2 of the last 3',
    );
    expect(worksMeta(false, [])).not.toContain('15');
  });
});

describe('in Dutch', () => {
  it('says a run’s sentence with the step’s words, the name and the code kept', () => {
    const en = runWords(
      'nextcloud',
      'Nextcloud',
      run(0, 'broken', { step: 'list', reason: 'status', status: 503 }),
    );
    const nl = localizePhrase(en, 'nl');
    expect(nl).not.toBe(en);
    expect(nl).toContain('Nextcloud');
    expect(nl).toContain('503');
    expect(nl).not.toContain('list your files');
    const ok = localizePhrase(runWords('immich', 'Immich', run(0, 'ok', { ms: 420 })), 'nl');
    expect(ok).toContain('0,4');
    const library = localizePhrase(
      runWords('plex', 'Plex', run(0, 'ok', { facts: { library: 'Films' } })),
      'nl',
    );
    expect(library).toContain('‘Films’');
    expect(library).not.toContain('opened');
  });

  it('says the card, the line and the toasts', () => {
    for (const en of [
      'Does it really work?',
      'Run now',
      'Watch it',
      'Stop watching',
      NOT_RUN,
      worksMeta(true, [{ outcome: 'ok' }, { outcome: 'ok' }]),
      'Whombat stopped running this test.',
      'Whombat runs this test every 15 minutes now.',
      'Until the test passes again.',
    ])
      expect(localizePhrase(en, 'nl')).not.toBe(en);
  });
});
