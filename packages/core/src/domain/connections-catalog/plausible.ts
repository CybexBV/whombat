import { BEARER, type CatalogEntryInput, DELETES_ASK, urlField } from './shared.js';

export const entry = {
  id: 'plausible',
  name: 'Plausible',
  category: 'business',
  description: 'Visitors, pages, sources and goals of your sites in Plausible Analytics.',
  signIn: [
    {
      kind: 'token',
      label: 'API key',
      auth: BEARER,
      secretLabel: 'API key',
      secretHelp:
        'In Plausible, pick the team at the top right, then open your account settings → API Keys → New API Key → Stats API. On plausible.io the Stats API needs a Business plan (a self-hosted Plausible always has it). The site must belong to that team.',
      steps: [
        {
          text: 'In Plausible, pick the team at the top right, then open your account settings → API Keys → New API Key.',
        },
        {
          text: 'Choose Stats API, name it and click Create API Key.',
          values: [{ label: 'Name', value: 'Whombat' }],
        },
        { text: 'Copy the key (it’s shown once) and paste it here.' },
      ],
    },
  ],
  fields: [
    urlField('https://plausible.io', 'plausible.io, or your own Plausible’s address.', {
      default: 'https://plausible.io',
    }),
    {
      id: 'site',
      label: 'Site',
      placeholder: 'example.com',
      kind: 'text',
      required: true,
      help: 'One of your sites as Plausible names it, to check the key with. The agent can read every site the key may.',
      validation: {
        pattern: '[A-Za-z0-9.-]+(/\\S*)?',
        message: 'Write the site’s domain, like example.com.',
      },
    },
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  // Works with a Stats API key on plausible.io and the community edition alike (the Sites API is neither's). On
  // plausible.io the Stats API is a Business plan's: other plans answer 402 (SG-11, CT-735).
  check: {
    kind: 'request',
    method: 'GET',
    path: '/api/v1/stats/realtime/visitors?site_id={site}',
    failures: [
      {
        status: [402],
        refused: false,
        text: 'Your Plausible plan doesn’t include the Stats API (it needs a Business plan).',
      },
    ],
  },
  tools: [],
  request: {
    prefixes: ['/api/v2/', '/api/v1/'],
    readPaths: [{ method: 'POST', path: '^/api/v2/query/?$' }],
  },
  guide:
    'Plausible’s Stats API: POST /api/v2/query (a read) {"site_id": "example.com", "metrics": ["visitors", "pageviews", "bounce_rate", "visit_duration"], "date_range": "7d", "dimensions": ["event:page"], "filters": [["is", "visit:country_name", ["Netherlands"]]], "order_by": [["visitors", "desc"]], "pagination": {"limit": 10}}. date_range: day, 24h, 7d, 28d, 30d, month, 6mo, 12mo, year, all, or ["2026-10-01", "2026-10-19"]. Dimensions: event:page, event:goal, event:hostname, event:props:<name>, visit:source, visit:referrer, visit:channel, visit:utm_source …, visit:device, visit:browser, visit:os, visit:country_name, visit:city_name, time:day, time:week, time:month. More metrics: visits, views_per_visit, events, conversion_rate (with event:goal), scroll_depth, time_on_page. It answers {results: [{dimensions, metrics}], meta, query}. Visitors right now: GET /api/v1/stats/realtime/visitors?site_id=… (a number). On plausible.io: GET /api/v1/sites, /api/v1/sites/<site_id>, /api/v1/sites/goals?site_id=… (making sites, goals and shared links needs a Sites API key). 600 requests an hour; errors are {"error": "…"} (401: a wrong key or site; 402: the plan lacks the Stats API). Deleting a site or a goal always asks a person.',
  sensitive: [DELETES_ASK],
  docsUrl: 'https://plausible.io/docs/stats-api',
  tokenUrl: '{url}/settings/api-keys',
  handle: 'plausible',
  access: {
    read: 'The agent can read your sites’ statistics, and change nothing.',
    manage:
      'The agent can also add goals and shared links where the key may. Deleting a site or a goal asks you first.',
  },
} satisfies CatalogEntryInput;
