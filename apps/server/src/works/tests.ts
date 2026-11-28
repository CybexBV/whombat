/**
 * “Does it really work?” (docs/decisions/service-works.md): one test per kind of service, doing what a person would and
 * only reading. Each is a few steps through the connection's own sign-in (`TestFetch`, `signedConnectionFetch` in
 * production): Nextcloud lists the person's files and opens the first bytes of one, Immich finds the newest photo and
 * loads its picture, Paperless finds the newest document and opens its first bytes, Jellyfin and Plex list the
 * libraries, find the newest item and open the first bytes of its file, Home Assistant reads when its sensors last
 * changed. Nothing is written anywhere and nothing that was read is kept: a run ends with its outcome, the step it
 * stopped at, the service's answer code and a few facts for its words.
 *
 * A step that fails says how: refused (401, 403: the sign-in expired or lost access, `access`), an error code or an
 * answer that doesn't hold what it should (`broken`), no answer in time (`broken`, a service that hangs), or no answer
 * at all (`down`).
 */
import type { ServiceTestKind, ServiceTestOutcome, ThingNoticeIcon } from '@whombat/core';
import type { CatalogConnectionRow } from '../connections/types';
import { ConnectionAuthError } from '../connections/types';
import type { ServiceTestFacts, ServiceTestReason } from '../db/schema/index';
import { list, num, rec, str } from '../things/words';
import { VaultCallError } from '../vault/net';

/** One request of a test, as the connection. */
export interface TestRequest {
  method?: 'GET' | 'POST' | 'PROPFIND';
  /** A path on the connection's address (`/api/assets/…`), with its query. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  /** Read only this many bytes of the answer (a file's first bytes) and stop. */
  firstBytes?: number;
  /** The most a whole answer may be (a folder's list). */
  maxBytes?: number;
}

export interface TestAnswer {
  status: number;
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export type TestFetch = (req: TestRequest) => Promise<TestAnswer>;

/** How a run ended, before its time and words are added. */
export interface TestResult {
  outcome: ServiceTestOutcome;
  step?: string;
  reason?: ServiceTestReason;
  status?: number;
  facts: ServiceTestFacts;
}

/** A step that stopped the test. */
export class StepFailed extends Error {
  override name = 'StepFailed';
  constructor(
    readonly step: string,
    readonly outcome: 'broken' | 'access' | 'down',
    readonly reason: ServiceTestReason,
    readonly status: number | null = null,
  ) {
    super(`${step}: ${outcome} (${reason}${status ? ` ${status}` : ''})`);
  }
}

/** What a test's steps use. */
export interface TestTools {
  row: Pick<CatalogConnectionRow, 'baseUrl' | 'fields'>;
  now: Date;
  /** One request as step `step`; an answer with an error code or no answer stops the test there. */
  call(step: string, req: TestRequest): Promise<TestAnswer>;
  /** The answer's JSON; one Whombat can't read stops the test there. */
  json(step: string, answer: TestAnswer): unknown;
}

export interface ServiceTest {
  /** The test in plain words, on the page: “Open your newest photo”. */
  name: string;
  icon: ThingNoticeIcon;
  /** What each step tried, as “… it can’t {what}”: “list your files”. */
  steps: Readonly<Record<string, string>>;
  /** What it did when it worked, as “It works — {done} in 0.4 s.”: “opened your newest photo”. */
  done: (facts: ServiceTestFacts) => string;
  /** Its line's short words in the head and a push: “Files don’t open”. */
  badge: string;
  /** The person's question when it fails: “Why can’t Nextcloud open my files?”. */
  question: (name: string) => string;
  run: (t: TestTools) => Promise<TestResult>;
}

const ok = (facts: ServiceTestFacts = {}): TestResult => ({ outcome: 'ok', facts });
const EMPTY: TestResult = { outcome: 'empty', facts: {} };
/** Stops the test: the step found nothing where it should be (no library, an empty list). */
const missing = (step: string): never => {
  throw new StepFailed(step, 'broken', 'missing');
};
/** A file's first bytes: enough to know it opens. */
const FIRST_BYTES = 2048;
/** A folder's list or a library's answer: more than a page's read, as a big folder lists everything in it. */
const LIST_MAX_BYTES = 8 * 1024 * 1024;

/** A failure of the call itself as a step's: refused, no answer in time, or none at all. */
export function failureOf(step: string, err: unknown): StepFailed {
  if (err instanceof StepFailed) return err;
  // The credential couldn't be used (an OAuth sign-in that can't be renewed): the person must sign in again.
  if (err instanceof ConnectionAuthError) return new StepFailed(step, 'access', 'status');
  if (err instanceof VaultCallError) {
    if (err.reason === 'timeout') return new StepFailed(step, 'broken', 'timeout');
    if (err.reason === 'too_large') return new StepFailed(step, 'broken', 'unreadable');
  }
  return new StepFailed(step, 'down', 'status');
}

/** An answer's code as a step's outcome: refused is the sign-in's, any other error the service's. */
export function answerFailure(step: string, status: number): StepFailed | null {
  if (status === 401 || status === 403) return new StepFailed(step, 'access', 'status', status);
  if (status >= 400) return new StepFailed(step, 'broken', 'status', status);
  return null;
}

/* Nextcloud: list the person's files over WebDAV, open the first bytes of one --------------------------------------- */

export const PROPFIND_BODY =
  '<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>';

export interface DavEntry {
  /** The path from `/remote.php/` on, as Nextcloud named it. */
  path: string;
  folder: boolean;
}

/**
 * A folder's WebDAV listing (`207 Multi-Status`): each entry's path and whether it is a folder, the folder itself left
 * out. Prefix-agnostic (Nextcloud says `d:`, others `D:`).
 */
export function parseDav(xml: string, self: string): DavEntry[] {
  const out: DavEntry[] = [];
  const responses =
    xml.match(/<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response>/g) ?? [];
  for (const r of responses) {
    const href = /<(?:[A-Za-z0-9_-]+:)?href>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?href>/.exec(r)?.[1]?.trim();
    if (!href) continue;
    const at = href.indexOf('/remote.php/');
    if (at < 0) continue;
    const path = href.slice(at).replace(/&amp;/g, '&');
    if (path.replace(/\/+$/, '') === self.replace(/\/+$/, '')) continue;
    out.push({ path, folder: /<(?:[A-Za-z0-9_-]+:)?collection\s*\/>/.test(r) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** How many folders the test looks into when the top one holds no file. */
const DAV_FOLDERS_MAX = 3;

const nextcloud: ServiceTest = {
  name: 'Open one of your files',
  icon: 'disk',
  steps: { list: 'list your files', open: 'open your files' },
  done: () => 'opened one of your files',
  badge: 'Files don’t open',
  question: (name) => `Why can’t ${name} open my files?`,
  async run(t) {
    const user = str(t.row.fields.userId) ?? str(t.row.fields.username);
    if (!user) return missing('list');
    const top = `/remote.php/dav/files/${encodeURIComponent(user as string)}/`;
    const listing = async (path: string) => {
      const answer = await t.call('list', {
        method: 'PROPFIND',
        path,
        headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8', Accept: 'application/xml' },
        body: PROPFIND_BODY,
        maxBytes: LIST_MAX_BYTES,
      });
      return parseDav(answer.body.toString('utf8'), path);
    };
    const first = await listing(top);
    let file = first.find((e) => !e.folder);
    for (const folder of first.filter((e) => e.folder).slice(0, DAV_FOLDERS_MAX)) {
      if (file) break;
      file = (await listing(folder.path)).find((e) => !e.folder);
    }
    if (!file) return EMPTY;
    await t.call('open', {
      path: file.path,
      headers: { Range: `bytes=0-${FIRST_BYTES - 1}`, Accept: '*/*' },
      firstBytes: FIRST_BYTES,
    });
    return ok();
  },
};

/* Immich: find the newest photo and load its picture ----------------------------------------------------------------- */

/** The newest photo's id from `POST /api/search/metadata`, or null when there is none. */
export function newestAsset(body: unknown): string | null {
  for (const raw of list(rec(rec(body).assets).items)) {
    const id = str(rec(raw).id);
    if (id && /^[0-9a-f-]{8,64}$/i.test(id)) return id;
  }
  return null;
}

const immich: ServiceTest = {
  name: 'Open your newest photo',
  icon: 'photo',
  steps: { find: 'find your newest photo', open: 'show your newest photo' },
  done: () => 'opened your newest photo',
  badge: 'Photos don’t open',
  question: (name) => `Why don’t my photos open in ${name}?`,
  async run(t) {
    // A search only reads (Immich takes it as a POST), the key's own library.
    const found = await t.call('find', {
      method: 'POST',
      path: '/api/search/metadata',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ order: 'desc', size: 1, type: 'IMAGE' }),
    });
    const id = newestAsset(t.json('find', found));
    if (!id) return EMPTY;
    // The preview is a file Immich made from the photo, kept beside it: it loads only while its storage is there.
    await t.call('open', {
      path: `/api/assets/${encodeURIComponent(id)}/thumbnail`,
      query: { size: 'preview' },
      headers: { Accept: 'image/*' },
      firstBytes: FIRST_BYTES,
    });
    return ok();
  },
};

/* Paperless-ngx: find the newest document and open its first bytes --------------------------------------------------- */

/** The newest document's id from `GET /api/documents/`, or null when there is none. */
export function newestDocument(body: unknown): number | null {
  const results = Array.isArray(body) ? body : list(rec(body).results);
  for (const raw of results) {
    const id = num(rec(raw).id);
    if (id !== null && Number.isInteger(id) && id >= 0) return id;
  }
  return null;
}

const paperless: ServiceTest = {
  name: 'Open your newest document',
  icon: 'log',
  steps: { find: 'find your newest document', open: 'open your newest document' },
  done: () => 'opened your newest document',
  badge: 'Documents don’t open',
  question: (name) => `Why don’t my documents open in ${name}?`,
  async run(t) {
    const found = await t.call('find', {
      path: '/api/documents/',
      query: { ordering: '-added', page_size: '1', fields: 'id' },
      headers: { Accept: 'application/json' },
    });
    const id = newestDocument(t.json('find', found));
    if (id === null) return EMPTY;
    await t.call('open', {
      path: `/api/documents/${id}/download/`,
      headers: { Range: `bytes=0-${FIRST_BYTES - 1}`, Accept: '*/*' },
      firstBytes: FIRST_BYTES,
    });
    return ok();
  },
};

/* Jellyfin: list the libraries, find the newest item, open the first bytes of its file ------------------------------- */

export interface MediaLibrary {
  id: string;
  name: string;
  /** Jellyfin's `CollectionType`, Plex's section type. */
  type: string;
}

/** Libraries whose items are films, series, music or videos (not photos, books, playlists or live TV). */
const PLAYABLE_JELLYFIN = new Set(['movies', 'tvshows', 'music', 'musicvideos', 'homevideos', 'mixed', '']);

/** `GET /Library/VirtualFolders`: the libraries with something to play. */
export function jellyfinLibraries(body: unknown): MediaLibrary[] {
  return list(body).flatMap((raw) => {
    const r = rec(raw);
    const id = str(r.ItemId);
    const type = (str(r.CollectionType) ?? '').toLowerCase();
    if (!id || !PLAYABLE_JELLYFIN.has(type)) return [];
    return [{ id, name: (str(r.Name) ?? 'A library').slice(0, 80), type }];
  });
}

/** The newest item of `GET /Items` and whether it is sound, or null when there is none. */
export function jellyfinItem(body: unknown): { id: string; audio: boolean } | null {
  const first = rec(list(rec(body).Items)[0]);
  const id = str(first.Id);
  if (!id || !/^[0-9a-f-]{8,64}$/i.test(id)) return null;
  return { id, audio: str(first.MediaType) === 'Audio' || str(first.Type) === 'Audio' };
}

/** How many libraries a test looks through for an item before it says they are empty. */
const LIBRARIES_MAX = 6;

const jellyfin: ServiceTest = {
  name: 'Open the newest item of a library',
  icon: 'film',
  steps: {
    library: 'list its libraries',
    item: 'find anything in your libraries',
    open: 'open the newest item of a library',
  },
  done: (facts) =>
    facts.library ? `opened the newest item in ‘${facts.library}’` : 'opened the newest item of a library',
  badge: 'Library doesn’t open',
  question: (name) => `Why can’t ${name} open what’s in my libraries?`,
  async run(t) {
    const libraries = jellyfinLibraries(
      t.json('library', await t.call('library', { path: '/Library/VirtualFolders' })),
    );
    if (!libraries.length) return missing('library');
    for (const lib of libraries.slice(0, LIBRARIES_MAX)) {
      const found = await t.call('item', {
        path: '/Items',
        query: {
          ParentId: lib.id,
          Recursive: 'true',
          IncludeItemTypes: 'Movie,Episode,Audio,MusicVideo,Video',
          SortBy: 'DateCreated',
          SortOrder: 'Descending',
          Limit: '1',
        },
      });
      const item = jellyfinItem(t.json('item', found));
      if (!item) continue;
      // The file itself, as a player would start it: no conversion, only its first bytes.
      await t.call('open', {
        path: `/${item.audio ? 'Audio' : 'Videos'}/${encodeURIComponent(item.id)}/stream`,
        query: { static: 'true' },
        headers: { Range: `bytes=0-${FIRST_BYTES - 1}`, Accept: '*/*' },
        firstBytes: FIRST_BYTES,
      });
      return ok({ library: lib.name });
    }
    return missing('item');
  },
};

/* Plex: list the libraries, find the newest item, open its details and the first bytes of its file ------------------- */

/** Plex's section types with something to play, and the item type its newest playable item is. */
const PLEX_ITEM_TYPE: Readonly<Record<string, string>> = { movie: '1', show: '4', artist: '10' };

const container = (body: unknown) => rec(rec(body).MediaContainer);

/** `GET /library/sections`: the libraries with something to play. */
export function plexLibraries(body: unknown): MediaLibrary[] {
  return list(container(body).Directory).flatMap((raw) => {
    const r = rec(raw);
    const id = str(r.key);
    const type = str(r.type) ?? '';
    if (!id || !PLEX_ITEM_TYPE[type]) return [];
    return [{ id, name: (str(r.title) ?? 'A library').slice(0, 80), type }];
  });
}

/** The first item of a Plex answer: its key and its file's path, when the answer has it. */
export function plexItem(body: unknown): { key: string; part: string | null } | null {
  const first = rec(list(container(body).Metadata)[0]);
  const key = str(first.ratingKey);
  if (!key) return null;
  const part = str(rec(list(rec(list(first.Media)[0]).Part)[0]).key);
  return { key, part: part?.startsWith('/library/parts/') ? part : null };
}

const plex: ServiceTest = {
  name: 'Open the newest item of a library',
  icon: 'film',
  steps: {
    library: 'list its libraries',
    item: 'find anything in your libraries',
    details: 'open an item’s details',
    open: 'open the newest item of a library',
  },
  done: jellyfin.done,
  badge: 'Library doesn’t open',
  question: jellyfin.question,
  async run(t) {
    const json = { Accept: 'application/json' };
    const libraries = plexLibraries(
      t.json('library', await t.call('library', { path: '/library/sections', headers: json })),
    );
    if (!libraries.length) return missing('library');
    for (const lib of libraries.slice(0, LIBRARIES_MAX)) {
      const found = await t.call('item', {
        path: `/library/sections/${encodeURIComponent(lib.id)}/all`,
        query: {
          type: PLEX_ITEM_TYPE[lib.type] ?? '1',
          sort: 'addedAt:desc',
          'X-Plex-Container-Start': '0',
          'X-Plex-Container-Size': '1',
        },
        headers: json,
      });
      const item = plexItem(t.json('item', found));
      if (!item) continue;
      const details = plexItem(
        t.json(
          'details',
          await t.call('details', {
            path: `/library/metadata/${encodeURIComponent(item.key)}`,
            headers: json,
          }),
        ),
      );
      const part = details?.part ?? item.part;
      if (!part) return missing('details');
      await t.call('open', {
        path: part,
        headers: { Range: `bytes=0-${FIRST_BYTES - 1}`, Accept: '*/*' },
        firstBytes: FIRST_BYTES,
      });
      return ok({ library: lib.name });
    }
    return missing('item');
  },
};

/* Home Assistant: see its sensors change ---------------------------------------------------------------------------- */

/**
 * How many sensors there are and when the newest reading came. `last_reported` (2024.3 and later) moves with every
 * reading, also one that says the same as before; an older Home Assistant has only `last_updated`.
 */
export const HA_SENSORS_TEMPLATE = (attribute: 'last_reported' | 'last_updated') =>
  `{% set s = states.sensor | list %}{{ s | count }}|{{ (s | map(attribute='${attribute}') | max).isoformat() if s else '' }}`;

/** A template's answer (“214|2026-11-28T10:41:53.123+00:00”): the count and the newest reading's time. */
export function haSensors(text: string): { count: number; newest: Date | null } | null {
  const m = /^\s*(\d+)\|(.*?)\s*$/s.exec(text);
  if (!m) return null;
  const at = m[2] ? Date.parse(m[2]) : Number.NaN;
  return { count: Number(m[1]), newest: Number.isFinite(at) ? new Date(at) : null };
}

/** No sensor changed for this long: Home Assistant answers, but isn't getting readings. */
export const HA_STALE_MS = 60 * 60_000;

const homeassistant: ServiceTest = {
  name: 'See a sensor change',
  icon: 'device',
  steps: { read: 'read its sensors', fresh: 'get new readings from its sensors' },
  done: () => 'saw a sensor change',
  badge: 'Sensors don’t change',
  question: (name) => `Why don’t my sensors change in ${name}?`,
  async run(t) {
    const ask = async (attribute: 'last_reported' | 'last_updated') =>
      t.call('read', {
        method: 'POST',
        path: '/api/template',
        headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
        body: JSON.stringify({ template: HA_SENSORS_TEMPLATE(attribute) }),
      });
    let answer: TestAnswer;
    try {
      answer = await ask('last_reported');
    } catch (err) {
      // An older Home Assistant doesn't know `last_reported`: the template fails, the other attribute works.
      if (!(err instanceof StepFailed) || err.status !== 400) throw err;
      answer = await ask('last_updated');
    }
    const read = haSensors(answer.body.toString('utf8'));
    if (!read) throw new StepFailed('read', 'broken', 'unreadable');
    if (read.count === 0 || !read.newest) return EMPTY;
    const age = Math.max(0, t.now.getTime() - read.newest.getTime());
    if (age > HA_STALE_MS) throw new StepFailed('fresh', 'broken', 'stale');
    return ok({ ageS: Math.round(age / 1000) });
  },
};

export const SERVICE_TESTS: Readonly<Record<ServiceTestKind, ServiceTest>> = {
  nextcloud,
  immich,
  paperless,
  jellyfin,
  plex,
  homeassistant,
};

/** The tools a test's steps use, over one fetch. */
export function testTools(
  fetch: TestFetch,
  row: Pick<CatalogConnectionRow, 'baseUrl' | 'fields'>,
  now: Date,
  /** Told each step as it starts: where a test that runs out of time was. */
  onStep?: (step: string) => void,
): TestTools {
  return {
    row,
    now,
    async call(step, req) {
      onStep?.(step);
      let answer: TestAnswer;
      try {
        answer = await fetch(req);
      } catch (err) {
        throw failureOf(step, err);
      }
      const failed = answerFailure(step, answer.status);
      if (failed) throw failed;
      return answer;
    },
    json(step, answer) {
      try {
        return JSON.parse(answer.body.toString('utf8'));
      } catch {
        throw new StepFailed(step, 'broken', 'unreadable');
      }
    },
  };
}

/** Runs a test's steps; a step that stopped it is its result. */
export async function runSteps(test: ServiceTest, tools: TestTools): Promise<TestResult> {
  try {
    return await test.run(tools);
  } catch (err) {
    if (!(err instanceof StepFailed)) throw err;
    return {
      outcome: err.outcome,
      step: err.step,
      reason: err.reason,
      ...(err.status !== null ? { status: err.status } : {}),
      facts: {},
    };
  }
}
