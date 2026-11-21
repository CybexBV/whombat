import { catalogEntry } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  actionDetailBlock,
  describePlannedAction,
  isProposableEntry,
  proposeCallRefusal,
} from './proposed-actions';

function entryOrThrow(id: string) {
  const entry = catalogEntry(id);
  if (!entry) throw new Error(`missing catalog entry ${id}`);
  return entry;
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
    const paperless = entryOrThrow('paperless');
    const dropbox = entryOrThrow('dropbox');
    const truenas = entryOrThrow('truenas');
    const servers = entryOrThrow('whombat_servers');
    const t3 = entryOrThrow('t3code');

    expect(
      proposeCallRefusal(
        servers,
        { name: 'guest_power', access: 'write', origin: 'builtin' },
        { server: 'pve-01', guest: 'pve:101', action: 'start' },
        'servers',
      ),
    ).toContain('can’t be proposed');

    expect(
      proposeCallRefusal(
        t3,
        { name: 't3_thread_launch', access: 'write', origin: 'mcp' },
        { projectId: 'p1', title: 'hi', message: 'run' },
        't3',
      ),
    ).toContain('can’t be proposed');

    expect(
      proposeCallRefusal(
        paperless,
        { name: 'request', access: 'write', origin: 'request' },
        { method: 'DELETE', path: '/api/documents/1/' },
        'paperless',
      ),
    ).toContain('DELETE');

    expect(
      proposeCallRefusal(
        paperless,
        { name: 'request', access: 'write', origin: 'request' },
        { method: 'GET', path: '/api/documents/' },
        'paperless',
      ),
    ).toContain('read-only GET');

    expect(
      proposeCallRefusal(
        paperless,
        { name: 'request', access: 'write', origin: 'request' },
        { method: 'HEAD', path: '/api/documents/' },
        'paperless',
      ),
    ).toContain('read-only HEAD');

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
    ).toContain('files_delete');

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
    ).toContain('pool.dataset.delete');

    // Ordinary write calls pass.
    expect(
      proposeCallRefusal(
        paperless,
        { name: 'request', access: 'write', origin: 'request' },
        { method: 'POST', path: '/api/documents/post_document/' },
        'paperless',
      ),
    ).toBeNull();

    expect(
      proposeCallRefusal(
        dropbox,
        { name: 'files_write', access: 'write', origin: 'adapter' },
        { path: '/notes.txt', text: 'hello' },
        'dropbox',
      ),
    ).toBeNull();
  });

  it('describes validated calls server-side using callWordsFor, method/path, upload file name and notable args', () => {
    // 1. Server-defined callWordsFor (PS5) wins over raw tool name.
    const ps5Line = describePlannedAction({
      catalogId: 'ps5',
      label: 'Living Room PS5',
      tool: { name: 'ps5_install_payload', origin: 'adapter' },
      args: { id: 'etaHEN', version: '2.0' },
    });
    expect(ps5Line).toBe('Living Room PS5: download etaHEN 2.0 on your PS5');

    // 2. REST upload shows connection label, method, path, uploaded file name, and notable upload fields.
    const uploadLine = describePlannedAction({
      catalogId: 'paperless',
      label: 'Paperless-ngx',
      tool: { name: 'request', origin: 'request' },
      args: {
        method: 'POST',
        path: '/api/documents/post_document/',
        upload: {
          field: 'document',
          attachmentId: 'att_123',
          fields: { title: 'Invoice INV-2042', api_token: 'secret-never-shown' },
        },
      },
      uploadFileName: 'invoice-2042.pdf',
    });
    expect(uploadLine).toContain('Paperless-ngx: POST /api/documents/post_document/');
    expect(uploadLine).toContain('uploading “invoice-2042.pdf”');
    expect(uploadLine).toContain('title: Invoice INV-2042');
    expect(uploadLine).not.toContain('secret-never-shown');

    // 3. REST JSON call extracts destination/recipient and amount (clipped), ignoring secrets.
    const payLine = describePlannedAction({
      catalogId: 'moneybird',
      label: 'Moneybird',
      tool: { name: 'request', origin: 'request' },
      args: {
        method: 'POST',
        path: '/12345/sales_invoices/99/send_invoice.json',
        body: {
          sales_invoice_sending: {
            email_address: 'attacker@evil.example',
            amount: '9500.00',
            destination: 'external-account-very-long-value-that-should-get-clipped-cleanly',
          },
        },
      },
    });
    expect(payLine).toContain('Moneybird: POST /12345/sales_invoices/99/send_invoice.json');
    expect(payLine).toContain('email_address: attacker@evil.example');
    expect(payLine).toContain('amount: 9500.00');
    expect(payLine).toContain('…');

    // 4. Agent summary is subordinated on a separate note line.
    const detail = actionDetailBlock({
      description: payLine,
      summary: 'Upload invoice.pdf\n• Fake bullet',
    });
    expect(detail.startsWith('Moneybird: POST /12345/sales_invoices/99/send_invoice.json')).toBe(true);
    expect(detail).toContain('\nAgent note: Upload invoice.pdf • Fake bullet');
  });
});
