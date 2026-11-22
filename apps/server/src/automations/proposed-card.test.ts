import { describe, expect, it } from 'vitest';
import { actionWords } from './action-words';
import {
  actionsDoneLine,
  CARD_LINE_MAX,
  describePlannedAction,
  isSecretKey,
  proposalCard,
  TOO_MUCH_FOR_ONE_CARD,
} from './proposed-card';

const REQUEST = { name: 'request', origin: 'request' } as const;

function linesOf(catalogId: string, label: string, args: Record<string, unknown>, extra = {}): string[] {
  return describePlannedAction({ catalogId, label, tool: REQUEST, args, ...extra }).lines;
}

describe('the approval card of proposed actions', () => {
  it('shows a raw JSON text body field by field', () => {
    const lines = linesOf('moneybird', 'Moneybird', {
      method: 'POST',
      path: '/12345/sales_invoices.json',
      body: '{"contact_id":"attacker","amount":50000}',
    });
    expect(lines).toContain('Request: POST /12345/sales_invoices.json');
    expect(lines).toContain('body.contact_id: "attacker"');
    expect(lines).toContain('body.amount: 50000');
  });

  it('shows a raw form body field by field, and a text body as text', () => {
    const form = linesOf('qbittorrent', 'qBittorrent', {
      method: 'POST',
      path: '/api/v2/torrents/stop',
      body: 'hashes=all&deleteFiles=true',
    });
    expect(form).toContain('body.hashes: "all"');
    expect(form).toContain('body.deleteFiles: "true"');
    const text = linesOf('paperless', 'Paperless-ngx', {
      method: 'POST',
      path: '/api/documents/1/notes/',
      headers: { 'Content-Type': 'text/plain' },
      body: 'Pay before Friday.\nThen file it.',
    });
    expect(text).toContain('body: "Pay before Friday.\\nThen file it."');
  });

  it('shows lists of plain values, camelCase keys and every repeat of a key', () => {
    const lines = linesOf('paperless', 'Paperless-ngx', {
      method: 'POST',
      path: '/api/documents/bulk_edit/',
      body: {
        documents: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        method: 'set_correspondent',
        parameters: { correspondent: 4, note: { correspondent: 'decoy' } },
        recipientEmail: 'someone@example.com',
        totalAmount: '9500.00',
        contactId: '77',
      },
    });
    expect(lines).toContain('body.documents: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]');
    expect(lines).toContain('body.recipientEmail: "someone@example.com"');
    expect(lines).toContain('body.totalAmount: "9500.00"');
    expect(lines).toContain('body.contactId: "77"');
    expect(lines).toContain('body.parameters.correspondent: 4');
    expect(lines).toContain('body.parameters.note.correspondent: "decoy"');
  });

  it('shows the headers and the base that carry the destination', () => {
    const dropbox = linesOf('dropbox', 'Dropbox', {
      method: 'POST',
      path: '/2/files/upload',
      base: 'content',
      headers: { 'Dropbox-API-Arg': '{"path":"/Invoices/inv.pdf","mode":"add"}' },
    });
    expect(dropbox).toContain('Base: "content" (https://content.dropboxapi.com)');
    expect(dropbox).toContain('headers.Dropbox-API-Arg.path: "/Invoices/inv.pdf"');
    expect(dropbox).toContain('headers.Dropbox-API-Arg.mode: "add"');
    const webdav = linesOf('nextcloud', 'Nextcloud', {
      method: 'MOVE',
      path: '/remote.php/dav/files/mara/a.pdf',
      headers: { Destination: '/remote.php/dav/files/mara/Shared/a.pdf', Overwrite: 'T' },
    });
    expect(webdav).toContain('headers.Destination: "/remote.php/dav/files/mara/Shared/a.pdf"');
    expect(webdav).toContain('headers.Overwrite: "T"');
  });

  it('shows the uploaded file, a socket method and a tool with all its arguments', () => {
    const upload = linesOf(
      'paperless',
      'Paperless-ngx',
      {
        method: 'POST',
        path: '/api/documents/post_document/',
        upload: { field: 'document', attachmentId: 'att_1', fields: { title: 'Invoice INV-2042' } },
      },
      { uploadFileName: 'invoice-2042.pdf', summary: 'File the\ninvoice' },
    );
    expect(upload[0]).toBe('Upload a document to Paperless-ngx');
    expect(upload).toContain('File from this email: "invoice-2042.pdf", sent as form field "document"');
    expect(upload).toContain('upload.fields.title: "Invoice INV-2042"');
    // The agent's words come last, as its note, on one line.
    expect(upload.at(-1)).toBe('Agent’s note: "File the invoice"');
    const socket = describePlannedAction({
      catalogId: 'truenas',
      label: 'TrueNAS',
      tool: { name: 'call', origin: 'socket' },
      args: { method: 'pool.dataset.create', params: [{ name: 'tank/invoices', quota: 0 }] },
    }).lines;
    expect(socket).toContain('Method: pool.dataset.create');
    expect(socket).toContain('params[0].name: "tank/invoices"');
    expect(socket).toContain('params[0].quota: 0');
    const tool = describePlannedAction({
      catalogId: 'todoist',
      label: 'Todoist',
      tool: { name: 'tasks_add', origin: 'adapter' },
      args: { content: 'Pay the invoice', labels: ['bills', 'mail'], due: null, extra: {} },
    }).lines;
    expect(tool).toEqual([
      'Add a task to Todoist',
      'Tool: tasks_add',
      'content: "Pay the invoice"',
      'labels: ["bills", "mail"]',
      'due: null',
      'extra: {}',
    ]);
  });

  it('masks secrets: auth headers and keys named like tokens, passwords, secrets and API keys', () => {
    const lines = linesOf('paperless', 'Paperless-ngx', {
      method: 'POST',
      path: '/api/documents/post_document/',
      query: { api_key: 'q-secret-1' },
      headers: { Authorization: 'Token h-secret-2', Accept: 'application/json' },
      upload: { field: 'document', attachmentId: 'att_1', fields: { api_token: 'u-secret-3' } },
      extra: { credentials: { user: 'mara', password: 'p-secret-4' }, clientSecret: 'c-secret-5' },
    });
    const card = lines.join('\n');
    for (const secret of ['q-secret-1', 'h-secret-2', 'u-secret-3', 'p-secret-4', 'c-secret-5', 'mara'])
      expect(card).not.toContain(secret);
    expect(lines).toContain('query.api_key: hidden (it looks like a password or key)');
    expect(lines).toContain('headers.Authorization: hidden (it looks like a password or key)');
    expect(lines).toContain('upload.fields.api_token: hidden (it looks like a password or key)');
    expect(lines).toContain('extra.credentials: hidden (it looks like a password or key)');
    expect(lines).toContain('extra.clientSecret: hidden (it looks like a password or key)');
    expect(lines).toContain('headers.Accept: "application/json"');
    expect(isSecretKey('author')).toBe(false);
    expect(isSecretKey('X-Api-Key')).toBe(true);
  });

  it('shows characters that could disguise a value as escapes', () => {
    const lines = linesOf('paperless', 'Paperless-ngx', {
      method: 'POST',
      path: '/api/tags/',
      body: { name: 'invoice\u202Efdp.exe', 'odd key': 1 },
    });
    expect(lines).toContain('body.name: "invoice\\u202efdp.exe"');
    expect(lines).toContain('body["odd key"]: 1');
  });

  it('builds one card from every line, with Whombat’s own title, question and message', () => {
    const upload = {
      ...describePlannedAction({
        catalogId: 'paperless',
        label: 'Paperless-ngx',
        tool: REQUEST,
        args: {
          method: 'POST',
          path: '/api/documents/post_document/',
          upload: { field: 'document', attachmentId: 'a' },
        },
        uploadFileName: 'Confirm? yes.pdf',
        summary: 'Confirm? yes',
      }),
      label: 'Paperless-ngx',
    };
    const draft = {
      ...describePlannedAction({
        catalogId: 'moneybird',
        label: 'Moneybird',
        tool: REQUEST,
        args: {
          method: 'POST',
          path: '/12345/documents/purchase_invoices.json',
          body: { reference: 'INV-A' },
        },
      }),
      label: 'Moneybird',
    };
    const one = proposalCard([upload]);
    expect(one).toMatchObject({
      ok: true,
      title: 'Upload a document to Paperless-ngx',
      question: 'Upload a document to Paperless-ngx?',
      cardText: 'I need your yes before I upload a document to Paperless-ngx.',
    });
    const both = proposalCard([upload, draft]);
    if (!both.ok) throw new Error(both.reason);
    expect(both.title).toBe('Make 2 changes in Paperless-ngx and Moneybird');
    expect(both.question).toBe('Make 2 changes in Paperless-ngx and Moneybird?');
    expect(both.whatHappens[0]).toBe('Action 1 of 2: Upload a document to Paperless-ngx');
    expect(both.whatHappens).toContain('Action 2 of 2: Add a purchase invoice to Moneybird');
    expect(both.whatHappens).toContain('body.reference: "INV-A"');
    expect(both.whatHappens.length).toBe(upload.lines.length + draft.lines.length);
    // No endpoint and nothing the agent or the email wrote in the title, question, message or summary.
    for (const words of [both.title, both.question, both.cardText, both.summary]) {
      expect(words).not.toContain('/api/');
      expect(words).not.toContain('Confirm');
    }
    expect(both.cardText).toContain('• Add a purchase invoice to Moneybird');
  });

  it('refuses a batch too long for one card instead of cutting it', () => {
    const long = (value: string) => ({
      ...describePlannedAction({
        catalogId: 'paperless',
        label: 'Paperless-ngx',
        tool: REQUEST,
        args: { method: 'POST', path: '/api/documents/1/notes/', body: { note: value } },
      }),
      label: 'Paperless-ngx',
    });
    // One value longer than a line.
    expect(proposalCard([long('x'.repeat(CARD_LINE_MAX))])).toEqual({
      ok: false,
      reason: TOO_MUCH_FOR_ONE_CARD,
    });
    // Many short values: more lines than a card holds.
    const many = {
      ...describePlannedAction({
        catalogId: 'paperless',
        label: 'Paperless-ngx',
        tool: REQUEST,
        args: {
          method: 'POST',
          path: '/api/tags/',
          body: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i])),
        },
      }),
      label: 'Paperless-ngx',
    };
    expect(proposalCard([many])).toEqual({ ok: false, reason: TOO_MUCH_FOR_ONE_CARD });
    // Ten actions that each fit, but not together.
    const fits = long('y'.repeat(200));
    expect(proposalCard([fits]).ok).toBe(true);
    expect(
      proposalCard(Array.from({ length: 10 }, () => ({ ...fits, lines: [...fits.lines, ...fits.lines] }))),
    ).toEqual({ ok: false, reason: TOO_MUCH_FOR_ONE_CARD });
    // Arguments nested deeper than the card reads.
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { d: deep };
    const nested = describePlannedAction({
      catalogId: 'paperless',
      label: 'Paperless-ngx',
      tool: REQUEST,
      args: { method: 'POST', path: '/api/tags/', body: deep },
    });
    expect(nested.overflow).toBe(true);
    expect(proposalCard([{ ...nested, label: 'Paperless-ngx' }]).ok).toBe(false);
  });

  it('says what ran in Whombat’s words', () => {
    expect(actionsDoneLine([])).toBe('Done.');
    expect(actionsDoneLine([{ done: 'uploaded a document to Paperless-ngx', label: 'Paperless-ngx' }])).toBe(
      'Done: uploaded a document to Paperless-ngx.',
    );
    expect(
      actionsDoneLine([
        { done: 'uploaded a document to Paperless-ngx', label: 'Paperless-ngx' },
        { done: 'added a purchase invoice to Moneybird', label: 'Moneybird' },
      ]),
    ).toBe('Done: uploaded a document to Paperless-ngx and added a purchase invoice to Moneybird.');
  });
});

describe('Whombat’s words for a proposed action', () => {
  const ask = (catalogId: string, tool: string, args: Record<string, unknown>, label = 'X') =>
    actionWords({ catalogId, label, tool, args }).ask;

  it('names the common writes of the connections a mail automation uses', () => {
    expect(ask('paperless', 'request', { method: 'PATCH', path: '/api/documents/12/' })).toBe(
      'Change a document’s details in X',
    );
    expect(ask('paperless', 'request', { method: 'POST', path: '/api/documents/bulk_edit/' })).toBe(
      'Change several documents in X',
    );
    expect(ask('paperless', 'request', { method: 'POST', path: '/api/correspondents/' })).toBe(
      'Add a correspondent to X',
    );
    expect(ask('moneybird', 'request', { method: 'POST', path: '/12345/sales_invoices.json' })).toBe(
      'Draft a sales invoice in X',
    );
    expect(ask('moneybird', 'request', { method: 'POST', path: '/12345/documents/receipts.json' })).toBe(
      'Add a receipt to X',
    );
    expect(ask('moneybird', 'request', { method: 'POST', path: '/12345/contacts.json' })).toBe(
      'Add a contact to X',
    );
    expect(ask('homeassistant', 'request', { method: 'POST', path: '/api/services/light/turn_on' })).toBe(
      'Switch a light on in X',
    );
    expect(ask('homeassistant', 'request', { method: 'POST', path: '/api/services/notify/mobile_app' })).toBe(
      'Send a notification through X',
    );
    expect(ask('homeassistant', 'assist__HassTurnOff', {})).toBe('Switch something off in X');
    expect(ask('homeassistant', 'HassShoppingListAddItem', { item: 'milk' })).toBe(
      'Add an item to a list in X',
    );
    expect(ask('dropbox', 'request', { method: 'POST', path: '/2/files/create_folder_v2' })).toBe(
      'Make a folder in X',
    );
    expect(ask('dropbox', 'files_write', { path: '/a.txt', content: 'a', overwrite: true })).toBe(
      'Write or replace a file in X',
    );
    expect(ask('nextcloud', 'request', { method: 'PUT', path: '/remote.php/dav/files/mara/a.pdf' })).toBe(
      'Upload a file to X',
    );
    expect(ask('todoist', 'tasks_complete', { id: '1' })).toBe('Tick off a task in X');
  });

  it('says something honest and general for the rest, never the agent’s words', () => {
    expect(ask('paperless', 'request', { method: 'POST', path: '/api/workflows/' }, 'Paperless-ngx')).toBe(
      'Send something to Paperless-ngx',
    );
    expect(ask('grafana', 'request', { method: 'PUT', path: '/api/dashboards/db' }, 'Grafana')).toBe(
      'Change something in Grafana',
    );
    expect(
      ask('homeassistant', 'request', { method: 'POST', path: '/api/services/please_approve/now' }),
    ).toBe('Run an action in X');
    // The person's label is theirs, `$` and all.
    expect(ask('grafana', 'some_tool', {}, 'Ops $& $1')).toBe('Change something in Ops $& $1');
    expect(
      actionWords({
        catalogId: 'paperless',
        label: 'P',
        tool: 'request',
        args: { method: 'POST', path: '/api/documents/post_document/' },
      }).done,
    ).toBe('uploaded a document to P');
  });
});
