/**
 * Something new is open to the internet (docs/decisions/internet-exposure.md): one line per opening that appeared
 * after Whombat kept a source's first list, on the connection whose settings opened it. The health pass reads the
 * source, keeps what it saw (`baseline.ts`) and adds the lines to the connection's own; the page reads them without
 * writing. A closed opening's line goes quietly; This is meant is Stop watching that one item, through What Whombat
 * watches, so the line, the Inbox item and the highlight go together.
 */
import { EXPOSURE_NEW_CHECK, thingHref } from '@whombat/core';
import { visibleConnections } from '../connections/store';
import type { CatalogConnectionRow } from '../connections/types';
import type { ConnectionGlance } from '../home/types';
import type { Services } from '../services';
import type { KindNotice } from '../things/quiet/types';
import { addressIndex, hostsServing, machineHref } from '../things/runs-on';
import { clip } from '../things/words';
import { keptOf, keptRows, recordOpenings } from './baseline';
import {
  isNewOpening,
  type KeptOpening,
  type Links,
  type LinkTarget,
  linkOf,
  NO_LINKS,
  openingId,
  openingSubject,
} from './openings';
import { hostPort, type RawOpening } from './parse';
import { isExposureSource, readOpenings } from './read';

/** Where the line and the Servers list send the person. */
export const EXPOSURE_HREF = '/internet';

/* What an opening leads to -------------------------------------------------------------------------------------- */

/**
 * The burrow's connections by the address and port they answer on, and its servers and guests by address: what a
 * target names. A read that fails leaves that half out.
 */
export async function buildLinks(
  services: Services,
  burrowId: string,
  rows?: readonly CatalogConnectionRow[],
): Promise<Links> {
  const [connections, index] = await Promise.all([
    rows ? Promise.resolve(rows) : visibleConnections(services.db, { burrowId }).catch(() => []),
    hostsServing(services, burrowId)
      .then((hosts) => (hosts ? addressIndex(hosts) : null))
      .catch(() => null),
  ]);
  const links: Links = { connections: new Map(), machines: new Map() };
  for (const r of connections) {
    const at = hostPort(r.baseUrl);
    const glance = r.glance as ConnectionGlance | null;
    if (!at.host || at.port === null) continue;
    const target: LinkTarget = {
      thing: `connection:${r.id}`,
      name: r.label,
      href: thingHref('connection', r.id),
      kind: r.catalogId,
      ...(glance?.machine?.name ? { machine: glance.machine.name } : {}),
    };
    const key = `${at.host}:${at.port}`;
    if (!links.connections.has(key)) links.connections.set(key, target);
  }
  for (const m of index?.machines ?? [])
    for (const a of m.addresses) {
      const key = a.toLowerCase();
      if (!links.machines.has(key))
        links.machines.set(key, {
          thing: `server:${m.serverId}`,
          name: m.name,
          href: machineHref(m.serverId, m.guestId),
        });
    }
  return links;
}

/* The line -------------------------------------------------------------------------------------------------------- */

/** The public side as the line names it: the name, or “Port 32400”. */
function lineAddress(o: RawOpening): string {
  return o.how === 'port_forward' || o.how === 'stream' ? `Port ${o.address}` : o.address;
}

/**
 * The line for one new opening, in English (the phrasebook says it in the reader's language): what is open now and
 * what it leads to, a link to the list, and Ignore until it closes.
 */
export function newOpeningNotice(sourceId: string, o: RawOpening, link: LinkTarget | null): KindNotice {
  const id = openingId(sourceId, o);
  const address = clip(lineAddress(o), 80);
  const what = clip(link?.name ?? o.target ?? o.address, 100);
  return {
    id: `exposure-new-${id}`.slice(0, 120),
    tone: 'warn',
    icon: 'network',
    title: clip(`${address} is open to the internet now`, 120),
    detail: clip(`It leads to ${what}. Is that meant?`, 200),
    link: { kind: 'href', label: 'See what’s open', href: EXPOSURE_HREF },
    nature: 'you',
    check: EXPOSURE_NEW_CHECK,
    subject: { id: openingSubject(id), name: clip(o.address, 80) },
    ignore: { lifts: 'fixed', words: 'Until it’s closed.' },
    badge: clip(`New opening: ${address}`, 40),
  };
}

/** The lines of what is new among `openings`, as kept: an opening's line goes once it is two weeks old. */
export function newOpeningNotices(
  sourceId: string,
  openings: readonly RawOpening[],
  kept: ReadonlyMap<string, KeptOpening>,
  links: Links,
  now: Date,
): KindNotice[] {
  const seen = new Set<string>();
  const out: KindNotice[] = [];
  for (const o of openings) {
    const id = openingId(sourceId, o);
    if (seen.has(id)) continue;
    seen.add(id);
    if (!isNewOpening(kept.get(id), now)) continue;
    out.push(newOpeningNotice(sourceId, o, linkOf(links, o.targetHost, o.targetPort)));
  }
  return out;
}

/** What the health pass adds to a connection's lines: its new openings, or that the check wasn't read this time. */
export interface ExposureSeen {
  notices: KindNotice[];
  /** The openings were read: an Ignore of a line that went may end. */
  read: boolean;
}

/** The health pass: reads the source, keeps what it saw and gives the lines of what is new. */
export async function exposureSeen(
  services: Services,
  row: CatalogConnectionRow,
  now: Date,
): Promise<ExposureSeen> {
  if (!isExposureSource(row.catalogId)) return { notices: [], read: true };
  try {
    const read = await readOpenings(services, row, 'pass');
    const ids = read.openings.map((o) => openingId(row.id, o));
    const kept = await recordOpenings(services, row.id, ids, read.complete, now);
    const fresh = [...kept.values()].some((k) => isNewOpening(k, now));
    const links = fresh ? await buildLinks(services, row.burrowId).catch(() => NO_LINKS) : NO_LINKS;
    return { notices: newOpeningNotices(row.id, read.openings, kept, links, now), read: true };
  } catch (err) {
    services.log.debug({ err: String(err), connectionId: row.id }, 'exposure: openings not read');
    return { notices: [], read: false };
  }
}

/** The page's lines: what is new as kept, without writing. */
export async function exposurePageNotices(
  services: Services,
  row: CatalogConnectionRow,
): Promise<KindNotice[]> {
  if (!isExposureSource(row.catalogId)) return [];
  try {
    const [read, rows] = await Promise.all([
      readOpenings(services, row, 'page'),
      keptRows(services.db, [row.id]),
    ]);
    const kept = keptOf(rows.get(row.id) ?? []);
    const now = services.clock();
    if (![...kept.values()].some((k) => isNewOpening(k, now))) return [];
    const links = await buildLinks(services, row.burrowId).catch(() => NO_LINKS);
    return newOpeningNotices(row.id, read.openings, kept, links, now);
  } catch {
    return [];
  }
}
