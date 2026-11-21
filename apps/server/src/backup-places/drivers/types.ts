/**
 * How Whombat sets a backup place up (docs/decisions/backup-places.md BPL-01…BPL-03): one driver per kind of place, made
 * for one place and the person (or Whombat) it acts for. The agent driver works through the hosts service (Unraid and
 * other Linux servers); the NAS drivers through the connection's own API (TrueNAS, Synology, QNAP).
 */
import type { BackupPlaceKept, BackupPlaceKind, BackupPlaceRef } from '@whombat/core';
import type { HostsActor } from '../../hosts/client';
import type { Services } from '../../services';
import type { PlaceKeep } from '../keep';
import type { LocationFacts } from '../locations';

/** The place a driver works on. */
export interface PlaceTarget {
  /** `server:<id>` or `connection:<id>`. */
  id: string;
  ref: Exclude<BackupPlaceRef, { type: 'found' }>;
  kind: BackupPlaceKind;
  /** As people call it (`BlackBox`): the words of a failure. */
  name: string;
}

export interface PlaceDriverContext {
  services: Services;
  target: PlaceTarget;
  /** Who the change is for, as the hosts service's audit names them (the agent driver; the NAS drivers sign in as the connection). */
  actor: HostsActor;
}

/** Whether a place can keep backups now, as its driver sees it (the NAS kinds; servers read it from the hosts service). */
export interface PlaceStatus {
  supported: boolean;
  /** One plain sentence when not. */
  reason: string | null;
  /** “Set it up by hand” is offered (BPL-09). */
  byHand: boolean;
  freeBytes: number | null;
  /** Where on it the backups can be kept (BPL-13); empty when the driver doesn't know. */
  locations?: LocationFacts[];
  /**
   * Where a Whombat's backups went on it before people could choose (the apps pool, `docker`, `Container`): the
   * location of a place set up then, whose record has none.
   */
  wasIn?: string | null;
}

/** Where `ensure` left the backup app: the repository's address and port, the folder, and the location it is in. */
export interface PlaceEnsured {
  address: string;
  port: number;
  path: string;
  /** The location the backups are in now (an Unraid share, a pool, a shared folder); null when the place has none. */
  location: string | null;
}

export interface PlaceDriver {
  /**
   * Installs or updates the backup app for `client` with the REST password and waits until it answers; the numeric LAN
   * address and port the box's repository names, and the folder the backups are in. Doing it again changes nothing but
   * the password. `location` (BPL-13, BPL-14): where on the place; left out, where the backups are now, else the
   * recommended one. Elsewhere than now: the agent moves the folder there (the address, port and repository stay; it
   * can take up to an hour), a NAS starts the app on an empty folder there (a new repository; the old one stays).
   */
  ensure(client: string, restPassword: string, location?: string): Promise<PlaceEnsured>;
  /**
   * Hands the repository password to the cleanup, which clears what `keep` doesn't keep (BPL-02, BKO-04). `windows`:
   * whether the place's cleanup takes the keep windows (left out: the driver finds out). Resolves to how it was handed
   * (nothing: as windows, which every NAS compose takes).
   */
  cleanup(
    client: string,
    repositoryPassword: string,
    keep: PlaceKeep,
    windows?: boolean,
  ): Promise<{ windows: boolean } | undefined>;
  /**
   * What the place says about `client`'s cleanup, when it says more than `kept` does (a server's helper): whether it is
   * set and what it keeps (null from a helper that knows only the days of every backup).
   */
  cleanupReport?(client: string): Promise<{ set: boolean; keep: PlaceKeep | null } | null>;
  /** Removes the backup app; `deleteData` also the backups it kept. */
  forget(client: string, deleteData: boolean): Promise<void>;
  /** What the place keeps for `client` (space used, free space, the last cleanup); null when it can't tell. */
  kept(client: string): Promise<BackupPlaceKept | null>;
  /** The place's numeric LAN addresses now, the one to use first (the address follow, BPL-08). */
  addresses?(): Promise<string[]>;
  /** Whether it can keep backups now (the places list of a NAS connection with Manage on). */
  status?(): Promise<PlaceStatus>;
}

export type PlaceDriverFactory = (ctx: PlaceDriverContext) => PlaceDriver;

/**
 * A step of a driver that didn't work: `unsupported` the place can't keep backups (`message` says why), `refused` its
 * API or the hosts service said no, `unreachable` nothing answered, `not_yet` this kind isn't built yet. `message` is one
 * plain sentence, never a password.
 */
export class PlaceError extends Error {
  constructor(
    readonly code: 'unsupported' | 'refused' | 'unreachable' | 'not_yet',
    message: string,
  ) {
    super(message);
    this.name = 'PlaceError';
  }
}
