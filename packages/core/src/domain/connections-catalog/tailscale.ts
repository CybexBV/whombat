import { BEARER, type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME } from './shared.js';

export const entry = {
  id: 'tailscale',
  name: 'Tailscale',
  category: 'infrastructure',
  description: 'Devices, users, keys, DNS and the access policy of a Tailscale tailnet.',
  signIn: [
    {
      kind: 'client_credentials',
      label: 'OAuth client',
      tokenUrl: 'https://api.tailscale.com/api/v2/oauth/token',
      scopes: { read: ['all:read'], manage: ['all'] },
      secretLabel: 'Client secret',
      secretPlaceholder: 'tskey-client-…',
      secretHelp: 'An OAuth client never expires: Whombat trades its secret for a fresh token every hour.',
      steps: [
        { text: 'Open Settings → Trust credentials in the Tailscale admin console (the link opens it).' },
        { text: 'Click Credential → OAuth. In the All row, choose Read to look only, or Write to manage.' },
        { text: 'Click Generate credential, copy the client secret (it’s shown once) and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b(tskey-client-[A-Za-z0-9-]+)' }],
    },
    {
      kind: 'token',
      label: 'API access token',
      auth: BEARER,
      secretLabel: 'API access token',
      secretPlaceholder: 'tskey-api-…',
      secretHelp:
        'In the Tailscale admin console: Settings → Keys → Generate access token. Choose how many days it lasts (1 to 90) and make a new one when it runs out. You need to be an Owner, Admin, IT admin or Network admin.',
      steps: [
        { text: 'Open Settings → Keys in the Tailscale admin console and click Generate access token.' },
        { text: 'Choose how many days it lasts (at most 90), copy the token and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b(tskey-api-[A-Za-z0-9-]+)' }],
      links: {
        read: 'https://console.tailscale.com/admin/settings/keys',
        manage: 'https://console.tailscale.com/admin/settings/keys',
      },
    },
  ],
  fields: [],
  transport: 'rest',
  baseUrl: 'https://api.tailscale.com',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/api/v2/tailnet/-/settings' },
  tools: [],
  request: {
    prefixes: ['/api/v2/'],
    readPaths: [{ method: 'POST', path: '^/api/v2/tailnet/[^/]+/acl/(preview|validate)/?$' }],
    headers: { Accept: 'application/json' },
  },
  guide:
    'Tailscale API v2 under /api/v2/. Use - for your tailnet. Devices: GET /api/v2/tailnet/-/devices (?fields=all adds routes and posture; filter with ?hostname=…), GET /api/v2/device/{id} (nodeId preferred), POST /device/{id}/name, /expire, /ip. Users: GET /tailnet/-/users, GET /users/{id}. Policy file: GET /tailnet/-/acl; POST /tailnet/-/acl/validate and /acl/preview only test a change. DNS: GET/POST /tailnet/-/dns/nameservers, /searchpaths, /preferences, GET/PATCH /dns/split-dns. Keys: GET /tailnet/-/keys. Settings: GET /tailnet/-/settings. Audit log: GET /tailnet/-/logging/configuration?start=…&end=… (RFC 3339). Also /tailnet/-/webhooks, /services, /contacts, /user-invites. No paging: lists come back whole. Errors are {"message"}. 401 means the token ran out (tokens last 1 to 90 days) or was revoked, so the person makes a new one; 403 means their role can’t do that. Always asks a person: deleting anything (devices, keys, users, webhooks, Services), changing the policy file, creating or changing auth keys, OAuth clients or OAuth apps, rotating a webhook secret, authorising a device or changing its routes, tags, key expiry or Service approval, changing a user’s role, approving, suspending or restoring users, invites and device sharing, and tailnet settings.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/v2/tailnet/[^/]+/acl/?$',
      reason: 'Changes the policy file, which decides who can reach what',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT'],
      path: '^/api/v2/(tailnet/[^/]+/(keys|oauth-apps)(/[^/]+)?|webhooks/[^/]+/rotate)/?$',
      reason: 'Creates or changes an auth key, OAuth client or app, or a webhook secret',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/v2/(device/[^/]+/(authorized|key|routes|tags)|tailnet/[^/]+/services/[^/]+/device/[^/]+/approved)/?$',
      reason: 'Lets a device in, changes what it can reach, or stops its key from expiring',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/v2/(users/[^/]+/(role|approve|suspend|restore|delete)|tailnet/[^/]+/user-invites|device/[^/]+/device-invites|device-invites/[^/]+/accept)/?$',
      reason: 'Adds, removes or changes a person in the tailnet, or shares a device',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['PATCH'],
      path: '^/api/v2/tailnet/[^/]+/settings/?$',
      reason: 'Changes tailnet settings such as device approval and key expiry',
    },
  ],
  docsUrl: 'https://tailscale.com/api',
  tokenUrl: 'https://console.tailscale.com/admin/settings/trust-credentials',
  handle: 'tailscale',
  access: {
    read: 'The agent can see devices, users, DNS and the access policy, and change nothing.',
    manage:
      'The agent can also rename devices and change DNS. The policy file, keys, letting devices in and people ask you first.',
  },
} satisfies CatalogEntryInput;
