/**
 * Backup places end to end (backup-places.md) against the fake hosts service and a fake backup service: the owner's
 * list (BPL-04), setting BlackBox up in one step (BPL-05) with nothing secret kept anywhere, the move rule (BPL-06), the
 * assistant's `whombat_backup` from this Whombat's own disk and what it is told to say (BPL-16), BlackBox's shares and
 * moving the backups to another one (BPL-13, BPL-14), the Inbox proposal (BPL-07), the keep-the-place-right job
 * (following the NAS to a new address, BPL-08; the cleanup handed again when it didn't take, an older helper, a policy
 * that doesn't parse), refusing to forget or replace while the backup service is silent, removing a place, and the
 * care plan's NFS storage for a Proxmox server (BPL-12). Postgres because every step is a signed appliance event and a
 * place record written through the commit pipeline.
 */
import { BACKUP_PLACE_CLEANUP_HINT, BACKUP_PLACE_TEXT } from '@whombat/core';
import { KIT_PRF_SALT_V2_B64, kitKeyFromPrf, openKitWithKey, toBase64url } from '@whombat/core/backup';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { careOfferFor } from '../care/facts';
import type { AdapterContext } from '../connections/adapters/types';
import {
  applianceEvents,
  appliancePasskeys,
  backupPlaces,
  burrows,
  commandReceipts,
  messages,
} from '../db/schema/index';
import { BACKUPS_HREF, registerBoxBackupSource } from '../home/box-backup';
import { homeOverview } from '../home/overview';
import { hostsFor } from '../hosts/service';
import { FakeHostsService } from '../hosts/testing/fake';
import { SERVERS_ADAPTER } from '../hosts/tools';
import { type BackupPort, BackupServiceDown } from '../managed/backup';
import { relock, useBackupKeys } from '../managed/backup-key';
import { updateBackupKeyState } from '../managed/backup-key-store';
import { whombatBackupTool } from '../managed/backup-tool';
import { boxBackupStatus, useBoxBackup } from '../managed/box-backup';
import { loadPrincipalRow } from '../read/principals';
import type { DispatchRow } from '../runtime/context';
import { IDS, TEST_BURROW_ID } from '../seed/test-world';
import { useManagedRuntime } from '../test/managed';
import { addPersonalAgent, type PersonalSetup } from '../test/personal';
import { accountOf } from '../test/tokens';
import { FIRST_BACKUP_TEXT, tellFirstBackup } from './first-backup';
import { keepPlaceRight, newPasswordOf } from './keep-right';
import { useKitNet } from './kit-copy';
import { changeBoxBackupNotes, loadBoxBackupNotes, without } from './notes';
import { keptHints } from './watch';

type Json = Record<string, unknown>;

const fake = new FakeHostsService();
const m = useManagedRuntime({
  seed: true,
  env: { WHOMBAT_HOSTS_SOCKET: fake.socket, WHOMBAT_HOSTS_TOKEN_FILE: fake.tokenFile },
});

/** The backup service: one destination at a time, a repository per address it was made at. */
const box = {
  destination: null as null | { kind: string; repository: string; restUser?: string; restPassword?: string },
  repositoryPassword: 'repo-secret-password-0123456789',
  repositories: new Map<string, string>(),
  puts: [] as Json[],
  checkpoints: 0,
  /** The person's policy as the service answers it (undefined: a service from before the options, 404). */
  policy: undefined as unknown,
  policyPuts: [] as Json[],
  /** The service doesn't answer (its socket is gone). */
  silent: false,
  /** When the last backup worked (null: none yet). */
  lastSuccessAt: null as string | null,
  doc() {
    const d = this.destination;
    return {
      kind: 'whombat.backup-status/1',
      state: d ? 'pending' : 'unprotected',
      protected: false,
      destination: d
        ? {
            configured: true,
            kind: d.kind,
            display:
              d.kind === 'rest'
                ? new URL(d.repository.slice(5)).host
                : d.kind === 'sftp'
                  ? d.repository.split(':')[1]
                  : '/var/lib/whombat/backup',
            appendOnly: d.kind === 'rest' ? 'verified' : 'not-enforced',
            repositoryId: this.repositories.get(d.repository) ?? 'repo-local',
          }
        : { configured: false },
      lastSuccess: this.lastSuccessAt
        ? {
            id: 'ck-1',
            at: this.lastSuccessAt,
            ageSeconds: 1,
            snapshotId: 's1',
            method: 'snapshot',
            quiesceHeldMs: 1,
            durationMs: 1,
            bytesAdded: 1,
            totalBytes: 1,
            files: 1,
            schemaVersion: 1,
          }
        : null,
      lastFailure: null,
      lastAttemptOk: null,
      coverage: [],
      recoverability: { lastDrill: null },
      kitGeneration: 0,
      running: null,
      updatedAt: new Date().toISOString(),
    };
  },
};
const port: BackupPort = {
  async call(method, path, body) {
    if (box.silent) throw new BackupServiceDown('unreachable');
    if (method === 'GET' && path === '/v1/status') return { status: 200, body: box.doc() };
    if (method === 'GET' && path === '/v1/policy')
      return box.policy === undefined ? { status: 404, body: null } : { status: 200, body: box.policy };
    if (method === 'PUT' && path === '/v1/policy') {
      box.policyPuts.push(body as Json);
      return { status: 200, body };
    }
    if (method === 'PUT' && path === '/v1/destination') {
      const b = body as Json;
      box.puts.push(b);
      const repository = String(b.repository);
      // An adopted repository is joined where it is: the same id at the new address.
      const id = b.adoptPassword ? box.repositories.get(String(box.destination?.repository)) : undefined;
      box.repositories.set(repository, id ?? `repo-${box.repositories.size + 1}`);
      box.destination = {
        kind: repository.split(':')[0] as string,
        repository,
        restUser: b.restUser as string,
        restPassword: b.restPassword as string,
      };
      return {
        status: 200,
        body: {
          repositoryId: box.repositories.get(repository),
          appendOnly: 'verified',
          generation: box.puts.length,
          kind: 'rest',
        },
      };
    }
    if (method === 'GET' && path === '/v1/recovery-material') {
      const d = box.destination;
      if (!d) return { status: 412, body: { error: 'unprotected' } };
      return {
        status: 200,
        body: {
          kind: 'whombat.backup-recovery-material/1',
          applianceId: 'box-1',
          generation: box.puts.length,
          createdAt: '2026-11-03T12:00:00Z',
          repository: d.repository,
          ...(d.restUser ? { restUser: d.restUser, restPassword: d.restPassword } : {}),
          repositoryPassword: box.repositoryPassword,
          repositoryId: box.repositories.get(d.repository) ?? 'repo-local',
          manifestKey: `ed25519:${Buffer.alloc(32, 7).toString('base64')}`,
        },
      };
    }
    if (method === 'POST' && path === '/v1/checkpoints') {
      box.checkpoints += 1;
      return { status: 200, body: { ok: true, ref: 'ck-1', verified: false, id: 'ck-1', seq: 1 } };
    }
    if (method === 'GET' && path === '/v1/ssh-public-key')
      return {
        status: 200,
        body: { publicKey: 'ssh-ed25519 AAAA whombat-backup@box', fingerprint: 'SHA256:x' },
      };
    return { status: 404, body: null };
  },
};

let owner: Awaited<ReturnType<typeof m.enroll>>;
let mine: PersonalSetup;
const blackbox = () => fake.details.blackbox as Json;
const place = () => blackbox().backup_place as Json;

beforeAll(async () => {
  await fake.start();
  m.runtime.dispatcher.backup = port;
  useBoxBackup(m.t.services, { port, status: () => null });
  registerBoxBackupSource();
  owner = await m.enroll(IDS.mara);
  mine = await addPersonalAgent(m.t.services, TEST_BURROW_ID, IDS.mara, { services: null });
});

afterAll(async () => {
  await fake.stop();
});

/** Mara, as Home reads for her. */
async function viewer() {
  const principal = await loadPrincipalRow(m.t.services.db, IDS.mara);
  const [burrow] = await m.t.services.db.select().from(burrows).where(eq(burrows.id, TEST_BURROW_ID));
  if (!principal || !burrow) throw new Error('viewer');
  return { principal, burrow } as never;
}

/** The assistant's `whombat_backup` in a turn for the person. */
async function tool(input: Json) {
  const account = await accountOf(m.t.services, IDS.mara);
  return whombatBackupTool(
    {
      services: m.t.services,
      agentId: mine.agentId,
      burrowId: TEST_BURROW_ID,
      dispatch: { onBehalfOfAccountId: account, conversationId: mine.dmId } as DispatchRow,
      onBehalfOf: {},
    },
    input as never,
  );
}

async function places() {
  const c = await m.client(owner);
  const answer = (await c.request('backup.places', {})) as unknown as {
    t: string;
    output: { places: Json[]; currentPlaceId: string | null };
  };
  expect(answer.t).toBe('result');
  return answer.output;
}

describe('backup places (backup-places.md)', () => {
  it('lists the servers that can keep backups, in their state', async () => {
    const list = await places();
    expect(list.currentPlaceId).toBeNull();
    // BlackBox (Unraid, Manage on) is ready; the server this Whombat runs on and one without Docker aren't listed.
    expect(list.places.map((p) => [p.id, p.kind, p.state])).toEqual([['server:blackbox', 'unraid', 'ready']]);
    expect(list.places[0]).toMatchObject({ address: '10.100.0.40', kept: { freeBytes: 1_900_000_000_000 } });
    // Its shares (BPL-13): the new one only Whombat uses first, a share open on the network says so, Unraid's own last.
    const locations = list.places[0]?.locations as Json[];
    expect(locations.map((l) => [l.id, l.recommended, l.isNew])).toEqual([
      ['whombat-backups', true, true],
      ['backups', false, false],
      ['appdata', false, false],
    ]);
    expect(locations[1]?.note).toBe(BACKUP_PLACE_TEXT.location.shared);
    expect(locations[2]?.note).toBe(BACKUP_PLACE_TEXT.location.holdsOther);
    expect(list.places[0]?.location).toBeNull();
  });

  it('the Inbox proposes it, also while backups go only to this Whombat’s own disk (BPL-07)', async () => {
    const item = async () =>
      (await homeOverview(m.t.services, await viewer())).needsYouList?.find((i) => i.kind === 'backup');
    expect((await item())?.title).toContain('blackbox');
    box.destination = { kind: 'local', repository: '/var/lib/whombat/backup' };
    await boxBackupStatus(m.t.services, { fresh: true });
    const own = await item();
    expect(own?.title).toContain('own disk');
    expect(own?.actions[0]?.text).toContain('blackbox');
  });

  it('the assistant sets it from this Whombat’s own disk with whombat_backup (BPL-06)', async () => {
    const read = (await tool({})) as { status: string; places: Json[] };
    expect(read.places).toEqual([expect.objectContaining({ id: 'server:blackbox', state: 'ready' })]);
    expect(((read.places[0]?.locations ?? []) as Json[]).map((l) => l.id)).toEqual([
      'whombat-backups',
      'backups',
      'appdata',
    ]);
    const set = (await tool({ set: 'place', place: 'server:blackbox' })) as Json;
    expect(set).toMatchObject({ status: 'set', kind: 'place', destination: 'blackbox' });
    // What the assistant passes on (BPL-16): the place and the share by name, the first backup running; no address,
    // port or path.
    const say = String(set.say);
    expect(say).toContain('blackbox');
    expect(say).toContain('the share whombat-backups');
    expect(say).toContain('running now');
    expect(say).not.toMatch(/10\.100|8747|\/mnt|http/);

    const [row] = await m.t.services.db.select().from(backupPlaces);
    expect(row).toMatchObject({ id: 'server:blackbox', kind: 'unraid', address: '10.100.0.40', port: 8747 });
    const client = row?.client as string;
    expect(client).toMatch(/^whombat-[a-z0-9-]+$/);
    // The backup app got a REST password; the destination the same user and password, plain http to the address.
    const ensure = fake.calls('POST', '/api/v1/servers/blackbox/backup-place/ensure').at(-1)?.body as Json;
    expect(ensure).toMatchObject({ client, port: 0 });
    const put = box.puts.at(-1) as Json;
    expect(put).toMatchObject({
      repository: `rest:http://10.100.0.40:8747/${client}/`,
      restUser: client,
      restPassword: ensure.rest_password,
      allowInit: true,
    });
    expect(put.adoptPassword).toBeUndefined();
    // The cleanup has the repository password, from the recovery material.
    const cleanup = fake.calls('PUT', `/api/v1/servers/blackbox/backup-place/${client}/cleanup`).at(-1)?.body;
    // With the recommended options (backup-options.md BKO-01): the windows and no limit.
    expect(cleanup).toEqual({
      repository_password: box.repositoryPassword,
      keep_within_days: 2,
      keep_daily_days: 14,
      keep_weekly_days: 56,
      keep_monthly_months: 12,
      limit_bytes: 0,
    });
    expect(row?.cleanupAt).not.toBeNull();
    expect(box.checkpoints).toBe(1);
    // Signed for the box, the assistant beside the person; no password in any record.
    const events = await m.t.services.db.select().from(applianceEvents);
    const set_ = events.filter((e) => e.type === 'backup.destination_set').at(-1);
    expect(set_?.payload).toMatchObject({ kind: 'rest', host: '10.100.0.40:8747', agentId: mine.agentId });
    const kept = JSON.stringify([events, await m.t.services.db.select().from(backupPlaces)]);
    expect(kept).not.toContain(String(ensure.rest_password));
    expect(kept).not.toContain(box.repositoryPassword);

    const list = await places();
    expect(list.currentPlaceId).toBe('server:blackbox');
    expect(list.places[0]).toMatchObject({ state: 'in_use', kept: { usedBytes: 0, cleanup: { on: true } } });
    // Now it backs up there: the assistant moves it no more, and the Inbox has nothing to propose.
    expect(await tool({ set: 'place', place: 'server:blackbox' })).toMatchObject({
      status: 'failed',
      reason: 'already_set',
    });
    expect(
      (await homeOverview(m.t.services, await viewer())).needsYouList?.find((i) => i.kind === 'backup'),
    ).toBeUndefined();
  });

  it('tells the thread the person said yes in when the first backup is done, once', async () => {
    box.lastSuccessAt = new Date(Date.now() + 1000).toISOString();
    await boxBackupStatus(m.t.services, { fresh: true });
    expect(await tellFirstBackup(m.t.services)).toBe('told');
    expect(await tellFirstBackup(m.t.services)).toBe('none');
    const said = await m.t.services.db
      .select({ text: messages.text, authorId: messages.authorId, threadRootId: messages.threadRootId })
      .from(messages)
      .where(eq(messages.conversationId, mine.dmId));
    const told = said.filter((x) => x.text?.includes(FIRST_BACKUP_TEXT.done('blackbox')));
    expect(told).toEqual([
      { text: FIRST_BACKUP_TEXT.done('blackbox'), authorId: mine.agentId, threadRootId: null },
    ]);
  });

  it('doing it again carries on with the same password and repository (BPL-05)', async () => {
    const c = await m.client(owner);
    const before = box.puts.length;
    const again = await c.request('backup.usePlace', { placeId: 'server:blackbox' });
    expect(again).toMatchObject({
      t: 'result',
      output: { placeId: 'server:blackbox', appendOnly: 'verified', firstBackup: false },
    });
    expect(box.puts.length).toBe(before);
    const ensures = fake.calls('POST', '/api/v1/servers/blackbox/backup-place/ensure');
    const password = (n: number) => (ensures.at(n)?.body as Json | undefined)?.rest_password;
    expect(password(-1)).toBe(password(-2));
    const receipts = JSON.stringify(await m.t.services.db.select().from(commandReceipts));
    expect(receipts).not.toContain(String(password(-1)));
  });

  it('moves the backups to another share on BlackBox: the same destination and history (BPL-13, BPL-14)', async () => {
    const c = await m.client(owner);
    const [before] = await m.t.services.db.select().from(backupPlaces);
    expect(before?.location).toBe('whombat-backups');
    expect((await places()).places[0]).toMatchObject({ state: 'in_use', location: 'whombat-backups' });
    // A share it doesn't have is refused before anything changes.
    expect(
      await c.request('backup.usePlace', { placeId: 'server:blackbox', location: 'nowhere' }),
    ).toMatchObject({ t: 'error', details: { code: 'backup_location_gone' } });
    const puts = box.puts.length;
    const checkpoints = box.checkpoints;
    const repositoryId = box.doc().destination.repositoryId;
    // The agent moves it itself: no move to confirm.
    const moved = await c.request('backup.usePlace', { placeId: 'server:blackbox', location: 'backups' });
    expect(moved).toMatchObject({
      t: 'result',
      output: { placeId: 'server:blackbox', locationName: 'the share backups', firstBackup: false },
    });
    const ensure = fake.calls('POST', '/api/v1/servers/blackbox/backup-place/ensure').at(-1)?.body as Json;
    expect(ensure).toMatchObject({ client: before?.client, location: 'backups' });
    expect(fake.backupPlaces.moves).toBe(1);
    // The destination, the repository and the first backup are as they were.
    expect(box.puts.length).toBe(puts);
    expect(box.checkpoints).toBe(checkpoints);
    expect(box.doc().destination.repositoryId).toBe(repositoryId);
    const [after] = await m.t.services.db.select().from(backupPlaces);
    expect(after?.location).toBe('backups');
    expect((await places()).places[0]).toMatchObject({ state: 'in_use', location: 'backups' });
  });

  it('follows BlackBox to a new address with the same repository (BPL-08)', async () => {
    const follow = async () => {
      const report = await keepPlaceRight(m.t.services);
      return report.outcome === 'ran' ? report.steps.follow : report.outcome;
    };
    expect(await follow()).toBe('same');
    place().addresses = ['10.100.0.41'];
    (blackbox().server as Json).address = '10.100.0.41';
    hostsFor(m.t.services).forget();
    const repositoryId = box.doc().destination.repositoryId;
    expect(await follow()).toBe('changed');
    const put = box.puts.at(-1) as Json;
    const [row] = await m.t.services.db.select().from(backupPlaces);
    expect(put).toMatchObject({
      repository: `rest:http://10.100.0.41:8747/${row?.client}/`,
      restUser: row?.client,
      adoptPassword: box.repositoryPassword,
    });
    expect(put.allowInit).toBeUndefined();
    expect(row?.address).toBe('10.100.0.41');
    expect(box.doc().destination.repositoryId).toBe(repositoryId);
    expect((await places()).currentPlaceId).toBe('server:blackbox');
  });

  it('lost or stolen: BlackBox gets a new password, and the passkey locks the new details again at once', async () => {
    // A passkey holds this Whombat's backup key.
    useBackupKeys(m.t.services, { appliance: m.appliance.peerId, manager: m.manager });
    const credentialId = 'cm90YXRlLWtleQ';
    const key = kitKeyFromPrf(new Uint8Array(32).fill(9), m.appliance.peerId);
    await m.t.services.db.insert(appliancePasskeys).values({
      id: credentialId,
      accountId: owner.accountId,
      name: 'Phone',
      publicKey: Buffer.from([1, 2, 3]),
      backupEligible: true,
      backedUp: true,
    });
    const c = await m.client(owner);
    expect(
      await c.request('backup.passkeyKey.set', {
        credentialId,
        salt: KIT_PRF_SALT_V2_B64,
        key: toBase64url(key),
      }),
    ).toMatchObject({ t: 'result' });
    // BlackBox's backup app, as the kit user sees it: 401 while it has no kit user.
    const [row] = await m.t.services.db.select().from(backupPlaces);
    const app = (place().clients as Json[]).find((x) => x.client === row?.client) as Json;
    const kitAsked: string[] = [];
    useKitNet(m.t.services, {
      scan: false,
      fetch: async (url, init) => {
        const method = init.method ?? 'GET';
        kitAsked.push(`${method} ${new URL(url).pathname}`);
        if (app.kit !== true) return new Response(null, { status: 401 });
        return new Response(null, { status: method === 'HEAD' || method === 'GET' ? 404 : 200 });
      },
    });
    const ensures = () => fake.calls('POST', '/api/v1/servers/blackbox/backup-place/ensure').length;
    try {
      const puts = box.puts.length;
      const pushes = m.manager.kitPushes.length;
      await changeBoxBackupNotes(m.t.services, (n) => ({
        ...n,
        rotate: { since: new Date().toISOString(), tries: 0, lastError: null },
      }));
      expect(await keepPlaceRight(m.t.services)).toMatchObject({ steps: { rotate: 'changed' } });
      expect(box.puts.length).toBe(puts + 1);
      // Locked again without waiting for the manager's next report: locking once more finds nothing to do, and control
      // has the details with the new password and generation.
      expect(await relock(m.t.services)).toBe('unchanged');
      expect(m.manager.kitPushes.length).toBeGreaterThan(pushes);
      const sent = m.manager.kitPushes.at(-1)?.envelopes[0];
      expect(sent).toMatchObject({ credentialId, generation: box.puts.length });
      const opened = openKitWithKey(sent?.envelope ?? '', key, m.appliance.peerId);
      expect(JSON.parse(opened ?? '{}')).toMatchObject({
        restPassword: box.destination?.restPassword,
        generation: box.puts.length,
      });

      // An app from before the kit user: writing the copy next to the backups finds none, and the keep-the-place-right
      // job gives it one inside the place lock.
      app.kit = false;
      hostsFor(m.t.services).forget();
      const before = ensures();
      await updateBackupKeyState(m.t.services, m.appliance.peerId, { nasDigest: null, nasTriedAt: null });
      await relock(m.t.services);
      expect(kitAsked.at(-1)).toBe('POST /kit/');
      expect((await loadBoxBackupNotes(m.t.services.db)).placeKit).toBeDefined();
      // The run the copy asked for is done once the next one is.
      await keepPlaceRight(m.t.services);
      expect(ensures()).toBe(before + 1);
      expect(app.kit).toBe(true);
      expect((await loadBoxBackupNotes(m.t.services.db)).placeKit).toBeUndefined();
      await relock(m.t.services);
      expect(kitAsked.at(-1)).toMatch(/^POST \/kit\/keys\/[0-9a-f]{64}$/);
    } finally {
      useKitNet(m.t.services, {
        scan: false,
        fetch: async () => {
          throw new TypeError('no network in tests');
        },
      });
      expect(await c.request('backup.passkeyKey.remove', { credentialId })).toMatchObject({ t: 'result' });
    }
  });

  it('lost or stolen on a place Whombat can’t give a new password: the person is told, until they set one', async () => {
    const saved = box.destination;
    const item = async () =>
      (await homeOverview(m.t.services, await viewer())).needsYouList?.find(
        (i) => i.kind === 'backup' && i.ref.id.startsWith('password:'),
      );
    try {
      // BlackBox, set up by Whombat: it changes the password itself.
      await boxBackupStatus(m.t.services, { fresh: true });
      expect(await newPasswordOf(m.t.services)).toEqual({ by: 'whombat', place: 'blackbox' });
      // A REST server typed in by hand.
      box.destination = {
        kind: 'rest',
        repository: 'rest:http://10.0.2.2:8747/rehearsal/',
        restUser: 'rehearsal',
        restPassword: 'old-secret',
      };
      const puts = box.puts.length;
      await changeBoxBackupNotes(m.t.services, (n) => ({
        ...n,
        rotate: { since: new Date().toISOString(), tries: 0, lastError: null },
      }));
      expect(await keepPlaceRight(m.t.services)).toMatchObject({ steps: { rotate: 'waiting' } });
      expect(box.puts.length).toBe(puts);
      const notes = await loadBoxBackupNotes(m.t.services.db);
      expect(notes.rotate).toBeUndefined();
      expect(notes.changePassword).toMatchObject({ place: '10.0.2.2:8747', byHand: false });
      expect(await newPasswordOf(m.t.services)).toEqual({ by: 'you', place: '10.0.2.2:8747' });
      const asked = await item();
      expect(asked?.title).toContain('10.0.2.2:8747');
      expect(asked?.actions[0]).toMatchObject({ kind: 'open', href: BACKUPS_HREF });
      // The person gives Whombat the new password: the item goes.
      const c = await m.client(owner);
      expect(
        await c.request('backup.configureDestination', {
          repository: 'rest:http://10.0.2.2:8747/rehearsal/',
          restUser: 'rehearsal',
          restPassword: 'new-secret',
        }),
      ).toMatchObject({ t: 'result' });
      expect(await item()).toBeUndefined();
    } finally {
      box.destination = saved;
      await changeBoxBackupNotes(m.t.services, (n) => without(n, 'changePassword'));
      await boxBackupStatus(m.t.services, { fresh: true });
    }
  });

  it('keeps the cleanup right: a change that didn’t take is handed again, never the defaults over the options', async () => {
    const [row] = await m.t.services.db.select().from(backupPlaces);
    const client = row?.client as string;
    const cleanups = () =>
      fake.calls('PUT', `/api/v1/servers/blackbox/backup-place/${client}/cleanup`).length;
    // What it was handed is recorded with the windows the helper takes.
    expect(row?.cleanupKeep).toMatchObject({ keep: { allDays: 2, monthlyMonths: 12 }, windows: true });
    const before = cleanups();
    expect(await keepPlaceRight(m.t.services)).toMatchObject({ outcome: 'ran', steps: { cleanup: 'same' } });
    expect(cleanups()).toBe(before);

    // The person's options: everything for 30 days, read from the service and handed over.
    box.policy = {
      v: 1,
      frequency: '6h',
      timeZone: 'Europe/Amsterdam',
      keep: { allDays: 30, dailyDays: 0, weeklyWeeks: 0, monthlyMonths: 0 },
      limitBytes: null,
      weeklyCheck: true,
    };
    // A change that never reached the place (the record lost it): handed again on the next run.
    await m.t.services.db.update(backupPlaces).set({ cleanupKeep: null });
    expect(await keepPlaceRight(m.t.services)).toMatchObject({ steps: { cleanup: 'changed' } });
    expect(
      fake.calls('PUT', `/api/v1/servers/blackbox/backup-place/${client}/cleanup`).at(-1)?.body,
    ).toMatchObject({
      keep_within_days: 30,
    });

    // A policy with a member this runtime doesn't know (a newer service): its windows still count, but the policy is
    // never written back (not even for the time zone), and never replaced by the recommended options.
    box.policy = { ...(box.policy as Json), timeZone: 'UTC', somethingNew: true };
    const puts = box.policyPuts.length;
    expect(await keepPlaceRight(m.t.services)).toMatchObject({
      steps: { timeZone: 'same', cleanup: 'same' },
    });
    expect(box.policyPuts.length).toBe(puts);
    // One that doesn't parse at all changes nothing.
    box.policy = { v: 2, keep: 'everything' };
    await m.t.services.db.update(backupPlaces).set({ cleanupKeep: null });
    const n = cleanups();
    expect(await keepPlaceRight(m.t.services)).toMatchObject({ steps: { cleanup: 'same' } });
    expect(cleanups()).toBe(n);
    expect(box.policyPuts.length).toBe(puts);
    box.policy = undefined;
    await keepPlaceRight(m.t.services);
  });

  it('an older helper gets the longest window as its days, never 2 (it would clear a year of backups)', async () => {
    const [row] = await m.t.services.db.select().from(backupPlaces);
    const client = row?.client as string;
    fake.backupPlaces.olderHelper = true;
    try {
      const c = (place().clients as Json[]).find((x) => x.client === client) as Json;
      c.cleanup = {
        set: false,
        running: false,
        keep_within_days: 0,
        last_run_at: null,
        last_ok: null,
        last_error: '',
      };
      await m.t.services.db.update(backupPlaces).set({ cleanupKeep: null });
      hostsFor(m.t.services).forget();
      expect(await keepPlaceRight(m.t.services)).toMatchObject({ steps: { cleanup: 'changed' } });
      const body = fake.calls('PUT', `/api/v1/servers/blackbox/backup-place/${client}/cleanup`).at(-1)
        ?.body as Json;
      expect(body.keep_within_days).toBe(365);
      const [after] = await m.t.services.db.select().from(backupPlaces);
      expect(after?.cleanupKeep).toMatchObject({ windows: false });
    } finally {
      fake.backupPlaces.olderHelper = false;
    }
  });

  it('says when old backups aren’t being cleared there (a line that starts off, BPL-11)', async () => {
    const [row] = await m.t.services.db.select().from(backupPlaces);
    const c = (place().clients as Json[]).find((x) => x.client === row?.client) as Json;
    (c.cleanup as Json).last_ok = false;
    hostsFor(m.t.services).forget();
    await places();
    expect(keptHints(m.t.services, 'blackbox').map((h) => h.kind)).toEqual([BACKUP_PLACE_CLEANUP_HINT]);
    (c.cleanup as Json).last_ok = true;
  });

  it('a move away is the person’s, with move; the place in use isn’t removed (BPL-06)', async () => {
    const c = await m.client(owner);
    // Backups go to an SFTP server the person set: setting a place asks for the move first.
    const saved = box.destination;
    box.destination = { kind: 'sftp', repository: 'sftp:nas-01:/srv/backup' };
    await boxBackupStatus(m.t.services, { fresh: true });
    expect(await c.request('backup.usePlace', { placeId: 'server:blackbox' })).toMatchObject({
      t: 'error',
      details: { code: 'move_needed', from: 'nas-01' },
    });
    expect(await tool({ set: 'place', place: 'server:blackbox' })).toMatchObject({
      status: 'failed',
      reason: 'already_set',
    });
    box.destination = saved;
    expect(await c.request('backup.forgetPlace', { placeId: 'server:blackbox' })).toMatchObject({
      t: 'error',
      details: { code: 'backup_place_in_use' },
    });
  });

  it('the job waits while a restore holds the box (quarantine)', async () => {
    const puts = box.puts.length;
    m.t.services.maintenance.quarantined = true;
    try {
      expect(await keepPlaceRight(m.t.services)).toEqual({ outcome: 'paused' });
    } finally {
      m.t.services.maintenance.quarantined = false;
    }
    expect(box.puts.length).toBe(puts);
  });

  it('the claim’s yes waits for the AI, and after a day without it the Inbox asks instead', async () => {
    const saved = box.destination;
    box.destination = null;
    try {
      await boxBackupStatus(m.t.services, { fresh: true });
      await changeBoxBackupNotes(m.t.services, (n) => ({
        ...n,
        consent: {
          at: new Date().toISOString(),
          accountId: 'acc',
          placeId: 'server:blackbox',
          state: 'waiting',
        },
      }));
      const proposal = async () =>
        (await homeOverview(m.t.services, await viewer())).needsYouList?.find((i) => i.kind === 'backup');
      expect(await proposal()).toBeUndefined();
      // No AI connected in this test: it waits…
      expect(await keepPlaceRight(m.t.services)).toMatchObject({ steps: { consent: 'waiting' } });
      // …a day at most.
      await changeBoxBackupNotes(m.t.services, (n) =>
        n.consent
          ? { ...n, consent: { ...n.consent, at: new Date(Date.now() - 25 * 3_600_000).toISOString() } }
          : null,
      );
      expect(await keepPlaceRight(m.t.services)).toMatchObject({ steps: { consent: 'failed' } });
      expect((await proposal())?.title).toContain('blackbox');
    } finally {
      box.destination = saved;
      await boxBackupStatus(m.t.services, { fresh: true });
    }
  });

  it('while the backup service doesn’t answer, nothing is forgotten or replaced (fail closed)', async () => {
    const c = await m.client(owner);
    box.silent = true;
    try {
      await boxBackupStatus(m.t.services, { fresh: true });
      expect(
        await c.request('backup.forgetPlace', { placeId: 'server:blackbox', deleteData: true }),
      ).toMatchObject({
        t: 'error',
        details: { code: 'backup_unavailable' },
      });
      expect(await tool({ set: 'disk' })).toMatchObject({ status: 'failed', reason: 'unavailable' });
      expect(place().clients).not.toEqual([]);
      // The person reads a plain sentence, not “Something went wrong”.
      const status = (await c.request('backup.status', {})) as Json;
      expect(status).toMatchObject({ t: 'error', details: { code: 'backup_unavailable' } });
      expect(String(status.message)).toContain('isn’t answering');
    } finally {
      box.silent = false;
      await boxBackupStatus(m.t.services, { fresh: true });
    }
  });

  it('Manage off: Turn on Manage first, and nothing is installed', async () => {
    const rc = (blackbox().server as Json).remote_control as Json;
    rc.manage = false;
    hostsFor(m.t.services).forget();
    const c = await m.client(owner);
    box.destination = null;
    try {
      const list = await places();
      expect(list.places.find((p) => p.id === 'server:blackbox')).toMatchObject({ state: 'manage_first' });
      const before = fake.calls('POST', '/api/v1/servers/blackbox/backup-place/ensure').length;
      expect(await c.request('backup.usePlace', { placeId: 'server:blackbox' })).toMatchObject({
        t: 'error',
        details: { code: 'backup_place_not_ready' },
      });
      expect(fake.calls('POST', '/api/v1/servers/blackbox/backup-place/ensure').length).toBe(before);
    } finally {
      rc.manage = true;
      hostsFor(m.t.services).forget();
    }
  });

  it('a failed install says which step, and removing a place not in use takes its app away', async () => {
    const c = await m.client(owner);
    fake.backupPlaces.failNextEnsure = {
      status: 502,
      headers: { 'content-type': 'application/problem+json' },
      body: { code: 'agent_error', detail: 'Docker couldn’t pull the image.', status: 502 },
    };
    const failed = (await c.request('backup.usePlace', { placeId: 'server:blackbox' })) as Json;
    expect(failed).toMatchObject({ t: 'error', details: { code: 'backup_place_failed', step: 'install' } });
    expect(String(failed.message)).toContain('blackbox');
    // Nothing backs up there now (the destination went elsewhere): it can go.
    expect(await c.request('backup.forgetPlace', { placeId: 'server:blackbox' })).toMatchObject({
      t: 'result',
      output: { ok: true },
    });
    expect(
      await m.t.services.db.select().from(backupPlaces).where(eq(backupPlaces.id, 'server:blackbox')),
    ).toEqual([]);
    expect(place().clients).toEqual([]);
    // By hand instead (BPL-09): the app to paste holds the user's bcrypt line; the password waits sealed in the record.
    const byHand = (await c.request('backup.placeByHand', { placeId: 'server:blackbox' })) as Json;
    expect(byHand).toMatchObject({ t: 'result' });
    const out = byHand.output as { compose: string; steps: string[]; expiresAt: string };
    expect(out.compose).toContain('/mnt/user/whombat-backups/');
    expect(out.compose).not.toContain('RESTIC_PASSWORD');
    expect(out.steps.length).toBeGreaterThan(1);
    const [rec] = await m.t.services.db
      .select()
      .from(backupPlaces)
      .where(eq(backupPlaces.id, 'server:blackbox'));
    expect(rec?.pendingPasswordEnc).toBeTruthy();
    expect(rec?.pendingUntil?.toISOString()).toBe(out.expiresAt);
    expect(rec?.byHand).toBe(false);
    // Asked again the same day: the same password (a compose pasted earlier still checks).
    expect(await c.request('backup.placeByHand', { placeId: 'server:blackbox' })).toMatchObject({
      t: 'result',
    });
    const [still] = await m.t.services.db
      .select()
      .from(backupPlaces)
      .where(eq(backupPlaces.id, 'server:blackbox'));
    expect(still?.pendingPasswordEnc).toBe(rec?.pendingPasswordEnc);
  });
});

describe('a Proxmox server’s backups on the NAS (BPL-12)', () => {
  it('plans them on BlackBox over NFS when there is no Backup Server, and the two tools set it up', async () => {
    const shale = fake.details.shale as Json;
    shale.storages = (shale.storages as Json[]).filter((s) => s.type !== 'pbs');
    hostsFor(m.t.services).forget();
    const offer = await careOfferFor(m.t.services, TEST_BURROW_ID, 'shale');
    const step = offer?.steps.find((s) => s.care === 'backup');
    expect(step?.text).toContain('blackbox');
    expect(step?.step).toContain('backup_place_nfs on blackbox');
    expect(step?.step).toContain('"10.20.0.15"');
    expect(step?.step).toContain('storage "blackbox-backup"');

    const ctx: AdapterContext = {
      baseUrl: '',
      fields: {},
      bases: {},
      send: () => Promise.reject(new Error('no')),
      call: {
        services: m.t.services,
        burrowId: TEST_BURROW_ID,
        agentId: mine.agentId,
        connectionId: 'servers',
        callId: 'call-1',
        conversationId: null,
        personId: IDS.mara,
      },
    };
    const run = async (name: string, args: Json) => {
      const tool = SERVERS_ADAPTER[name];
      if (!tool) throw new Error(name);
      const out = await tool(ctx, args);
      expect(out.isError, out.content).toBe(false);
      return JSON.parse(out.content) as Json;
    };
    const shared = await run('backup_place_nfs', {
      server: 'blackbox',
      name: 'whombat-shale',
      clients: ['10.20.0.15'],
    });
    // BlackBox answers at the address it moved to above.
    expect(shared).toMatchObject({ export: '/mnt/user/whombat-shale', nfsServer: '10.100.0.41' });
    expect(fake.backupPlaces.exports.get('blackbox/whombat-shale')).toEqual(['10.20.0.15']);
    await run('proxmox_storage_add', {
      server: 'shale',
      storage: 'blackbox-backup',
      nfs_server: shared.nfsServer,
      export: shared.export,
    });
    expect((shale.storages as Json[]).find((s) => s.id === 'blackbox-backup')).toMatchObject({ type: 'nfs' });
    // Its backups have a storage on the network now: the plan saves there.
    hostsFor(m.t.services).forget();
    const after = (await careOfferFor(m.t.services, TEST_BURROW_ID, 'shale'))?.steps.find(
      (s) => s.care === 'backup',
    );
    expect(after?.text).toContain('blackbox-backup');
    expect(after?.step).not.toContain('backup_place_nfs');
  });
});
