/**
 * What's protected and restore tests (Whombat docs/decisions/backup-trust.md): one read of everything that holds data
 * and where its copies are, and the person's switch for weekly restore tests of a Proxmox server's machines.
 */
import { z } from 'zod';
import { ProtectedView, RestoreTestServer } from '../domain/protected.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });
const S = B.extend({ serverId: z.string().min(1).max(200) });

/** Turn restore tests on or off for a server; `guests` the machines to test (empty or absent: all of them). */
export const SetRestoreTestsBody = z.strictObject({
  on: z.boolean(),
  guests: z.array(z.string().min(1).max(200)).max(200).optional(),
});
export type SetRestoreTestsBody = z.infer<typeof SetRestoreTestsBody>;

/** Test one machine now (`guest`), else the one whose turn it is. */
export const RunRestoreTestBody = z.strictObject({ guest: z.string().min(1).max(200).optional() });
export type RunRestoreTestBody = z.infer<typeof RunRestoreTestBody>;

export const protectedEndpoints = {
  get: endpoint({
    id: 'protected.get',
    method: 'GET',
    path: '/burrows/:burrow/protected',
    summary:
      'Everything that holds data — this Whombat, servers, machines and services that keep data — and where its copies are, with the restore tests.',
    params: B,
    response: ProtectedView,
  }),
};

export const restoreTestEndpoints = {
  set: endpoint({
    id: 'restoreTests.set',
    method: 'PUT',
    path: '/burrows/:burrow/restore-tests/:serverId',
    summary:
      'Turn weekly restore tests of a Proxmox server’s machines on or off, and choose which machines. 403 when the caller may not.',
    params: S,
    body: SetRestoreTestsBody,
    response: RestoreTestServer,
  }),
  run: endpoint({
    id: 'restoreTests.run',
    method: 'POST',
    path: '/burrows/:burrow/restore-tests/:serverId/run',
    summary:
      'Start a restore test now: the newest backup of one machine is restored as a copy with its network off, started, then deleted. 409 while one runs.',
    params: S,
    body: RunRestoreTestBody,
    response: RestoreTestServer,
  }),
};
