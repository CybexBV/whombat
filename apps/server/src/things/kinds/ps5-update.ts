/**
 * Updating PS5 homebrew from its page (docs/decisions/ps5-connection.md PS5-17…PS5-20): an Update button on each line of
 * To update, Update all on the card, the same button on the Worth a look line. Each runs the very steps the
 * assistant's tools run (`connections/adapters/ps5.ts`), confirmed first and only for the version the page showed: the
 * server reads the updates again when the button is pressed and refuses when they changed.
 */
import { createHash } from 'node:crypto';
import {
  PS5_MANAGER_ID,
  PS5_WEBKIT_INSTALLER,
  Ps5Checksum,
  Ps5Config,
  Ps5Payloads,
  type Ps5UpdateLine,
  ps5AllUpdates,
  type ThingPageButton,
} from '@whombat/core';
import { externalEffect } from '../../commit/scope';
import {
  keepPs5Fields,
  ps5UpdateManager,
  ps5UpdatePayload,
  ps5UpdateWebkit,
} from '../../connections/adapters/ps5';
import { connectionDatagram, connectionLine, signedConnectionFetch } from '../../connections/http';
import {
  firmwareOf,
  Ps5ApiError,
  type Ps5Context,
  ps5OfficialReleases,
  readPs5,
  readPs5Console,
} from '../../connections/ps5-api';
import { ConnectionArgumentError } from '../../connections/request';
import type { CatalogConnectionRow } from '../../connections/types';
import { ApiError, badRequest, conflict } from '../../lib/errors';
import type { Services } from '../../services';
import { clip, plural } from '../words';
import { pageButton } from './buttons';
import type { KindAction, KindActionCtx, KindActionInput, KindActionWords } from './registry';
import type { KindCtx } from './types';

/** Who reads the page: its buttons are allowed or not by the connection's access. */
export type Ps5ButtonCtx = Pick<KindCtx, 'row'>;

/** An update a button can offer: newer, and from a release Whombat can check. */
export const updatable = (
  u: Ps5UpdateLine,
): u is Ps5UpdateLine & { available: NonNullable<Ps5UpdateLine['available']> } => u.newer && !!u.available;

const isWebkit = (u: Ps5UpdateLine) => u.available?.id === PS5_WEBKIT_INSTALLER;
const isManager = (u: Ps5UpdateLine) => u.slot === PS5_MANAGER_ID;

/** Why this update can't be pressed, or null. */
function refusal(u: Ps5UpdateLine): string | null {
  if (u.fits === false && u.firmware)
    return `This release supports firmware ${u.firmware.from} to ${u.firmware.to}, not your PS5’s.`;
  if (!Ps5Checksum.safeParse(u.available?.checksum ?? '').success)
    return 'The repository gives no checksum for this release, so Whombat can’t check it.';
  return null;
}

/** What Update all takes: every update except WebKit Autoloader's installer, which runs on the PS5 and needs a restart. */
export const forAll = (updates: readonly Ps5UpdateLine[]) =>
  updates.filter((u) => updatable(u) && !isWebkit(u) && refusal(u) === null);

/** What the page showed Update all, so a press after a newer release came out is refused. */
export function updatesKey(lines: readonly Ps5UpdateLine[]): string {
  const list = lines.map((u) => `${u.slot}@${u.available?.version}`).sort();
  return createHash('sha256').update(list.join(',')).digest('hex').slice(0, 16);
}

function confirmBody(u: Ps5UpdateLine & { available: { version: string } }): string {
  const v = u.available.version;
  if (isWebkit(u))
    return `Whombat downloads the ${v} installer and runs it on your PS5. When your PS5 says it’s done, restart it and open WebKit Autoloader again.`;
  if (isManager(u))
    return `Whombat downloads Payload Manager ${v}. It takes effect the next time Payload Manager starts, after your PS5 restarts.`;
  return `Whombat downloads ${u.name} ${v} and checks it. It takes effect the next time it starts${u.source === 'uploaded' ? ', and the old copy stays so you can go back' : ''}.`;
}

/** A line's Update button, confirmed; drawn disabled with the reason when its release can't be used. */
export function ps5UpdateButton(u: Ps5UpdateLine, bctx: Ps5ButtonCtx): ThingPageButton | null {
  if (!updatable(u)) return null;
  const button = pageButton(bctx, {
    action: 'update',
    target: u.slot,
    value: u.available.version,
    label: 'Update',
    icon: 'up',
    confirm: {
      title: clip(`Update ${u.name} to ${u.available.version}?`, 80),
      body: confirmBody(u),
      button: 'Update',
    },
  });
  const why = refusal(u);
  return why && button.allowed ? { ...button, allowed: false, reason: why } : button;
}

/** **Update all** on To update: two or more updates it can take together. */
export function ps5UpdateAllButton(
  updates: readonly Ps5UpdateLine[],
  bctx: Ps5ButtonCtx,
): ThingPageButton | null {
  const all = forAll(updates);
  if (all.length < 2) return null;
  const webkit = updates.some((u) => updatable(u) && isWebkit(u));
  return pageButton(bctx, {
    action: 'update-all',
    value: updatesKey(all),
    label: 'Update all',
    icon: 'up',
    confirm: {
      title: `Update ${plural(all.length, 'homebrew item')}?`,
      body: clip(
        `${all.map((u) => `${u.name} ${u.available?.version}`).join(', ')}. Whombat downloads each one and checks it; each takes effect the next time it starts.${webkit ? ' WebKit Autoloader has its own Update.' : ''}`,
        300,
      ),
      button: 'Update all',
    },
  });
}

/** Requests that change the PS5, under the connection's policy; reads among them may be retried. */
function writeContext(services: Services, row: CatalogConnectionRow): Ps5Context {
  return {
    baseUrl: row.baseUrl.replace(/\/+$/, ''),
    fields: row.fields,
    send: (req) =>
      externalEffect('things.ps5', () => signedConnectionFetch(services, row, req), {
        idempotent: (req.method ?? 'GET') === 'GET',
      }),
    datagram: (port, payload) => connectionDatagram(services, row, port, payload),
    line: (port, command, idempotent) => connectionLine(services, row, port, command, idempotent),
  };
}

/** The updates as the PS5 and the Official Repository say now. */
async function freshUpdates(ctx: Ps5Context): Promise<Ps5UpdateLine[]> {
  const [inventory, releases, config, seen] = await Promise.all([
    readPs5(ctx, '/list_payloads', Ps5Payloads),
    ps5OfficialReleases(ctx),
    readPs5(ctx, '/get_config', Ps5Config).catch(() => null),
    readPs5Console(ctx).catch(() => null),
  ]);
  return ps5AllUpdates(inventory, releases, config?.AUTOLOAD_LIST ?? '', firmwareOf(seen));
}

/** A failure in plain words; the tools' own hints (“Read ps5_… again”) are for the assistant, not a person. */
export function plain(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ConnectionArgumentError || err instanceof Ps5ApiError)
    return /ps5_/.test(err.message)
      ? conflict('That changed on your PS5 since the page was read. Look again and try once more.')
      : conflict(err.message);
  return new ApiError(
    'unavailable',
    'Whombat couldn’t reach your PS5 just now. Check that homebrew is running.',
  );
}

/** Runs one update the way its kind of payload needs. */
async function runOne(
  { services, row, now }: KindActionCtx,
  ctx: Ps5Context,
  u: Ps5UpdateLine & { available: NonNullable<Ps5UpdateLine['available']> },
): Promise<{ message: string; title: string }> {
  const { version, checksum } = u.available;
  if (isManager(u)) {
    await ps5UpdateManager(ctx, { version, checksum });
    return {
      message: `Payload Manager ${version} is downloaded. It takes effect the next time Payload Manager starts.`,
      title: `Updated Payload Manager to ${version}`,
    };
  }
  if (isWebkit(u)) {
    await ps5UpdateWebkit(
      ctx,
      { version, checksum },
      (values) => keepPs5Fields(services, row.id, values),
      now,
    );
    return {
      message:
        'The WebKit Autoloader installer is running on your PS5. When it says it’s done, restart your PS5 and open WebKit Autoloader.',
      title: `Ran the WebKit Autoloader ${version} installer`,
    };
  }
  const done = await ps5UpdatePayload(ctx, { slot: u.slot, ...u.available });
  return { message: done.message, title: `Updated ${done.name} to ${version}` };
}

/** The page's Update and Update all; `open` is how they reach the PS5 (tests give a fake console). */
export function ps5UpdateActions(
  open: (services: Services, row: CatalogConnectionRow) => Ps5Context = writeContext,
): Record<string, KindAction> {
  /** One update, by its slot and the version the page showed. */
  const update: KindAction = async (actx, { target, value }) => {
    if (typeof target !== 'string' || !target) throw badRequest('Say which homebrew to update.');
    const ctx = open(actx.services, actx.row);
    try {
      const u = (await freshUpdates(ctx)).find((x) => x.slot === target);
      if (!u) throw conflict('That homebrew isn’t on your PS5 any more.');
      if (!updatable(u)) throw conflict(`${u.name} is up to date already.`);
      if (typeof value === 'string' && value !== u.available.version)
        throw conflict(
          `${u.name} ${u.available.version} came out since the page was read. Look at it again before updating.`,
        );
      const why = refusal(u);
      if (why) throw conflict(why);
      return await runOne(actx, ctx, u);
    } catch (err) {
      throw plain(err);
    }
  };

  /** Every update Update all showed, one after another; it stops at the first that fails and says so. */
  const updateAll: KindAction = async (actx, { value }) => {
    const ctx = open(actx.services, actx.row);
    const done: string[] = [];
    let all: Ps5UpdateLine[];
    try {
      all = forAll(await freshUpdates(ctx));
    } catch (err) {
      throw plain(err);
    }
    if (!all.length) throw conflict('Your homebrew is up to date already.');
    if (typeof value === 'string' && value !== updatesKey(all))
      throw conflict('The updates changed since the page was read. Look at them again before updating.');
    for (const u of all) {
      if (!updatable(u)) continue;
      try {
        await runOne(actx, ctx, u);
        done.push(`${u.name} ${u.available.version}`);
      } catch (err) {
        const why = plain(err).message;
        if (!done.length) throw plain(err);
        return {
          message: clip(`Updated ${done.join(', ')}. ${u.name} didn’t update: ${why}`, 200),
          title: clip(`Updated ${done.join(', ')}`, 200),
        };
      }
    }
    return {
      message: clip(
        `Updated ${done.join(', ')}. ${done.length === 1 ? 'It takes' : 'Each takes'} effect the next time it starts.`,
        200,
      ),
      title: clip(`Updated ${plural(done.length, 'homebrew item')} on the PS5`, 200),
    };
  };

  return { update, 'update-all': updateAll };
}

export const PS5_UPDATE_ACTIONS = ps5UpdateActions();

/** The assistant's approval card for the same buttons, in Whombat's words; null for any other action. */
export async function describePs5Update(
  { services, row }: KindActionCtx,
  action: string,
  { target }: KindActionInput,
  read: (services: Services, row: CatalogConnectionRow) => Ps5Context,
): Promise<KindActionWords | null> {
  if (action !== 'update' && action !== 'update-all') return null;
  const updates = await freshUpdates(read(services, row));
  const lines =
    action === 'update' ? updates.filter((u) => u.slot === target && updatable(u)) : forAll(updates);
  if (!lines.length) return null;
  return {
    title: action === 'update' ? 'Update homebrew on your PS5' : 'Update all homebrew on your PS5',
    lines: [
      ...lines
        .slice(0, 8)
        .map((u) => clip(`${u.name}: ${u.installed ?? 'unknown'} → ${u.available?.version}`, 120)),
      'Each takes effect the next time it starts.',
    ],
  };
}
