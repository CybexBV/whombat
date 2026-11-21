/**
 * Pictures on a thing's page on the phone (contracts 0.121, CT-1000; Whombat service-dashboards.md SD-06; app
 * service-dashboards.md AP-4537, AP-4650…): where a `ThingImage` comes from, by how the app talks to its Whombat — a
 * self-hosted server's `things.image` with the session token on the request (as attachment images), a managed Whombat's
 * `thing-image` stream through its session into a scoped cache file (`resourceToCacheFile`, as attachments there), and
 * the demo world's pictures drawn on the phone (`fixturePictureDataUrl`, handed in by fixture mode so the fixtures stay
 * out of the bundle's first load). The ref is the server's, used as it came; the phone never builds or reads one.
 */
import { type ApplianceSession, type ResourceRef, thingImageResource } from '@whombat/client/session';
import { createContext } from 'react';
import type { FileAccess } from './fileAccess';

/** Draws a picture of the demo world by its ref (fixture mode), or null for one it doesn't know. */
export type DrawPicture = (ref: string) => string | null;

/** Fixture mode's drawer; null everywhere else (`SignedInRoot`'s demo world provides it). */
export const DrawnPictures = createContext<DrawPicture | null>(null);

export type PicturePlan =
  /** Drawn here (the demo world): a `data:` URI. */
  | { kind: 'drawn'; uri: string }
  /** A Whombat: the session's `thing-image` download into a cache file of `scope`. */
  | {
      kind: 'session';
      session: ApplianceSession;
      ref: Extract<ResourceRef, { kind: 'thing-image' }>;
      scope: string;
    }
  /** The session isn't known yet: the box waits. */
  | { kind: 'wait' }
  /** Nothing to load (a demo ref that isn't drawn): the box shows the title's letter. */
  | { kind: 'none' };

export function picturePlan(input: {
  burrow: string;
  /** The thingId (`connection:con_plex`), as the page's `things.page` was read with. */
  thing: string;
  ref: string;
  access: FileAccess | null;
  drawn: DrawPicture | null;
}): PicturePlan {
  if (input.drawn) {
    const uri = input.drawn(input.ref);
    return uri ? { kind: 'drawn', uri } : { kind: 'none' };
  }
  const access = input.access;
  if (!access) return { kind: 'wait' };
  return {
    kind: 'session',
    session: access.session,
    ref: thingImageResource(input.burrow, input.thing, input.ref),
    scope: access.scope,
  };
}

/** A picture's cache file name in its resource directory (one picture each). */
export const PICTURE_FILE = 'picture';
/** At most this many bytes per picture (the server makes them at most 480 px on their long side, SD-06). */
export const PICTURE_MAX_BYTES = 3 * 1024 * 1024;
/**
 * Pictures kept in the phone's cache before the oldest go: a camera's snapshot has a new ref every read (SD-S09), so
 * an open Protect page would otherwise leave a file every 10 seconds until sign-out.
 */
export const PICTURES_KEPT = 96;

/**
 * The cache's pictures, least recently shown first (`touch` moves one to the end); `touch` returns the keys to remove
 * once there are more than `keep`. Pure, so it is tested without files.
 */
export function createPictureLru(keep = PICTURES_KEPT) {
  const order: string[] = [];
  return {
    touch(key: string): string[] {
      const at = order.indexOf(key);
      if (at >= 0) order.splice(at, 1);
      order.push(key);
      return order.length > keep ? order.splice(0, order.length - keep) : [];
    },
    get size() {
      return order.length;
    },
  };
}
