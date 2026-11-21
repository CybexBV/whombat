import { type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME } from './shared.js';

export const entry = {
  id: 'pipedrive',
  name: 'Pipedrive',
  category: 'business',
  description: 'Deals, people, organizations and activities in Pipedrive.',
  signIn: [
    {
      kind: 'token',
      label: 'API token',
      auth: { type: 'header', name: 'x-api-token', template: '{secret}' },
      secretLabel: 'Personal API token',
      secretHelp:
        'In Pipedrive: your account name (top right) → Company settings → Personal preferences → API. The token has your own access; making a new one stops the old one.',
      steps: [
        {
          text: 'Open the link, or in Pipedrive: your account name (top right) → Company settings → Personal preferences → API.',
        },
        {
          text: 'Copy Your personal API token and paste it here. No API page? An admin turns on “use API” in your permission set.',
        },
      ],
      paste: [{ target: 'secret', pattern: '\\b([0-9a-f]{40})\\b' }],
    },
  ],
  fields: [],
  transport: 'rest',
  baseUrl: 'https://api.pipedrive.com',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/v1/users/me' },
  tools: [],
  request: { prefixes: ['/api/v2/', '/v1/', '/api/v1/'] },
  guide:
    'Pipedrive’s API: /api/v2/ for deals, persons, organizations, activities, products, pipelines and stages and their search; /v1/ for notes, leads, users, files and filters (the v1 forms of the v2 ones are no longer supported). List: GET /api/v2/deals?limit=100&status=open&owner_id=…&sort_by=update_time, pages with cursor (pass additional_data.next_cursor); v1 lists use start and limit (additional_data.pagination.next_start). Search: GET /api/v2/itemSearch?term=…&item_types=deal,person,organization, or /api/v2/persons/search?term=… Create: POST /api/v2/deals {"title", "value", "currency", "person_id", "org_id", "stage_id"}; change: PATCH /api/v2/deals/<id> (v1 uses PUT). Notes: POST /v1/notes {"content", "deal_id"}. Custom fields have hash keys: GET /api/v2/dealFields (personFields, organizationFields) names them. Me: GET /v1/users/me. Answers are {success, data, additional_data}; errors {success: false, error}. A daily budget applies (searches cost the most); after a 429 wait. Deleting (deals, persons and organizations stay in the trash for 30 days) and merging records always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['PUT', 'POST'],
      path: '^/(api/)?v1/(persons|organizations|deals)/[^/]+/merge$',
      reason: 'Merges two records into one',
    },
  ],
  docsUrl: 'https://developers.pipedrive.com/docs/api/v1',
  tokenUrl: 'https://app.pipedrive.com/settings/api',
  handle: 'pipedrive',
  access: {
    read: 'The agent can see deals, people, organizations and activities, and change nothing.',
    manage:
      'The agent can also add and change deals, people, notes and activities. Deleting and merging ask you first.',
  },
} satisfies CatalogEntryInput;
