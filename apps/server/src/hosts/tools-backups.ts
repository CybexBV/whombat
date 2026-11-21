/**
 * The Servers tools for backups (proxmox.md PX-02, PX-03; `tools-manage.ts` has the whole picture): a server's or a
 * guest's backups and its backup jobs to read; back up now, restore over a guest or as a new one, protect, annotate
 * and delete a backup, and create, change, pause, resume, delete and run a backup job or add a guest to one.
 */
import type { HostBackupJob, HostGuest } from '@whombat/core';
import type { Adapter } from '../connections/adapters/types';
import { ConnectionArgumentError } from '../connections/request';
import { seg } from './client';
import { arr, obj, toHostBackupJob, toHostBackupVolumes, toHostManageResult } from './map';
import { checkGuestName } from './tools-guests';
import {
  type CallScope,
  call,
  changeOf,
  choicesOf,
  FOLLOWED_NOTE,
  follow,
  G,
  gb,
  idsOf,
  newGuestId,
  oneOf,
  opt,
  optBool,
  optInt,
  output,
  plainName,
  record,
  refuseSelf,
  req,
  resolveGuest,
  resolveServer,
  S,
  scope,
  send,
} from './tools-shared';
import type { ToolInverse } from './undo';
import { backupNoun, scheduleWords } from './words';

/** The guest a backup volume is of, as a hub id (`pbs:backup/vm/101/…` and `vzdump-qemu-101-…` → `pve:101`). */
export function backupGuestId(volume: string): string | null {
  const m = /backup\/(?:vm|ct)\/(\d+)\//.exec(volume) ?? /vzdump-(?:qemu|lxc)-(\d+)-/.exec(volume);
  return m ? `pve:${m[1]}` : null;
}

/** A backup job's guest lists after adding or taking out a guest (pure), or why it can't. */
export function jobWithGuest(
  job: Pick<HostBackupJob, 'selection' | 'guests' | 'exclude' | 'pool'>,
  guestId: string,
  add: boolean,
): { guests?: string[]; exclude?: string[]; unchanged?: true } | { refused: string } {
  const guests = job.guests ?? [];
  const exclude = job.exclude ?? [];
  if (job.selection === 'pool')
    return {
      refused:
        `This job backs up the pool ${job.pool ?? ''}; add or remove the guest in that pool in Proxmox.`.replace(
          '  ',
          ' ',
        ),
    };
  if (job.selection === 'guests') {
    if (add === guests.includes(guestId)) return { unchanged: true };
    return { guests: add ? [...guests, guestId] : guests.filter((g) => g !== guestId) };
  }
  if (add === !exclude.includes(guestId)) return { unchanged: true };
  return { exclude: add ? exclude.filter((g) => g !== guestId) : [...exclude, guestId] };
}

/** A server's backup jobs as the agent reads them. */
async function jobsOf(s: CallScope, serverId: string): Promise<HostBackupJob[]> {
  const raw = await s.hosts.call<unknown>({ path: `${S(serverId)}/backup-jobs`, actor: s.actor('operator') });
  return arr(obj(raw).items).map(toHostBackupJob);
}

async function jobById(s: CallScope, serverId: string, jobId: string): Promise<HostBackupJob> {
  const job = (await jobsOf(s, serverId)).find((j) => j.id === jobId);
  if (!job)
    throw new ConnectionArgumentError(
      `There’s no backup job “${jobId}” on ${serverId}. backup_jobs lists them.`,
    );
  return job;
}

/** A job's name in words: its comment, else when it runs. */
const jobName = (job: Pick<HostBackupJob, 'comment' | 'schedule'>) =>
  job.comment?.trim() ? job.comment.trim().slice(0, 60) : `${scheduleWords(job.schedule)}`;

const snakeKeep = (keep: unknown): Record<string, number> | undefined => {
  if (keep === undefined || keep === null) return undefined;
  if (typeof keep !== 'object' || Array.isArray(keep))
    throw new ConnectionArgumentError('keep: like {"last": 3, "daily": 7, "weekly": 4}.');
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(keep as Record<string, unknown>)) {
    if (!['last', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'].includes(k))
      throw new ConnectionArgumentError(`keep.${k}: last, hourly, daily, weekly, monthly or yearly.`);
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10_000)
      throw new ConnectionArgumentError(`keep.${k}: a whole number.`);
    out[k] = v;
  }
  return out;
};

/** The parts of `guest_backup` an Incus or QEMU/KVM guest's backup takes (checked by the caller). */
interface NewOnlyBackupArgs {
  backup: string | null;
  name: string | null;
  expiresDays: number | null;
  start: boolean | null;
  storage: string | null;
  compress: boolean | null;
  when: string;
}

/**
 * `guest_backup` on an Incus instance (IU-04) or a QEMU/KVM VM (IU-13): back up now (Incus with a name and an expiry,
 * libvirt optionally compressed, running or not), restore as a new guest (never over one), or delete a backup.
 * Protection and notes are Proxmox's.
 */
async function newOnlyBackup(
  s: CallScope,
  srv: { id: string; label: string },
  guest: HostGuest,
  action: string,
  args: Readonly<Record<string, unknown>>,
  a: NewOnlyBackupArgs,
) {
  const id = srv.id;
  const platform = guest.platform === 'incus' ? 'incus' : 'libvirt';
  const incus = platform === 'incus';
  const platformWords = incus ? 'Incus' : 'QEMU/KVM';
  const on = `${guest.name} on ${id}`;
  const names = { server: id, label: srv.label, guest: guest.name, platform };
  if (action === 'protect' || action === 'unprotect' || action === 'notes')
    throw new ConnectionArgumentError(
      `action: ${platformWords} backups have no ${action === 'notes' ? 'notes' : 'protection'}${incus ? '; they expire instead' : ''}.`,
    );
  if (
    args.as_new !== undefined ||
    args.id !== undefined ||
    args.mode !== undefined ||
    args.notes !== undefined
  )
    throw new ConnectionArgumentError(
      `as_new, id, mode, notes: Proxmox only; a ${platformWords} restore is always a new guest.`,
    );
  if (!incus && a.expiresDays !== null)
    throw new ConnectionArgumentError('expires_days: Incus backups only.');
  if (incus && a.compress !== null) throw new ConnectionArgumentError('compress: QEMU/KVM backups only.');
  if (action === 'create') {
    if (a.start !== null || a.storage)
      throw new ConnectionArgumentError('start, storage: for a restore, not a backup.');
    if (!incus && a.name)
      throw new ConnectionArgumentError('name: a QEMU/KVM backup is named by when it was made.');
    if (a.name && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(a.name))
      throw new ConnectionArgumentError('name: letters, digits, “.”, “_” and “-”.');
    const expires = incus
      ? new Date(s.call.services.clock().getTime() + (a.expiresDays ?? 7) * 86_400_000)
      : null;
    const r = toHostManageResult(
      await send<unknown>(s, 'operator', {
        method: 'POST',
        path: `${G(id, guest.id)}/backups`,
        body: incus
          ? { ...(a.name ? { name: a.name } : {}), expires_at: (expires as Date).toISOString() }
          : a.compress
            ? { compress: 'zstd' }
            : {},
      }),
    );
    const followed = await follow(
      s,
      'guest_backup',
      args,
      r.task?.id,
      names,
      changeOf('guest_backup', id, guest.id, `Started a backup of ${on}`, { ids: idsOf(r) }),
    );
    return output({
      accepted: true,
      ...(expires ? { expires: expires.toISOString() } : {}),
      ...(r.task ? { task: r.task.id } : {}),
      ...(followed ? { next: FOLLOWED_NOTE } : {}),
    });
  }
  if (a.expiresDays !== null || a.compress !== null)
    throw new ConnectionArgumentError('expires_days, compress: for a new backup only.');
  if (action === 'restore') {
    const name = a.name ?? `${guest.name}-restored`.slice(0, 63);
    checkGuestName(platform, name);
    const r = toHostManageResult(
      await send<unknown>(s, 'admin', {
        method: 'POST',
        path: `${S(id)}/backups/restore`,
        body: {
          platform,
          guest: guest.id,
          volume: a.backup,
          name,
          ...(a.storage ? { storage: a.storage } : {}),
          ...(a.start ? { start: true } : {}),
        },
      }),
    );
    s.hosts.forget('fleet');
    const followed = await follow(
      s,
      'guest_backup',
      args,
      r.task?.id,
      { ...names, name, backup: a.when },
      changeOf('guest_backup', id, r.newId ?? null, `Restored a copy of ${on} as ${name} from ${a.when}`, {
        ids: idsOf(r),
      }),
    );
    return output({
      accepted: true,
      ...(r.newId ? { guest: r.newId } : {}),
      ...(r.task ? { task: r.task.id } : {}),
      ...(followed ? { next: FOLLOWED_NOTE } : {}),
    });
  }
  if (a.name || a.start !== null || a.storage)
    throw new ConnectionArgumentError('name, start, storage: for a restore, not a delete.');
  const r = toHostManageResult(
    await send<unknown>(s, 'admin', {
      method: 'DELETE',
      path: `${S(id)}/backups`,
      query: { platform, guest: guest.id, volume: a.backup as string },
    }),
  );
  const followed = await follow(
    s,
    'guest_backup',
    args,
    r.task?.id,
    { ...names, backup: a.when },
    changeOf('guest_backup', id, guest.id, `Deleted ${a.when} of ${on}`, { ids: idsOf(r) }),
  );
  return output({
    done: !r.task,
    ...(r.task ? { task: r.task.id } : {}),
    ...(followed ? { next: FOLLOWED_NOTE } : {}),
  });
}

export const BACKUP_TOOLS: Adapter = {
  async guest_backups(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = opt(args, 'guest');
    return call(
      async () => {
        const { id } = await resolveServer(s, server);
        const read = async (g: { id: string; name: string }) =>
          toHostBackupVolumes(
            await s.hosts.call<unknown>({ path: `${G(id, g.id)}/backups`, actor: s.actor('operator') }),
          ).map((b) => ({ ...b, guestId: g.id, guestName: g.name }));
        let note: string | null = null;
        let list: Awaited<ReturnType<typeof read>>;
        if (guestArg) list = await read(await resolveGuest(s, id, guestArg));
        else {
          // The service lists backups per guest: every Proxmox guest's, a few at a time.
          const page = obj(
            await s.hosts.call<unknown>({
              path: `${S(id)}/guests`,
              query: { limit: 500 },
              actor: s.actor('viewer'),
            }),
          );
          const guests = arr(page.guests)
            .map(obj)
            .filter(
              (g) =>
                (g.platform === 'pve' && g.template !== true) ||
                g.platform === 'incus' ||
                g.platform === 'libvirt',
            )
            .map((g) => ({ id: String(g.id), name: String(g.name ?? g.id) }));
          if (guests.length > 40)
            note = `The backups of the first 40 of ${guests.length} guests; give a guest for the others.`;
          list = [];
          const todo = guests.slice(0, 40);
          for (let i = 0; i < todo.length; i += 4)
            for (const part of await Promise.all(todo.slice(i, i + 4).map((g) => read(g).catch(() => []))))
              list.push(...part);
        }
        list.sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
        return output({
          server: id,
          backups: list.slice(0, 100).map((b) => ({
            backup: b.volume,
            guest: b.guestId,
            name: b.guestName,
            storage: b.storage,
            ...(b.created ? { made: b.created } : {}),
            ...(gb(b.sizeBytes) !== null ? { sizeGb: gb(b.sizeBytes) } : {}),
            ...(b.notes ? { notes: b.notes } : {}),
            ...(b.protected ? { protected: true } : {}),
            ...(b.verified ? { verified: b.verified } : {}),
            ...(b.encrypted ? { encrypted: true } : {}),
            ...(b.expiresAt ? { expires: b.expiresAt } : {}),
          })),
          ...(list.length > 100 ? { more: list.length - 100 } : {}),
          ...(note ? { note } : {}),
        });
      },
      { server, ...(guestArg ? { guest: guestArg } : {}) },
    );
  },

  async backup_jobs(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    return call(
      async () => {
        const { id } = await resolveServer(s, server);
        const jobs = await jobsOf(s, id);
        return output({
          server: id,
          jobs: jobs.map((j) => ({
            id: j.id,
            on: j.enabled,
            runs: scheduleWords(j.schedule),
            schedule: j.schedule,
            storage: j.storage,
            ...(j.node ? { node: j.node } : {}),
            selection: j.selection,
            ...(j.guests?.length ? { guests: j.guests } : {}),
            ...(j.exclude?.length ? { exclude: j.exclude } : {}),
            ...(j.pool ? { pool: j.pool } : {}),
            mode: j.mode,
            // All counts 0 keeps every backup; none set, the storage's own retention.
            keeps: !j.keep
              ? 'what the storage keeps'
              : Object.values(j.keep).every((n) => !n)
                ? 'every backup'
                : j.keep,
            ...(j.comment ? { comment: j.comment } : {}),
            ...(j.nextRun ? { nextRun: j.nextRun } : {}),
          })),
        });
      },
      { server },
    );
  },

  async guest_backup(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const action = oneOf(args, 'action', [
      'create',
      'restore',
      'protect',
      'unprotect',
      'notes',
      'delete',
    ] as const);
    const guestArg = opt(args, 'guest');
    const backup = action === 'create' ? null : req(args, 'backup');
    // A Proxmox volume (`pbs-01:backup/vm/101/…`) or an Incus backup's name (`whombat-20261016-0200`).
    if (backup && (backup.length > 500 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*(:\S+)?$/.test(backup)))
      throw new ConnectionArgumentError(
        'backup: the volume as guest_backups lists it (pbs-01:backup/vm/101/…, or an Incus backup’s name).',
      );
    const name = opt(args, 'name');
    const expiresDays = optInt(args, 'expires_days', 1, 3650);
    const start = optBool(args, 'start');
    const compress = optBool(args, 'compress');
    const storage = plainName(args, 'storage');
    const mode = opt(args, 'mode');
    if (mode && !['snapshot', 'suspend', 'stop'].includes(mode))
      throw new ConnectionArgumentError('mode: snapshot, suspend or stop.');
    const notes = opt(args, 'notes');
    if (notes && notes.length > 1024) throw new ConnectionArgumentError('notes: at most 1024 characters.');
    if (action === 'notes' && notes === null && args.notes !== '')
      throw new ConnectionArgumentError('notes: the backup’s new notes ("" to clear them).');
    const asNew = optBool(args, 'as_new') === true;
    const newId = newGuestId(args);
    if (action === 'create' && !guestArg) throw new ConnectionArgumentError('guest: the guest to back up.');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const { id } = srv;
        // The guest: the one named, else the one the backup is of (it restores over that one unless as_new).
        const guestRef = guestArg ?? (backup ? backupGuestId(backup) : null);
        const guest = guestRef
          ? await resolveGuest(s, id, guestRef).catch((err: unknown) => {
              if (action === 'restore' && asNew && !guestArg) return null;
              throw err;
            })
          : null;
        const gname = guest?.name ?? 'a guest';
        const when = backupNoun(backup, s.call.services.clock());
        if (!guest && (srv.kind === 'incus' || srv.kind === 'libvirt'))
          throw new ConnectionArgumentError(
            'guest: the guest whose backup it is (guest_backups lists them).',
          );
        if (guest?.platform === 'incus' || guest?.platform === 'libvirt')
          return newOnlyBackup(s, srv, guest, action, args, {
            backup,
            name,
            expiresDays,
            start,
            storage,
            compress,
            when,
          });
        if (name !== null || expiresDays !== null || compress !== null)
          throw new ConnectionArgumentError('name, expires_days, compress: Incus and QEMU/KVM backups only.');
        if (action === 'restore') refuseSelf(guest, { op: 'backup.restore', asNew });
        switch (action) {
          case 'create': {
            const target =
              storage ?? (await choicesOf(s, id)).storages.find((st) => st.content.includes('backup'))?.id;
            if (!target)
              throw new ConnectionArgumentError('storage: this server has no storage for backups; give one.');
            const r = toHostManageResult(
              await send<unknown>(s, 'operator', {
                method: 'POST',
                path: `${G(id, (guest as HostGuest).id)}/backups`,
                body: { storage: target, ...(mode ? { mode } : {}), ...(notes ? { notes } : {}) },
              }),
            );
            const followed = await follow(
              s,
              'guest_backup',
              args,
              r.task?.id,
              { server: id, guest: gname },
              changeOf('guest_backup', id, guest?.id ?? null, `Started a backup of ${gname} on ${id}`, {
                ids: idsOf(r),
              }),
            );
            return output({
              accepted: true,
              storage: target,
              ...(r.task ? { task: r.task.id } : {}),
              ...(followed ? { next: FOLLOWED_NOTE } : {}),
            });
          }
          case 'restore': {
            if (!asNew && !guest)
              throw new ConnectionArgumentError('guest: the guest to restore over (or as_new true).');
            if (!asNew && newId)
              throw new ConnectionArgumentError('id: only a restore as_new takes a new id.');
            const r = toHostManageResult(
              await send<unknown>(s, 'admin', {
                method: 'POST',
                path: `${S(id)}/backups/restore`,
                body: {
                  platform: 'pve',
                  volume: backup,
                  ...(asNew
                    ? { ...(newId ? { new_id: newId } : {}), unique: true }
                    : { guest: (guest as HostGuest).id, confirm: true }),
                  ...(storage ? { storage } : {}),
                  ...(start ? { start: true } : {}),
                },
              }),
            );
            s.hosts.forget('fleet');
            const title = asNew
              ? `Restored a copy of ${gname} on ${id} from ${when}`
              : `Restored ${gname} on ${id} from ${when}`;
            const followed = await follow(
              s,
              'guest_backup',
              args,
              r.task?.id,
              {
                server: id,
                guest: gname,
                backup: when,
              },
              changeOf('guest_backup', id, asNew ? (r.newId ?? null) : (guest?.id ?? null), title, {
                ids: idsOf(r),
              }),
            );
            return output({
              accepted: true,
              ...(r.newId ? { guest: r.newId } : {}),
              ...(r.task ? { task: r.task.id } : {}),
              ...(followed ? { next: FOLLOWED_NOTE } : {}),
            });
          }
          case 'protect':
          case 'unprotect':
          case 'notes': {
            let before: string | null = null;
            if (action === 'notes' && guest) {
              const list = toHostBackupVolumes(
                await s.hosts.call<unknown>({
                  path: `${G(id, guest.id)}/backups`,
                  actor: s.actor('operator'),
                }),
              );
              before = list.find((b) => b.volume === backup)?.notes ?? '';
            }
            const r = toHostManageResult(
              await send<unknown>(s, 'operator', {
                method: 'PATCH',
                path: `${S(id)}/backups`,
                body: {
                  platform: 'pve',
                  volume: backup,
                  ...(action === 'notes' ? { notes: notes ?? '' } : { protected: action === 'protect' }),
                },
              }),
            );
            const of = guest ? ` of ${gname} on ${id}` : ` on ${id}`;
            const title =
              action === 'protect'
                ? `Protected ${when}${of}`
                : action === 'unprotect'
                  ? `Stopped protecting ${when}${of}`
                  : `Changed the notes of ${when}${of}`;
            const base = { server: id, backup, ...(guest ? { guest: guest.id } : {}) };
            const inverse: ToolInverse | null =
              action === 'notes'
                ? before !== null && guest
                  ? {
                      tool: 'guest_backup',
                      args: { ...base, action: 'notes', notes: before },
                      serverId: id,
                      expect: {
                        backupNotes: { guestId: guest.id, volume: backup as string, notes: notes ?? '' },
                      },
                    }
                  : null
                : {
                    tool: 'guest_backup',
                    args: { ...base, action: action === 'protect' ? 'unprotect' : 'protect' },
                    serverId: id,
                  };
            await record(
              s,
              changeOf('guest_backup', id, guest?.id ?? null, title, { ids: idsOf(r), inverse }),
            );
            return output({ done: true });
          }
          default: {
            const r = toHostManageResult(
              await send<unknown>(s, 'admin', {
                method: 'DELETE',
                path: `${S(id)}/backups`,
                query: { platform: 'pve', volume: backup as string },
              }),
            );
            const followed = await follow(
              s,
              'guest_backup',
              args,
              r.task?.id,
              {
                server: id,
                guest: gname,
                backup: when,
              },
              changeOf(
                'guest_backup',
                id,
                guest?.id ?? null,
                `Deleted ${when}${guest ? ` of ${gname}` : ''} on ${id}`,
                { ids: idsOf(r) },
              ),
            );
            return output({
              done: !r.task,
              ...(r.task ? { task: r.task.id } : {}),
              ...(followed ? { next: FOLLOWED_NOTE } : {}),
            });
          }
        }
      },
      { server, ...(guestArg ? { guest: guestArg } : {}) },
    );
  },

  async backup_job_set(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const action = oneOf(args, 'action', [
      'create',
      'update',
      'pause',
      'resume',
      'delete',
      'run',
      'add_guest',
      'remove_guest',
    ] as const);
    const jobId = action === 'create' ? null : req(args, 'job');
    if (jobId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(jobId))
      throw new ConnectionArgumentError('job: the job’s id as backup_jobs lists it.');
    const guestArg = opt(args, 'guest');
    if ((action === 'add_guest' || action === 'remove_guest') && !guestArg)
      throw new ConnectionArgumentError('guest: the guest to add or take out.');
    const schedule = opt(args, 'schedule');
    if (schedule && !/^[A-Za-z0-9 :,.*/~-]{1,128}$/.test(schedule))
      throw new ConnectionArgumentError(
        'schedule: in Proxmox’s words, like 04:00, sat 02:00 or mon..fri 21:30.',
      );
    const storage = plainName(args, 'storage');
    const mode = opt(args, 'mode');
    if (mode && !['snapshot', 'suspend', 'stop'].includes(mode))
      throw new ConnectionArgumentError('mode: snapshot, suspend or stop.');
    const keep = snakeKeep(args.keep);
    const selection = opt(args, 'selection');
    if (selection && !['all', 'guests', 'pool'].includes(selection))
      throw new ConnectionArgumentError('selection: all, guests or pool.');
    const pool = opt(args, 'pool');
    const comment = opt(args, 'comment');
    if (comment && (comment.length > 500 || /[\r\n]/.test(comment)))
      throw new ConnectionArgumentError('comment: one line, at most 500 characters.');
    const fields = {
      ...(schedule ? { schedule } : {}),
      ...(storage ? { storage } : {}),
      ...(mode ? { mode } : {}),
      ...(keep ? { keep } : {}),
      ...(selection ? { selection } : {}),
      ...(pool ? { pool } : {}),
      ...(comment ? { comment } : {}),
    };
    return call(
      async () => {
        const { id } = await resolveServer(s, server);
        const path = jobId ? `${S(id)}/backup-jobs/${seg(jobId)}` : `${S(id)}/backup-jobs`;
        const guest = guestArg ? await resolveGuest(s, id, guestArg) : null;
        if (action === 'create') {
          if (!schedule)
            throw new ConnectionArgumentError('schedule: when it runs, like 04:00 or sat 02:00.');
          const target =
            storage ?? (await choicesOf(s, id)).storages.find((st) => st.content.includes('backup'))?.id;
          if (!target)
            throw new ConnectionArgumentError('storage: this server has no storage for backups; give one.');
          const sel = selection ?? (guest ? 'guests' : 'all');
          if (sel === 'guests' && !guest)
            throw new ConnectionArgumentError('guest: its first guest, for selection guests.');
          if (sel === 'pool' && !pool) throw new ConnectionArgumentError('pool: the pool it backs up.');
          const r = toHostManageResult(
            await send<unknown>(s, 'admin', {
              method: 'POST',
              path,
              body: {
                enabled: true,
                ...fields,
                storage: target,
                selection: sel,
                ...(sel === 'guests' && guest ? { guests: [guest.id] } : {}),
              },
            }),
          );
          s.hosts.forget('fleet');
          await record(
            s,
            changeOf(
              'backup_job',
              id,
              guest?.id ?? null,
              `Added a backup job on ${id} that runs ${scheduleWords(schedule)}`,
              {
                ids: { ...idsOf(r), ...(r.newId ? { jobId: r.newId } : {}) },
              },
            ),
          );
          return output({ done: true, ...(r.newId ? { job: r.newId } : {}) });
        }
        const job = await jobById(s, id, jobId as string);
        const name = jobName(job);
        const put = async (body: Record<string, unknown>) =>
          toHostManageResult(
            await send<unknown>(s, 'admin', {
              method: 'PUT',
              path,
              body: { ...body, ...(job.digest ? { digest: job.digest } : {}) },
            }),
          );
        switch (action) {
          case 'update': {
            if (Object.keys(fields).length === 0)
              throw new ConnectionArgumentError(
                'Nothing to change: give schedule, storage, mode, keep, selection, pool or comment.',
              );
            const r = await put(fields);
            s.hosts.forget('fleet');
            await record(
              s,
              changeOf('backup_job', id, null, `Changed the backup job “${name}” on ${id}`, {
                ids: { ...idsOf(r), jobId: job.id },
                detail: (r.changes ?? [])
                  .map((c) => `${c.key}: ${c.old ?? '—'} → ${c.new ?? '—'}`)
                  .join('\n'),
              }),
            );
            return output({ done: true, changes: r.changes ?? [] });
          }
          case 'pause':
          case 'resume': {
            const enabled = action === 'resume';
            if (job.enabled === enabled)
              return output({ done: true, note: `It was already ${enabled ? 'on' : 'paused'}.` });
            const r = await put({ enabled });
            s.hosts.forget('fleet');
            await record(
              s,
              changeOf(
                'backup_job',
                id,
                null,
                `${enabled ? 'Resumed' : 'Paused'} the backup job “${name}” on ${id}`,
                {
                  ids: { ...idsOf(r), jobId: job.id },
                  inverse: {
                    tool: 'backup_job_set',
                    args: { server: id, action: enabled ? 'pause' : 'resume', job: job.id },
                    serverId: id,
                  },
                },
              ),
            );
            return output({ done: true });
          }
          case 'delete': {
            const r = toHostManageResult(
              await send<unknown>(s, 'admin', { method: 'DELETE', path, query: { confirm: '1' } }),
            );
            s.hosts.forget('fleet');
            await record(
              s,
              changeOf('backup_job', id, null, `Deleted the backup job “${name}” on ${id}`, {
                ids: { ...idsOf(r), jobId: job.id },
              }),
            );
            return output({ done: true });
          }
          case 'run': {
            const r = toHostManageResult(
              await send<unknown>(s, 'operator', { method: 'POST', path: `${path}/run`, body: {} }),
            );
            const followed = await follow(
              s,
              'backup_job_set',
              args,
              r.task?.id,
              {
                server: id,
                name: job.comment?.trim() || null,
              },
              changeOf('backup_job', id, null, `Started the backup job “${name}” on ${id}`, {
                ids: { ...idsOf(r), jobId: job.id },
              }),
            );
            return output({
              accepted: true,
              ...(r.task ? { task: r.task.id } : {}),
              ...(followed ? { next: FOLLOWED_NOTE } : {}),
            });
          }
          default: {
            const add = action === 'add_guest';
            const g = guest as HostGuest;
            const next = jobWithGuest(job, g.id, add);
            if ('refused' in next) throw new ConnectionArgumentError(next.refused);
            if (next.unchanged)
              return output({ done: true, note: `${g.name} was already ${add ? 'in' : 'out of'} that job.` });
            const r = await put(next.guests ? { guests: next.guests } : { exclude: next.exclude });
            s.hosts.forget('fleet');
            await record(
              s,
              changeOf(
                'backup_job',
                id,
                g.id,
                add
                  ? `Added ${g.name} to the backup job “${name}” on ${id}`
                  : `Took ${g.name} out of the backup job “${name}” on ${id}`,
                {
                  ids: { ...idsOf(r), jobId: job.id },
                  inverse: {
                    tool: 'backup_job_set',
                    args: {
                      server: id,
                      action: add ? 'remove_guest' : 'add_guest',
                      job: job.id,
                      guest: g.id,
                    },
                    serverId: id,
                  },
                },
              ),
            );
            return output({ done: true });
          }
        }
      },
      { server, ...(guestArg ? { guest: guestArg } : {}) },
    );
  },
};
