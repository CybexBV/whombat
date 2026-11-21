import { BEARER, type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'grafana',
  name: 'Grafana',
  category: 'infrastructure',
  description:
    'Dashboards, data source queries, alerts and annotations in your Grafana or Grafana Cloud stack.',
  tagline: 'Dashboards and alerts',
  signIn: [
    {
      kind: 'password',
      label: 'Sign in once',
      account: {
        label: 'Username',
        placeholder: 'admin',
        help: 'An organisation admin of this Grafana (Grafana Cloud: make a token instead).',
      },
      secondFactor: 'never',
      creates:
        'A service account named Whombat with the Viewer role to look or Editor to manage, and a token for it.',
      serviceLimits: true,
    },
    {
      kind: 'token',
      label: 'Service account token',
      auth: BEARER,
      secretLabel: 'Service account token',
      secretPlaceholder: 'glsa_…',
      secretHelp:
        'In Grafana: Administration → Users and access → Service accounts → Add service account. Give it Viewer to look around or Editor to change dashboards and alerts. Then open it → Add service account token → Generate token.',
      steps: [
        {
          text: 'Open the link and name the service account Whombat, with Viewer to look or Editor to manage.',
          values: [{ label: 'Name', value: 'Whombat' }],
        },
        { text: 'On its page, click Add service account token → Generate token.' },
        { text: 'Copy the token (it’s shown once) and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b(glsa_[A-Za-z0-9_]+)' }],
      links: {
        read: '{url}/org/serviceaccounts/create',
        manage: '{url}/org/serviceaccounts/create',
      },
    },
  ],
  fields: [
    urlField(
      'https://grafana.example.com',
      'Your Grafana’s address, or your Grafana Cloud stack’s (https://yourstack.grafana.net).',
    ),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/api/org' },
  tools: [],
  request: {
    prefixes: ['/api/', '/apis/'],
    readPaths: [{ method: 'POST', path: '^/api/ds/query/?$' }],
    allowedHeaders: ['X-Disable-Provenance'],
  },
  guide:
    'Grafana HTTP API under /api/ (Grafana 13 adds /apis/; the old routes keep working). Find things: GET /api/search?query=…&type=dash-db|dash-folder&tag=…&limit=…&page=… (limit up to 5000). Dashboards: GET /api/dashboards/uid/{uid} → {dashboard, meta}; POST /api/dashboards/db {dashboard, folderUid, overwrite, message}; GET /api/folders. Data sources: GET /api/datasources, GET /api/datasources/uid/{uid}/health. Query: POST /api/ds/query {queries:[{refId:"A", datasource:{uid}, expr:…}], from:"now-1h", to:"now"}; copy the data source uid and query from a dashboard panel. Alerts: GET /api/prometheus/grafana/api/v1/rules (rules and their state), GET /api/alertmanager/grafana/api/v2/alerts (firing), silences at /api/alertmanager/grafana/api/v2/silences; rules, contact points, policies, mute timings and templates under /api/v1/provisioning/ (send X-Disable-Provenance: true so people can still edit them in Grafana). Annotations: GET /api/annotations?from=…&to=…&dashboardUID=…&tags=…&limit=…; POST /api/annotations {dashboardUID, panelId, time, text, tags}. 401 means a wrong or expired token; 403 means the service account’s role is too low (a Viewer can’t edit and may not list data sources). /api/user and /api/admin don’t take service account tokens. Always asks a person: deleting anything, service accounts and their tokens, adding people or changing roles, teams and permissions, public dashboards and snapshots, and server admin calls.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT', 'PATCH'],
      path: '^/api/(serviceaccounts(/[^/]+(/tokens)?)?|auth/keys)/?$',
      reason: 'Creates or changes a service account, or makes a token or API key',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT', 'PATCH'],
      path: '^/api/(org/(users(/[^/]+)?|invites)|teams/[^/]+/members|access-control/.+|.+/permissions)/?$',
      reason: 'Adds people, changes their roles or grants access',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT', 'PATCH'],
      path: '^/api/(admin|orgs|v1/sso-settings)(/.*)?$',
      reason: 'Changes users, organizations or sign-in for the whole Grafana',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT', 'PATCH'],
      path: '^/apis/iam\\.grafana\\.app/',
      reason: 'Changes users, teams, roles or service accounts',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT', 'PATCH'],
      path: '^/api/(dashboards/uid/[^/]+/public-dashboards(/.*)?|snapshots)/?$',
      reason: 'Shares a dashboard with people outside Grafana',
    },
  ],
  docsUrl: 'https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/',
  tokenUrl: '{url}/org/serviceaccounts',
  handle: 'grafana',
  access: {
    read: 'The agent can read dashboards, query data sources and see alerts, and change nothing.',
    manage:
      'The agent can also change dashboards, alerts and annotations. People, service accounts and sharing ask you first.',
  },
  discovery: {
    targets: [{ port: 3000, scheme: 'http' }],
    probes: [
      { path: '/api/health', status: [200], bodyPattern: '"database"\\s*:', version: { json: 'version' } },
    ],
  },
} satisfies CatalogEntryInput;
