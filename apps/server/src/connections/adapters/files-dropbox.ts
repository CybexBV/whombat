/**
 * Dropbox's `files_*` tools (docs/decisions/connections-catalog.md CX-34, CX-58) over API v2: every call is a POST;
 * RPC endpoints on `api.dropboxapi.com` take JSON, content endpoints on `content.dropboxapi.com` take their arguments in
 * the `Dropbox-API-Arg` header (non-ASCII escaped as \uXXXX) and the file as the body. Paths start with `/`; the root is
 * `""` to Dropbox. Errors answer 409 with an `error_summary`, returned as data.
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
  parseJson,
  str,
} from './types';

const CONTENT_BASE = 'https://content.dropboxapi.com';
/** Entries `files_list` reads at most (list_folder pages of up to 500). */
const LIST_MAX = 2000;

/** A tool path as Dropbox writes it: `""` for the root. */
export function dropboxPath(path: string): string {
  return path === '/' ? '' : path;
}

/** `Dropbox-API-Arg`: JSON with every non-ASCII character escaped (the header must be ASCII). */
export function dropboxArg(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

interface DropboxMetadata {
  '.tag'?: string;
  name?: string;
  path_display?: string;
  size?: number;
  server_modified?: string;
}

/** One entry as `files_list` and `files_search` answer it. */
export function dropboxEntry(m: DropboxMetadata) {
  return {
    name: m.name ?? '',
    path: m.path_display ?? '',
    folder: m['.tag'] === 'folder',
    ...(typeof m.size === 'number' ? { size: m.size } : {}),
    ...(m.server_modified ? { modified: m.server_modified } : {}),
  };
}

async function rpc(ctx: AdapterContext, endpoint: string, body: unknown) {
  const res = await ctx.send({
    method: 'POST',
    url: `${ctx.baseUrl}/2/${endpoint}`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, json: res.status < 300 ? parseJson(res.body) : null };
}

function contentBase(ctx: AdapterContext): string {
  return (ctx.bases.content ?? CONTENT_BASE).replace(/\/+$/, '');
}

export const DROPBOX_FILES: Adapter = {
  async files_list(ctx, args) {
    const path = filePath(args, 'path', '/');
    let { res, json } = await rpc(ctx, 'files/list_folder', { path: dropboxPath(path), limit: 500 });
    if (res.status >= 300) return errorOutput('Dropbox', res);
    const entries: ReturnType<typeof dropboxEntry>[] = [];
    let page = json as { entries?: DropboxMetadata[]; has_more?: boolean; cursor?: string } | null;
    let bytes = res.body.length;
    while (page) {
      for (const e of page.entries ?? []) entries.push(dropboxEntry(e));
      if (!page.has_more || !page.cursor || entries.length >= LIST_MAX) break;
      ({ res, json } = await rpc(ctx, 'files/list_folder/continue', { cursor: page.cursor }));
      bytes += res.body.length;
      if (res.status >= 300) return errorOutput('Dropbox', res);
      page = json as typeof page;
    }
    const more = Boolean(page?.has_more);
    return { ...jsonOutput({ path, entries: entries.slice(0, LIST_MAX), more }, res), bytes };
  },

  async files_search(ctx, args) {
    const query = str(args, 'query');
    const within = optStr(args, 'path');
    const { res, json } = await rpc(ctx, 'files/search_v2', {
      query,
      options: {
        ...(within ? { path: dropboxPath(filePath(args, 'path')) } : {}),
        max_results: 100,
      },
    });
    if (res.status >= 300) return errorOutput('Dropbox', res);
    const found = json as { matches?: { metadata?: { metadata?: DropboxMetadata } }[]; has_more?: boolean };
    const entries = (found?.matches ?? []).flatMap((m) =>
      m.metadata?.metadata ? [dropboxEntry(m.metadata.metadata)] : [],
    );
    return jsonOutput({ query, entries, more: Boolean(found?.has_more) }, res);
  },

  async files_read(ctx, args) {
    const path = filePath(args, 'path');
    const res = await ctx.send(
      {
        method: 'POST',
        url: `${contentBase(ctx)}/2/files/download`,
        headers: { 'Dropbox-API-Arg': dropboxArg({ path: dropboxPath(path) }) },
      },
      { truncateAt: CONNECTION_OUTPUT_MAX + 1 },
    );
    if (res.status >= 300) return errorOutput('Dropbox', res);
    const meta = res.headers['dropbox-api-result'];
    const size =
      typeof meta === 'string' ? (parseJson(Buffer.from(meta)) as DropboxMetadata | null)?.size : null;
    return fileOutput(path, res, typeof size === 'number' ? size : null);
  },

  async files_write(ctx, args) {
    const path = filePath(args, 'path');
    if (path === '/') throw new ConnectionArgumentError('path: name a file, not the root.');
    const content = args.content;
    if (typeof content !== 'string') throw new ConnectionArgumentError('content: the text to write.');
    if (Buffer.byteLength(content) > VAULT_REQUEST_BODY_MAX)
      throw new ConnectionArgumentError('content: larger than 256 KB.');
    const overwrite = args.overwrite === true;
    const res = await ctx.send({
      method: 'POST',
      url: `${contentBase(ctx)}/2/files/upload`,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': dropboxArg({
          path,
          mode: overwrite ? 'overwrite' : 'add',
          autorename: false,
          mute: true,
        }),
      },
      body: content,
    });
    if (res.status >= 300) return errorOutput('Dropbox', res);
    return jsonOutput({ written: dropboxEntry((parseJson(res.body) ?? {}) as DropboxMetadata) }, res);
  },

  async files_move(ctx, args) {
    const from = filePath(args, 'from');
    const to = filePath(args, 'to');
    const { res, json } = await rpc(ctx, 'files/move_v2', {
      from_path: from,
      to_path: to,
      autorename: false,
    });
    if (res.status >= 300) return errorOutput('Dropbox', res);
    const moved = (json as { metadata?: DropboxMetadata } | null)?.metadata ?? {};
    return jsonOutput({ moved: dropboxEntry(moved) }, res);
  },

  async files_delete(ctx, args) {
    const path = filePath(args, 'path');
    if (path === '/') throw new ConnectionArgumentError('path: the root can’t be deleted.');
    const { res, json } = await rpc(ctx, 'files/delete_v2', { path });
    if (res.status >= 300) return errorOutput('Dropbox', res);
    const gone = (json as { metadata?: DropboxMetadata } | null)?.metadata ?? {};
    return jsonOutput({ deleted: dropboxEntry(gone) }, res);
  },
};
