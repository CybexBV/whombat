/**
 * The Servers tools for QEMU/KVM through libvirt (incus-unraid.md IU-13; contracts 0.84.0, CT-371): the read
 * `libvirt_overview`. Everything else a libvirt VM takes goes through the tools Proxmox and Incus already had, widened
 * by the guest's platform or the server's kind (`guest_config_set`, `guest_create`, `guest_clone`, `guest_rename`,
 * `guest_delete`, `guest_disk`, `guest_backup`, `storage_contents`, `storage_content`, `storage_volume`,
 * `network_leases`, `guest_log`, `server_tasks`, `task_stop`, `server_choices`; incus-unraid-server.md IU-S14…).
 */
import type { Adapter } from '../connections/adapters/types';
import { toHostServerDetail } from './map';
import { call, gb, output, req, resolveServer, scope, serverDetailRaw } from './tools-shared';

const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : null);

export const LIBVIRT_TOOLS: Adapter = {
  async libvirt_overview(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const d = toHostServerDetail(await serverDetailRaw(s, srv.id), [], null, s.call.services.clock());
        const l = d.libvirt;
        if (!l)
          return output(
            {
              error: `${srv.id} doesn’t run QEMU/KVM, so this tool doesn’t work there.`,
              code: 'unsupported',
            },
            true,
          );
        const vms = d.workloads?.libvirt?.guests ?? [];
        return output({
          server: srv.id,
          libvirt: l.version,
          ...(l.qemu ? { qemu: l.qemu } : {}),
          pools: l.pools.map((p) => ({
            pool: p.name,
            type: p.type,
            ...(p.active ? {} : { active: false }),
            ...(p.path ? { path: p.path } : {}),
            sizeGb: gb(p.totalBytes),
            freeGb: gb(p.availBytes),
            usedPct: pct(p.usedBytes, p.totalBytes),
            volumes: p.volumes,
          })),
          networks: l.networks.map((n) => ({
            network: n.name,
            ...(n.active ? {} : { active: false }),
            ...(n.forward ? { forward: n.forward } : {}),
            ...(n.bridge ? { bridge: n.bridge } : {}),
            ...(n.ipv4 ? { ipv4: n.ipv4 } : {}),
            dhcp: n.dhcp,
            usedBy: n.usedBy,
          })),
          // Unraid's VM Manager keeps VMs and ISO images in folders: `folder:domains` and `folder:isos` as storages.
          ...(l.folders
            ? {
                folders: { domains: l.folders.domains, isos: l.folders.isos },
                storages: ['folder:domains', 'folder:isos'],
              }
            : {}),
          newVms: { uefi: l.firmware.uefi, secureBoot: l.firmware.secureBoot, tpm: l.firmware.tpm },
          ...(l.backupsDir ? { backupsGoTo: l.backupsDir } : {}),
          vms: vms.map((g) => ({
            guest: g.id,
            name: g.name,
            state: g.state,
            ...(g.autostart !== undefined ? { autostart: g.autostart } : {}),
            ...(g.self ? { thisWhombat: true } : {}),
          })),
        });
      },
      { server },
    );
  },
};
