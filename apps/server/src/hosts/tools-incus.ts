/**
 * The Servers tools for an Incus host's own things (incus-unraid.md IU-04; contracts 0.83.0, CT-366): its projects,
 * pools, networks, profiles, images and custom volumes, a profile whole, a network's leases and an instance's log to
 * read; rename, move and publish an instance, download, refresh and delete images, create, change and delete profiles,
 * create, grow and delete custom volumes to change. As everywhere (`tools-manage.ts`): the role each route needs, the
 * guest this Whombat runs in refused before the hub is asked (IU-02), every change recorded, long work followed (IU-07).
 */
import { HOST_LOG_LINES_DEFAULT, HOST_LOG_LINES_MAX, type HostGuest } from '@whombat/core';
import type { Adapter } from '../connections/adapters/types';
import { ConnectionArgumentError } from '../connections/request';
import { networksOf, poolsOf, seg } from './client';
import {
  toHostGuestLog,
  toHostIncusProfile,
  toHostManageResult,
  toHostNetworkLeases,
  toHostServerDetail,
} from './map';
import { checkGuestName } from './tools-guests';
import {
  type CallScope,
  call,
  changeOf,
  FOLLOWED_NOTE,
  follow,
  G,
  gb,
  idsOf,
  incusDevices,
  oneOf,
  opt,
  optInt,
  optStrList,
  optStrMap,
  output,
  plainName,
  type ResolvedServer,
  record,
  refuseSelf,
  req,
  resolveGuest,
  resolveServer,
  S,
  scope,
  send,
  serverDetailRaw,
  wrongKind,
} from './tools-shared';

const pct = (used: number | null, total: number | null) =>
  used !== null && total ? Math.round((used / total) * 100) : null;

/** An Incus instance or a QEMU/KVM VM the call named (rename and the log work on both, 0.84), or the refusal. */
async function vmOrInstance(s: CallScope, srv: ResolvedServer, raw: string): Promise<HostGuest> {
  const guest = await resolveGuest(s, srv.id, raw);
  if (guest.platform !== 'incus' && guest.platform !== 'libvirt')
    throw new ConnectionArgumentError(
      `guest: ${guest.name} isn’t an Incus instance or a QEMU/KVM VM; this tool works on those.`,
    );
  return guest;
}

/**
 * Whose pool or network a name is (IU-S16): an Incus host's or libvirt's, from the server's detail — a server can run
 * both (basalt) — else the server's kind decides.
 */
async function incusOrLibvirt(
  s: CallScope,
  srv: ResolvedServer,
  what: 'pools' | 'networks',
  name: string,
): Promise<'incus' | 'libvirt'> {
  const d = toHostServerDetail(await serverDetailRaw(s, srv.id), [], null, s.call.services.clock());
  if (d.incus?.[what].some((x) => x.name === name)) return 'incus';
  if (d.libvirt?.[what].some((x) => x.name === name)) return 'libvirt';
  return srv.kind === 'incus' || (d.incus && !d.libvirt) ? 'incus' : 'libvirt';
}

/** An Incus guest the call named on an Incus server, or the refusal of another kind. */
async function incusGuest(s: CallScope, srv: ResolvedServer, raw: string): Promise<HostGuest> {
  const guest = await resolveGuest(s, srv.id, raw);
  if (guest.platform !== 'incus')
    throw new ConnectionArgumentError(
      `guest: ${guest.name} isn’t an Incus instance; this tool works on those.`,
    );
  return guest;
}

/** A project's name as Incus takes it, or null. */
const projectOf = (args: Readonly<Record<string, unknown>>) => plainName(args, 'project');

export const INCUS_TOOLS: Adapter = {
  async incus_overview(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const d = toHostServerDetail(await serverDetailRaw(s, srv.id), [], null, s.call.services.clock());
        const i = d.incus;
        if (!i) return wrongKind(srv, 'Incus');
        return output({
          server: srv.id,
          version: i.version,
          ...(i.clustered ? { clustered: true } : {}),
          projects: i.projects,
          pools: i.pools.map((p) => ({
            name: p.name,
            driver: p.driver,
            ...(p.status && p.status !== 'Created' ? { status: p.status } : {}),
            usedGb: gb(p.usedBytes),
            sizeGb: gb(p.totalBytes),
            usedPct: pct(p.usedBytes, p.totalBytes),
            volumes: p.volumes,
          })),
          networks: i.networks.map((n) => ({
            name: n.name,
            type: n.type,
            managed: n.managed,
            ...(n.ipv4 ? { ipv4: n.ipv4 } : {}),
            ...(n.ipv6 ? { ipv6: n.ipv6 } : {}),
            usedBy: n.usedBy,
          })),
          profiles: i.profiles,
          images: i.images.map((m) => ({
            image: m.fingerprint,
            aliases: m.aliases,
            type: m.type,
            ...(m.description ? { description: m.description } : {}),
            sizeMb: Math.round(m.sizeBytes / 1048576),
            project: m.project,
            ...(m.cached ? { cached: true } : {}),
          })),
          volumes: i.volumes.map((v) => ({
            pool: v.pool,
            volume: v.name,
            project: v.project,
            contentType: v.contentType,
            sizeGb: gb(v.sizeBytes),
            usedBy: v.usedBy,
          })),
        });
      },
      { server },
    );
  },

  async incus_profile(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const profile = plainName(args, 'profile', true);
    const project = projectOf(args);
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const p = toHostIncusProfile(
          await s.hosts.call<unknown>({
            path: `${S(srv.id)}/incus/profiles/${seg(profile)}`,
            query: { project: project ?? undefined },
            actor: s.actor('operator'),
          }),
        );
        return output({
          server: srv.id,
          profile: p.name,
          project: p.project,
          ...(p.description ? { description: p.description } : {}),
          digest: p.digest,
          config: p.config,
          devices: p.devices,
          usedBy: p.usedBy,
          ...(p.restricted.length ? { notChangeableHere: p.restricted } : {}),
        });
      },
      { server },
    );
  },

  async network_leases(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const network = plainName(args, 'network', true);
    const project = projectOf(args);
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const platform = await incusOrLibvirt(s, srv, 'networks', network);
        if (project && platform !== 'incus')
          throw new ConnectionArgumentError('project: Incus networks only.');
        const leases = toHostNetworkLeases(
          await s.hosts.call<unknown>({
            path: `${networksOf(srv.id, platform)}/${seg(network)}/leases`,
            query: { project: project ?? undefined },
            actor: s.actor('operator'),
          }),
        );
        return output({
          server: srv.id,
          network,
          leases: leases.slice(0, 300).map((l) => ({
            hostname: l.hostname,
            address: l.address,
            mac: l.hwaddr,
            type: l.type,
            ...(l.guestId ? { guest: l.guestId } : {}),
          })),
          ...(leases.length > 300 ? { more: leases.length - 300 } : {}),
        });
      },
      { server },
    );
  },

  async guest_log(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const lines = optInt(args, 'lines', 1, HOST_LOG_LINES_MAX) ?? HOST_LOG_LINES_DEFAULT;
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const guest = await vmOrInstance(s, srv, guestArg);
        const log = toHostGuestLog(
          await s.hosts.call<unknown>({
            path: `${G(srv.id, guest.id)}/log`,
            query: { lines },
            actor: s.actor('operator'),
          }),
        );
        return output({
          server: srv.id,
          guest: guest.id,
          name: guest.name,
          file: log.file,
          lines: log.lines,
        });
      },
      { server, guest: guestArg },
    );
  },

  async guest_rename(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const name = req(args, 'name');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const id = srv.id;
        const guest = await vmOrInstance(s, srv, guestArg);
        checkGuestName(guest.platform as 'incus' | 'libvirt', name);
        refuseSelf(guest, { op: 'guest.rename' });
        const r = toHostManageResult(
          await send<unknown>(s, 'admin', {
            method: 'POST',
            path: `${G(id, guest.id)}/rename`,
            body: { name },
          }),
        );
        s.hosts.forget('fleet');
        const newId = r.newId ?? guest.id.replace(/[^:/]+$/, name);
        // Renaming back is the inverse; the id changed with the name.
        const followed = await follow(
          s,
          'guest_rename',
          args,
          r.task?.id,
          {
            server: id,
            label: srv.label,
            guest: guest.name,
            name,
          },
          changeOf('guest_rename', id, newId, `Renamed ${guest.name} on ${id} to ${name}`, {
            ids: idsOf(r),
            inverse: {
              tool: 'guest_rename',
              args: { server: id, guest: newId, name: guest.name },
              serverId: id,
            },
          }),
        );
        return output({
          accepted: true,
          guest: newId,
          ...(r.task ? { task: r.task.id } : {}),
          ...(followed ? { next: FOLLOWED_NOTE } : {}),
        });
      },
      { server, guest: guestArg },
    );
  },

  async guest_move(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const pool = plainName(args, 'pool');
    const project = projectOf(args);
    if (!pool && !project)
      throw new ConnectionArgumentError('pool, project: where to move it (one or both).');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const id = srv.id;
        const guest = await incusGuest(s, srv, guestArg);
        refuseSelf(guest, { op: 'guest.move' });
        // The approval already happened (guest_move always asks); the service still wants the confirmation.
        const r = toHostManageResult(
          await send<unknown>(s, 'admin', {
            method: 'POST',
            path: `${G(id, guest.id)}/move`,
            body: { ...(pool ? { pool } : {}), ...(project ? { project } : {}), confirm: true },
          }),
        );
        s.hosts.forget('fleet');
        const where = [pool && `the pool ${pool}`, project && `the project ${project}`]
          .filter(Boolean)
          .join(' and ');
        const followed = await follow(
          s,
          'guest_move',
          args,
          r.task?.id,
          {
            server: id,
            label: srv.label,
            guest: guest.name,
          },
          changeOf('guest_move', id, r.newId ?? guest.id, `Moved ${guest.name} on ${id} to ${where}`, {
            ids: idsOf(r),
          }),
        );
        return output({
          accepted: true,
          ...(r.newId ? { guest: r.newId } : {}),
          ...(r.task ? { task: r.task.id } : {}),
          ...(followed ? { next: FOLLOWED_NOTE } : {}),
        });
      },
      { server, guest: guestArg },
    );
  },

  async guest_publish(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const alias = opt(args, 'alias');
    if (alias && !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,99}$/.test(alias))
      throw new ConnectionArgumentError('alias: letters, digits, “.”, “_”, “/” and “-”.');
    const description = opt(args, 'description');
    if (description && (description.length > 500 || /[\r\n]/.test(description)))
      throw new ConnectionArgumentError('description: one line, at most 500 characters.');
    const snapshot = opt(args, 'snapshot');
    if (snapshot && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(snapshot))
      throw new ConnectionArgumentError('snapshot: its name as guest_snapshots lists it.');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const id = srv.id;
        const guest = await incusGuest(s, srv, guestArg);
        refuseSelf(guest, { op: 'guest.publish' });
        const r = toHostManageResult(
          await send<unknown>(s, 'admin', {
            method: 'POST',
            path: `${G(id, guest.id)}/publish`,
            body: {
              ...(alias ? { alias } : {}),
              ...(description ? { description } : {}),
              ...(snapshot ? { snapshot } : {}),
            },
          }),
        );
        const followed = await follow(
          s,
          'guest_publish',
          args,
          r.task?.id,
          {
            server: id,
            label: srv.label,
            guest: guest.name,
          },
          changeOf('guest_publish', id, guest.id, `Made an image of ${guest.name} on ${id}`, {
            ids: idsOf(r),
          }),
        );
        return output({
          accepted: true,
          ...(r.newId ? { image: r.newId } : {}),
          ...(r.task ? { task: r.task.id } : {}),
          ...(followed ? { next: FOLLOWED_NOTE } : {}),
        });
      },
      { server, guest: guestArg },
    );
  },

  async incus_image(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const action = oneOf(args, 'action', ['download', 'refresh', 'delete'] as const);
    const project = projectOf(args);
    const alias = action === 'download' ? req(args, 'alias') : null;
    if (alias && !/^(images:)?[A-Za-z0-9][A-Za-z0-9_./-]{0,99}$/.test(alias))
      throw new ConnectionArgumentError('alias: an image of the images server, like debian/13.');
    const type = opt(args, 'type') ?? 'container';
    if (!['container', 'virtual-machine'].includes(type))
      throw new ConnectionArgumentError('type: container or virtual-machine.');
    const image = action === 'download' ? null : req(args, 'image');
    if (image && !/^[0-9a-f]{4,64}$/.test(image))
      throw new ConnectionArgumentError('image: its fingerprint as incus_overview lists it.');
    if (action !== 'download' && (args.alias !== undefined || args.type !== undefined))
      throw new ConnectionArgumentError('alias, type: for a download.');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const id = srv.id;
        const names = { server: id, label: srv.label };
        if (action === 'download') {
          const r = toHostManageResult(
            await send<unknown>(s, 'admin', {
              method: 'POST',
              path: `${S(id)}/incus/images`,
              body: {
                alias: (alias as string).replace(/^images:/, ''),
                type,
                ...(project ? { project } : {}),
              },
            }),
          );
          const followed = await follow(
            s,
            'incus_image',
            args,
            r.task?.id,
            names,
            changeOf('incus_image', id, null, `Started downloading the image ${alias} to ${id}`, {
              ids: idsOf(r),
            }),
          );
          return output({
            accepted: true,
            ...(r.newId ? { image: r.newId } : {}),
            ...(r.task ? { task: r.task.id } : {}),
            ...(followed ? { next: FOLLOWED_NOTE } : {}),
          });
        }
        const path = `${S(id)}/incus/images/${seg(image as string)}`;
        const r = toHostManageResult(
          action === 'refresh'
            ? await send<unknown>(s, 'operator', {
                method: 'POST',
                path: `${path}/refresh`,
                body: project ? { project } : {},
              })
            : await send<unknown>(s, 'admin', {
                method: 'DELETE',
                path,
                ...(project ? { query: { project } } : {}),
              }),
        );
        const followed = await follow(
          s,
          'incus_image',
          args,
          r.task?.id,
          names,
          changeOf(
            'incus_image',
            id,
            null,
            action === 'refresh' ? `Refreshed an image on ${id}` : `Deleted an image on ${id}`,
            { ids: idsOf(r) },
          ),
        );
        return output({
          done: !r.task,
          ...(r.task ? { task: r.task.id } : {}),
          ...(followed ? { next: FOLLOWED_NOTE } : {}),
        });
      },
      { server },
    );
  },

  async incus_profile_set(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const action = oneOf(args, 'action', ['create', 'update', 'delete'] as const);
    const profile = plainName(args, 'profile', true);
    const project = projectOf(args);
    const description = opt(args, 'description');
    if (description && (description.length > 500 || /[\r\n]/.test(description)))
      throw new ConnectionArgumentError('description: one line, at most 500 characters.');
    const copyFrom = plainName(args, 'copy_from');
    const set = optStrMap(args, 'set');
    const del = optStrList(args, 'delete', 100);
    const devices = incusDevices(args.devices);
    const digest = opt(args, 'digest');
    const only = (allowed: readonly string[]) => {
      const extra = ['digest', 'set', 'delete', 'devices', 'description', 'copy_from'].filter(
        (k) => !allowed.includes(k) && args[k] !== undefined && args[k] !== null,
      );
      if (extra.length) throw new ConnectionArgumentError(`${extra.join(', ')}: not for ${action}.`);
    };
    if (action === 'create') only(['description', 'copy_from']);
    if (action === 'delete') only([]);
    if (action === 'update') {
      only(['digest', 'set', 'delete', 'devices', 'description']);
      if (!digest) throw new ConnectionArgumentError('digest: the one incus_profile gave.');
      if (!set && !del?.length && !devices && description === null)
        throw new ConnectionArgumentError('Nothing to change: give set, delete, devices or description.');
    }
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const id = srv.id;
        const path = `${S(id)}/incus/profiles/${seg(profile)}`;
        let title: string;
        let r: ReturnType<typeof toHostManageResult>;
        if (action === 'create') {
          r = toHostManageResult(
            await send<unknown>(s, 'admin', {
              method: 'POST',
              path: `${S(id)}/incus/profiles`,
              body: {
                name: profile,
                ...(description ? { description } : {}),
                ...(copyFrom ? { copy_from: copyFrom } : {}),
                ...(project ? { project } : {}),
              },
            }),
          );
          title = `Added the profile ${profile} on ${id}`;
        } else if (action === 'update') {
          r = toHostManageResult(
            await send<unknown>(s, 'admin', {
              method: 'PUT',
              path,
              body: {
                digest,
                ...(project ? { project } : {}),
                ...(set ? { set } : {}),
                ...(del?.length ? { delete: del } : {}),
                ...(devices ? { devices } : {}),
                ...(description !== null ? { description } : {}),
              },
            }),
          );
          title = `Changed the profile ${profile} on ${id}`;
        } else {
          r = toHostManageResult(
            await send<unknown>(s, 'admin', {
              method: 'DELETE',
              path,
              query: { ...(project ? { project } : {}), confirm: '1' },
            }),
          );
          title = `Deleted the profile ${profile} on ${id}`;
        }
        await record(
          s,
          changeOf('incus_profile', id, null, title, {
            ids: idsOf(r),
            detail: (r.changes ?? []).map((c) => `${c.key}: ${c.old ?? '—'} → ${c.new ?? '—'}`).join('\n'),
          }),
        );
        return output({ done: true, ...(r.changes?.length ? { changes: r.changes } : {}) });
      },
      { server },
    );
  },

  async storage_volume(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const action = oneOf(args, 'action', ['create', 'resize', 'delete'] as const);
    const pool = plainName(args, 'pool', true);
    const volume = plainName(args, 'volume', true);
    const project = projectOf(args);
    const size = action === 'delete' ? null : req(args, 'size');
    if (size && !/^\d+(\.\d+)?\s?(B|[KMGTP]i?B)$/.test(size))
      throw new ConnectionArgumentError('size: like 10GiB or 500MiB.');
    const contentType = opt(args, 'content_type');
    if (contentType && (action !== 'create' || !['filesystem', 'block'].includes(contentType)))
      throw new ConnectionArgumentError('content_type: filesystem or block, when creating one.');
    if (action === 'delete' && args.size !== undefined)
      throw new ConnectionArgumentError('size: not for delete.');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const id = srv.id;
        // An Incus pool's custom volume or a libvirt pool's volume (0.84): the pool says whose.
        const platform = await incusOrLibvirt(s, srv, 'pools', pool);
        if (platform === 'libvirt' && (contentType || project))
          throw new ConnectionArgumentError('content_type, project: Incus volumes only.');
        const base = `${poolsOf(id, platform)}/${seg(pool)}/volumes`;
        let r: ReturnType<typeof toHostManageResult>;
        let title: string;
        if (action === 'create') {
          r = toHostManageResult(
            await send<unknown>(s, 'admin', {
              method: 'POST',
              path: base,
              body: {
                name: volume,
                size,
                ...(contentType ? { content_type: contentType } : {}),
                ...(project ? { project } : {}),
              },
            }),
          );
          title = `Added the volume ${volume} to ${pool} on ${id}`;
        } else if (action === 'resize') {
          r = toHostManageResult(
            await send<unknown>(s, 'operator', {
              method: 'POST',
              path: `${base}/${seg(volume)}/resize`,
              body: { size, ...(project ? { project } : {}) },
            }),
          );
          title = `Grew the volume ${volume} on ${id} to ${size}`;
        } else {
          r = toHostManageResult(
            await send<unknown>(s, 'admin', {
              method: 'DELETE',
              path: `${base}/${seg(volume)}`,
              query: { ...(project ? { project } : {}), confirm: '1' },
            }),
          );
          title = `Deleted the volume ${volume} on ${id}`;
        }
        await record(s, changeOf('storage_volume', id, null, title, { ids: idsOf(r) }));
        return output({
          done: true,
          ...(action === 'create'
            ? {
                next:
                  platform === 'incus'
                    ? 'Attach it with guest_config_set’s devices.'
                    : `Attach it with guest_config_set: a disk key set to source=${pool}/${volume}.`,
              }
            : {}),
        });
      },
      { server },
    );
  },
};
