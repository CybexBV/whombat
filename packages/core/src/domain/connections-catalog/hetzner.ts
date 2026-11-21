import { BEARER, type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME } from './shared.js';

export const entry = {
  id: 'hetzner',
  name: 'Hetzner Cloud',
  category: 'infrastructure',
  description: 'Servers, volumes and firewalls in a Hetzner Cloud project.',
  signIn: [
    {
      kind: 'token',
      label: 'API token',
      auth: BEARER,
      secretLabel: 'API token',
      secretHelp:
        'Create one in the Hetzner Console: your project → Security → API tokens → Generate API token.',
      steps: [
        { text: 'Open your project in the Hetzner Console (the link lists them).' },
        {
          text: 'Go to Security → API tokens and click Generate API token.',
          values: [{ label: 'Description', value: 'Whombat' }],
        },
        {
          text: 'Choose Read to look only, or Read & Write to manage, then copy the token and paste it here.',
        },
      ],
      paste: [{ target: 'secret', pattern: '\\b([A-Za-z0-9]{64})\\b' }],
    },
  ],
  fields: [],
  transport: 'rest',
  baseUrl: 'https://api.hetzner.cloud',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/v1/locations' },
  tools: [],
  request: { prefixes: ['/v1/'] },
  guide:
    'Hetzner Cloud API under /v1/. GET /v1/servers (and /v1/servers/<id>) lists servers with status, type and IPs; /v1/volumes, /v1/firewalls, /v1/networks, /v1/load_balancers, /v1/images, /v1/server_types, /v1/locations and /v1/pricing likewise. POST /v1/servers creates one (name, server_type, image, location, ssh_keys). Server actions: POST /v1/servers/<id>/actions/poweron, reboot, shutdown, poweroff, create_image, …; each answers an action: GET /v1/actions/<id> follows it (listing actions needs ?id=). DNS: /v1/zones and /v1/zones/<zone>/rrsets. Lists page with page and per_page. The token covers one project, 3 600 requests an hour. Power-offs, rebuilds, resets and deletes always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '/actions/(poweroff|shutdown|reset|reboot|rebuild|change_type|enable_rescue|reset_password|delete)$',
      reason: 'Stops, rebuilds or resets a server',
    },
  ],
  docsUrl: 'https://docs.hetzner.cloud/',
  tokenUrl: 'https://console.hetzner.com/projects',
  handle: 'hetzner',
  access: {
    read: 'The agent can see servers, volumes, networks and firewalls, and change nothing.',
    manage:
      'The agent can also create servers and change firewalls and DNS. Powering off, rebuilding and deleting ask you first.',
  },
} satisfies CatalogEntryInput;
