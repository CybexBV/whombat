import {
  type CatalogEntryInput,
  certificateField,
  DELETES_ASK,
  REQUEST_TOOL_NAME,
  urlField,
} from './shared.js';

export const entry = {
  id: 'unifi_network',
  name: 'UniFi Network',
  category: 'infrastructure',
  description: 'Devices, clients, Wi-Fi and firewall on your UniFi console.',
  tagline: 'Wi-Fi and everything on it',
  signIn: [
    {
      kind: 'password',
      label: 'Sign in once',
      account: {
        label: 'Username',
        placeholder: 'admin',
        help: 'Best: a local admin (Admins & Users → Add Admin, Restrict to local access only, role Super Admin). A UI.com account asks for a code every time.',
      },
      secondFactor: 'asked',
      creates:
        'An API key named Whombat on this account. UniFi keys can’t be limited, so Whombat keeps it to the level you choose. The same key works for UniFi Network and Protect.',
      serviceLimits: false,
    },
    {
      kind: 'token',
      label: 'API key',
      auth: { type: 'header', name: 'X-API-KEY', template: '{secret}' },
      secretLabel: 'API key',
      secretHelp:
        'Sign in to the console itself (not unifi.ui.com), open Integrations at the bottom left (older versions: Settings → Control Plane → Integrations) and create an API key. It has its maker’s full rights and works for UniFi Protect too.',
      steps: [
        { text: 'Open the console itself in your browser (not unifi.ui.com).' },
        {
          text: 'Open Integrations at the bottom left (older versions: Settings → Control Plane → Integrations) and click Create API Key.',
          values: [{ label: 'Name', value: 'Whombat' }],
        },
        { text: 'Copy the key (it’s shown once) and paste it here.' },
      ],
    },
  ],
  fields: [
    urlField(
      'https://192.168.1.1',
      'Your UniFi console’s address on your network, like https://192.168.1.1 (UniFi OS Server: add :11443).',
    ),
    certificateField('your browser shows it under the padlock → certificate'),
  ],
  transport: 'rest',
  baseUrl: '{url}/proxy/network/integration',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/v1/info' },
  tools: [],
  request: { prefixes: ['/v1/'] },
  guide:
    'UniFi Network’s official API under /v1/. GET /v1/sites lists sites; every other path takes a site’s id (a UUID): /v1/sites/<siteId>/devices (APs, switches, gateway; …/devices/<id>/statistics/latest gives CPU, memory, uptime and uplink rates), /clients (connected now: WIRED, WIRELESS or VPN, with IP, MAC and uplinkDeviceId), /networks, /wifi/broadcasts, /firewall/policies, /firewall/zones, /acl-rules, /dns/policies, /hotspot/vouchers, /wans, /vpn/servers. Lists take offset and limit (≤200, default 25) and answer {offset, limit, count, totalCount, data}; filter with ?filter=name.like(\'kitchen*\') or and(type.eq(\'WIRELESS\'), ipAddress.isNotNull()). Actions: POST …/devices/<id>/actions {"action": "RESTART"}; POST …/devices/<id>/interfaces/ports/<portIdx>/actions {"action": "POWER_CYCLE"} restarts a PoE port; POST …/clients/<id>/actions {"action": "AUTHORIZE_GUEST_ACCESS", "timeLimitMinutes": 60} lets a guest in (UNAUTHORIZE_GUEST_ACCESS ends it); POST …/hotspot/vouchers makes vouchers. GET /v1/info gives the Network version: before 10.0 only sites, devices, clients and vouchers exist. Errors answer {statusCode, code, message}. Blocking or forgetting a client and port forwards aren’t in this API. Deleting, restarting a device, and changing the firewall, ACL rules or Wi-Fi networks always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT', 'PATCH'],
      path: '^/v1/sites/[^/]+/(firewall/|acl-rules|traffic-matching-lists)',
      reason: 'Changes the firewall or access rules',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT', 'PATCH'],
      path: '^/v1/sites/[^/]+/wifi/broadcasts',
      reason: 'Changes a Wi-Fi network or its password',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/v1/sites/[^/]+/devices/[^/]+/actions/?$',
      reason: 'Restarts a device; restarting the gateway takes the whole network down',
    },
  ],
  cutsOff: [
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT', 'PATCH'],
      path: '^/v1/sites/[^/]+/(networks|wans|dns/policies|vpn)(/|$)',
      reason: 'Changes a network, the internet connection, DNS or VPN',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/v1/sites/[^/]+/devices/[^/]+/interfaces/ports/[^/]+/actions/?$',
      reason: 'Restarts a port: what is plugged into it goes off for a moment',
    },
  ],
  docsUrl: 'https://developer.ui.com/network',
  tokenUrl: null,
  handle: 'unifi',
  access: {
    read: 'The agent can see devices, clients, networks and Wi-Fi, and change nothing.',
    manage:
      'The agent can also let guests in and make vouchers. Firewall and Wi-Fi changes, restarts and deleting ask you first.',
  },
  discovery: {
    targets: [
      { port: 443, scheme: 'https' },
      { port: 11443, scheme: 'https' },
    ],
    probes: [{ path: '/api/system', status: [200], bodyPattern: '"shortname"\\s*:\\s*"[^"]+"' }],
  },
} satisfies CatalogEntryInput;
