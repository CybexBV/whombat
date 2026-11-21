import {
  type CatalogEntryInput,
  certificateField,
  DELETES_ASK,
  REQUEST_TOOL_NAME,
  urlField,
} from './shared.js';

export const entry = {
  id: 'proxmox_backup',
  name: 'Proxmox Backup Server',
  category: 'infrastructure',
  description: 'Datastores, backups, verify, sync and prune jobs on your Proxmox Backup Server.',
  tagline: 'Backups of your virtual machines',
  signIn: [
    {
      kind: 'password',
      label: 'Sign in once',
      account: {
        label: 'Username',
        placeholder: 'root@pam',
        help: 'With its realm, like root@pam or mara@pbs.',
      },
      secondFactor: 'asked',
      creates:
        'An API token named whombat on this account, with Audit to look, or the datastore, remote and tape admin roles to manage (never users, permissions or power).',
      serviceLimits: true,
    },
    {
      kind: 'token',
      label: 'API token',
      auth: { type: 'header', name: 'Authorization', template: 'PBSAPIToken={tokenId}:{secret}' },
      secretLabel: 'Token secret',
      secretPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      secretHelp:
        'Create one in Proxmox Backup Server → Configuration → Access Control → API Token → Add. A new token has no permissions: add it under Permissions with a role, for example Audit on / to look and DatastoreAdmin on /datastore to act.',
      steps: [
        {
          text: 'In Proxmox Backup Server, open Configuration → Access Control → API Token and click Add.',
          values: [{ label: 'Token Name', value: 'whombat' }],
        },
        { text: 'Copy the Token ID and the Secret it shows (only once).' },
        {
          text: 'Under Permissions, click Add → API Token Permission: path /, your token, role Audit to look or DatastoreAdmin to manage.',
          values: [{ label: 'Path', value: '/' }],
        },
        { text: 'Paste the Token ID and the Secret here.' },
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
    urlField('https://pbs.local:8007', 'Your Proxmox Backup Server’s address with its port (usually 8007).'),
    {
      id: 'tokenId',
      methods: ['token'],
      label: 'Token ID',
      placeholder: 'root@pam!whombat',
      kind: 'text',
      required: true,
      help: 'The user, realm and token name, as Proxmox Backup Server shows it.',
      validation: {
        pattern: '^[^\\s:/@!]+@[A-Za-z0-9_][A-Za-z0-9._-]*![A-Za-z0-9_][A-Za-z0-9._-]*$',
        message: 'Write it like root@pam!whombat.',
      },
    },
    certificateField('Proxmox Backup Server → Dashboard → Show Fingerprint'),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/api2/json/version' },
  tools: [],
  request: {
    prefixes: ['/api2/json/'],
    readPaths: [{ method: 'PUT', path: '^/api2/json/admin/s3/[^/]+/check$' }],
  },
  guide:
    'Proxmox Backup Server’s API under /api2/json/ (answers {"data": …}). GET /api2/json/admin/datastore lists datastores; GET /api2/json/status/datastore-usage gives total, used, avail and the estimated full date of each. Per datastore: /admin/datastore/<store>/status, /groups (backup-type vm, ct or host + backup-id, last-backup, backup-count) and /snapshots?backup-type=vm&backup-id=100 (backup-time, size, verification, protected); add ns=<namespace> for namespaces. GET …/<store>/gc reads garbage collection, POST starts it; POST …/<store>/verify verifies (filter with backup-type, backup-id, backup-time). Jobs: GET /admin/verify, /admin/sync, /admin/prune and /admin/gc list them with last and next run; POST /admin/verify/<id>/run or /admin/sync/<id>/run runs one. Long actions answer a task id (UPID): GET /nodes/localhost/tasks/<upid>/status follows it (URL-encode the UPID), …/log?limit=100 reads its log, GET /nodes/localhost/tasks?errors=1&limit=20 lists failed ones. GET /nodes/localhost/status reads CPU, memory and disk. A new token has no permissions: a 403 means it lacks a role on that path; GET /api2/json/access/permissions shows what it has. Deleting snapshots or groups, pruning (even a dry run), wiping disks, creating users or tokens, changing permissions, stopping services and rebooting or shutting down the server always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api2/json/admin/(datastore/[^/]+/prune(-datastore)?|prune/[^/]+/run)$',
      reason: 'Prunes backups: snapshots outside the keep rules are deleted',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api2/json/nodes/[^/]+/status$',
      reason: 'Reboots or shuts down the backup server',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT'],
      path: '^/api2/json/(nodes/[^/]+/disks/(wipedisk|initgpt|zfs|directory)|tape/drive/[^/]+/format-media)$',
      reason: 'Wipes or formats a disk or tape',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT'],
      path: '^/api2/json/access/(users(/[^/]+/token/[^/]+)?|acl|password|tfa/[^/]+)$',
      reason: 'Creates a user or token, or changes passwords or permissions',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api2/json/nodes/[^/]+/services/[^/]+/stop$',
      reason: 'Stops a service of the backup server',
    },
  ],
  docsUrl: 'https://pbs.proxmox.com/docs/api-viewer/index.html',
  tokenUrl: null,
  handle: 'pbs',
  access: {
    read: 'The agent can see datastores, backups and jobs, and change nothing.',
    manage:
      'The agent can also run verify, sync and garbage collection. Pruning and deleting backups ask you first.',
  },
  discovery: {
    targets: [{ port: 8007, scheme: 'https' }],
    probes: [{ path: '/api2/json/access/domains', status: [200], bodyPattern: '"type"\\s*:\\s*"pbs"' }],
  },
  asServer: true,
} satisfies CatalogEntryInput;
