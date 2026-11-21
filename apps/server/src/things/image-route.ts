/**
 * A thing page's pictures over the session (service-dashboards.md SD-06, SD-S03; contracts CT-1000): the session's
 * `thing-image` download, authorized as the page is — the caller is in the burrow and may see the thing (`findThing`)
 * — and only for a ref signed for that very connection, unexpired. Every refusal is the same 404 (no probing); the
 * bytes come from `images.ts`.
 */
import type { BurrowAccess } from '../auth/request';
import type { ConnectionViewer } from '../connections/store';
import { notFound } from '../lib/errors';
import type { Services } from '../services';
import { type Picture, pictureFor, readImageRef } from './images';
import { findThing } from './page';
import { thingParam } from './routes';

/** A person in a burrow as a connection's viewer (what `findThing` checks). */
export function imageViewer(accountId: string, access: BurrowAccess): ConnectionViewer {
  return {
    accountId,
    burrowId: access.burrow.id,
    principal: access.principal,
  };
}

/** The picture `ref` names on `thing`'s page, for this viewer; `not_found` for anything wrong. */
export async function thingPicture(
  services: Services,
  viewer: ConnectionViewer,
  thing: string,
  ref: string,
): Promise<Picture> {
  if (viewer.principal.kind !== 'person') throw notFound('Picture');
  const payload = readImageRef(services.custody, ref, services.clock());
  if (!payload) throw notFound('Picture');
  const target = await findThing(services, viewer, thingParam(thing)).catch(() => null);
  if (target?.kind !== 'connection' || target.row.id !== payload.c) throw notFound('Picture');
  const picture = await pictureFor(services, target.row, payload);
  if (!picture) throw notFound('Picture');
  return picture;
}
