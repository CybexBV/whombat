/**
 * Tests only: Home Assistant's WebSocket API as its page reads it (connection-pages-server.md CP-S10): the sign-in, then
 * `get_config`, `system_health/info` (a subscription: `initial`, an `update`, `finish`), `config_entries/get`,
 * `repairs/list_issues`, `frontend/get_translations`, `system_log/list`, `backup/info`, `render_template` (a
 * subscription) and, on Home Assistant OS, `supervisor/api`. Plays John's Home Assistant Container by default: 2026.10.2,
 * 171 integrations with two not loading, MariaDB 10.11 at 2.8 GB. Plugs into `startStub`'s `websocket` option, or into
 * any `ws` server.
 */
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { StubSocket } from '../../connections/provision/testing-home';

export interface FakeHaState {
  token: string;
  version: string;
  installation: string;
  /** The account is an administrator (else `config_entries/get` and `system_log/list` are refused). */
  admin: boolean;
  recoveryMode: boolean;
  entries: Record<string, unknown>[];
  issues: Record<string, unknown>[];
  translations: Record<string, string>;
  log: Record<string, unknown>[];
  /** `backup/info`; null: the command doesn't exist (an older version). */
  backups: Record<string, unknown>[] | null;
  /** `render_template`'s answer: updates|unavailable|entities. */
  counts: string;
  recorder: Record<string, unknown>;
  /** Supervisor answers by endpoint (Home Assistant OS). */
  supervisor: Record<string, unknown> | null;
  /** The system health ends with `finish`; false plays John's, whose reachability checks never finish in time. */
  healthFinish: boolean;
  /** Every command type the client sent. */
  seen: string[];
}

/** 169 loaded integrations, Shelly retrying and Daikin failed. */
export function haEntries(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < 169; i++)
    out.push({
      entry_id: `e${i}`,
      domain: i % 2 ? 'knx' : 'mqtt',
      title: `Thing ${i}`,
      state: 'loaded',
      source: 'user',
      disabled_by: null,
    });
  out.push({
    entry_id: 'shelly1',
    domain: 'shelly',
    title: 'Living room plug',
    state: 'setup_retry',
    reason: 'Device unreachable',
    source: 'zeroconf',
    disabled_by: null,
  });
  out.push({
    entry_id: 'daikin1',
    domain: 'daikin',
    title: 'Heat pump',
    state: 'setup_error',
    source: 'user',
    disabled_by: null,
  });
  out.push({
    entry_id: 'off1',
    domain: 'hue',
    title: 'Old bridge',
    state: 'not_loaded',
    source: 'user',
    disabled_by: 'user',
  });
  out.push({
    entry_id: 'ign1',
    domain: 'cast',
    title: 'Ignored',
    state: 'not_loaded',
    source: 'ignore',
    disabled_by: null,
  });
  return out;
}

export function fakeHaState(over: Partial<FakeHaState> = {}): FakeHaState {
  const now = Date.now() / 1000;
  return {
    token: 'ha-token-Test1234',
    version: '2026.10.2',
    installation: 'Home Assistant Container',
    admin: true,
    recoveryMode: false,
    entries: haEntries(),
    issues: [
      {
        domain: 'homeassistant',
        issue_domain: 'knx',
        issue_id: 'yaml_deprecated',
        translation_key: 'deprecated_yaml',
        translation_placeholders: { integration: 'KNX' },
        severity: 'warning',
        ignored: false,
      },
      { domain: 'zha', issue_id: 'x', translation_key: 'gone', severity: 'error', ignored: true },
    ],
    translations: {
      'component.knx.issues.deprecated_yaml.title': 'The {integration} YAML configuration is being removed',
    },
    log: [
      {
        name: 'homeassistant.components.knx.climate',
        message: ['Could not read the room temperature'],
        level: 'ERROR',
        timestamp: now - 60,
        first_occurred: now - 600,
        count: 30,
      },
      {
        name: 'custom_components.solar.sensor',
        message: ['Timeout'],
        level: 'ERROR',
        timestamp: now - 120,
        first_occurred: now - 300,
        count: 8,
      },
      {
        name: 'homeassistant.components.mqtt',
        message: ['Slow'],
        level: 'WARNING',
        timestamp: now - 30,
        first_occurred: now - 30,
        count: 1,
      },
    ],
    backups: [
      {
        backup_id: 'b1',
        name: 'Settings copy before the kiosk update',
        date: new Date((now - 86_400) * 1000).toISOString(),
        agents: { 'backup.local': { protected: false, size: 1_800_000_000 } },
        with_automatic_settings: false,
      },
    ],
    counts: '2|12|6012',
    recorder: {
      database_engine: 'mysql',
      database_version: '10.11.6',
      estimated_db_size: '2670.41 MiB',
      current_recorder_run: new Date((now - 23 * 3600) * 1000).toISOString(),
    },
    supervisor: null,
    healthFinish: true,
    seen: [],
    ...over,
  };
}

/** Answers like Home Assistant on one socket. */
export function fakeHomeAssistant(state: FakeHaState) {
  return {
    open(socket: StubSocket) {
      socket.send({ type: 'auth_required', ha_version: state.version });
    },
    // biome-ignore lint/suspicious/noExplicitAny: messages are whatever the client sent.
    message(socket: StubSocket, m: any) {
      if (m.type === 'auth') {
        socket.send(
          m.access_token === state.token
            ? { type: 'auth_ok', ha_version: state.version }
            : { type: 'auth_invalid', message: 'Invalid access token or password' },
        );
        return;
      }
      state.seen.push(m.type);
      const result = (r: unknown) => socket.send({ id: m.id, type: 'result', success: true, result: r });
      const error = (code: string) =>
        socket.send({ id: m.id, type: 'result', success: false, error: { code, message: code } });
      const event = (e: unknown) => socket.send({ id: m.id, type: 'event', event: e });
      switch (m.type) {
        case 'get_config':
          return result({
            version: state.version,
            recovery_mode: state.recoveryMode,
            safe_mode: false,
            state: 'RUNNING',
          });
        case 'system_health/info':
          result(null);
          event({
            type: 'initial',
            data: {
              homeassistant: { info: { installation_type: state.installation, version: state.version } },
              recorder: { info: { ...state.recorder, estimated_db_size: { type: 'pending' } } },
              ...(state.supervisor ? { hassio: { info: { host_os: 'Home Assistant OS 16.2' } } } : {}),
            },
          });
          event({
            type: 'update',
            domain: 'recorder',
            key: 'estimated_db_size',
            success: true,
            data: state.recorder.estimated_db_size,
          });
          if (state.healthFinish) event({ type: 'finish' });
          return;
        case 'config_entries/get':
          return state.admin ? result(state.entries) : error('unauthorized');
        case 'repairs/list_issues':
          return result({ issues: state.issues });
        case 'frontend/get_translations':
          return result({ resources: state.translations });
        case 'system_log/list':
          return state.admin ? result(state.log) : error('unauthorized');
        case 'backup/info':
          return state.backups ? result({ backups: state.backups }) : error('unknown_command');
        case 'render_template':
          result(null);
          event({ result: state.counts, listeners: { all: true } });
          return;
        case 'supervisor/api': {
          const answer = state.supervisor?.[m.endpoint as string];
          return answer !== undefined ? result(answer) : error('unknown_error');
        }
        default:
          return error('unknown_command');
      }
    },
  };
}

/** Puts the fake on `/api/websocket` of an http server a test made itself; returns how to take it off. */
export function attachFakeHomeAssistant(server: Server, state: FakeHaState): () => void {
  const fake = fakeHomeAssistant(state);
  const wss = new WebSocketServer({ server, path: '/api/websocket' });
  wss.on('connection', (client) => {
    const socket: StubSocket = { send: (m) => client.send(JSON.stringify(m)), close: () => client.close() };
    client.on('message', (data) => fake.message(socket, JSON.parse(String(data))));
    fake.open(socket);
  });
  return () => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  };
}
