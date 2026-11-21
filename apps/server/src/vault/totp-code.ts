/**
 * A website login's authenticator key as the Vault keeps it and the code it makes (docs/decisions/vault-simplify.md
 * VLT-46, CT-1663): what the person pastes is read by core (`parseVaultTotp`) and sealed in one form
 * (`vaultTotpCanonical`); the current code is made here, where the key is, so the key never leaves the server. Core
 * gives the counter and the truncation, Node the HMAC.
 */
import { createHmac } from 'node:crypto';
import {
  parseVaultTotp,
  type VaultTotp,
  vaultBase32Decode,
  vaultTotpCanonical,
  vaultTotpCounter,
  vaultTotpCounterBytes,
  vaultTotpTruncate,
} from '@whombat/core';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { vaultTotpAad } from './store';

/** The authenticator key as the Vault seals it, or a field error (`totp`) in core's words. */
export function canonicalTotp(text: string): string {
  const parsed = parseVaultTotp(text);
  if (!parsed.ok)
    throw new ApiError('validation_failed', 'Some fields are not valid.', {
      fields: { totp: [parsed.message] },
    });
  return vaultTotpCanonical(parsed.totp);
}

/** RFC 6238: the HMAC of the time step's counter with the key, truncated to the code's digits. */
export function totpCode(totp: VaultTotp, nowMs: number): string {
  const hmac = createHmac(totp.algorithm.toLowerCase(), vaultBase32Decode(totp.secret))
    .update(vaultTotpCounterBytes(vaultTotpCounter(nowMs, totp.period)))
    .digest();
  return vaultTotpTruncate(new Uint8Array(hmac), totp.digits);
}

/** The code an authenticator app shows now for a key's canonical link, or null when it can't be read. */
export function totpCodeOf(canonical: string, nowMs: number): string | null {
  const parsed = parseVaultTotp(canonical);
  return parsed.ok ? totpCode(parsed.totp, nowMs) : null;
}

/** A login entry's current code, when it has an authenticator key that opens; null otherwise. */
export function currentTotp(
  services: Pick<Services, 'custody' | 'clock'>,
  row: { id: string; kind: string; totpSealed: string | null },
): string | null {
  if (row.kind !== 'login' || !row.totpSealed) return null;
  let canonical: string;
  try {
    canonical = services.custody.open(vaultTotpAad(row.id), row.totpSealed);
  } catch {
    return null;
  }
  return totpCodeOf(canonical, services.clock().getTime());
}
