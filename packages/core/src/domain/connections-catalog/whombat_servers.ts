import type { JsonObject, JsonValue } from '../common.js';
import { HOST_PACKAGE_NAME_PATTERN, HOST_PACKAGES_MAX, HOST_SCREEN_LIMITS } from '../hosts.js';
import {
  builtin,
  type CatalogEntryInput,
  type ConnectionToolDef,
  int,
  obj,
  type SensitiveRule,
  str,
} from './shared.js';

export const SERVER = str(
  'The server’s id as servers_overview lists it (pve-02), or the name the person gave it',
);

export const GUEST = str('The guest’s id as guests_list lists it: pve:101, incus:web, docker:pihole');

export const bool = (description: string, extra: Record<string, JsonValue> = {}): JsonObject => ({
  type: 'boolean',
  description,
  ...extra,
});

export const strMap = (description: string, extra: Record<string, JsonValue> = {}): JsonObject => ({
  type: 'object',
  additionalProperties: { type: 'string' },
  description,
  ...extra,
});

export const strList = (description: string): JsonObject => ({
  type: 'array',
  items: { type: 'string' },
  description,
});

export const NEW_GUEST_ID = (description: string): JsonObject =>
  int(description, { minimum: 100, maximum: 999_999_999 });

export const BACKUP_MODE = (when: string): JsonObject =>
  str(`${when}snapshot (the guest keeps running; the default), suspend or stop`, {
    enum: ['snapshot', 'suspend', 'stop'],
  });

export const KEEP_COUNT = (what: string): JsonObject => int(what, { minimum: 0 });

export const BACKUP_KEEP: JsonObject = {
  ...obj({
    last: KEEP_COUNT('The newest backups'),
    hourly: KEEP_COUNT('One per hour, for this many hours'),
    daily: KEEP_COUNT('One per day, for this many days'),
    weekly: KEEP_COUNT('One per week, for this many weeks'),
    monthly: KEEP_COUNT('One per month, for this many months'),
    yearly: KEEP_COUNT('One per year, for this many years'),
  }),
  description: 'How many backups to keep: {"last": 3, "daily": 7, "weekly": 4}',
};

export const FIREWALL_RULE: JsonObject = {
  ...obj({
    type: str('in, out or group', { enum: ['in', 'out', 'group'] }),
    action: str('ACCEPT, DROP or REJECT; for type group, the security group’s name'),
    enable: bool('Whether the rule is on (default true)'),
    macro: str('A Proxmox macro instead of proto and ports: SSH, HTTPS'),
    proto: str('tcp, udp, icmp, …'),
    source: str('Where from: an address, a range or an alias'),
    dest: str('Where to: an address, a range or an alias'),
    sport: str('Source ports: 1024:65535'),
    dport: str('Destination ports: 443, 8000:8100'),
    iface: str('The guest’s network device: net0'),
    log: str('Log level: nolog, info, warning, …'),
    comment: str('A short note'),
  }),
  description: 'add_rule, update_rule: the rule (an update sends only what changes)',
};

/**
 * What `mac_screen` does (Whombat macos-servers.md): only `look` doesn't change anything, and it doesn't ask; it is still
 * an owner's step, since a screenshot shows the person's whole desktop.
 */
export const MAC_SCREEN_ACTIONS = [
  'look',
  'click',
  'double_click',
  'right_click',
  'drag',
  'scroll',
  'type',
  'keys',
  'unlock',
  'password',
];
/** What `mac_ui` does: `apps` and `list` only read (and don't ask), as owner's steps like a look. */
export const MAC_UI_ACTIONS = ['apps', 'list', 'press', 'set', 'menu', 'focus', 'open'];

/** The hosts service's limits on a Mac's screen step, as the tools' schemas say them. */
const SL = HOST_SCREEN_LIMITS;
const SCREEN_PX = { minimum: 0, maximum: SL.position };
const SCROLL = { minimum: -SL.scroll, maximum: SL.scroll };

/**
 * The built-in Servers connection's tools (0.80, CT-342; one-whombat.md ONE-12): the hosts service through
 * `connection_call`, so keys, tiers, approvals and signed events apply. Since 0.81 (CT-355; proxmox.md PX-02) Whombat
 * can do what a person can on a Proxmox server: create, clone, convert and delete guests, grow and move disks, back up
 * and restore, backup jobs, ISO images and container templates, tasks, firewall, high availability, replication and the
 * server's own power. Since 0.83 (CT-366; incus-unraid.md IU-04…IU-06) the same on Incus (configuration with devices
 * and profiles, create from an image, copy, rename, move, publish, backups, images, profiles, volumes, operations, the
 * instance log, network leases) and on Unraid (the array, parity, disks, the mover, plugins, notifications, container
 * updates, autostart); since 0.84 (CT-371; IU-13) on QEMU/KVM through libvirt (configuration with disks, CD/DVD and
 * network cards, create from an OS type, clone, rename, delete, backups, pool volumes, ISO images, leases, the QEMU
 * log, tasks, `libvirt_overview`); since 0.85 (CT-378; server-signin.md SI-10) `server_add`, which only puts a card
 * in the conversation that opens Add a server filled in (the person signs in there; the model never sees the password);
 * since 0.98 (CT-505; server-updates.md SWU-08) `server_updates` and `server_update`: a server's operating-system
 * updates, checked for and installed as a task; `mac_screen` and `mac_ui` (Whombat macos-servers.md): a Mac's
 * screen by position and its apps by name, each step but a look or a list asking unless the server is set not to.
 * Whatever destroys or moves something always asks: `guest_delete`, `guest_template`,
 * `guest_migrate`, `guest_move`, `server_power` and `server_command` whole, and by their `action`
 * (`SERVERS_SENSITIVE`) stopping, shutting down, rebooting and pausing a guest, restoring or deleting a snapshot or a
 * backup, moving a disk, deleting an image, template, backup job, profile or volume, stopping an Unraid array,
 * cancelling a parity check, updating a plugin or a container, and installing a server's updates.
 */
export const SERVERS_TOOLS: readonly ConnectionToolDef[] = [
  {
    name: 'servers_overview',
    title: 'Servers at a glance',
    description:
      'Every server with its status, processor, memory, storage, hottest sensor, guests running and open alerts, and the name the person gave it (`name`; call it that to them).',
    access: 'read',
    inputSchema: obj({}),
  },
  {
    name: 'server_detail',
    title: 'A server in detail',
    description:
      'One server: facts, live load, sensors, disks and SMART, storage, updates and failed services, hints, for Proxmox the cluster, storages and backups, for Incus its projects, pools and images, for Unraid the array and parity, for QEMU/KVM (libvirt) its pools and networks. Whether one of its guests is this Whombat itself.',
    access: 'read',
    inputSchema: obj({ server: SERVER }, ['server']),
  },
  {
    name: 'server_metrics',
    title: 'A server’s history',
    description:
      'A server’s history for a range (1h, 6h, 24h, 7d, 30d, 90d): processor, memory, temperature and network by default, with average and peak.',
    access: 'read',
    inputSchema: obj(
      {
        server: SERVER,
        range: str('1h, 6h, 24h, 7d, 30d or 90d', {
          enum: ['1h', '6h', '24h', '7d', '30d', '90d'],
          default: '24h',
        }),
        series: {
          type: 'array',
          items: { type: 'string' },
          description: 'Series names (cpu_pct, mem_pct, temp_max_c, net_rx_mbps, net_tx_mbps)',
        },
      },
      ['server'],
    ),
  },
  {
    name: 'guests_list',
    title: 'List guests',
    description: 'VMs and containers on one server or all of them, with state, processor and memory use.',
    access: 'read',
    inputSchema: obj({
      server: str('Only this server (optional)'),
      q: str('Words in the name, id or image (optional)'),
      state: str('running, stopped or unhealthy (optional)', { enum: ['running', 'stopped', 'unhealthy'] }),
    }),
  },
  {
    name: 'guest_detail',
    title: 'A guest in detail',
    description:
      'One VM or container: state, resources, addresses, snapshots, last backup and what may be done to it.',
    access: 'read',
    inputSchema: obj({ server: SERVER, guest: GUEST }, ['server', 'guest']),
  },
  {
    name: 'guest_config',
    title: 'Read a guest’s settings',
    description:
      'A Proxmox, Incus or QEMU/KVM guest’s configuration as the platform stores it, with its digest (pass it to guest_config_set), which values wait for a restart, the keys Whombat doesn’t change, and for Incus its profiles and devices. A QEMU/KVM VM’s keys read like Proxmox’s: vcpus, memory_mb, autostart, boot, disk0, cdrom0, net0.',
    access: 'read',
    inputSchema: obj({ server: SERVER, guest: GUEST }, ['server', 'guest']),
  },
  {
    name: 'guest_snapshots',
    title: 'A guest’s snapshots',
    description:
      'A guest’s snapshots by name (pass one to guest_snapshot), with when each was taken and what it is for.',
    access: 'read',
    inputSchema: obj({ server: SERVER, guest: GUEST }, ['server', 'guest']),
  },
  {
    name: 'guest_backups',
    title: 'Backups',
    description:
      'The backups on a Proxmox server’s storages or of its Incus instances or QEMU/KVM VMs, or one guest’s: the volume (pass it to guest_backup), storage, size, when, notes, whether it is protected and when an Incus backup expires.',
    access: 'read',
    inputSchema: obj(
      {
        server: SERVER,
        guest: str('Only this guest’s backups (optional): pve:101, incus:web, libvirt:win11'),
      },
      ['server'],
    ),
  },
  {
    name: 'guest_firewall',
    title: 'A guest’s firewall',
    description:
      'A Proxmox guest’s firewall: whether it is on, its options, and its rules in order with their positions (for guest_firewall_set).',
    access: 'read',
    inputSchema: obj({ server: SERVER, guest: GUEST }, ['server', 'guest']),
  },
  {
    name: 'server_choices',
    title: 'What a server offers',
    description:
      'What a Proxmox, Incus or QEMU/KVM server offers for a new guest, a clone, a backup or a download: storages or pools and what each holds, network bridges or networks, ISO images, container templates, templates, the next free id, processor types, the other cluster nodes, for Incus its projects, profiles, local images and the common images to download, and for QEMU/KVM the OS types (os_variant) and whether it has UEFI, Secure Boot and a TPM.',
    access: 'read',
    inputSchema: obj(
      {
        server: SERVER,
        project: str('Incus: the project whose pools, networks and profiles to list (optional)'),
      },
      ['server'],
    ),
  },
  {
    name: 'backup_jobs',
    title: 'Backup jobs',
    description:
      'A server’s scheduled backup jobs: when each runs, where to, which guests, how many backups it keeps, whether it is on and its next run.',
    access: 'read',
    inputSchema: obj({ server: SERVER }, ['server']),
  },
  {
    name: 'storage_contents',
    title: 'ISO images and templates',
    description:
      'The ISO images, container templates and disk images on a Proxmox server’s storages, the ISO images of a QEMU/KVM server’s pools and Unraid’s ISO folder, or with appliances true the container templates Proxmox can download.',
    access: 'read',
    inputSchema: obj(
      {
        server: SERVER,
        storage: str('Only this storage (optional): local; on QEMU/KVM a pool, or folder:isos on Unraid'),
        content: str('Only iso, vztmpl (container templates) or import (disk images) (optional)', {
          enum: ['iso', 'vztmpl', 'import'],
        }),
        appliances: bool('List the container templates Proxmox offers to download instead (default false)', {
          default: false,
        }),
      },
      ['server'],
    ),
  },
  {
    name: 'server_tasks',
    title: 'Tasks',
    description:
      'A server’s recent tasks, newest first, or one task with its state and log: Proxmox tasks, Incus operations (backups, copies, restores, moves), Unraid commands (the array, parity, plugin and container updates, the mover) and QEMU/KVM jobs (clones, backups, restores, downloads, disk copies).',
    access: 'read',
    inputSchema: obj(
      {
        server: SERVER,
        guest: str('Only this guest’s tasks (optional)'),
        task: str('One task’s id from this list, for its state and log (optional)'),
      },
      ['server'],
    ),
  },
  {
    name: 'incus_overview',
    title: 'Incus at a glance',
    description:
      'An Incus server’s own things: the Incus version, projects with their instances, storage pools with their use, networks, profiles, images and custom volumes with the guests using them.',
    access: 'read',
    inputSchema: obj({ server: SERVER }, ['server']),
  },
  {
    name: 'incus_profile',
    title: 'An Incus profile',
    description:
      'One Incus profile whole: its settings and devices, the instances using it, the keys Whombat doesn’t change, and its digest (pass it to incus_profile_set).',
    access: 'read',
    inputSchema: obj(
      {
        server: SERVER,
        profile: str('The profile’s name as incus_overview lists it: default'),
        project: str('Its project (optional; default)'),
      },
      ['server', 'profile'],
    ),
  },
  {
    name: 'network_leases',
    title: 'Who has which address',
    description:
      'The addresses a managed Incus network or a QEMU/KVM (libvirt) network handed out: host name, address, MAC address and which guest it is.',
    access: 'read',
    inputSchema: obj(
      {
        server: SERVER,
        network: str('The network’s name as incus_overview or libvirt_overview lists it: incusbr0, default'),
        project: str('Incus: its project (optional; default)'),
      },
      ['server', 'network'],
    ),
  },
  {
    name: 'guest_log',
    title: 'An instance’s log',
    description:
      'The last lines of an Incus instance’s or a QEMU/KVM VM’s own log (how it started and stopped), to see why it doesn’t start. For a Docker container’s output use guest_detail’s console instead.',
    access: 'read',
    inputSchema: obj(
      {
        server: SERVER,
        guest: GUEST,
        lines: int('How many of the last lines (default 500, at most 2000)', {
          minimum: 1,
          maximum: 2000,
          default: 500,
        }),
      },
      ['server', 'guest'],
    ),
  },
  {
    name: 'unraid_overview',
    title: 'Unraid at a glance',
    description:
      'An Unraid server’s own things: the array and its state, parity (running, the last check, history, schedule), every disk with its temperature, errors and spin state, pools, shares, plugins with updates, unread notifications, and whether a newer Unraid exists.',
    access: 'read',
    inputSchema: obj({ server: SERVER }, ['server']),
  },
  {
    name: 'libvirt_overview',
    title: 'QEMU/KVM at a glance',
    description:
      'A server’s QEMU/KVM (libvirt) things: the libvirt and QEMU versions, storage pools with their use, networks, Unraid’s VM and ISO folders, whether new VMs can have UEFI, Secure Boot and a TPM, and where VM backups go. Works on every server that runs libvirt, Unraid too.',
    access: 'read',
    inputSchema: obj({ server: SERVER }, ['server']),
  },
  {
    name: 'guest_power',
    title: 'Start, stop or restart a guest',
    description:
      'Start, stop, shut down, reboot, pause or resume a VM or container. Stopping, shutting down, rebooting and pausing always ask a person.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        guest: GUEST,
        action: str('start, stop, shutdown, reboot, pause or resume', {
          enum: ['start', 'stop', 'shutdown', 'reboot', 'pause', 'resume'],
        }),
      },
      ['server', 'guest', 'action'],
    ),
  },
  {
    name: 'guest_config_set',
    title: 'Change a guest’s settings',
    description:
      'Change a Proxmox, Incus or QEMU/KVM guest’s configuration: set, delete or revert keys, with the digest from guest_config. Some values apply at the next restart; deleting an unused disk needs confirm. Incus: also its devices (network cards on an Incus network or a host bridge, disks on a pool, never a host folder), its profiles and its snapshot schedule (snapshots.schedule). QEMU/KVM: insert or eject an ISO with cdrom0 (works while it runs), add a disk with disk1 set to new=20G,storage=default, a network card with net1, delete a disk key to detach it (the file stays).',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        guest: GUEST,
        digest: str('The digest guest_config gave'),
        set: strMap(
          'Keys to set: {"memory": "8192"}; QEMU/KVM: {"memory_mb": "8192", "cdrom0": "source=empty"}',
        ),
        delete: strList('Keys to remove'),
        revert: strList('Changes waiting for a restart to undo, by key'),
        confirm: bool('True to delete an unused disk for good (delete: ["unused0"])', { default: false }),
        devices: {
          type: 'object',
          additionalProperties: {
            anyOf: [{ type: 'object', additionalProperties: { type: 'string' } }, { type: 'null' }],
          },
          description:
            'Incus: devices to add or change by name, null to remove one: {"eth1": {"type": "nic", "network": "incusbr0"}, "data": {"type": "disk", "pool": "default", "source": "data", "path": "/data"}}',
        },
        profiles: strList('Incus: the profiles it uses, in order (replaces the list): ["default", "web"]'),
      },
      ['server', 'guest', 'digest'],
    ),
  },
  {
    name: 'guest_snapshot',
    title: 'Snapshots',
    description:
      'Create a snapshot of a guest, or restore or delete one. Restoring and deleting always ask a person.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        guest: GUEST,
        action: str('create, restore or delete', { enum: ['create', 'restore', 'delete'] }),
        name: str('The snapshot’s name (letters, digits, . _ -); create picks one when left out'),
        description: str('What it is for (create)'),
      },
      ['server', 'guest', 'action'],
    ),
  },
  {
    name: 'guest_migrate',
    title: 'Move a guest to another node',
    description:
      'Move a Proxmox guest to another node of its cluster: a running VM keeps running, a running container restarts. Asks a person first unless the server is set not to ask.',
    access: 'write',
    sensitive: true,
    inputSchema: obj(
      {
        server: SERVER,
        guest: GUEST,
        target: str('The node to move it to'),
        storage: str('The storage on that node for its local disks (optional; the same name otherwise)'),
      },
      ['server', 'guest', 'target'],
    ),
  },
  {
    name: 'guest_create',
    title: 'Create a guest',
    description:
      'Create a VM or container on Proxmox, Incus or QEMU/KVM. On Proxmox a VM installs from an ISO image and a container starts from a template; on Incus both start from an image, in a project, with profiles, a pool and a network; on QEMU/KVM a VM starts from an OS type (Windows 11 gets UEFI and a TPM) and installs from an ISO image. server_choices lists them. Other settings use the platform’s own keys.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        kind: str('vm or container (QEMU/KVM: vm)', { enum: ['vm', 'container'] }),
        name: str('Its name: letters, digits and - (web-01)'),
        id: NEW_GUEST_ID('Proxmox: its number (optional; the next free one)'),
        cores: int('Processor cores (optional)', { minimum: 1, maximum: 512 }),
        memory_mb: int('Memory in MB (optional): 2048', { minimum: 16 }),
        disk_gb: int('Its disk’s size in GB (optional)', { minimum: 1 }),
        storage: str(
          'Proxmox and QEMU/KVM: the storage for its disk (optional): local-lvm; on QEMU/KVM a pool, or folder:domains on Unraid',
        ),
        bridge: str('Proxmox and QEMU/KVM: the host’s network bridge (optional): vmbr0, br0'),
        iso: str(
          'Proxmox and QEMU/KVM VMs: the ISO image to install from, as server_choices lists it: local:iso/debian-13.iso',
        ),
        os_variant: str('QEMU/KVM: the OS type as server_choices lists it (optional): debian13, win11'),
        template: str(
          'Proxmox containers: the template (local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst); Incus: the image, a local alias or one of the common images (images:debian/13)',
        ),
        project: str('Incus: the project (optional; default)'),
        profiles: strList('Incus: its profiles in order (optional; ["default"])'),
        pool: str('Incus: the storage pool for its disk (optional; the profile’s)'),
        network: str(
          'Incus and QEMU/KVM: the network for its network card (optional; on Incus the profile’s): incusbr0, default',
        ),
        cloud_init: str('Incus /cloud images: cloud-init user data, at most 64 KiB (optional)', {
          maxLength: 65536,
        }),
        password: str('Containers: the root password (optional)'),
        ssh_keys: str('Containers: public SSH keys for root, one per line (optional)'),
        start: bool('Start it once it is made (default false)', { default: false }),
        settings: strMap(
          'Other settings in the platform’s own keys (optional): {"onboot": "1", "ostype": "win11"}; QEMU/KVM: {"autostart": "1", "cpu_mode": "host-passthrough"}',
        ),
      },
      ['server', 'kind', 'name'],
    ),
  },
  {
    name: 'guest_clone',
    title: 'Clone a guest',
    description:
      'Copy a Proxmox or Incus VM or container or a stopped QEMU/KVM VM (its disks copied, a new identity), or make a new one from a Proxmox template, under a new name.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        guest: str('The guest or template to copy: pve:9000, incus:web, libvirt:debian'),
        name: str('The copy’s name: letters, digits and -'),
        id: NEW_GUEST_ID('Proxmox: the copy’s number (optional; the next free one)'),
        full: bool(
          'Proxmox: copy every disk (true), or link to a template’s disks (false; templates only). Left out: linked from a template, a full copy otherwise',
        ),
        storage: str(
          'The storage for the copy’s disks (optional; on Proxmox full copies only); on Incus and QEMU/KVM the pool, or folder:domains on Unraid',
        ),
        project: str('Incus: the project to copy it into (optional; its own)'),
        instance_only: bool('Incus: copy it without its snapshots (default false)', { default: false }),
      },
      ['server', 'guest', 'name'],
    ),
  },
  {
    name: 'guest_template',
    title: 'Turn a guest into a template',
    description:
      'Turn a stopped Proxmox guest into a template to clone new guests from. It can’t be started again. Asks a person first unless the server is set not to ask.',
    access: 'write',
    sensitive: true,
    inputSchema: obj({ server: SERVER, guest: GUEST }, ['server', 'guest']),
  },
  {
    name: 'guest_delete',
    title: 'Delete a guest',
    description:
      'Delete a stopped Proxmox, Incus or QEMU/KVM VM or container with its disks, for good. Asks a person first unless the server is set not to ask.',
    access: 'write',
    sensitive: true,
    inputSchema: obj(
      {
        server: SERVER,
        guest: GUEST,
        purge: bool(
          'Proxmox: also take it out of backup jobs, replication and high availability; QEMU/KVM: also delete its disks and firmware settings, false keeps the files (default true)',
          {
            default: true,
          },
        ),
      },
      ['server', 'guest'],
    ),
  },
  {
    name: 'guest_disk',
    title: 'Grow or move a disk',
    description:
      'Grow a Proxmox, Incus or QEMU/KVM guest’s disk (disks only grow, a running QEMU/KVM VM’s too), or move a Proxmox disk to another storage (an Incus guest moves whole with guest_move). Moving asks a person first unless the server is set not to ask.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        guest: GUEST,
        action: str('resize or move', { enum: ['resize', 'move'] }),
        disk: str(
          'The disk’s key as guest_config lists it: scsi0, rootfs, mp0; on Incus the device: root; on QEMU/KVM disk0',
        ),
        size: str('resize: the new size, or how much to add: 64G, +10G'),
        storage: str('move: the storage to move it to'),
        delete_source: bool(
          'move: remove the old copy afterwards; else it stays as an unused disk (default false)',
          {
            default: false,
          },
        ),
      },
      ['server', 'guest', 'action', 'disk'],
    ),
  },
  {
    name: 'guest_backup',
    title: 'Back up or restore a guest',
    description:
      'Back up a Proxmox, Incus or QEMU/KVM guest now (a QEMU/KVM VM while it runs too), restore a backup over its guest or as a new one (on Incus and QEMU/KVM always as a new one), protect or unprotect a Proxmox backup, change its notes, or delete a backup. Restoring and deleting always ask a person.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        guest: str('The guest: to back up, or to restore over'),
        action: str('create, restore, protect, unprotect, notes or delete', {
          enum: ['create', 'restore', 'protect', 'unprotect', 'notes', 'delete'],
        }),
        backup: str('The backup’s volume as guest_backups lists it (all but create)'),
        storage: str('create: where to store it; restore: the storage for its disks (optional)'),
        mode: BACKUP_MODE('create: '),
        notes: str('create, notes: the backup’s notes'),
        as_new: bool('restore: as a new guest instead of over the one it came from (default false)', {
          default: false,
        }),
        id: NEW_GUEST_ID('Proxmox restore as new: the new guest’s number (optional; the next free one)'),
        name: str(
          'Incus: create: the backup’s name (optional); Incus and QEMU/KVM restore: the new guest’s name (optional; <name>-restored)',
        ),
        expires_days: int('Incus create: days until Incus deletes it by itself (default 7)', {
          minimum: 1,
          maximum: 3650,
          default: 7,
        }),
        start: bool('Incus and QEMU/KVM restore: start the new guest once it is made (default false)', {
          default: false,
        }),
        compress: bool('QEMU/KVM create: compress the copied disks (default false)', { default: false }),
      },
      ['server', 'action'],
    ),
  },
  {
    name: 'backup_job_set',
    title: 'Change backup jobs',
    description:
      'Create, change, pause, resume, delete or run now a scheduled backup job, or add a guest to one or take it out. Deleting asks a person first unless the server is set not to ask.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        action: str('create, update, pause, resume, delete, run, add_guest or remove_guest', {
          enum: ['create', 'update', 'pause', 'resume', 'delete', 'run', 'add_guest', 'remove_guest'],
        }),
        job: str('The job’s id as backup_jobs lists it (all but create)'),
        guest: str('add_guest, remove_guest: the guest; create: its first guest: pve:101'),
        schedule: str('When it runs, in Proxmox’s words: 04:00, sat 02:00, mon..fri 21:30'),
        storage: str('Where the backups go: a storage server_choices lists'),
        mode: BACKUP_MODE(''),
        keep: BACKUP_KEEP,
        selection: str('all (every guest), guests (the ones added) or pool', {
          enum: ['all', 'guests', 'pool'],
        }),
        pool: str('selection pool: the pool’s name'),
        comment: str('A short note on the job'),
      },
      ['server', 'action'],
    ),
  },
  {
    name: 'backup_place_nfs',
    title: 'Share a folder for backups',
    description:
      'On an Unraid server with NFS on, or a TrueNAS connected with Manage (server connection:<id>, as the care plan names it), make a share for another server’s backups and share it over NFS with exactly that server’s addresses (never over SMB). Doing it again adds addresses. Answers the address and the folder to give proxmox_storage_add.',
    access: 'write',
    inputSchema: obj(
      {
        server: str(
          'The Unraid server that keeps the backups, as servers_overview lists it (blackbox), or the TrueNAS the care plan names (connection:<id>)',
        ),
        name: str('The share’s name: whombat-<server>, like whombat-pve-01'),
        clients: { ...strList('The IPv4 addresses of the server whose backups go there'), minItems: 1 },
      },
      ['server', 'name', 'clients'],
    ),
  },
  {
    name: 'proxmox_storage_add',
    title: 'Add backup storage',
    description:
      'Add a folder shared over NFS to a Proxmox server as storage for backups (then backup_job_set can save there). Doing it again with the same address and folder changes nothing.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        storage: str('The storage’s name in Proxmox: blackbox-backup'),
        nfs_server: str('The address that shares the folder, from backup_place_nfs: 10.100.0.40'),
        export: str('The folder, from backup_place_nfs: /mnt/user/whombat-pve-01'),
      },
      ['server', 'storage', 'nfs_server', 'export'],
    ),
  },
  {
    name: 'storage_content',
    title: 'ISO images and templates: download or delete',
    description:
      'Download an ISO image or a disk image from a web address to a storage (on QEMU/KVM an ISO image to a pool or Unraid’s ISO folder), fetch a container template Proxmox offers, or delete one no guest uses. Deleting asks a person first unless the server is set not to ask.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        action: str('download, get_template or delete', { enum: ['download', 'get_template', 'delete'] }),
        storage: str(
          'The storage, as server_choices lists it: local; on QEMU/KVM a pool, or folder:isos on Unraid',
        ),
        content: str('download: iso, vztmpl (a container template) or import (a disk image); QEMU/KVM: iso', {
          enum: ['iso', 'vztmpl', 'import'],
        }),
        url: str('download: the http(s) address'),
        filename: str('download: the file’s name with its extension: debian-13.iso'),
        checksum: str('download: its checksum, to check the file (optional)'),
        checksum_algorithm: str('download: md5, sha1, sha224, sha256, sha384 or sha512', {
          enum: ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'],
        }),
        template: str('get_template: the template’s name as storage_contents lists it with appliances true'),
        volume: str('delete: the volume as storage_contents lists it: local:iso/debian-13.iso'),
      },
      ['server', 'action', 'storage'],
    ),
  },
  {
    name: 'task_stop',
    title: 'Stop a task',
    description:
      'Stop a running task on a server: a Proxmox backup, clone, restore or move, an Incus operation server_tasks says can be stopped, or a QEMU/KVM backup or disk copy.',
    access: 'write',
    inputSchema: obj({ server: SERVER, task: str('The task’s id as server_tasks lists it') }, [
      'server',
      'task',
    ]),
  },
  {
    name: 'guest_firewall_set',
    title: 'Change a guest’s firewall',
    description:
      'Turn a Proxmox guest’s firewall on or off, change its options, or add, change, delete or move a rule (positions as guest_firewall lists them).',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        guest: GUEST,
        action: str('enable, disable, options, add_rule, update_rule, delete_rule or move_rule', {
          enum: ['enable', 'disable', 'options', 'add_rule', 'update_rule', 'delete_rule', 'move_rule'],
        }),
        rule: FIREWALL_RULE,
        pos: int('update_rule, delete_rule, move_rule: the rule’s position', { minimum: 0 }),
        to: int('move_rule: its new position', { minimum: 0 }),
        options: strMap('options: the options to set: {"policy_in": "DROP", "dhcp": "1"}'),
      },
      ['server', 'guest', 'action'],
    ),
  },
  {
    name: 'guest_ha',
    title: 'High availability',
    description:
      'Have a Proxmox cluster keep a guest running and move it when its node fails, change how, or stop that.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        guest: GUEST,
        action: str('set or remove', { enum: ['set', 'remove'] }),
        state: str('set: started (the default), stopped, ignored or disabled', {
          enum: ['started', 'stopped', 'ignored', 'disabled'],
        }),
        max_restart: int('set: restarts on its node before it moves (default 1)', {
          minimum: 0,
          maximum: 10,
        }),
        max_relocate: int('set: moves to another node before it gives up (default 1)', {
          minimum: 0,
          maximum: 10,
        }),
      },
      ['server', 'guest', 'action'],
    ),
  },
  {
    name: 'guest_replication',
    title: 'Replication',
    description:
      'Copy a Proxmox guest’s disks to another node of its cluster on a schedule, or stop a replication job.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        guest: GUEST,
        action: str('add or delete', { enum: ['add', 'delete'] }),
        target: str('add: the node to copy to'),
        schedule: str('add: how often, in Proxmox’s words (default */15, every 15 minutes)'),
        job: str('delete: the job’s id as guest_config lists it: 101-0'),
      },
      ['server', 'guest', 'action'],
    ),
  },
  {
    name: 'guest_rename',
    title: 'Rename an instance',
    description: 'Give a stopped Incus instance or QEMU/KVM VM a new name. Its id changes with it.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        guest: GUEST,
        name: str(
          'The new name. Incus: a letter first, then letters, digits and -, at most 63; QEMU/KVM: a letter or digit first, then letters, digits, . _ and -, at most 64',
          { pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' },
        ),
      },
      ['server', 'guest', 'name'],
    ),
  },
  {
    name: 'guest_move',
    title: 'Move an instance',
    description:
      'Move a stopped Incus instance to another storage pool or project. Its id changes when the project does. Asks a person first unless the server is set not to ask.',
    access: 'write',
    sensitive: true,
    inputSchema: obj(
      {
        server: SERVER,
        guest: GUEST,
        pool: str('The pool to move it to (optional)'),
        project: str('The project to move it to (optional)'),
      },
      ['server', 'guest'],
    ),
  },
  {
    name: 'guest_publish',
    title: 'Make an image of an instance',
    description:
      'Make an Incus image of a stopped instance, or of one of its snapshots while it runs, to create new instances from.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        guest: GUEST,
        alias: str('A name for the image (optional): web-base'),
        description: str('What the image is for (optional)'),
        snapshot: str('Make it of this snapshot instead (optional; the instance may keep running)'),
      },
      ['server', 'guest'],
    ),
  },
  {
    name: 'incus_image',
    title: 'Incus images',
    description:
      'Download an image to an Incus server from the images server, refresh one, or delete one. Deleting asks a person first unless the server is set not to ask.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        action: str('download, refresh or delete', { enum: ['download', 'refresh', 'delete'] }),
        alias: str(
          'download: the image, as server_choices lists it or any alias of the images server: debian/13',
        ),
        type: str('download: container or virtual-machine (default container)', {
          enum: ['container', 'virtual-machine'],
          default: 'container',
        }),
        image: str('refresh, delete: the image’s fingerprint as incus_overview lists it'),
        project: str('The project (optional; default)'),
      },
      ['server', 'action'],
    ),
  },
  {
    name: 'incus_profile_set',
    title: 'Change Incus profiles',
    description:
      'Create an Incus profile (empty or as a copy), change one’s settings, devices or description with the digest from incus_profile, or delete one nothing uses. Deleting asks a person first unless the server is set not to ask.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        action: str('create, update or delete', { enum: ['create', 'update', 'delete'] }),
        profile: str('The profile’s name'),
        project: str('Its project (optional; default)'),
        digest: str('update: the digest incus_profile gave'),
        set: strMap('update: keys to set: {"limits.memory": "2GiB"}'),
        delete: strList('update: keys to remove'),
        devices: {
          type: 'object',
          additionalProperties: {
            anyOf: [{ type: 'object', additionalProperties: { type: 'string' } }, { type: 'null' }],
          },
          description:
            'update: devices to add or change by name, null to remove one: {"eth0": {"type": "nic", "network": "incusbr0"}}',
        },
        description: str('create, update: what the profile is for'),
        copy_from: str('create: the profile to copy (optional)'),
      },
      ['server', 'action', 'profile'],
    ),
  },
  {
    name: 'storage_volume',
    title: 'Storage volumes',
    description:
      'Create a volume on an Incus or QEMU/KVM storage pool, grow one, or delete one no guest uses. Attach it with guest_config_set (Incus devices, QEMU/KVM disk1 with source=pool/volume). Deleting asks a person first unless the server is set not to ask.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        action: str('create, resize or delete', { enum: ['create', 'resize', 'delete'] }),
        pool: str('The pool as incus_overview or libvirt_overview lists it: default'),
        volume: str('The volume’s name'),
        size: str('create, resize: its size (volumes only grow): 10GiB'),
        content_type: str('Incus create: filesystem (the default) or block', {
          enum: ['filesystem', 'block'],
          default: 'filesystem',
        }),
        project: str('Incus: its project (optional; default)'),
      },
      ['server', 'action', 'pool', 'volume'],
    ),
  },
  {
    name: 'unraid_array',
    title: 'The Unraid array',
    description:
      'Start or stop an Unraid server’s array, check parity (with or without corrections), pause, resume or cancel a check, spin disks up or down, run the mover, or archive notifications. Stopping the array and cancelling a parity check always ask a person.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        action: str(
          'start, stop, parity_check, parity_pause, parity_resume, parity_cancel, spin_up, spin_down, mover or archive_notifications',
          {
            enum: [
              'start',
              'stop',
              'parity_check',
              'parity_pause',
              'parity_resume',
              'parity_cancel',
              'spin_up',
              'spin_down',
              'mover',
              'archive_notifications',
            ],
          },
        ),
        correct: bool('parity_check: write corrections to parity (default false: only check)', {
          default: false,
        }),
        disk: str('spin_up, spin_down: a disk’s name as unraid_overview lists it (disk1, parity), or all'),
        notification: str('archive_notifications: one notification’s id (optional; all when left out)'),
      },
      ['server', 'action'],
    ),
  },
  {
    name: 'unraid_plugins',
    title: 'Unraid plugins',
    description:
      'Check an Unraid server’s plugins for updates, or update one or all of them (never Unraid itself: update that in Unraid). Updating asks a person first unless the server is set not to ask.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        action: str('check or update', { enum: ['check', 'update'] }),
        plugin: str('update: the plugin’s file as unraid_overview lists it, or all'),
      },
      ['server', 'action'],
    ),
  },
  {
    name: 'container_update',
    title: 'Update a container',
    description:
      'Update a Docker container on an Unraid server from its template (its newest image, its settings kept), or check every container for updates. Updating asks a person first unless the server is set not to ask.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        action: str('update or check', { enum: ['update', 'check'] }),
        guest: str('update: the container as guests_list lists it: docker:plex'),
      },
      ['server', 'action'],
    ),
  },
  {
    name: 'guest_autostart',
    title: 'Start with the server',
    description:
      'Have a Docker container on an Unraid server, or a libvirt VM, start when its server starts, or not.',
    access: 'write',
    inputSchema: obj(
      { server: SERVER, guest: GUEST, on: bool('True: start with the server; false: don’t') },
      ['server', 'guest', 'on'],
    ),
  },
  {
    name: 'alerts_list',
    title: 'Open alerts',
    description:
      'Open alerts and hints of one server or all, most severe first, with whether someone acknowledged them.',
    access: 'read',
    inputSchema: obj({ server: str('Only this server (optional)') }),
  },
  {
    name: 'alert_snooze',
    title: 'Snooze an alert',
    description: 'Acknowledge an alert, or snooze it for some minutes, with a short note.',
    access: 'write',
    inputSchema: obj(
      {
        alert: str('The alert’s id from alerts_list'),
        minutes: {
          type: 'integer',
          minimum: 0,
          maximum: 43200,
          description: '0 until it resolves, else 1 to 43200',
        },
        note: str('Why (optional)'),
      },
      ['alert'],
    ),
  },
  {
    name: 'server_diagnose',
    title: 'Run read-only checks',
    description:
      'Run read-only checks on a server (disks, services, logs, network, memory) and get their output. Changes nothing.',
    access: 'read',
    inputSchema: obj(
      {
        server: SERVER,
        check: str('One check’s name; leave out to see the list'),
        args: strMap(
          'The check’s arguments as the list names them (optional): {"grep": "sdc", "since": "2h"}',
          {
            maxProperties: 16,
          },
        ),
      },
      ['server'],
    ),
  },
  {
    name: 'server_disk_usage',
    title: 'Find out what fills a disk',
    description:
      'Measure what fills one mounted filesystem on a server right now (on request, read-only, low priority, skips spun-down disks): container images and build cache, container volumes and logs, the system journal, package caches, VM disks and snapshots where known, and the largest folders. The server page shows recent results.',
    access: 'read',
    inputSchema: obj(
      {
        server: SERVER,
        mount: str(
          'The mount point to measure, as server_detail lists it (/, /var/lib/docker, /mnt/cache). Leave out to check the fullest local filesystem.',
        ),
      },
      ['server'],
    ),
  },
  {
    name: 'server_command',
    title: 'Run a command on a server',
    description:
      'Run one shell command on a server as root, with a reason a person reads first. Output is capped. Asks a person first unless the server is set not to ask.',
    access: 'write',
    sensitive: true,
    inputSchema: obj(
      { server: SERVER, command: str('The command, one line'), reason: str('Why, in plain words') },
      ['server', 'command', 'reason'],
    ),
  },
  {
    name: 'server_power',
    title: 'Restart or shut down a server',
    description:
      'Reboot or shut down a server itself, and with it every guest running on it. Asks a person first unless the server is set not to ask.',
    access: 'write',
    sensitive: true,
    inputSchema: obj(
      { server: SERVER, action: str('reboot or shutdown', { enum: ['reboot', 'shutdown'] }) },
      ['server', 'action'],
    ),
  },
  {
    name: 'mac_screen',
    title: 'Use a Mac’s screen',
    description:
      'A Mac’s screen: look (a screenshot), or click, double_click, right_click, drag, scroll, type, keys or unlock, by position in the screen’s pixels; password types the Mac’s password into a macOS password prompt in front (you never see it). Each step answers with a fresh look. Steps but look ask a person first unless the server is set not to ask.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        action: str('look, click, double_click, right_click, drag, scroll, type, keys, unlock or password', {
          enum: MAC_SCREEN_ACTIONS,
        }),
        x: int('Pixels from the left, as screen_w counts them (click, drag start)', SCREEN_PX),
        y: int('Pixels from the top (click, drag start)', SCREEN_PX),
        to_x: int('drag: where to, from the left', SCREEN_PX),
        to_y: int('drag: where to, from the top', SCREEN_PX),
        dx: int(`scroll: steps right (negative: left), at most ${SL.scroll}`, SCROLL),
        dy: int(`scroll: steps down (negative: up), at most ${SL.scroll}`, SCROLL),
        text: str('type: the text', { maxLength: SL.typeText }),
        keys: str('keys: cmd+q, return, cmd+shift+4, tab tab space', { maxLength: SL.keys }),
      },
      ['server', 'action'],
    ),
  },
  {
    name: 'mac_ui',
    title: 'Use a Mac’s apps by name',
    description:
      'A Mac’s apps through Whombat Helper: apps (what runs), list (an app’s buttons and fields), press, set (type into a field), menu, focus (bring an app forward), open (accessibility, an app or an https address). Steps but apps and list ask a person first unless the server is set not to ask.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        action: str('apps, list, press, set, menu, focus or open', { enum: MAC_UI_ACTIONS }),
        app: str('The app’s name or bundle id (left out: the one in front)', { maxLength: SL.name }),
        window: str('list: a window title, or part of it', { maxLength: SL.name }),
        name: str('press, set: the element’s title, description, value or identifier', {
          maxLength: SL.name,
        }),
        role: str(
          'press, set: button, checkbox, switch, text_field, menu_item, link, tab, row, popup, radio or any, or a comma list of them',
          { maxLength: SL.role },
        ),
        index: int('press, set: the n-th match, from 0', { minimum: 0, maximum: 1000 }),
        value: str('set: the text', { maxLength: SL.text }),
        path: {
          type: 'array',
          items: { type: 'string', maxLength: SL.name },
          description: 'menu: the menu bar path, ["File", "Save…"]',
          minItems: 1,
          maxItems: SL.path,
        },
        target: str('open: accessibility, an app’s name or an https address', { maxLength: SL.target }),
        limit: int('list: at most this many (default 300)', { minimum: 1, maximum: SL.list }),
      },
      ['server', 'action'],
    ),
  },
  {
    name: 'server_updates',
    title: 'A server’s updates',
    description:
      'The operating-system updates waiting on a server: its package manager, how many and how many for security, when it last checked and any error, whether it needs a restart and why, and the packages (name, installed and new version, security, source; at most 500), with the update task running now and how the last one ended.',
    access: 'read',
    inputSchema: obj({ server: SERVER }, ['server']),
  },
  {
    name: 'server_update',
    title: 'Install a server’s updates',
    description:
      'Check a server for operating-system updates, or install the waiting ones (all, or only the packages named) as a task; Whombat says in the chat when it ends. It never restarts the server, changes its repositories or upgrades it to a new release. Installing asks a person first unless the server is set not to ask.',
    access: 'write',
    inputSchema: obj(
      {
        server: SERVER,
        action: str('check (read the package lists again) or install', { enum: ['check', 'install'] }),
        packages: {
          type: 'array',
          items: { type: 'string', pattern: HOST_PACKAGE_NAME_PATTERN.source },
          minItems: 1,
          maxItems: HOST_PACKAGES_MAX,
          description:
            'install: only these packages, by name as server_updates lists them (optional; left out: everything waiting)',
        },
        reason: str('Why, in plain words'),
      },
      ['server', 'action', 'reason'],
    ),
  },
  {
    name: 'server_add',
    title: 'Ask the person to add a server',
    description:
      'Ask the person to add a server (Linux, or a Mac with macOS 13 or later): puts a card in the conversation that opens Add a server filled in; they sign in there. You never get the password.',
    access: 'read',
    inputSchema: obj(
      {
        address: str(
          'The server’s host name or IP address, with :port when SSH isn’t on 22: 10.100.0.40, pve-03.lan:2222',
        ),
        username: str(
          'The user to sign in as (optional; root when left out; on a Mac the user at its screen, so Whombat can use the screen too)',
        ),
        control: str(
          'What Whombat may do on it (optional): watch (read-only checks), operate (also consoles and power) or full (everything; the default)',
          { enum: ['watch', 'operate', 'full'] },
        ),
        name: str('What to call it in Whombat (optional; its host name when left out)'),
      },
      ['address'],
    ),
  },
];

/**
 * The Servers connection's calls that always ask by their `action` (CT-342; 0.81, CT-355): stopping, pausing and
 * restarting guests, restoring and deleting snapshots and backups, moving disks, deleting images, templates and backup
 * jobs; since 0.83 (CT-366) deleting an Incus image, profile or volume, stopping an Unraid array, cancelling a parity
 * check, updating a plugin or a container; since 0.98 (CT-505) installing a server's updates (checking never asks).
 * Each rule tests only the `action` argument (`arg`, CT-354), so a note or a name that says “delete” doesn't ask.
 */
export const SERVERS_SENSITIVE: readonly SensitiveRule[] = [
  {
    tools: ['guest_power'],
    arg: 'action',
    argValue: '^(stop|shutdown|reboot|pause)$',
    reason: 'Stopping, pausing or restarting a guest always asks',
  },
  {
    tools: ['guest_snapshot'],
    arg: 'action',
    argValue: '^(restore|delete)$',
    reason: 'Restoring or deleting a snapshot always asks',
  },
  {
    tools: ['guest_disk'],
    arg: 'action',
    argValue: '^move$',
    reason: 'Moving a disk always asks',
  },
  {
    tools: ['guest_backup'],
    arg: 'action',
    argValue: '^(restore|delete)$',
    reason: 'Restoring or deleting a backup always asks',
  },
  {
    tools: ['storage_content'],
    arg: 'action',
    argValue: '^delete$',
    reason: 'Deleting an image or template always asks',
  },
  {
    tools: ['backup_job_set'],
    arg: 'action',
    argValue: '^delete$',
    reason: 'Deleting a backup job always asks',
  },
  {
    tools: ['incus_image'],
    arg: 'action',
    argValue: '^delete$',
    reason: 'Deleting an image always asks',
  },
  {
    tools: ['incus_profile_set'],
    arg: 'action',
    argValue: '^delete$',
    reason: 'Deleting a profile always asks',
  },
  {
    tools: ['storage_volume'],
    arg: 'action',
    argValue: '^delete$',
    reason: 'Deleting a volume always asks',
  },
  {
    tools: ['unraid_array'],
    arg: 'action',
    argValue: '^(stop|parity_cancel)$',
    reason: 'Stopping the array or cancelling a parity check always asks',
  },
  {
    tools: ['unraid_plugins'],
    arg: 'action',
    argValue: '^update$',
    reason: 'Updating a plugin always asks',
  },
  {
    tools: ['container_update'],
    arg: 'action',
    argValue: '^update$',
    reason: 'Updating a container always asks',
  },
  {
    tools: ['server_update'],
    arg: 'action',
    argValue: '^install$',
    reason: 'Installing updates always asks',
  },
  {
    tools: ['mac_screen'],
    arg: 'action',
    argValue: '^(click|double_click|right_click|drag|scroll|type|keys|unlock|password)$',
    reason: 'Using a Mac’s screen asks',
  },
  {
    tools: ['mac_ui'],
    arg: 'action',
    argValue: '^(press|set|menu|focus|open)$',
    reason: 'Using a Mac’s apps asks',
  },
];

export const entry = {
  ...builtin(
    'whombat_servers',
    'Servers',
    'infrastructure',
    'Your servers, their VMs and containers, through Whombat’s own monitoring.',
    null,
  ),
  handle: 'servers',
  tools: [...SERVERS_TOOLS],
  sensitive: [...SERVERS_SENSITIVE],
  guide:
    'Start with servers_overview, then server_detail or guests_list; incus_overview, unraid_overview and libvirt_overview show Incus, Unraid or QEMU/KVM details. Filling disk: server_disk_usage (skips sleeping disks). server_add puts a card in chat to add a server; only the person signs in there. Read before you change: guest_config and incus_profile give the digest their _set tool needs; guest_snapshots, guest_backups, backup_jobs and server_choices the names and ids other tools take. Backups, clones, restores, moves and Unraid commands run as tasks: Whombat says when one ends; server_tasks shows progress. The guest this Whombat runs in can be read, snapshotted and backed up, not changed. Updates: server_updates lists what waits; server_update checks or installs them. Say what changed, offer a restart (server_power) if needed, update one cluster node at a time, never a new major release. On a Mac, press by name first (mac_ui press; list shows names); mac_screen look and click by position only if nothing matches; unlock a locked screen; password fills a macOS password prompt; mac_ui open accessibility when Whombat Helper lacks it. Never ask for a Mac’s password. Risky steps (deleting, restoring, moving, stopping, restarting, updates, commands, a Mac’s screen) ask a person first unless server_detail says asksFirst never; give a plain reason. To stop asking, the person sets Asks you first to Never on the server’s System tab or the card’s button; never suggest a way around it.',
} satisfies CatalogEntryInput;
