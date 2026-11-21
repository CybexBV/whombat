/**
 * The typed tools' requests and answers (docs/decisions/connections-catalog.md CX-34) against stub senders: Dropbox
 * API v2, Nextcloud WebDAV and Todoist API v1, as their documentation describes them.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { ConnectionRequest } from '../http';
import { DROPBOX_FILES, dropboxArg } from './files-dropbox';
import { NEXTCLOUD_FILES, nextcloudUser, parseMultistatus, searchBody } from './files-nextcloud';
import { dueFields, TODOIST_TASKS } from './tasks-todoist';
import type { AdapterContext } from './types';

interface Reply {
  status?: number;
  headers?: IncomingHttpHeaders;
  body?: string | Buffer | object;
}

/** A stub sender: answers in order and keeps every request. */
function stub(base: string, replies: Reply[], fields: Record<string, string> = {}) {
  const seen: (ConnectionRequest & { truncateAt?: number })[] = [];
  const ctx: AdapterContext = {
    baseUrl: base,
    fields,
    bases: { content: 'https://content.dropboxapi.com' },
    async send(req, options) {
      seen.push({ ...req, ...(options?.truncateAt ? { truncateAt: options.truncateAt } : {}) });
      const r = replies.shift() ?? { status: 500 };
      const body =
        r.body === undefined
          ? Buffer.alloc(0)
          : Buffer.isBuffer(r.body)
            ? r.body
            : Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      return {
        status: r.status ?? 200,
        headers: r.headers ?? (typeof r.body === 'object' ? { 'content-type': 'application/json' } : {}),
        body,
      };
    },
  };
  return { ctx, seen };
}

const json = (s: string) => JSON.parse(s);

describe('Dropbox files (API v2)', () => {
  it('lists a folder with list_folder and follows the cursor', async () => {
    const { ctx, seen } = stub('https://api.dropboxapi.com', [
      {
        body: {
          entries: [{ '.tag': 'folder', name: 'Invoices', path_display: '/Invoices' }],
          has_more: true,
          cursor: 'c1',
        },
      },
      {
        body: {
          entries: [
            {
              '.tag': 'file',
              name: 'a.txt',
              path_display: '/a.txt',
              size: 3,
              server_modified: '2026-10-01T10:00:00Z',
            },
          ],
          has_more: false,
        },
      },
    ]);
    const out = await DROPBOX_FILES.files_list?.(ctx, {});
    expect(seen.map((r) => [r.method, r.url])).toEqual([
      ['POST', 'https://api.dropboxapi.com/2/files/list_folder'],
      ['POST', 'https://api.dropboxapi.com/2/files/list_folder/continue'],
    ]);
    expect(json(String(seen[0]?.body))).toEqual({ path: '', limit: 500 });
    expect(json(String(seen[1]?.body))).toEqual({ cursor: 'c1' });
    expect(json(out?.content ?? '')).toEqual({
      path: '/',
      entries: [
        { name: 'Invoices', path: '/Invoices', folder: true },
        { name: 'a.txt', path: '/a.txt', folder: false, size: 3, modified: '2026-10-01T10:00:00Z' },
      ],
      more: false,
    });
  });

  it('downloads on the content base with Dropbox-API-Arg, text as text and binary as a note', async () => {
    const { ctx, seen } = stub('https://api.dropboxapi.com', [
      {
        headers: { 'content-type': 'application/octet-stream', 'dropbox-api-result': '{"size":5}' },
        body: 'hello',
      },
      {
        headers: { 'content-type': 'application/octet-stream', 'dropbox-api-result': '{"size":4}' },
        body: Buffer.from([0, 1, 2, 3]),
      },
    ]);
    const text = await DROPBOX_FILES.files_read?.(ctx, { path: '/Notes/ünï.md' });
    expect(seen[0]?.url).toBe('https://content.dropboxapi.com/2/files/download');
    expect(seen[0]?.headers?.['Dropbox-API-Arg']).toBe('{"path":"/Notes/\\u00fcn\\u00ef.md"}');
    expect(seen[0]?.body).toBeUndefined();
    expect(text?.content).toBe('hello');
    const bin = await DROPBOX_FILES.files_read?.(ctx, { path: '/x.bin' });
    expect(bin?.content).toBe('[binary, 4 bytes; not shown]');
  });

  it('uploads without overwriting unless asked, moves and deletes', async () => {
    const { ctx, seen } = stub('https://api.dropboxapi.com', [
      { body: { '.tag': 'file', name: 'todo.md', path_display: '/todo.md', size: 2 } },
      { status: 409, body: { error_summary: 'from_lookup/not_found/' } },
      { body: { metadata: { '.tag': 'file', name: 'b', path_display: '/b' } } },
    ]);
    await DROPBOX_FILES.files_write?.(ctx, { path: '/todo.md', content: 'hi' });
    expect(json(String(seen[0]?.headers?.['Dropbox-API-Arg']))).toEqual({
      path: '/todo.md',
      mode: 'add',
      autorename: false,
      mute: true,
    });
    expect(seen[0]?.body).toBe('hi');
    const moved = await DROPBOX_FILES.files_move?.(ctx, { from: '/a', to: '/b' });
    expect(moved).toMatchObject({ isError: true, httpStatus: 409 });
    expect(moved?.content).toContain('from_lookup/not_found');
    const gone = await DROPBOX_FILES.files_delete?.(ctx, { path: '/b' });
    expect(seen[2]?.url).toBe('https://api.dropboxapi.com/2/files/delete_v2');
    expect(json(gone?.content ?? '')).toEqual({ deleted: { name: 'b', path: '/b', folder: false } });
  });

  it('escapes non-ASCII in its header argument', () => {
    expect(dropboxArg({ path: '/€' })).toBe('{"path":"/\\u20ac"}');
  });

  it('refuses paths that climb', async () => {
    const { ctx } = stub('https://api.dropboxapi.com', []);
    await expect(DROPBOX_FILES.files_read?.(ctx, { path: '/a/../b' })).rejects.toThrow('“.” and “..”');
  });
});

const MULTISTATUS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
 <d:response><d:href>/remote.php/dav/files/mara/Documents/</d:href><d:propstat><d:prop>
  <d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Thu, 01 Oct 2026 10:00:00 GMT</d:getlastmodified>
 </d:prop></d:propstat></d:response>
 <d:response><d:href>/remote.php/dav/files/mara/Documents/Q3%20report.txt</d:href><d:propstat><d:prop>
  <d:resourcetype/><d:getcontentlength>12</d:getcontentlength><d:getcontenttype>text/plain</d:getcontenttype>
  <d:getlastmodified>Fri, 02 Oct 2026 09:30:00 GMT</d:getlastmodified>
 </d:prop></d:propstat></d:response>
</d:multistatus>`;

describe('Nextcloud files (WebDAV)', () => {
  const fields = { url: 'https://cloud.example.com', username: 'mara' };

  it('lists a folder with PROPFIND depth 1 and reads the multistatus', async () => {
    const { ctx, seen } = stub('https://cloud.example.com', [{ status: 207, body: MULTISTATUS }], fields);
    const out = await NEXTCLOUD_FILES.files_list?.(ctx, { path: '/Documents' });
    expect(seen[0]).toMatchObject({
      method: 'PROPFIND',
      url: 'https://cloud.example.com/remote.php/dav/files/mara/Documents/',
      headers: expect.objectContaining({ Depth: '1' }),
    });
    expect(json(out?.content ?? '')).toEqual({
      path: '/Documents',
      entries: [
        {
          name: 'Q3 report.txt',
          path: '/Documents/Q3 report.txt',
          folder: false,
          size: 12,
          modified: '2026-10-02T09:30:00.000Z',
          type: 'text/plain',
        },
      ],
    });
  });

  it('names the user id in DAV paths, the login name only where none was read yet (SG-15a)', async () => {
    const ldap = { ...fields, username: 'mara', userId: '5f0c1b2a-uuid' };
    const { ctx, seen } = stub(
      'https://cloud.example.com',
      [{ status: 207, body: '<d:multistatus/>' }],
      ldap,
    );
    await NEXTCLOUD_FILES.files_list?.(ctx, { path: '/' });
    expect(seen[0]?.url).toBe('https://cloud.example.com/remote.php/dav/files/5f0c1b2a-uuid/');
    expect(nextcloudUser({ username: 'mara', userId: ' ' })).toBe('mara');
    expect(nextcloudUser({ username: 'mara' })).toBe('mara');
  });

  it('parses any namespace prefix', () => {
    const upper = MULTISTATUS.replace(/d:/g, 'D:').replace(/xmlns:D/g, 'xmlns:D');
    expect(parseMultistatus(upper, '/remote.php/dav/files/mara/').map((e) => e.path)).toEqual([
      '/Documents',
      '/Documents/Q3 report.txt',
    ]);
  });

  it('searches names with SEARCH under the user’s scope, escaping the words', async () => {
    expect(searchBody('mara', '/Documents', '50%_off')).toContain('<d:literal>%50\\%\\_off%</d:literal>');
    expect(searchBody('mara', '/', 'x')).toContain('<d:href>/files/mara</d:href>');
    const { ctx, seen } = stub('https://cloud.example.com', [{ status: 207, body: MULTISTATUS }], fields);
    const out = await NEXTCLOUD_FILES.files_search?.(ctx, { query: 'report' });
    expect(seen[0]).toMatchObject({ method: 'SEARCH', url: 'https://cloud.example.com/remote.php/dav/' });
    expect(json(out?.content ?? '').entries).toHaveLength(2);
  });

  it('writes with MKCOL on the way and If-None-Match unless overwriting', async () => {
    const { ctx, seen } = stub(
      'https://cloud.example.com',
      [{ status: 405 }, { status: 201 }, { status: 201 }, { status: 412 }],
      fields,
    );
    const out = await NEXTCLOUD_FILES.files_write?.(ctx, { path: '/Notes/2026/todo.md', content: 'x' });
    expect(seen.map((r) => [r.method, r.url])).toEqual([
      ['MKCOL', 'https://cloud.example.com/remote.php/dav/files/mara/Notes'],
      ['MKCOL', 'https://cloud.example.com/remote.php/dav/files/mara/Notes/2026'],
      ['PUT', 'https://cloud.example.com/remote.php/dav/files/mara/Notes/2026/todo.md'],
    ]);
    expect(seen[2]?.headers?.['If-None-Match']).toBe('*');
    expect(json(out?.content ?? '')).toEqual({
      written: { path: '/Notes/2026/todo.md', size: 1, created: true },
    });
    const again = await NEXTCLOUD_FILES.files_write?.(ctx, { path: '/a.md', content: 'x' });
    expect(again).toMatchObject({
      isError: true,
      content: 'A file is already there. Pass overwrite: true to replace it.',
    });
  });

  it('moves with a Destination on the same server and no overwrite', async () => {
    const { ctx, seen } = stub('https://cloud.example.com', [{ status: 201 }], fields);
    await NEXTCLOUD_FILES.files_move?.(ctx, { from: '/a b.txt', to: '/Old/a b.txt' });
    expect(seen[0]).toMatchObject({
      method: 'MOVE',
      url: 'https://cloud.example.com/remote.php/dav/files/mara/a%20b.txt',
      headers: {
        Destination: 'https://cloud.example.com/remote.php/dav/files/mara/Old/a%20b.txt',
        Overwrite: 'F',
      },
    });
  });
});

describe('Todoist tasks (API v1)', () => {
  const base = 'https://api.todoist.com';

  it('lists by filter, or by project looked up by name', async () => {
    const { ctx, seen } = stub(base, [
      {
        body: {
          results: [
            {
              id: '6X',
              content: 'Call Ana',
              priority: 4,
              due: { date: '2026-10-05', string: 'today' },
              labels: [],
            },
          ],
          next_cursor: null,
        },
      },
      {
        body: {
          results: [
            { id: 'p1', name: 'Inbox', inbox_project: true },
            { id: 'p2', name: 'Work' },
          ],
        },
      },
      { body: { results: [{ id: '7Y', content: 'Ship', project_id: 'p2' }], next_cursor: 'n' } },
    ]);
    const filtered = await TODOIST_TASKS.tasks_list?.(ctx, { filter: 'today | overdue' });
    expect(seen[0]?.url).toBe(
      'https://api.todoist.com/api/v1/tasks/filter?query=today+%7C+overdue&limit=200',
    );
    expect(json(filtered?.content ?? '')).toEqual({
      tasks: [{ id: '6X', content: 'Call Ana', priority: 4, due: { date: '2026-10-05', text: 'today' } }],
      more: false,
    });
    const work = await TODOIST_TASKS.tasks_list?.(ctx, { project: 'work' });
    expect(seen[2]?.url).toBe('https://api.todoist.com/api/v1/tasks?limit=200&project_id=p2');
    expect(json(work?.content ?? '').more).toBe(true);
  });

  it('adds a task with a date or words, and completes one', async () => {
    expect(dueFields('2026-10-09')).toEqual({ due_date: '2026-10-09' });
    expect(dueFields('tomorrow at 9')).toEqual({ due_string: 'tomorrow at 9' });
    const { ctx, seen } = stub(base, [
      { body: { id: '8Z', content: 'Pay rent', priority: 2 } },
      { status: 204 },
    ]);
    await TODOIST_TASKS.tasks_add?.(ctx, {
      content: 'Pay rent',
      due: 'every 1st',
      priority: 2,
      labels: ['home'],
    });
    expect(seen[0]).toMatchObject({ method: 'POST', url: 'https://api.todoist.com/api/v1/tasks' });
    expect(json(String(seen[0]?.body))).toEqual({
      content: 'Pay rent',
      due_string: 'every 1st',
      priority: 2,
      labels: ['home'],
    });
    const done = await TODOIST_TASKS.tasks_complete?.(ctx, { id: '8Z' });
    expect(seen[1]).toMatchObject({ method: 'POST', url: 'https://api.todoist.com/api/v1/tasks/8Z/close' });
    expect(json(done?.content ?? '')).toEqual({ completed: { id: '8Z' } });
  });

  it('refuses an unknown project, a bad priority and an empty change', async () => {
    const { ctx } = stub(base, [{ body: { results: [{ id: 'p1', name: 'Inbox' }] } }]);
    await expect(TODOIST_TASKS.tasks_add?.(ctx, { content: 'x', project: 'Nope' })).rejects.toThrow(
      'no project',
    );
    await expect(TODOIST_TASKS.tasks_add?.(ctx, { content: 'x', priority: 7 })).rejects.toThrow('priority');
    await expect(TODOIST_TASKS.tasks_update?.(ctx, { id: '1' })).rejects.toThrow('Say what changes');
  });
});
