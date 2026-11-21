/**
 * The DEV box's state on this machine (`~/.local/state/whombat-devbox/state.json`, 0600; `WB_DEVBOX_HOME`): which VM,
 * device and release, and the person's credentials the tool claimed it with — the cloud session, the enrolled endpoint's
 * key and the recovery kit, as a person's app would keep them. Nothing here is a production secret: the box is on the
 * dev instance.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEVBOX_HOME = process.env.WB_DEVBOX_HOME ?? join(homedir(), '.local', 'state', 'whombat-devbox');
export const STATE_FILE = join(DEVBOX_HOME, 'state.json');

export interface Owner {
  email: string;
  name: string;
  org: string;
  accountId?: string;
}

export interface DevboxState {
  v: 1;
  vm: string;
  serial: string;
  monitorPort: number;
  installedFrom: { releaseId: string; iso: string; isoSha256: string };
  /**
   * The release the box is to run after its claim, when it isn't the one installed: a runtime-only release (Home's,
   * for the bridge rehearsal) that DEV control brings it to.
   */
  target?: string;
  /** The managed lease the VM lives under (agent-resource), which removes it when it ends. */
  lease?: string;
  createdAt: string;
  owner: Owner;
  device?: string;
  peerId?: string;
  /** A cloud session of the person (DEV control), reused until it expires. */
  session?: { token: string; expiresAt: string };
  /** The person's enrolled endpoint (libp2p protobuf identity, base64) and its id on the box. */
  endpointKey?: string;
  endpointId?: string;
  recovery?: { publicKey: string; secretKey: string; kitId: string };
  claimedAt?: string;
  internalAt?: string;
  healthyAt?: string;
  /** The backup disk (IN-423): its volume, when it was last set up, the status then and the newest snapshot. */
  backupDisk?: { volume: string; at: string; state: string; snapshotId: string | null };
}

export function loadState(): DevboxState | null {
  return existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as DevboxState) : null;
}

export function saveState(s: DevboxState): void {
  mkdirSync(DEVBOX_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(`${STATE_FILE}.tmp`, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}

/** Keeps the old state next to the new one when the box is destroyed (for the record). */
export function retireState(): void {
  if (!existsSync(STATE_FILE)) return;
  renameSync(STATE_FILE, join(DEVBOX_HOME, `state.${new Date().toISOString().replace(/[:.]/g, '')}.json`));
}

/** What `status` may print: no session token, no keys. */
export function publicView(s: DevboxState): Record<string, unknown> {
  const { session, endpointKey, recovery, ...rest } = s;
  return {
    ...rest,
    session: session ? { expiresAt: session.expiresAt } : null,
    endpoint: endpointKey ? 'kept' : null,
    recovery: recovery ? { kitId: recovery.kitId } : null,
  };
}
