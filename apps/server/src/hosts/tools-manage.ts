/**
 * The Servers tools for managing Proxmox (and Incus) guests (proxmox.md PX-02; contracts 0.81.0, CT-355; the build
 * brief §2.2): what a person can do on a server's and a guest's pages, through `connection_call` — snapshots, choices,
 * backups, backup jobs, storage content, tasks and firewall to read; create, clone, convert and delete guests, grow
 * and move disks, back up and restore, backup jobs, downloads, tasks, firewall, high availability, replication and the
 * server's own power to change.
 *
 * Each call goes to the service's manage routes as “<Whombat> for <person>” with the role its route needs
 * (one-whombat-servers.md ONE-DH03: reads operator, changes operator, the admin ops — create, clone, template,
 * delete, restore, deleting a backup, downloads and deleting content, HA, backup jobs but running one, server power —
 * admin), answers compact JSON (ONE-DH16) and refuses in Whombat's words (`errors.ts`). Whatever destroys or moves
 * something asked a person before it got here (the catalog's sensitive rules), so destructive routes are sent with
 * `confirm` and a delete with the guest's own name. Every change is recorded (`hosts.change`, ONE-DH17) with Undo where
 * the inverse is clear (`hosts.tool_inverse`); a task it starts is followed (PX-05). The tools live in
 * `tools-guests.ts`, `tools-backups.ts`, `tools-host.ts` and `tools-updates.ts`, their shared pieces in `tools-shared.ts`.
 */
import type { Adapter } from '../connections/adapters/types';
import { BACKUP_PLACE_TOOL_ARGS, BACKUP_PLACE_TOOLS } from './tools-backup-places';
import { BACKUP_TOOLS } from './tools-backups';
import { GUEST_TOOLS } from './tools-guests';
import { HOST_TOOLS } from './tools-host';
import { INCUS_TOOLS } from './tools-incus';
import { LIBVIRT_TOOLS } from './tools-libvirt';
import { MAC_TOOL_ARGS, MAC_TOOLS } from './tools-macos';
import { UNRAID_TOOLS } from './tools-unraid';
import { UPDATE_TOOL_ARGS, UPDATE_TOOLS } from './tools-updates';

export { backupGuestId, jobWithGuest } from './tools-backups';
export { type CreateInput, firewallRule, incusCreateSet, pveCreateSet } from './tools-guests';

/** The arguments each of these tools takes (`checkArgs`, PX-08). */
export const MANAGE_TOOL_ARGS: Readonly<Record<string, readonly string[]>> = {
  guest_snapshots: ['server', 'guest'],
  guest_backups: ['server', 'guest'],
  guest_firewall: ['server', 'guest'],
  server_choices: ['server', 'project'],
  backup_jobs: ['server'],
  storage_contents: ['server', 'storage', 'content', 'appliances'],
  server_tasks: ['server', 'guest', 'task'],
  guest_create: [
    'server',
    'kind',
    'name',
    'id',
    'cores',
    'memory_mb',
    'disk_gb',
    'storage',
    'bridge',
    'iso',
    'template',
    'password',
    'ssh_keys',
    'start',
    'settings',
    'project',
    'profiles',
    'pool',
    'network',
    'cloud_init',
    'os_variant',
  ],
  guest_clone: ['server', 'guest', 'name', 'id', 'full', 'storage', 'project', 'instance_only'],
  guest_template: ['server', 'guest'],
  guest_delete: ['server', 'guest', 'purge'],
  guest_disk: ['server', 'guest', 'action', 'disk', 'size', 'storage', 'delete_source'],
  guest_backup: [
    'server',
    'guest',
    'action',
    'backup',
    'storage',
    'mode',
    'notes',
    'as_new',
    'id',
    'name',
    'expires_days',
    'start',
    'compress',
  ],
  backup_job_set: [
    'server',
    'action',
    'job',
    'guest',
    'schedule',
    'storage',
    'mode',
    'keep',
    'selection',
    'pool',
    'comment',
  ],
  storage_content: [
    'server',
    'action',
    'storage',
    'content',
    'url',
    'filename',
    'checksum',
    'checksum_algorithm',
    'template',
    'volume',
  ],
  task_stop: ['server', 'task'],
  guest_firewall_set: ['server', 'guest', 'action', 'rule', 'pos', 'to', 'options'],
  guest_ha: ['server', 'guest', 'action', 'state', 'max_restart', 'max_relocate'],
  guest_replication: ['server', 'guest', 'action', 'target', 'schedule', 'job'],
  server_power: ['server', 'action'],
  // Incus (0.83, CT-366; tools-incus.ts).
  incus_overview: ['server'],
  incus_profile: ['server', 'profile', 'project'],
  network_leases: ['server', 'network', 'project'],
  guest_log: ['server', 'guest', 'lines'],
  guest_rename: ['server', 'guest', 'name'],
  guest_move: ['server', 'guest', 'pool', 'project'],
  guest_publish: ['server', 'guest', 'alias', 'description', 'snapshot'],
  incus_image: ['server', 'action', 'alias', 'type', 'image', 'project'],
  incus_profile_set: [
    'server',
    'action',
    'profile',
    'project',
    'digest',
    'set',
    'delete',
    'devices',
    'description',
    'copy_from',
  ],
  storage_volume: ['server', 'action', 'pool', 'volume', 'size', 'content_type', 'project'],
  // Unraid (0.83, CT-366; tools-unraid.ts).
  unraid_overview: ['server'],
  unraid_array: ['server', 'action', 'correct', 'disk', 'notification'],
  unraid_plugins: ['server', 'action', 'plugin'],
  container_update: ['server', 'action', 'guest'],
  guest_autostart: ['server', 'guest', 'on'],
  // QEMU/KVM through libvirt (0.84, CT-371; tools-libvirt.ts).
  libvirt_overview: ['server'],
  // The server's operating-system updates (0.98, server-updates.md SWU-08; tools-updates.ts).
  ...UPDATE_TOOL_ARGS,
  // A Proxmox server's backups on a NAS (backup-places.md BPL-12; tools-backup-places.ts).
  ...BACKUP_PLACE_TOOL_ARGS,
  // A Mac's screen and apps (macos-servers.md; tools-macos.ts).
  ...MAC_TOOL_ARGS,
};

/** The manage tools, by name. */
export const MANAGE_TOOLS: Adapter = {
  ...GUEST_TOOLS,
  ...BACKUP_TOOLS,
  ...HOST_TOOLS,
  ...INCUS_TOOLS,
  ...UNRAID_TOOLS,
  ...LIBVIRT_TOOLS,
  ...UPDATE_TOOLS,
  ...BACKUP_PLACE_TOOLS,
  ...MAC_TOOLS,
};
