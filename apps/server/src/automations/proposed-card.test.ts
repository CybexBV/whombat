import { describe, expect, it } from 'vitest';
import { isSecretKey, listedWords } from './listed-actions';
import {
  actionsDoneLine,
  CARD_LINE_MAX,
  CARD_LINES_MAX,
  cardRefs,
  describePlannedAction,
  proposalCard,
  TOO_MUCH_FOR_ONE_CARD,
  valueLines,
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
    // Any other header is the text it is, whatever it starts with.
    expect(
      linesOf('nextcloud', 'Nextcloud', {
        method: 'PUT',
        path: '/remote.php/dav/files/mara/a.txt',
        headers: { Accept: '{"a":1}' },
        body: 'x',
      }),
    ).toContain('headers.Accept: "{\\"a\\":1}"');
    const webdav = linesOf('nextcloud', 'Nextcloud', {
      method: 'MOVE',
      path: '/remote.php/dav/files/mara/a.pdf',
      headers: { Destination: '/remote.php/dav/files/mara/Shared/a.pdf', Overwrite: 'T' },
    });
    expect(webdav).toContain('headers.Destination: "/remote.php/dav/files/mara/Shared/a.pdf"');
    expect(webdav).toContain('headers.Overwrite: "T"');
  });

  it('shows the email’s file by name, type and size, a socket method and a tool with all its arguments', () => {
    const upload = linesOf(
      'paperless',
      'Paperless-ngx',
      {
        method: 'POST',
        path: '/api/documents/post_document/',
        upload: {
          field: 'document',
          attachmentId: 'att_1',
          fields: { title: 'Invoice INV-2042', tags: ['3', '7'] },
        },
      },
      {
        uploadFile: { name: 'invoice-2042.pdf', contentType: 'application/pdf', size: 12345 },
        summary: 'File the\ninvoice',
      },
    );
    expect(upload[0]).toBe('Upload a document to Paperless-ngx');
    expect(upload).toContain(
      'File from this email: "invoice-2042.pdf" (application/pdf, 12 345 bytes), sent as form field "document"',
    );
    expect(upload).toContain('upload.fields.title: "Invoice INV-2042"');
    expect(upload).toContain('upload.fields.tags: ["3", "7"]');
    // The agent's words come last, as its note, on one line.
    expect(upload.at(-1)).toBe('Agent’s note: "File the invoice"');
    const whole = linesOf(
      'nextcloud',
      'Nextcloud',
      {
        method: 'PUT',
        path: '/remote.php/dav/files/mara/Invoices/a.pdf',
        headers: { 'If-None-Match': '*' },
        upload: { attachmentId: 'att_1' },
      },
      { uploadFile: { name: `${'n'.repeat(250)}.pdf`, contentType: 'application/pdf', size: 9 } },
    );
    // A long name goes on in parts, the type, size and how it is sent on lines of their own.
    expect(whole).toContain('File type and size: application/pdf, 9 bytes');
    expect(whole).toContain('File sent as the whole request body');
    expect(whole).toContain('headers.If-None-Match: "*"');
    expect(whole.every((l) => l.length <= CARD_LINE_MAX)).toBe(true);
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

  it('hides nothing: every value is shown, whatever its key is called', () => {
    const lines = linesOf('paperless', 'Paperless-ngx', {
      method: 'POST',
      path: '/api/documents/post_document/',
      headers: { Authorization: 'Token h-1', Accept: 'application/json' },
      extra: { credentials: { user: 'mara' } },
    });
    expect(lines).toContain('headers.Authorization: "Token h-1"');
    expect(lines).toContain('extra.credentials.user: "mara"');
    expect(lines.join('\n')).not.toContain('hidden');
    // What an outsiders' run refuses before any card is made (`outsidersCall`).
    expect(isSecretKey('author')).toBe(false);
    expect(isSecretKey('X-Api-Key')).toBe(true);
    expect(isSecretKey('auth')).toBe(true);
  });

  it('goes on in numbered parts when a value is longer than a line', () => {
    const note = 'Pay before Friday, then file it with the others. '.repeat(45).slice(0, 2000);
    const parts = valueLines('body.note', note);
    expect(parts.length).toBeGreaterThan(7);
    expect(parts.every((l) => l.length <= CARD_LINE_MAX)).toBe(true);
    expect(parts[0]).toMatch(/^body\.note \(part 1 of \d+\): "Pay before/);
    // Read back, the parts are the value, whole and in order, broken after spaces.
    const text = parts.map((l) => JSON.parse(l.slice(l.indexOf('): ') + 3)) as string).join('');
    expect(text).toBe(note);
    expect(parts.slice(0, -1).every((l) => l.endsWith(' "'))).toBe(true);
    // Escaped characters count as they are shown; a short value stays on one line.
    const escaped = valueLines('body.x', '‮'.repeat(200));
    expect(escaped.length).toBeGreaterThan(1);
    expect(escaped.every((l) => l.length <= CARD_LINE_MAX)).toBe(true);
    expect(valueLines('body.x', 'short')).toEqual(['body.x: "short"']);
    // A long list goes item by item.
    expect(
      valueLines(
        'body.ids',
        Array.from({ length: 40 }, (_, i) => `id-${i}-${'x'.repeat(10)}`),
      ),
    ).toHaveLength(40);
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
        uploadFile: { name: 'Confirm? yes.pdf', contentType: 'application/pdf', size: 10 },
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

  it('refuses a batch too long for one card instead of cutting it, and says so plainly', () => {
    const long = (value: string) => ({
      ...describePlannedAction({
        catalogId: 'todoist',
        label: 'Todoist',
        tool: { name: 'tasks_add', origin: 'adapter' },
        args: { content: 'Pay it', description: value },
      }),
      label: 'Todoist',
    });
    // One value longer than a line goes on in parts.
    expect(proposalCard([long('x'.repeat(CARD_LINE_MAX * 3))]).ok).toBe(true);
    // Many short values: more lines than a card holds.
    const many = {
      ...describePlannedAction({
        catalogId: 'paperless',
        label: 'Paperless-ngx',
        tool: REQUEST,
        args: {
          method: 'POST',
          path: '/api/tags/',
          body: Object.fromEntries(Array.from({ length: CARD_LINES_MAX + 10 }, (_, i) => [`k${i}`, i])),
        },
      }),
      label: 'Paperless-ngx',
    };
    expect(proposalCard([many])).toEqual({ ok: false, reason: TOO_MUCH_FOR_ONE_CARD });
    expect(TOO_MUCH_FOR_ONE_CARD).toContain(String(CARD_LINES_MAX));
    // Ten actions that each fit, but not together.
    const fits = long('y'.repeat(5000));
    expect(proposalCard([fits]).ok).toBe(true);
    expect(proposalCard(Array.from({ length: 10 }, () => fits))).toEqual({
      ok: false,
      reason: TOO_MUCH_FOR_ONE_CARD,
    });
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

describe('the ids, folders and nothing-changes an action’s card names', () => {
  const upload = (fields: Record<string, unknown>) => ({
    method: 'POST',
    path: '/api/documents/post_document/',
    upload: { field: 'document', attachmentId: 'att_1', fields },
  });
  const invoice = {
    method: 'POST',
    path: '/12345/documents/purchase_invoices.json',
    body: {
      purchase_invoice: {
        contact_id: '4242',
        reference: 'INV-1',
        details_attributes: [
          { description: 'Coffee', price: '3.50', tax_rate_id: '11', ledger_account_id: '21' },
          { description: 'Tea', price: '2.50', tax_rate_id: '11' },
        ],
      },
    },
  };

  it('lists the ids an action names, as sent', () => {
    expect(
      cardRefs('paperless', REQUEST, upload({ tags: ['3', '7'], correspondent: '4', title: 'A' })),
    ).toEqual([
      { kind: 'tag', what: 'tag', id: '3' },
      { kind: 'tag', what: 'tag', id: '7' },
      { kind: 'correspondent', what: 'correspondent', id: '4' },
    ]);
    expect(cardRefs('moneybird', REQUEST, invoice).map((r) => `${r.kind}:${r.id}`)).toEqual([
      'contact:4242',
      'tax_rate:11',
      'ledger_account:21',
      'tax_rate:11',
    ]);
    expect(
      cardRefs('todoist', REQUEST, { method: 'POST', path: '/api/v1/tasks', body: { project_id: '6Jf8' } }),
    ).toEqual([{ kind: 'project', what: 'project', id: '6Jf8' }]);
    // Nothing for what isn't listed, and nothing for a value that only looks like one.
    expect(
      cardRefs('paperless', REQUEST, { method: 'POST', path: '/api/tags/', body: { tags: [1] } }),
    ).toEqual([]);
  });

  it('shows each id with its name, and says so when it couldn’t look one up', () => {
    const named = linesOf('paperless', 'Paperless-ngx', upload({ tags: ['3', '7'], correspondent: '4' }), {
      names: { 'tag:3': 'Invoices', 'tag:7': 'Paid "late"', 'correspondent:4': 'Acme BV' },
    });
    expect(named).toContain('upload.fields.tags: ["Invoices" (3), "Paid \\"late\\"" (7)]');
    expect(named).toContain('upload.fields.correspondent: "Acme BV" (4)');
    expect(named.some((l) => l.includes('couldn’t look up'))).toBe(false);
    const partly = linesOf('moneybird', 'Moneybird', invoice, {
      names: { 'contact:4242': 'Acme BV', 'tax_rate:11': '21% btw' },
      summary: 'Draft it',
    });
    expect(partly).toContain('body.purchase_invoice.contact_id: "Acme BV" (4242)');
    expect(partly).toContain('body.purchase_invoice.details_attributes[0].tax_rate_id: "21% btw" (11)');
    expect(partly).toContain('body.purchase_invoice.details_attributes[1].tax_rate_id: "21% btw" (11)');
    // The one it couldn't read shows as it is, and a line says so, before the agent's note.
    expect(partly).toContain('body.purchase_invoice.details_attributes[0].ledger_account_id: "21"');
    expect(partly.at(-2)).toBe('Whombat couldn’t look up some names in Moneybird, so their ids are shown.');
    expect(partly.at(-1)).toBe('Agent’s note: "Draft it"');
    // A long name is shortened, and a name that could disguise itself is escaped.
    const odd = linesOf('paperless', 'Paperless-ngx', upload({ tags: '3' }), {
      names: { 'tag:3': `\u202e${'x'.repeat(200)}` },
    });
    const tags = odd.find((l) => l.startsWith('upload.fields.tags: ')) ?? '';
    expect(tags).toMatch(/^upload\.fields\.tags: "\\u202ex+…" \(3\)$/);
    expect(tags.length).toBeLessThan(CARD_LINE_MAX);
  });

  it('shows an id the service doesn’t have as it is, with a line that says so, instead of refusing the card', () => {
    const lines = linesOf(
      'paperless',
      'Paperless-ngx',
      upload({ tags: ['3', '99', '99'], correspondent: '4' }),
      {
        names: { 'tag:3': 'Invoices', 'correspondent:4': 'Acme BV' },
        missing: ['tag:99'],
        summary: 'File it',
      },
    );
    expect(lines).toContain('upload.fields.tags: ["Invoices" (3), "99", "99"]');
    // Said once however often the action names it, and not as a name Whombat couldn't read.
    expect(lines.filter((l) => l === 'Paperless-ngx has no tag 99.')).toHaveLength(1);
    expect(lines.some((l) => l.includes('couldn’t look up'))).toBe(false);
    expect(lines.at(-1)).toBe('Agent’s note: "File it"');
    // An id that could disguise itself is escaped there too.
    const odd = linesOf('paperless', 'Paperless-ngx', upload({ tags: ['\u202e9'] }), {
      missing: ['tag:\u202e9'],
    });
    expect(odd).toContain('Paperless-ngx has no tag \\u202e9.');
  });

  it('says the folder Dropbox makes on the way, and that a folder there already changes nothing', () => {
    const dropbox = linesOf('dropbox', 'Dropbox', {
      method: 'POST',
      path: '/2/files/upload',
      base: 'content',
      headers: { 'Dropbox-API-Arg': '{"path":"/Invoices/2026/acme.pdf","mode":"add"}' },
      upload: { attachmentId: 'att_1' },
    });
    expect(dropbox.slice(0, 2)).toEqual([
      'Save a new file in Dropbox',
      'And the folder "/Invoices/2026", if it doesn’t exist',
    ]);
    const written = describePlannedAction({
      catalogId: 'dropbox',
      label: 'Dropbox',
      tool: { name: 'files_write', origin: 'adapter' },
      args: { path: '/Notes/acme.txt', content: 'Paid.', overwrite: false },
    }).lines;
    expect(written[1]).toBe('And the folder "/Notes", if it doesn’t exist');
    // In the root, there is no folder to make.
    const root = describePlannedAction({
      catalogId: 'dropbox',
      label: 'Dropbox',
      tool: { name: 'files_write', origin: 'adapter' },
      args: { path: '/acme.txt', content: 'Paid.', overwrite: false },
    }).lines;
    expect(root.some((l) => l.startsWith('And the folder'))).toBe(false);
    const mkcol = linesOf('nextcloud', 'Nextcloud', {
      method: 'MKCOL',
      path: '/remote.php/dav/files/mara/Invoices/',
    });
    expect(mkcol.slice(0, 2)).toEqual([
      'Make a folder in Nextcloud',
      'If the folder is there already, nothing changes.',
    ]);
  });
});

describe('Whombat’s words for a proposed action', () => {
  const ask = (
    catalogId: string,
    tool: string,
    args: Record<string, unknown>,
    label = 'X',
    origin: 'request' | 'adapter' | 'mcp' = tool === 'request' ? 'request' : 'adapter',
  ) => listedWords({ catalogId, label, tool: { name: tool, origin }, args }).ask;

  it('names each listed action by what it does', () => {
    expect(ask('paperless', 'request', { method: 'POST', path: '/api/documents/post_document/' })).toBe(
      'Upload a document to X',
    );
    expect(
      ask('moneybird', 'request', { method: 'POST', path: '/12345/documents/purchase_invoices.json' }),
    ).toBe('Add a purchase invoice to X');
    expect(ask('moneybird', 'request', { method: 'POST', path: '/12345/documents/receipts.json' })).toBe(
      'Add a receipt to X',
    );
    expect(ask('dropbox', 'request', { method: 'POST', path: '/2/files/upload' })).toBe(
      'Save a new file in X',
    );
    expect(ask('dropbox', 'files_write', { path: '/a.txt', content: 'a' })).toBe('Save a new file in X');
    expect(ask('nextcloud', 'request', { method: 'PUT', path: '/remote.php/dav/files/mara/a.pdf' })).toBe(
      'Save a new file in X',
    );
    expect(ask('nextcloud', 'request', { method: 'MKCOL', path: '/remote.php/dav/files/mara/A/' })).toBe(
      'Make a folder in X',
    );
    expect(ask('todoist', 'tasks_add', { content: 'a' })).toBe('Add a task to X');
    expect(ask('todoist', 'request', { method: 'POST', path: '/api/v1/tasks' })).toBe('Add a task to X');
    expect(
      ask('homeassistant', 'request', {
        method: 'POST',
        path: '/api/services/persistent_notification/create',
      }),
    ).toBe('Show a notification in X');
  });

  it('says something honest and general for the rest, never the agent’s words', () => {
    expect(ask('paperless', 'request', { method: 'POST', path: '/api/workflows/' }, 'Paperless-ngx')).toBe(
      'Send something to Paperless-ngx',
    );
    expect(ask('grafana', 'request', { method: 'PUT', path: '/api/dashboards/db' }, 'Grafana')).toBe(
      'Change something in Grafana',
    );
    // A tool of the same name from an MCP server isn't the listed one.
    expect(ask('todoist', 'tasks_add', { content: 'a' }, 'X', 'mcp')).toBe('Change something in X');
    // The person's label is theirs, `$` and all.
    expect(ask('grafana', 'some_tool', {}, 'Ops $& $1')).toBe('Change something in Ops $& $1');
    expect(
      listedWords({
        catalogId: 'paperless',
        label: 'P',
        tool: { name: 'request', origin: 'request' },
        args: { method: 'POST', path: '/api/documents/post_document/' },
      }).done,
    ).toBe('uploaded a document to P');
  });
});
