import { BEARER, type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME } from './shared.js';

export const entry = {
  id: 'cloudflare',
  name: 'Cloudflare',
  category: 'infrastructure',
  description: 'DNS, Workers, Pages, R2, tunnels, Zero Trust and analytics in a Cloudflare account.',
  signIn: [
    // Cloudflare's own MCP server (the whole API), which any client registers with. Asked for exactly what the
    // manage token below holds, plus tunnels and their networks, so its consent page shows this list instead of
    // Minimal, Read only or Full access (Full access can transfer domains and add members). More is asked in the middle
    // of a task when a call needs it, never what `scopesNever` lists.
    {
      kind: 'mcp_oauth',
      label: 'Sign in with Cloudflare',
      mcpUrl: 'https://mcp.cloudflare.com/mcp',
      scopes: [
        'zone.read',
        'zone-settings.read',
        'zone-dns-settings.read',
        'dns.read',
        'dns.write',
        'ssl-and-certificates.read',
        'cache.purge',
        'analytics.read',
        'account-analytics.read',
        'argotunnel.read',
        'argotunnel.write',
        'teams-connector-cloudflared.read',
        'teams-connector-cloudflared.write',
        'teams-networks.read',
        'teams-networks.write',
        'teams.read',
        'access.read',
        'access-acct.read',
        'workers-scripts.read',
        'workers-scripts.write',
        'workers-routes.read',
        'workers-routes.write',
        'workers-kv-storage.read',
        'workers-kv-storage.write',
        'workers-r2.read',
        'workers-r2.write',
        'workers-tail.read',
        'page.read',
        'page.write',
        'd1.read',
        'd1.write',
      ],
      scopesNever: [
        'registrar-domains.admin',
        'registrar-sandbox-domains.admin',
        'memberships.write',
        'account-api-tokens.write',
        'account-settings.write',
        'user-details.write',
      ],
    },
    {
      kind: 'token',
      label: 'API token',
      transport: 'rest',
      auth: BEARER,
      secretLabel: 'API token',
      secretHelp:
        'In the Cloudflare dashboard: Manage account → Account API tokens → Create Token (keeps working when people leave), or My Profile → API Tokens. Pick a template or your own permissions; “Edit” lets the agent make changes.',
      steps: [
        {
          text: 'Open the link: Cloudflare fills in an account API token with the permissions for the level you chose.',
        },
        { text: 'Check them, click Continue to summary, then Create Token.' },
        { text: 'Copy the token (it’s shown once) and paste it here.' },
      ],
      // SG-21 (CT-749): tokens made before Cloudflare's prefixes are 40 bare characters, and still work.
      paste: [
        {
          target: 'secret',
          pattern: '\\b(cf[ua]t_[A-Za-z0-9_]{40,60}|[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-]))',
        },
      ],
      links: {
        read: 'https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22ssl_and_certificates%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_routes%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22page%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22argotunnel%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22teams%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22access%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22access_acct%22%2C%22type%22%3A%22read%22%7D%5D&name=Whombat',
        manage:
          'https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22account_analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22analytics%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22ssl_and_certificates%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_routes%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22page%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22argotunnel%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22teams%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22access%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22access_acct%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22cache%22%2C%22type%22%3A%22purge%22%7D%2C%7B%22key%22%3A%22workers_tail%22%2C%22type%22%3A%22read%22%7D%5D&name=Whombat',
      },
    },
  ],
  fields: [],
  transport: 'mcp',
  baseUrl: 'https://api.cloudflare.com',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/client/v4/accounts' },
  tools: [],
  request: {
    prefixes: ['/client/v4/'],
    readPaths: [{ method: 'POST', path: '^/client/v4/graphql/?$' }],
  },
  guide:
    'Cloudflare. Signed in with Cloudflare, use its own tools (they search and call the whole API). With a token, API v4 under /client/v4/. Answers are {success, errors[], messages[], result, result_info}; lists page with ?page=&per_page= (result_info.total_count), a few use ?cursor=. Find ids first: GET /client/v4/accounts, GET /client/v4/zones?name=example.com. Zone: /zones/{zone_id}/dns_records (GET, POST, PATCH /{id}), /settings, /rulesets, POST /purge_cache {"files":[…]} or {"purge_everything":true}. Account: /accounts/{account_id}/workers/scripts, /pages/projects/{name}/deployments, /r2/buckets, /storage/kv/namespaces, /d1/database, /cfd_tunnel, /members, /access/apps. Analytics: POST /client/v4/graphql, read-only GraphQL (viewer { zones(filter:{zoneTag:…}) { httpRequestsAdaptiveGroups(…) } }), 300 queries per 5 min. Overall 1 200 requests per 5 min; after a 429 wait 5 minutes. 403 (code 9109 or 10000) means the token lacks that permission or that zone or account: ask the person to add it to the token. Account tokens (cfat_) can’t use /user/…; check one with GET /accounts/{account_id}/tokens/verify, a user token with GET /user/tokens/verify. Always asks a person: deleting anything, creating, changing or rolling API tokens, adding or changing account members, Zero Trust Access apps, policies, groups, service tokens and identity providers, and creating tunnels or changing what they expose.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT'],
      path: '^/client/v4/(user|accounts/[^/]+)/tokens(/[^/]+(/value)?)?/?$',
      reason: 'Creates, changes or rolls an API token',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT'],
      path: '^/client/v4/accounts/[^/]+/members(/[^/]+)?/?$',
      reason: 'Adds someone to the account or changes their roles',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT', 'PATCH'],
      path: '^/client/v4/(accounts|zones)/[^/]+/access/(apps|policies|groups|service_tokens|identity_providers|certificates|organizations)(/.*)?$',
      reason: 'Changes who can get in through Zero Trust Access',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT', 'PATCH'],
      path: '^/client/v4/accounts/[^/]+/(cfd_tunnel(/[^/]+(/configurations)?)?|teamnet/routes(/.*)?)/?$',
      reason: 'Creates a tunnel or changes what it exposes',
    },
  ],
  docsUrl: 'https://developers.cloudflare.com/api/',
  tokenUrl: 'https://dash.cloudflare.com/?to=/:account/api-tokens',
  handle: 'cloudflare',
  access: {
    read: 'The agent can see zones, DNS, Workers, Pages, R2 and analytics, and change nothing.',
    manage:
      'The agent can also change DNS records, deploy Workers and Pages and purge caches. Tokens, members, Access and tunnels ask you first.',
  },
} satisfies CatalogEntryInput;
