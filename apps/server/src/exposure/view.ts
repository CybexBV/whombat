/**
 * Open to the internet (`things.exposure`, docs/decisions/internet-exposure.md): every opening of every place Whombat
 * reads, in the person's language, with what is new, what the person said is meant, and what is worth a look; then the
 * places it read and those it can't see, so the page never looks complete when it isn't.
 */
import {
  EXPOSURE_NEW_CHECK,
  type ExposureOpening,
  type ExposureSource,
  type ExposureSourceKind,
  type ExposureView,
  thingHref,
  thingId,
} from '@whombat/core';
import { type ConnectionViewer, visibleConnections } from '../connections/store';
import type { CatalogConnectionRow } from '../connections/types';
import { type ServerMessageKey, tpServer, tServer } from '../i18n/catalog';
import { burrowLocale } from '../i18n/locale';
import type { Services } from '../services';
import { within } from '../things/part-of';
import { thingQuiet } from '../things/quiet/store';
import { clip } from '../things/words';
import { keptOf, keptRows } from './baseline';
import { buildLinks } from './lines';
import { buildOpening, sortOpenings } from './openings';
import type { Blind, SourceOpenings } from './parse';
import { isExposureSource, manageUrlOf, readOpenings } from './read';

/** How long the page waits for one place before it says it couldn't read it now. */
const SOURCE_WAIT_MS = 8_000;
/** Where Add a connection is. */
const ADD_CONNECTION_HREF = '/connections?connection=add';
const ROUTERS: readonly string[] = ['opnsense', 'unifi_network'];

type Read = { ok: true; value: SourceOpenings } | { ok: false };

/** A place's blind spot in words. */
export function blindWords(b: Blind, locale: string): string {
  const t = (key: ServerMessageKey, vars?: Record<string, string>) => tServer(locale, key, vars);
  switch (b.code) {
    case 'streams_unread':
      return t('exposure.source.streamsUnread');
    case 'forwards_partial':
      return t('exposure.source.forwardsPartial');
    case 'forwards_unread':
      return tpServer(locale, 'exposure.source.forwardsUnread', b.count, { count: b.count, names: b.names });
    case 'tunnels_unread':
      return t('exposure.source.tunnelsUnread');
    case 'tunnel_local':
      return t('exposure.source.tunnelLocal', { name: b.name });
    case 'tunnel_config_unread':
      return t('exposure.source.tunnelConfigUnread', { name: b.name });
    case 'access_unread':
      return t('exposure.source.accessUnread');
    case 'upnp_on':
      return t('exposure.source.upnpOn');
    case 'upnp_unknown':
      return t('exposure.source.upnpUnknown');
    case 'funnel_allowed':
      return t('exposure.source.funnelAllowed', { who: b.who });
    case 'policy_unread':
      return t('exposure.source.policyUnread');
  }
}

/** One place as the page lists it: how many openings, and what it couldn't see. */
export function sourceOf(
  row: Pick<CatalogConnectionRow, 'id' | 'label' | 'catalogId'>,
  read: Read,
  count: number,
  locale: string,
): ExposureSource {
  const base = {
    thing: thingId('connection', row.id),
    name: clip(row.label, 120),
    href: thingHref('connection', row.id),
  };
  if (!read.ok) return { ...base, state: 'unread', words: tServer(locale, 'exposure.source.unread') };
  const blind = read.value.blind.map((b) => blindWords(b, locale));
  // Tailscale opens nothing by itself: only what its policy lets Funnel share, which is the whole line. A read that
  // missed part of a place never says nothing is open there.
  const head =
    row.catalogId === 'tailscale'
      ? blind.length
        ? null
        : tServer(locale, 'exposure.source.funnelOff')
      : count
        ? tpServer(locale, 'exposure.source.openings', count, { count })
        : tServer(locale, read.value.complete ? 'exposure.source.nothing' : 'exposure.source.nothingRead');
  const first = head && blind.length && !/[.!?]$/.test(head) ? `${head}.` : head;
  const words = clip([first, ...blind].filter(Boolean).join(' '), 300);
  return { ...base, state: blind.length ? 'partly' : 'read', words };
}

/** The line under the title: how many, how many worth a look, how many new. */
export function summaryOf(openings: readonly ExposureOpening[], locale: string): string {
  if (!openings.length) return tServer(locale, 'exposure.summary.none');
  const parts = [tpServer(locale, 'exposure.summary.openings', openings.length, { count: openings.length })];
  const looks = openings.filter((o) => o.risk).length;
  const fresh = openings.filter((o) => o.isNew).length;
  if (looks) parts.push(tpServer(locale, 'exposure.summary.looks', looks, { count: looks }));
  if (fresh) parts.push(tpServer(locale, 'exposure.summary.new', fresh, { count: fresh }));
  return clip(parts.join(' · '), 200);
}

/** `things.exposure`: the page for the viewer's Whombat. */
export async function exposureView(
  services: Services,
  viewer: Pick<ConnectionViewer, 'burrowId'>,
  timeZone: string,
): Promise<ExposureView> {
  const now = services.clock();
  const [locale, rows] = await Promise.all([
    burrowLocale(services, viewer.burrowId),
    visibleConnections(services.db, viewer),
  ]);
  const sources = rows.filter((r) => isExposureSource(r.catalogId));
  const [links, kept, reads, quiets] = await Promise.all([
    buildLinks(services, viewer.burrowId, rows),
    keptRows(
      services.db,
      sources.map((r) => r.id),
    ),
    Promise.all(
      sources.map((r) =>
        within(
          readOpenings(services, r, 'page').then(
            (value): Read => ({ ok: true, value }),
            (): Read => ({ ok: false }),
          ),
          SOURCE_WAIT_MS,
          { ok: false } as Read,
        ),
      ),
    ),
    Promise.all(sources.map((r) => thingQuiet(services.db, r.burrowId, thingId('connection', r.id)))),
  ]);
  const openings = new Map<string, ExposureOpening>();
  const places: ExposureSource[] = [];
  sources.forEach((row, i) => {
    const read = reads[i] as Read;
    const quiet = quiets[i];
    const meant = new Set(
      (quiet?.offs ?? [])
        .filter((o) => o.checkId === EXPOSURE_NEW_CHECK && o.subject !== '')
        .map((o) => o.subject),
    );
    let count = 0;
    if (read.ok) {
      const ctx = {
        locale,
        now,
        timeZone,
        source: {
          kind: row.catalogId as ExposureSourceKind,
          id: row.id,
          name: row.label,
          manageUrl: manageUrlOf(row),
        },
        links,
        meant,
        kept: keptOf(kept.get(row.id) ?? []),
      };
      for (const raw of read.value.openings) {
        const o = buildOpening(raw, ctx);
        if (!openings.has(o.id)) {
          openings.set(o.id, o);
          count++;
        }
      }
    }
    places.push(sourceOf(row, read, count, locale));
  });
  if (!sources.some((r) => ROUTERS.includes(r.catalogId)))
    places.push({
      name: tServer(locale, 'exposure.source.router'),
      state: 'missing',
      words: tServer(locale, 'exposure.source.routerMissing'),
      href: ADD_CONNECTION_HREF,
    });
  const list = sortOpenings([...openings.values()]).slice(0, 500);
  return {
    openings: list,
    sources: places.slice(0, 40),
    summary: summaryOf(list, locale),
    note: tServer(locale, 'exposure.note'),
    readAt: now.toISOString(),
  };
}
