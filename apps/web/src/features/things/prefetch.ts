/**
 * A connection's or device's page read before it opens (app page-speed.md AP-2660…AP-2664): the pointer resting on a
 * link to it, or the keyboard's focus reaching one, reads `things.page` at the default range as the page reads it, so
 * opening it draws from the cache. A pointer sweeping over the sidebar reads nothing (it rests `PREFETCH_DELAY_MS`
 * first), a copy younger than `PAGE_FRESH_MS` isn't read again, and a touch screen's emulated hover reads nothing (the
 * tap opens the page at once). A server's page (`/things/server:…`) is built from the hosts service, not read here.
 */
import { type FetchQueryOptions, type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useWhombat } from '@whombat/client/react';
import { type HostSeriesRange, parseThingId } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { type FocusEvent, type PointerEvent, useCallback, useEffect, useMemo } from 'react';

/** How long the pointer or the focus rests on a link before its page is read (AP-2661). */
export const PREFETCH_DELAY_MS = 100;
/** A page read this recently is fresh: not read again on hover, nor when it opens (AP-2662, AP-2663). */
export const PAGE_FRESH_MS = 20_000;

/** A thing page's read as the page makes it and a hover repeats it (one key): the range only when one is asked. */
export function thingPageInput(burrow: string, thing: string, range?: HostSeriesRange) {
  return { params: { burrow, thing }, query: range ? { range } : {} };
}

/**
 * The thingId a link opens when it is a connection's or a device's page at the default range (`?tab=` opens the same
 * read); null for a server's page, one with `?range=` and anything else.
 */
export function prefetchedThing(href: string): string | null {
  const m = /^\/things\/([^/?#]+)(?:\?([^#]*))?/.exec(href);
  if (!m?.[1]) return null;
  let thing: string;
  try {
    thing = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const parsed = parseThingId(thing);
  if (!parsed || parsed.kind === 'server') return null;
  return m[2] && new URLSearchParams(m[2]).has('range') ? null : thing;
}

export interface RestTimer {
  /** Wait for `key`, replacing any other wait. */
  start: (key: string) => void;
  /** Stop waiting (for `key` only, when given). */
  cancel: (key?: string) => void;
}

/** Runs `run(key)` once the pointer or the focus has rested `delay` ms on `key`, unless it left first; one wait at a time. */
export function restTimer(delay: number, run: (key: string) => void): RestTimer {
  let wait: { key: string; timer: ReturnType<typeof setTimeout> } | null = null;
  const cancel = (key?: string) => {
    if (!wait || (key !== undefined && wait.key !== key)) return;
    clearTimeout(wait.timer);
    wait = null;
  };
  return {
    start: (key) => {
      cancel();
      const timer = setTimeout(() => {
        wait = null;
        run(key);
      }, delay);
      wait = { key, timer };
    },
    cancel,
  };
}

export interface ThingLinkProps {
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: () => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: () => void;
}

/** Whether the focus came from the keyboard (`:focus-visible`), not from a click or a tap. */
function keyboardFocus(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * A link's handlers for `thing` (AP-2661, AP-2664): a mouse or a pen resting on it, or the keyboard's focus reaching
 * it, starts the wait; leaving stops it. A touch's pointer (and the hover a touch screen emulates after it) starts none.
 */
export function linkHandlers(thing: string, timer: RestTimer): ThingLinkProps {
  return {
    onPointerEnter: (e) => {
      if (e.pointerType !== 'touch') timer.start(thing);
    },
    onPointerLeave: () => timer.cancel(thing),
    onFocus: (e) => {
      if (keyboardFocus(e.currentTarget)) timer.start(thing);
    },
    onBlur: () => timer.cancel(thing),
  };
}

/** Read a thing page into the cache unless a fresh copy is there (AP-2662); a refusal stays the page's to show. */
export function readThingPage(
  qc: QueryClient,
  options: FetchQueryOptions<unknown, Error, unknown, readonly unknown[]>,
) {
  return qc.prefetchQuery({ ...options, retry: false, staleTime: PAGE_FRESH_MS });
}

/**
 * The props a link to a thing page takes so its page is read before it opens (`<AppLink href={h} {...linkProps(h)} />`);
 * none for a link to anything else, or before the burrow is known.
 */
export function useThingLinkProps(burrow: string | null | undefined): (href: string) => ThingLinkProps {
  const qc = useQueryClient();
  const { queries } = useWhombat();
  const timer = useMemo(
    () =>
      restTimer(PREFETCH_DELAY_MS, (thing) => {
        if (burrow) void readThingPage(qc, queries.endpoint(api.things.page, thingPageInput(burrow, thing)));
      }),
    [qc, queries, burrow],
  );
  useEffect(() => () => timer.cancel(), [timer]);
  return useCallback(
    (href: string) => {
      const thing = burrow ? prefetchedThing(href) : null;
      return thing ? linkHandlers(thing, timer) : {};
    },
    [burrow, timer],
  );
}
