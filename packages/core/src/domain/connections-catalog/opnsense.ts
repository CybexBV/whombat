import {
  type CatalogEntryInput,
  certificateField,
  DELETES_ASK,
  REQUEST_TOOL_NAME,
  urlField,
} from './shared.js';

export const entry = {
  id: 'opnsense',
  name: 'OPNsense',
  category: 'infrastructure',
  description: 'Firewall rules, DHCP, DNS and VPN on your OPNsense firewall.',
  tagline: 'Firewall, router and VPN',
  signIn: [
    {
      kind: 'password',
      label: 'Sign in once',
      account: {
        label: 'Username',
        placeholder: 'root',
        help: 'An admin of the firewall (OPNsense 25.1 or later).',
      },
      secondFactor: 'optional',
      creates:
        'An API key and secret on this account. OPNsense gives a key its user’s rights, so Whombat keeps it to the level you choose.',
      serviceLimits: false,
    },
    {
      kind: 'token',
      label: 'API key and secret',
      auth: { type: 'basic', usernameField: 'apiKey' },
      secretLabel: 'API secret',
      secretPlaceholder: 'The secret= value',
      secretHelp:
        'In OPNsense → System → Access → Users, press the ticket button on a user’s row (older versions: edit the user → API keys → +). It downloads a file: key= goes in API key, secret= here. The key has that user’s privileges.',
      steps: [
        { text: 'In OPNsense, open System → Access → Users.' },
        { text: 'Press the key button on your user’s row: a file with key= and secret= lines downloads.' },
        { text: 'Drop that file here, or paste what’s in it.' },
      ],
      paste: [
        { target: 'apiKey', pattern: '^\\s*key=(\\S+)\\s*$' },
        { target: 'secret', pattern: '^\\s*secret=(\\S+)\\s*$' },
      ],
    },
  ],
  fields: [
    urlField(
      'https://192.168.1.1',
      'Your OPNsense’s address, with the port if its web interface isn’t on 443.',
    ),
    {
      id: 'apiKey',
      methods: ['token'],
      label: 'API key',
      placeholder: 'w86XNZob/8Oq8aC5…',
      kind: 'text',
      required: true,
      help: 'The key= value from the file OPNsense downloaded.',
      validation: {
        pattern: '^[A-Za-z0-9+/]{16,200}={0,2}$',
        message: 'Paste the key= value from the downloaded file, without “key=”.',
      },
    },
    certificateField('your browser shows it under the padlock → certificate'),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/api/core/menu/tree' },
  tools: [],
  request: {
    prefixes: ['/api/'],
    readPaths: [
      { method: 'POST', path: '^/api/[^/]+/[^/]+/search[a-z_]*(/|$)' },
      { method: 'POST', path: '^/api/diagnostics/log/[^/]+/[^/]+/?$' },
      { method: 'POST', path: '^/api/diagnostics/firewall/query_?(states|pf_?top)$' },
      { method: 'POST', path: '^/api/firewall/alias_?util/find_?references$' },
      { method: 'POST', path: '^/api/core/firmware/(status|changelog|details|license)(/|$)' },
    ],
  },
  guide:
    'OPNsense’s API: /api/<module>/<controller>/<command>/<params…>, JSON both ways (send {} as the body of a POST without data); snake_case or camelCase names (search_rule = searchRule). GET reads; POST changes or acts, except search commands (search, search_item, search_rule…), which take {"current": 1, "rowCount": 50, "searchPhrase": ""} and answer {rows, rowCount, total, current}. Useful: GET /api/diagnostics/system/system_information, /api/core/system/status, /api/core/firmware/status, /api/diagnostics/interface/get_interface_statistics, /api/diagnostics/interface/get_arp, /api/core/service/search (POST /api/core/service/restart/<name>); /api/firewall/filter/search_rule, /api/firewall/d_nat/search_rule (port forwards), /api/firewall/alias/search_item, /api/unbound/settings/search_host_override; leases at /api/dnsmasq/leases/search or /api/kea/leases/search; logs: POST /api/diagnostics/log/core/system {"rowCount": 50, "searchPhrase": "…"}. Changes are staged: POST /api/firewall/filter/apply (aliases: /api/firewall/alias/reconfigure; others: /api/<module>/service/reconfigure) makes them live. Saves answer {"result": "saved", "uuid": …} or validation messages. A 403 means the key’s user lacks that page’s privilege; GET /api/core/menu/tree shows what it may reach. Deleting, changes to firewall rules, NAT, aliases, users, API keys, VPN or certificates, rebooting, powering off, updating, and resetting or restoring the configuration always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/[^/]+/[^/]+/(del|delete|remove|flush)[a-z_]*(/|$)|^/api/diagnostics/log/[^/]+/[^/]+/clear$',
      reason: 'Deletes something',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['GET', 'POST'],
      path: '^/api/firewall/[^/]+/(add|set|toggle_?(rule|item)(/|$)|move|import|upload|revert)',
      reason: 'Changes the firewall, NAT or aliases',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/auth/(user|group|priv)/(add|set|upload)',
      reason: 'Creates or changes users, API keys or privileges',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/(wireguard|openvpn|ipsec)/[^/]+/(add|set|toggle|import|upload)',
      reason: 'Changes who can reach your network over VPN',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/trust/(ca|cert)/(add|set|import)',
      reason: 'Creates or changes a certificate',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/core/(system/(reboot|halt)|firmware/(reboot|poweroff|update|upgrade))/?$',
      reason: 'Restarts, powers off or updates the firewall',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/core/(defaults/(factory_?defaults|reset)|backup/revert_?backup|snapshots/activate)(/|$)',
      reason: 'Resets or restores the firewall’s configuration',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      path: '^/api/core/backup/download(/|$)',
      reason: 'Downloads OPNsense’s configuration backup, which contains passwords and private keys',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      path: '^/api/trust/(ca|cert)/(get|generate_?file|raw_?dump)[a-z_]*(/|$)',
      reason: 'Reads a certificate or authority, including its private key',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      path: '^/api/auth/user/(get|download|new_?otp_?seed)[a-z_]*(/|$)',
      reason: 'Reads or generates user credentials, API keys or two-step secrets',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      path: '^/api/(wireguard/(server|client)|openvpn/(instances|export)|ipsec/(key_?pairs|pre_?shared_?keys|connections|settings))/(get|search|key_?pair|gen_?key|psk|download)[a-z_]*(/|$)',
      reason: 'Reads VPN configuration or keys, which may contain private keys or pre-shared secrets',
    },
  ],
  cutsOff: [
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/(unbound|dnsmasq|kea|dhcrelay|dhcpv4|dhcpv6)/[^/]+/(add|set|toggle)[a-z_]*(/|$)',
      reason: 'Changes DNS or DHCP, which every device on the network uses',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/interfaces/[^/]+/(add|set|toggle|reconfigure)[a-z_]*(/|$)',
      reason: 'Changes a network interface; a mistake can cut the network off',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/(core/service/(stop|restart)|(unbound|dnsmasq|kea)/service/(stop|restart|reconfigure))(/|$)',
      reason: 'Stops or restarts a service; DNS or DHCP going down cuts the network off',
    },
  ],
  docsUrl: 'https://docs.opnsense.org/development/api.html',
  tokenUrl: null,
  handle: 'opnsense',
  access: {
    read: 'The agent can see rules, leases, DNS, VPN and logs, and change nothing.',
    manage:
      'The agent can also restart services and change DNS and DHCP. Firewall, NAT, VPN, users and power ask you first.',
  },
  discovery: {
    targets: [{ port: 443, scheme: 'https' }],
    probes: [{ path: '/', header: { name: 'Server', pattern: 'OPNsense' } }],
  },
} satisfies CatalogEntryInput;
