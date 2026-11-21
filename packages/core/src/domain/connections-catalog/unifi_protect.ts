import {
  type CatalogEntryInput,
  certificateField,
  DELETES_ASK,
  REQUEST_TOOL_NAME,
  urlField,
} from './shared.js';

export const entry = {
  id: 'unifi_protect',
  name: 'UniFi Protect',
  category: 'home',
  description: 'Cameras, snapshots, sensors, lights and the alarm in UniFi Protect.',
  tagline: 'Cameras and doorbells',
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
        'Sign in to the console itself as an administrator (not unifi.ui.com), open Integrations at the bottom left (older versions: Settings → Control Plane → Integrations) and create an API key. A key made for UniFi Network works too.',
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
  baseUrl: '{url}/proxy/protect/integration',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'request', method: 'GET', path: '/v1/meta/info' },
  tools: [],
  request: { prefixes: ['/v1/'] },
  guide:
    'UniFi Protect’s official API under /v1/; lists are plain arrays, no paging. GET /v1/cameras lists cameras (id, name, state CONNECTED or DISCONNECTED, isMicEnabled, smartDetectSettings, hasPackageCamera); PATCH /v1/cameras/<id> changes name, LEDs, mic volume, smart detections or a doorbell’s lcdMessage. GET /v1/cameras/<id>/snapshot is a JPEG (?highQuality=true, ?channel=package; binary: answered as a note). GET /v1/sensors (isOpened, isMotionDetected, motionDetectedAt, leakDetectedAt, batteryStatus, stats), /v1/lights (isLightOn, lastMotion), /v1/sirens, /v1/chimes, /v1/relays, /v1/viewers, /v1/liveviews, /v1/nvrs, /v1/users and /v1/arm-profiles read the rest. Actions: PATCH /v1/lights/<id> {"isLightForceEnabled": true} turns a light on; POST /v1/sirens/<id>/play or /stop; POST /v1/cameras/<id>/ptz/goto/<slot>, …/ptz/patrol/start/<slot> and …/ptz/patrol/stop move a PTZ camera; PATCH /v1/viewers/<id> {"liveview": "<id>"} switches a Viewport. Events only come over a WebSocket (/v1/subscribe/events) this connection can’t follow: read the motion and open fields instead. GET /v1/meta/info gives the version; errors answer {error, name}. Arming or disarming the alarm, switching relay and alarm-hub outputs (doors, gates), the Alarm Manager webhook, RTSPS stream links, deleting, and turning a microphone off for good always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST', 'PATCH'],
      path: '^/v1/arm-profiles(/|$)',
      reason: 'Arms, disarms or changes the alarm',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/v1/(relays|alarm-hubs)/[^/]+/outputs/',
      reason: 'Switches an output that may open a door or gate',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/v1/alarm-manager/webhook/',
      reason: 'Sets off the Alarm Manager’s alarms and what they trigger',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/v1/cameras/[^/]+/rtsps-stream/?$',
      reason: 'Makes a stream link anyone on your network can watch without signing in',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/v1/cameras/[^/]+/disable-mic-permanently/?$',
      reason: 'Turns a camera’s microphone off for good; only a factory reset brings it back',
    },
  ],
  docsUrl: 'https://developer.ui.com/protect',
  tokenUrl: null,
  handle: 'protect',
  access: {
    read: 'The agent can see cameras, snapshots and sensors, and change nothing.',
    manage:
      'The agent can also turn on lights, play sirens and move cameras. The alarm, doors and gates ask you first.',
  },
  discovery: {
    targets: [
      { port: 443, scheme: 'https' },
      { port: 11443, scheme: 'https' },
    ],
    probes: [
      { path: '/api/system', status: [200], bodyPattern: '"shortname"\\s*:\\s*"[^"]+"' },
      { path: '/proxy/protect/api', status: [401] },
    ],
  },
} satisfies CatalogEntryInput;
