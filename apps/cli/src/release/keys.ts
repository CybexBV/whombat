/**
 * The release signing keys the project trusts (docs/decisions/bp-distribution.md BP-F20): the public halves of the
 * keys a bundle's `SHA256SUMS` may be signed with. `pnpm --filter @whombat/package sign --require-pinned` signs only
 * with one of these, and `sign --check` checks a signature against them (and any `--release-key <file>`).
 *
 * Adding a key: `pnpm --filter @whombat/package sign --keygen <dir>` makes a pair and prints the entry for this list.
 *
 * There is no key yet: the project's release key hasn't been generated. A key for local builds or tests is never
 * listed here.
 */
import type { ReleaseKey } from './signature';

export const RELEASE_KEYS: readonly ReleaseKey[] = [];
