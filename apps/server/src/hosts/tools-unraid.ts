/**
 * The Servers tools for an unRAID server (incus-unraid.md IU-05; contracts 0.83.0, CT-366): its array, parity, disks,
 * pools, shares, plugins and notifications to read; the array, parity, spinning disks, the mover, archiving
 * notifications, plugin updates and checks, container updates from their templates and checks, and autostart (Docker
 * on unRAID, libvirt anywhere) to change. Each unRAID command is a task on the server (`unraid:<16 hex>`); the long ones
 * are followed and end with one message (IU-07: “The parity check on BlackBox is done. No errors.”).
 */
import type { HostGuest } from '@whombat/core';
import type { Adapter } from '../connections/adapters/types';
import { ConnectionArgumentError } from '../connections/request';
import { seg } from './client';
import { toHostManageResult, toHostServerDetail } from './map';
import {
  type CallScope,
  call,
  changeOf,
  FOLLOWED_NOTE,
  follow,
  G,
  gb,
  idsOf,
  oneOf,
  opt,
  optBool,
  output,
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

const pct = (used: number | null, size: number) =>
  used !== null && size > 0 ? Math.round((used / size) * 100) : null;

/** The server's detail mapped (its unRAID part and its guests). */
async function detailOf(s: CallScope, srv: ResolvedServer) {
  return toHostServerDetail(await serverDetailRaw(s, srv.id), [], null, s.call.services.clock());
}

/** A Docker guest of an unRAID server, for `container_update`. */
async function unraidContainer(s: CallScope, srv: ResolvedServer, raw: string): Promise<HostGuest> {
  const guest = await resolveGuest(s, srv.id, raw);
  if (guest.platform !== 'docker')
    throw new ConnectionArgumentError(`guest: ${guest.name} isn’t a Docker container.`);
  if (guest.template === false)
    throw new ConnectionArgumentError(
      `guest: ${guest.name} has no template in Unraid, so Whombat can’t update it; update it in Unraid.`,
    );
  return guest;
}

/** The unRAID array actions: the service's route, the role it needs, whether it is followed to its end. */
const ARRAY_ACTIONS = {
  start: { path: 'array/start', role: 'admin', follow: true },
  stop: { path: 'array/stop', role: 'admin', follow: true },
  parity_check: { path: 'parity/start', role: 'operator', follow: true },
  parity_pause: { path: 'parity/pause', role: 'operator', follow: false },
  parity_resume: { path: 'parity/resume', role: 'operator', follow: false },
  parity_cancel: { path: 'parity/cancel', role: 'operator', follow: false },
  spin_up: { path: 'disks/{disk}/spin-up', role: 'operator', follow: false },
  spin_down: { path: 'disks/{disk}/spin-down', role: 'operator', follow: false },
  mover: { path: 'mover', role: 'operator', follow: true },
  archive_notifications: { path: 'notifications/archive', role: 'operator', follow: false },
} as const;
type ArrayAction = keyof typeof ARRAY_ACTIONS;

/** The words of a change's title (Done recently). */
function arrayTitle(
  action: ArrayAction,
  id: string,
  disk: string,
  notification: string | null,
  correct: boolean,
) {
  const disks = disk === 'all' ? `every disk of ${id}` : `${disk} on ${id}`;
  switch (action) {
    case 'start':
      return `Started the array of ${id}`;
    case 'stop':
      return `Stopped the array of ${id}`;
    case 'parity_check':
      return correct ? `Started a parity check with corrections on ${id}` : `Started a parity check on ${id}`;
    case 'parity_pause':
      return `Paused the parity check on ${id}`;
    case 'parity_resume':
      return `Resumed the parity check on ${id}`;
    case 'parity_cancel':
      return `Cancelled the parity check on ${id}`;
    case 'spin_up':
      return `Spun up ${disks}`;
    case 'spin_down':
      return `Spun down ${disks}`;
    case 'mover':
      return `Started the mover on ${id}`;
    default:
      return notification ? `Archived a notification on ${id}` : `Archived the notifications on ${id}`;
  }
}

export const UNRAID_TOOLS: Adapter = {
  async unraid_overview(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const d = await detailOf(s, srv);
        const u = d.unraid;
        if (!u) return wrongKind(srv, 'Unraid');
        const a = u.array;
        const disk = (x: (typeof a.disks)[number]) => ({
          disk: x.name,
          slot: x.slot,
          status: x.status,
          ...(x.model ? { model: x.model } : {}),
          sizeGb: gb(x.sizeBytes),
          ...(x.usedBytes !== null ? { usedPct: pct(x.usedBytes, x.sizeBytes) } : {}),
          ...(x.fsType ? { fs: x.fsType } : {}),
          tempC: x.tempC,
          ...(x.spunDown ? { spunDown: true } : {}),
          ...(x.errors ? { errors: x.errors } : {}),
        });
        const containers = d.workloads?.docker?.guests ?? [];
        return output({
          server: srv.id,
          name: u.name,
          version: u.version,
          ...(u.osUpdate
            ? { newerVersion: u.osUpdate.version, note: 'Update Unraid itself in Unraid.' }
            : {}),
          array: {
            state: a.state,
            startsOnBoot: a.startOnBoot,
            sizeGb: gb(a.sizeBytes),
            usedPct: pct(a.usedBytes, a.sizeBytes),
            freeGb: gb(a.freeBytes),
            ...(a.disabled ? { disabled: a.disabled } : {}),
            ...(a.invalid ? { invalid: a.invalid } : {}),
            ...(a.missing ? { missing: a.missing } : {}),
            ...(a.moverRunning ? { moverRunning: true } : {}),
            disks: a.disks.map(disk),
          },
          parity: {
            state: a.parity.state,
            ...(a.parity.state !== 'idle'
              ? {
                  action: a.parity.action,
                  pct: a.parity.pct,
                  etaS: a.parity.etaS,
                  speedMbs: a.parity.speedMbs,
                  errorsSoFar: a.parity.errors,
                }
              : {}),
            last: a.parity.last,
            history: a.parity.history.slice(0, 5),
            schedule: a.parity.schedule,
          },
          pools: u.pools.map((p) => ({
            pool: p.name,
            fs: p.fsType,
            ...(p.profile ? { profile: p.profile } : {}),
            sizeGb: gb(p.sizeBytes),
            usedPct: pct(p.usedBytes, p.sizeBytes),
            disks: p.disks.map(disk),
          })),
          ...(u.flash ? { flash: disk(u.flash) } : {}),
          shares: u.shares.map((x) => ({
            share: x.name,
            ...(x.comment ? { comment: x.comment } : {}),
            primary: x.primary,
            ...(x.secondary ? { secondary: x.secondary } : {}),
            usedGb: gb(x.usedBytes),
            freeGb: gb(x.freeBytes),
          })),
          plugins: [...u.plugins]
            .sort((p, q) => Number(Boolean(q.update)) - Number(Boolean(p.update)))
            .map((p) => ({
              plugin: p.file,
              name: p.name,
              version: p.version,
              ...(p.update ? { update: p.update } : {}),
            })),
          containersWithUpdates: containers.filter((g) => g.updateAvailable).map((g) => g.id),
          notifications: u.notifications.slice(0, 20).map((n) => ({
            notification: n.id,
            importance: n.importance,
            at: n.at,
            subject: n.subject,
            ...(n.description ? { description: n.description } : {}),
          })),
          docker: u.docker,
          vms: u.vms,
        });
      },
      { server },
    );
  },

  async unraid_array(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const action = oneOf(args, 'action', Object.keys(ARRAY_ACTIONS) as ArrayAction[]);
    const correct = optBool(args, 'correct');
    const diskArg = opt(args, 'disk');
    const notification = opt(args, 'notification');
    if (correct !== null && action !== 'parity_check')
      throw new ConnectionArgumentError('correct: for parity_check only.');
    if (diskArg !== null && action !== 'spin_up' && action !== 'spin_down')
      throw new ConnectionArgumentError('disk: for spin_up and spin_down only.');
    if (notification !== null && action !== 'archive_notifications')
      throw new ConnectionArgumentError('notification: for archive_notifications only.');
    const disk = diskArg ?? 'all';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(disk))
      throw new ConnectionArgumentError(
        'disk: a disk’s name as unraid_overview lists it (disk1, parity), or all.',
      );
    if (notification && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(notification))
      throw new ConnectionArgumentError('notification: its id as unraid_overview lists it.');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        if (srv.kind !== 'unraid') return wrongKind(srv, 'Unraid');
        const id = srv.id;
        const spec = ARRAY_ACTIONS[action];
        // Stopping the array and cancelling a check asked a person already (the catalog's sensitive rules).
        const body =
          action === 'stop' || action === 'parity_cancel'
            ? { confirm: true }
            : action === 'parity_check'
              ? { correct: correct === true }
              : action === 'archive_notifications'
                ? notification
                  ? { id: notification }
                  : {}
                : undefined;
        const r = toHostManageResult(
          await send<unknown>(s, spec.role, {
            method: 'POST',
            path: `${S(id)}/unraid/${spec.path.replace('{disk}', seg(disk))}`,
            ...(body !== undefined ? { body } : {}),
          }),
        );
        s.hosts.forget('fleet');
        const followed = await follow(
          s,
          'unraid_array',
          args,
          spec.follow ? r.task?.id : null,
          { server: id, label: srv.label },
          changeOf('unraid_array', id, null, arrayTitle(action, id, disk, notification, correct === true), {
            ids: idsOf(r),
          }),
        );
        return output({
          accepted: true,
          ...(r.task ? { task: r.task.id } : {}),
          ...(followed ? { next: FOLLOWED_NOTE } : {}),
        });
      },
      { server },
    );
  },

  async unraid_plugins(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const action = oneOf(args, 'action', ['check', 'update'] as const);
    const plugin = action === 'update' ? req(args, 'plugin') : opt(args, 'plugin');
    if (action === 'check' && plugin !== null) throw new ConnectionArgumentError('plugin: for update only.');
    if (plugin && plugin !== 'all' && !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,199}\.plg$/.test(plugin))
      throw new ConnectionArgumentError(
        'plugin: its file as unraid_overview lists it (unassigned.devices.plg), or all.',
      );
    if (plugin && /^unraidserver\.plg$/i.test(plugin))
      throw new ConnectionArgumentError('plugin: Unraid itself is updated in Unraid, not here.');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        if (srv.kind !== 'unraid') return wrongKind(srv, 'Unraid');
        const id = srv.id;
        const r = toHostManageResult(
          action === 'check'
            ? await send<unknown>(s, 'operator', { method: 'POST', path: `${S(id)}/unraid/plugins/check` })
            : await send<unknown>(s, 'admin', {
                method: 'POST',
                path: `${S(id)}/unraid/plugins/${seg(plugin as string)}/update`,
                body: { confirm: true },
              }),
        );
        const name = plugin && plugin !== 'all' ? plugin.replace(/\.plg$/, '') : null;
        const followed = await follow(
          s,
          'unraid_plugins',
          args,
          r.task?.id,
          { server: id, label: srv.label },
          changeOf(
            'unraid_plugins',
            id,
            null,
            action === 'check'
              ? `Checked for plugin updates on ${id}`
              : name
                ? `Started updating the plugin ${name} on ${id}`
                : `Started updating the plugins on ${id}`,
            { ids: idsOf(r) },
          ),
        );
        return output({
          accepted: true,
          ...(r.task ? { task: r.task.id } : {}),
          ...(followed ? { next: FOLLOWED_NOTE } : {}),
        });
      },
      { server },
    );
  },

  async container_update(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const action = oneOf(args, 'action', ['update', 'check'] as const);
    const guestArg = action === 'update' ? req(args, 'guest') : opt(args, 'guest');
    if (action === 'check' && guestArg !== null)
      throw new ConnectionArgumentError('guest: check looks at every container; leave it out.');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        if (srv.kind !== 'unraid') return wrongKind(srv, 'Unraid');
        const id = srv.id;
        if (action === 'check') {
          const r = toHostManageResult(
            await send<unknown>(s, 'operator', { method: 'POST', path: `${S(id)}/unraid/containers/check` }),
          );
          const followed = await follow(
            s,
            'container_update',
            args,
            r.task?.id,
            { server: id, label: srv.label },
            changeOf('container_update', id, null, `Checked for container updates on ${id}`, {
              ids: idsOf(r),
            }),
          );
          return output({
            accepted: true,
            ...(r.task ? { task: r.task.id } : {}),
            ...(followed ? { next: FOLLOWED_NOTE } : {}),
          });
        }
        const guest = await unraidContainer(s, srv, guestArg as string);
        refuseSelf(guest, { op: 'container.update' });
        // Updating asked a person already (always); the service still wants the confirmation.
        const r = toHostManageResult(
          await send<unknown>(s, 'admin', {
            method: 'POST',
            path: `${G(id, guest.id)}/update`,
            body: { confirm: true },
          }),
        );
        s.hosts.forget('fleet');
        const followed = await follow(
          s,
          'container_update',
          args,
          r.task?.id,
          {
            server: id,
            label: srv.label,
            guest: guest.name,
          },
          changeOf('container_update', id, guest.id, `Started updating ${guest.name} on ${id}`, {
            ids: idsOf(r),
          }),
        );
        return output({
          accepted: true,
          ...(guest.updateAvailable === false ? { note: `${guest.name} looked up to date already.` } : {}),
          ...(r.task ? { task: r.task.id } : {}),
          ...(followed ? { next: FOLLOWED_NOTE } : {}),
        });
      },
      { server, ...(guestArg ? { guest: guestArg } : {}) },
    );
  },

  async guest_autostart(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const on = optBool(args, 'on');
    if (on === null) throw new ConnectionArgumentError('on: true or false.');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const id = srv.id;
        const guest = await resolveGuest(s, id, guestArg);
        // Incus and Proxmox keep it in their settings (IU-S11).
        if (guest.platform === 'incus')
          throw new ConnectionArgumentError(
            'guest: an Incus instance starts with its server through guest_config_set: {"boot.autostart": "true"}.',
          );
        if (guest.platform === 'pve')
          throw new ConnectionArgumentError(
            'guest: a Proxmox guest starts with its server through guest_config_set: {"onboot": "1"}.',
          );
        refuseSelf(guest, { op: 'guest.autostart' });
        if (guest.autostart === on)
          return output({
            done: true,
            note: `${guest.name} ${on ? 'already starts' : 'already doesn’t start'} with its server.`,
          });
        const r = toHostManageResult(
          await send<unknown>(s, 'operator', {
            method: 'PUT',
            path: `${G(id, guest.id)}/autostart`,
            body: { on },
          }),
        );
        s.hosts.forget('fleet');
        await record(
          s,
          changeOf(
            'guest_autostart',
            id,
            guest.id,
            on
              ? `${guest.name} on ${id} starts with its server now`
              : `${guest.name} on ${id} no longer starts by itself`,
            {
              ids: idsOf(r),
              inverse: {
                tool: 'guest_autostart',
                args: { server: id, guest: guest.id, on: !on },
                serverId: id,
              },
            },
          ),
        );
        return output({ done: true });
      },
      { server, guest: guestArg },
    );
  },
};
