/**
 * Restoring a backup file onto another Whombat (docs/decisions/backup-file.md BF-19…BF-22, BF-S01…; one-agent.md
 * OA-S27): two Whombats with their own databases, master keys and hosts services, as when a box is moved or reset.
 * The Servers connection is the one the new box made (never added, never signed in again; its tiers follow keep or
 * replace), the file's agent is the new box's own agent (its name and keys with “Use the backup”, within the limits
 * Settings → Agent has), and a schedule finds its thread once the messages are back.
 */
import { randomBytes } from 'node:crypto';
import {
  agentDefaultGrants,
  api,
  type BackupCategoryId,
  type BackupRestorePreview,
  type BackupRestoreView,
  type BackupUploadView,
  buildPath,
  type DeviceProfileInput,
  KEY_CATALOG,
  newId,
} from '@whombat/core';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBurrow } from '../commands/burrows';
import { sendMessage } from '../commands/messages';
import { setToolLimits, setToolTier } from '../connections/commands';
import {
  accounts,
  agentSchedules,
  burrows,
  catalogConnections,
  chatThreadRuntimes,
  commandAllowances,
  connections,
  connectionTools,
  conversations,
  deviceSkills,
  events,
  grants,
  messages,
  principals,
  widgets,
} from '../db/schema/index';
import { decideDeviceSkill, proposeDeviceSkill } from '../devices/skills';
import { ensureServersConnection, SERVERS_CATALOG_ID } from '../hosts/provision';
import { FakeHostsService } from '../hosts/testing/fake';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { downloadBackup, uploadBackup } from '../test/backups';
import { upload } from '../test/files';
import { useTestServer } from '../test/harness';
import { addPersonalAgent } from '../test/personal';
import { sessionFor } from '../test/tokens';
import { backupsFor } from './service';

const hostsA = new FakeHostsService();
const hostsB = new FakeHostsService();
/** The Whombat the file is made on: the seeded burrow, its agent renamed Rex. */
const a = useTestServer({
  seed: true,
  app: true,
  env: {
    WHOMBAT_MASTER_KEY: randomBytes(32).toString('base64'),
    WHOMBAT_HOSTS_SOCKET: hostsA.socket,
    WHOMBAT_HOSTS_TOKEN_FILE: hostsA.tokenFile,
  },
});
/** A fresh Whombat: Mara's account, her new burrow and the agent made with it. */
const b = useTestServer({
  app: true,
  env: {
    WHOMBAT_MASTER_KEY: randomBytes(32).toString('base64'),
    WHOMBAT_HOSTS_SOCKET: hostsB.socket,
    WHOMBAT_HOSTS_TOKEN_FILE: hostsB.tokenFile,
  },
});

const PASSWORD = 'moving the whole box';
/** A heat pump on the home network: one reading, one action. */
const HEAT_PUMP: DeviceProfileInput = {
  name: 'Daikin Altherma heat pump',
  vendor: 'Daikin',
  model: 'Altherma',
  driver: 'modbus_tcp',
  readings: [
    {
      key: 'room',
      label: 'Room',
      unit: '°C',
      modbus: { table: 'input', address: 0, type: 's16', scale: 0.1 },
    },
  ],
  actions: [
    {
      key: 'room_setpoint',
      label: 'Room temperature',
      description: 'The temperature the room is heated to.',
      modbus: { table: 'holding', address: 100, type: 's16', scale: 0.1 },
      valueType: 'number',
      min: 12,
      max: 28,
      step: 0.5,
    },
  ],
};
const CATEGORIES: BackupCategoryId[] = ['settings', 'connections', 'agents', 'messages'];
const url = (path: string, params: Record<string, string>) => `/api/v1${buildPath(path, params)}`;

let fileBytes: Buffer = Buffer.alloc(0);
let rex = { agentId: '', dmId: '' };
let threadRoot = '';
let raisedKey = '';
let target = { burrowId: '', principalId: '', slug: '', cookie: '' };

type Server = typeof a;

async function call(s: Server, method: 'GET' | 'POST' | 'PUT', path: string, cookie: string, body?: unknown) {
  const res = await s.api.inject({
    method,
    url: path,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {} };
}

/** The Servers connection of a Whombat's home burrow, made by the server as at its start. */
async function serversConnection(s: Server): Promise<string> {
  for (let i = 0; ; i++) {
    const id = await ensureServersConnection(s.services).catch(() => null);
    if (id) return id;
    if (i > 100) throw new Error('no Servers connection');
    await new Promise((r) => setTimeout(r, 20));
  }
}

type Target = typeof target;

async function uploadToB(to: Target = target): Promise<BackupUploadView> {
  const staged = await call(b, 'POST', url(api.backups.stage.path, { burrow: to.slug }), to.cookie, {
    fileName: 'moved.wbk',
    size: fileBytes.length,
  });
  expect(staged.status, JSON.stringify(staged.body)).toBe(201);
  const { id } = staged.body.upload as BackupUploadView;
  await uploadBackup(b.services, to.slug, to.cookie, id, fileBytes);
  const got = await call(
    b,
    'GET',
    url(api.backups.getUpload.path, { burrow: to.slug, stagedBackupId: id }),
    to.cookie,
  );
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  return got.body.upload as BackupUploadView;
}

async function preview(uploadId: string): Promise<BackupRestorePreview> {
  const res = await call(
    b,
    'POST',
    url(api.backups.inspect.path, { burrow: target.slug, stagedBackupId: uploadId }),
    target.cookie,
    { password: PASSWORD },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as BackupRestorePreview;
}

async function restore(
  onDifferent: 'keep' | 'replace',
  to: Target = target,
  categories: BackupCategoryId[] = CATEGORIES,
): Promise<BackupRestoreView> {
  const upload = await uploadToB(to);
  const res = await call(
    b,
    'POST',
    url(api.backups.restore.path, { burrow: to.slug, stagedBackupId: upload.id }),
    to.cookie,
    { password: PASSWORD, categories, onDifferent },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await backupsFor(b.services).settle();
  const done = await call(
    b,
    'GET',
    url(api.backups.getRestore.path, {
      burrow: to.slug,
      restoreId: (res.body.restore as BackupRestoreView).id,
    }),
    to.cookie,
  );
  const view = done.body.restore as BackupRestoreView;
  expect(view, JSON.stringify(view)).toMatchObject({ status: 'done', error: null });
  return view;
}

/** The agent on the fresh Whombat. */
async function assistantOnB() {
  const [row] = await b.services.db
    .select()
    .from(principals)
    .where(
      and(
        eq(principals.burrowId, target.burrowId),
        and(
          eq(principals.kind, 'agent'),
          sql`${principals.burrowId} = (select p.burrow_id from principals p where p.id = ${target.principalId})`,
        ),
      ),
    );
  if (!row) throw new Error('no agent on B');
  return row;
}

beforeAll(async () => {
  await hostsA.start();
  await hostsB.start();
  const s = a.services;
  // The source: the agent, renamed Rex, a thread in Mara's Chat with a schedule in it, a Servers tier she changed.
  const made = await addPersonalAgent(s, TEST_BURROW_ID, IDS.mara, { services: null });
  rex = { agentId: made.agentId, dmId: made.dmId };
  await s.db.update(principals).set({ name: 'Rex' }).where(eq(principals.id, rex.agentId));
  const sent = await a.commit(IDS.mara, sendMessage, {
    conversationId: rex.dmId,
    text: 'Check the backups every morning, please.',
  });
  expect(sent.status).toBe('ok');
  const [root] = await s.db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, rex.dmId), isNull(messages.threadRootId)))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  threadRoot = root?.id as string;
  const [mara] = await s.db.select().from(principals).where(eq(principals.id, IDS.mara));
  const now = s.clock();
  await s.db.insert(agentSchedules).values({
    id: newId('agentSchedule'),
    burrowId: TEST_BURROW_ID,
    agentId: rex.agentId,
    conversationId: rex.dmId,
    threadRootId: threadRoot,
    forAccountId: mara?.accountId as string,
    prompt: 'Look at last night’s backups and say how they went.',
    when: { kind: 'cron', expr: '0 8 * * *', zone: 'Europe/Amsterdam' },
    status: 'active',
    nextAt: now,
    anchorAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const serversA = await serversConnection(a);
  expect(
    (
      await a.commit(IDS.mara, setToolTier, {
        connectionId: serversA,
        tool: 'guests_list',
        tier: 'off',
      })
    ).status,
  ).toBe('ok');
  expect(
    (
      await a.commit(IDS.mara, setToolLimits, {
        connectionId: serversA,
        tool: 'server_power',
        limits: { args: { '/action': { choices: ['reboot'] } } },
        summary: null,
      })
    ).status,
  ).toBe('ok');
  // That thread is about a server, and Mara chose what answers it.
  await s.db
    .update(messages)
    .set({ subjectKind: 'server', subjectId: 'granite', subjectName: 'granite' })
    .where(eq(messages.id, threadRoot));
  await s.db.insert(chatThreadRuntimes).values({
    rootId: threadRoot,
    burrowId: TEST_BURROW_ID,
    conversationId: rex.dmId,
    runtime: { provider: 'claude' },
    setById: IDS.mara,
    setAt: now,
  });
  // A heat pump Rex learned to read, switched on with a limit on what it may set.
  const proposed = await s.pipeline.commit(
    proposeDeviceSkill,
    {
      profile: HEAT_PUMP,
      host: '192.168.91.42',
      port: 502,
      unitId: 1,
      tested: [],
      testedAt: now.toISOString(),
      conversationId: rex.dmId,
      personId: IDS.mara,
    },
    { burrowId: TEST_BURROW_ID, actorId: rex.agentId },
  );
  expect(proposed.status, JSON.stringify(proposed)).toBe('ok');
  const proposalId = (proposed as { result: { proposalId: string } }).result.proposalId;
  const decided = await a.commit(IDS.mara, decideDeviceSkill, {
    proposalId,
    actions: { room_setpoint: { tier: 'can', limits: { min: 16, max: 24 } } },
    switchOn: true,
  });
  expect(decided.status, JSON.stringify(decided)).toBe('ok');
  const [skill] = await s.db.select().from(deviceSkills).where(eq(deviceSkills.id, proposalId));
  const heatPump = skill?.connectionId as string;
  // A task chat about the heat pump, the Feedback room, each with a message.
  for (const chat of [
    { taskKey: 'tsk_heatpump1', chatTitle: 'Why is the heat pump loud?', subject: heatPump },
    { taskKey: 'feedback', chatTitle: 'Feedback', subject: null },
  ]) {
    const id = newId('conversation');
    await s.db.insert(conversations).values({
      id,
      burrowId: TEST_BURROW_ID,
      kind: 'dm',
      slug: `${made.handle}--mara--${chat.taskKey}`,
      title: 'Rex',
      dmAgentId: rex.agentId,
      dmPersonId: IDS.mara,
      taskKey: chat.taskKey,
      chatTitle: chat.chatTitle,
      chatSubjectKind: chat.subject ? 'device' : null,
      chatSubjectId: chat.subject,
      chatSubjectName: chat.subject ? 'Heat pump' : null,
      createdAt: now,
    });
    expect((await a.commit(IDS.mara, sendMessage, { conversationId: id, text: chat.chatTitle })).status).toBe(
      'ok',
    );
  }
  // A file on a message (Files isn't in this backup), a widget of the heat pump on its page, a command Rex may always
  // run, Mara's preferences, and a Google account whose sign-in doesn't open any more.
  const cookieA = (await sessionFor(s, IDS.mara)).cookie;
  const note = await upload(
    a.api,
    { cookie: cookieA },
    rex.dmId,
    'log.txt',
    Buffer.from('loud\n'),
    'text/plain',
  );
  expect(
    (
      await a.commit(IDS.mara, sendMessage, {
        conversationId: rex.dmId,
        text: 'The log',
        attachmentIds: [note.id],
      })
    ).status,
  ).toBe('ok');
  await s.db.insert(widgets).values({
    id: newId('widget'),
    burrowId: TEST_BURROW_ID,
    ownerId: IDS.mara,
    title: 'Room',
    kind: 'line',
    source: {
      kind: 'connection_tool',
      connectionId: heatPump,
      tool: 'heat_pump_read',
      args: {},
      values: [{ key: 'room', label: 'Room', path: '/room' }],
    },
    series: [{ key: 'room', label: 'Room', color: 1 }],
    thingId: `device:${heatPump}`,
    createdAt: now,
  } as never);
  await s.db.insert(commandAllowances).values({
    id: newId('commandAllowance'),
    burrowId: TEST_BURROW_ID,
    agentId: rex.agentId,
    keyId: 'deploy',
    command: 'fly deploy',
    target: '',
    createdById: IDS.mara,
    createdAt: now,
  });
  // Rex's keys as Mara set them: one the new box's agent holds at ask turned into allowed, and one an agent may only
  // ask for.
  const askHere = new Set(agentDefaultGrants('x').flatMap((g) => (g.tier === 'ask' ? [g.keyId] : [])));
  const rexKeys = await s.db.select().from(grants).where(eq(grants.agentId, rex.agentId));
  const raised = rexKeys.find(
    (g) =>
      g.tier === 'ask' &&
      askHere.has(g.keyId as never) &&
      KEY_CATALOG[g.keyId as keyof typeof KEY_CATALOG]?.agentMaxTier === 'can',
  );
  raisedKey = raised?.keyId as string;
  expect(raisedKey).toBeTruthy();
  await s.db
    .update(grants)
    .set({ tier: 'can' })
    .where(and(eq(grants.agentId, rex.agentId), eq(grants.keyId, raisedKey as never)));
  await s.db.delete(grants).where(and(eq(grants.agentId, rex.agentId), eq(grants.keyId, 'mail.send')));
  await s.db.insert(grants).values({
    burrowId: TEST_BURROW_ID,
    agentId: rex.agentId,
    keyId: 'mail.send',
    tier: 'can',
    position: 99,
  });
  await s.db
    .update(accounts)
    .set({ preferences: { theme: 'dark', timeZone: 'Europe/Amsterdam' } })
    .where(eq(accounts.id, mara?.accountId as string));
  await s.db.insert(connections).values({
    id: newId('connection'),
    accountId: mara?.accountId as string,
    provider: 'google',
    externalId: 'sub-mara',
    email: 'mara@gmail.example',
    name: 'Mara',
    services: ['mail'],
    scopes: [],
    refreshTokenEnc: 'sealed-under-another-key',
    grantedAt: now,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  } as never);

  // The file, made by Mara and downloaded.
  const create = await call(a, 'POST', url(api.backups.create.path, { burrow: 'burrow-hq' }), cookieA, {
    categories: CATEGORIES,
    password: PASSWORD,
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  await backupsFor(s).settle();
  const id = (create.body.file as { id: string }).id;
  const got = await call(
    a,
    'GET',
    url(api.backups.get.path, { burrow: 'burrow-hq', backupFileId: id }),
    cookieA,
  );
  const view = got.body.file as { status: string };
  expect(view.status).toBe('ready');
  fileBytes = await downloadBackup(a.services, 'burrow-hq', cookieA, id);

  // The fresh Whombat: Mara signs in there and makes her burrow, made with its agent (Dusty); Servers follows.
  const accountId = newId('account');
  await b.services.db.insert(accounts).values({
    id: accountId,
    email: 'mara@burrowhq.example',
    name: 'Mara Okafor',
    createdAt: b.services.clock(),
  });
  const fresh = await createBurrow(b.services, accountId, 'Moved Home');
  const [burrow] = await b.services.db.select().from(burrows).where(eq(burrows.id, fresh.burrowId));
  target = {
    ...fresh,
    slug: burrow?.slug as string,
    cookie: (await sessionFor(b.services, fresh.principalId)).cookie,
  };
  await serversConnection(b);
});

afterAll(async () => {
  await hostsA.stop();
  await hostsB.stop();
});

describe('the preview on a fresh Whombat', () => {
  it('counts the Servers connection as here and the agent as here', async () => {
    const p = await preview((await uploadToB()).id);
    const connections = p.categories.find((c) => c.id === 'connections');
    // Servers is here (B made it) and differs by Mara's tier; the heat pump and the Google account are new.
    expect(connections).toMatchObject({ new: 2, different: 1 });
    // The Google sign-in that couldn't go in the file, and the file left out without Files, are said.
    expect(connections?.notes.map((n) => n.code)).toContain('sign_in_left_out');
    const messagesRow = p.categories.find((c) => c.id === 'messages');
    expect(messagesRow?.notes).toContainEqual(expect.objectContaining({ code: 'files_left_out', count: 1 }));
    const agents = p.categories.find((c) => c.id === 'agents');
    // The agent is the one here, its name and keys different; never a second one.
    expect(agents).toMatchObject({ new: 0, different: 1 });
  });
});

describe('restoring it, keeping what is here', () => {
  let view: BackupRestoreView;

  beforeAll(async () => {
    view = await restore('keep');
  });

  it('never adds a Servers connection nor asks to sign in to one', async () => {
    const rows = await b.services.db
      .select()
      .from(catalogConnections)
      .where(
        and(
          eq(catalogConnections.burrowId, target.burrowId),
          eq(catalogConnections.catalogId, SERVERS_CATALOG_ID),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('active');
    // Only the Google account whose sign-in couldn't go in the file asks for one.
    expect((view.summary?.connectionsToSignIn ?? []).map((c) => c.label)).toEqual(['mara@gmail.example']);
    // Kept: the tier and limits are still B's own.
    const tools = await b.services.db
      .select()
      .from(connectionTools)
      .where(eq(connectionTools.connectionId, rows[0]?.id as string));
    expect(tools.find((t) => t.name === 'guests_list')?.tier).not.toBe('off');
    expect(tools.find((t) => t.name === 'server_power')?.limits ?? null).toBeNull();
  });

  it('brings the heat pump back with its skill, its choices and tools, working', async () => {
    const [device] = await b.services.db
      .select()
      .from(catalogConnections)
      .where(
        and(eq(catalogConnections.burrowId, target.burrowId), eq(catalogConnections.catalogId, 'device')),
      );
    expect(device?.status).toBe('active');
    const [skill] = await b.services.db
      .select()
      .from(deviceSkills)
      .where(eq(deviceSkills.connectionId, device?.id as string));
    expect(skill).toMatchObject({ status: 'on', host: '192.168.91.42', port: 502, unitId: 1 });
    expect(skill?.choices?.room_setpoint).toEqual({ tier: 'can', limits: { min: 16, max: 24 } });
    expect(device?.fields.skillId).toBe(skill?.id);
    const tools = await b.services.db
      .select()
      .from(connectionTools)
      .where(eq(connectionTools.connectionId, device?.id as string));
    const setpoint = tools.find((t) => t.name.endsWith('room_setpoint'));
    expect(setpoint?.tier).toBe('can');
    expect(setpoint?.limits).toEqual({ args: { '/value': { min: 16, max: 24 } } });
  });

  it('brings Chat back as it was: the thread, the task chat and the Feedback room', async () => {
    const mine = await assistantOnB();
    const chats = await b.services.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.dmAgentId, mine.id), eq(conversations.dmPersonId, target.principalId)));
    const [device] = await b.services.db
      .select({ id: catalogConnections.id })
      .from(catalogConnections)
      .where(
        and(eq(catalogConnections.burrowId, target.burrowId), eq(catalogConnections.catalogId, 'device')),
      );
    expect(chats.find((c) => c.taskKey === 'feedback')?.chatTitle).toBe('Feedback');
    expect(chats.find((c) => c.taskKey === 'tsk_heatpump1')).toMatchObject({
      chatSubjectKind: 'device',
      chatSubjectId: device?.id,
      title: mine.name,
    });
    const chat = chats.find((c) => c.taskKey === null);
    const [root] = await b.services.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, chat?.id as string), eq(messages.subjectId, 'granite')));
    expect(root).toMatchObject({ subjectKind: 'server', threadRootId: null });
    const [choice] = await b.services.db
      .select()
      .from(chatThreadRuntimes)
      .where(eq(chatThreadRuntimes.rootId, root?.id as string));
    expect(choice?.runtime.provider).toBe('claude');
  });

  it('brings back Mara’s widget, Rex’s allowed command and her preferences', async () => {
    const [device] = await b.services.db
      .select({ id: catalogConnections.id })
      .from(catalogConnections)
      .where(
        and(eq(catalogConnections.burrowId, target.burrowId), eq(catalogConnections.catalogId, 'device')),
      );
    const [widget] = await b.services.db
      .select()
      .from(widgets)
      .where(eq(widgets.ownerId, target.principalId));
    expect(widget?.thingId).toBe(`device:${device?.id}`);
    expect(widget?.source).toMatchObject({ kind: 'connection_tool', connectionId: device?.id });
    const mine = await assistantOnB();
    const allowed = await b.services.db
      .select({ command: commandAllowances.command, keyId: commandAllowances.keyId })
      .from(commandAllowances)
      .where(eq(commandAllowances.agentId, mine.id));
    expect(allowed).toEqual([{ command: 'fly deploy', keyId: 'deploy' }]);
    const [account] = await b.services.db
      .select({ preferences: accounts.preferences })
      .from(accounts)
      .where(eq(accounts.email, 'mara@burrowhq.example'));
    expect(account?.preferences).toMatchObject({ theme: 'dark', timeZone: 'Europe/Amsterdam' });
    const [google] = await b.services.db
      .select({ status: connections.status })
      .from(connections)
      .where(eq(connections.email, 'mara@gmail.example'));
    expect(google?.status).toBe('needs_reauth');
  });

  it('keeps the agent here as it is', async () => {
    const mine = await assistantOnB();
    expect(mine.name).toBe('Dusty');
  });

  it('finds the schedule its thread once the messages are back', async () => {
    const mine = await assistantOnB();
    const [schedule] = await b.services.db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.agentId, mine.id));
    expect(schedule?.status).toBe('paused');
    expect(schedule?.threadRootId).toBeTruthy();
    const [root] = await b.services.db
      .select()
      .from(messages)
      .where(eq(messages.id, schedule?.threadRootId as string));
    expect(root).toMatchObject({ conversationId: schedule?.conversationId, threadRootId: null });
    expect(root?.text).toContain('backups');
  });
});

describe('restoring it again with the backup’s choices', () => {
  it('sets the Servers tiers directly, gives the agent the file’s name and keys, and adds nothing', async () => {
    const view = await restore('replace');
    for (const c of view.summary?.categories ?? []) expect(c.added, c.id).toBe(0);
    expect(view.summary?.connectionsToSignIn ?? []).toEqual([]);
    expect(
      await b.services.db.select().from(conversations).where(eq(conversations.taskKey, 'tsk_heatpump1')),
    ).toHaveLength(1);
    expect(
      await b.services.db.select().from(widgets).where(eq(widgets.ownerId, target.principalId)),
    ).toHaveLength(1);
    const [servers] = await b.services.db
      .select({ id: catalogConnections.id })
      .from(catalogConnections)
      .where(
        and(
          eq(catalogConnections.burrowId, target.burrowId),
          eq(catalogConnections.catalogId, SERVERS_CATALOG_ID),
        ),
      );
    const tools = await b.services.db
      .select()
      .from(connectionTools)
      .where(eq(connectionTools.connectionId, servers?.id as string));
    expect(tools.find((t) => t.name === 'guests_list')?.tier).toBe('off');
    expect(tools.find((t) => t.name === 'server_power')?.limits).toEqual({
      args: { '/action': { choices: ['reboot'] } },
    });
    // Keys within Settings → Agent's limits, signed as it signs them; the name the file's agent had.
    const mine = await assistantOnB();
    const held = await b.services.db.select().from(grants).where(eq(grants.agentId, mine.id));
    expect(held.find((g) => g.keyId === raisedKey)?.tier).toBe('can');
    expect(held.find((g) => g.keyId === 'mail.send')?.tier ?? 'cannot').not.toBe('can');
    const keyEvents = await b.services.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.aboutId, mine.id), eq(events.kind, 'Keys')));
    expect(keyEvents.map((e) => e.payload.keyId)).toContain(raisedKey);
    expect(mine.name).toBe('Rex');
    const [renamed] = await b.services.db
      .select({ actorId: events.actorId, kind: events.kind })
      .from(events)
      .where(and(eq(events.aboutId, mine.id), eq(events.type, 'agent.updated')))
      .orderBy(desc(events.seq))
      .limit(1);
    expect(renamed).toEqual({ actorId: target.principalId, kind: 'Keys' });
    const schedules = await b.services.db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.burrowId, target.burrowId));
    expect(schedules).toHaveLength(1);
  });
});

describe('a burrow that doesn’t watch the servers', () => {
  it('gets no Servers connection from the file', async () => {
    const [mara] = await b.services.db.select().from(principals).where(eq(principals.id, target.principalId));
    const second = await createBurrow(b.services, mara?.accountId as string, 'Second Place', {
      besideOwn: true,
    });
    const [burrow] = await b.services.db.select().from(burrows).where(eq(burrows.id, second.burrowId));
    const to = {
      ...second,
      slug: burrow?.slug as string,
      cookie: (await sessionFor(b.services, second.principalId)).cookie,
    };
    const view = await restore('replace', to, ['connections']);
    expect(view.summary?.connectionsToSignIn ?? []).toEqual([]);
    const rows = await b.services.db
      .select()
      .from(catalogConnections)
      .where(
        and(
          eq(catalogConnections.burrowId, second.burrowId),
          eq(catalogConnections.catalogId, SERVERS_CATALOG_ID),
        ),
      );
    expect(rows).toEqual([]);
  });
});
