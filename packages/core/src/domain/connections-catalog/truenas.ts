import { BEARER, type CatalogEntryInput, certificateField, SOCKET_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'truenas',
  name: 'TrueNAS',
  category: 'infrastructure',
  description: 'Pools, datasets, snapshots, shares, apps and alerts on your TrueNAS.',
  tagline: 'Storage and snapshots',
  signIn: [
    {
      kind: 'token',
      label: 'API key',
      // Not sent on the socket's handshake: the socket signs in with auth.login_with_api_key (CT-471).
      auth: BEARER,
      secretLabel: 'API key',
      secretPlaceholder: '1-…',
      secretHelp:
        'In TrueNAS, open My API Keys from the menu at the top right and add one. The key has its user’s rights; it stops working if it is ever sent over plain http.',
      steps: [
        {
          text: 'In TrueNAS, open My API Keys from the menu at the top right (25.10: the Settings menu) and click Add.',
          values: [{ label: 'Name', value: 'Whombat' }],
        },
        {
          text: 'Pick the user whose rights the key gets (an admin to manage, a read-only admin to look), tick Non-expiring or pick a date, and click Save.',
        },
        { text: 'Copy the key it shows (only once) and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b([0-9]+-[A-Za-z0-9]{64})\\b' }],
    },
  ],
  fields: [
    urlField('https://192.168.1.30', 'Your TrueNAS’s https address (TrueNAS 25.04 or later).', {
      // CM-05: TrueNAS turns a key off when it is used over plain http (0.97, CT-474).
      validation: {
        pattern: 'https://.*',
        message: 'TrueNAS turns a key off when it’s used over plain http. Use its https address.',
      },
    }),
    certificateField('TrueNAS → System → Certificates, or your browser under the padlock'),
  ],
  transport: 'socket',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'socket', method: 'system.info', params: [], version: 'version' },
  tools: [],
  request: null,
  socket: {
    dialect: 'jsonrpc',
    path: '/api/current',
    login: { method: 'auth.login_with_api_key', params: ['{secret}'], when: 'always' },
    reads: [
      '(?!(certificate|certificateauthority|keychaincredential|cloudsync\\.credentials)\\.)[a-z0-9_]+(\\.[a-z0-9_]+)*\\.(query|get_instance)',
      '[a-z0-9_]+(\\.[a-z0-9_]+)*\\.config',
      'system\\.(info|version|version_short|ready|state|boot_id|product_type|host_id)',
      'alert\\.(list|list_categories|list_policies)',
      'disk\\.(temperatures|temperature_agg|temperature_alerts|details)',
      'pool\\.dataset\\.(details|processes|get_quota|encryption_summary)',
      'pool\\.(get_disks|is_upgraded|validate_name)',
      'update\\.(status|check_available|get_trains|get_pending|get_auto_download|available_versions|profile_choices)',
      'core\\.(get_jobs|ping)',
      'auth\\.me',
      'api_key\\.my_keys',
      'reporting\\.(graphs|get_data|netdata_graphs|netdata_get_data)',
      'app\\.(available|categories|latest|similar|used_ports|used_host_ips)',
      'service\\.started',
      'smart\\.test\\.results',
      'filesystem\\.(stat|listdir|statfs|getacl|acl_is_trivial|get_zfs_attributes|default_acl_choices)',
      'boot\\.(get_state|get_disks)',
      'network\\.general\\.summary',
      'vm\\.status',
    ],
    refused: [
      'auth\\.(?!me$).*',
      'core\\.(subscribe|unsubscribe|set_options|download|upload|job_download_logs)',
      'user\\.setup_local_administrator',
      'system\\.debug',
      'config\\.save',
    ],
    missing: 'This TrueNAS is older than 25.04: update it, then connect it.',
  },
  guide:
    'TrueNAS 25.04 or later over its JSON-RPC 2.0 WebSocket API; Whombat signs in with the key. One method per call, params positional: {"method": "pool.query", "params": []}. Queries take [filters, options]: pool.dataset.query [[["pool", "=", "tank"]], {"select": ["name", "used", "available"], "limit": 50, "offset": 0, "order_by": ["name"]}]; get_instance takes an id. Reads: system.info (version, uptime, loadavg), pool.query (status, healthy, topology), pool.dataset.query, pool.dataset.details, pool.scrub.query, disk.query, disk.temperatures, alert.list, sharing.smb.query, sharing.nfs.query, app.query, vm.query, service.query, replication.query, cloudsync.query, reporting.netdata_get_data, core.get_jobs. Snapshots are pool.snapshot.* on 25.10 and zfs.snapshot.* on 25.04; updates: update.status on 25.10, update.check_available on 25.04. Jobs (pool.snapshot.create [{"dataset": "tank/docs", "name": "manual-1"}], pool.scrub.run, app.start, app.stop, service.control …) answer a job id: follow it with core.get_jobs [[["id", "=", <id>]]] until state is SUCCESS or FAILED (progress.percent meanwhile). Errors are error {code, message, data.reason}. Deleting, exporting or wiping a pool, dataset, zvol, snapshot or disk, rolling back, rebooting or shutting down, installing an update, users, groups, API keys, SSH, certificates, network settings, encryption keys and changing files or permissions always ask a person.',
  sensitive: [
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^pool\\.(export|remove|detach|offline|replace|upgrade)$',
      reason: 'Exports a pool or takes disks out of one; exporting can destroy it',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^(pool|zfs)\\.snapshot\\.rollback$',
      reason: 'Rolls a dataset back to a snapshot; anything newer is lost',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^system\\.(reboot|shutdown)$',
      reason: 'Restarts or shuts down the NAS',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^update\\.(update|run|download|manual|file)$',
      reason: 'Installs an update or changes how updates happen; installing restarts the NAS',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^(user|group|privilege|api_key)\\.',
      reason: 'Changes users, groups, privileges or API keys',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^ssh\\.update$',
      reason: 'Changes SSH access',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'params',
      argValue: '^ssh$',
      reason: 'Starts, stops or changes SSH access',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^(certificate|certificateauthority|acme\\.dns\\.authenticator)\\.',
      reason: 'Reads a certificate’s private key or changes a certificate',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue:
        '^(keychaincredential|cloudsync\\.credentials)\\.|^pool\\.dataset\\.export_keys?(_for_replication)?$',
      reason: 'Reads or changes private keys or stored passwords',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^pool\\.dataset\\.(change_key|lock)$',
      reason: 'Changes or locks a dataset’s encryption',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^filesystem\\.',
      reason: 'Changes files or their permissions on the NAS',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^config\\.(reset|upload)$',
      reason: 'Resets or replaces the NAS’s configuration',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^interface\\.(create|update|commit|rollback)$',
      reason: 'Changes the network settings; a mistake can cut the NAS off',
    },
  ],
  docsUrl: 'https://api.truenas.com/v25.10/',
  tokenUrl: null,
  handle: 'truenas',
  access: {
    read: 'The agent can see pools, datasets, snapshots, shares, apps and alerts, and change nothing.',
    manage:
      'The agent can also take snapshots, run scrubs and start or stop apps. Deleting, rolling back, restarts, updates and users ask you first.',
  },
  discovery: {
    targets: [{ port: 443, scheme: 'https' }],
    probes: [
      { path: '/api/versions', status: [200], bodyPattern: '^\\s*\\[\\s*"v2[0-9]\\.[0-9]{2}\\.[0-9]+"' },
    ],
  },
} satisfies CatalogEntryInput;
