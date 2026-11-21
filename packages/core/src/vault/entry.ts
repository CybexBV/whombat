/** What makes an entry well-formed for its kind (docs/decisions/vault.md VT-02, VT-03). */
import { parseVaultUrl } from './network.js';
import { vaultSecretProblem } from './request.js';
import type { VaultAuth, VaultEntryKind } from './schemas.js';

export interface VaultEntryShape {
  kind: VaultEntryKind;
  url?: string | null | undefined;
  auth?: VaultAuth | null | undefined;
  /** The secret being set (create, or a replacement); absent when it isn't being set. */
  secret?: string | null | undefined;
  /** An `ssh` entry's key as it is created: generated, or imported (VT-S03). Absent for the other kinds. */
  sshKey?:
    | { mode: 'generate' }
    | { mode: 'import'; privateKey: string; passphrase?: string | undefined }
    | null;
}

export interface VaultFieldProblem {
  /** `kind`, `url`, `auth`, `auth.username`, `secret`, `sshKey`. */
  field: string;
  message: string;
}

/**
 * The problems with an entry's fields for its kind, as field errors (empty when it is fine):
 *
 * - `mcp`: a URL and how it signs in (`none` allowed: then no secret); a secret unless `none`.
 * - `http`: a URL and how it signs in (never `none`); a secret.
 * - `login` (VT-D28): the sign-in page's URL and `form` (the username, optional selectors); the password as the
 *   secret. `form` is for `login` only, and `login` takes nothing else.
 * - `ssh` (VT-S02, VT-S03): no URL and no secret; on create no `auth` either (the server writes `ssh_key` from the key)
 *   and an `sshKey` (generate, or import a private key); `ssh_key` belongs to `ssh` alone, `sshKey` too. Its servers are
 *   added afterwards (an entry without servers can be saved, VT-S04).
 * - `secret`: none is made (CT-823; Whombat skill-store.md SST-09): `create` refuses the kind; an existing one stays
 *   listed, takes neither URL nor sign-in, and can be edited and
 *   removed.
 *
 * `create` needs the secret; `update` checks the merged entry and only the secret being set. The destination (public
 * or on the home network) is the server's check, with the addresses it resolves (`vaultDestinationProblem`).
 */
export function vaultEntryShapeProblems(
  entry: VaultEntryShape,
  mode: 'create' | 'update' = 'create',
): VaultFieldProblem[] {
  const problems: VaultFieldProblem[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });
  const hasSecret = entry.secret !== undefined && entry.secret !== null;
  const hasSshKey = entry.sshKey !== undefined && entry.sshKey !== null;
  if (entry.kind === 'ssh') {
    if (entry.url) add('url', 'An SSH key has no address: add its servers after saving.');
    if (mode === 'create' && entry.auth)
      add('auth', 'Whombat writes an SSH key’s sign-in from the key itself.');
    else if (entry.auth && entry.auth.type !== 'ssh_key') add('auth', 'An SSH key signs in with its key.');
    if (hasSecret) add('secret', 'Paste a private key under “Use my own key”.');
    if (mode === 'create' && !hasSshKey) add('sshKey', 'Choose “Generate a new key” or “Use my own key”.');
    return problems;
  }
  if (hasSshKey) add('sshKey', 'Only an SSH key entry takes a key.');
  if (entry.auth?.type === 'ssh_key') {
    add('auth', 'Only an SSH key entry signs in with a key.');
    return problems;
  }
  if (entry.kind === 'secret') {
    if (mode === 'create')
      add('kind', 'Whombat doesn’t make this kind of entry any more. Save it as an API token.');
    if (entry.url) add('url', 'This entry has no address.');
    if (entry.auth) add('auth', 'This entry has no sign-in.');
    return problems;
  }
  if (!entry.url) add('url', 'Add the address.');
  else {
    const parsed = parseVaultUrl(entry.url);
    if (!parsed.ok) add('url', parsed.message);
  }
  if (!entry.auth) add('auth', 'Choose how it signs in.');
  else if (entry.kind === 'login' && entry.auth.type !== 'form')
    add('auth', 'A login signs in with a username and password on its sign-in page.');
  else if (entry.kind !== 'login' && entry.auth.type === 'form')
    add('auth', 'Only a website login signs in on a sign-in page.');
  else if (entry.auth.type === 'none') {
    if (entry.kind !== 'mcp') add('auth', 'An API needs a way to sign in.');
    if (hasSecret) add('secret', 'Nothing to paste: it signs in with nothing.');
  } else if (mode === 'create' && !hasSecret)
    add('secret', entry.kind === 'login' ? 'Paste the password.' : 'Paste the secret.');
  if (hasSecret && entry.auth) {
    const problem = vaultSecretProblem(entry.auth, entry.secret as string);
    if (problem) add('secret', problem);
  }
  return problems;
}
