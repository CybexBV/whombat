/**
 * The Servers tools for keeping a Proxmox server's backups on a NAS (docs/decisions/backup-places.md BPL-12): an Unraid
 * server, or a TrueNAS connected with Manage (`connection:<id>`, through its own API), shares a folder over NFS with
 * exactly the Proxmox server's addresses (`backup_place_nfs`), and the Proxmox
 * server adds it as storage for backups (`proxmox_storage_add`). The care plan's backup step names them. Both are
 * synchronous on the hosts service and idempotent; each change is recorded for Done recently.
 */

import { isPrivateIpv4, nfsAnswer, nfsBody, PLACE_ROUTES, storageBody } from '../backup-places/hub';
import { nasPlaceDriver } from '../backup-places/nas/transport';
import { TrueNasPlaceDriver } from '../backup-places/nas/truenas';
import { NasPlaceError } from '../backup-places/nas/types';
import type { Adapter, AdapterCall } from '../connections/adapters/types';
import { currentRow } from '../connections/http';
import { type CallOutput, ConnectionArgumentError } from '../connections/request';
import { call, changeOf, optStrList, output, record, req, resolveServer, scope, send } from './tools-shared';

/** The arguments each tool takes (`checkArgs`). */
export const BACKUP_PLACE_TOOL_ARGS: Readonly<Record<string, readonly string[]>> = {
  backup_place_nfs: ['server', 'name', 'clients'],
  proxmox_storage_add: ['server', 'storage', 'nfs_server', 'export'],
};

/**
 * The TrueNAS connection `backup_place_nfs` shares on, by id, when its `server` names one (`connection:<id>`): the call
 * acts through that connection too, so a yes is bound to where it goes as well (`callReaches`).
 */
export function trueNasOf(args: Readonly<Record<string, unknown>>): string | null {
  const server = typeof args.server === 'string' ? args.server.trim() : '';
  return server.startsWith('connection:') ? server.slice('connection:'.length) : null;
}

/** The other connections a Servers call acts through (`callReaches`). */
export function serversReach(tool: string, args: Readonly<Record<string, unknown>>): string[] {
  const id = tool === 'backup_place_nfs' ? trueNasOf(args) : null;
  return id ? [id] : [];
}

/**
 * `backup_place_nfs` on a TrueNAS connection: a dataset shared over NFS with exactly those addresses, signed in only as
 * the connection the call was checked on (`bound-targets.ts`; the caller binds it).
 */
async function trueNasNfs(
  call: AdapterCall,
  connectionId: string,
  name: string,
  clients: readonly string[],
): Promise<CallOutput> {
  const row = await currentRow(call.services, connectionId);
  if (!row || row.burrowId !== call.burrowId || row.catalogId !== 'truenas')
    throw new ConnectionArgumentError(
      'server: a server from servers_overview, or the TrueNAS the care plan names.',
    );
  try {
    const driver = nasPlaceDriver(call.services, row);
    if (!(driver instanceof TrueNasPlaceDriver)) throw new ConnectionArgumentError('server: not a TrueNAS.');
    const answer = await driver.nfsShare(name, clients);
    return output({
      export: answer.export,
      nfsServer: answer.addresses[0] ?? null,
      addresses: answer.addresses,
    });
  } catch (err) {
    if (err instanceof NasPlaceError) return output({ error: err.message }, true);
    throw err;
  }
}

export const BACKUP_PLACE_TOOLS: Adapter = {
  async backup_place_nfs(ctx, args) {
    const server = req(args, 'server');
    const name = req(args, 'name');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name))
      throw new ConnectionArgumentError('name: letters, digits, “.”, “_” and “-”, like whombat-pve-01.');
    const clients = optStrList(args, 'clients', 16) ?? [];
    if (!clients.length || clients.some((c) => !isPrivateIpv4(c)))
      throw new ConnectionArgumentError(
        'clients: the IPv4 addresses on the home network, like ["10.100.1.5"].',
      );
    // A TrueNAS connected with Manage shares it through its own API (the care plan names it `connection:<id>`); the
    // hosts service isn't needed for it.
    const trueNas = trueNasOf(args);
    if (trueNas !== null) {
      if (!ctx.call)
        throw new ConnectionArgumentError('This connection’s tools run only in an assistant’s turn.');
      return trueNasNfs(ctx.call, trueNas, name, clients);
    }
    const s = await scope(ctx);
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        const answer = nfsAnswer(
          await send<unknown>(s, 'operator', {
            method: 'POST',
            path: PLACE_ROUTES.nfs(srv.id),
            body: nfsBody(name, clients),
          }),
        );
        await record(
          s,
          changeOf('backup_place_nfs', srv.id, null, `Shared ${name} on ${srv.label} for backups`, {
            detail: `With ${clients.join(', ')}`,
          }),
        );
        return output({
          export: answer.export,
          nfsServer: answer.addresses[0] ?? null,
          addresses: answer.addresses,
        });
      },
      { server },
    );
  },

  async proxmox_storage_add(ctx, args) {
    const s = await scope(ctx);
    const server = req(args, 'server');
    const storage = req(args, 'storage');
    const nfsServer = req(args, 'nfs_server');
    const exportPath = req(args, 'export');
    if (!/^[a-z][a-z0-9._-]{1,39}$/.test(storage))
      throw new ConnectionArgumentError(
        'storage: lowercase letters, digits, “.”, “_” and “-”, like blackbox-backup.',
      );
    if (!isPrivateIpv4(nfsServer))
      throw new ConnectionArgumentError('nfs_server: the IPv4 address backup_place_nfs answered.');
    if (!exportPath.startsWith('/'))
      throw new ConnectionArgumentError('export: the folder, like /mnt/user/whombat-pve-01.');
    return call(
      async () => {
        const srv = await resolveServer(s, server);
        await send<unknown>(s, 'operator', {
          method: 'POST',
          path: PLACE_ROUTES.storages(srv.id),
          body: storageBody(storage, nfsServer, exportPath),
        });
        s.hosts.forget('fleet');
        await record(
          s,
          changeOf('proxmox_storage_add', srv.id, null, `Added ${storage} on ${srv.label} for backups`, {
            detail: `${nfsServer}:${exportPath}`,
          }),
        );
        return output({ storage, done: true });
      },
      { server },
    );
  },
};
