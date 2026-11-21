/**
 * The REST server's user (docs/decisions/backup-places.md BPL-01, BPL-05): a password of 32 random bytes and its
 * htpasswd line. Only the bcrypt line goes to the NAS or into a compose file a person pastes; the password goes to the
 * box's backup destination alone.
 */
import { randomBytes } from 'node:crypto';
import { PLACE_KIT_USER } from '@whombat/core/backup';
import bcrypt from 'bcryptjs';

/** 32 random bytes as URL-safe base64 (43 characters, nothing a shell, URL or YAML treats specially). */
export function newPlacePassword(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * `client:$2y$10$…`. The `$2y$` spelling is Apache's, which every htpasswd reader takes (bcryptjs writes `$2b$`, the
 * same hash).
 */
export function htpasswdLine(client: string, password: string, rounds = 10): string {
  const hash = bcrypt.hashSync(password, rounds).replace(/^\$2[ab]\$/, () => '$2y$');
  return `${client}:${hash}`;
}

/** Whether `password` is the one of an htpasswd line (tests, and a check before a redeploy keeps an old line). */
export function htpasswdMatches(line: string, password: string): boolean {
  const hash = line.slice(line.indexOf(':') + 1).replace(/^\$2y\$/, () => '$2b$');
  try {
    return bcrypt.compareSync(password, hash);
  } catch {
    return false;
  }
}

/**
 * The kit user's line (docs/decisions/backup-passkey.md): `kit` with its well-known password (`PLACE_KIT_PASSWORD`),
 * hashed once with a fixed salt so every compose Whombat writes says the same and a redeploy changes nothing.
 */
export const PLACE_KIT_HTPASSWD = `${PLACE_KIT_USER}:$2y$10$ZsTLSq1BhIeKshkcNw2onOic.FJ5gPUhVJZ2OKHl0iVwT3l1O1Wqa`;
