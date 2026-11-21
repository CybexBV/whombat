import { BEARER, type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME } from './shared.js';

export const entry = {
  id: 'moneybird',
  name: 'Moneybird',
  category: 'business',
  description: 'Invoices, contacts and bookkeeping in Moneybird.',
  signIn: [
    {
      kind: 'token',
      label: 'API token',
      auth: BEARER,
      secretLabel: 'API token',
      // SG-21 (0.111, CT-749): the administration's settings, not Ontwikkelaars (whose tokens the owner approves).
      secretHelp:
        'Create one in Moneybird → Instellingen → Koppelingen → Externe applicaties → Nieuw token aanmaken (in English: Settings → External applications and AI connections → New API token). Not under Ontwikkelaars: those tokens need the owner’s approval.',
      steps: [
        {
          text: 'In Moneybird, open Instellingen → Koppelingen → Externe applicaties → Nieuw token aanmaken.',
        },
        {
          text: 'Give it a name, tick every box under Rechten (choose Alleen lezen to look only) and save.',
          values: [{ label: 'Name', value: 'Whombat' }],
        },
        { text: 'Copy the token and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b([0-9a-f]{64})\\b' }],
    },
  ],
  fields: [
    {
      id: 'administration',
      label: 'Administration',
      kind: 'select',
      required: true,
      fromService: true,
      help: 'Which administration the agent works in. Chosen once the token is checked.',
    },
  ],
  transport: 'rest',
  baseUrl: 'https://moneybird.com/api/v2',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/administrations.json' },
  tools: [],
  request: { prefixes: ['/{administration}/'] },
  guide:
    'Moneybird API v2: paths are /<administration>/<resource>.json (the administration id is in the connection’s fields). Main resources: contacts.json (?query= searches), sales_invoices.json (GET with ?filter=state:open; POST drafts one with contact_id and details_attributes), sales_invoices/<id>/send_invoice.json (PATCH sends it), documents/purchase_invoices.json, documents/receipts.json, documents/typeless_documents.json, financial_mutations.json (bank lines), ledger_accounts.json, tax_rates.json, products.json, estimates.json. Ids are big numbers: keep them as strings. Pages: page and per_page (at most 100). At most 150 requests per 5 minutes. Sending invoices or reminders, recording payments and deletes always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PATCH', 'PUT'],
      path: '/(send_invoice|send_reminder|register_payment|payments|mark_as_uncollectible|duplicate_creditinvoice)(\\.json)?(/|$)',
      reason: 'Sends invoices or records payments',
    },
  ],
  docsUrl: 'https://developer.moneybird.com/',
  tokenUrl: null,
  handle: 'moneybird',
  access: {
    read: 'The agent can read invoices, contacts and bookkeeping, and change nothing.',
    manage:
      'The agent can also make contacts and draft invoices. Sending invoices, payments and deleting ask you first.',
  },
} satisfies CatalogEntryInput;
