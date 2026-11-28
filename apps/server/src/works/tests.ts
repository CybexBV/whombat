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
 * answer that doesn't hold what it should (`broken`), a web page where the service's data should be (`broken`: a
 * sign-in page in front of it or a wrong address, never “it works”), no answer in time (`broken`, a service that
 * hangs), or no answer at all (`down`).
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
  /** The answer is a file's first bytes: what the file must be (`fileFits`). */
  file?: FileExpect;
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
  // No redirect is followed: one sends Whombat to another page (a sign-in page in front of the service), not its data.
  if (status >= 300) return new StepFailed(step, 'broken', 'page', status);
  return null;
}

/** An answer's media type, lowercase and without its parameters (`text/html`), or '' when it has none. */
export function mediaType(answer: Pick<TestAnswer, 'headers'>): string {
  for (const [name, value] of Object.entries(answer.headers)) {
    if (name.toLowerCase() !== 'content-type') continue;
    const first = Array.isArray(value) ? value[0] : value;
    return (first ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  }
  return '';
}

const HTML_TYPES: ReadonlySet<string> = new Set(['text/html', 'application/xhtml+xml']);

/**
 * Whether an answer is a web page: no step of a test asks for one, so it is a sign-in page in front of the service or
 * the wrong address, never the service's data. Without a type, a page still starts like one.
 */
export function isWebPage(answer: TestAnswer): boolean {
  const type = mediaType(answer);
  if (type) return HTML_TYPES.has(type);
  return /^\s*<(?:!doctype\s+html|html)\b/i.test(answer.body.subarray(0, 512).toString('utf8'));
}

/** A JSON answer's type: `application/json` and its kinds (`application/problem+json`). */
const isJsonType = (type: string) => /^application\/(?:[\w.-]+\+)?json$/.test(type);

/**
 * What a file must be: a picture (a photo's preview), a film or song, or any file. A JSON answer is never the file
 * (an error some services send with 200) unless the file itself is JSON (`json`).
 */
export interface FileExpect {
  kind: 'image' | 'media' | 'any';
  json?: boolean;
}

const at = (b: Buffer, offset: number, text: string) =>
  b.subarray(offset, offset + text.length).toString('latin1') === text;

/** What a file's first bytes say it is, by the signature its format starts with; null when Whombat doesn't know it. */
export function fileSignature(b: Buffer): 'image' | 'media' | 'document' | null {
  if (b.length < 4) return null;
  const [b0, b1, b2, b3] = [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0];
  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return 'image';
  if (at(b, 0, '\x89PNG') || at(b, 0, 'GIF8') || at(b, 0, 'II*\0') || at(b, 0, 'MM\0*')) return 'image';
  if (at(b, 0, 'RIFF') && at(b, 8, 'WEBP')) return 'image';
  // ISO media (MP4, MOV, M4A, HEIC, AVIF): its brand says whether it is a picture.
  if (at(b, 4, 'ftyp'))
    return /^(avif|avis|heic|heix|hevc|hevx|mif1|msf1)$/.test(b.subarray(8, 12).toString('latin1'))
      ? 'image'
      : 'media';
  if (b0 === 0x1a && b1 === 0x45 && b2 === 0xdf && b3 === 0xa3) return 'media';
  if (at(b, 0, 'OggS') || at(b, 0, 'fLaC') || at(b, 0, 'ID3') || at(b, 0, 'FLV')) return 'media';
  if (at(b, 0, 'RIFF') && (at(b, 8, 'AVI ') || at(b, 8, 'WAVE'))) return 'media';
  if (b0 === 0x30 && b1 === 0x26 && b2 === 0xb2 && b3 === 0x75) return 'media';
  if (b0 === 0 && b1 === 0 && b2 === 1 && (b3 === 0xba || b3 === 0xb3)) return 'media';
  if (b0 === 0x47 && b.length > 188 && b[188] === 0x47) return 'media';
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return 'media';
  if (at(b, 0, '%PDF')) return 'document';
  return null;
}

/** Types that say nothing of what a file is. */
const GENERIC_TYPES: ReadonlySet<string> = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
/** Films and songs some servers give a type outside `video/` and `audio/`. */
const MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/mp4',
  'application/ogg',
  'application/x-matroska',
  'application/vnd.rn-realmedia',
]);

/**
 * Whether a file's first bytes read as text: valid UTF-8 with no control characters but tabs and line ends (an empty
 * answer too). A film or song is binary from its first bytes; text there is an error message.
 */
export function readsAsText(b: Buffer): boolean {
  const head = b.subarray(0, 512);
  // A character cut at the end of what was read is still text.
  for (let cut = 0; cut <= (b.length > head.length ? 3 : 0); cut++) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - cut));
    } catch {
      continue;
    }
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return false;
    }
    return true;
  }
  return false;
}

/** Whether an answer is the file a step opens: not JSON where a file should be, and what the service says it is. */
export function fileFits(answer: TestAnswer, expect: FileExpect): boolean {
  const type = mediaType(answer);
  const head = answer.body.subarray(0, 64).toString('utf8').trimStart();
  const generic = GENERIC_TYPES.has(type);
  if (!expect.json && (isJsonType(type) || (generic && /^[{[]/.test(head)))) return false;
  const signature = fileSignature(answer.body);
  if (expect.kind === 'image') return type.startsWith('image/') || signature === 'image';
  if (expect.kind === 'media')
    return (
      /^(video|audio)\//.test(type) ||
      MEDIA_TYPES.has(type) ||
      signature === 'media' ||
      // A container Whombat doesn't know by its first bytes, sent without a type: binary, never text (a plain error
      // message such as “Storage unavailable”, a page, an empty answer).
      (generic && signature === null && !readsAsText(answer.body))
    );
  return true;
}

/** Stops the test when an answer doesn't hold what the service always sends: it isn't the service's answer. */
const holds = (step: string, ok: boolean): void => {
  if (!ok) throw new StepFailed(step, 'broken', 'unreadable');
};

/* Nextcloud: list the person's files over WebDAV, open the first bytes of one --------------------------------------- */

export const PROPFIND_BODY =
  '<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getcontenttype/></d:prop></d:propfind>';

export interface DavEntry {
  /** The path from `/remote.php/` on, as Nextcloud named it. */
  path: string;
  folder: boolean;
  /** A file's size in bytes, when the listing says it. */
  size?: number;
  /** A file's media type, lowercase, when the listing says it. */
  type?: string;
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
    const size = /<(?:[A-Za-z0-9_-]+:)?getcontentlength>\s*(\d+)\s*</.exec(r)?.[1];
    const type = /<(?:[A-Za-z0-9_-]+:)?getcontenttype>([^<]*)</
      .exec(r)?.[1]
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    out.push({
      path,
      folder: /<(?:[A-Za-z0-9_-]+:)?collection\s*\/>/.test(r),
      ...(size !== undefined ? { size: Number(size) } : {}),
      ...(type ? { type } : {}),
    });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** How many folders the test looks into when the top one holds no file. */
const DAV_FOLDERS_MAX = 3;

/**
 * A file the test can open: one with bytes in it, and not a web page the person keeps (its answer would read as a
 * sign-in page in front of Nextcloud).
 */
export const openableFile = (e: DavEntry): boolean =>
  !e.folder && e.size !== 0 && !(e.type && HTML_TYPES.has(e.type));

/** A WebDAV listing is a `207 Multi-Status` with its `multistatus`: anything else isn't Nextcloud's answer. */
export const isDavListing = (status: number, xml: string): boolean =>
  status === 207 && /<(?:[A-Za-z0-9_-]+:)?multistatus\b/.test(xml);

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
      const xml = answer.body.toString('utf8');
      holds('list', isDavListing(answer.status, xml));
      return parseDav(xml, path);
    };
    const first = await listing(top);
    let file = first.find(openableFile);
    for (const folder of first.filter((e) => e.folder).slice(0, DAV_FOLDERS_MAX)) {
      if (file) break;
      file = (await listing(folder.path)).find(openableFile);
    }
    if (!file) return EMPTY;
    await t.call('open', {
      path: file.path,
      headers: { Range: `bytes=0-${FIRST_BYTES - 1}`, Accept: '*/*' },
      firstBytes: FIRST_BYTES,
      // A file the listing doesn't say the type of may be JSON itself.
      file: { kind: 'any', json: !file.type || isJsonType(file.type) },
    });
    return ok();
  },
};

/* Immich: find the newest photo and load its picture ----------------------------------------------------------------- */

/** Whether an answer is Immich's search result: its `assets.items` list, empty or not. */
export const isAssetSearch = (body: unknown): boolean => Array.isArray(rec(rec(body).assets).items);

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
    const body = t.json('find', found);
    holds('find', isAssetSearch(body));
    const id = newestAsset(body);
    if (!id) return EMPTY;
    // The preview is a file Immich made from the photo, kept beside it: it loads only while its storage is there.
    await t.call('open', {
      path: `/api/assets/${encodeURIComponent(id)}/thumbnail`,
      query: { size: 'preview' },
      headers: { Accept: 'image/*' },
      firstBytes: FIRST_BYTES,
      file: { kind: 'image' },
    });
    return ok();
  },
};

/* Paperless-ngx: find the newest document and open its first bytes --------------------------------------------------- */

/** Whether an answer is Paperless's document list: its `results` (or, from an older one, the list itself). */
export const isDocumentList = (body: unknown): boolean =>
  Array.isArray(body) || Array.isArray(rec(body).results);

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
    const body = t.json('find', found);
    holds('find', isDocumentList(body));
    const id = newestDocument(body);
    if (id === null) return EMPTY;
    await t.call('open', {
      path: `/api/documents/${id}/download/`,
      headers: { Range: `bytes=0-${FIRST_BYTES - 1}`, Accept: '*/*' },
      firstBytes: FIRST_BYTES,
      file: { kind: 'any' },
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
    const folders = t.json('library', await t.call('library', { path: '/Library/VirtualFolders' }));
    holds('library', Array.isArray(folders));
    const libraries = jellyfinLibraries(folders);
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
      const items = t.json('item', found);
      holds('item', Array.isArray(rec(items).Items));
      const item = jellyfinItem(items);
      if (!item) continue;
      // The file itself, as a player would start it: no conversion, only its first bytes.
      await t.call('open', {
        path: `/${item.audio ? 'Audio' : 'Videos'}/${encodeURIComponent(item.id)}/stream`,
        query: { static: 'true' },
        headers: { Range: `bytes=0-${FIRST_BYTES - 1}`, Accept: '*/*' },
        firstBytes: FIRST_BYTES,
        file: { kind: 'media' },
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

/** Whether an answer is Plex's: every answer of its API is a `MediaContainer`. */
export const isPlexAnswer = (body: unknown): boolean => {
  const c = rec(body).MediaContainer;
  return !!c && typeof c === 'object' && !Array.isArray(c);
};

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
    /** A step's answer, which must be Plex's. */
    const plexJson = (step: string, answer: TestAnswer) => {
      const body = t.json(step, answer);
      holds(step, isPlexAnswer(body));
      return body;
    };
    const libraries = plexLibraries(
      plexJson('library', await t.call('library', { path: '/library/sections', headers: json })),
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
      const item = plexItem(plexJson('item', found));
      if (!item) continue;
      const details = plexItem(
        plexJson(
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
        file: { kind: 'media' },
      });
      return ok({ library: lib.name });
    }
    return missing('item');
  },
};

/* Home Assistant: see its sensors change ---------------------------------------------------------------------------- */

/**
 * How many sensors there are, when the newest reading came and Home Assistant's own time now: the reading's age is told
 * by its clock, so a Home Assistant whose clock is off from the box's doesn't read as stuck. `last_reported` (2024.3 and
 * later) moves with every reading, also one that says the same as before; an older Home Assistant has only
 * `last_updated`.
 */
export const HA_SENSORS_TEMPLATE = (attribute: 'last_reported' | 'last_updated') =>
  `{% set s = states.sensor | list %}{{ s | count }}|{{ (s | map(attribute='${attribute}') | max).isoformat() if s else '' }}|{{ now().isoformat() }}`;

/**
 * A template's answer (“214|2026-11-28T10:41:53.123+00:00|2026-11-28T10:42:00.004+00:00”): the count, the newest
 * reading's time and Home Assistant's time now (absent from an answer without it).
 */
export function haSensors(text: string): { count: number; newest: Date | null; now: Date | null } | null {
  const m = /^\s*(\d+)\|([^|]*?)(?:\|([^|]*?))?\s*$/s.exec(text);
  if (!m) return null;
  const date = (raw: string | undefined) => {
    const at = raw ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(at) ? new Date(at) : null;
  };
  return { count: Number(m[1]), newest: date(m[2]), now: date(m[3]) };
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
    const age = Math.max(0, (read.now ?? t.now).getTime() - read.newest.getTime());
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
      if (isWebPage(answer)) throw new StepFailed(step, 'broken', 'page', answer.status);
      // A file's first bytes: an answer without any didn't open it.
      if (req.firstBytes !== undefined && answer.body.length === 0)
        throw new StepFailed(step, 'broken', 'unreadable', answer.status);
      if (req.file && !fileFits(answer, req.file))
        throw new StepFailed(step, 'broken', 'unreadable', answer.status);
      return answer;
    },
    json(step, answer) {
      if (!isJsonType(mediaType(answer))) throw new StepFailed(step, 'broken', 'unreadable');
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
