import type { Adapter } from '../connections/adapters/types';
import { ConnectionArgumentError } from '../connections/request';
import { seg } from './client';
import { arr, num, obj, str, toHostManageResult, toHostTask } from './map';
import { taskPlatform } from './task-platform';
import {
  call,
  changeOf,
  choicesOf,
  FOLLOWED_NOTE,
  follow,
  G,
  gb,
  idsOf,
  managePlatform,
  oneOf,
  opt,
  optBool,
  output,
  plainName,
  record,
  req,
  resolveGuest,
  resolveServer,
  S,
  scope,
  send,
} from './tools-shared';
import { volumeFile } from './words';

export { taskPlatform };

/**
 * A task's id as the service gives it: Proxmox's UPID, an Incus operation, an unRAID or libvirt job (0.83, 0.84), a
 * package task of the server itself (0.98, server-updates.md SWU-04).
 */
const TASK_ID = /^(UPID:\S+|incus:[A-Za-z0-9-]+|(unraid|libvirt|pkg):[0-9a-f]{1,64})$/;

/** Whose ISO images and downloads a server has (0.84): Proxmox's storages, else libvirt's pools and Unraid's folder. */
const contentPlatform = (kind: string): 'pve' | 'libvirt' => (kind === 'proxmox' ? 'pve' : 'libvirt');

export const HOST_TOOLS: Adapter = {
  async server_choices(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const project = plainName(args, 'project');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const { id } = srv;
        const platform = managePlatform(srv.kind);
        if (project && platform !== 'incus')
          throw new ConnectionArgumentError('project: Incus servers only.');
        const c = await choicesOf(s, id, platform, project);
        const volume = (v: unknown) => str(obj(v).volume) ?? str(obj(v).volid) ?? str(obj(v).name);
        return output({
          server: id,
          platform: c.platform,
          ...(c.node ? { node: c.node } : {}),
          ...(c.nextId ? { nextId: c.nextId } : {}),
          storages: c.storages.map((st) => ({
            id: st.id,
            type: st.type,
            holds: st.content,
            ...(gb(st.availBytes) !== null ? { freeGb: gb(st.availBytes) } : {}),
            ...(gb(st.totalBytes) !== null ? { sizeGb: gb(st.totalBytes) } : {}),
            ...(st.shared ? { shared: true } : {}),
          })),
          bridges: c.bridges,
          ...(c.isos?.length ? { isos: c.isos.map(volume).filter(Boolean).slice(0, 100) } : {}),
          ...(c.ctTemplates?.length
            ? { containerTemplates: c.ctTemplates.map(volume).filter(Boolean).slice(0, 100) }
            : {}),
          ...(c.templates?.length
            ? { templates: c.templates.map((t) => ({ id: `pve:${t.id}`, name: t.name, kind: t.kind })) }
            : {}),
          ...(c.cpuTypes?.length ? { cpuTypes: c.cpuTypes.slice(0, 40) } : {}),
          ...(c.nodes?.length ? { otherNodes: c.nodes } : {}),
          ...(c.profiles?.length ? { profiles: c.profiles } : {}),
          ...(c.images?.length ? { images: c.images.slice(0, 50) } : {}),
          ...(c.projects?.length ? { projects: c.projects } : {}),
          ...(c.remoteImages?.length ? { imagesToDownload: c.remoteImages.slice(0, 60) } : {}),
          ...(c.networks?.length ? { networks: c.networks } : {}),
          ...(c.osVariants?.length ? { osVariants: c.osVariants } : {}),
          ...(c.firmware ? { firmware: c.firmware } : {}),
          ...(c.platform === 'pve' ? { canDownload: c.download === true } : {}),
        });
      },
      { server },
    );
  },

  async storage_contents(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const storage = plainName(args, 'storage');
    const content = opt(args, 'content');
    if (content && !['iso', 'vztmpl', 'import'].includes(content))
      throw new ConnectionArgumentError('content: iso, vztmpl or import.');
    const appliances = optBool(args, 'appliances') === true;
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const { id } = srv;
        // QEMU/KVM's ISO images (0.84) everywhere but on Proxmox: its pools, Unraid's ISO folder.
        if (contentPlatform(srv.kind) === 'libvirt') {
          if (appliances) throw new ConnectionArgumentError('appliances: Proxmox only.');
          if (content && content !== 'iso')
            throw new ConnectionArgumentError('content: QEMU/KVM keeps ISO images only (iso).');
          if (!storage) {
            const isos = (await choicesOf(s, id, 'libvirt')).isos ?? [];
            return output({
              server: id,
              items: isos.slice(0, 200).map((i) => ({
                volume: str(i.volid) ?? str(i.volume),
                ...(str(i.name) ? { name: str(i.name) } : {}),
                ...(num(i.sizeBytes) !== null
                  ? { sizeMb: Math.round((num(i.sizeBytes) as number) / 1048576) }
                  : {}),
              })),
              ...(isos.length > 200 ? { more: isos.length - 200 } : {}),
            });
          }
        }
        if (appliances) {
          const raw = await s.hosts.call<unknown>({
            path: `${S(id)}/appliances`,
            actor: s.actor('operator'),
          });
          return output({
            server: id,
            templates: arr(obj(raw).items)
              .map(obj)
              .slice(0, 150)
              .map((a) => ({
                template: str(a.template),
                ...(str(a.headline) ? { what: str(a.headline) } : {}),
                ...(str(a.section) ? { section: str(a.section) } : {}),
              })),
            next: 'storage_content get_template downloads one to a storage that holds vztmpl.',
          });
        }
        const stores = storage
          ? [storage]
          : (await choicesOf(s, id)).storages
              .filter((st) =>
                st.content.some((c) => (content ? c === content : ['iso', 'vztmpl', 'import'].includes(c))),
              )
              .map((st) => st.id)
              .slice(0, 8);
        const items: Record<string, unknown>[] = [];
        const libvirt = contentPlatform(srv.kind) === 'libvirt';
        for (const st of stores) {
          const raw = await s.hosts.call<unknown>({
            path: `${S(id)}/storage/${seg(st)}/content`,
            query: libvirt ? { platform: 'libvirt', content: 'iso' } : content ? { content } : {},
            actor: s.actor('operator'),
          });
          for (const i of arr(obj(raw).items).map(obj))
            items.push({
              volume: str(i.volume),
              storage: str(i.storage) ?? st,
              content: str(i.content),
              ...(num(i.size_bytes) !== null
                ? { sizeMb: Math.round((num(i.size_bytes) as number) / 1048576) }
                : {}),
            });
        }
        return output({
          server: id,
          items: items.slice(0, 200),
          ...(items.length > 200 ? { more: items.length - 200 } : {}),
        });
      },
      { server },
    );
  },

  async server_tasks(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = opt(args, 'guest');
    const task = opt(args, 'task');
    if (task && !TASK_ID.test(task))
      throw new ConnectionArgumentError(
        'task: an id as server_tasks lists it or a call gave it (UPID:…, incus:…, libvirt:…, pkg:…).',
      );
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const { id } = srv;
        if (task) {
          const t = toHostTask(
            await s.hosts.call<unknown>({
              path: `${S(id)}/tasks/${seg(task)}`,
              query: {
                log_start: 0,
                ...(taskPlatform(task) !== 'pve' ? { platform: taskPlatform(task) } : {}),
              },
              actor: s.actor('operator'),
            }),
          );
          const log = t.log ?? [];
          return output({
            server: id,
            task: t.id,
            type: t.type,
            ...(t.guestId ? { guest: t.guestId } : {}),
            status: t.status,
            started: t.started,
            ...(t.ended ? { ended: t.ended } : {}),
            ...(t.message ? { message: t.message } : {}),
            // A package task (0.98): why it ended early, and what it installed and held back.
            ...(t.code ? { code: t.code } : {}),
            ...(t.packages ? { packages: t.packages } : {}),
            log: log.slice(-100),
            ...(log.length > 100 ? { earlierLines: log.length - 100 } : {}),
          });
        }
        const guest = guestArg ? await resolveGuest(s, id, guestArg) : null;
        // An Incus host's operations, an unRAID server's commands; Proxmox's by default.
        const platform =
          srv.kind === 'incus' || srv.kind === 'unraid' || srv.kind === 'libvirt' ? srv.kind : undefined;
        const raw = await s.hosts.call<unknown>({
          path: guest ? `${G(id, guest.id)}/tasks` : `${S(id)}/tasks`,
          ...(platform && !guest ? { query: { platform } } : {}),
          actor: s.actor('operator'),
        });
        return output({
          server: id,
          tasks: arr(obj(raw).items)
            .map(toHostTask)
            .slice(0, 30)
            .map((t) => ({
              task: t.id,
              type: t.type,
              ...(t.guestId ? { guest: t.guestId } : {}),
              status: t.status,
              started: t.started,
              ...(t.ended ? { ended: t.ended } : {}),
              ...(t.user ? { by: t.user } : {}),
              ...(t.message && t.status !== 'ok' ? { message: t.message } : {}),
              ...(t.cancellable ? { canStop: true } : {}),
            })),
        });
      },
      { server, ...(guestArg ? { guest: guestArg } : {}) },
    );
  },

  async storage_content(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const action = oneOf(args, 'action', ['download', 'get_template', 'delete'] as const);
    const storage = plainName(args, 'storage', true);
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const { id } = srv;
        const platform = contentPlatform(srv.kind);
        if (action === 'get_template' && platform !== 'pve')
          throw new ConnectionArgumentError(
            'action: container templates are Proxmox’s; download an ISO instead.',
          );
        if (action === 'delete') {
          const volume = req(args, 'volume');
          if (platform === 'pve' && !volume.startsWith(`${storage}:`))
            throw new ConnectionArgumentError(
              `volume: one of ${storage}’s, as storage_contents lists it (${storage}:iso/…).`,
            );
          if (volume.length > 500 || /[\r\n]/.test(volume))
            throw new ConnectionArgumentError('volume: as storage_contents lists it.');
          const r = toHostManageResult(
            await send<unknown>(s, 'admin', {
              method: 'DELETE',
              path: `${S(id)}/storage/content`,
              query: { platform, volume },
            }),
          );
          const file = volumeFile(volume);
          const followed = await follow(
            s,
            'storage_content',
            args,
            r.task?.id,
            { server: id, name: file },
            changeOf('storage_content', id, null, `Deleted ${file} from ${storage} on ${id}`, {
              ids: idsOf(r),
            }),
          );
          return output({
            done: !r.task,
            ...(r.task ? { task: r.task.id } : {}),
            ...(followed ? { next: FOLLOWED_NOTE } : {}),
          });
        }
        if (action === 'get_template') {
          const template = req(args, 'template');
          const r = toHostManageResult(
            await send<unknown>(s, 'admin', {
              method: 'POST',
              path: `${S(id)}/storage/${seg(storage)}/appliances`,
              body: { platform: 'pve', template },
            }),
          );
          const followed = await follow(
            s,
            'storage_content',
            args,
            r.task?.id,
            { server: id, name: template },
            changeOf('storage_content', id, null, `Started downloading ${template} to ${storage} on ${id}`, {
              ids: idsOf(r),
            }),
          );
          return output({
            accepted: true,
            ...(r.task ? { task: r.task.id } : {}),
            ...(followed ? { next: FOLLOWED_NOTE } : {}),
          });
        }
        const url = req(args, 'url');
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new ConnectionArgumentError('url: an http(s) address.');
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
          throw new ConnectionArgumentError('url: an http(s) address without a user name or password.');
        const filename = opt(args, 'filename') ?? decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
        if (!/^[A-Za-z0-9._-]{1,200}$/.test(filename))
          throw new ConnectionArgumentError(
            'filename: the file’s name with its extension (letters, digits, “.”, “_”, “-”).',
          );
        const content =
          opt(args, 'content') ??
          (/\.(iso|img)$/i.test(filename)
            ? 'iso'
            : /\.tar\.(gz|xz|zst)$/i.test(filename)
              ? 'vztmpl'
              : /\.(ova|qcow2|vmdk|raw)$/i.test(filename)
                ? 'import'
                : null);
        if (!content || !['iso', 'vztmpl', 'import'].includes(content))
          throw new ConnectionArgumentError('content: iso, vztmpl or import.');
        if (platform === 'libvirt' && content !== 'iso')
          throw new ConnectionArgumentError('content: QEMU/KVM downloads ISO images only (iso).');
        const checksum = opt(args, 'checksum');
        const algorithm = opt(args, 'checksum_algorithm');
        if ((checksum === null) !== (algorithm === null))
          throw new ConnectionArgumentError('checksum, checksum_algorithm: both or neither.');
        if (checksum && !/^[0-9a-fA-F]{32,128}$/.test(checksum))
          throw new ConnectionArgumentError('checksum: 32 to 128 hexadecimal digits.');
        const r = toHostManageResult(
          await send<unknown>(s, 'admin', {
            method: 'POST',
            path: `${S(id)}/storage/${seg(storage)}/download`,
            body: {
              platform,
              content,
              url,
              filename,
              ...(checksum ? { checksum: checksum.toLowerCase(), checksum_algorithm: algorithm } : {}),
            },
          }),
        );
        const followed = await follow(
          s,
          'storage_content',
          { ...args, filename },
          r.task?.id,
          {
            server: id,
            name: filename,
          },
          changeOf('storage_content', id, null, `Started downloading ${filename} to ${storage} on ${id}`, {
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

  async task_stop(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const task = req(args, 'task');
    if (!TASK_ID.test(task))
      throw new ConnectionArgumentError(
        'task: an id as server_tasks lists it or a call gave it (UPID:…, incus:…, unraid:…, pkg:…).',
      );
    return call(
      async () => {
        const { id } = await resolveServer(s, server);
        const r = toHostManageResult(
          await send<unknown>(s, 'operator', {
            method: 'DELETE',
            path: `${S(id)}/tasks/${seg(task)}`,
            query: { platform: taskPlatform(task) },
          }),
        );
        await record(
          s,
          changeOf('task_stop', id, null, `Stopped a task on ${id}`, { ids: { ...idsOf(r), taskId: task } }),
        );
        return output({ done: true });
      },
      { server },
    );
  },

  async server_power(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const action = oneOf(args, 'action', ['reboot', 'shutdown'] as const);
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const { id } = srv;
        const raw = obj(
          await send<unknown>(s, 'admin', {
            method: 'POST',
            path: `${S(id)}/actions`,
            body: { action: action === 'reboot' ? 'host_reboot' : 'host_shutdown', confirm: true },
          }),
        );
        s.hosts.forget('fleet');
        await record(
          s,
          changeOf('server_power', id, null, action === 'reboot' ? `Rebooted ${id}` : `Shut down ${id}`, {
            ids: str(raw.action_id) ? { actionId: str(raw.action_id) as string } : {},
          }),
        );
        return output({
          accepted: true,
          ...(str(raw.action_id) ? { actionId: str(raw.action_id) } : {}),
          next: srv.runsThisWhombat
            ? // This Whombat runs on it (IU-02): it goes too, and this turn with it.
              action === 'reboot'
              ? `This Whombat goes down too and comes back with ${id} in a few minutes.`
              : `This Whombat goes down too and stays off until someone powers ${id} on.`
            : action === 'reboot'
              ? `${id} goes away for a few minutes and its guests with it; servers_overview shows when it is back.`
              : `${id} stays off until someone powers it on.`,
        });
      },
      { server },
    );
  },
};
