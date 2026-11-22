import { argon2id } from '@noble/hashes/argon2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  api,
  BACKUP_FILE_TRANSFER,
  backupContentRange,
  backupDownloadUrl,
  backupUploadUrl,
  CreateBackupFileBody,
  ERROR_STATUS,
  parseBackupContentRange,
  REALTIME_EVENT_TOPICS,
  RealtimeEvent,
  RestoreBackupBody,
  StageBackupUploadBody,
} from '../contracts/index.js';
import * as root from '../index.js';
import * as backup from './index.js';
import {
  BACKUP_APP_ERROR_PREFIX,
  BACKUP_CATEGORY_IDS,
  BACKUP_COUNTED_TYPES,
  BACKUP_DEFAULT_CATEGORIES,
  BACKUP_FILE_ERROR_CODES,
  BACKUP_FILE_ERROR_STATUS,
  BACKUP_FILE_ERROR_TEXT,
  BACKUP_FORMAT,
  BACKUP_NOTE_CODES,
  BACKUP_RECORD_SCHEMAS,
  BACKUP_SCHEMA_VERSION,
  type BackupCategoryId,
  BackupEntryOrder,
  BackupFileDecoder,
  BackupFileEncoder,
  BackupFileError,
  type BackupFileManifest,
  BackupJsonlReader,
  type BackupKdf,
  backupAppErrorCode,
  backupCategoryMeta,
  backupDownloadLabel,
  backupEntryName,
  backupFileErrorOf,
  backupFileMadeText,
  backupFileName,
  backupFileNoticeText,
  backupIncludesSecrets,
  backupMadeText,
  backupMakingText,
  backupNoteText,
  backupRestoreChips,
  backupRestoredText,
  backupRestoreHint,
  backupRestoreSummaryLines,
  classifyBackupEntry,
  collectBackupIds,
  createBackupFileKeys,
  decodeBackupFileManifest,
  encodeBackupLine,
  formatBackupSize,
  isBackupFileError,
  parseBackupDirectoryEntry,
  parseBackupFileManifest,
  parseBackupRecord,
  remapBackupIds,
  sortBackupCategories,
  TarReader,
  TarWriter,
} from './index.js';

const NBSP = ' ';
const at = '2026-10-11T09:30:00.000Z';
const sha = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));
const smallKdf: BackupKdf = (pw, salt, p) =>
  argon2id(pw, salt, { m: p.memoryKiB, t: p.passes, p: p.parallelism, dkLen: 32 });

/** One record of every type, as a server would write them. */
export const RECORDS: Record<BackupCategoryId, Record<string, unknown>[]> = {
  agents: [
    {
      type: 'agent',
      id: 'prn_dusty',
      handle: 'dusty',
      name: 'Dusty',
      runtime: {
        provider: 'claude',
        model: 'claude-opus-5-5',
        effort: 'high',
      },
      grants: [
        { keyId: 'pr.open', tier: 'can' },
        { keyId: 'merge', tier: 'ask', scope: { repos: ['acme/web'] } },
      ],
      createdAt: at,
    },
    {
      type: 'schedule',
      id: 'sch_daily',
      agent: 'prn_dusty',
      conversation: 'cnv_dm',
      prompt: 'Check the nightly build.',
      when: { kind: 'cron', expr: '0 9 * * *', zone: 'Europe/Amsterdam' },
      status: 'active',
      createdAt: at,
    },
    {
      type: 'briefing',
      agent: 'prn_dusty',
      cron: '0 8 * * 1-5',
      timeZone: 'Europe/Amsterdam',
      enabled: true,
    },
  ],
  memories: [
    { type: 'hermes_home', home: 'person', archive: { sha256: sha('home-mara'), size: 18_204, files: 4 } },
    { type: 'hermes_home', home: 'outside', archive: { sha256: sha('home-outside'), size: 512, files: 1 } },
    { type: 'agent_notes', text: 'Backups run at 02:00.', updatedAt: at },
  ],
  automations: [
    {
      type: 'automation',
      id: 'aut_triage',
      principal: 'prn_aut_triage',
      name: 'Triage new issues',
      status: 'published',
      version: 3,
      definition: { triggers: [{ kind: 'github', repo: 'acme/web' }], steps: [{ kind: 'dispatch_agent' }] },
      draft: null,
      createdBy: 'prn_mara',
      publishedBy: 'prn_mara',
      grants: [{ keyId: 'pr.comment', tier: 'can' }],
      webhook: false,
      summary: 'When a new issue is opened on acme/web, Dusty assesses it.',
      tags: ['assess', 'comment'],
      createdAt: at,
      updatedAt: at,
    },
    { type: 'destination', url: 'https://hooks.example/whombat', approvedBy: 'prn_mara', approvedAt: at },
  ],
  connections: [
    {
      type: 'connection',
      id: 'con_ha',
      catalogId: 'homeassistant',
      connectedBy: 'prn_mara',
      label: 'Home Assistant',
      handle: 'home',
      transport: 'mcp',
      signIn: 'token',
      baseUrl: 'https://ha.local:8123',
      fields: { url: 'https://ha.local:8123' },
      auth: { type: 'bearer' },
      tools: [{ name: 'HassTurnOn', tier: 'can', hash: 'h1' }],
      credential: { secret: 'eyJhbGciOi.token' },
      createdAt: at,
    },
    {
      type: 'connector_account',
      id: 'con_google',
      provider: 'google',
      externalId: '1234567890',
      email: 'mara@lumio.example',
      services: ['gmail', 'calendar'],
      refreshToken: '1//refresh',
      grantedAt: at,
    },
    {
      type: 'connector_app',
      provider: 'google',
      clientId: 'abc.apps.googleusercontent.com',
      clientSecret: 's3cret',
    },
    {
      type: 'feedback_source',
      id: 'fbi_site',
      intake: 'enabled',
      assessment: 'active',
      conversation: 'cnv_feedback',
      settings: { handoff: 'on' },
      token: 'tracker-token',
    },
    { type: 'github', login: 'mara-c', connectedBy: 'mara@lumio.example', token: 'gho_abc' },
  ],
  skills: [
    { type: 'hermes_skills', skills: 23, archive: { sha256: sha('skills'), size: 96_000, files: 61 } },
  ],
  settings: [
    {
      type: 'settings',
      name: 'Lumio BV',
      slug: 'lumio-bv',
      timeZone: 'Europe/Amsterdam',
      aiGateway: { connection: 'con_fusebox', claude: true, codex: false },
      backupDefaults: ['agents', 'connections'],
      homeNetworks: [{ cidr: '10.100.0.0/16', ports: [22, 443] }],
    },
    { type: 'repo', id: 'rep_web', fullName: 'acme/web', source: 'github', enabled: true },
  ],
  vault: [
    {
      type: 'vault_entry',
      id: 'vlt_api',
      kind: 'http',
      name: 'Hetzner API',
      url: 'https://api.hetzner.cloud',
      auth: { type: 'bearer' },
      secret: 'hcloud-token',
      key: { envName: 'HETZNER_API' },
      createdAt: at,
    },
    {
      type: 'vault_entry',
      id: 'vlt_ssh',
      kind: 'ssh',
      name: 'Servers',
      secret: '-----BEGIN OPENSSH PRIVATE KEY-----\n…',
      key: { servers: ['vss_web'] },
      sshServers: [
        {
          id: 'vss_web',
          name: 'web1',
          host: '10.100.0.5',
          port: 22,
          username: 'deploy',
          hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc' },
        },
      ],
      createdAt: at,
    },
  ],
  messages: [
    {
      type: 'conversation',
      id: 'cnv_dm',
      kind: 'dm',
      slug: 'chat',
      title: 'Chat',
      dm: { person: 'prn_mara' },
      createdAt: at,
    },
    {
      type: 'message',
      id: 'msg_1',
      conversation: 'cnv_dm',
      author: 'prn_mara',
      authorName: 'Mara Oost',
      createdAt: at,
      text: 'Hello @dusty',
      mentions: ['prn_dusty'],
      attachments: [
        {
          id: 'att_1',
          name: 'plan.pdf',
          contentType: 'application/pdf',
          kind: 'document',
          size: 4,
          sha256: sha('blob'),
          folder: 'Plans',
        },
      ],
      reactions: [{ value: '👍', by: ['prn_dusty'] }],
      pinned: { at, by: 'prn_mara' },
    },
    {
      type: 'canvas',
      id: 'cvs_plan',
      slug: 'plan',
      title: 'Plan',
      conversation: 'cnv_dm',
      ydoc: { sha256: sha('ydoc'), size: 4 },
      provenance: { createdById: 'prn_mara', requestedById: null, editorIds: [] },
      createdAt: at,
      updatedAt: at,
    },
  ],
  servers: [
    {
      type: 'servers_hub',
      caSha256: 'a'.repeat(64),
      agentUrl: 'wss://10.100.1.160:8443',
      address: '10.100.1.160',
      madeAt: at,
      servers: [{ id: 'pve-01', name: 'pve-01', address: '10.100.1.20' }],
      backup: { size: 4096, sha256: 'b'.repeat(64) },
    },
    { type: 'server_ask', server: 'pve-01', asksFirst: 'never', changedBy: 'prn_mara', changedAt: at },
  ],
  files: [
    {
      type: 'file',
      id: 'att_1',
      conversation: 'cnv_dm',
      message: 'msg_1',
      name: 'plan.pdf',
      contentType: 'application/pdf',
      kind: 'document',
      size: 4,
      sha256: sha('blob'),
      folder: 'Plans',
      uploadedBy: 'prn_mara',
      addedAt: at,
    },
  ],
  repositories: [
    {
      type: 'repository',
      id: 'rep_site',
      name: 'site',
      fullName: 'local/site',
      bundle: { sha256: sha('bundle'), size: 6 },
      refs: 3,
    },
  ],
};

const DIRECTORY = [
  { type: 'burrow', id: 'bur_lumio', name: 'Lumio BV', slug: 'lumio-bv', timeZone: 'Europe/Amsterdam' },
  {
    type: 'person',
    id: 'prn_mara',
    accountId: 'acc_mara',
    email: 'mara@lumio.example',
    name: 'Mara Oost',
    handle: 'mara',
  },
  { type: 'agent', id: 'prn_dusty', handle: 'dusty', name: 'Dusty' },
  { type: 'system', id: 'prn_github', system: 'github', name: 'GitHub', handle: 'github' },
  { type: 'automation', id: 'aut_triage', principalId: 'prn_aut_triage', name: 'Triage new issues' },
  { type: 'conversation', id: 'cnv_pr12', kind: 'branch', slug: 'feat-pdf', title: 'feat/pdf' },
  { type: 'conversation', id: 'cnv_dm', kind: 'dm', slug: 'chat', title: 'Chat', dm: { person: 'prn_mara' } },
  {
    type: 'connection',
    id: 'con_ha',
    source: 'catalog',
    service: 'homeassistant',
    handle: 'home',
    label: 'Home Assistant',
    address: 'https://ha.local:8123',
  },
  { type: 'repo', id: 'rep_web', fullName: 'acme/web', source: 'github' },
  { type: 'vault_entry', id: 'vlt_api', kind: 'http', name: 'Hetzner API' },
  { type: 'vault_ssh_server', id: 'vss_web', entry: 'vlt_ssh', name: 'web1' },
  { type: 'canvas', id: 'cvs_plan', slug: 'plan', title: 'Plan' },
];

const MANIFEST: BackupFileManifest = {
  format: BACKUP_FORMAT,
  schemaVersion: BACKUP_SCHEMA_VERSION,
  createdAt: at,
  timeZone: 'Europe/Amsterdam',
  whombatVersion: '0.83.1',
  source: { burrowId: 'bur_lumio', name: 'Lumio BV', slug: 'lumio-bv' },
  madeBy: { name: 'Mara Oost', email: 'mara@lumio.example' },
  categories: BACKUP_CATEGORY_IDS.map((id) => ({ id, count: RECORDS[id].length, bytes: 100 })),
  includesSecrets: true,
  notes: [],
};

describe('backup categories and the download panel (CT-335)', () => {
  it('has ten stable ids, seven on by default, and the panel’s labels', () => {
    expect(BACKUP_CATEGORY_IDS).toEqual([
      'agents',
      'memories',
      'automations',
      'connections',
      'skills',
      'settings',
      'vault',
      'messages',
      'servers',
      'files',
      'repositories',
    ]);
    expect(BACKUP_DEFAULT_CATEGORIES).toEqual(BACKUP_CATEGORY_IDS.slice(0, 9));
    expect(backup.BACKUP_CATEGORY_LABELS.settings).toBe('Settings');
    expect(backup.BACKUP_CATEGORY_LABELS.vault).toBe('Your Vault');
    expect(sortBackupCategories(['vault', 'agents', 'vault'])).toEqual(['agents', 'vault']);
    expect(backupIncludesSecrets(['agents', 'memories'])).toBe(false);
    expect(backupIncludesSecrets(['vault'])).toBe(true);
  });

  it('says the mock’s meta lines', () => {
    expect(backupCategoryMeta({ id: 'memories', count: 3, bytes: 0 })).toMatch(/remembers about you.*notes$/);
    expect(backupCategoryMeta({ id: 'automations', count: 9, bytes: 0 })).toBe(
      '9 automations · come back switched off',
    );
    expect(backupCategoryMeta({ id: 'connections', count: 14, bytes: 0 })).toBe(
      '14 connections, with their sign-ins',
    );
    expect(backupCategoryMeta({ id: 'skills', count: 23, bytes: 0 })).toMatch(/^23 skills/);
    expect(backupCategoryMeta({ id: 'settings', count: 3, bytes: 0 })).toMatch(/settings/);
    expect(backupCategoryMeta({ id: 'vault', count: 8, bytes: 0 })).toBe('Your 8 entries');
    expect(backupCategoryMeta({ id: 'messages', count: 18_402, bytes: 0 })).toBe(
      '18,402 messages in chats and threads',
    );
    expect(backupCategoryMeta({ id: 'files', count: 312, bytes: 0 })).toMatch(/^312 files .*saved$/);
  });

  it('handles one and none', () => {
    // One agent: its line counts nothing.
    expect(backupCategoryMeta({ id: 'agents', count: 1, bytes: 0 })).toMatch(/model and keys$/);
    expect(backupCategoryMeta({ id: 'agents', count: 1, bytes: 0 })).not.toMatch(/\d|role/);
    expect(backupCategoryMeta({ id: 'automations', count: 1, bytes: 0 })).toBe(
      '1 automation · comes back switched off',
    );
    expect(backupCategoryMeta({ id: 'vault', count: 1, bytes: 0 })).toBe('Your 1 entry');
    expect(backupCategoryMeta({ id: 'vault', count: 0, bytes: 0 })).not.toMatch(/people|private/);
    expect(backupCategoryMeta({ id: 'repositories', count: 2, bytes: 0 })).toBe(
      '2 repositories, with all their history',
    );
    expect(backupCategoryMeta({ id: 'messages', count: 0, bytes: 0 })).toBe('No messages yet');
  });

  it('formats sizes as the mock does', () => {
    expect(formatBackupSize(12_000)).toBe(`12${NBSP}KB`);
    expect(formatBackupSize(640_200)).toBe(`640${NBSP}KB`);
    expect(formatBackupSize(1_100_000)).toBe(`1.1${NBSP}MB`);
    expect(formatBackupSize(120_400_000)).toBe(`120${NBSP}MB`);
    expect(formatBackupSize(1_400_000_000)).toBe(`1.4${NBSP}GB`);
    expect(formatBackupSize(300)).toBe(`1${NBSP}KB`);
    expect(formatBackupSize(0)).toBe(`0${NBSP}KB`);
    expect(backupDownloadLabel(1_800_000)).toBe(`Download · 1.8${NBSP}MB`);
  });
});

describe('backup records (CT-335)', () => {
  it('parses one record of every type, and the directory', () => {
    for (const id of BACKUP_CATEGORY_IDS)
      for (const value of RECORDS[id]) {
        const r = parseBackupRecord(id, value);
        expect(r.ok, `${id} ${(value as { type: string }).type} ${r.ok ? '' : r.problem}`).toBe(true);
      }
    for (const value of DIRECTORY)
      expect(parseBackupDirectoryEntry(value).ok, JSON.stringify(value)).toBe(true);
  });

  it('fills defaults, strips unknown members, and skips a bad record without throwing', () => {
    const r = parseBackupRecord('agents', { ...RECORDS.agents[0], extra: 1 });
    if (!r.ok) throw new Error(r.problem);
    expect(r.record).not.toHaveProperty('extra');
    if (r.record.type !== 'agent') throw new Error('agent');
    expect(r.record.runtime.fast).toBeNull();
    expect(r.record.face).toBe('dusty');
    expect(parseBackupRecord('agents', { ...RECORDS.agents[0], face: 'pip' }).ok).toBe(false);
    expect(parseBackupRecord('agents', { type: 'agent', id: 'prn_x' }).ok).toBe(false);
    expect(parseBackupRecord('vault', RECORDS.agents[0]).ok).toBe(false);
    expect(parseBackupRecord('memories', null).ok).toBe(false);
  });

  it('carries the outsiders’ mark as a member an older release drops, and reads older messages as unmarked', () => {
    const message = RECORDS.messages.find((r) => (r as { type: string }).type === 'message') as object;
    // A message of a release before the mark: none.
    const older = parseBackupRecord('messages', message);
    if (!older.ok || older.record.type !== 'message') throw new Error('message');
    expect(older.record.outsidersRun).toBe(false);
    // This release keeps it.
    const marked = parseBackupRecord('messages', { ...message, outsidersRun: true });
    if (!marked.ok || marked.record.type !== 'message') throw new Error('message');
    expect(marked.record.outsidersRun).toBe(true);
    // A release before the mark reads the record without the member (records drop what they don't know), and its
    // provenance is one of the two kinds that release has.
    const before = backup.BackupMessageRecord.omit({ outsidersRun: true }).safeParse({
      ...message,
      outsidersRun: true,
    });
    expect(before.success).toBe(true);
    expect(before.data).not.toHaveProperty('outsidersRun');
    expect(root.MessageProvenance.options).toEqual(['feedback_assessment', 'feedback_handoff']);
  });

  it('every counted type exists in its category', () => {
    for (const id of BACKUP_CATEGORY_IDS) {
      const types = new Set(
        (
          BACKUP_RECORD_SCHEMAS[id] as unknown as { options: { shape: { type: { value: string } } }[] }
        ).options.map((o) => o.shape.type.value),
      );
      for (const t of BACKUP_COUNTED_TYPES[id]) expect(types.has(t), `${id}.${t}`).toBe(true);
    }
  });

  it('never holds box-bound fields: no signing keys, sealed blobs or device ids', () => {
    const text = JSON.stringify(
      Object.values(BACKUP_RECORD_SCHEMAS).map((s) =>
        z.toJSONSchema(s, { unrepresentable: 'any', io: 'input' }),
      ),
    );
    expect(text).toContain('refreshToken');
    for (const word of [
      'secretKey',
      'sealed',
      'Enc"',
      'deviceId',
      'sessionId',
      'tokenHash',
      'endpointId',
      'authzGeneration',
    ])
      expect(text.includes(word), word).toBe(false);
  });

  it('remaps whole ids in stored JSON and reports the ones it can’t', () => {
    const definition = {
      triggers: [{ kind: 'message_posted', conversationId: 'cnv_general', text: 'about cnv_general' }],
      steps: [{ agent: 'prn_dusty', connection: 'con_gone' }],
    };
    expect([...collectBackupIds(definition)].sort()).toEqual(['cnv_general', 'con_gone', 'prn_dusty']);
    const { value, missing } = remapBackupIds(
      definition,
      new Map([
        ['cnv_general', 'cnv_X'],
        ['prn_dusty', 'prn_Y'],
      ]),
    );
    expect(value).toEqual({
      triggers: [{ kind: 'message_posted', conversationId: 'cnv_X', text: 'about cnv_general' }],
      steps: [{ agent: 'prn_Y', connection: 'con_gone' }],
    });
    expect(missing).toEqual(['con_gone']);
  });

  it('refuses a record line above 4 MiB', () => {
    expect(() => encodeBackupLine({ text: 'x'.repeat(4 * 1024 * 1024) })).toThrow(BackupFileError);
  });
});

describe('backup manifest and body (CT-335)', () => {
  it('checks the format and schema version before anything else', () => {
    expect(parseBackupFileManifest(MANIFEST).source.name).toBe('Lumio BV');
    const code = (v: unknown) => {
      try {
        parseBackupFileManifest(v);
        return 'ok';
      } catch (e) {
        return (e as BackupFileError).code;
      }
    };
    expect(code({ ...MANIFEST, format: 'whombat.backup-file/2' })).toBe('newer_format');
    expect(code({ ...MANIFEST, schemaVersion: BACKUP_SCHEMA_VERSION + 1 })).toBe('newer_format');
    expect(code({ ...MANIFEST, format: 'something/1' })).toBe('damaged');
    expect(code({ ...MANIFEST, categories: [] })).toBe('damaged');
    expect(code('nope')).toBe('damaged');
    expect(() => decodeBackupFileManifest(utf8ToBytes('{'))).toThrow(BackupFileError);
  });

  it('names the file, the entries and the made line', () => {
    expect(backupFileName('lumio-bv', at, 'Europe/Amsterdam')).toBe('lumio-bv-2026-10-11.wbk');
    expect(backupFileName('Lumio BV!', '2026-10-11T23:30:00Z', 'Europe/Amsterdam')).toBe(
      'lumio-bv-2026-10-12.wbk',
    );
    expect(backupMadeText(MANIFEST)).toBe('Made 11 Oct 2026 on Lumio BV · Whombat 0.83');
    expect(classifyBackupEntry('agents.jsonl')).toEqual({ kind: 'records', category: 'agents' });
    expect(classifyBackupEntry(backupEntryName.blob(sha('x')))).toEqual({ kind: 'blob', sha256: sha('x') });
    expect(classifyBackupEntry('canvases/cvs_plan.yjs')).toEqual({ kind: 'canvas', canvasId: 'cvs_plan' });
    expect(classifyBackupEntry('repositories/site.bundle')).toEqual({ kind: 'repository', name: 'site' });
    expect(classifyBackupEntry('repositories/../x.bundle')).toBeNull();
    expect(classifyBackupEntry('audit.jsonl')).toBeNull();
    expect(classifyBackupEntry('files/ABC')).toBeNull();
  });

  it('holds entries to their order', () => {
    const order = new BackupEntryOrder();
    for (const name of [
      'manifest.json',
      'directory.jsonl',
      'agents.jsonl',
      'vault.jsonl',
      `files/${sha('a')}`,
    ])
      order.next(name);
    expect(order.pastRecords).toBe(true);
    const bad = (names: string[]) => () => {
      const o = new BackupEntryOrder();
      for (const n of names) o.next(n);
    };
    expect(bad(['directory.jsonl'])).toThrow(BackupFileError);
    expect(bad(['manifest.json', 'directory.jsonl', 'vault.jsonl', 'agents.jsonl'])).toThrow(BackupFileError);
    expect(bad(['manifest.json', 'directory.jsonl', `files/${sha('a')}`, 'agents.jsonl'])).toThrow(
      BackupFileError,
    );
    expect(bad(['manifest.json', 'manifest.json'])).toThrow(BackupFileError);
  });

  it('splits jsonl in any pieces, and refuses broken lines', () => {
    const text = utf8ToBytes('{"a":"é"}\n\n{"b":2}\n{"c":3}');
    for (const piece of [1, 2, 5, 100]) {
      const r = new BackupJsonlReader();
      const out: unknown[] = [];
      for (let i = 0; i < text.length; i += piece) out.push(...r.push(text.subarray(i, i + piece)));
      out.push(...r.finish());
      expect(out).toEqual([{ a: 'é' }, { b: 2 }, { c: 3 }]);
    }
    expect(() => new BackupJsonlReader().push(utf8ToBytes('{nope}\n'))).toThrow(BackupFileError);
    expect(() => new BackupJsonlReader().push(new Uint8Array([0xc3, 0x0a]))).toThrow(BackupFileError);
  });

  it('round-trips a whole file: tar body, encrypted, read back entry by entry', async () => {
    const tar = new TarWriter();
    const mtime = Date.parse(at) / 1000;
    const body: Uint8Array[] = [
      tar.file(backupEntryName.manifest, encodeBackupLine(MANIFEST), mtime),
      tar.file(backupEntryName.directory, concatLines(DIRECTORY), mtime),
    ];
    for (const id of BACKUP_CATEGORY_IDS)
      body.push(tar.file(backupEntryName.records(id), concatLines(RECORDS[id]), mtime));
    body.push(tar.file(backupEntryName.blob(sha('blob')), utf8ToBytes('blob'), mtime));
    body.push(tar.file(backupEntryName.canvas('cvs_plan'), utf8ToBytes('ydoc'), mtime));
    body.push(tar.file(backupEntryName.repository('site'), utf8ToBytes('bundle'), mtime));
    body.push(tar.finish());

    const keys = await createBackupFileKeys('a long enough password', {
      params: { memoryKiB: 64, passes: 1, parallelism: 1 },
      kdf: smallKdf,
    });
    const enc = new BackupFileEncoder(keys);
    const file: Uint8Array[] = [];
    for (const piece of body) file.push(...enc.push(piece));
    file.push(...enc.finish());

    const dec = new BackupFileDecoder(keys);
    const reader = new TarReader();
    const order = new BackupEntryOrder();
    const seen: Record<string, unknown[]> = {};
    let jsonl: BackupJsonlReader | null = null;
    let current = '';
    const blobs: Record<string, string> = {};
    const onPlain = (plain: Uint8Array) => {
      for (const ev of reader.push(plain)) {
        if (ev.type === 'entry') {
          current = ev.entry.name;
          const kind = order.next(current);
          jsonl =
            kind.kind === 'records' || kind.kind === 'directory' || kind.kind === 'manifest'
              ? new BackupJsonlReader()
              : null;
          seen[current] = [];
          blobs[current] = '';
        } else if (ev.type === 'data') {
          if (jsonl) seen[current]?.push(...jsonl.push(ev.data));
          else blobs[current] += String.fromCharCode(...ev.data);
        } else if (jsonl) seen[current]?.push(...jsonl.finish());
      }
    };
    let first = true;
    for (let chunk of file) {
      if (first) {
        chunk = chunk.subarray(110);
        first = false;
      }
      for (const p of dec.push(chunk)) onPlain(p);
    }
    for (const p of dec.finish()) onPlain(p);
    reader.finish();

    expect(parseBackupFileManifest(seen['manifest.json']?.[0])).toEqual(MANIFEST);
    expect(seen['directory.jsonl']).toEqual(DIRECTORY);
    for (const id of BACKUP_CATEGORY_IDS) {
      const lines = seen[`${id}.jsonl`] ?? [];
      expect(lines).toHaveLength(RECORDS[id].length);
      for (const line of lines) expect(parseBackupRecord(id, line).ok).toBe(true);
    }
    expect(blobs[`files/${sha('blob')}`]).toBe('blob');
    expect(blobs['repositories/site.bundle']).toBe('bundle');
  });
});

function concatLines(values: unknown[]): Uint8Array {
  const parts = values.map(encodeBackupLine);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('restore preview and summary (CT-335)', () => {
  it('shows the mock’s chips and hints', () => {
    const chips = (p: Parameters<typeof backupRestoreChips>[0]) => backupRestoreChips(p).map((c) => c.label);
    expect(chips({ id: 'agents', count: 1, new: 0, here: 1, different: 0 })).toEqual(['1 already here']);
    expect(backupRestoreChips({ id: 'memories', count: 145, new: 130, here: 12, different: 3 })).toEqual([
      { label: '130 new', tone: 'neutral' },
      { label: '12 already here', tone: 'neutral' },
      { label: '3 different', tone: 'warn' },
    ]);
    expect(chips({ id: 'settings', count: 3, new: 1, here: 2, different: 0 })).toEqual([
      '1 new',
      '2 already here',
    ]);
    expect(chips({ id: 'files', count: 0, new: 0, here: 0, different: 0 })).toEqual([
      'Nothing to bring back',
    ]);
    expect(backupRestoreHint('automations')).toBe('They start switched off, so they don’t run twice.');
    expect(backupRestoreHint('connections')).toBe(
      'Checked after restoring. Any that need you show in Connections.',
    );
    expect(backupRestoreHint('agents')).toBeNull();
    expect(backup.BACKUP_ON_DIFFERENT_LABELS).toEqual({
      keep: 'Keep what’s here',
      replace: 'Use the backup',
    });
  });

  it('says every note in plain words', () => {
    for (const code of BACKUP_NOTE_CODES) {
      const one = backupNoteText({ code, count: 1 });
      const many = backupNoteText({ code, count: 3 });
      for (const t of [one, many]) {
        expect(t).toMatch(/^[A-Z0-9M].*\.$/);
        expect(t).not.toMatch(/'|"/);
      }
    }
    expect(backupNoteText({ code: 'drafts', count: 2 })).toBe(
      '2 automations no longer fit this Whombat, so they come back as drafts.',
    );
  });

  it('sums up a finished restore and signs it in one line', () => {
    const summary = {
      categories: [
        { id: 'automations' as const, added: 9, updated: 0, unchanged: 0, kept: 0, skipped: 0 },
        { id: 'agents' as const, added: 1, updated: 1, unchanged: 3, kept: 0, skipped: 0 },
        { id: 'connections' as const, added: 14, updated: 0, unchanged: 0, kept: 0, skipped: 0 },
        { id: 'vault' as const, added: 8, updated: 0, unchanged: 0, kept: 0, skipped: 0 },
      ],
      connectionsToSignIn: [
        { id: 'con_a', label: 'Fusebox' },
        { id: 'con_b', label: 'Google' },
      ],
      automationsOff: 9,
      notes: [{ code: 'schedules_paused' as const, count: 2 }],
      finishedAt: at,
    };
    expect(backupRestoreSummaryLines(summary)).toEqual([
      'Brought back 2 agents, 9 automations, 14 connections and 8 Vault entries.',
      '2 connections need you to sign in again. They’re in the Inbox.',
      '9 automations are switched off. Switch them on when you’re ready.',
      '2 schedules come back paused.',
    ]);
    expect(
      backupRestoredText({ categories: summary.categories.slice(0, 1) }, MANIFEST, '2026-10-12T10:00:00Z'),
    ).toBe('Restored 9 automations from a backup made on 11 Oct');
    expect(backupRestoredText(summary, MANIFEST, '2027-01-02T10:00:00Z')).toBe(
      'Restored 2 agents, 9 automations, 14 connections and more from a backup made on 11 Oct 2026',
    );
    expect(
      backupRestoreSummaryLines({
        categories: [{ id: 'agents', added: 0, updated: 0, unchanged: 5, kept: 0, skipped: 0 }],
        finishedAt: at,
      })[0],
    ).toBe('Everything in the file was already here.');
  });

  it('tells the person in one sentence, and only about sign-ins (3.0: no other owners, CT-1512)', () => {
    expect(backupFileNoticeText(['agents', 'connections'])).toMatch(/connection sign-ins/);
    expect(backupFileNoticeText(['vault'])).toMatch(/your Vault/);
    expect(backupFileNoticeText(['agents', 'memories'])).toBeNull();
    expect(backupFileMadeText(['agents'])).toBe('Made a backup file');
    expect(backupMakingText({ done: 42, total: 100, step: 'messages' })).toBe(
      'Making the file · Messages · 42 %',
    );
    expect(backup.BACKUP_COPY.download.passwordHint).toBe(
      'You need it to restore. Whombat can’t get it back for you.',
    );
  });
});

describe('backup errors (CT-335)', () => {
  it('has a sentence and a status for every code', () => {
    for (const code of BACKUP_FILE_ERROR_CODES) {
      expect(BACKUP_FILE_ERROR_TEXT[code]).toMatch(/\.$/);
      expect(ERROR_STATUS[BACKUP_FILE_ERROR_STATUS[code]]).toBeGreaterThanOrEqual(400);
    }
    expect(BACKUP_FILE_ERROR_TEXT.wrong_password).toBe('That password doesn’t open this file.');
    expect(BACKUP_FILE_ERROR_TEXT.damaged).toBe('This file is damaged or incomplete.');
    expect(BACKUP_FILE_ERROR_TEXT.newer_format).toBe(
      'This file was made by a newer Whombat. Update this one first.',
    );
    expect(backupAppErrorCode('damaged')).toBe(`${BACKUP_APP_ERROR_PREFIX}damaged`);
    expect(backupFileErrorOf({ code: 'backup_file.wrong_password' })).toBe('wrong_password');
    expect(backupFileErrorOf({ code: 'backup_file.nope' })).toBeNull();
    expect(isBackupFileError(new BackupFileError('damaged'))).toBe(true);
  });
});

describe('backups REST contract (CT-335)', () => {
  it('has every endpoint under the burrow, session-authenticated', () => {
    const eps = Object.values(api.backups);
    expect(eps.map((e) => e.id).sort()).toEqual(
      [
        'backups.create',
        'backups.defaults',
        'backups.estimate',
        'backups.get',
        'backups.getRestore',
        'backups.getUpload',
        'backups.inspect',
        'backups.list',
        'backups.remove',
        'backups.removeUpload',
        'backups.restore',
        'backups.setDefaults',
        'backups.stage',
      ].sort(),
    );
    for (const e of eps) {
      expect(e.path.startsWith('/burrows/:burrow/'), e.id).toBe(true);
      expect(e.auth).toBe('session');
    }
  });

  it('validates bodies: password length, categories, defaults', () => {
    expect(CreateBackupFileBody.safeParse({ categories: ['agents'], password: '123456789' }).success).toBe(
      false,
    );
    expect(CreateBackupFileBody.safeParse({ categories: [], password: '1234567890' }).success).toBe(false);
    expect(
      CreateBackupFileBody.safeParse({ categories: ['agents', 'agents'], password: '1234567890' }).success,
    ).toBe(false);
    expect(CreateBackupFileBody.safeParse({ categories: ['agents'], password: '1234567890' }).success).toBe(
      true,
    );
    expect(RestoreBackupBody.parse({ password: '1234567890', categories: ['vault'] }).onDifferent).toBe(
      'keep',
    );
    expect(StageBackupUploadBody.safeParse({ fileName: 'x.wbk', size: 11 * 1024 ** 3 }).success).toBe(false);
  });

  it('builds transfer paths and ranges', () => {
    expect(backupDownloadUrl('lumio-bv', 'bkf_1')).toBe('/api/v1/burrows/lumio-bv/backups/bkf_1/content');
    expect(backupUploadUrl('lumio-bv', 'bku_1')).toBe(
      '/api/v1/burrows/lumio-bv/backup-uploads/bku_1/content',
    );
    expect(BACKUP_FILE_TRANSFER.upload.method).toBe('PUT');
    expect(backupContentRange(0, 8, 20)).toBe('bytes 0-7/20');
    expect(parseBackupContentRange('bytes 0-7/20')).toEqual({ start: 0, end: 8, size: 20 });
    expect(parseBackupContentRange('bytes 7-3/20')).toBeNull();
    expect(parseBackupContentRange('bytes 0-20/20')).toBeNull();
  });

  it('tells the maker when a file or restore changes', () => {
    expect(REALTIME_EVENT_TOPICS['backups.changed']).toEqual(['me']);
    expect(RealtimeEvent.safeParse({ type: 'backups.changed', kind: 'file', id: 'bkf_1' }).success).toBe(
      true,
    );
  });

  it('is re-exported from the package root', () => {
    const exported = new Map(Object.entries(root));
    for (const [name, value] of Object.entries(backup)) expect(exported.get(name), name).toBe(value);
  });
});
