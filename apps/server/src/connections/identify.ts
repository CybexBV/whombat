/**
 * `connections.identify` (docs/decisions/connections-setup.md CS-13): what is at the address a person typed, before
 * anything secret goes there — the address to use, the entry it is and its version, and its certificate.
 *
 * - The address is read as typed (`pve.local`, `192.168.1.10:8006`, `https://cloud.example.com/nextcloud/`): the query
 *   and fragment are dropped (a browser's Proxmox address carries `#v1:…`), a trailing slash is stripped, and what is
 *   missing is added from the entry's discovery targets — the scheme the targets name for that port, or the first
 *   target's port and scheme (CS-D20).
 * - Every candidate is checked against the connections' destination rule first, exactly as on connect (CX-40, CX-41);
 *   when none passes, `destination_refused` with what to add.
 * - Then the entry's discovery probes run on each candidate (or every entry's, with no entry given), unauthenticated, the
 *   certificate read but not enforced on the home network (`finder.ts`, `lib/probe.ts`). The first candidate whose
 *   probes all match answers; else the first that answered at all, with why it isn't what was asked.
 */
import {
  CATALOG_CONNECTABLE,
  type CatalogEntry,
  CONNECTION_FIELD_VALUE_MAX,
  destinationRefusedText,
  discoveredUrl,
  type IdentifyConnectionBody,
  type IdentifyConnectionResponse,
  parseUrlAuthority,
  vaultDestinationProblem,
} from '@whombat/core';
import type { Services } from '../services';
import { resolveHost } from '../vault/net';
import { destinationReach } from '../vault/store';
import { connectableEntry } from './connect';
import { connectionError, connectionFieldError } from './errors';
import { type EntryProbe, HostProbes } from './finder';

type Scheme = 'http' | 'https';

/** The address as typed: what was written of scheme, host, port and path. */
export interface TypedAddress {
  scheme: Scheme | null;
  /** Lower-case name or canonical IP (IPv6 without brackets). */
  host: string;
  port: number | null;
  /** The path without a trailing slash (`''` for none). */
  path: string;
}

/** Why the typed address can't be used, as a field error on `url`. */
function addressError(message: string) {
  return connectionFieldError({ url: message }, message);
}

/** Reads an address as a person types it (CS-13): optional scheme and port, a path kept, query and fragment dropped. */
export function typedAddress(raw: string): TypedAddress {
  const m = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/)?([^/?#]*)([^?#]*)/.exec(raw.trim());
  if (!m) throw addressError('Whombat can’t use that address.');
  const schemeText = m[1]?.toLowerCase() ?? null;
  if (schemeText !== null && schemeText !== 'http' && schemeText !== 'https')
    throw addressError('Use an http or https address.');
  const scheme = schemeText as Scheme | null;
  const authority = parseUrlAuthority(scheme ?? 'http', m[2] ?? '');
  if (!authority.ok)
    throw addressError(
      authority.code === 'credentials'
        ? 'Leave the user name and password out of the address.'
        : 'Whombat can’t use that address.',
    );
  const path = (m[3] ?? '').replace(/\/+$/, '');
  // Room for the scheme and port the answer adds (`url` is a field value).
  if (path.length > CONNECTION_FIELD_VALUE_MAX - 300 || !/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(path))
    throw addressError('Whombat can’t use that address.');
  const a = authority.authority;
  return { scheme, host: a.host, port: a.explicitPort ? a.port : null, path };
}

/** Where an entry might be at the address (CS-D20): scheme and port, in the order to try. */
export function candidatesFor(entry: CatalogEntry, a: TypedAddress): { scheme: Scheme; port: number }[] {
  const targets = entry.discovery?.targets ?? [];
  const out: { scheme: Scheme; port: number }[] = [];
  const add = (scheme: Scheme, port: number) => {
    if (!out.some((c) => c.scheme === scheme && c.port === port)) out.push({ scheme, port });
  };
  if (a.port !== null) {
    if (a.scheme) add(a.scheme, a.port);
    for (const t of targets) if (!a.scheme && t.port === a.port) add(t.scheme, t.port);
    if (out.length === 0) {
      add('http', a.port);
      add('https', a.port);
    }
  } else {
    for (const t of targets) if (!a.scheme || t.scheme === a.scheme) add(t.scheme, t.port);
    if (a.scheme) add(a.scheme, a.scheme === 'https' ? 443 : 80);
    if (out.length === 0) add('https', 443);
  }
  return out;
}

interface Candidate {
  entry: CatalogEntry;
  url: string;
}

/** “a Proxmox VE”, “an Immich”, “an Unraid”, “a UniFi Network”. */
function withArticle(name: string): string {
  return /^(?:[AEIOaeio]|Un(?!i))/.test(name) ? `an ${name}` : `a ${name}`;
}

const NOTHING_ANSWERED = 'Nothing answered at that address.';
const UNTRUSTED_PUBLIC =
  'That address is on the internet and its certificate isn’t valid, so Whombat didn’t go on.';

/**
 * What is at the address (CS-13); a refusal offers “Add this network” (CX-41).
 * Throws `validation_failed` (`url`), `not_supported` (a builtin entry) or `destination_refused`.
 */
export async function identifyConnection(
  services: Services,
  body: IdentifyConnectionBody,
): Promise<IdentifyConnectionResponse> {
  const given = body.catalogId ? connectableEntry(body.catalogId) : null;
  const entries = given ? [given] : CATALOG_CONNECTABLE.filter((e) => e.discovery);
  const address = typedAddress(body.url);
  const paths = address.path ? [address.path, ''] : [''];
  const candidates: Candidate[] = [];
  for (const entry of entries)
    for (const c of candidatesFor(entry, address))
      for (const path of paths)
        candidates.push({ entry, url: `${discoveredUrl(c.scheme, address.host, c.port)}${path}` });
  const first = candidates[0];
  if (!first) throw addressError('Whombat can’t use that address.');

  // The destination rule, as on connect (CX-40): the host resolved once, each candidate's scheme and port checked.
  const [resolved, reach] = await Promise.all([
    resolveHost(services, discoveredUrl('https', address.host, 443)),
    destinationReach(services),
  ]);
  const allowed = candidates.filter(
    (c) => vaultDestinationProblem({ url: c.url, resolved, ...reach, at: 'save' }) === null,
  );
  if (allowed.length === 0) {
    const problem = vaultDestinationProblem({ url: first.url, resolved, ...reach, at: 'save' });
    const s = problem?.suggestion;
    throw connectionError(
      'destination_refused',
      {
        problem: problem?.code ?? 'bad_url',
        ...(s ? { cidr: s.cidr, port: s.port } : {}),
      },
      s ? destinationRefusedText(s.cidr, s.port) : (problem?.message ?? 'That address isn’t allowed.'),
    );
  }

  const probes = new HostProbes(services);
  const results: EntryProbe[] = await Promise.all(
    allowed.map((c) => (c.entry.discovery ? probes.entryAt(c.entry, c.url) : probes.rootAt(c.url))),
  );
  const at = (i: number) => allowed[i] as Candidate;
  const matched = results.findIndex((r) => r.matched);
  if (matched !== -1) {
    const r = results[matched] as EntryProbe;
    return {
      url: at(matched).url,
      reachable: true,
      catalogId: at(matched).entry.id,
      version: r.version,
      certificate: r.certificate,
      message: null,
    };
  }
  const answered = results.findIndex((r) => r.answered || r.untrusted);
  if (answered !== -1) {
    const r = results[answered] as EntryProbe;
    return {
      url: at(answered).url,
      reachable: true,
      catalogId: null,
      version: null,
      certificate: r.certificate,
      message: r.untrusted
        ? UNTRUSTED_PUBLIC
        : given?.discovery
          ? `That address answered, but it isn’t ${withArticle(given.name)}.`
          : given
            ? null
            : 'That address answered, but Whombat doesn’t recognise what’s there.',
    };
  }
  return {
    url: at(0).url,
    reachable: false,
    catalogId: null,
    version: null,
    certificate: null,
    message: NOTHING_ANSWERED,
  };
}
