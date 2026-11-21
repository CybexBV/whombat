/**
 * What recognises a service at an address (docs/decisions/connections-setup.md CS-13, CS-14): the catalog's discovery
 * probes (`CatalogEntry.discovery`), sent unauthenticated through `lib/probe.ts` under the connections' destination rule
 * (`connectionPolicy`, CX-40), for `connections.identify` (the address a person typed) and `connections.discover` (each
 * open port a scan found). Nothing secret goes with them, so the certificate is read rather than enforced on the home
 * network (and must verify anywhere else).
 *
 * Tests stand stubs on 127.0.0.1 behind home-network addresses and the services' own ports through
 * `useDiscoveryNetForTests` (refused outside `NODE_ENV=test`): this machine's interfaces, and where an address and port
 * are really dialled. No production check is relaxed for them.
 */
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';
import {
  type CatalogEntry,
  type DiscoveryProbe,
  type PresentedCertificate,
  probeMatches,
  probeVersion,
} from '@whombat/core';
import type { z } from 'zod';
import { OutboundError, type OutboundPolicy } from '../lib/outbound';
import { PROBE_DEADLINE_MS, type ProbeAnswer, type ProbeDial, probeRequest } from '../lib/probe';
import type { Services } from '../services';
import { connectionPolicy } from './destination';

/** This machine's network as discovery sees it. */
export interface DiscoveryNet {
  /** This machine's interfaces (`os.networkInterfaces()`). */
  interfaces(): NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** Where an address and port are really dialled (null: nothing listens there); null: as addressed. */
  dial: ProbeDial | null;
}

const systemNet: DiscoveryNet = { interfaces: () => networkInterfaces(), dial: null };

const overrides = new WeakMap<Services, DiscoveryNet>();

/** Tests only: fake interfaces, and stubs on 127.0.0.1 behind addresses and ports. Refused outside `NODE_ENV=test`. */
export function useDiscoveryNetForTests(services: Services, net: Partial<DiscoveryNet>): void {
  if (services.config.NODE_ENV !== 'test') throw new Error('The discovery network seam is for tests only.');
  overrides.set(services, { ...systemNet, ...net });
}

export function discoveryNetOf(services: Services): DiscoveryNet {
  return overrides.get(services) ?? systemNet;
}

/** What an entry's probes found at one address. */
export interface EntryProbe {
  /** Something answered over HTTP there. */
  answered: boolean;
  /** Every probe matched: it is the entry. */
  matched: boolean;
  /** The version a matching probe named. */
  version: string | null;
  /** Over https: the certificate presented, and whether it verified. */
  certificate: PresentedCertificate | null;
  /** An https address on the internet whose certificate didn't verify: nothing was sent. */
  untrusted: boolean;
}

type Probe = z.output<typeof DiscoveryProbe>;

/** Any address answers this (an entry without discovery: is something there, and which certificate?). */
const ROOT_PROBE: Probe = { method: 'GET', path: '/', headers: {} };

/**
 * One host's probes (one identify, or one address of a scan): each request is sent once and each origin's policy read
 * once, whichever entries ask (UniFi Network and Protect share `/api/system`).
 */
export class HostProbes {
  readonly #answers = new Map<string, Promise<ProbeAnswer | OutboundError>>();
  readonly #policies = new Map<string, Promise<OutboundPolicy>>();

  constructor(private readonly services: Services) {}

  /** Runs the entry's discovery probes at `base` (`https://192.168.1.10:8006`), in order; all must match. */
  async entryAt(entry: CatalogEntry, base: string): Promise<EntryProbe> {
    return this.#run(entry.discovery?.probes ?? [], base, true);
  }

  /** `GET {base}/`, matching nothing: whether something answers there, and its certificate. */
  async rootAt(base: string): Promise<EntryProbe> {
    return this.#run([ROOT_PROBE], base, false);
  }

  async #run(probes: readonly Probe[], base: string, match: boolean): Promise<EntryProbe> {
    const out: EntryProbe = {
      answered: false,
      matched: false,
      version: null,
      certificate: null,
      untrusted: false,
    };
    if (probes.length === 0) return out;
    for (const probe of probes) {
      const answer = await this.#send(base, probe);
      if (answer instanceof OutboundError) {
        out.untrusted = answer.reason === 'untrusted_certificate';
        return out;
      }
      out.answered = true;
      out.certificate ??= answer.certificate;
      if (!match || !probeMatches(probe, answer)) return out;
      out.version ??= probeVersion(probe, answer);
    }
    out.matched = true;
    return out;
  }

  #send(base: string, probe: Probe): Promise<ProbeAnswer | OutboundError> {
    const url = `${base}${probe.path}`;
    const key = `${probe.method} ${url}\n${JSON.stringify(probe.headers)}\n${probe.body ?? ''}`;
    let answer = this.#answers.get(key);
    if (!answer) {
      const dial = discoveryNetOf(this.services).dial;
      answer = this.#policy(base).then(
        (policy) =>
          probeRequest(
            url,
            {
              method: probe.method,
              headers: { 'user-agent': 'Whombat', accept: '*/*', ...probe.headers },
              ...(probe.body !== undefined ? { body: probe.body } : {}),
            },
            policy,
            dial ? { dial } : {},
          ).catch((err: unknown) =>
            err instanceof OutboundError ? err : new OutboundError('network', String(err)),
          ),
        (err: unknown) => (err instanceof OutboundError ? err : new OutboundError('network', String(err))),
      );
      this.#answers.set(key, answer);
    }
    return answer;
  }

  /** The connections' destination rule for this origin (CX-40), with a probe's short deadline. */
  #policy(base: string): Promise<OutboundPolicy> {
    const origin = new URL(base).origin;
    let policy = this.#policies.get(origin);
    if (!policy) {
      policy = connectionPolicy(this.services, origin, { deadlineMs: PROBE_DEADLINE_MS });
      this.#policies.set(origin, policy);
    }
    return policy;
  }
}
