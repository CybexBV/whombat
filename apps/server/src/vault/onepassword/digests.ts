/**
 * The base a link keeps (docs/decisions/onepassword-sync.md OPW-23): an HMAC of each field's canonical text, with a key
 * of the box's own (the key custody's, for this purpose only), separated by entry and field. So a pass can tell which
 * side changed without a second copy of any secret, and a digest of one entry's password says nothing about another's.
 */
import {
  ONEPASSWORD_SYNC_FIELDS,
  type OnePasswordDigests,
  type OnePasswordProjection,
  type OnePasswordSyncField,
  onePasswordCanonical,
} from '@whombat/core';
import type { KeyCustody } from '../../keys/custody';

/** The key custody's purpose for these digests: a sub-key of its own, used for nothing else. */
const PURPOSE = 'vault/onepassword/base';

/** The digest of one field of one entry's pair. */
export function onePasswordFieldDigest(
  custody: Pick<KeyCustody, 'mac'>,
  entryId: string,
  field: OnePasswordSyncField,
  canonical: string,
): string {
  return custody.mac(PURPOSE, `${entryId}\u0000${field}\u0000${canonical}`);
}

/** Each field's digest of a projection, for the entry `entryId`'s pair. */
export function onePasswordDigests(
  custody: Pick<KeyCustody, 'mac'>,
  entryId: string,
  projection: OnePasswordProjection,
): OnePasswordDigests {
  const canonical = onePasswordCanonical(projection);
  const out = {} as Record<OnePasswordSyncField, string>;
  for (const field of ONEPASSWORD_SYNC_FIELDS)
    out[field] = onePasswordFieldDigest(custody, entryId, field, canonical[field]);
  return out;
}

/** Whether a stored base has every field (an older or broken one counts as none: 1Password wins, OPW-23). */
export function storedBase(base: unknown): OnePasswordDigests | null {
  if (!base || typeof base !== 'object') return null;
  const b = base as Record<string, unknown>;
  return ONEPASSWORD_SYNC_FIELDS.every((f) => typeof b[f] === 'string') ? (b as OnePasswordDigests) : null;
}
