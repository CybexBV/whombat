import { catalogEntry } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import type { ConnectionToolRow } from '../connections/types';
import { isProposableEntry, outsidersCall } from './proposed-actions';
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
        path: '/12345/documents/receipts.json',
        body: {
          receipt: { reference: 'R-1', details_attributes: [{ description: 'Coffee', price: '3.50' }] },
        },
      }),
    ).toMatchObject({ headers: { 'Content-Type': 'application/json' } });
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
    expect(sent('nextcloud', { method: 'MKCOL', path: '/remote.php/dav/files/mara/Invoices/2026/' })).toEqual(
      { method: 'MKCOL', path: '/remote.php/dav/files/mara/Invoices/2026/' },
    );
  });

  it('sets the create-only parts itself: never over a file that is there, never a replace', () => {
    // A WebDAV PUT only creates: If-None-Match: * makes Nextcloud refuse it over an existing file.
    expect(
      sent('nextcloud', {
        method: 'PUT',
        path: '/remote.php/dav/files/mara/Invoices/acme.pdf',
        upload: { attachmentId: ATT },
      }),
    ).toEqual({
      method: 'PUT',
      path: '/remote.php/dav/files/mara/Invoices/acme.pdf',
      headers: { 'If-None-Match': '*' },
      upload: { attachmentId: ATT },
    });
    expect(
      sent('nextcloud', { method: 'PUT', path: '/remote.php/dav/files/mara/Notes/acme.txt', body: 'Paid.' })
        .headers,
    ).toEqual({ 'If-None-Match': '*', 'Content-Type': 'text/plain; charset=utf-8' });
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
    // The file tools write new files only.
    for (const kind of ['dropbox', 'nextcloud'])
      expect(sent(kind, { path: '/Notes/acme.txt', content: 'Paid.' }, adapter('files_write'))).toEqual({
        path: '/Notes/acme.txt',
        content: 'Paid.',
        overwrite: false,
      });
    // Settling what was settled changes nothing: the card, the hash and the wire agree.
    for (const [kind, args, tool] of [
      ['dropbox', dropbox, REQUEST],
      [
        'nextcloud',
        sent('nextcloud', { method: 'PUT', path: '/remote.php/dav/files/mara/a.txt', body: 'x' }),
        REQUEST,
      ],
      [
        'dropbox',
        sent('dropbox', { path: '/a.txt', content: 'x' }, adapter('files_write')),
        adapter('files_write'),
      ],
    ] as const)
      expect(sent(kind, args, tool)).toEqual(args);
  });

  it('refuses replacing, moving or copying what is there', () => {
    const put = (headers: Record<string, string>) =>
      refusal('nextcloud', {
        method: 'PUT',
        path: '/remote.php/dav/files/mara/a.pdf',
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
        path: '/12345/documents/purchase_invoices.json',
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
    expect(refusal('todoist', { content: 'x', allow_empty: true }, adapter('tasks_add'))).toContain(
      '“allow_empty”',
    );
    expect(refusal('todoist', { content: 'x', assignee_id: '9' }, adapter('tasks_add'))).toContain(
      '“assignee_id”',
    );
    // Values are bounded.
    expect(invoice({ reference: 'x'.repeat(256) })).toContain('at most 255 characters');
    expect(
      invoice({ details_attributes: Array.from({ length: 51 }, () => ({ description: 'x', price: '1' })) }),
    ).toContain('at most 50');
    // A Nextcloud path outside the connection's own files.
    expect(
      refusal('nextcloud', {
        method: 'PUT',
        path: '/remote.php/dav/files/someone/a.pdf',
        upload: { attachmentId: ATT },
      }),
    ).toContain('/remote.php/dav/files/mara/');
  });

  it('refuses headers that could disagree with the card, and any header the action doesn’t take', () => {
    const json = (headers: Record<string, string>) =>
      refusal('moneybird', {
        method: 'POST',
        path: '/12345/documents/purchase_invoices.json',
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
        path: '/12345/documents/purchase_invoices.json',
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
      path: '/12345/documents/purchase_invoices.json',
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
    const file = sent(
      'nextcloud',
      { method: 'PUT', path: '/remote.php/dav/files/admin/Notes/acme.txt', body: note },
      REQUEST,
      {
        userId: 'admin',
      },
    );
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
        path: '/12345/documents/purchase_invoices.json',
        body: '{"purchase_invoice":{"reference":"INV-1"}}',
      }).body,
    ).toEqual({ purchase_invoice: { reference: 'INV-1' } });
    expect(
      refusal('moneybird', {
        method: 'POST',
        path: '/12345/documents/purchase_invoices.json',
        body: '{"purchase_invoice":{"contact_id":424242424242424242424}}',
      }),
    ).toContain('too large to send exactly');
  });
});
