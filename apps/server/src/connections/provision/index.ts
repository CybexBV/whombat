/** The provisioners of sign in once by catalog id (docs/decisions/connections-setup.md CS-01). */
import { HOME_PROVISIONERS } from './home';
import { NETWORK_PROVISIONERS } from './network';
import { provisionT3Code } from './t3code';
import type { Provisioner } from './types';

/**
 * Plex signs in on its own PIN page since 0.111 (docs/decisions/connection-signin.md SG-04, `service-login/plex.ts`):
 * its password provisioner went with the catalog's password sign-in.
 */
export const PROVISIONERS: Readonly<Record<string, Provisioner>> = {
  ...HOME_PROVISIONERS,
  ...NETWORK_PROVISIONERS,
  // A pairing code, not a password (docs/decisions/t3code.md T3-02).
  t3code: provisionT3Code,
};

/** Tests' stand-ins, by catalog id (`useProvisionerForTests`). */
const testProvisioners = new Map<string, Provisioner>();

/**
 * Tests only: a stand-in provisioner for an entry, in place of the real one (or where there is none); null removes it.
 * Refused outside `NODE_ENV=test`.
 */
export function useProvisionerForTests(catalogId: string, provisioner: Provisioner | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('The provisioner seam is for tests only.');
  if (provisioner) testProvisioners.set(catalogId, provisioner);
  else testProvisioners.delete(catalogId);
}

export function provisionerFor(catalogId: string): Provisioner | null {
  return testProvisioners.get(catalogId) ?? PROVISIONERS[catalogId] ?? null;
}
