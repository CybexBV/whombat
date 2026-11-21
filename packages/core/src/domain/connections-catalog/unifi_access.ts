import {
  BEARER,
  type CatalogEntryInput,
  certificateField,
  DELETES_ASK,
  REQUEST_TOOL_NAME,
  urlField,
} from './shared.js';

export const entry = {
  id: 'unifi_access',
  name: 'UniFi Access',
  category: 'home',
  description: 'Doors, readers, people and door logs in UniFi Access.',
  tagline: 'Doors, readers and who gets in',
  signIn: [
    {
      kind: 'token',
      label: 'API token',
      auth: BEARER,
      secretLabel: 'API token',
      secretHelp:
        'In UniFi Access, open Settings → General → Advanced → API Token and create one. A key from the console’s Integrations page is for UniFi Protect and doesn’t work here.',
      steps: [
        {
          text: 'In UniFi Access, open Settings → General → Advanced (newer versions: Settings → General), find API Token and click Create New.',
          values: [{ label: 'Name', value: 'Whombat' }],
        },
        {
          text: 'Choose Never expires (otherwise Whombat stops working on the day it ends) and the permission scopes: the view ones to look, the edit ones too to manage.',
        },
        { text: 'Click Create, copy the token (it’s shown once) and paste it here.' },
      ],
    },
  ],
  fields: [
    urlField(
      'https://192.168.1.1:12445',
      'Your UniFi console’s address with port 12445, where UniFi Access’s API is (UniFi Access 1.9.1 or later).',
    ),
    certificateField('port 12445 has its own: your browser shows it under the padlock → certificate'),
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  // A refused token can come back 200 with an error code and no data.
  check: { kind: 'request', method: 'GET', path: '/api/v1/developer/doors', okJsonPath: 'data' },
  tools: [],
  request: {
    prefixes: ['/api/v1/developer/'],
    readPaths: [{ method: 'POST', path: '^/api/v1/developer/system/logs(/export)?/?$' }],
  },
  guide:
    'UniFi Access’s API under /api/v1/developer/ (port 12445). Answers are {code, msg, data}: code SUCCESS, else an error code, sometimes with status 200 (CODE_UNAUTHORIZED: the token lacks that scope). Lists take page_num (from 1) and page_size, and answer pagination {page_num, page_size, total}. Doors: GET /api/v1/developer/doors (door_lock_relay_status lock or unlock, door_position_status open or close), /doors/<id>, /door_groups, GET /doors/<id>/lock_rule, GET /doors/settings/emergency. People: GET /api/v1/developer/users (?expand[]=access_policy), /users/search?keyword=…, /users/<id>, /user_groups, /visitors, /access_policies (and /schedules, /holiday_groups), /credentials/nfc_cards/tokens, /credentials/touch_passes. Devices: GET /api/v1/developer/devices; POST /devices/<id>/doorbell {"room_name"} rings one. Logs: POST /api/v1/developer/system/logs?page_num=1&page_size=25 {"topic": "door_openings", "since": <unix>, "until": <unix>} only reads (topics critical, door_openings, updates, device_events, admin_activity, visitor). Unlocking (PUT /doors/<id>/unlock), lock rules (PUT /doors/<id>/lock_rule {"type": "keep_lock"|"keep_unlock"|"custom"|"reset"|"lock_early"|"lock_now", "interval": minutes}), lockdown and evacuation (PUT /doors/settings/emergency {"lockdown", "evacuation"}), users, visitors, cards, PINs and touch passes (buying them costs money), policies, device settings, webhooks and deleting always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['PUT', 'POST'],
      path: '^/api/v1/developer/doors/[^/]+/unlock/?$',
      reason: 'Unlocks a door',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['PUT', 'POST'],
      path: '^/api/v1/developer/doors/[^/]+/lock_rule/?$',
      reason: 'Keeps a door locked or unlocked, or changes when it locks',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['PUT', 'POST'],
      path: '^/api/v1/developer/doors/settings/emergency/?$',
      reason: 'Locks down or evacuates every door',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT', 'PATCH'],
      path: '^/api/v1/developer/(users|user_groups|visitors|credentials)(/|$)',
      reason: 'Changes who can get in: people, visitors, cards, PINs or touch passes',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT', 'PATCH'],
      path: '^/api/v1/developer/(access_policies|door_groups)(/|$)',
      reason: 'Changes which doors people can open, and when',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PUT', 'PATCH'],
      path: '^/api/v1/developer/(devices/[^/]+/settings|webhooks|api_server)(/|$)',
      reason: 'Changes a reader’s settings, where door events are sent, or the API’s certificate',
    },
  ],
  docsUrl: 'https://assets.identity.ui.com/unifi-access/api_reference.pdf',
  tokenUrl: null,
  handle: 'access',
  access: {
    read: 'The agent can see doors, readers, people and the door logs, and change nothing.',
    manage:
      'The agent can also ring doorbells. Unlocking, lock rules, lockdowns, people and their cards and PINs ask you first.',
  },
  discovery: {
    targets: [{ port: 12445, scheme: 'https' }],
    probes: [{ path: '/api/v1/developer/doors', status: [401], bodyPattern: '"CODE_UNAUTHORIZED"' }],
  },
} satisfies CatalogEntryInput;
