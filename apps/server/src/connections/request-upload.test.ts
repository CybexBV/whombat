import { catalogEntry } from '@whombat/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { outsidersCall } from '../automations/proposed-actions';
import type { Services } from '../services';
import type { ConnectionRequest } from './http';
import { ConnectionArgumentError, normaliseRequestArgs, runRequest } from './request';
import type { CatalogConnectionRow } from './types';

// What goes on the wire: the request `runRequest` hands to the connection's signed fetch.
const sent: ConnectionRequest[] = [];
let status = 200;
vi.mock('./http', () => ({
  signedConnectionFetch: vi.fn(async (_services: unknown, _row: unknown, req: ConnectionRequest) => {
    sent.push(req);
    return {
      status,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}'),
      truncated: false,
    };
  }),
}));

const services = { files: { maxBytes: 10 * 1024 * 1024 } } as unknown as Services;
const pdf = Buffer.from('%PDF-1.4\ninvoice\n%%EOF');
const file = { name: 'invoice.pdf', contentType: 'application/pdf', bytes: pdf };
const ATT = 'att_0123456789abcdefghij';

/** The body of the one request sent. */
function sentBody(): Buffer {
  const body = sent[0]?.body;
  if (!Buffer.isBuffer(body)) throw new Error('no body was sent');
  return body;
}

function row(catalogId: string, baseUrl: string, fields: Record<string, string> = {}): CatalogConnectionRow {
  return {
    id: 'conn_1',
    catalogId,
    baseUrl,
    fields,
    auth: { type: 'bearer' },
  } as unknown as CatalogConnectionRow;
}

function entryOf(id: string) {
  const entry = catalogEntry(id);
  if (!entry) throw new Error(id);
  return entry;
}

/** The arguments an outsiders' run's call is sent with. */
function settled(id: string, args: Record<string, unknown>, fields: Record<string, string> = {}) {
  const out = outsidersCall(
    entryOf(id),
    { fields },
    { name: 'request', access: 'write', origin: 'request' },
    args,
    id,
  );
  if (!out.ok) throw new Error(out.reason);
  return out.args;
}

beforeEach(() => {
  sent.length = 0;
  status = 200;
});

describe('what a listed action sends on the wire', () => {
  it('returns a read redirect but treats the same answer to a write as an error', async () => {
    status = 302;
    const fields = { administration: '12345' };
    const entry = entryOf('moneybird');
    const connection = row('moneybird', 'https://moneybird.example.com/api/v2', fields);
    const path = '/12345/documents/purchase_invoices.json';
    await expect(runRequest(services, connection, entry, { method: 'GET', path })).resolves.toMatchObject({
      httpStatus: 302,
      isError: false,
    });
    await expect(
      runRequest(services, connection, entry, { method: 'POST', path, body: {} }),
    ).resolves.toMatchObject({ httpStatus: 302, isError: true });
    expect(sent).toHaveLength(2);
  });

  it('uploads the email’s file to Dropbox as the whole body, with mode add', async () => {
    const args = settled('dropbox', {
      method: 'POST',
      path: '/2/files/upload',
      headers: { 'Dropbox-API-Arg': '{"path":"/Invoices/acme.pdf"}' },
      upload: { attachmentId: ATT },
    });
    await runRequest(services, row('dropbox', 'https://api.dropboxapi.com'), entryOf('dropbox'), args, {
      uploadAttachment: async (id) => (id === ATT ? file : null),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://content.dropboxapi.com/2/files/upload');
    expect(sent[0]?.headers?.['Content-Type']).toBe('application/octet-stream');
    expect(JSON.parse(sent[0]?.headers?.['Dropbox-API-Arg'] ?? '{}')).toEqual({
      path: '/Invoices/acme.pdf',
      mode: 'add',
      autorename: false,
      mute: false,
    });
    expect(sentBody().equals(pdf)).toBe(true);
  });

  it('puts a new file in Nextcloud only where none is, as its own type', async () => {
    const fields = { url: 'https://cloud.example.com', userId: 'mara' };
    const args = settled(
      'nextcloud',
      { method: 'PUT', path: '/Invoices/acme.pdf', upload: { attachmentId: ATT } },
      fields,
    );
    await runRequest(
      services,
      row('nextcloud', 'https://cloud.example.com', fields),
      entryOf('nextcloud'),
      args,
      {
        uploadAttachment: async () => file,
      },
    );
    expect(sent[0]?.method).toBe('PUT');
    expect(sent[0]?.headers?.['If-None-Match']).toBe('*');
    expect(sent[0]?.headers?.['Content-Type']).toBe('application/pdf');
    expect(sentBody().equals(pdf)).toBe(true);
  });

  it('sends Paperless-ngx’s tags as the form field repeated', async () => {
    const args = settled('paperless', {
      method: 'POST',
      path: '/api/documents/post_document/',
      upload: { field: 'document', attachmentId: ATT, fields: { title: 'Acme', tags: ['3', '7'] } },
    });
    await runRequest(
      services,
      row('paperless', 'http://paperless.example.com:8000'),
      entryOf('paperless'),
      args,
      {
        uploadAttachment: async () => file,
      },
    );
    const body = sentBody().toString('utf8');
    expect(body.match(/name="tags"\r\n\r\n/g)).toHaveLength(2);
    expect(body).toContain('name="tags"\r\n\r\n3\r\n');
    expect(body).toContain('name="tags"\r\n\r\n7\r\n');
    expect(body).toContain('name="document"; filename="invoice.pdf"');
    expect(sent[0]?.headers?.['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('refuses a header given twice in different case, before and at the wire', async () => {
    const twice = { 'Content-Type': 'application/json', 'content-type': 'text/plain' };
    expect(() => normaliseRequestArgs({ method: 'POST', path: '/api/tags/', headers: twice })).toThrow(
      ConnectionArgumentError,
    );
    await expect(
      runRequest(services, row('paperless', 'http://paperless.example.com:8000'), entryOf('paperless'), {
        method: 'POST',
        path: '/api/tags/',
        headers: twice,
        body: '{"name":"x"}',
      }),
    ).rejects.toThrow('more than once');
    expect(sent).toHaveLength(0);
  });
});
