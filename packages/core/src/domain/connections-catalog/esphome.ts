import { type CatalogEntryInput, SOCKET_TOOL_NAME, urlField } from './shared.js';

export const entry = {
  id: 'esphome',
  name: 'ESPHome',
  category: 'home',
  description:
    'Your ESPHome devices: their configuration, logs and firmware, through ESPHome Device Builder.',
  tagline: 'Firmware for home sensors and switches',
  signIn: [
    { kind: 'none', label: 'No sign-in' },
    {
      kind: 'token',
      label: 'Username and password',
      // Not sent on the socket's handshake: the socket signs in with `auth/login` when ESPHome asks (CT-471).
      auth: { type: 'basic', usernameField: 'username' },
      secretLabel: 'Password',
      secretHelp:
        'Only when ESPHome asks you to sign in: the username and password it was started with (--username and --password, or ESPHOME_USERNAME and ESPHOME_PASSWORD).',
      steps: [
        { text: 'If ESPHome asks you to sign in when you open it, enter that username and password here.' },
        {
          text: 'They were set when ESPHome was started: --username and --password, or ESPHOME_USERNAME and ESPHOME_PASSWORD.',
        },
      ],
    },
  ],
  fields: [
    urlField(
      'http://192.168.1.10:6052',
      'Your ESPHome Device Builder’s address, usually port 6052 (ESPHome 2026.7 or later). The Home Assistant add-on opens port 6052 only with “Leave front door open” on, and then needs no password.',
    ),
    {
      id: 'username',
      methods: ['token'],
      label: 'Username',
      placeholder: 'admin',
      kind: 'text',
      required: true,
      help: 'The username ESPHome asks for.',
    },
  ],
  transport: 'socket',
  baseUrl: '{url}',
  mcpPath: null,
  mcpMissingHint: null,
  check: { kind: 'socket', method: 'config/version', version: 'esphome_version' },
  tools: [],
  request: null,
  socket: {
    dialect: 'esphome',
    path: '/ws',
    login: {
      method: 'auth/login',
      params: { username: '{username}', password: '{secret}' },
      when: 'asked',
    },
    reads: [
      'ping',
      'config/(version|get_info|serial_ports|get_preferences|get_secrets)',
      'devices/(list|get_states|list_archived|get_config|troubleshoot|decode_backtrace|logs|validate)',
      'yaml/search',
      'firmware/(get_jobs|get_job|get_binaries|follow_job)',
      'labels/list',
      'onboarding/get_state',
      'version_history/(list_versions|get_version|get_diff|list_deleted)',
      '(boards|components|remote_build)/get_[a-z_]+',
      'automations/(get_[a-z_]+|parse)',
      'editor/(migrate_config|validate_yaml)',
      'desktop/check_update',
    ],
    streams: ['devices/(logs|validate)', 'firmware/follow_job'],
    refused: [
      'auth(/.*)?',
      'subscribe_events',
      'firmware/(follow_jobs|download_token)',
      'devices/(subscribe_reachability|stop_stream|import_bundle_token)',
    ],
    missing: 'This ESPHome dashboard is too old: update ESPHome, then connect it.',
  },
  guide:
    'ESPHome Device Builder’s commands over its WebSocket; Whombat signs in when it asks. One command per call, args as an object: {"method": "devices/list", "params": {}}. A device is named by its YAML file ("configuration": "kitchen.yaml"). Reads: devices/list (configured and importable devices), devices/get_states (online or offline), devices/get_config {"configuration"} (its YAML), yaml/search {"query"}, config/get_secrets (secret names only), firmware/get_jobs, firmware/get_job {"job_id"}, labels/list, version_history/list_versions and version_history/get_diff {"configuration", "sha"}, config/version. Streams, read for the call’s seconds: devices/logs {"configuration"} (the device’s live log), devices/validate {"configuration"}, firmware/follow_job {"job_id"}. Changes: devices/update_config {"configuration", "content"} saves YAML; firmware/compile {"configuration"} builds; firmware/install {"configuration", "port": "OTA"} builds and flashes: it answers the compile job, so follow that, then the upload job firmware/get_jobs lists with its depends_on; devices/create, devices/clone, devices/archive, labels/create. Errors come back as an error_code (not_found, invalid_args, not_authenticated) with details. The devices’ own API stays with Home Assistant. Flashing, renaming or deleting a device, resetting the build files, setting a secret or the Wi-Fi password, restoring an older version and reading secrets.yaml always ask a person.',
  sensitive: [
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^firmware/(install|upload|install_bulk)$|bootloader',
      reason: 'Flashes firmware onto a device',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^devices/rename$',
      reason: 'Renames a device, which flashes it again',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^firmware/reset_build_env$',
      reason: 'Clears ESPHome’s build files and cancels every job',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^config/(set_secret|set_wifi_credentials)$',
      reason: 'Changes a secret or the Wi-Fi password your devices use',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^version_history/restore$',
      reason: 'Puts an older version of a device’s configuration back',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^devices/get_(encryption|api)_key$',
      reason: 'Reads a device’s encryption key',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'params',
      argValue: '(^|/)secrets\\.ya?ml$',
      onReads: true,
      reason: 'Reads or changes secrets.yaml, which holds your passwords and keys',
    },
    {
      tools: [SOCKET_TOOL_NAME],
      arg: 'method',
      argValue: '^desktop/update$',
      reason: 'Updates ESPHome',
    },
  ],
  docsUrl: 'https://github.com/esphome/device-builder/blob/main/docs/API.md',
  tokenUrl: null,
  handle: 'esphome',
  access: {
    read: 'The agent can see your devices, their configuration, states and logs, and change nothing.',
    manage:
      'The agent can also change configurations and build firmware. Flashing, renaming or deleting devices and secrets ask you first.',
  },
  discovery: {
    targets: [{ port: 6052, scheme: 'http' }],
    probes: [
      { path: '/version', status: [200], bodyPattern: '"version"\\s*:', version: { json: 'version' } },
    ],
  },
} satisfies CatalogEntryInput;
