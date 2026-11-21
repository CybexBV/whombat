import { type CatalogEntryInput, DELETES_ASK, REQUEST_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'frigate',
  name: 'Frigate',
  category: 'home',
  description: 'Cameras, live snapshots, object detections, detectors and recordings in Frigate.',
  tagline: 'Local cameras and object detection',
  signIn: [
    {
      kind: 'none',
      label: 'No sign-in (local network, port 5000)',
    },
    {
      kind: 'token',
      label: 'Username and password (port 8971)',
      auth: {
        type: 'session',
        login: {
          method: 'POST',
          path: '/api/login',
          body: { user: '{username}', password: '{secret}' },
        },
        tokenCookie: 'frigate_token',
        ttlSeconds: 3600,
        apply: { type: 'cookie', name: 'frigate_token' },
        logout: { method: 'GET', path: '/api/logout' },
      },
      secretLabel: 'Password',
      secretHelp:
        'Your Frigate user password (for port 8971 with authentication). On the open local port (5000), choose No sign-in instead.',
      steps: [
        { text: 'If Frigate runs with authentication on port 8971, enter your username and password here.' },
        { text: 'If Frigate runs without sign-in on port 5000, choose No sign-in above.' },
      ],
    },
  ],
  fields: [
    urlField(
      'http://192.168.1.20:5000',
      'Your Frigate address: usually http on port 5000 (open on your network) or https on port 8971 (with sign-in).',
    ),
    {
      id: 'username',
      label: 'Username',
      placeholder: 'admin',
      help: 'Your Frigate username on port 8971 (usually admin).',
      kind: 'text',
      required: true,
      default: 'admin',
      methods: ['token'],
    },
  ],
  transport: 'rest',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: {
    kind: 'request',
    method: 'GET',
    path: '/api/version',
  },
  tools: [],
  request: {
    prefixes: ['/api/'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    readMethods: ['GET', 'HEAD'],
  },
  guide:
    'Frigate’s HTTP API under /api/. Reads: GET /api/version, GET /api/stats (cameras with camera_fps, detection_fps, skipped_fps; detectors with inference_speed in ms; service.version, service.uptime and service.storage in MB), GET /api/events (?camera=…&label=person|car&limit=20&after=<unix>), GET /api/events/summary (daily counts by camera and label), GET /api/<camera>/latest.jpg?h=360 (latest camera snapshot JPEG). Reading or saving Frigate’s configuration (which can hold RTSP camera passwords), restarting Frigate and deleting events always ask a person.',
  sensitive: [
    DELETES_ASK,
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['GET', 'POST', 'PUT'],
      path: '^/api/config(/|$)',
      reason: 'Reads or changes Frigate’s configuration, which may contain camera stream passwords',
    },
    {
      tools: [REQUEST_TOOL_NAME],
      methods: ['POST'],
      path: '^/api/restart/?$',
      reason: 'Restarts Frigate, pausing recording and detection briefly',
    },
  ],
  docsUrl: 'https://docs.frigate.video/integrations/api/',
  tokenUrl: null,
  handle: 'frigate',
  access: {
    read: 'The agent can see cameras, snapshots, detections, detectors and storage, and change nothing.',
    manage:
      'The agent can also trigger recordings or snapshots. Reading or saving configuration, deleting events and restarting Frigate ask you first.',
  },
  discovery: {
    targets: [
      { port: 5000, scheme: 'http' },
      { port: 8971, scheme: 'https' },
    ],
    probes: [
      { path: '/', status: [200], bodyPattern: '<title>[^<]*Frigate' },
      { path: '/api/stats', status: [200, 401], version: { json: 'service.version' } },
    ],
  },
} satisfies CatalogEntryInput;
