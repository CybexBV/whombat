import {
  type CatalogEntryInput,
  certificateField,
  DELETES_ASK,
  REQUEST_TOOL_NAME,
  urlField,
} from './shared.js';

export const entry = {
  id: 'proxmox',
  name: 'Proxmox VE',
  category: 'infrastructure',
  description: 'Virtual machines and containers on your Proxmox server.',
  tagline: 'Virtual machines and backups',
  signIn: [
    {
      kind: 'password',
      label: 'Sign in once',
      account: {
        label: 'Username',
        placeholder: 'root@pam',
        help: 'With its realm, like root@pam or mara@pve. Without one, Whombat uses the default realm.',
      },
      secondFactor: 'asked',
      creates:
        'An API token named whombat on this account, with PVEAuditor to look, or the VM, storage and pool admin roles to manage (never users, permissions or power).',
      serviceLimits: true,
    },
    {
      kind: 'token',
      label: 'API token',
      auth: { type: 'header', name: 'Authorization', template: 'PVEAPIToken={tokenId}={secret}' },
      secretLabel: 'Token secret',
      secretPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      secretHelp:
        'Create one in Proxmox → Datacenter → Permissions → API Tokens → Add, and give it a role on the paths the agent may use.',
      steps: [
        { text: 'In Proxmox, open Datacenter → Permissions → API Tokens and click Add.' },
        {
          text: 'Pick your user, enter the token ID, untick Privilege Separation and click Add.',
          values: [{ label: 'Token ID', value: 'whombat' }],
        },
        { text: 'Copy the Token ID and the Secret it shows (only once) and paste both here.' },
      ],
      paste: [
        { target: 'tokenId', pattern: '\\b([^\\s@!:]+@[^\\s@!:]+![A-Za-z0-9._-]+)' },
        {
          target: 'secret',
          pattern: '\\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\b',
        },
      ],
    },
  ],
  fields: [
    urlField('https://pve.local:8006', 'Your Proxmox server’s address with its port (usually 8006).'),
    {
      id: 'tokenId',
      methods: ['token'],
      label: 'Token ID',
      placeholder: 'root@pam!whombat',
      kind: 'text',
      required: true,
      help: 'The user, realm and token name, as Proxmox shows it.',
      validation: {
        pattern: '^[^\\s@!]+@[^\\s@!]+![A-Za-z][A-Za-z0-9._-]*$',
        message: 'Write it like root@pam!whombat.',
      },
    },
    certificateField('Proxmox → node → System → Certificates'),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/api2/json/version' },
  tools: [],
  request: { prefixes: ['/api2/json/'] },
  guide:
    'Proxmox VE’s API under /api2/json/ (answers {"data": …}). GET /api2/json/cluster/resources?type=vm lists every VM and container with node, status, CPU and memory; GET /api2/json/nodes lists nodes. Per node: /nodes/<node>/qemu (VMs) and /nodes/<node>/lxc (containers); …/<vmid>/status/current reads one; POST …/<vmid>/status/start, /shutdown (clean), /stop (hard), /reboot; …/<vmid>/config reads and PUT changes settings; …/<vmid>/snapshot lists and POST makes snapshots. Changes answer a task id (UPID): GET /nodes/<node>/tasks/<upid>/status follows it. GET /api2/json/access/permissions shows what the token may do: a token only has the roles it was given. Stopping, shutting down, rebooting and deleting always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '/status/(stop|shutdown|reset|reboot|hibernate|suspend)$',
      reason: 'Stops or restarts a machine',
    },
  ],
  docsUrl: 'https://pve.proxmox.com/wiki/Proxmox_VE_API',
  tokenUrl: null,
  handle: 'proxmox',
  access: {
    read: 'The agent can see your VMs, containers, storage and tasks, and change nothing.',
    manage:
      'The agent can also start VMs and containers, take snapshots and change settings. Stopping, restarting and deleting ask you first.',
  },
  discovery: {
    targets: [{ port: 8006, scheme: 'https' }],
    probes: [
      { path: '/api2/json/access/domains', status: [200], bodyPattern: '"type"\\s*:\\s*"pve"' },
      {
        path: '/',
        status: [200],
        bodyPattern: 'Proxmox Virtual Environment',
        version: { pattern: 'ext6-pve\\.css\\?ver=([0-9][0-9.\\-]*)' },
      },
    ],
  },
  asServer: true,
} satisfies CatalogEntryInput;
