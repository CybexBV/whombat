import {
  type CatalogEntryInput,
  certificateField,
  REQUEST_TOOL_NAME,
  type SensitiveRule,
  urlField,
} from './shared.js';

/* Synology DSM and QNAP (0.110, CT-708, CT-709; Whombat desk-found.md NS-01…NS-08) ------------------------------- */

/**
 * Synology DSM's methods that only read (CT-708; NS-05): every call is `GET /webapi/entry.cgi?api=…&version=…&method=…`,
 * and these method names read on every API that has them (`SYNO.Core.System` `info`, `SYNO.Storage.CGI.Storage`
 * `load_info`, `SYNO.FileStation.List` `list_share`, `SYNO.Core.Upgrade.Server` `check`, `SYNO.Docker.Container`
 * `stats`). Anything else is a write.
 */
export const SYNOLOGY_READ_METHODS = [
  'get',
  'list',
  'info',
  'getinfo',
  'get_info',
  'load_info',
  'list_share',
  'query',
  'status',
  'check',
  'stats',
  'get_health_info',
  'get_smart_info',
  'download',
];

/** What always asks on Synology DSM (CT-708; NS-06): rules on a write's query, so reading never asks. */
export const SYNOLOGY_SENSITIVE: SensitiveRule[] = [
  {
    tools: [REQUEST_TOOL_NAME],
    arg: 'query',
    argValue: '^(shutdown|reboot)$',
    reason: 'Shuts down or restarts the NAS',
  },
  {
    tools: [REQUEST_TOOL_NAME],
    arg: 'query',
    argValue: '^(delete|remove|secure_erase|erase_all_data|prune|uninstall)(_[a-z_]+)?$',
    reason: 'Deletes something: a share, a volume, a snapshot, a user, a package or files',
  },
  {
    tools: [REQUEST_TOOL_NAME],
    arg: 'query',
    argValue: '^SYNO\\.Core\\.(User|Group|NormalUser|OTP|AppPriv|Share\\.Permission)(\\.|$)',
    reason: 'Changes users, groups, passwords or permissions',
  },
  {
    tools: [REQUEST_TOOL_NAME],
    arg: 'query',
    argValue: '^SYNO\\.Storage\\.',
    reason: 'Changes storage pools, volumes or disks; a mistake can lose data',
  },
  {
    tools: [REQUEST_TOOL_NAME],
    arg: 'query',
    argValue: '^SYNO\\.Core\\.Upgrade(\\.|$)',
    reason: 'Installs a DSM update; the NAS restarts',
  },
  {
    tools: [REQUEST_TOOL_NAME],
    arg: 'query',
    argValue: '^SYNO\\.Core\\.Terminal$',
    reason: 'Turns SSH or Telnet access on or off',
  },
  {
    tools: [REQUEST_TOOL_NAME],
    arg: 'query',
    argValue: '^SYNO\\.API\\.Auth$',
    reason: 'Signs in or out as the account Whombat uses',
  },
];

export const entry = {
  id: 'synology',
  name: 'Synology DSM',
  category: 'infrastructure',
  description:
    'Storage pools, disks, shares, packages, containers, backups and snapshots on your Synology NAS.',
  tagline: 'Storage, shares and backups',
  signIn: [
    {
      kind: 'token',
      label: 'Account and password',
      // A session (0.110, CT-708; NS-02, NS-03): DSM has no API keys for its own API, so Whombat signs in as a user of
      // its own with SYNO.API.Auth — a form, so the password stays out of URLs — and sends the session as `_sid`.
      auth: {
        type: 'session',
        login: {
          method: 'POST',
          path: '/webapi/entry.cgi',
          query: { api: 'SYNO.API.Auth', version: '6', method: 'login' },
          encoding: 'form',
          body: { account: '{username}', passwd: '{secret}', session: 'webui', format: 'sid' },
        },
        tokenJsonPath: 'data.sid',
        ttlSeconds: 1800,
        apply: { type: 'query', name: '_sid' },
        logout: {
          method: 'GET',
          path: '/webapi/entry.cgi',
          query: { api: 'SYNO.API.Auth', version: '6', method: 'logout' },
        },
        // Session timeout, interrupted by another sign-in, no such session, a sign-in from another address.
        stale: [{ json: 'error.code', values: ['106', '107', '119', '150'] }],
        failures: [
          { json: 'error.code', values: ['400'], reason: 'refused' },
          { json: 'error.code', values: ['401'], reason: 'disabled' },
          {
            json: 'error.code',
            values: ['402'],
            reason: 'denied',
            text: 'Synology DSM doesn’t let the user Whombat signs in as use DSM. Allow DSM for it under Control Panel → User & Group → Edit → Applications, then try again.',
          },
          // 403 (a code is needed) and 404 (the code didn't work) are `twoStep`'s (SG-09, CT-740).
          {
            json: 'error.code',
            values: ['406'],
            reason: 'two_step',
            text: 'DSM requires two-step sign-in for this user. Sign in to DSM as it once to set up a code, then connect.',
          },
          {
            json: 'error.code',
            values: ['407', '411'],
            reason: 'locked',
            text: 'Synology DSM blocked Whombat after too many tries. Remove its address under Control Panel → Security → Protection → Allow/Block List, or wait, then try again.',
          },
          { json: 'error.code', values: ['408', '409', '410'], reason: 'expired' },
        ],
        // Asked once (SG-09, CT-740), the way Home Assistant's Synology library does: with the code DSM is asked to
        // trust Whombat as a device, and every later sign-in sends that device token instead of a code.
        twoStep: {
          asked: { json: 'error.code', values: ['403'] },
          wrongCode: { json: 'error.code', values: ['404'] },
          code: { name: 'otp_code' },
          remember: {
            body: { enable_device_token: 'yes', device_name: 'Whombat' },
            tokenJsonPaths: ['data.device_id', 'data.did'],
            name: 'device_id',
            with: { device_name: 'Whombat' },
          },
          again: 'Synology asks for a two-step code again. Replace the password and enter a code.',
        },
      },
      secretLabel: 'Password',
      secretHelp:
        'Synology has no API keys for DSM, so Whombat signs in as a user of its own. Make one just for Whombat. With two-step sign-in, Whombat asks for a code once.',
      steps: [
        {
          text: 'In DSM, open Control Panel → User & Group → User and click Create. Name the user whombat and give it a strong password.',
          values: [{ label: 'Name', value: 'whombat' }],
        },
        {
          text: 'For Manage, add it to the administrators group. For Look only it may stay a plain user, but DSM then hides storage and system health from it; Whombat changes nothing on Look only either way.',
        },
        {
          text: 'Two-step sign-in may stay on: Whombat asks for a code once, and DSM then trusts it. Where Control Panel → Security → Account enforces it, sign in to DSM as whombat once to set up a code first.',
        },
        { text: 'Enter whombat and its password here.' },
      ],
    },
  ],
  fields: [
    urlField(
      'https://192.168.1.20:5001',
      'Your Synology’s address: https on port 5001, or http on port 5000 (DSM 7 or later).',
    ),
    {
      id: 'username',
      label: 'Account',
      placeholder: 'whombat',
      kind: 'text',
      required: true,
      help: 'The name of the user Whombat signs in as.',
    },
    certificateField('DSM → Control Panel → Security → Certificate, or your browser under the padlock'),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  // File Station's own information: any user File Station is allowed for may read it; an error has no `data`.
  check: {
    kind: 'request',
    method: 'GET',
    path: '/webapi/entry.cgi?api=SYNO.FileStation.Info&version=2&method=get',
    okJsonPath: 'data',
  },
  tools: [],
  // Every call is a GET with the method in the query: the method decides whether it reads (NS-05). GET only, so a
  // body can't name another method than the query does.
  request: {
    prefixes: ['/webapi/'],
    methods: ['GET'],
    readMethods: [],
    queryReads: [{ name: 'method', values: SYNOLOGY_READ_METHODS }],
  },
  guide:
    'Synology DSM 7’s Web API, GET only: /webapi/entry.cgi with api, version, method and the method’s parameters in the query (JSON values as JSON text); Whombat signs in as its user and adds the session itself. /webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=all lists every API with its maxVersion (Container Manager’s only when it is installed). Answers are {"success": true, "data": …}, or 200 with {"success": false, "error": {"code": n}}: 105 means the user may not (DSM shows storage and health only to administrators), 101–104 a wrong api, method or version. Health: SYNO.DSM.Info getinfo (version 2: model, version_string, temperature, uptime), SYNO.Core.System info (type=storage_v2 or network), SYNO.Core.System.Utilization get, SYNO.Storage.CGI.Storage load_info (pools, volumes, disks with smart_status and temp), SYNO.Core.Upgrade.Server check (update.available). Shares: SYNO.Core.Share list (shareType=all); snapshots: SYNO.Core.Share.Snapshot list (name). Packages: SYNO.Core.Package list. Containers: SYNO.Docker.Container list, get, stats, start, stop (name); logs: SYNO.Docker.Container.Log get (name). Backups: SYNO.Backup.Task list, status (task_id). Files: SYNO.FileStation.List list_share, list (folder_path). Shutting down or restarting, deleting anything, users, groups, passwords and permissions, storage changes and DSM updates always ask a person.',
  sensitive: SYNOLOGY_SENSITIVE,
  docsUrl:
    'https://global.download.synology.com/download/Document/Software/DeveloperGuide/Os/DSM/All/enu/DSM_Login_Web_API_Guide_enu.pdf',
  tokenUrl: '{url}/?launchApp=SYNO.SDS.AdminCenter.Application',
  handle: 'synology',
  access: {
    read: 'The agent can see storage, disks, shares, packages, containers, backups and snapshots, and change nothing.',
    manage:
      'The agent can also start and stop packages and containers, run backups and take snapshots. Restarts, deleting, users and permissions ask you first.',
  },
  discovery: {
    targets: [
      { port: 5001, scheme: 'https' },
      { port: 5000, scheme: 'http' },
    ],
    // What DSM answers before anyone signs in; it doesn't show its version there.
    probes: [
      {
        path: '/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth',
        status: [200],
        bodyPattern: '"SYNO\\.API\\.Auth"\\s*:\\s*\\{[^}]*"maxVersion"',
      },
    ],
  },
} satisfies CatalogEntryInput;
