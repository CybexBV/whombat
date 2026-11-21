/**
 * The Servers tools for a guest's life and settings (proxmox.md PX-02; `tools-manage.ts` has the whole picture): its
 * snapshots and firewall to read; create (Proxmox's wizard defaults), clone, convert to a template, delete, grow and
 * move disks, firewall, high availability and replication to change.
 */
import { type HostChoices, type HostGuest, INCUS_NAME_PATTERN, LIBVIRT_NAME_PATTERN } from '@whombat/core';
import type { Adapter } from '../connections/adapters/types';
import { ConnectionArgumentError } from '../connections/request';
import { seg } from './client';
import { toHostFirewall, toHostGuestConfig, toHostManageResult, toHostSnapshots } from './map';
import {
  type CallScope,
  call,
  changeOf,
  choicesOf,
  FOLLOWED_NOTE,
  follow,
  G,
  idsOf,
  managePlatform,
  newGuestId,
  oneOf,
  opt,
  optBool,
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
} from './tools-shared';
import type { ToolInverse } from './undo';
import { scheduleWords } from './words';

/** What `guest_create` was asked for, checked. */
export interface CreateInput {
  kind: 'vm' | 'container';
  name: string;
  id: number | null;
  cores: number | null;
  memoryMb: number | null;
  diskGb: number | null;
  storage: string | null;
  bridge: string | null;
  iso: string | null;
  template: string | null;
  password: string | null;
  sshKeys: string | null;
  start: boolean;
  settings: Record<string, string> | null;
}

/** A VM's or container's Proxmox settings as Proxmox's own Create wizard fills them, with `settings` over them. */
export function pveCreateSet(
  input: CreateInput,
  choices: Pick<HostChoices, 'storages' | 'bridges'>,
): Record<string, string> {
  const settings = input.settings ?? {};
  const holds = (content: string) => choices.storages.find((st) => st.content.includes(content))?.id ?? null;
  const bridge = input.bridge ?? choices.bridges[0] ?? null;
  if (!bridge) throw new ConnectionArgumentError('bridge: this server has no network bridge; give one.');
  if (input.kind === 'vm') {
    const storage = input.storage ?? holds('images');
    if (!storage)
      throw new ConnectionArgumentError('storage: this server has no storage for VM disks; give one.');
    const ovmf = settings.bios === 'ovmf';
    const set: Record<string, string> = {
      ostype: 'l26',
      // The wizard's machine is i440fx unless the firmware is OVMF (UEFI), which wants q35 and an EFI disk.
      ...(ovmf ? { machine: 'q35', efidisk0: `${storage}:1,efitype=4m,pre-enrolled-keys=1` } : {}),
      scsihw: 'virtio-scsi-single',
      scsi0: `${storage}:${input.diskGb ?? 32},iothread=1`,
      ide2: `${input.iso ?? 'none'},media=cdrom`,
      boot: 'order=scsi0;ide2;net0',
      sockets: '1',
      cores: String(input.cores ?? 1),
      cpu: 'x86-64-v2-AES',
      memory: String(input.memoryMb ?? 2048),
      net0: `virtio,bridge=${bridge},firewall=1`,
      agent: '1',
    };
    return { ...set, ...settings };
  }
  const storage = input.storage ?? holds('rootdir');
  if (!storage)
    throw new ConnectionArgumentError('storage: this server has no storage for containers; give one.');
  if (!input.template)
    throw new ConnectionArgumentError(
      'template: a container starts from a template (storage_contents lists them).',
    );
  const set: Record<string, string> = {
    ostemplate: input.template,
    rootfs: `${storage}:${input.diskGb ?? 8}`,
    cores: String(input.cores ?? 1),
    memory: String(input.memoryMb ?? 512),
    swap: '512',
    net0: `name=eth0,bridge=${bridge},firewall=1,ip=dhcp`,
    unprivileged: '1',
    features: 'nesting=1',
    ...(input.password ? { password: input.password } : {}),
    ...(input.sshKeys ? { 'ssh-public-keys': input.sshKeys } : {}),
  };
  // Privileged containers aren't made here (the service refuses them too).
  return { ...set, ...settings, unprivileged: '1' };
}

/** What only an Incus create takes (0.83, CT-366). */
export interface IncusCreateInput {
  project: string | null;
  profiles: string[] | null;
  pool: string | null;
  network: string | null;
  cloudInit: string | null;
}

/** What a create on each platform doesn't take (IU-S06, IU-S15). */
const NOT_FOR: Readonly<Record<'pve' | 'incus' | 'libvirt', { keys: readonly string[]; words: string }>> = {
  pve: {
    keys: ['project', 'profiles', 'pool', 'network', 'cloud_init', 'os_variant'],
    words: 'not on Proxmox',
  },
  incus: {
    keys: ['id', 'storage', 'bridge', 'iso', 'password', 'ssh_keys', 'os_variant'],
    words: 'not on Incus; give pool, network, profiles or cloud_init instead',
  },
  libvirt: {
    keys: ['id', 'project', 'profiles', 'pool', 'cloud_init', 'template', 'password', 'ssh_keys'],
    words: 'not on QEMU/KVM; give os_variant, iso, storage, network or bridge instead',
  },
};

/** The arguments a platform's create doesn't take, refused in words (IU-S06). */
export function createArgsFor(
  platform: 'pve' | 'incus' | 'libvirt',
  args: Readonly<Record<string, unknown>>,
): void {
  const not = NOT_FOR[platform];
  const given = not.keys.filter((k) => args[k] !== undefined && args[k] !== null);
  if (given.length) throw new ConnectionArgumentError(`${given.join(', ')}: ${not.words}.`);
}

/** A libvirt VM's settings from the same input (IU-13: Proxmox-like keys `vcpus`, `memory_mb`). */
export function libvirtCreateSet(input: CreateInput): Record<string, string> {
  return {
    ...(input.cores ? { vcpus: String(input.cores) } : {}),
    ...(input.memoryMb ? { memory_mb: String(input.memoryMb) } : {}),
    ...(input.settings ?? {}),
  };
}

/** A new guest's name as its platform takes it, or the refusal in words. */
export function checkGuestName(platform: 'pve' | 'incus' | 'libvirt', name: string): void {
  if (platform === 'incus' && !INCUS_NAME_PATTERN.test(name))
    throw new ConnectionArgumentError(
      'name: on Incus a letter first, then letters, digits and -, at most 63 (web-01).',
    );
  if (platform === 'libvirt' && !LIBVIRT_NAME_PATTERN.test(name))
    throw new ConnectionArgumentError('name: up to 64 letters, digits, “.”, “_” and “-” (web-01).');
  if (platform === 'pve' && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(name))
    throw new ConnectionArgumentError('name: up to 63 letters, digits, dots and dashes (web-01).');
}

/** An Incus instance's settings from the same input (limits; the rest in Incus's own keys). */
export function incusCreateSet(input: CreateInput): Record<string, string> {
  return {
    ...(input.cores ? { 'limits.cpu': String(input.cores) } : {}),
    ...(input.memoryMb ? { 'limits.memory': `${input.memoryMb}MiB` } : {}),
    ...(input.settings ?? {}),
  };
}

/** A firewall rule as the agent gave it, checked (strings, `enable` a boolean, `pos` a number). */
export function firewallRule(raw: unknown, partial: boolean): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ConnectionArgumentError(
      'rule: an object like {"type": "in", "action": "ACCEPT", "macro": "SSH"}.',
    );
  const fields = [
    'type',
    'action',
    'enable',
    'macro',
    'proto',
    'source',
    'dest',
    'sport',
    'dport',
    'iface',
    'log',
    'comment',
  ];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!fields.includes(k))
      throw new ConnectionArgumentError(`rule.${k}: not a rule field (${fields.join(', ')}).`);
    if (k === 'enable') {
      if (typeof v !== 'boolean') throw new ConnectionArgumentError('rule.enable: true or false.');
    } else if (typeof v !== 'string' || /[\r\n]/.test(v) || v.length > 200)
      throw new ConnectionArgumentError(`rule.${k}: one line of text.`);
    out[k] = v;
  }
  if (!partial) {
    if (!['in', 'out', 'group'].includes(String(out.type)))
      throw new ConnectionArgumentError('rule.type: in, out or group.');
    if (!out.action)
      throw new ConnectionArgumentError('rule.action: ACCEPT, DROP, REJECT or a security group.');
  } else if (Object.keys(out).length === 0) throw new ConnectionArgumentError('rule: what to change.');
  return out;
}

/** A guest by id or name, or a template the server keeps (templates may not be in the guests list). */
export async function resolveGuestOrTemplate(
  s: CallScope,
  serverId: string,
  raw: string,
): Promise<HostGuest & { template?: boolean }> {
  try {
    return await resolveGuest(s, serverId, raw);
  } catch (err) {
    if (!(err instanceof ConnectionArgumentError)) throw err;
    const want = raw.trim().toLowerCase();
    const templates = (await choicesOf(s, serverId).catch(() => null))?.templates ?? [];
    const hit = templates.filter(
      (t) => `pve:${t.id}` === want || t.id === want || t.name.toLowerCase() === want,
    );
    if (hit.length !== 1) throw err;
    const t = hit[0] as NonNullable<HostChoices['templates']>[number];
    return {
      id: `pve:${t.id}`,
      serverId,
      name: t.name,
      platform: 'pve',
      kind: t.kind,
      state: 'stopped',
      template: true,
    } as unknown as HostGuest & { template: boolean };
  }
}

/**
 * `guest_create` on QEMU/KVM (IU-13): a VM from an OS type (Windows 11 gets UEFI and a TPM from the service), an ISO,
 * a disk on a pool or Unraid's domains folder, a network or a bridge.
 */
async function libvirtCreate(
  s: CallScope,
  srv: ResolvedServer,
  args: Readonly<Record<string, unknown>>,
  input: CreateInput,
  more: { name: string; osVariant: string | null; network: string | null },
) {
  const id = srv.id;
  if (input.kind !== 'vm') throw new ConnectionArgumentError('kind: QEMU/KVM makes VMs only.');
  if (more.network && input.bridge)
    throw new ConnectionArgumentError('network, bridge: one of them (a libvirt network or a host bridge).');
  const r = toHostManageResult(
    await send<unknown>(s, 'admin', {
      method: 'POST',
      path: `${S(id)}/guests`,
      body: {
        platform: 'libvirt',
        kind: 'vm',
        name: more.name,
        set: libvirtCreateSet(input),
        ...(more.osVariant ? { os_variant: more.osVariant } : {}),
        ...(input.iso ? { iso: input.iso } : {}),
        ...(input.storage ? { storage: input.storage } : {}),
        ...(input.diskGb ? { disk_gb: input.diskGb } : {}),
        ...(more.network ? { network: more.network } : {}),
        ...(input.bridge ? { bridge: input.bridge } : {}),
        ...(input.start ? { start: true } : {}),
      },
    }),
  );
  s.hosts.forget('fleet');
  const followed = await follow(
    s,
    'guest_create',
    args,
    r.task?.id,
    {
      server: id,
      label: srv.label,
      name: more.name,
    },
    changeOf('guest_create', id, r.newId ?? null, `Created the VM ${more.name} on ${id}`, { ids: idsOf(r) }),
  );
  return output({
    accepted: true,
    ...(r.newId ? { guest: r.newId } : {}),
    ...(r.task ? { task: r.task.id } : {}),
    ...(followed ? { next: FOLLOWED_NOTE } : {}),
  });
}

export const GUEST_TOOLS: Adapter = {
  async guest_snapshots(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    return call(
      async () => {
        const { id } = await resolveServer(s, server);
        const guest = await resolveGuest(s, id, guestArg);
        const raw = await s.hosts.call<unknown>({
          path: `${G(id, guest.id)}/snapshots`,
          actor: s.actor('operator'),
        });
        const snapshots = toHostSnapshots(raw)
          .filter((x) => x.name && x.name !== 'current')
          .map((x) => ({
            name: x.name,
            ...(x.created ? { taken: x.created } : {}),
            ...(x.description ? { description: x.description } : {}),
            ...(x.memory ? { withMemory: true } : {}),
          }));
        return output({ server: id, guest: guest.id, name: guest.name, snapshots });
      },
      { server, guest: guestArg },
    );
  },

  async guest_firewall(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    return call(
      async () => {
        const { id } = await resolveServer(s, server);
        const guest = await resolveGuest(s, id, guestArg);
        const f = toHostFirewall(
          await s.hosts.call<unknown>({ path: `${G(id, guest.id)}/firewall`, actor: s.actor('operator') }),
        );
        return output({
          server: id,
          guest: guest.id,
          name: guest.name,
          on: f.options.enable === '1',
          ...(f.clusterEnabled
            ? {}
            : { note: 'The datacenter firewall is off, so these rules do nothing yet.' }),
          options: f.options,
          rules: f.rules,
          ...(f.groups?.length ? { securityGroups: f.groups } : {}),
        });
      },
      { server, guest: guestArg },
    );
  },

  async guest_create(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const kind = oneOf(args, 'kind', ['vm', 'container'] as const);
    const name = req(args, 'name');
    if (name.length > 64) throw new ConnectionArgumentError('name: at most 64 characters.');
    const osVariant = plainName(args, 'os_variant');
    const input: CreateInput = {
      kind,
      name,
      id: newGuestId(args),
      cores: optInt(args, 'cores', 1, 512),
      memoryMb: optInt(args, 'memory_mb', 16, 16_777_216),
      diskGb: optInt(args, 'disk_gb', 1, 1_000_000),
      storage: plainName(args, 'storage'),
      bridge: plainName(args, 'bridge'),
      iso: opt(args, 'iso'),
      template: opt(args, 'template'),
      password: opt(args, 'password'),
      sshKeys: opt(args, 'ssh_keys'),
      start: optBool(args, 'start') === true,
      settings: optStrMap(args, 'settings'),
    };
    if (kind === 'vm' && (input.password || input.sshKeys))
      throw new ConnectionArgumentError(
        'password, ssh_keys: containers only; a VM sets them in its installer or cloud-init.',
      );
    const incus: IncusCreateInput = {
      project: plainName(args, 'project'),
      profiles: optStrList(args, 'profiles', 20),
      pool: plainName(args, 'pool'),
      network: plainName(args, 'network'),
      cloudInit: opt(args, 'cloud_init'),
    };
    if (incus.cloudInit && Buffer.byteLength(incus.cloudInit) > 65_536)
      throw new ConnectionArgumentError('cloud_init: at most 64 KiB.');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const { id } = srv;
        // The server's kind says whose create it is; a server of another kind asks the service (PX-S07 before 0.83).
        const asked = managePlatform(srv.kind) ?? (await choicesOf(s, id)).platform;
        const platform = asked === 'incus' || asked === 'libvirt' ? asked : 'pve';
        const pve = platform === 'pve';
        createArgsFor(platform, args);
        checkGuestName(platform, name);
        if (platform === 'libvirt')
          return libvirtCreate(s, srv, args, input, { name, osVariant, network: incus.network });
        const choices = pve ? await choicesOf(s, id, 'pve') : null;
        if (pve && kind === 'vm' && input.template)
          throw new ConnectionArgumentError(
            'template: containers only; a VM installs from an iso (or guest_clone a template).',
          );
        if (!pve && !input.template)
          throw new ConnectionArgumentError(
            'template: the Incus image to start from, like images:debian/13.',
          );
        const raw = await send<unknown>(s, 'admin', {
          method: 'POST',
          path: `${S(id)}/guests`,
          body: {
            platform,
            kind,
            ...(pve && input.id ? { new_id: input.id } : {}),
            name,
            set: pve && choices ? pveCreateSet(input, choices) : incusCreateSet(input),
            ...(input.start ? { start: true } : {}),
            ...(!pve
              ? {
                  image: input.template,
                  ...(incus.profiles ? { profiles: incus.profiles } : {}),
                  ...(incus.project ? { project: incus.project } : {}),
                  ...(incus.pool ? { pool: incus.pool } : {}),
                  ...(incus.network ? { network: incus.network } : {}),
                  ...(incus.cloudInit ? { cloud_init: incus.cloudInit } : {}),
                }
              : {}),
          },
        });
        const r = toHostManageResult(raw);
        s.hosts.forget('fleet');
        const what = kind === 'vm' ? 'VM' : 'container';
        const followed = await follow(
          s,
          'guest_create',
          args,
          r.task?.id,
          { server: id, label: srv.label, name },
          changeOf('guest_create', id, r.newId ?? null, `Created the ${what} ${name} on ${id}`, {
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
      { server },
    );
  },

  async guest_clone(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const name = req(args, 'name');
    if (name.length > 64) throw new ConnectionArgumentError('name: at most 64 characters.');
    const newId = newGuestId(args);
    const fullArg = optBool(args, 'full');
    const storage = plainName(args, 'storage');
    const project = plainName(args, 'project');
    const instanceOnly = optBool(args, 'instance_only');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const { id } = srv;
        const guest = await resolveGuestOrTemplate(s, id, guestArg);
        refuseSelf(guest, { op: 'guest.clone' });
        checkGuestName(
          guest.platform === 'incus' || guest.platform === 'libvirt' ? guest.platform : 'pve',
          name,
        );
        if (guest.platform === 'incus' || guest.platform === 'libvirt') {
          // An Incus or QEMU/KVM copy: a pool (and an Incus project), no numbers and no linked copies.
          const what = guest.platform === 'incus' ? 'an Incus copy' : 'a QEMU/KVM copy';
          if (newId !== null || fullArg !== null)
            throw new ConnectionArgumentError(`id, full: Proxmox only; ${what} is always whole.`);
          if (guest.platform === 'libvirt' && (project !== null || instanceOnly !== null))
            throw new ConnectionArgumentError('project, instance_only: Incus only.');
          const r = toHostManageResult(
            await send<unknown>(s, 'admin', {
              method: 'POST',
              path: `${G(id, guest.id)}/clone`,
              body: {
                name,
                ...(storage ? { storage } : {}),
                ...(project ? { project } : {}),
                ...(instanceOnly ? { instance_only: true } : {}),
              },
            }),
          );
          s.hosts.forget('fleet');
          const followed = await follow(
            s,
            'guest_clone',
            args,
            r.task?.id,
            {
              server: id,
              label: srv.label,
              guest: guest.name,
              name,
            },
            changeOf('guest_clone', id, guest.id, `Copied ${guest.name} on ${id} as ${name}`, {
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
        if (project !== null || instanceOnly !== null)
          throw new ConnectionArgumentError('project, instance_only: Incus only.');
        const template = guest.template === true;
        const full = fullArg ?? !template;
        if (!full && !template)
          throw new ConnectionArgumentError(
            `full: only a template can be linked; ${guest.name} is a guest, so leave full out.`,
          );
        if (storage && !full) throw new ConnectionArgumentError('storage: only a full copy takes a storage.');
        const raw = await send<unknown>(s, 'admin', {
          method: 'POST',
          path: `${G(id, guest.id)}/clone`,
          body: { ...(newId ? { new_id: newId } : {}), name, full, ...(storage ? { storage } : {}) },
        });
        const r = toHostManageResult(raw);
        s.hosts.forget('fleet');
        const followed = await follow(
          s,
          'guest_clone',
          args,
          r.task?.id,
          {
            server: id,
            label: srv.label,
            guest: guest.name,
            name,
          },
          changeOf('guest_clone', id, guest.id, `Cloned ${guest.name} on ${id} as ${name}`, {
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

  async guest_template(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    return call(
      async () => {
        const { id } = await resolveServer(s, server);
        const guest = await resolveGuest(s, id, guestArg);
        refuseSelf(guest, { op: 'guest.template' });
        const r = toHostManageResult(
          await send<unknown>(s, 'admin', {
            method: 'POST',
            path: `${G(id, guest.id)}/template`,
            body: { confirm: true },
          }),
        );
        s.hosts.forget('fleet');
        const followed = await follow(
          s,
          'guest_template',
          args,
          r.task?.id,
          { server: id, guest: guest.name },
          changeOf('guest_template', id, guest.id, `Turned ${guest.name} on ${id} into a template`, {
            ids: idsOf(r),
          }),
        );
        return output({
          accepted: true,
          ...(r.task ? { task: r.task.id } : {}),
          ...(followed ? { next: FOLLOWED_NOTE } : {}),
        });
      },
      { server, guest: guestArg },
    );
  },

  async guest_delete(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const purge = optBool(args, 'purge') ?? true;
    return call(
      async () => {
        const { id } = await resolveServer(s, server);
        const guest = await resolveGuestOrTemplate(s, id, guestArg);
        refuseSelf(guest, { op: 'guest.delete' });
        // The approval already happened; the service still wants the name, as a person types it. Purging: Proxmox's jobs, or a VM's disks.
        const r = toHostManageResult(
          await send<unknown>(s, 'admin', {
            method: 'DELETE',
            path: G(id, guest.id),
            query: {
              confirm_name: guest.name || guest.id,
              ...(guest.platform === 'pve' || guest.platform === 'libvirt'
                ? { purge: purge ? '1' : '0' }
                : {}),
            },
          }),
        );
        s.hosts.forget('fleet');
        const followed = await follow(
          s,
          'guest_delete',
          args,
          r.task?.id,
          { server: id, guest: guest.name },
          changeOf('guest_delete', id, guest.id, `Deleted ${guest.name} on ${id}`, { ids: idsOf(r) }),
        );
        return output({
          accepted: true,
          ...(r.task ? { task: r.task.id } : {}),
          ...(followed ? { next: FOLLOWED_NOTE } : {}),
        });
      },
      { server, guest: guestArg },
    );
  },

  async guest_disk(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const action = oneOf(args, 'action', ['resize', 'move'] as const);
    const disk = req(args, 'disk');
    if (
      !/^(scsi\d+|virtio\d+|sata\d+|ide\d+|efidisk0|tpmstate0|rootfs|mp\d+|[A-Za-z0-9][A-Za-z0-9_.-]{0,62})$/.test(
        disk,
      )
    )
      throw new ConnectionArgumentError('disk: its key as guest_config lists it (scsi0, rootfs, mp0).');
    const size = action === 'resize' ? req(args, 'size') : null;
    if (size && !/^\+?\d+(\.\d+)?([KMGT]i?B?)?$/.test(size))
      throw new ConnectionArgumentError('size: the new size or how much to add, like 64G, +10G or 20GiB.');
    const storage = action === 'move' ? plainName(args, 'storage', true) : null;
    const deleteSource = optBool(args, 'delete_source') ?? false;
    return call(
      async () => {
        const { id } = await resolveServer(s, server);
        const guest = await resolveGuest(s, id, guestArg);
        refuseSelf(guest, { op: action === 'resize' ? 'disk.resize' : 'disk.move' });
        if (action === 'move' && guest.platform === 'incus')
          throw new ConnectionArgumentError(
            'action: an Incus instance moves whole to another pool with guest_move, not disk by disk.',
          );
        if (action === 'move' && guest.platform === 'libvirt')
          throw new ConnectionArgumentError(
            'action: a QEMU/KVM disk only grows here; clone the VM to another pool.',
          );
        const r = toHostManageResult(
          await send<unknown>(s, 'operator', {
            method: 'POST',
            path: `${G(id, guest.id)}/disks/${seg(disk)}/${action}`,
            body:
              action === 'resize' ? { size } : { storage, ...(deleteSource ? { delete_source: true } : {}) },
          }),
        );
        const title =
          action === 'resize'
            ? `Grew the disk ${disk} of ${guest.name} on ${id} ${size?.startsWith('+') ? `by ${size.slice(1)}` : `to ${size}`}`
            : `Moved the disk ${disk} of ${guest.name} on ${id} to ${storage}`;
        const followed = await follow(
          s,
          'guest_disk',
          args,
          r.task?.id,
          { server: id, guest: guest.name },
          changeOf('guest_disk', id, guest.id, title, { ids: idsOf(r) }),
        );
        return output({
          accepted: true,
          ...(r.task ? { task: r.task.id } : {}),
          ...(action === 'move' && !deleteSource ? { note: 'The old copy stays as an unused disk.' } : {}),
          ...(followed ? { next: FOLLOWED_NOTE } : {}),
        });
      },
      { server, guest: guestArg },
    );
  },

  async guest_firewall_set(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const action = oneOf(args, 'action', [
      'enable',
      'disable',
      'options',
      'add_rule',
      'update_rule',
      'delete_rule',
      'move_rule',
    ] as const);
    const pos = optInt(args, 'pos', 0, 9999);
    const to = optInt(args, 'to', 0, 9999);
    if ((action === 'update_rule' || action === 'delete_rule' || action === 'move_rule') && pos === null)
      throw new ConnectionArgumentError('pos: the rule’s position as guest_firewall lists it.');
    if (action === 'move_rule' && to === null)
      throw new ConnectionArgumentError('to: the rule’s new position.');
    const rule =
      action === 'add_rule' || action === 'update_rule'
        ? firewallRule(args.rule, action === 'update_rule')
        : null;
    const options = action === 'options' ? optStrMap(args, 'options', 10) : null;
    if (action === 'options' && !options)
      throw new ConnectionArgumentError('options: the options to set, like {"policy_in": "DROP"}.');
    return call(
      async () => {
        const { id } = await resolveServer(s, server);
        const guest = await resolveGuest(s, id, guestArg);
        refuseSelf(guest, { op: 'firewall.options' });
        const fwPath = `${G(id, guest.id)}/firewall`;
        const fw = toHostFirewall(await s.hosts.call<unknown>({ path: fwPath, actor: s.actor('operator') }));
        const on = `${guest.name} on ${id}`;
        const base = { server: id, guest: guest.id };
        let title: string;
        let inverse: ToolInverse | null = null;
        let r: ReturnType<typeof toHostManageResult>;
        switch (action) {
          case 'enable':
          case 'disable': {
            const want = action === 'enable' ? '1' : '0';
            if ((fw.options.enable ?? '0') === want)
              return output({
                done: true,
                note: `The firewall of ${guest.name} was already ${action === 'enable' ? 'on' : 'off'}.`,
              });
            r = toHostManageResult(
              await send<unknown>(s, 'operator', {
                method: 'PUT',
                path: `${fwPath}/options`,
                body: { ...(fw.optionsDigest ? { digest: fw.optionsDigest } : {}), set: { enable: want } },
              }),
            );
            title = `Turned ${action === 'enable' ? 'on' : 'off'} the firewall of ${on}`;
            inverse = {
              tool: 'guest_firewall_set',
              args: { ...base, action: action === 'enable' ? 'disable' : 'enable' },
              serverId: id,
            };
            break;
          }
          case 'options':
            r = toHostManageResult(
              await send<unknown>(s, 'operator', {
                method: 'PUT',
                path: `${fwPath}/options`,
                body: { ...(fw.optionsDigest ? { digest: fw.optionsDigest } : {}), set: options },
              }),
            );
            title = `Changed the firewall options of ${on}`;
            break;
          case 'add_rule':
            r = toHostManageResult(
              await send<unknown>(s, 'operator', {
                method: 'POST',
                path: `${fwPath}/rules`,
                body: { rule: { enable: true, ...rule } },
              }),
            );
            title = `Added a firewall rule to ${on}`;
            break;
          case 'update_rule': {
            const current = fw.rules.find((x) => x.pos === pos);
            if (!current)
              throw new ConnectionArgumentError(
                `pos: ${guest.name} has no rule at ${pos} (guest_firewall lists them).`,
              );
            r = toHostManageResult(
              await send<unknown>(s, 'operator', {
                method: 'PUT',
                path: `${fwPath}/rules/${pos}`,
                body: { ...(fw.rulesDigest ? { digest: fw.rulesDigest } : {}), rule },
              }),
            );
            const onlyEnable = rule && Object.keys(rule).length === 1 && typeof rule.enable === 'boolean';
            title = onlyEnable
              ? `Turned ${rule.enable ? 'on' : 'off'} a firewall rule of ${on}`
              : `Changed a firewall rule of ${on}`;
            if (onlyEnable && current.enable !== rule.enable)
              inverse = {
                tool: 'guest_firewall_set',
                args: { ...base, action: 'update_rule', pos, rule: { enable: current.enable } },
                serverId: id,
              };
            break;
          }
          case 'delete_rule':
            if (!fw.rules.some((x) => x.pos === pos))
              throw new ConnectionArgumentError(
                `pos: ${guest.name} has no rule at ${pos} (guest_firewall lists them).`,
              );
            r = toHostManageResult(
              await send<unknown>(s, 'operator', {
                method: 'DELETE',
                path: `${fwPath}/rules/${pos}`,
                ...(fw.rulesDigest ? { query: { digest: fw.rulesDigest } } : {}),
              }),
            );
            title = `Removed a firewall rule of ${on}`;
            break;
          default:
            r = toHostManageResult(
              await send<unknown>(s, 'operator', {
                method: 'PUT',
                path: `${fwPath}/rules/${pos}`,
                body: { ...(fw.rulesDigest ? { digest: fw.rulesDigest } : {}), move_to: to },
              }),
            );
            title = `Moved a firewall rule of ${on}`;
        }
        await record(s, changeOf('guest_firewall', id, guest.id, title, { ids: idsOf(r), inverse }));
        return output({
          done: true,
          ...(fw.clusterEnabled
            ? {}
            : { note: 'The datacenter firewall is off, so the rules do nothing until it is on.' }),
        });
      },
      { server, guest: guestArg },
    );
  },

  async guest_ha(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const action = oneOf(args, 'action', ['set', 'remove'] as const);
    const state = opt(args, 'state') ?? 'started';
    if (!['started', 'stopped', 'ignored', 'disabled'].includes(state))
      throw new ConnectionArgumentError('state: started, stopped, ignored or disabled.');
    const maxRestart = optInt(args, 'max_restart', 0, 10) ?? 1;
    const maxRelocate = optInt(args, 'max_relocate', 0, 10) ?? 1;
    return call(
      async () => {
        const { id } = await resolveServer(s, server);
        const guest = await resolveGuest(s, id, guestArg);
        refuseSelf(guest, { op: action === 'remove' ? 'ha.remove' : 'ha.set' });
        const on = `${guest.name} on ${id}`;
        if (action === 'remove') {
          const r = toHostManageResult(
            await send<unknown>(s, 'admin', { method: 'DELETE', path: `${G(id, guest.id)}/ha` }),
          );
          await record(
            s,
            changeOf('guest_ha', id, guest.id, `Took ${on} out of high availability`, { ids: idsOf(r) }),
          );
          return output({ done: true });
        }
        // Whether it had HA before: Undo takes it out again only when it didn't.
        const before = toHostGuestConfig(
          await s.hosts.call<unknown>({ path: `${G(id, guest.id)}/config`, actor: s.actor('operator') }),
        ).ha;
        const r = toHostManageResult(
          await send<unknown>(s, 'admin', {
            method: 'PUT',
            path: `${G(id, guest.id)}/ha`,
            body: { state, max_restart: maxRestart, max_relocate: maxRelocate },
          }),
        );
        await record(
          s,
          changeOf(
            'guest_ha',
            id,
            guest.id,
            before ? `Changed the high availability of ${on}` : `Turned on high availability for ${on}`,
            {
              ids: idsOf(r),
              inverse: before
                ? null
                : { tool: 'guest_ha', args: { server: id, guest: guest.id, action: 'remove' }, serverId: id },
            },
          ),
        );
        return output({ done: true, changes: r.changes ?? [] });
      },
      { server, guest: guestArg },
    );
  },

  async guest_replication(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const guestArg = req(args, 'guest');
    const action = oneOf(args, 'action', ['add', 'delete'] as const);
    const target = action === 'add' ? plainName(args, 'target', true) : null;
    const schedule = opt(args, 'schedule') ?? '*/15';
    if (!/^[A-Za-z0-9 :,.*/~-]{1,128}$/.test(schedule))
      throw new ConnectionArgumentError('schedule: in Proxmox’s words, like */15 or 02:00.');
    const job = action === 'delete' ? req(args, 'job') : null;
    if (job && !/^\d+-\d+$/.test(job))
      throw new ConnectionArgumentError('job: the job’s id as guest_config lists it (101-0).');
    return call(
      async () => {
        const { id } = await resolveServer(s, server);
        const guest = await resolveGuest(s, id, guestArg);
        const on = `${guest.name} on ${id}`;
        if (action === 'delete') {
          const r = toHostManageResult(
            await send<unknown>(s, 'operator', {
              method: 'DELETE',
              path: `${G(id, guest.id)}/replication/${seg(job as string)}`,
            }),
          );
          await record(
            s,
            changeOf('guest_replication', id, guest.id, `Stopped a replication of ${on}`, { ids: idsOf(r) }),
          );
          return output({ done: true });
        }
        const r = toHostManageResult(
          await send<unknown>(s, 'operator', {
            method: 'POST',
            path: `${G(id, guest.id)}/replication`,
            body: { target, schedule },
          }),
        );
        await record(
          s,
          changeOf('guest_replication', id, guest.id, `Started replicating ${on} to ${target}`, {
            ids: idsOf(r),
          }),
        );
        return output({ done: true, runs: scheduleWords(schedule) });
      },
      { server, guest: guestArg },
    );
  },
};
