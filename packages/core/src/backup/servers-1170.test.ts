/**
 * Contracts 0.117 (CT-900…CT-914; Whombat backup-file.md BF-13…BF-22): the `servers` category, the new records and
 * fields, schema version 3, the restore's servers part, and pointing servers here. Files made by 0.116 still parse.
 */
import { describe, expect, it } from 'vitest';
import {
  api,
  BackupDefaults,
  BackupEstimate,
  REALTIME_EVENT_TOPICS,
  RealtimeEvent,
  RestoreBackupBody,
  SetBackupDefaultsBody,
} from '../contracts/index.js';
import {
  HOME_REF_KINDS,
  HOST_REPOINT_MAX,
  HOST_REPOINT_WORDS,
  HostAddressChange,
  HostRepoint,
  HostRepointBody,
  hostsAddressChangeText,
  hostsAgentAddress,
} from '../domain/index.js';
import {
  BACKUP_CATEGORY_IDS,
  BACKUP_CATEGORY_LABELS,
  BACKUP_DEFAULT_CATEGORIES,
  BACKUP_FORMAT,
  BACKUP_NOTE_CODES,
  BACKUP_SCHEMA_VERSION,
  BACKUP_SECRET_CATEGORIES,
  BackupCategoryEstimate,
  BackupEntryOrder,
  BackupFileError,
  BackupRestorePreview,
  BackupRestoreSummary,
  backupCategoryMeta,
  backupEntryName,
  backupFileMadeText,
  backupFileNoticeText,
  backupNoteText,
  backupOfferedDefaults,
  backupRecordCount,
  backupRestoreSummaryLines,
  backupServersAddressText,
  backupServersStateText,
  classifyBackupEntry,
  parseBackupDirectoryEntry,
  parseBackupFileManifest,
  parseBackupRecord,
} from './index.js';

const at = '2026-10-21T09:30:00.000Z';
const sha = 'c'.repeat(64);

/** A 0.116 manifest: schema version 2, no notes. */
const OLD_MANIFEST = {
  format: BACKUP_FORMAT,
  schemaVersion: 2,
  createdAt: at,
  timeZone: 'Europe/Amsterdam',
  whombatVersion: '0.133.1',
  source: { burrowId: 'bur_lumio', name: 'Lumio BV', slug: 'lumio-bv' },
  madeBy: { name: 'Mara Oost', email: 'mara@lumio.example' },
  categories: [{ id: 'agents', count: 1, bytes: 10 }],
  includesSecrets: false,
};

function ok<T>(r: { ok: true; record: T } | { ok: false; problem: string }): T {
  if (!r.ok) throw new Error(r.problem);
  return r.record;
}

describe('the servers category (CT-900, CT-901)', () => {
  it('sits after messages, holds sign-ins, and is on by default where offered', () => {
    expect(BACKUP_CATEGORY_IDS).toHaveLength(11);
    expect(BACKUP_CATEGORY_IDS.indexOf('servers')).toBe(BACKUP_CATEGORY_IDS.indexOf('messages') + 1);
    expect(BACKUP_CATEGORY_LABELS.servers).toBe('Servers');
    expect(BACKUP_SECRET_CATEGORIES).toContain('servers');
    expect(BACKUP_DEFAULT_CATEGORIES).toContain('messages');
    expect(BACKUP_DEFAULT_CATEGORIES).toContain('servers');
    expect(BACKUP_DEFAULT_CATEGORIES).not.toContain('files');
    const offered = BACKUP_CATEGORY_IDS.filter((id) => id !== 'servers');
    expect(backupOfferedDefaults(BACKUP_DEFAULT_CATEGORIES, offered)).not.toContain('servers');
    expect(backupOfferedDefaults(['servers', 'agents'], BACKUP_CATEGORY_IDS)).toEqual(['agents', 'servers']);
  });

  it('says what a servers file holds, and who is told', () => {
    expect(backupCategoryMeta({ id: 'servers', count: 5, bytes: 0 })).toMatch(/^5 servers/);
    expect(backupCategoryMeta({ id: 'servers', count: 1, bytes: 0 })).toMatch(/^1 server,/);
    expect(backupCategoryMeta({ id: 'servers', count: 0, bytes: 0 })).toBe('No servers yet');
    expect(backupFileNoticeText(['servers'])).toContain('servers');
    expect(backupFileNoticeText(['connections', 'vault', 'servers'])).toMatch(/sign-ins, .* and /);
    expect(backupFileMadeText(['servers'])).toContain('sign-ins');
  });

  it('marks what a Whombat offers, older estimates offered', () => {
    expect(BackupCategoryEstimate.parse({ id: 'files', count: 1, bytes: 1 }).offered).toBe(true);
    expect(BackupCategoryEstimate.parse({ id: 'servers', count: 0, bytes: 0, offered: false }).offered).toBe(
      false,
    );
    const all = BACKUP_CATEGORY_IDS.map((id) => ({ id, count: 0, bytes: 0 }));
    expect(
      BackupEstimate.safeParse({ categories: all, freeBytes: null, maxBytes: 1, generatedAt: at }).success,
    ).toBe(true);
    expect(SetBackupDefaultsBody.safeParse({ categories: [...BACKUP_CATEGORY_IDS] }).success).toBe(true);
    expect(
      BackupDefaults.safeParse({ categories: [...BACKUP_CATEGORY_IDS], custom: true, updatedAt: at }).success,
    ).toBe(true);
    const settings = ok(
      parseBackupRecord('settings', {
        type: 'settings',
        name: 'Lumio BV',
        slug: 'lumio-bv',
        timeZone: 'Europe/Amsterdam',
        backupDefaults: [...BACKUP_CATEGORY_IDS],
      }),
    );
    expect(settings.type === 'settings' && settings.backupDefaults).toHaveLength(11);
  });
});

describe('schema version 3 and older files (CT-902)', () => {
  it('reads 0.116 files and refuses newer ones', () => {
    expect(BACKUP_SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
    expect(parseBackupFileManifest(OLD_MANIFEST).notes).toEqual([]);
    expect(
      parseBackupFileManifest({
        ...OLD_MANIFEST,
        schemaVersion: 3,
        notes: [{ code: 'files_left_out', count: 4 }],
      }).notes[0],
    ).toEqual({ code: 'files_left_out', category: null, count: 4 });
    let code = '';
    try {
      parseBackupFileManifest({ ...OLD_MANIFEST, schemaVersion: BACKUP_SCHEMA_VERSION + 1 });
    } catch (e) {
      code = e instanceof BackupFileError ? e.code : 'other';
    }
    expect(code).toBe('newer_format');
  });

  it('fills the new fields of 0.116 records', () => {
    const connection = ok(
      parseBackupRecord('connections', {
        type: 'connection',
        id: 'con_ha',
        catalogId: 'homeassistant',
        label: 'Home Assistant',
        handle: 'home',
        transport: 'mcp',
        signIn: 'token',
        baseUrl: 'https://ha.local:8123',
        tools: [{ name: 'HassTurnOn', tier: 'can', hash: 'h1' }],
        createdAt: at,
      }),
    );
    if (connection.type !== 'connection') throw new Error('connection');
    expect(connection).toMatchObject({ runsOn: null, builtin: false, device: null, needsSignIn: false });
    expect(connection.tools[0]?.limits).toBeNull();

    const account = ok(
      parseBackupRecord('connections', {
        type: 'connector_account',
        id: 'con_g',
        provider: 'google',
        owner: 'mara@lumio.example',
        externalId: 'g-1',
        email: 'mara@lumio.example',
        refreshToken: 'rt',
        grantedAt: at,
      }),
    );
    expect(account).toMatchObject({ refreshToken: 'rt', needsSignIn: false });

    const agent = ok(
      parseBackupRecord('agents', {
        type: 'agent',
        id: 'prn_dusty',
        handle: 'dusty',
        name: 'Dusty',
        runtime: { provider: 'claude' },
        createdAt: at,
      }),
    );
    if (agent.type !== 'agent') throw new Error('agent');
    expect(agent.face).toBe('dusty');
    expect(agent.runtime.fast).toBeNull();

    const dir = parseBackupDirectoryEntry({
      type: 'conversation',
      id: 'cnv_dm',
      kind: 'dm',
      slug: 'dm-dusty-mara',
      title: 'Dusty',
      dm: { person: 'prn_mara' },
    });
    if (!dir.ok || dir.entry.type !== 'conversation') throw new Error('directory');
    expect(dir.entry).toMatchObject({
      taskKey: null,
      chatTitle: null,
      chatSubject: null,
      chatArchivedAt: null,
    });

    const message = ok(
      parseBackupRecord('messages', {
        type: 'message',
        id: 'msg_1',
        conversation: 'cnv_dm',
        author: 'prn_mara',
        authorName: 'Mara',
        createdAt: at,
        text: 'hi',
      }),
    );
    expect(message.type === 'message' && message.subject).toBeNull();

    const entry = ok(
      parseBackupRecord('vault', {
        type: 'vault_entry',
        id: 'vlt_x',
        kind: 'login',
        name: 'Bol.com',
        createdAt: at,
      }),
    );
    expect(entry.totp).toBeNull();
  });
});

describe('records of 0.117 (CT-903, CT-904)', () => {
  it('parses the new fields and records', () => {
    const device = ok(
      parseBackupRecord('connections', {
        type: 'connection',
        id: 'con_dev',
        catalogId: 'device',
        label: 'Heat pump',
        handle: 'heat-pump',
        transport: 'rest',
        signIn: 'none',
        baseUrl: '',
        tools: [
          { name: 'set_temp', tier: 'ask', hash: 'h', limits: { args: { '/value': { min: 16, max: 24 } } } },
        ],
        runsOn: { mode: 'chosen', serverId: 'pve-01' },
        builtin: true,
        device: {
          name: 'Heat pump',
          profile: { driver: 'modbus' },
          host: '10.100.1.40',
          port: 502,
          choices: { set: { tier: 'ask' } },
        },
        createdAt: at,
      }),
    );
    if (device.type !== 'connection') throw new Error('connection');
    expect(device.runsOn).toEqual({ mode: 'chosen', serverId: 'pve-01', guestId: null });
    expect(device.device?.unitId).toBeNull();
    expect(device.tools[0]?.limits?.args['/value']?.max).toBe(24);

    const signIn = ok(
      parseBackupRecord('connections', {
        type: 'connector_account',
        id: 'con_g',
        provider: 'google',
        owner: 'mara@lumio.example',
        externalId: 'g-1',
        email: 'mara@lumio.example',
        needsSignIn: true,
        grantedAt: at,
      }),
    );
    expect(signIn).toMatchObject({ refreshToken: null, needsSignIn: true });
    expect(
      ok(
        parseBackupRecord('connections', {
          type: 'connector_app',
          provider: 'google',
          clientId: 'c',
          needsSignIn: true,
        }),
      ),
    ).toMatchObject({ clientSecret: null });

    const types = (category: Parameters<typeof parseBackupRecord>[0], values: unknown[]) =>
      values.map((v) => ok(parseBackupRecord(category, v)).type);
    expect(
      types('agents', [
        {
          type: 'command_allowance',
          agent: 'prn_dusty',
          keyId: 'computer.run',
          command: 'git status',
          createdAt: at,
        },
      ]),
    ).toEqual(['command_allowance']);
    expect(
      types('settings', [
        {
          type: 'widget',
          id: 'wdg_1',
          owner: 'prn_mara',
          thing: 'server:pve-01',
          title: 'CPU',
          source: { kind: 'server_metric', serverId: 'pve-01', series: ['cpu_pct'] },
          series: [{ key: 'cpu', label: 'CPU', color: 'blue' }],
          createdAt: at,
        },
        {
          type: 'account_profile',
          preferences: { theme: 'dark', timeZone: null },
          photo: { sha256: sha, size: 10, contentType: 'image/png' },
        },
      ]),
    ).toEqual(['widget', 'account_profile']);
    expect(
      types('messages', [
        {
          type: 'conversation',
          id: 'cnv_task',
          kind: 'dm',
          slug: 'dm-task',
          title: 'Update pve-01',
          dm: { person: 'prn_mara' },
          taskKey: 'feedback',
          chatTitle: 'Feedback',
          chatSubject: { kind: 'server', id: 'pve-01', name: 'pve-01' },
          createdAt: at,
        },
        {
          type: 'chat_thread_runtime',
          root: 'msg_1',
          conversation: 'cnv_task',
          runtime: { provider: 'codex', fast: true },
          setAt: at,
        },
        {
          type: 'canvas_comment',
          id: 'cmt_1',
          canvas: 'cvs_plan',
          author: 'prn_mara',
          authorName: 'Mara',
          text: 'Yes',
          createdAt: at,
        },
      ]),
    ).toEqual(['conversation', 'chat_thread_runtime', 'canvas_comment']);
  });

  it('counts a hub by its servers', () => {
    const hub = ok(
      parseBackupRecord('servers', {
        type: 'servers_hub',
        caSha256: sha,
        agentUrl: 'wss://10.100.1.160:8443',
        address: '10.100.1.160',
        madeAt: at,
        servers: [
          { id: 'pve-01', name: 'pve-01', address: '10.100.1.20' },
          { id: 'blackbox', name: 'blackbox' },
        ],
        backup: { size: 1024 },
      }),
    );
    if (hub.type !== 'servers_hub') throw new Error('hub');
    expect(hub.backup.sha256).toBeNull();
    expect(hub.servers[1]?.address).toBeNull();
    expect(backupRecordCount('servers', hub)).toBe(2);
    const ask = ok(
      parseBackupRecord('servers', {
        type: 'server_ask',
        server: 'pve-01',
        asksFirst: 'never',
        changedAt: at,
      }),
    );
    expect(backupRecordCount('servers', ask)).toBe(0);
    expect(backupRecordCount('agents', { type: 'agent' })).toBe(1);
    expect(
      parseBackupRecord('servers', {
        type: 'server_ask',
        server: 'pve-01',
        asksFirst: 'sometimes',
        changedAt: at,
      }).ok,
    ).toBe(false);
  });

  it('keeps the hosts service’s backup after the record files', () => {
    expect(classifyBackupEntry(backupEntryName.hostsBackup)).toEqual({ kind: 'hosts_backup' });
    expect(classifyBackupEntry('servers.jsonl')).toEqual({ kind: 'records', category: 'servers' });
    const order = new BackupEntryOrder();
    for (const name of ['manifest.json', 'directory.jsonl', 'messages.jsonl', 'servers.jsonl', 'files.jsonl'])
      order.next(name);
    expect(order.next('servers/hub.tar.gz').kind).toBe('hosts_backup');
    expect(() => order.next('servers/hub.tar.gz')).toThrow(BackupFileError);
    const early = new BackupEntryOrder();
    expect(() => early.next('servers/hub.tar.gz')).toThrow(BackupFileError);
  });

  it('says the new notes', () => {
    for (const code of ['sign_in_left_out', 'files_left_out'] as const) {
      expect(BACKUP_NOTE_CODES).toContain(code);
      expect(backupNoteText({ code, count: 2 })).toMatch(/^2 /);
    }
    // One agent: its model note has no count.
    expect(BACKUP_NOTE_CODES).toContain('model_unavailable');
    expect(BACKUP_NOTE_CODES).not.toContain('retired_agents');
    expect(backupNoteText({ code: 'model_unavailable', count: 1 })).toMatch(/model/);
  });
});

describe('restoring servers (CT-906…CT-908)', () => {
  const base = {
    fileName: 'lumio-bv-2026-10-21.wbk',
    size: 10,
    manifest: OLD_MANIFEST,
    sameBurrow: true,
    categories: [],
  };

  it('previews their state and the address question', () => {
    expect(BackupRestorePreview.parse(base).servers).toBeNull();
    const p = BackupRestorePreview.parse({
      ...base,
      servers: { state: 'new', count: 5, address: { from: '10.100.1.160', to: '10.100.1.158' } },
    });
    expect(p.servers).toMatchObject({ state: 'new', blockedBy: null });
    expect(backupServersAddressText({ from: '10.100.1.160', to: '10.100.1.158' })).toMatch(
      /10\.100\.1\.160.*10\.100\.1\.158/,
    );
    const blocked = backupServersStateText({ state: 'blocked', count: 5, blockedBy: 3 });
    expect(blocked).toContain('3 servers');
    expect(blocked).toContain('5 in the file');
    expect(backupServersStateText({ state: 'unavailable', count: 1 })).toContain('the server in the file');
    expect(backupServersStateText({ state: 'new', count: 5 })).toBeNull();
  });

  it('takes the answer in the restore body', () => {
    const body = { password: 'correct horse battery', categories: ['servers'] };
    expect(RestoreBackupBody.parse(body).servers).toBeUndefined();
    expect(RestoreBackupBody.parse({ ...body, servers: { pointHere: false } }).servers).toEqual({
      pointHere: false,
    });
    expect(RestoreBackupBody.safeParse({ ...body, servers: { pointHere: true, x: 1 } }).success).toBe(false);
  });

  it('sums up what came back and what to point by hand', () => {
    const summary = BackupRestoreSummary.parse({
      categories: [{ id: 'servers', added: 5, updated: 0, unchanged: 0, kept: 0, skipped: 0 }],
      servers: {
        back: 5,
        pointed: 3,
        toPoint: [
          { id: 'pve-01', name: 'pve-01', address: '10.100.1.20' },
          { id: 'blackbox', name: 'blackbox' },
        ],
      },
      finishedAt: at,
    });
    expect(summary.servers?.toPoint[1]?.address).toBeNull();
    const lines = backupRestoreSummaryLines(summary);
    expect(lines[0]).toContain('5 servers');
    expect(lines.some((l) => l.includes('3 servers'))).toBe(true);
    expect(lines.some((l) => l.includes('pve-01 and blackbox'))).toBe(true);
    expect(BackupRestoreSummary.parse({ categories: [], finishedAt: at }).servers).toBeNull();
  });
});

describe('pointing servers here (CT-910…CT-914)', () => {
  it('reads an agent URL as people do', () => {
    expect(hostsAgentAddress('wss://10.100.1.160:8443')).toBe('10.100.1.160');
    expect(hostsAgentAddress('wss://Whombat.lan:9443/agent')).toBe('whombat.lan:9443');
    expect(hostsAgentAddress('wss://[fd00::5]:8443')).toBe('fd00::5');
    expect(hostsAgentAddress('wss://[fd00::5]:9443')).toBe('[fd00::5]:9443');
    expect(hostsAgentAddress('10.100.1.160')).toBeNull();
  });

  it('says the address change', () => {
    const text = hostsAddressChangeText({
      from: '10.100.1.160',
      to: '10.100.1.158',
      waiting: [{ name: 'a' }, { name: 'b' }],
    });
    expect(text).toContain('from 10.100.1.160 to 10.100.1.158');
    expect(text).toContain('2 servers');
    expect(hostsAddressChangeText({ from: 'a', to: 'b', waiting: [{ name: 'pve-01' }] })).toContain(
      'pve-01 hasn’t',
    );
    expect(HOME_REF_KINDS).toContain('address_change');
    expect(api.hosts.addressChange.response.parse(null)).toBeNull();
    expect(
      HostAddressChange.parse({
        from: 'a',
        to: 'b',
        changedAt: at,
        waiting: [{ id: 'pve-01', name: 'pve-01', address: null }],
      }).waiting,
    ).toHaveLength(1);
  });

  it('starts a repoint job and follows it', () => {
    expect(HostRepointBody.safeParse({ servers: ['pve-01'] }).success).toBe(true);
    expect(HostRepointBody.safeParse({ servers: [] }).success).toBe(false);
    expect(HostRepointBody.safeParse({ servers: ['a', 'a'] }).success).toBe(false);
    expect(
      HostRepointBody.safeParse({ servers: Array.from({ length: HOST_REPOINT_MAX + 1 }, (_, i) => `s${i}`) })
        .success,
    ).toBe(false);
    const job = HostRepoint.parse({
      id: 'rpt_1',
      to: '10.100.1.158',
      state: 'done',
      servers: [
        { id: 'pve-01', name: 'pve-01', address: '10.100.1.20', state: 'pointed', error: null },
        { id: 'blackbox', name: 'blackbox', address: null, state: 'no_key', error: null },
        {
          id: 'nas',
          name: 'nas',
          address: '10.100.1.30',
          state: 'failed',
          error: { code: 'sign_in_failed', message: 'x' },
        },
      ],
      startedAt: at,
      finishedAt: at,
    });
    expect(job.servers.map((s) => HOST_REPOINT_WORDS.states[s.state])).toEqual([
      'Pointed here',
      'Needs a password',
      'Didn’t work',
    ]);
    expect([api.hosts.repoint.method, api.hosts.repoint.path, api.hosts.repoint.status]).toEqual([
      'POST',
      '/burrows/:burrow/hosts/repoints',
      202,
    ]);
    expect(api.hosts.getRepoint.path).toBe('/burrows/:burrow/hosts/repoints/:repointId');
    expect(api.hosts.addressChange.path).toBe('/burrows/:burrow/hosts/address-change');
    expect(
      RealtimeEvent.parse({ type: 'hosts.repoint', repointId: 'rpt_1', state: 'running' }),
    ).toMatchObject({
      repointId: 'rpt_1',
    });
    expect(REALTIME_EVENT_TOPICS['hosts.repoint']).toEqual(['hosts']);
  });
});
