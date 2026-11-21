import {
  type CatalogEntryInput,
  certificateField,
  type QueryRead,
  REQUEST_TOOL_NAME,
  type SensitiveRule,
  urlField,
} from './shared.js';

/**
 * QNAP's CGI calls that only read (CT-709; NS-05), by the parameter that names the function: `func` (File Station,
 * disks, snapshots, devices), `subfunc` (system information, firmware, apps), `chart_func` (volumes, bandwidth), and
 * `apply`, which carries an action under a `subfunc` (10 lists apps; 3 and 4 start and stop one). A call carrying one
 * reads only when each it carries reads; a call carrying none is a write.
 */
export const QNAP_QUERY_READS: QueryRead[] = [
  {
    name: 'func',
    values: [
      'get_tree',
      'get_list',
      'stat',
      'search',
      'download',
      'get_thumb',
      'check_sid',
      'extra_get',
      'all_hd_data',
      'getExternalDev',
      'external_get_all',
    ],
  },
  { name: 'subfunc', values: ['sysinfo', 'firm_update', 'qpkg'] },
  { name: 'chart_func', values: ['disk_usage', 'QSM40bandwidth', 'bandwidth'] },
  { name: 'apply', values: ['10'] },
];

/** What always asks on QNAP (CT-709; NS-06): rules on a write's query, so reading never asks. */
export const QNAP_SENSITIVE: SensitiveRule[] = [
  {
    tools: [REQUEST_TOOL_NAME],
    arg: 'query',
    argValue: '^(power_mgmt|shutdown|restart|reboot)$',
    reason: 'Shuts down or restarts the NAS',
  },
  {
    tools: [REQUEST_TOOL_NAME],
    arg: 'query',
    argValue: '^(delete|remove|del_[a-z_]+|delete_[a-z_]+|[a-z_]+_(delete|remove))$',
    reason: 'Deletes something: files, a share, a snapshot or a user',
  },
  {
    tools: [REQUEST_TOOL_NAME],
    arg: 'query',
    argValue: '^(volume_mgmt|pool_mgmt|vol_remove)$|format|init_disk',
    reason: 'Changes or removes a volume or a storage pool, or formats disks; a mistake can lose data',
  },
  {
    tools: [REQUEST_TOOL_NAME],
    path: '^/cgi-bin/(priv|accessrights)/',
    arg: 'query',
    argValue: '.',
    reason: 'Changes users, groups, passwords or permissions',
  },
  {
    tools: [REQUEST_TOOL_NAME],
    arg: 'query',
    argValue: '^(user|group)_[a-z_]+$|password',
    reason: 'Changes users, groups, passwords or permissions',
  },
  {
    tools: [REQUEST_TOOL_NAME],
    arg: 'query',
    argValue: '^firm_update$',
    reason: 'Installs a firmware update; the NAS restarts',
  },
];

export const entry = {
  id: 'qnap',
  name: 'QNAP',
  category: 'infrastructure',
  description:
    'Storage pools, volumes, disks, files, apps and snapshots on your QNAP NAS (QTS or QuTS hero).',
  tagline: 'Storage, shares and snapshots',
  signIn: [
    {
      kind: 'token',
      label: 'Account and password',
      // A session (0.110, CT-709; NS-02, NS-03): QTS has no API keys, so Whombat signs in with authLogin.cgi — a form,
      // the password in base64 as QTS wants it — reads `authSid` from the XML and sends it as `sid`.
      auth: {
        type: 'session',
        login: {
          method: 'POST',
          path: '/cgi-bin/authLogin.cgi',
          encoding: 'form',
          body: { user: '{username}', pwd: '{secret:base64}', serviceKey: '1' },
        },
        tokenXmlTag: 'authSid',
        ttlSeconds: 1800,
        apply: { type: 'query', name: 'sid' },
        logout: { method: 'GET', path: '/cgi-bin/authLogout.cgi', query: { logout: '1' } },
        // QTS answers an ended session 200 with authPassed 0 in XML, File Station with {"status": 3} in JSON.
        stale: [
          { xml: 'authPassed', values: ['0'] },
          { json: 'status', values: ['3'], path: '^/cgi-bin/filemanager/' },
        ],
        // QTS tells only a two-step code and a refused service apart; a disabled or blocked account looks refused.
        failures: [
          { xml: 'need_2sv', values: ['1'], reason: 'two_step' },
          { xml: 'PermissionDeny', values: ['1'], reason: 'denied' },
          {
            xml: 'authPassed',
            values: ['0'],
            reason: 'refused',
            text: 'QNAP refused the account name or password. Check them, and that the account is on and not blocked by Access Protection, then try again.',
          },
        ],
      },
      secretLabel: 'Password',
      secretHelp:
        'QNAP has no API keys, so Whombat signs in as a user of its own. Make one just for Whombat, and leave two-step sign-in off for it.',
      steps: [
        {
          text: 'In QTS, open Control Panel → Privilege → Users and choose Create → Create a User. Name it whombat and give it a strong password.',
          values: [{ label: 'Username', value: 'whombat' }],
        },
        {
          text: 'For Manage, add it to the administrators group. For Look only it may stay in everyone, but QTS then hides most of the system from it; Whombat changes nothing on Look only either way.',
        },
        { text: 'Leave 2-step verification off for this user.' },
        { text: 'Enter whombat and its password here.' },
      ],
    },
  ],
  fields: [
    urlField(
      'https://192.168.1.21',
      'Your QNAP’s address: https (usually port 443), or http on port 8080 (QTS 5 or QuTS hero).',
    ),
    {
      id: 'username',
      label: 'Account',
      placeholder: 'whombat',
      kind: 'text',
      required: true,
      help: 'The name of the user Whombat signs in as.',
    },
    certificateField(
      'QTS → Control Panel → Security → SSL Certificate & Private Key, or your browser under the padlock',
    ),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  // File Station's session check: {"status": 1} for a working session.
  check: {
    kind: 'request',
    method: 'GET',
    path: '/cgi-bin/filemanager/utilRequest.cgi?func=check_sid',
    okAnswer: { json: 'status', values: ['1'] },
  },
  tools: [],
  // GET only, the function in the query (NS-05); not authLogin.cgi or authLogout.cgi.
  request: {
    prefixes: [
      '/cgi-bin/management/',
      '/cgi-bin/disk/',
      '/cgi-bin/sys/',
      '/cgi-bin/filemanager/',
      '/cgi-bin/application/',
      '/cgi-bin/devices/',
      '/cgi-bin/priv/',
      '/cgi-bin/accessrights/',
      '/cgi-bin/wizReq.cgi',
    ],
    methods: ['GET'],
    readMethods: [],
    queryReads: QNAP_QUERY_READS,
  },
  guide:
    'QNAP QTS and QuTS hero answer CGI calls under /cgi-bin/, GET only, the function in the query; Whombat signs in as its user and adds the session itself. Most answers are XML (<QDocRoot>, values in CDATA). Health: /cgi-bin/management/manaRequest.cgi?subfunc=sysinfo&hd=no&multicpu=1 (func/ownContent/root: cpu_usage, total_memory, free_memory, sys_tempc, cpu_tempc, uptime; model, firmware), …?subfunc=sysinfo&sysHealth=1 (sysHealth status good). Disks: /cgi-bin/disk/qsmart.cgi?func=all_hd_data (Health, Temperature, Model). Volumes: /cgi-bin/management/chartReq.cgi?chart_func=disk_usage&disk_select=all&include=all. Pools: /cgi-bin/disk/disk_manage.cgi?func=extra_get&store=poolList&extra_pool_index=1. Snapshots: /cgi-bin/disk/snapshot.cgi?func=extra_get&volumeID=<id>&snapshot_list=1&snap_start=0&snap_count=100. Firmware: /cgi-bin/sys/sysRequest.cgi?subfunc=firm_update (newVersion). Apps: /cgi-bin/application/appRequest.cgi?subfunc=qpkg&apply=10&action=reload. Files (JSON): /cgi-bin/filemanager/utilRequest.cgi?func=get_tree&node=share_root, func=get_list&path=/<share>&start=0&limit=100, func=stat; status 1 is fine, 4 not allowed, 5 not found. A call without func, subfunc or chart_func counts as a change. Shutting down or restarting, deleting files, shares, volumes or snapshots, users, passwords and permissions, firmware updates and formatting disks always ask a person.',
  sensitive: QNAP_SENSITIVE,
  docsUrl: 'https://download.qnap.com/dev/API_QNAP_QTS_Authentication.pdf',
  tokenUrl: '{url}/cgi-bin/',
  handle: 'qnap',
  access: {
    read: 'The agent can see storage, disks, files, apps and snapshots, and change nothing.',
    manage:
      'The agent can also start and stop apps and take snapshots. Restarts, deleting, users and permissions ask you first.',
  },
  discovery: {
    targets: [
      { port: 443, scheme: 'https' },
      { port: 8080, scheme: 'http' },
    ],
    // What QTS answers before anyone signs in: the model and, unless hidden, the firmware (QuTS hero's starts with h).
    probes: [
      {
        path: '/cgi-bin/authLogin.cgi',
        status: [200],
        bodyPattern: '<QDocRoot[\\s>]',
        version: { pattern: '<firmware>\\s*<version>\\s*(?:<!\\[CDATA\\[)?\\s*([hH]?[0-9][0-9.]*)' },
      },
    ],
  },
} satisfies CatalogEntryInput;
