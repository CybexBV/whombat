import { BEARER, type CatalogEntryInput, REQUEST_TOOL_NAME, urlField } from './shared.js';

/**
 * Home Assistant domains whose services open, unlock or arm things (CX-31). Covers are left to the words below since
 * 0.58 (CT-311): most are blinds and curtains; a garage door, gate or door says so in its name.
 */
export const HA_SENSITIVE_DOMAINS = 'lock|alarm_control_panel|valve|siren|garage';

/**
 * Words that name a lock, an alarm, a gate or a door in a Home Assistant name, an entity id or a script (CX-31, CT-311),
 * English and Dutch (`poort`, `hek`, `deur`, `slot`): `lock`, `gate`, `door`, `hek` and `slot` as whole words (not
 * “clock”, “doorbell”), the rest anywhere (“voordeur”, “garagepoort”, “alarm_uitschakelen”).
 */
export const HA_SENSITIVE_WORDS =
  '(^|[^a-z])(un)?lock(s|ed)?([^a-z]|$)|(^|[^a-z])(gate|door|hek|slot)([^a-z]|$)|alarm|garage|poort|deur|siren';

export const HA_SENSITIVE_REASON = 'Locks, alarms, gates and doors always ask';

export const entry = {
  id: 'homeassistant',
  name: 'Home Assistant',
  category: 'home',
  description: 'Lights, sensors and automations in your home.',
  tagline: 'Lights, heating and sensors',
  signIn: [
    {
      kind: 'password',
      label: 'Sign in once',
      account: {
        label: 'Username',
        placeholder: 'mara',
        help: 'The name you sign in to Home Assistant with.',
      },
      secondFactor: 'asked',
      creates:
        'A long-lived access token named Whombat on this account. Home Assistant can’t limit a token, so Whombat keeps it to the level you choose.',
      serviceLimits: false,
    },
    {
      kind: 'token',
      label: 'Access token',
      auth: BEARER,
      secretLabel: 'Long-lived access token',
      secretHelp:
        'Create one in Home Assistant: your profile → Security → Long-lived access tokens → Create token.',
      steps: [
        { text: 'Open your profile in Home Assistant (your name, bottom left) and go to Security.' },
        {
          text: 'Under Long-lived access tokens, click Create token and give it a name.',
          values: [{ label: 'Name', value: 'Whombat' }],
        },
        { text: 'Copy the token (it’s shown once) and paste it here.' },
      ],
      paste: [{ target: 'secret', pattern: '\\b(eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]+)' }],
    },
    {
      kind: 'ha_oauth',
      label: 'Sign in with Home Assistant',
      authorizePath: '/auth/authorize',
      tokenPath: '/auth/token',
    },
  ],
  fields: [
    urlField(
      'http://homeassistant.local:8123',
      'The address Whombat reaches Home Assistant at. On your network it needs a home-network allowance.',
    ),
  ],
  transport: 'mcp',
  baseUrl: '{url}',
  mcpPath: '/api/mcp',
  mcpMissingHint:
    'Add the Model Context Protocol Server integration in Home Assistant (Settings → Devices & services) to give the agent its tools. Until then it uses the REST API.',
  mcpSetup: { kind: 'ha_config_flow', handler: 'mcp_server' },
  check: { kind: 'request', method: 'GET', path: '/api/' },
  tools: [],
  request: {
    prefixes: ['/api/'],
    alongsideMcp: true,
    // Reads Home Assistant takes as a POST (0.91, CT-400): rendering a template, checking the configuration, and the
    // services that only answer data (calendar/get_events, weather/get_forecasts, todo/get_items).
    readPaths: [
      { method: 'POST', path: '^/api/template$' },
      { method: 'POST', path: '^/api/config/core/check_config$' },
      { method: 'POST', path: '^/api/services/[a-z0-9_]+/get_[a-z0-9_]+$' },
    ],
  },
  guide:
    'Home Assistant’s REST API: paths start with /api/ (the slash after api matters). GET /api/states lists every entity with its state and attributes; GET /api/states/<entity_id> reads one (light.kitchen). GET /api/services lists what can be called. POST /api/services/<domain>/<service> with JSON like {"entity_id": "light.kitchen"} calls a service (light/turn_on, climate/set_temperature); add ?return_response for services that answer data (those named get_…, like calendar/get_events, only read). GET /api/history/period/<ISO time>?filter_entity_id=<id> gives history (filter_entity_id is required). POST /api/template {"template": "{{ states(\'sensor.outside\') }}"} renders a template and only reads, as does POST /api/config/core/check_config. GET /api/config shows the setup. When the Model Context Protocol Server integration is on, its own tools (…HassTurnOn, …HassTurnOff, …GetLiveContext) are usually easier: they find devices by name and area, and see only what is exposed to Assist (a missing device: ask the person to expose it under Settings → Voice assistants → Expose). Pass the domain when turning something on or off. Locks, alarms, gates and doors always ask a person first.',
  sensitive: [
    // An action naming a sensitive domain (`lock`, `lock.front_door`) or a lock, alarm, gate or door (`…HassTurnOff`
    // with “Voordeur”, a service call on `cover.garage_door`); reading one (`…GetLiveContext`) doesn't ask.
    { argValue: `^(${HA_SENSITIVE_DOMAINS})(\\.[a-z0-9_]+)?$`, reason: HA_SENSITIVE_REASON },
    { argValue: HA_SENSITIVE_WORDS, reason: HA_SENSITIVE_REASON },
    // A script named for one (`assist__script__poort_openen`), and raw KNX bus writes (any device, locks included).
    { tools: ['*script*'], name: HA_SENSITIVE_WORDS, reason: HA_SENSITIVE_REASON },
    { name: 'group_value_write', reason: 'Writes straight to the KNX bus' },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: `^/api/services/(${HA_SENSITIVE_DOMAINS})/`,
      reason: HA_SENSITIVE_REASON,
    },
  ],
  docsUrl: 'https://developers.home-assistant.io/docs/api/rest/',
  tokenUrl: '{url}/profile/security',
  handle: 'homeassistant',
  access: {
    read: 'The agent can see your devices, their state and history, and change nothing.',
    manage:
      'The agent can also switch devices, run scripts and change automations. Locks, alarms, gates and doors still ask you first.',
  },
  discovery: {
    targets: [
      { port: 8123, scheme: 'http' },
      { port: 8123, scheme: 'https' },
    ],
    probes: [{ path: '/manifest.json', status: [200], bodyPattern: '"name"\\s*:\\s*"Home Assistant"' }],
  },
} satisfies CatalogEntryInput;
