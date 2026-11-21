/**
 * The Hermes Agent the assistant runs on, for This Whombat → About (docs/decisions/hermes-updates.md): the version a
 * connected runner reported with Hermes ready. Null while no runner has said, or its Hermes isn't ready.
 */
import type { HermesCheck } from '@whombat/core';
import type { ApplianceInfo } from '@whombat/protocol/session';

/** The longest version `ApplianceInfo.hermes` carries. */
const VERSION_MAX = 64;

export function applianceHermes(check: HermesCheck | null | undefined): ApplianceInfo['hermes'] {
  const version = check?.ready ? check.version?.trim() : undefined;
  return version ? { version: version.slice(0, VERSION_MAX) } : null;
}
