import { catalogEntry } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { isProposableEntry, proposeCallRefusal, proposedRequestArgs } from './proposed-actions';

function entryOrThrow(id: string) {
  const entry = catalogEntry(id);
  if (!entry) throw new Error(`missing catalog entry ${id}`);
  return entry;
}

const REQUEST = { name: 'request', access: 'write', origin: 'request' } as const;

/** Why an outsiders' run may not propose a `request` call on a catalog entry (null: it may). */
function requestRefusal(id: string, args: Record<string, unknown>): string | null {
  return proposeCallRefusal(entryOrThrow(id), REQUEST, args, id);
}

describe('proposed connection action narrowing', () => {
  it('blocks whombat_servers, t3code, device, and non-callable builtins while allowing ordinary services', () => {
    expect(isProposableEntry(entryOrThrow('whombat_servers'))).toBe(false);
    expect(isProposableEntry(entryOrThrow('t3code'))).toBe(false);
    expect(isProposableEntry(entryOrThrow('device'))).toBe(false);
    expect(isProposableEntry(entryOrThrow('google'))).toBe(false);
    expect(isProposableEntry(entryOrThrow('github'))).toBe(false);

    expect(isProposableEntry(entryOrThrow('paperless'))).toBe(true);
    expect(isProposableEntry(entryOrThrow('moneybird'))).toBe(true);
    expect(isProposableEntry(entryOrThrow('dropbox'))).toBe(true);
    expect(isProposableEntry(entryOrThrow('todoist'))).toBe(true);
    expect(isProposableEntry(entryOrThrow('truenas'))).toBe(true);
  });

  it('refuses disallowed services, DELETE calls, and read-only calls with plain reasons', () => {
    const dropbox = entryOrThrow('dropbox');
    const truenas = entryOrThrow('truenas');

    expect(
      proposeCallRefusal(
        entryOrThrow('whombat_servers'),
        { name: 'guest_power', access: 'write', origin: 'builtin' },
        { server: 'pve-01', guest: 'pve:101', action: 'start' },
        'servers',
      ),
    ).toContain('can’t be proposed');
    expect(
      proposeCallRefusal(
        entryOrThrow('t3code'),
        { name: 't3_thread_launch', access: 'write', origin: 'mcp' },
        { projectId: 'p1', title: 'hi', message: 'run' },
        't3',
      ),
    ).toContain('can’t be proposed');

    expect(requestRefusal('paperless', { method: 'DELETE', path: '/api/documents/1/' })).toContain('DELETE');
    expect(requestRefusal('paperless', { method: 'GET', path: '/api/documents/' })).toContain(
      'read-only GET',
    );
    expect(requestRefusal('paperless', { method: 'HEAD', path: '/api/documents/' })).toContain(
      'read-only HEAD',
    );
    expect(
      proposeCallRefusal(
        dropbox,
        { name: 'files_list', access: 'read', origin: 'adapter' },
        { path: '/' },
        'dropbox',
      ),
    ).toContain('read-only');
    expect(
      proposeCallRefusal(
        dropbox,
        { name: 'files_delete', access: 'write', origin: 'adapter' },
        { path: '/invoice.pdf' },
        'dropbox',
      ),
    ).toContain('“delete”');
    expect(
      proposeCallRefusal(
        truenas,
        { name: 'call', access: 'write', origin: 'socket' },
        { method: 'pool.query', params: [] },
        'truenas',
      ),
    ).toContain('read-only');
    expect(
      proposeCallRefusal(
        truenas,
        { name: 'call', access: 'write', origin: 'socket' },
        { method: 'pool.dataset.delete', params: ['tank/old'] },
        'truenas',
      ),
    ).toContain('“delete”');
  });

  it('refuses the four calls the council found, each with its plain reason', () => {
    // Paperless-ngx: a bulk edit whose method deletes ten documents.
    expect(
      requestRefusal('paperless', {
        method: 'POST',
        path: '/api/documents/bulk_edit/',
        body: { documents: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], method: 'delete', parameters: {} },
      }),
    ).toContain('“delete”');
    // Pi-hole: the DNS servers every device uses.
    expect(
      requestRefusal('pihole', {
        method: 'PATCH',
        path: '/api/config',
        body: { config: { dns: { upstreams: ['203.0.113.9'] } } },
      }),
    ).toContain('DNS');
    // AdGuard Home: where it sends DNS queries.
    expect(
      requestRefusal('adguard', {
        method: 'POST',
        path: '/control/dns_config',
        body: { upstream_dns: ['203.0.113.9'] },
      }),
    ).toContain('DNS');
    // AdGuard Home: removing a client, named only in the path.
    expect(
      requestRefusal('adguard', {
        method: 'POST',
        path: '/control/clients/delete',
        body: { name: 'Laptop' },
      }),
    ).toContain('“delete”');
  });

  it('refuses deleting however it is said: names, paths, method-like values, switches, raw bodies and code', () => {
    const mcp = (name: string, args: Record<string, unknown> = {}) =>
      proposeCallRefusal(entryOrThrow('homeassistant'), { name, access: 'write', origin: 'mcp' }, args, 'ha');
    // Tool names in camelCase, snake_case and kebab-case, with every synonym.
    expect(mcp('deleteFile')).toContain('“delete”');
    expect(mcp('removeItem')).toContain('“remove”');
    expect(mcp('purge_cache')).toContain('“purge”');
    expect(mcp('HassListRemoveItem')).toContain('“remove”');
    for (const word of ['trash', 'clear', 'reset', 'wipe', 'destroy', 'unlink', 'erase', 'drop', 'empty']) {
      expect(mcp(`${word}-everything`)).toContain(`“${word}”`);
      expect(mcp(`do${word.charAt(0).toUpperCase()}${word.slice(1)}All`)).toContain(`“${word}”`);
    }
    // A path segment, percent-encoded or not.
    expect(requestRefusal('qbittorrent', { method: 'POST', path: '/api/v2/torrents/delete' })).toContain(
      '“delete”',
    );
    expect(requestRefusal('paperless', { method: 'POST', path: '/api/trash/' })).toContain('“trash”');
    // What a method-, action-, op-, command-, type- or api-like key says, at any depth.
    expect(
      requestRefusal('paperless', {
        method: 'POST',
        path: '/api/documents/bulk_edit/',
        body: { documents: [1], method: 'remove_tag', parameters: { tag: 3 } },
      }),
    ).toContain('“remove”');
    expect(
      requestRefusal('paperless', {
        method: 'PATCH',
        path: '/api/documents/1/',
        body: [{ op: 'remove', path: '/tags/0' }],
      }),
    ).toContain('“remove”');
    expect(
      requestRefusal('synology', {
        method: 'POST',
        path: '/webapi/entry.cgi',
        query: { api: 'SYNO.FileStation.Delete', method: 'start', version: '2', path: '/home' },
      }),
    ).toContain('“delete”');
    expect(
      requestRefusal('paperless', {
        method: 'POST',
        path: '/api/documents/bulk_edit/',
        body: { nested: { deeper: { bulkActionType: 'purge' } } },
      }),
    ).toContain('“purge”');
    // A switch that turns deleting on: `delete_originals`, Rails' `_destroy`, `deleteFiles` in a raw form body.
    expect(
      requestRefusal('paperless', {
        method: 'POST',
        path: '/api/documents/bulk_edit/',
        body: { documents: [1, 2], method: 'merge', parameters: { delete_originals: true } },
      }),
    ).toContain('“delete”');
    expect(
      requestRefusal('moneybird', {
        method: 'PATCH',
        path: '/12345/sales_invoices/9.json',
        body: { sales_invoice: { details_attributes: [{ id: '1', _destroy: true }] } },
      }),
    ).toContain('“destroy”');
    expect(
      requestRefusal('qbittorrent', {
        method: 'POST',
        path: '/api/v2/torrents/stop',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'hashes=all&deleteFiles=true',
      }),
    ).toContain('“delete”');
    // A raw JSON text body says it just the same.
    expect(
      requestRefusal('paperless', {
        method: 'POST',
        path: '/api/documents/bulk_edit/',
        body: '{"documents":[1],"method":"delete"}',
      }),
    ).toContain('“delete”');
    // A method override in a header or the query.
    expect(
      requestRefusal('paperless', {
        method: 'POST',
        path: '/api/documents/1/',
        headers: { 'X-HTTP-Method-Override': 'DELETE' },
      }),
    ).toContain('“delete”');
    expect(
      requestRefusal('paperless', {
        method: 'POST',
        path: '/api/documents/1/',
        query: { _method: 'delete' },
      }),
    ).toContain('“delete”');
    // Code a service runs: a GraphQL mutation, SQL.
    expect(
      requestRefusal('unraid', {
        method: 'POST',
        path: '/graphql',
        body: { query: 'mutation { docker { removeContainer(id: "1") } }' },
      }),
    ).toContain('“remove”');
    expect(
      proposeCallRefusal(
        entryOrThrow('homeassistant'),
        { name: 'run_sql', access: 'write', origin: 'mcp' },
        { sql: 'DROP TABLE states' },
        'ha',
      ),
    ).toContain('“drop”');
  });

  it('refuses what the connection always asks about, and changes that can cut the person off', () => {
    // The catalog's own sensitive rules: Pi-hole blocking off (also as raw JSON text), Moneybird sending, HA locks.
    expect(
      requestRefusal('pihole', { method: 'POST', path: '/api/dns/blocking', body: '{"blocking": false}' }),
    ).toContain('turns blocking off');
    expect(
      requestRefusal('moneybird', {
        method: 'PATCH',
        path: '/12345/sales_invoices/9/send_invoice.json',
        body: {},
      }),
    ).toContain('sends invoices');
    expect(
      requestRefusal('homeassistant', {
        method: 'POST',
        path: '/api/services/lock/unlock',
        body: { entity_id: 'lock.front_door' },
      }),
    ).toContain('can’t propose this');
    // DNS, DHCP, firewalls and networks elsewhere (the catalog's `cutsOff`).
    expect(
      requestRefusal('tailscale', {
        method: 'POST',
        path: '/api/v2/tailnet/-/dns/nameservers',
        body: { dns: ['203.0.113.9'] },
      }),
    ).toContain('DNS');
    expect(
      requestRefusal('cloudflare', {
        method: 'PATCH',
        path: '/client/v4/zones/abc/dns_records/def',
        body: { content: '203.0.113.9' },
      }),
    ).toContain('DNS');
    expect(
      requestRefusal('opnsense', {
        method: 'POST',
        path: '/api/unbound/settings/addHostOverride',
        body: { host: { hostname: 'bank', domain: 'example.com', server: '203.0.113.9' } },
      }),
    ).toContain('DNS');
    expect(
      requestRefusal('hetzner', { method: 'PUT', path: '/v1/firewalls/1', body: { rules: [] } }),
    ).toContain('firewall');
    expect(
      requestRefusal('adguard', {
        method: 'POST',
        path: '/control/rewrite/add',
        body: { domain: 'bank.example.com', answer: '203.0.113.9' },
      }),
    ).toContain('another address');
  });

  it('lets ordinary writes through: upload a document, add a tag, draft an invoice, write a file', () => {
    expect(
      requestRefusal('paperless', {
        method: 'POST',
        path: '/api/documents/post_document/',
        upload: { field: 'document', attachmentId: 'att_123', fields: { title: 'Clear glass invoice' } },
      }),
    ).toBeNull();
    expect(
      requestRefusal('paperless', { method: 'POST', path: '/api/tags/', body: { name: 'Invoices' } }),
    ).toBeNull();
    expect(
      requestRefusal('paperless', {
        method: 'POST',
        path: '/api/documents/bulk_edit/',
        body: { documents: [1, 2], method: 'add_tag', parameters: { tag: 3 } },
      }),
    ).toBeNull();
    expect(
      requestRefusal('moneybird', {
        method: 'POST',
        path: '/12345/sales_invoices.json',
        body: {
          sales_invoice: {
            contact_id: '42',
            reference: 'INV-2042',
            details_attributes: [{ description: 'Empty bottles returned', price: '420.00', amount: '1' }],
          },
        },
      }),
    ).toBeNull();
    expect(
      requestRefusal('dropbox', {
        method: 'POST',
        path: '/2/files/upload',
        base: 'content',
        headers: { 'Dropbox-API-Arg': '{"path": "/Invoices/inv.pdf", "mode": "add"}' },
      }),
    ).toBeNull();
    expect(
      proposeCallRefusal(
        entryOrThrow('dropbox'),
        { name: 'files_write', access: 'write', origin: 'adapter' },
        { path: '/notes.txt', content: 'hello', overwrite: false },
        'dropbox',
      ),
    ).toBeNull();
    expect(
      proposeCallRefusal(
        entryOrThrow('todoist'),
        { name: 'tasks_add', access: 'write', origin: 'adapter' },
        { content: 'Pay the invoice', allow_empty: true },
        'todoist',
      ),
    ).toBeNull();
  });

  it('reads a JSON text body as the JSON it is, and refuses a number it can’t send exactly', () => {
    const paperless = entryOrThrow('paperless');
    const settled = proposedRequestArgs(
      paperless,
      { method: 'post', path: '/api/tags/', body: '{"name": "A", "name": "B"}' },
      'paperless',
    );
    // What runs is what the card shows: the parsed body, the last of a repeated key.
    expect(settled).toEqual({ ok: true, args: { method: 'POST', path: '/api/tags/', body: { name: 'B' } } });
    const big = proposedRequestArgs(
      entryOrThrow('moneybird'),
      { method: 'POST', path: '/12345/sales_invoices.json', body: '{"contact_id": 123456789012345678901}' },
      'moneybird',
    );
    expect(big.ok).toBe(false);
    // A text body that isn't JSON stays text; an unknown base is refused before the card.
    expect(
      proposedRequestArgs(
        paperless,
        { method: 'POST', path: '/api/tags/', body: 'just words', headers: { 'Content-Type': 'text/plain' } },
        'paperless',
      ),
    ).toMatchObject({ ok: true, args: { body: 'just words' } });
    expect(
      proposedRequestArgs(
        entryOrThrow('dropbox'),
        { method: 'POST', path: '/2/files/upload', base: 'constructor' },
        'dropbox',
      ).ok,
    ).toBe(false);
  });
});
