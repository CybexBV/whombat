/**
 * Unauthenticated probes (docs/decisions/connections-setup.md CS-13, CS-14): what answers at an address, before anything
 * secret is sent to it. One request under the caller's outbound policy (its destination rule, checked against the IP
 * literal or every address the host resolves to, DNS pinned), with the certificate read instead of enforced:
 *
 * - over https the answer carries the leaf certificate's SHA-256 (`AB:CD:…`) and whether it verified normally (chain
 *   and host name). One that doesn't verify is accepted only when every address is non-public — the home network, where
 *   self-signed certificates are the rule — and refused (`untrusted_certificate`) before the request is written
 *   anywhere else: on the internet a probe talks only to a server that proves who it is;
 * - no redirect is followed (a 3xx is an answer), the body is cut at 64 KiB, and the whole request has a 3 s deadline;
 * - nothing secret ever goes with a probe: callers send the catalog's discovery requests only, never a token or a cookie
 *   (which is why verification can be off at all). A pin in the policy is ignored: a probe reads what is there.
 *
 * `dial` says where an address and port are really dialled: tests stand stubs on 127.0.0.1 behind home-network
 * addresses and the services' own ports (`connections/finder.ts`); null means nothing listens there.
 */
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { createConnection, isIP, type NetConnectOpts, type Socket } from 'node:net';
import tls from 'node:tls';
import type { PresentedCertificate } from '@whombat/core';
import {
  checkOutboundUrl,
  isPublicAddress,
  normalisedPin,
  OutboundError,
  type OutboundPolicy,
  outboundErrorOf,
  safeLookup,
} from './outbound';

/** The most of an answer a probe keeps (CS-13): enough for a login page's markers. */
export const PROBE_BODY_MAX = 64 * 1024;
/** A probe's whole time, connect to last byte (CS-14: 3 s each). */
export const PROBE_DEADLINE_MS = 3_000;

export type ProbeDial = (address: string, port: number) => { address: string; port: number } | null;

export interface ProbeInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ProbeOptions {
  /** Where an address and port are really dialled; null: nothing listens there. Default: the policy's `dialAddress`. */
  dial?: ProbeDial;
}

export interface ProbeAnswer {
  status: number;
  headers: IncomingHttpHeaders;
  /** At most `PROBE_BODY_MAX` bytes, as UTF-8. */
  body: string;
  /** Over https: the leaf certificate and whether it verified (chain and host name); null over http. */
  certificate: PresentedCertificate | null;
}

type Done = (err: Error | null, socket?: Socket) => void;
type ConnectionOptions = tls.ConnectionOptions & { host?: string; port?: number | string };

/**
 * An agent whose sockets go where `dial` says, after `lookup` checked the host's addresses (an IP literal was checked
 * with the URL). Over TLS the handshake never fails on the certificate: `onSecure` decides, before the request is
 * written, and reads what was presented.
 */
function probeAgent(
  scheme: 'http:' | 'https:',
  lookup: ReturnType<typeof safeLookup>,
  dial: ProbeDial,
  onSecure: (socket: tls.TLSSocket) => OutboundError | null,
): http.Agent {
  const agent =
    scheme === 'https:'
      ? new https.Agent({ keepAlive: false, maxCachedSessions: 0 })
      : new http.Agent({ keepAlive: false });
  (agent as unknown as { createConnection: (o: ConnectionOptions, cb: Done) => undefined }).createConnection =
    (options, callback) => {
      let called = false;
      const done: Done = (err, socket) => {
        if (called) return;
        called = true;
        callback(err, socket);
      };
      const host = String(options.host ?? '');
      const port = Number(options.port);
      const connect = (address: string) => {
        const target = dial(address, port);
        if (!target) {
          done(new OutboundError('network', `Nothing answered at ${address}:${port}.`));
          return;
        }
        const base = { ...options, host: target.address, port: target.port, lookup: undefined };
        if (scheme === 'http:') {
          done(null, createConnection(base as NetConnectOpts));
          return;
        }
        const socket = tls.connect({
          ...base,
          // The host name is what the certificate is verified against (an IP literal: the address itself).
          ...(isIP(host) ? {} : { servername: host }),
          rejectUnauthorized: false,
          session: undefined,
        });
        const onError = (err: Error) => done(err);
        socket.once('error', onError);
        socket.once('secureConnect', () => {
          const refused = onSecure(socket);
          if (refused) {
            socket.destroy();
            done(refused);
            return;
          }
          socket.removeListener('error', onError);
          done(null, socket);
        });
      };
      if (isIP(host)) connect(host);
      else
        lookup(host, { family: 0 }, (err, address) => {
          if (err) done(err);
          else connect(String(address));
        });
      return undefined;
    };
  return agent;
}

/**
 * Sends one unauthenticated probe under `policy` (its destination rule and resolver; its pin, body caps and longer
 * deadlines don't apply). Resolves with any status (3xx included) and, over https, the certificate presented; throws
 * `OutboundError` (`untrusted_certificate` for a certificate that didn't verify on a public address).
 */
export function probeRequest(
  raw: string,
  init: ProbeInit,
  policy: OutboundPolicy,
  options: ProbeOptions = {},
): Promise<ProbeAnswer> {
  const base: OutboundPolicy = { ...policy };
  delete base.pinnedCertSha256;
  delete base.homeNetworkOnly;
  delete base.dialAddress;
  let url: URL;
  try {
    url = checkOutboundUrl(raw, base);
  } catch (err) {
    return Promise.reject(err);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: readonly string[] = isIP(host) ? [host] : [];
  const lookup = safeLookup(base, (found) => {
    addresses = found;
  });
  const dialAddress = policy.dialAddress;
  const dial: ProbeDial =
    options.dial ?? ((address, port) => ({ address: dialAddress ? dialAddress(address) : address, port }));
  let certificate: PresentedCertificate | null = null;
  const agent = probeAgent(url.protocol === 'https:' ? 'https:' : 'http:', lookup, dial, (socket) => {
    const fingerprint = socket.getPeerCertificate()?.fingerprint256;
    if (!fingerprint || !normalisedPin(fingerprint))
      return new OutboundError('network', 'The server presented no certificate.');
    const trusted = socket.authorized;
    const home = addresses.length > 0 && addresses.every((a) => !isPublicAddress(a));
    if (!trusted && !home)
      return new OutboundError('untrusted_certificate', 'The server’s certificate isn’t valid.');
    certificate = { sha256: fingerprint.toUpperCase(), trusted };
    return null;
  });
  const deadlineMs = Math.max(1, Math.min(policy.deadlineMs ?? PROBE_DEADLINE_MS, PROBE_DEADLINE_MS));
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise<ProbeAnswer>((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(outboundErrorOf(err));
    };
    const req = transport.request(url, { method: init.method, headers: init.headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          certificate,
        });
      };
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        const room = PROBE_BODY_MAX - size;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        size += Math.min(chunk.length, room);
        if (size >= PROBE_BODY_MAX) {
          finish();
          req.destroy();
        }
      });
      res.on('end', finish);
      res.on('error', fail);
    });
    deadline = setTimeout(() => {
      fail(new OutboundError('timeout', `No answer within ${deadlineMs} ms.`));
      req.destroy();
    }, deadlineMs);
    deadline.unref?.();
    req.on('error', fail);
    req.end(init.body);
  });
}
