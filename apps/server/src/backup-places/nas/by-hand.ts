/**
 * Setting a place up by hand (docs/decisions/backup-places.md BPL-09): when Whombat can't install the backup app
 * itself, it hands the person the compose to paste — with the user's bcrypt line, never the password — and “Check it”
 * points the box's backups at the app once it answers.
 *
 * - `backup.placeByHand`: makes the user's password (32 random bytes) and keeps it sealed on the server for 24 hours
 *   (the place record's pending password); asking again within that time hands out the same app, so a compose pasted
 *   earlier still checks. The compose has no cleanup: the NAS gets the repository password only through Whombat's
 *   own calls, once it is connected with Manage.
 * - `backup.placeCheck`: the pending password, the place's numeric address and the port; the app must answer there,
 *   then the place is set as `backup.usePlace` sets one (`finish`, the server's flow), marked as set up by hand.
 *
 * The record, the client name and the finishing steps are the server's (`ByHandDeps`), so this is tested on its own.
 */
import type { BackupPlaceKind } from '@whombat/core';
import { FIRST_PLACE_PORT, PLACE_ROOT_NAME, placeAppName, placeCompose } from './compose';
import { htpasswdLine, newPlacePassword } from './htpasswd';
import { answersHttp, NasPlaceError } from './types';

/** How long a pasted app can still be checked. */
export const BY_HAND_TTL_MS = 24 * 60 * 60_000;

/** A place as the by-hand flow needs it. */
export interface ByHandPlace {
  id: string;
  kind: BackupPlaceKind;
  /** As people call it: `BlackBox`. */
  name: string;
}

/** The password that waits for “Check it”, kept sealed in the place's record. */
export interface PendingPlace {
  client: string;
  port: number;
  password: string;
  expiresAt: Date;
}

export interface ByHandDeps {
  place(placeId: string): Promise<ByHandPlace | null>;
  /** This Whombat's client name on places (the same the drivers get). */
  client(): Promise<string>;
  pending(placeId: string): Promise<PendingPlace | null>;
  /** Keeps the password sealed in the place's record until `expiresAt`. */
  putPending(placeId: string, pending: PendingPlace): Promise<void>;
  /** The place's numeric LAN address now; throws `NasPlaceError` when there is none. */
  address(place: ByHandPlace): Promise<string>;
  probe(url: string): Promise<number | null>;
  /** TrueNAS's apps pool when Whombat can read it (a connection that looks is enough), so the path needs no edit. */
  trueNasPool?(place: ByHandPlace): Promise<string | null>;
  /** Sets the box's backups to the app and records the place as set up by hand (the server's `usePlace` steps). */
  finish(input: {
    place: ByHandPlace;
    client: string;
    address: string;
    port: number;
    password: string;
    move?: boolean;
  }): Promise<{
    placeId: string;
    destination: string;
    /** Where on the place (a place set up by hand has no choice: null). */
    locationName: string | null;
    appendOnly: 'verified' | 'not-enforced' | 'unknown';
    firstBackup: boolean;
  }>;
  now(): Date;
}

/** The host folder of the backups, per kind of place. */
function dataPath(kind: BackupPlaceKind, client: string, pool: string | null): string {
  switch (kind) {
    case 'synology':
      // Inside the project's own folder, which the person picks when making the project.
      return './backups';
    case 'qnap':
      return `/share/Container/${PLACE_ROOT_NAME}/${client}`;
    case 'truenas':
      return `/mnt/${pool ?? 'tank'}/${PLACE_ROOT_NAME}/${client}`;
    case 'unraid':
      return `/mnt/user/${PLACE_ROOT_NAME}/${client}`;
    default:
      return `/srv/${PLACE_ROOT_NAME}/${client}`;
  }
}

/** What the person does, in order, where the compose is pasted (one plain sentence each). */
export function byHandSteps(kind: BackupPlaceKind, name: string, app: string, pool: string | null): string[] {
  const check = `Come back here and click Check it. Whombat then makes ${name} keep this Whombat’s backups.`;
  switch (kind) {
    case 'synology':
      return [
        'In DSM, open Container Manager → Project and click Create.',
        `Name it ${app}, choose a new folder for it in the docker folder, and pick Create docker-compose.yml.`,
        'Paste the text below, click Next until Done, and let it start.',
        check,
      ];
    case 'qnap':
      return [
        'In QTS, open Container Station → Applications and click Create.',
        `Name it ${app}, paste the text below and click Create.`,
        check,
      ];
    case 'truenas':
      return [
        'In TrueNAS, open Apps → Discover Apps, click ⋮ and choose Install via YAML.',
        `Name it ${app} and paste the text below.`,
        ...(pool ? [] : ['In the folder path, change tank to the name of your pool.']),
        'Click Save and wait until the app runs.',
        check,
      ];
    default:
      return [
        'On the server, make a folder and save the text below in it as compose.yaml.',
        'In that folder, run docker compose up -d.',
        check,
      ];
  }
}

/** `backup.placeByHand`: the compose to paste, its steps, and until when “Check it” can set it. */
export async function placeByHand(
  deps: ByHandDeps,
  input: { placeId: string },
): Promise<{ compose: string; steps: string[]; expiresAt: string }> {
  const place = await deps.place(input.placeId);
  if (!place) throw new NasPlaceError('failed', 'Whombat doesn’t know that place any more.');
  const client = await deps.client();
  const now = deps.now();
  const had = await deps.pending(place.id);
  // The same app while it can still be checked, so a compose pasted a moment ago keeps working.
  const pending =
    had && had.client === client && had.expiresAt.getTime() > now.getTime()
      ? had
      : {
          client,
          port: FIRST_PLACE_PORT,
          password: newPlacePassword(),
          expiresAt: new Date(now.getTime() + BY_HAND_TTL_MS),
        };
  if (pending !== had) await deps.putPending(place.id, pending);
  const pool = place.kind === 'truenas' ? ((await deps.trueNasPool?.(place)) ?? null) : null;
  const compose = placeCompose({
    client,
    port: pending.port,
    dataPath: dataPath(place.kind, client, pool),
    htpasswd: htpasswdLine(client, pending.password),
    cleanup: null,
    withVersion: place.kind === 'qnap',
  });
  return {
    compose,
    steps: byHandSteps(place.kind, place.name, placeAppName(client, place.kind === 'qnap' ? 32 : 40), pool),
    expiresAt: pending.expiresAt.toISOString(),
  };
}

/** `backup.placeCheck`: sets the place made by hand once its app answers. */
export async function placeCheck(deps: ByHandDeps, input: { placeId: string; move?: boolean }) {
  const place = await deps.place(input.placeId);
  if (!place) throw new NasPlaceError('failed', 'Whombat doesn’t know that place any more.');
  const pending = await deps.pending(place.id);
  if (!pending || pending.expiresAt.getTime() <= deps.now().getTime())
    throw new NasPlaceError(
      'failed',
      'The backup app’s password waits only a day, and that day is over. Click Set it up by hand again and paste the new text.',
    );
  const address = await deps.address(place);
  if (!answersHttp(await deps.probe(`http://${address}:${pending.port}/`)))
    throw new NasPlaceError(
      'failed',
      `Whombat can’t reach the backup app on ${place.name} yet. Check that it runs and that port ${pending.port} is free, then try again.`,
    );
  return deps.finish({
    place,
    client: pending.client,
    address,
    port: pending.port,
    password: pending.password,
    ...(input.move !== undefined ? { move: input.move } : {}),
  });
}
