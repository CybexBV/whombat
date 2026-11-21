import { BEARER, type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME } from './shared.js';

export const entry = {
  id: 'hubspot',
  name: 'HubSpot',
  category: 'business',
  description: 'Contacts, companies, deals and tickets in your HubSpot CRM.',
  signIn: [
    {
      kind: 'token',
      label: 'Service key',
      auth: BEARER,
      secretLabel: 'Service key',
      secretPlaceholder: 'pat-…',
      secretHelp:
        'Create one in HubSpot → Development → Keys → Service keys (or Settings → Integrations → Service Keys). You need to be a super admin or have Developer tools access. An existing private app’s token works too; new private apps can’t be made after 26 October 2026.',
      steps: [
        {
          text: 'In HubSpot, open Development → Keys → Service keys and click Create service key.',
          values: [{ label: 'Name', value: 'Whombat' }],
        },
        {
          text: 'Add the scopes: the read ones to look, the write ones too to manage, then click Create and confirm.',
          values: [
            {
              label: 'To look',
              value:
                'crm.objects.contacts.read crm.objects.companies.read crm.objects.deals.read crm.objects.tickets.read crm.objects.owners.read',
            },
            {
              label: 'To manage, also',
              value:
                'crm.objects.contacts.write crm.objects.companies.write crm.objects.deals.write crm.objects.tickets.write',
            },
          ],
        },
        { text: 'Click the key’s name → Show → Copy, and paste it here.' },
      ],
      paste: [
        {
          target: 'secret',
          pattern: '\\b(pat-[a-z]{2}[0-9]+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\\b',
        },
      ],
    },
  ],
  fields: [],
  transport: 'rest',
  baseUrl: 'https://api.hubapi.com',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/crm/v3/objects/contacts?limit=1' },
  tools: [],
  request: {
    prefixes: ['/crm/', '/account-info/'],
    readPaths: [{ method: 'POST', path: '^/crm/.+/(search|batch/read)$' }],
  },
  guide:
    'HubSpot’s CRM API. Paths are dated, /crm/objects/2026-09/<type> (the older /crm/v3/objects/<type> still answers); types: contacts, companies, deals, tickets, notes, tasks, calls, emails, meetings, line_items, products, quotes. List: GET /crm/objects/2026-09/contacts?limit=100&properties=email,firstname,lastname&associations=companies (paging.next.after → ?after=). One: GET …/<type>/<id>. Search (a read): POST /crm/objects/2026-09/<type>/search {"filterGroups": [{"filters": [{"propertyName": "email", "operator": "EQ", "value": "ann@example.com"}]}], "sorts": [{"propertyName": "createdate", "direction": "DESCENDING"}], "properties": […], "limit": 100, "after": "…"} (operators EQ, NEQ, LT, GT, BETWEEN, IN, HAS_PROPERTY, CONTAINS_TOKEN; at most 10 000 results, 5 searches a second). POST …/<type>/batch/read {"inputs": [{"id"}]} reads; …/batch/create, /batch/update and /batch/upsert write (100 at most). Create: POST …/<type> {"properties": {…}}; change: PATCH …/<type>/<id>. Properties: GET /crm/properties/2026-09/<type>; pipelines and stages: GET /crm/pipelines/2026-09/deals; owners: GET /crm/owners/2026-09. Associations: GET /crm/objects/2026-09/<type>/<id>/associations/<toType>; PUT …/<type>/<id>/associations/default/<toType>/<toId>. Errors are {"category", "message", "context"}; context.missingScopes names a scope the key lacks; after a 429 wait a few seconds. Deleting or archiving records (one or a batch), merging records and GDPR deletes always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/crm/.+/(batch/archive|gdpr-delete)$',
      reason: 'Deletes records',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/crm/.+/merge$',
      reason: 'Merges two records into one',
    },
  ],
  docsUrl: 'https://developers.hubspot.com/docs/api-reference/2026-03/overview',
  tokenUrl: null,
  handle: 'hubspot',
  access: {
    read: 'The agent can see contacts, companies, deals and tickets, and change nothing.',
    manage: 'The agent can also add and change records, notes and tasks. Deleting and merging ask you first.',
  },
} satisfies CatalogEntryInput;
