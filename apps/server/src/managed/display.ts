/**
 * Screens elsewhere over the session (docs/decisions/desk-display.md DK-138, DK-146; desk-display-server.md “Screens
 * elsewhere”): a tablet or computer becomes a screen, sees only its own screen, and stops being one when the person
 * removes it.
 *
 * - **Becoming a screen.** `enroll.display.request` shows six letters for 10 minutes (`DisplayRequests`, memory only);
 *   the device asks `enroll.display.status`. The person types the letters in Settings (`desk.screen.add`): one commit
 *   enrols the waiting device's key to their account as a `display` (the signed `endpoint.enrolled`) and writes its
 *   screen (`ScreensApi.addDevice`). The device reconnects and is a screen.
 * - **Only its own screen.** A `display` session acts for no account (`TrustService.identify`), resolves only the
 *   `screen` channel (dispatcher), subscribes to nothing and opens no stream but a `screen` op's export (connection,
 *   `resources.ts`). Its ops below always find the screen by the session's own endpoint: there is no screen id to ask
 *   for another one with.
 * - **Removing one** (`revokeScreenKey`, from Settings' *Remove*; `endpoints.revoke` too) revokes its key and deletes its
 *   screen in one commit; its sessions close at once.
 */
import {
  DESK_SCREENS_MAX,
  DESK_WORDS,
  type DeskLayout,
  type DeskScreenDetail,
  fillDeskWords,
  topics,
} from '@whombat/core';
import type { DeskScreenAddInput } from '@whombat/protocol/session';
import { and, count, eq, ne, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { applianceEndpoints, screens as screensTable } from '../db/schema/index';
import { screenText } from '../desk/glance';
import { deskTarget } from '../desk/person';
import { type ScreenSessions, screenError } from '../desk/screen-sessions';
import { loadDeskRow } from '../desk/store';
import { gridFor, screenDetailFor } from '../desk/widgets/older-apps';
import type { ScreenRecord } from '../desk/widgets/types';
import { ApiError, forbidden, notFound } from '../lib/errors';
import type { Services } from '../services';
import type { SessionOpContext } from './dispatcher';
import type { DisplayEndpoint } from './display-requests';
import { announceRevocation, isScreenEndpoint, requireEnrolled, revokeEndpointIn } from './trust';

/** A screen is online while it asked within this long (as Settings' list says). */
const ONLINE_MS = 2 * 60_000;

/**
 * The device line Settings shows (“iPad · Safari”): the app's label turned round, else as it came, as one line with
 * nothing invisible (the device chose the label, so nothing in it may reorder or hide what Settings shows).
 */
export function screenDeviceLine(endpoint: DisplayEndpoint): string | null {
  const label = screenText(endpoint.label, 80);
  const parts = /^(.+?) on (.+)$/.exec(label);
  return screenText(parts ? `${parts[2]} · ${parts[1]}` : label, 80) || null;
}

function screensOf(c: Pick<SessionOpContext, 'screens'>): ScreenSessions {
  if (!c.screens) throw new ApiError('not_implemented', 'This Whombat can’t show screens elsewhere.');
  return c.screens;
}

/** Whether the burrow has as many screens besides the box's own as a Whombat keeps (DK-148). */
async function screensFull(db: Db | Tx, burrowId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(screensTable)
    .where(and(eq(screensTable.burrowId, burrowId), ne(screensTable.kind, 'box')));
  return (row?.n ?? 0) >= DESK_SCREENS_MAX;
}

/** Settings' picture of a screen just added (`desk.screen.add`'s answer). */
export function screenDetail(record: ScreenRecord, layout: DeskLayout, now: Date): DeskScreenDetail {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    popups: record.popups,
    size: record.size,
    pages: layout.pages.length,
    online: !!record.lastSeenAt && now.getTime() - record.lastSeenAt.getTime() < ONLINE_MS,
    lastSeenAt: record.lastSeenAt?.toISOString() ?? null,
    ...(record.device ? { device: record.device } : {}),
    layout,
    show: record.show,
  };
}

/* Becoming a screen ---------------------------------------------------------------------------------------------- */

async function endpointState(db: Db, peerId: string): Promise<'enrolled' | 'revoked' | null> {
  const [row] = await db
    .select({ revokedAt: applianceEndpoints.revokedAt })
    .from(applianceEndpoints)
    .where(eq(applianceEndpoints.peerId, peerId));
  if (!row) return null;
  return row.revokedAt ? 'revoked' : 'enrolled';
}

/** Why a page without a secure context can't become a screen (LNK-17). */
export const SCREEN_SECURE_ONLY_TEXT =
  'A screen joins only at this Whombat’s secure address. Open it there on this device and try again.';

/**
 * `enroll.display.request {endpoint}`: six letters for this device for 10 minutes. Refused where screens elsewhere
 * can't be shown, before the claim, for a key that is a device or a screen here already (or was removed), and over the
 * request limits.
 */
export async function requestDisplay(c: SessionOpContext, input: { endpoint: DisplayEndpoint }) {
  // Letters nobody could use aren't shown.
  screensOf(c);
  if (!(await c.trust.isClaimed())) throw forbidden('Claim this appliance first.');
  // A tablet becomes a screen only at an HTTPS address (whombat-link.md LNK-17): a page the box served over plain HTTP
  // has no secure context, so its key could be copied by any script on that page.
  const page = c.session?.transport?.via === 'direct' ? c.session.transport.page : null;
  if (page && !page.secureContext) throw forbidden(SCREEN_SECURE_ONLY_TEXT);
  const known = await endpointState(c.services.db, c.principal.peerId);
  if (known === 'enrolled')
    throw new ApiError('conflict', 'This device is already enrolled.', {
      details: { code: 'endpoint_enrolled' },
    });
  if (known === 'revoked')
    throw forbidden(
      'This device key was revoked on this appliance. Reset the app’s storage to get a new key.',
    );
  const now = c.services.clock().getTime();
  // The local network's devices have places of their own: strangers through the relay can't take them, nor the reverse.
  const pool = c.session?.transport?.via === 'direct' ? 'direct' : 'relay';
  const asked = c.trust.display.request(
    { peerId: c.principal.peerId, publicKey: c.principal.publicKey },
    input.endpoint,
    now,
    pool,
  );
  if (!asked.ok)
    throw new ApiError(
      'rate_limited',
      asked.reason === 'full'
        ? 'Too many devices are waiting to become a screen. Try again in a few minutes.'
        : asked.reason === 'busy'
          ? 'Too many devices asked just now. Try again in a minute.'
          : 'Too many codes asked for. Wait a while and try again.',
    );
  // Never the letters.
  c.services.log.info(
    { peer: c.principal.peerId.slice(-8) },
    'screens: a device shows letters to become a screen',
  );
  const r = asked.request;
  return { requestId: r.requestId, code: r.code, expiresAt: new Date(r.expiresAt).toISOString() };
}

/** `enroll.display.status {requestId}`: only the device that asked hears how it went. */
export async function displayStatus(c: SessionOpContext, input: { requestId: string }) {
  const status = c.trust.display.status(c.principal.peerId, input.requestId, c.services.clock().getTime());
  if (!status) throw notFound('That request');
  return status;
}

/**
 * `desk.screen.add {code, name, popups, start}` (the person's): the device showing these letters becomes a screen of
 * the person's, its key enrolled as a `display` and its screen written in one commit. Full is said before the letters
 * are used up (remove a screen, type the same letters again); wrong letters count against the person's tries.
 */
export async function addScreenDevice(
  c: SessionOpContext,
  input: DeskScreenAddInput,
): Promise<DeskScreenDetail> {
  const { account, endpoint } = requireEnrolled(c.principal);
  const screens = screensOf(c);
  const services = c.services;
  const display = c.trust.display;
  const now = services.clock();
  const t = now.getTime();
  if (display.triesLeft(account.id, t) === 0) {
    const min = Math.max(1, Math.ceil((display.retryAt(account.id, t) - t) / 60_000));
    throw new ApiError('rate_limited', `Too many wrong letters. Try again in ${min} min.`, {
      details: { code: 'wrong_code', triesLeft: 0 },
    });
  }
  const target = await deskTarget(services.db, {
    accountId: account.id,
    preferBurrowId: (await loadDeskRow(services.db))?.burrowId ?? undefined,
  });
  if (!target) throw new ApiError('conflict', 'You need your assistant on this Whombat first.');
  if (await screensFull(services.db, target.burrowId))
    throw screenError('screens_full', DESK_WORDS.errors.screens_full);
  const taken = display.take(input.code, t);
  if (!taken.ok) {
    if (taken.reason === 'expired') throw screenError('pairing_expired', DESK_WORDS.errors.pairing_expired);
    const left = display.wrongTry(account.id, t);
    throw screenError(
      'wrong_code',
      left > 0
        ? fillDeskWords(DESK_WORDS.errors.wrong_code, { n: left })
        : 'Those letters don’t match the screen. Wait ten minutes before trying again.',
      { triesLeft: left },
    );
  }
  const request = taken.request;
  let record: ScreenRecord;
  try {
    record = await services.pipeline.transactAccount(async (tx, session) => {
      // Two adds at once can't both take the last place.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('whombat/screens'))`);
      if (await screensFull(tx, target.burrowId))
        throw screenError('screens_full', DESK_WORDS.errors.screens_full);
      // The key first: the screen's row names it.
      const endpointId = await c.trust.insertEndpoint(tx, {
        identity: { peerId: request.peerId, publicKey: request.publicKey },
        accountId: account.id,
        endpoint: request.endpoint,
        via: 'display',
        by: endpoint.id,
        at: now,
      });
      const added = await screens.api.addDevice(tx, {
        burrowId: target.burrowId,
        personId: target.id,
        endpointId,
        name: input.name,
        popups: input.popups,
        start: input.start,
        device: screenDeviceLine(request.endpoint),
      });
      session.publish(topics.me(target.id), { type: 'desk.changed' });
      return added;
    });
  } catch (err) {
    // Its key became a device here meanwhile, or was removed: these letters can't make a screen any more.
    const app = err instanceof ApiError ? (err.extra.details as { code?: unknown } | undefined) : undefined;
    if (err instanceof ApiError && (err.code === 'forbidden' || app?.code === 'endpoint_enrolled'))
      display.drop(request);
    else display.release(request);
    throw err;
  }
  display.added(request, { id: record.id, name: record.name });
  services.log.info(
    { screen: record.id, peer: request.peerId.slice(-8) },
    'screens: a device became a screen',
  );
  return screenDetail(record, record.layout, now);
}

/* A screen's own ops --------------------------------------------------------------------------------------------- */

/**
 * The screen this session's endpoint is. A screen's key whose screen is gone (its burrow went), or whose person is (the
 * screen draws for whoever added it, and nobody else), is revoked here, so the device learns it is no screen any more
 * instead of asking for nothing for ever.
 */
async function ownScreen(c: SessionOpContext): Promise<{ screens: ScreenSessions; screen: ScreenRecord }> {
  const screens = screensOf(c);
  const endpoint = c.principal.endpoint;
  // The dispatcher lets only a screen's session here; checked again, as everything here acts on that alone.
  if (!endpoint || !isScreenEndpoint(endpoint))
    throw new ApiError('forbidden', 'Only a screen asks for this.');
  const screen = await screens.api.byEndpoint(endpoint.id);
  if (screen && screen.kind === 'device' && screen.endpointId === endpoint.id && screen.personId)
    return { screens, screen };
  await revokeScreenKey(c.services, endpoint.id);
  throw screenError('unknown_screen', DESK_WORDS.errors.unknown_screen);
}

// biome-ignore lint/suspicious/noExplicitAny: each handler receives its op's parsed input.
type DisplayHandler = (c: SessionOpContext, input: any) => Promise<unknown>;

/** The ops of screens elsewhere: becoming one, adding one (the person's), and a screen's own. */
export const DISPLAY_SESSION_HANDLERS: Readonly<Record<string, DisplayHandler>> = {
  'enroll.display.request': (c, i) => requestDisplay(c, i),
  'enroll.display.status': (c, i) => displayStatus(c, i),
  // An older app's and screen's answers leave out what they can't read (weather-news.md).
  'desk.screen.add': async (c, i) => screenDetailFor(await addScreenDevice(c, i), c.principal.protocolMinor),
  'screen.state': async (c, i) => {
    const { screens, screen } = await ownScreen(c);
    const state = await screens.state(screen, i);
    return 'grid' in state && state.grid
      ? { ...state, grid: gridFor(state.grid, c.principal.protocolMinor) }
      : state;
  },
  'screen.unlock': async (c, i: { pin: string }) => {
    const { screens, screen } = await ownScreen(c);
    return screens.unlock(screen, i.pin);
  },
  'screen.lock': async (c) => {
    const { screens, screen } = await ownScreen(c);
    return screens.lock(screen);
  },
  'screen.image': async (c, i: { thing: string; ref: string }) => {
    const { screens, screen } = await ownScreen(c);
    return screens.image(screen, i);
  },
};

/* Removing one --------------------------------------------------------------------------------------------------- */

/**
 * Revokes a screen's key and deletes its screen in one commit (`revokeEndpointIn`); its sessions close at once and
 * control hears; `byEndpointId` the person's device that removed it, for the signed event. Settings' *Remove* comes
 * here through `revokeScreenDevice` (`desk/screens.ts`). False when it was revoked already (or isn't a screen's key).
 */
export async function revokeScreenKey(
  services: Services,
  endpointId: string,
  byEndpointId: string | null = null,
): Promise<boolean> {
  const now = services.clock();
  const result = await services.pipeline.transactAccount(async (tx, session) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('whombat/endpoints'))`);
    const [row] = await tx
      .select()
      .from(applianceEndpoints)
      .where(eq(applianceEndpoints.id, endpointId))
      .for('update');
    // Only ever a screen's key: a person's device is theirs to remove (`endpoints.revoke`).
    if (!row || !isScreenEndpoint(row)) return null;
    if (row.revokedAt) {
      // Revoked before; its screen goes now if it was somehow left.
      await tx.delete(screensTable).where(eq(screensTable.endpointId, row.id));
      return null;
    }
    const [screen] = await tx
      .select({ personId: screensTable.personId })
      .from(screensTable)
      .where(eq(screensTable.endpointId, row.id));
    const revoked = await revokeEndpointIn(tx, services, {
      row,
      by: { accountId: row.accountId, endpointId: byEndpointId },
      now,
    });
    if (screen?.personId) session.publish(topics.me(screen.personId), { type: 'desk.changed' });
    return revoked;
  });
  if (!result) return false;
  announceRevocation(services, result);
  return true;
}
