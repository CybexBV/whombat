import { catalogEntry } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { ConnectionToolRow } from '../connections/types';
import { listedOffers, listedThere } from './listed-actions';
import { isProposableEntry, notOfferedText, outsidersCall } from './proposed-actions';
import { describePlannedAction, proposalCard } from './proposed-card';

function entryOrThrow(id: string) {
  const entry = catalogEntry(id);
  if (!entry) throw new Error(`missing catalog entry ${id}`);
  return entry;
}

type Tool = Pick<ConnectionToolRow, 'name' | 'access' | 'origin'>;
const REQUEST: Tool = { name: 'request', access: 'write', origin: 'request' };
const adapter = (name: string): Tool => ({ name, access: 'write', origin: 'adapter' });

const FIELDS: Record<string, Record<string, string>> = {
  moneybird: { administration: '12345' },
  nextcloud: { url: 'https://cloud.example.com', userId: 'mara', username: 'mara' },
  paperless: { url: 'http://paperless.example.com:8000' },
  homeassistant: { url: 'http://homeassistant.example.com:8123' },
};

/** What an outsiders' run's call comes out as on a catalog entry. */
function call(id: string, args: Record<string, unknown>, tool: Tool = REQUEST, fields = FIELDS[id] ?? {}) {
  return outsidersCall(entryOrThrow(id), { fields }, tool, args, id);
}

/** Why it is refused (null: it may be proposed). */
function refusal(
  id: string,
  args: Record<string, unknown>,
  tool: Tool = REQUEST,
  fields?: Record<string, string>,
) {
  const out = call(id, args, tool, fields);
  return out.ok ? null : out.reason;
}

/** The server's own settled arguments checked again before they run (throws when refused). */
function resent(id: string, args: Record<string, unknown>, tool: Tool = REQUEST, fields = FIELDS[id] ?? {}) {
  const out = outsidersCall(entryOrThrow(id), { fields }, tool, args, id, true);
  if (!out.ok) throw new Error(out.reason);
  return out.args;
}

/** The arguments as Whombat sends them (throws when refused). */
function sent(
  id: string,
  args: Record<string, unknown>,
  tool: Tool = REQUEST,
  fields?: Record<string, string>,
) {
  const out = call(id, args, tool, fields);
  if (!out.ok) throw new Error(out.reason);
  return out.args;
}

const ATT = 'att_0123456789abcdefghij';

describe('what an outsiders’ run may propose: only listed, create-only actions', () => {
  it('has actions only on the kinds of connection a mail automation needs', () => {
    for (const id of ['paperless', 'moneybird', 'dropbox', 'nextcloud', 'todoist', 'homeassistant'])
      expect(isProposableEntry(entryOrThrow(id)), id).toBe(true);
    for (const id of [
      'whombat_servers',
      't3code',
      'device',
      'google',
      'github',
      'custom_api',
      'custom_mcp',
      'truenas',
    ])
      expect(isProposableEntry(entryOrThrow(id)), id).toBe(false);
    const builtin = refusal(
      'whombat_servers',
      { server: 'pve-01' },
      { name: 'guest_power', access: 'write', origin: 'builtin' },
    );
    // The refusal says what a mail automation can do instead.
    expect(builtin).toContain('can’t be proposed');
    expect(builtin).toContain('Paperless-ngx');
    expect(builtin).toContain('Todoist');
  });

  it('lets each listed action through, as Whombat sends it', () => {
    expect(
      sent('paperless', {
        method: 'post',
        path: '/api/documents/post_document/',
        upload: {
          field: 'document',
          attachmentId: ATT,
          fields: {
            title: 'Membership fee',
            correspondent: '4',
            document_type: '2',
            tags: ['3', '7'],
            created: '2026-11-20',
          },
        },
      }),
    ).toEqual({
      method: 'POST',
      path: '/api/documents/post_document/',
      upload: {
        field: 'document',
        attachmentId: ATT,
        fields: {
          title: 'Membership fee',
          created: '2026-11-20',
          correspondent: '4',
          document_type: '2',
          tags: ['3', '7'],
        },
      },
    });
    expect(
      sent('moneybird', {
        method: 'POST',
        path: '/documents/receipts.json',
        body: {
          receipt: { reference: 'R-1', details_attributes: [{ description: 'Coffee', price: '3.50' }] },
        },
      }),
    ).toMatchObject({
      path: '/12345/documents/receipts.json',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(
      sent('todoist', { content: 'Pay the invoice', due: 'Friday', labels: ['bills'] }, adapter('tasks_add')),
    ).toEqual({ content: 'Pay the invoice', due: 'Friday', labels: ['bills'] });
    expect(
      sent('todoist', { method: 'POST', path: '/api/v1/tasks', body: { content: 'Pay it', priority: 4 } }),
    ).toMatchObject({ body: { content: 'Pay it', priority: 4 } });
    expect(
      sent('homeassistant', {
        method: 'POST',
        path: '/api/services/persistent_notification/create',
        body: { title: 'Invoice', message: 'An invoice from Acme came in.' },
      }),
    ).toMatchObject({ headers: { 'Content-Type': 'application/json' } });
    expect(sent('nextcloud', { method: 'MKCOL', path: '/Invoices/2026/' })).toEqual({
      method: 'MKCOL',
      path: '/remote.php/dav/files/mara/Invoices/2026/',
    });
  });

  it('sets the create-only parts itself: never over a file that is there, never a replace', () => {
    // A WebDAV PUT only creates: If-None-Match: * makes Nextcloud refuse it over an existing file.
    expect(
      sent('nextcloud', {
        method: 'PUT',
        path: '/Invoices/acme.pdf',
        upload: { attachmentId: ATT },
      }),
    ).toEqual({
      method: 'PUT',
      path: '/remote.php/dav/files/mara/Invoices/acme.pdf',
      headers: { 'If-None-Match': '*' },
      upload: { attachmentId: ATT },
    });
    expect(sent('nextcloud', { method: 'PUT', path: '/Notes/acme.txt', body: 'Paid.' }).headers).toEqual({
      'If-None-Match': '*',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    // Dropbox's upload is written again with mode add, on the content base, as a raw file.
    const dropbox = sent('dropbox', {
      method: 'POST',
      path: '/2/files/upload',
      headers: { 'Dropbox-API-Arg': '{"path":"/Invoices/acme.pdf"}' },
      upload: { attachmentId: ATT },
    });
    expect(dropbox.base).toBe('content');
    expect(dropbox.headers).toEqual({
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': '{"path":"/Invoices/acme.pdf","mode":"add","autorename":false,"mute":false}',
    });
    // Dropbox's file tool writes new files only.
    expect(sent('dropbox', { path: '/Notes/acme.txt', content: 'Paid.' }, adapter('files_write'))).toEqual({
      path: '/Notes/acme.txt',
      content: 'Paid.',
      overwrite: false,
    });
    // Nextcloud's makes every missing folder on the way first, which the card wouldn't show: its PUT and MKCOL are
    // listed instead, each its own action.
    expect(
      refusal('nextcloud', { path: '/Notes/acme.txt', content: 'Paid.' }, adapter('files_write')),
    ).toContain('can’t propose this');
    // Settling what was settled changes nothing: the card, the hash and the wire agree.
    for (const [kind, args, tool] of [
      ['dropbox', dropbox, REQUEST],
      ['nextcloud', sent('nextcloud', { method: 'PUT', path: '/a.txt', body: 'x' }), REQUEST],
      [
        'dropbox',
        sent('dropbox', { path: '/a.txt', content: 'x' }, adapter('files_write')),
        adapter('files_write'),
      ],
    ] as const)
      expect(resent(kind, args, tool)).toEqual(args);
  });

  it('refuses replacing, moving or copying what is there', () => {
    const put = (headers: Record<string, string>) =>
      refusal('nextcloud', {
        method: 'PUT',
        path: '/a.pdf',
        headers,
        upload: { attachmentId: ATT },
      });
    expect(put({ 'If-None-Match': '"etag-1"' })).toContain('If-None-Match');
    expect(put({ 'If-Match': '*' })).toContain('can’t be sent');
    expect(put({ Overwrite: 'T' })).toContain('can’t be sent');
    for (const method of ['COPY', 'MOVE', 'PROPPATCH', 'LOCK'])
      expect(
        refusal('nextcloud', {
          method,
          path: '/remote.php/dav/files/mara/a.pdf',
          headers: { Destination: '/remote.php/dav/files/mara/b.pdf' },
        }),
        method,
      ).toContain('can’t propose this');
    // Calendars and contacts: a PUT there replaces an event or a contact (and can invite people).
    expect(
      refusal('nextcloud', {
        method: 'PUT',
        path: '/remote.php/dav/calendars/mara/personal/x.ics',
        body: 'BEGIN:VCALENDAR',
      }),
    ).toContain('can’t propose this');
    expect(
      refusal('nextcloud', {
        method: 'PUT',
        path: '/remote.php/dav/addressbooks/users/mara/contacts/x.vcf',
        body: 'BEGIN:VCARD',
      }),
    ).toContain('can’t propose this');
    // Dropbox: any mode but add, in any spelling.
    for (const mode of [
      '"overwrite"',
      '"update"',
      '{".tag":"overwrite"}',
      '{".tag":"update","update":"rev1"}',
    ])
      expect(
        refusal('dropbox', {
          method: 'POST',
          path: '/2/files/upload',
          base: 'content',
          headers: { 'Dropbox-API-Arg': `{"path":"/a.pdf","mode":${mode}}` },
          upload: { attachmentId: ATT },
        }),
        mode,
      ).toContain('only “add”');
    expect(
      refusal('dropbox', { path: '/a.txt', content: 'x', overwrite: true }, adapter('files_write')),
    ).toContain('overwrite');
    for (const path of [
      '/2/files/move_v2',
      '/2/files/copy_v2',
      '/2/files/save_url',
      '/2/files/upload_session/finish',
    ])
      expect(
        refusal('dropbox', { method: 'POST', path, body: { from_path: '/a', to_path: '/b' } }),
        path,
      ).toContain('can’t propose this');
    expect(refusal('dropbox', { from: '/a', to: '/b' }, adapter('files_move'))).toContain(
      'can’t propose this',
    );
    expect(refusal('todoist', { id: '1', content: 'x' }, adapter('tasks_update'))).toContain(
      'can’t propose this',
    );
    expect(refusal('todoist', { method: 'POST', path: '/api/v1/tasks/1', body: { content: 'x' } })).toContain(
      'can’t propose this',
    );
  });

  it('refuses every way of saying delete, purge, prune, format or share the council found', () => {
    const cases: [string, Record<string, unknown>, Tool?][] = [
      // A GraphQL mutation after a comment.
      [
        'gitlab',
        {
          method: 'POST',
          path: '/api/graphql',
          body: { query: '# file it\nmutation { destroyProject(id: 1) }' },
        },
      ],
      ['paperless', { method: 'POST', path: '/api/graphql', body: { query: '# note\nmutation { x }' } }],
      // Methods and paths no list names.
      ['paperless', { method: 'PURGE', path: '/api/documents/1/' }],
      ['nextcloud', { method: 'PURGE', path: '/remote.php/dav/files/mara/a.pdf' }],
      ['paperless', { method: 'POST', path: '/api/prune' }],
      ['paperless', { method: 'DELETE', path: '/api/documents/1/' }],
      ['paperless', { method: 'GET', path: '/api/documents/' }],
      [
        'paperless',
        { method: 'POST', path: '/api/documents/bulk_edit/', body: { documents: [1], action: 'cleanup' } },
      ],
      ['paperless', { method: 'POST', path: '/api/documents/1/notes/', body: { expireNow: true } }],
      ['paperless', { method: 'POST', path: '/api/group/5/user/7' }],
      ['paperless', { method: 'PATCH', path: '/api/documents/1/', body: { owner: 9 } }],
      ['moneybird', { method: 'PATCH', path: '/12345/sales_invoices/9/send_invoice.json', body: {} }],
      ['moneybird', { method: 'POST', path: '/12345/sales_invoices.json', body: { sales_invoice: {} } }],
      [
        'homeassistant',
        { method: 'POST', path: '/api/services/lock/unlock', body: { entity_id: 'lock.front_door' } },
      ],
      [
        'homeassistant',
        { method: 'POST', path: '/api/services/light/turn_on', body: { entity_id: 'light.kitchen' } },
      ],
      [
        'homeassistant',
        {
          method: 'POST',
          path: '/api/services/notify/smtp',
          body: { message: 'hi', target: ['someone@example.com'] },
        },
      ],
      [
        'homeassistant',
        { item: 'milk' },
        { name: 'HassShoppingListAddItem', access: 'write', origin: 'mcp' },
      ],
      // A socket's method.
      [
        'truenas',
        { method: 'disk.format', params: ['sda'] },
        { name: 'call', access: 'write', origin: 'socket' },
      ],
      // Services a mail automation never needs.
      ['pihole', { method: 'POST', path: '/api/dns/blocking', body: { blocking: false } }],
      ['custom_api', { method: 'POST', path: '/anything', body: { a: 1 } }],
    ];
    for (const [id, args, tool] of cases)
      expect(refusal(id, args, tool), `${id} ${JSON.stringify(args)}`).not.toBeNull();
  });

  it('refuses anything a listed action’s schema doesn’t name, however deep', () => {
    const invoice = (extra: Record<string, unknown>) =>
      refusal('moneybird', {
        method: 'POST',
        path: '/documents/purchase_invoices.json',
        body: { purchase_invoice: { reference: 'INV-1', ...extra } },
      });
    expect(invoice({ set_permissions: { view: { users: [99] } } })).toContain('“set_permissions”');
    expect(invoice({ share: { email: 'someone@example.com' } })).toContain('“share”');
    expect(invoice({ delete: { id: 1 } })).toContain('“delete”');
    expect(invoice({ delete: [1, 2, 3] })).toContain('“delete”');
    expect(invoice({ delete_ids: [1] })).toContain('“delete_ids”');
    expect(invoice({ payments_attributes: [{ price: '1' }] })).toContain('isn’t part of this action');
    expect(invoice({ details_attributes: [{ id: '5', _destroy: true }] })).toContain(
      'isn’t part of this action',
    );
    // Unknown fields of the upload, keys beside the request's own, a query.
    expect(
      refusal('paperless', {
        method: 'POST',
        path: '/api/documents/post_document/',
        upload: { field: 'document', attachmentId: ATT, fields: { set_permissions: '{}' } },
      }),
    ).toContain('“set_permissions”');
    expect(
      refusal('paperless', {
        method: 'POST',
        path: '/api/documents/post_document/',
        upload: { field: 'file', attachmentId: ATT },
      }),
    ).toContain('upload.field');
    expect(
      refusal('paperless', {
        method: 'POST',
        path: '/api/documents/post_document/',
        query: { full_perms: 'true' },
        upload: { field: 'document', attachmentId: ATT },
      }),
    ).toContain('query');
    expect(refusal('todoist', { content: 'x', allow_empty: true }, adapter('tasks_add'))).toBe(
      'todoist: “allow_empty” isn’t part of this action.',
    );
    expect(
      refusal('moneybird', {
        method: 'POST',
        path: '/documents/receipts.json',
        body: { receipt: { contact_id: 'acme' } },
      }),
    ).toContain('body.receipt.contact_id: an id');
    expect(refusal('todoist', { content: 'x', assignee_id: '9' }, adapter('tasks_add'))).toContain(
      '“assignee_id”',
    );
    // Values are bounded.
    expect(invoice({ reference: 'x'.repeat(256) })).toContain('at most 255 characters');
    expect(
      invoice({ details_attributes: Array.from({ length: 51 }, () => ({ description: 'x', price: '1' })) }),
    ).toContain('at most 50');
    // A Nextcloud path in someone else's files, refused without naming the connection's user.
    const someone = refusal('nextcloud', {
      method: 'PUT',
      path: '/remote.php/dav/files/someone/a.pdf',
      upload: { attachmentId: ATT },
    });
    expect(someone).toContain('a path in the person’s files');
    expect(someone).not.toContain('mara');
  });

  it('refuses headers that could disagree with the card, and any header the action doesn’t take', () => {
    const json = (headers: Record<string, string>) =>
      refusal('moneybird', {
        method: 'POST',
        path: '/documents/purchase_invoices.json',
        headers,
        body: '{"purchase_invoice":{"reference":"INV-1"}}',
      });
    expect(json({ 'Content-Type': 'application/json', 'content-type': 'text/plain' })).toContain(
      'more than once',
    );
    expect(json({ 'content-type': 'text/plain' })).toContain('Whombat sets it');
    expect(json({ 'X-HTTP-Method-Override': 'DELETE' })).toContain('can’t be sent');
    expect(json({ 'Content-Type': 'application/json; charset=utf-8' })).toBeNull();
    expect(json({ Accept: 'application/json' })).toBeNull();
  });

  it('refuses a value named like a password or key: an outsiders’ run has none, so the card hides nothing', () => {
    expect(
      refusal('moneybird', {
        method: 'POST',
        path: '/documents/purchase_invoices.json',
        body: { purchase_invoice: { reference: 'x' }, auth: { user: 'a', password: 'b' } },
      }),
    ).toContain('“auth”');
    expect(
      refusal('paperless', {
        method: 'POST',
        path: '/api/documents/post_document/',
        headers: { Authorization: 'Token abc' },
        upload: { field: 'document', attachmentId: ATT },
      }),
    ).toContain('“Authorization”');
    expect(
      refusal('dropbox', {
        method: 'POST',
        path: '/2/files/upload',
        headers: { 'Dropbox-API-Arg': '{"path":"/a.pdf","api_key":"x"}' },
        body: 'x',
      }),
    ).toContain('“api_key”');
    expect(
      refusal('todoist', { content: 'x', labels: [], clientSecret: 'y' }, adapter('tasks_add')),
    ).toContain('“clientSecret”');
  });

  it('lets through what was refused wrongly before: long values, access-like words, a user called admin', () => {
    // A ten-line purchase invoice, and the card that shows it whole.
    const lines = Array.from({ length: 10 }, (_, i) => ({
      description: `Membership fee, line ${i + 1}: ${'monthly access for the admin team '.repeat(2)}`,
      price: '42.50',
      amount: '1',
      tax_rate_id: '987654321098765432',
      ledger_account_id: '123456789012345678',
    }));
    const invoice = sent('moneybird', {
      method: 'POST',
      path: '/documents/purchase_invoices.json',
      body: {
        purchase_invoice: {
          contact_id: '424242424242424242',
          reference: 'INV-2042',
          date: '2026-11-20',
          due_date: '2026-12-20',
          currency: 'EUR',
          prices_are_incl_tax: true,
          details_attributes: lines,
        },
      },
    });
    const described = describePlannedAction({
      catalogId: 'moneybird',
      label: 'Moneybird',
      tool: REQUEST,
      args: invoice,
      summary: 'Draft the invoice',
    });
    expect(proposalCard([{ ...described, label: 'Moneybird' }]).ok).toBe(true);
    // A 2,000-character file and task description: wrapped on the card, not refused.
    const note = `${'Pay before Friday and file the receipt with the others. '.repeat(36)}`.slice(0, 2000);
    const file = sent('nextcloud', { method: 'PUT', path: '/Notes/acme.txt', body: note }, REQUEST, {
      userId: 'admin',
    });
    const fileCard = describePlannedAction({
      catalogId: 'nextcloud',
      label: 'Nextcloud',
      tool: REQUEST,
      args: file,
    });
    expect(proposalCard([{ ...fileCard, label: 'Nextcloud' }]).ok).toBe(true);
    const task = sent('todoist', { content: 'Membership fee', description: note }, adapter('tasks_add'));
    const taskCard = describePlannedAction({
      catalogId: 'todoist',
      label: 'Todoist',
      tool: adapter('tasks_add'),
      args: task,
    });
    expect(proposalCard([{ ...taskCard, label: 'Todoist' }]).ok).toBe(true);
    // A notification that mentions a door unlocks nothing.
    expect(
      refusal('homeassistant', {
        method: 'POST',
        path: '/api/services/persistent_notification/create',
        body: { message: 'The parcel is at the front door; the garage invoice is paid.' },
      }),
    ).toBeNull();
    // Words that once read as access or deleting are just words in a value.
    expect(
      refusal('paperless', {
        method: 'POST',
        path: '/api/documents/post_document/',
        upload: {
          field: 'document',
          attachmentId: ATT,
          fields: { title: 'Remove old share: admin password reset' },
        },
      }),
    ).toBeNull();
  });

  it('reads a JSON text body as the JSON it is, and refuses a number it can’t send exactly', () => {
    expect(
      sent('moneybird', {
        method: 'POST',
        path: '/documents/purchase_invoices.json',
        body: '{"purchase_invoice":{"reference":"INV-1"}}',
      }).body,
    ).toEqual({ purchase_invoice: { reference: 'INV-1' } });
    expect(
      refusal('moneybird', {
        method: 'POST',
        path: '/documents/purchase_invoices.json',
        body: '{"purchase_invoice":{"contact_id":424242424242424242424}}',
      }),
    ).toContain('too large to send exactly');
  });
  it('takes paths without the person’s account ids and writes the connection’s own in', () => {
    // Moneybird: from /documents/, the administration put in front by the server.
    expect(
      sent('moneybird', {
        method: 'POST',
        path: '/documents/purchase_invoices.json',
        body: { purchase_invoice: { reference: 'INV-1' } },
      }).path,
    ).toBe('/12345/documents/purchase_invoices.json');
    expect(
      sent('moneybird', {
        method: 'POST',
        path: '/documents/receipts',
        body: { receipt: { reference: 'R-1' } },
      }).path,
    ).toBe('/12345/documents/receipts');
    // Nextcloud: a path from the root of the person's files, the WebDAV part with their user id put in front.
    const put = sent('nextcloud', {
      method: 'PUT',
      path: '/Invoices/acme%20bv.pdf',
      upload: { attachmentId: ATT },
    });
    expect(put.path).toBe('/remote.php/dav/files/mara/Invoices/acme%20bv.pdf');
    expect(sent('nextcloud', { method: 'MKCOL', path: '/Invoices/2026/' }).path).toBe(
      '/remote.php/dav/files/mara/Invoices/2026/',
    );
    // The user id, not the login name, when they differ (an LDAP account), written as a path segment.
    expect(
      sent('nextcloud', { method: 'PUT', path: '/a.txt', body: 'x' }, REQUEST, {
        url: 'https://cloud.example.com',
        username: 'mara',
        userId: 'mara@example.com',
      }).path,
    ).toBe('/remote.php/dav/files/mara%40example.com/a.txt');
    // Settling what was settled changes nothing: the card, the hash and the wire agree.
    for (const [kind, args] of [
      [
        'moneybird',
        sent('moneybird', {
          method: 'POST',
          path: '/documents/purchase_invoices.json',
          body: { purchase_invoice: { reference: 'INV-1' } },
        }),
      ],
      ['nextcloud', put],
      ['nextcloud', sent('nextcloud', { method: 'MKCOL', path: '/Invoices/' })],
    ] as const)
      expect(resent(kind, args)).toEqual(args);
  });

  it('refuses an agent’s path that names an account id with the same words, right or wrong', () => {
    const invoice = (path: string) => ({
      method: 'POST',
      path,
      body: { purchase_invoice: { reference: 'INV-1' } },
    });
    const right = refusal('moneybird', invoice('/12345/documents/purchase_invoices.json'));
    const wrong = refusal('moneybird', invoice('/99999/documents/purchase_invoices.json'));
    expect(right).not.toBeNull();
    expect(right).toBe(wrong);
    expect(refusal('moneybird', invoice('/%31%32%33%34%35/documents/purchase_invoices.json'))).toBe(wrong);
    const file = (user: string) => ({
      method: 'PUT',
      path: `/remote.php/dav/files/${user}/a.txt`,
      body: 'x',
    });
    const own = refusal('nextcloud', file('mara'));
    expect(own).not.toBeNull();
    expect(own).toBe(refusal('nextcloud', file('someone')));
    expect(refusal('nextcloud', { method: 'MKCOL', path: '/remote.php/dav/files/mara/Invoices/' })).toBe(
      refusal('nextcloud', { method: 'MKCOL', path: '/remote.php/dav/files/someone/Invoices/' }),
    );
    for (const reason of [right, own]) expect(reason).not.toMatch(/12345|mara/);
    // Only the server's own settled arguments, checked again before they run, keep the id it filled in, and only that
    // one.
    expect(resent('moneybird', invoice('/12345/documents/purchase_invoices.json')).path).toBe(
      '/12345/documents/purchase_invoices.json',
    );
    expect(() => resent('moneybird', invoice('/99999/documents/purchase_invoices.json'))).toThrow();
    expect(resent('nextcloud', file('mara')).path).toBe('/remote.php/dav/files/mara/a.txt');
    expect(() => resent('nextcloud', file('someone'))).toThrow();
  });

  it('never says an account id the agent didn’t write, in what it lists or what it refuses', () => {
    const tools = [
      { name: 'request', origin: 'request' as const },
      { name: 'files_write', origin: 'adapter' as const },
    ];
    const how = [...listedOffers('moneybird', tools), ...listedOffers('nextcloud', tools)]
      .map((offer) => offer.how)
      .join('\n');
    expect(how).toContain('POST /documents/purchase_invoices.json');
    expect(how).toContain('PUT /<folder>/<name>');
    expect(how).not.toMatch(/<administration>|<user id>|remote\.php|files_write/);
    const refusals = [
      // Another administration, a guess, or none chosen yet.
      refusal('moneybird', {
        method: 'POST',
        path: '/99999/documents/purchase_invoices.json',
        body: { purchase_invoice: { reference: 'INV-1' } },
      }),
      refusal(
        'moneybird',
        { method: 'POST', path: '/documents/receipts.json', body: { receipt: { reference: 'R-1' } } },
        REQUEST,
        {},
      ),
      // Someone else's files, a path outside them, a bad path, a connection that doesn't know its user yet.
      refusal('nextcloud', { method: 'MKCOL', path: '/remote.php/dav/files/someone/Invoices/' }),
      refusal('nextcloud', { method: 'PUT', path: '/Invoices/../a.pdf', upload: { attachmentId: ATT } }),
      refusal('nextcloud', { method: 'PUT', path: '/Invoices/', body: 'x' }),
      refusal('nextcloud', { method: 'PUT', path: '/a.txt', body: 'x' }, REQUEST, {
        url: 'https://cloud.example.com',
      }),
    ];
    for (const reason of refusals) {
      expect(reason).not.toBeNull();
      expect(reason).not.toMatch(/12345|mara/);
    }
    expect(refusals[0]).toContain('/documents/');
    expect(refusals[1]).toContain('no administration');
    expect(refusals[5]).toContain('doesn’t know its user');
  });

  it('keeps text as text: a file, a note or a task that starts with { or [ is never read as JSON', () => {
    const json = '{"total": 420, "token": "abc", "items": [1, 2]}';
    const file = sent('nextcloud', { method: 'PUT', path: '/Notes/order.json', body: json });
    expect(file.body).toBe(json);
    expect(file.headers).toMatchObject({ 'Content-Type': 'text/plain; charset=utf-8' });
    expect(
      sent('dropbox', {
        method: 'POST',
        path: '/2/files/upload',
        base: 'content',
        headers: { 'Dropbox-API-Arg': '{"path":"/Notes/list.txt"}' },
        body: '[1, 2, 3]',
      }).body,
    ).toBe('[1, 2, 3]');
    expect(sent('dropbox', { path: '/a.json', content: json }, adapter('files_write')).content).toBe(json);
    expect(
      sent('todoist', { content: 'Check the order', description: json }, adapter('tasks_add')).description,
    ).toBe(json);
    expect(
      sent('todoist', {
        method: 'POST',
        path: '/api/v1/tasks',
        body: { content: 'Check it', description: '[{"password": 1}]' },
      }).body,
    ).toEqual({ content: 'Check it', description: '[{"password": 1}]' });
    expect(
      sent('homeassistant', {
        method: 'POST',
        path: '/api/services/persistent_notification/create',
        body: { message: '{"secret": true}' },
      }).body,
    ).toEqual({ message: '{"secret": true}' });
    // A JSON body is still the JSON it says, a secret in it still refused.
    expect(
      sent('todoist', { method: 'POST', path: '/api/v1/tasks', body: '{"content":"Pay it"}' }).body,
    ).toEqual({ content: 'Pay it' });
    expect(
      refusal('moneybird', {
        method: 'POST',
        path: '/documents/purchase_invoices.json',
        body: '{"purchase_invoice":{"reference":"x"},"auth":{"password":"b"}}',
      }),
    ).toContain('“auth”');
  });

  it('counts a folder that is there already as done, and nothing else', () => {
    const mkcol = sent('nextcloud', { method: 'MKCOL', path: '/Invoices/' });
    expect(listedThere({ catalogId: 'nextcloud', label: 'Nextcloud', tool: REQUEST, args: mkcol })).toEqual({
      status: 405,
      done: 'found the folder already in Nextcloud',
    });
    const put = sent('nextcloud', { method: 'PUT', path: '/Invoices/a.pdf', upload: { attachmentId: ATT } });
    expect(listedThere({ catalogId: 'nextcloud', label: 'Nextcloud', tool: REQUEST, args: put })).toBeNull();
  });
});

describe('what an outsiders’ turn hears of what the person has', () => {
  it('marks a refusal for the person’s setup apart from one for the arguments', () => {
    const theirs = [
      call(
        'whombat_servers',
        { server: 'pve-01' },
        { name: 'guest_power', access: 'write', origin: 'builtin' },
      ),
      call('paperless', { method: 'DELETE', path: '/api/documents/1/' }),
      call('dropbox', { path: '/old.pdf' }, adapter('files_delete')),
    ];
    for (const out of theirs) expect(out).toMatchObject({ ok: false, offered: false });
    // A listed action with an argument it doesn't take: about the agent's own arguments, said as it is.
    const own = call('paperless', {
      method: 'POST',
      path: '/api/documents/post_document/',
      upload: { field: 'document', attachmentId: ATT, fields: { title: 'x'.repeat(200) } },
    });
    expect(own.ok).toBe(false);
    expect(own).not.toHaveProperty('offered');
  });

  it('says the same words for any action it wasn’t offered, naming nothing of the person’s', () => {
    const words = notOfferedText('paperless');
    expect(words).toContain('“paperless”');
    expect(words).toContain('can’t be proposed');
    // The handle as the agent wrote it, on one line; whatever else differs, the words don't.
    expect(notOfferedText('  github\nnow ')).toBe(notOfferedText('github now'));
    expect(notOfferedText('servers').replace('servers', 'paperless')).toBe(words);
  });
});
