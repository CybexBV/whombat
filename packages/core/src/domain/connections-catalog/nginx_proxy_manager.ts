import { type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'nginx_proxy_manager',
  name: 'Nginx Proxy Manager',
  category: 'infrastructure',
  description: 'Proxy hosts, redirects, streams, access lists and certificates in Nginx Proxy Manager.',
  tagline: 'Web addresses and certificates',
  signIn: [
    {
      kind: 'token',
      label: 'Email and password',
      // A session (0.97, CT-470; CM-08): no API keys, so Whombat signs in as a user for a token that lasts a day.
      auth: {
        type: 'session',
        login: {
          method: 'POST',
          path: '/api/tokens',
          body: { identity: '{username}', secret: '{secret}' },
        },
        tokenJsonPath: 'token',
        expiresJsonPath: 'expires',
        ttlSeconds: 86_400,
        apply: { type: 'bearer' },
        // SG-21 (0.111, CT-749): a user with Two-Factor Auth on answers 200 without a token.
        failures: [
          {
            json: 'requires_2fa',
            values: ['true'],
            reason: 'two_step',
            text: 'This Nginx Proxy Manager user has Two-Factor Auth on, which Whombat can’t use. Make a user just for Whombat (Users → Add User), which starts without it, and enter that one here.',
          },
        ],
      },
      secretLabel: 'Password',
      secretHelp:
        'Nginx Proxy Manager has no API keys, so Whombat signs in as a user. Make one just for Whombat, with only the permissions it should have. A new user starts without Two-Factor Auth.',
      steps: [
        {
          text: 'In Nginx Proxy Manager, open Users → Add User. Give it a name and an email, and leave Administrator off.',
          values: [{ label: 'Full Name', value: 'Whombat' }],
        },
        {
          text: 'In its row’s menu, open Permissions: View Only to let the agent look, Manage for what it may change.',
        },
        {
          text: 'Open Set Password in the same menu, then enter that email and password here. Leave Two-Factor Auth off for this user.',
        },
      ],
    },
  ],
  fields: [
    urlField('http://192.168.1.2:81', 'Nginx Proxy Manager’s admin address, usually port 81.'),
    {
      id: 'username',
      label: 'Email',
      placeholder: 'whombat@example.com',
      kind: 'text',
      required: true,
      help: 'The email of the user Whombat signs in as.',
    },
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/api/users/me' },
  tools: [],
  // Not /api/tokens: a refreshed token would reach the agent.
  request: {
    prefixes: ['/api/nginx/', '/api/users', '/api/reports/', '/api/settings', '/api/audit-log', '/api/logs/'],
    readPaths: [{ method: 'POST', path: '^/api/nginx/certificates/(test-http|validate)$' }],
  },
  guide:
    'Nginx Proxy Manager’s API under /api/ (JSON); Whombat signs in as its user and sends the token itself. Proxy hosts: GET /api/nginx/proxy-hosts?expand=certificate,access_list (no paging; ?query= searches); POST /api/nginx/proxy-hosts {"domain_names": ["app.example.com"], "forward_scheme": "http", "forward_host": "192.168.1.20", "forward_port": 8080, "certificate_id": 3, "ssl_forced": true, "block_exploits": true, "allow_websocket_upgrade": true} adds one; PUT /api/nginx/proxy-hosts/{id} changes it; POST …/{id}/enable or …/{id}/disable. The same shape for /api/nginx/redirection-hosts, /api/nginx/dead-hosts (404 hosts) and /api/nginx/streams. Certificates: GET /api/nginx/certificates; POST /api/nginx/certificates/test-http {"domains": […]} checks a name is reachable first; POST /api/nginx/certificates {"provider": "letsencrypt", "domain_names": […], "meta": {"dns_challenge": false}} requests one ("certificate_id": "new" on a host does too); POST …/{id}/renew. Access lists: /api/nginx/access-lists. GET /api/reports/hosts counts hosts; /api/settings and /api/audit-log need an administrator. The user Whombat signs in as limits what agents can do: 403 “Permission Denied” means it lacks that permission. Errors are {"error": {"code", "message"}}. Users, permissions, passwords, signing in as someone else and deleting anything always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT'],
      path: '^/api/users(/|$)',
      reason: 'Adds a user, or changes users, passwords, permissions or two-step sign-in',
    },
  ],
  cutsOff: [
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT'],
      path: '^/api/nginx/(proxy-hosts|redirection-hosts|dead-hosts|streams|access-lists)(/|$)',
      reason: 'Changes where a site points or who may reach it',
    },
  ],
  docsUrl: 'https://nginxproxymanager.com/',
  tokenUrl: '{url}/users',
  handle: 'npm',
  access: {
    read: 'The agent can see proxy hosts, redirects, streams, access lists and certificates, and change nothing.',
    manage:
      'The agent can also add and change hosts and request certificates. Users, permissions and deleting ask you first.',
  },
  discovery: {
    targets: [{ port: 81, scheme: 'http' }],
    probes: [
      {
        path: '/api/',
        status: [200],
        bodyPattern: '"status"\\s*:\\s*"OK"[\\s\\S]*"version"\\s*:\\s*\\{\\s*"major"',
      },
    ],
  },
} satisfies CatalogEntryInput;
