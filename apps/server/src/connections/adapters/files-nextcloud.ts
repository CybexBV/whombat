/**
 * Nextcloud's `files_*` tools (docs/decisions/connections-catalog.md CX-34, CX-57) over WebDAV at
 * `/remote.php/dav/files/<user id>/`: PROPFIND (Depth 1) lists, SEARCH on `/remote.php/dav/` finds by name, GET reads,
 * PUT writes (folders on the way made with MKCOL; `If-None-Match: *` unless overwriting), MOVE moves (Destination on
 * the same server, Overwrite F), DELETE deletes (into Nextcloud's trash bin).
 */
import { CONNECTION_OUTPUT_MAX } from '@whombat/core';
import { VAULT_REQUEST_BODY_MAX } from '../../vault/limits';
import { ConnectionArgumentError } from '../request';
import {
  type Adapter,
  type AdapterContext,
  errorOutput,
  fileOutput,
  filePath,
  jsonOutput,
  optStr,
  str,
} from './types';

const PROPS =
  '<d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/></d:prop>';
const PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:">${PROPS}</d:propfind>`;
/** Search results asked for at most. */
const SEARCH_MAX = 100;

/**
 * Whose files the DAV paths name: the user id (`userId`, filled from the check's answer, connection-signin.md SG-15a),
 * which isn't always the login name (an LDAP account's is a UUID by default). A connection made before it falls back
 * to the login name (the username field; Login Flow v2 stores its loginName there) until its next check fills it.
 */
export function nextcloudUser(fields: Readonly<Record<string, string>>): string {
  const user = fields.userId?.trim() || fields.username?.trim() || fields.loginName?.trim();
  if (!user) throw new ConnectionArgumentError('This Nextcloud connection has no username.');
  return user;
}

/** `/a b/c` → `/a%20b/c` (each segment encoded). */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

/** The WebDAV URL of a file path in the user's files. */
export function davUrl(ctx: Pick<AdapterContext, 'baseUrl' | 'fields'>, path: string): string {
  const root = `${ctx.baseUrl}/remote.php/dav/files/${encodeURIComponent(nextcloudUser(ctx.fields))}`;
  return path === '/' ? `${root}/` : `${root}${encodePath(path)}`;
}

function xmlText(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The text of the first element of this local name (any namespace prefix), or null. */
function element(xml: string, name: string): string | null {
  const m = new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${name}>)`,
  ).exec(xml);
  if (!m) return null;
  return xmlText(m[1] ?? '').trim();
}

export interface DavEntry {
  name: string;
  path: string;
  folder: boolean;
  size?: number;
  modified?: string;
  type?: string;
}

/**
 * A WebDAV multistatus as entries, with paths from the user's root (`/Documents/a.txt`). `userRoot` is the href path
 * of the user's root (`/remote.php/dav/files/mara`).
 */
export function parseMultistatus(xml: string, userRoot: string): DavEntry[] {
  const out: DavEntry[] = [];
  const root = decodeURIComponent(userRoot).replace(/\/+$/, '');
  for (const m of xml.matchAll(
    /<(?:[A-Za-z0-9_-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?response>/g,
  )) {
    const block = m[1] ?? '';
    const href = element(block, 'href');
    if (!href) continue;
    let path: string;
    try {
      path = decodeURIComponent(new URL(href, 'http://x').pathname);
    } catch {
      continue;
    }
    const at = path.indexOf(root);
    if (at === -1) continue;
    path = path.slice(at + root.length).replace(/\/+$/, '') || '/';
    const folder = /<(?:[A-Za-z0-9_-]+:)?collection\b/.test(block);
    const size = element(block, 'getcontentlength');
    const modified = element(block, 'getlastmodified');
    const type = element(block, 'getcontenttype');
    out.push({
      name: path === '/' ? '/' : (path.split('/').at(-1) ?? ''),
      path,
      folder,
      ...(size && !folder ? { size: Number(size) } : {}),
      ...(modified ? { modified: new Date(modified).toISOString() } : {}),
      ...(type && !folder ? { type } : {}),
    });
  }
  return out;
}

function userRootPath(ctx: AdapterContext): string {
  return new URL(davUrl(ctx, '/')).pathname;
}

/** The SEARCH body: names containing the words, under `path`, at most 100. */
export function searchBody(user: string, path: string, query: string): string {
  const scope = `/files/${user}${path === '/' ? '' : path}`;
  const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select>${PROPS}</d:select>
    <d:from><d:scope><d:href>${escapeXml(scope)}</d:href><d:depth>infinity</d:depth></d:scope></d:from>
    <d:where><d:like><d:prop><d:displayname/></d:prop><d:literal>${escapeXml(like)}</d:literal></d:like></d:where>
    <d:orderby/>
    <d:limit><d:nresults>${SEARCH_MAX}</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>`;
}

const XML = { 'Content-Type': 'application/xml; charset=utf-8' };

export const NEXTCLOUD_FILES: Adapter = {
  async files_list(ctx, args) {
    const path = filePath(args, 'path', '/');
    const url = davUrl(ctx, path);
    const res = await ctx.send({
      method: 'PROPFIND',
      url: path === '/' || url.endsWith('/') ? url : `${url}/`,
      headers: { ...XML, Depth: '1' },
      body: PROPFIND_BODY,
    });
    if (res.status !== 207) return errorOutput('Nextcloud', res);
    const entries = parseMultistatus(res.body.toString('utf8'), userRootPath(ctx)).filter(
      (e) => e.path !== path,
    );
    return jsonOutput({ path, entries }, res);
  },

  async files_search(ctx, args) {
    const query = str(args, 'query');
    const within = optStr(args, 'path') ? filePath(args, 'path') : '/';
    const user = nextcloudUser(ctx.fields);
    const res = await ctx.send({
      method: 'SEARCH',
      url: `${ctx.baseUrl}/remote.php/dav/`,
      headers: XML,
      body: searchBody(user, within, query),
    });
    if (res.status !== 207) return errorOutput('Nextcloud', res);
    const entries = parseMultistatus(res.body.toString('utf8'), userRootPath(ctx));
    return jsonOutput({ query, entries, more: entries.length >= SEARCH_MAX }, res);
  },

  async files_read(ctx, args) {
    const path = filePath(args, 'path');
    const res = await ctx.send(
      { method: 'GET', url: davUrl(ctx, path) },
      { truncateAt: CONNECTION_OUTPUT_MAX + 1 },
    );
    if (res.status >= 300) return errorOutput('Nextcloud', res);
    const length = res.headers['content-length'];
    return fileOutput(path, res, typeof length === 'string' && /^\d+$/.test(length) ? Number(length) : null);
  },

  async files_write(ctx, args) {
    const path = filePath(args, 'path');
    if (path === '/') throw new ConnectionArgumentError('path: name a file, not the root.');
    const content = args.content;
    if (typeof content !== 'string') throw new ConnectionArgumentError('content: the text to write.');
    if (Buffer.byteLength(content) > VAULT_REQUEST_BODY_MAX)
      throw new ConnectionArgumentError('content: larger than 256 KB.');
    // Folders on the way: MKCOL each (405 means it is there already).
    const parts = path.split('/').slice(1, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = `/${parts.slice(0, i).join('/')}`;
      const made = await ctx.send({ method: 'MKCOL', url: davUrl(ctx, dir) });
      if (made.status >= 300 && made.status !== 405) return errorOutput('Nextcloud', made);
    }
    const res = await ctx.send({
      method: 'PUT',
      url: davUrl(ctx, path),
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        ...(args.overwrite === true ? {} : { 'If-None-Match': '*' }),
      },
      body: content,
    });
    if (res.status === 412)
      return {
        ...errorOutput('Nextcloud', res),
        content: 'A file is already there. Pass overwrite: true to replace it.',
      };
    if (res.status >= 300) return errorOutput('Nextcloud', res);
    return jsonOutput(
      { written: { path, size: Buffer.byteLength(content), created: res.status === 201 } },
      res,
    );
  },

  async files_move(ctx, args) {
    const from = filePath(args, 'from');
    const to = filePath(args, 'to');
    if (from === '/' || to === '/') throw new ConnectionArgumentError('The root can’t be moved.');
    const res = await ctx.send({
      method: 'MOVE',
      url: davUrl(ctx, from),
      headers: { Destination: davUrl(ctx, to), Overwrite: 'F' },
    });
    if (res.status >= 300) return errorOutput('Nextcloud', res);
    return jsonOutput({ moved: { from, to } }, res);
  },

  async files_delete(ctx, args) {
    const path = filePath(args, 'path');
    if (path === '/') throw new ConnectionArgumentError('path: the root can’t be deleted.');
    const res = await ctx.send({ method: 'DELETE', url: davUrl(ctx, path) });
    if (res.status >= 300) return errorOutput('Nextcloud', res);
    return jsonOutput({ deleted: { path } }, res);
  },
};
