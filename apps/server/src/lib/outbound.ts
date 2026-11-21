/**
 * Outbound requests to user- or agent-supplied URLs (ARCHITECTURE "Outbound requests"): the one helper every
 * such fetch goes through. It
 *
 * - accepts `https:` only;
 * - refuses private, loopback, link-local, shared, multicast and reserved addresses — IP literals up front,
 *   and host names at connect time (the address actually dialled is the one checked, so DNS rebinding
 *   between a check and the request does not help);
 * - never follows redirects (a 3xx is returned as is);
 * - caps the response body and the time the request may take.
 *
 * `allowPrivate` lifts the address and scheme rules for tests and local mocks only; the server config refuses
 * it in production (`WHOMBAT_OUTBOUND_ALLOW_PRIVATE`). Everything this helper throws is an `OutboundError`.
 *
 * The Vault (docs/decisions/vault.md VT-10…VT-13) replaces the address rule with its own per-call `destination`
 * policy (public https, or listed home networks and ports; never loopback, link-local or metadata), checked against
 * the IP literal up front and against every address the host resolves to at connect time (the socket then dials one
 * of exactly those). It also sets a total `deadlineMs` (the socket timeout alone is an idle timeout), a request body
 * cap and `truncateAt` (keep that much of the answer and stop reading, instead of failing).
 *
 * `pinnedCertSha256` (catalog connections, a self-signed Proxmox on the home network: connections-catalog.md CX-60) is
 * for addresses on the home network only: every address the host resolves to (or the IP literal) must be non-public,
 * the scheme `https:`, and the TLS handshake is accepted when the server's leaf certificate has exactly that SHA-256
 * fingerprint and refused otherwise — chain and host name are not consulted, nothing else passes. The check runs
 * after the handshake and before the request is written, so a wrong certificate never sees the request or its token.
 * A certificate that doesn't verify without a pin fails `untrusted_certificate`, and `presentedCertSha256` reads the
 * fingerprint a home-network server presents (a handshake only), for the person to compare and pin (CX-D33).
 *
 * `outboundDatagram` sends one UDP datagram under the same rule and waits for one answer from the address it went to
 * (a console's discovery: who is there, awake or resting). The URL names the host and port; its scheme only lets the
 * rule judge it.
 */
import { createSocket } from 'node:dgram';
import { lookup as dnsLookup } from 'node:dns/promises';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction, type Socket } from 'node:net';
import tls from 'node:tls';
import { addressIsPublic } from '@whombat/core';

export type OutboundRefusal = 'bad_url' | 'scheme' | 'private_address' | 'host_not_allowed' | 'destination';
export type OutboundFailure = 'too_large' | 'timeout' | 'network' | 'certificate' | 'untrusted_certificate';

export class OutboundError extends Error {
  constructor(
    readonly reason: OutboundRefusal | OutboundFailure,
    message: string,
  ) {
    super(message);
    this.name = 'OutboundError';
  }

  /** The URL itself is not allowed (as opposed to a failure while talking to an allowed one). */
  get refused(): boolean {
    return ['bad_url', 'scheme', 'private_address', 'host_not_allowed', 'destination'].includes(this.reason);
  }
}

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const)
  BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64 can reach IPv4 inside
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 embeds any IPv4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10],
  ['ff00::', 8], // multicast
] as const)
  BLOCKED.addSubnet(net, prefix, 'ipv6');

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` / `::ffff:xxxx:xxxx`). */
function mappedIPv4(ip: string): string | null {
  const m = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(.+)$/i.exec(ip);
  if (!m?.[1]) return null;
  const rest = m[1];
  if (isIP(rest) === 4) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!hex?.[1] || !hex[2]) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * True for an address on the public internet; false for anything private, local or reserved (or not an IP). Core's
 * `addressIsPublic` must agree too: it also refuses cloud metadata endpoints (168.63.129.16 …), IPv4-compatible
 * `::/96` and the `3fff::/20` documentation range (contracts CT-98, docs/decisions/vault.md VT-D02).
 */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  if (family === 6) {
    const v4 = mappedIPv4(ip);
    if (v4) return isPublicAddress(v4);
  }
  return !BLOCKED.check(ip, family === 4 ? 'ipv4' : 'ipv6') && addressIsPublic(ip);
}

/**
 * A per-call destination rule that replaces the public-address rule (the Vault's, VT-10…VT-13). `check` gets the host
 * and every address it resolves to (or the IP literal) before anything connects, and throws an `OutboundError`
 * (`destination`) to refuse; the socket then dials one of exactly those addresses (DNS pinned).
 */
export interface OutboundDestination {
  schemes: readonly ('http:' | 'https:')[];
  check(hostname: string, addresses: readonly string[]): void;
}

export interface OutboundPolicy {
  /** Tests and local mocks only: allow `http:` and private addresses. */
  allowPrivate?: boolean;
  /** Further restricts the host name (e.g. to known push services). Not applied with `allowPrivate`. */
  allowHost?: (hostname: string) => boolean;
  /** Replaces the public-address and scheme rules (and `allowPrivate`) with the caller's destination rule. */
  destination?: OutboundDestination;
  /** Response body cap (default 1 MiB): a larger answer fails `too_large` (unless `truncateAt` is set). */
  maxBytes?: number;
  /** Keep at most this many bytes of the answer and stop reading (`truncated`), instead of failing. */
  truncateAt?: number;
  /** Socket idle timeout (default 10 s). */
  timeoutMs?: number;
  /** Total deadline for the whole request, connect to last byte (default none: only the idle timeout). */
  deadlineMs?: number;
  /** Request body cap in bytes (default none). */
  maxRequestBytes?: number;
  /** DNS resolution (tests). Defaults to the system resolver. */
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  /**
   * Tests only (the Vault's seam): the address a checked address is actually dialled at, so a fake on 127.0.0.1 can
   * stand behind a home-network address. Every check still runs on the resolved address.
   */
  dialAddress?: (address: string) => string;
  /**
   * Home-network addresses only: accept exactly the leaf certificate with this SHA-256 fingerprint (hex, colons and
   * case ignored) instead of verifying its chain and host name. A different certificate fails `certificate`.
   */
  pinnedCertSha256?: string;
  /** Home-network addresses over https only, as a pin needs (`presentedCertSha256`, CX-D33). */
  homeNetworkOnly?: boolean;
}

/** A pin, or the certificate probe: the address must be on the home network and the scheme https. */
function homeNetworkOnly(policy: OutboundPolicy): boolean {
  return policy.pinnedCertSha256 !== undefined || policy.homeNetworkOnly === true;
}

/**
 * Node's codes for a certificate that didn't verify: self-signed, from an authority Whombat doesn't know, expired or not
 * yet valid, or for another host name. They fail `untrusted_certificate` (CX-D33), not `network`.
 */
const UNTRUSTED_CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** An error of the request or its socket as an `OutboundError`. */
export function outboundErrorOf(err: unknown): OutboundError {
  if (err instanceof OutboundError) return err;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && UNTRUSTED_CERTIFICATE_CODES.has(code))
    return new OutboundError('untrusted_certificate', String(err));
  return new OutboundError('network', String(err));
}

export interface OutboundInit {
  method: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export interface OutboundResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** `truncateAt` cut the answer short. */
  truncated?: boolean;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Parses and checks a URL against the policy without connecting. Throws `OutboundError`. */
export function checkOutboundUrl(raw: string, policy: OutboundPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundError('bad_url', 'Not a URL.');
  }
  const schemes: readonly string[] = policy.destination
    ? policy.destination.schemes
    : policy.allowPrivate
      ? ['https:', 'http:']
      : ['https:'];
  if (!schemes.includes(url.protocol)) throw new OutboundError('scheme', `${url.protocol} is not allowed.`);
  if (url.username || url.password)
    throw new OutboundError('bad_url', 'URLs with credentials are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (policy.pinnedCertSha256 !== undefined && !normalisedPin(policy.pinnedCertSha256))
    throw new OutboundError('bad_url', 'A pinned certificate is a SHA-256 fingerprint (32 bytes in hex).');
  if (homeNetworkOnly(policy)) {
    if (url.protocol !== 'https:')
      throw new OutboundError('scheme', 'A pinned certificate needs an https address.');
    if (isIP(host) && isPublicAddress(host))
      throw new OutboundError(
        'destination',
        'A pinned certificate is only for addresses on your home network.',
      );
  }
  if (policy.destination) {
    // An IP literal never goes through the lookup: its one address is checked here.
    if (isIP(host)) policy.destination.check(host, [host]);
  } else if (!policy.allowPrivate) {
    if (isIP(host) && !isPublicAddress(host))
      throw new OutboundError('private_address', `${host} is not a public address.`);
    if (policy.allowHost && !policy.allowHost(host.toLowerCase()))
      throw new OutboundError('host_not_allowed', `${host} is not allowed here.`);
  }
  return url;
}

/**
 * A lookup that only ever hands the socket addresses the policy allows (public ones by default). `onResolved` hears
 * every address the host resolved to once they passed (the probes' home-network test, `lib/probe.ts`).
 */
export function safeLookup(
  policy: OutboundPolicy,
  onResolved?: (addresses: readonly string[]) => void,
): LookupFunction {
  const resolve =
    policy.resolve ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  return (hostname, options, callback) => {
    resolve(hostname)
      .then((addresses) => {
        if (addresses.length === 0) throw new OutboundError('network', `${hostname} did not resolve.`);
        if (policy.destination) {
          // Every address, before the socket gets any of them (a host that resolves partly private is refused).
          policy.destination.check(
            hostname,
            addresses.map((a) => a.address),
          );
        } else if (!policy.allowPrivate) {
          const inside = addresses.find((a) => !isPublicAddress(a.address));
          if (inside)
            throw new OutboundError(
              'private_address',
              `${hostname} resolves to ${inside.address}, not a public address.`,
            );
        }
        if (homeNetworkOnly(policy)) {
          const outside = addresses.find((a) => isPublicAddress(a.address));
          if (outside)
            throw new OutboundError(
              'destination',
              `${hostname} resolves to ${outside.address}: a pinned certificate is only for your home network.`,
            );
        }
        onResolved?.(addresses.map((a) => a.address));
        const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
        const dial = policy.dialAddress;
        const usable = (wanted ? addresses.filter((a) => a.family === wanted) : addresses).map((a) =>
          dial ? { address: dial(a.address), family: isIP(dial(a.address)) || a.family } : a,
        );
        if (usable.length === 0)
          throw new OutboundError('network', `${hostname} has no IPv${wanted} address.`);
        if (options.all) callback(null, usable);
        else callback(null, usable[0]?.address ?? '', usable[0]?.family ?? 4);
      })
      .catch((err: unknown) => {
        callback(err instanceof Error ? (err as NodeJS.ErrnoException) : new Error(String(err)), '', 4);
      });
  };
}

/** A SHA-256 fingerprint as 64 upper-case hex digits, or null when it isn't one. */
export function normalisedPin(pin: string): string | null {
  const hex = pin.replace(/[:\s]/g, '').toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex : null;
}

/**
 * An agent whose TLS sockets are handed to the request only after the server's leaf certificate matched `pin`: the
 * handshake skips chain and host-name verification (a self-signed certificate) and the fingerprint decides alone.
 */
function pinnedAgent(pin: string): https.Agent {
  const agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
  type Done = (err: Error | null, socket?: Socket) => void;
  (
    agent as unknown as { createConnection: (o: tls.ConnectionOptions, cb: Done) => undefined }
  ).createConnection = (options, callback) => {
    let called = false;
    const done: Done = (err, socket) => {
      if (called) return;
      called = true;
      callback(err, socket);
    };
    const socket = tls.connect({
      ...options,
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
      session: undefined,
    });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const seen = cert?.fingerprint256 ? normalisedPin(cert.fingerprint256) : null;
      if (seen !== pin) {
        socket.destroy();
        done(new OutboundError('certificate', 'The server’s certificate isn’t the pinned one.'));
        return;
      }
      socket.removeListener('error', onError);
      done(null, socket);
    });
    const onError = (err: Error) => done(err);
    socket.once('error', onError);
    return undefined;
  };
  return agent;
}

/**
 * What a client that opens its own connection (a WebSocket: sign in once with Home Assistant, connections-setup.md
 * CS-22) needs to stay under the policy: the checked URL, the lookup that checks and pins every address the host
 * resolves to, and with a pinned certificate the agent that accepts exactly that leaf. Without a pin, TLS verifies as
 * usual. Throws `OutboundError` when the URL itself isn't allowed.
 */
export function outboundConnectOptions(
  raw: string,
  policy: OutboundPolicy = {},
): { url: URL; lookup: LookupFunction; agent?: https.Agent } {
  const url = checkOutboundUrl(raw, policy);
  const pin = policy.pinnedCertSha256 !== undefined ? normalisedPin(policy.pinnedCertSha256) : null;
  return { url, lookup: safeLookup(policy), ...(pin ? { agent: pinnedAgent(pin) } : {}) };
}

/** Sends one request under the policy. Resolves with any status (3xx included); throws `OutboundError`. */
export function outboundRequest(
  raw: string,
  init: OutboundInit,
  policy: OutboundPolicy = {},
): Promise<OutboundResponse> {
  let url: URL;
  try {
    url = checkOutboundUrl(raw, policy);
  } catch (err) {
    return Promise.reject(err);
  }
  const maxBytes = policy.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const truncateAt = policy.truncateAt;
  if (policy.maxRequestBytes !== undefined && init.body !== undefined) {
    const size = typeof init.body === 'string' ? Buffer.byteLength(init.body) : init.body.length;
    if (size > policy.maxRequestBytes)
      return Promise.reject(
        new OutboundError('too_large', `The request body is larger than ${policy.maxRequestBytes} bytes.`),
      );
  }
  const transport = url.protocol === 'https:' ? https : http;
  const pin = policy.pinnedCertSha256 !== undefined ? normalisedPin(policy.pinnedCertSha256) : null;
  return new Promise<OutboundResponse>((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout | null = null;
    const done = () => {
      if (deadline) clearTimeout(deadline);
      deadline = null;
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      done();
      reject(outboundErrorOf(err));
    };
    const req = transport.request(
      url,
      {
        method: init.method,
        headers: init.headers,
        lookup: safeLookup(policy),
        agent: pin ? pinnedAgent(pin) : false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = (truncated: boolean) => {
          if (settled) return;
          settled = true;
          done();
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            ...(truncated ? { truncated } : {}),
          });
        };
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (truncateAt !== undefined && size + chunk.length > truncateAt) {
            chunks.push(chunk.subarray(0, Math.max(0, truncateAt - size)));
            size = truncateAt;
            finish(true);
            req.destroy();
            return;
          }
          size += chunk.length;
          if (size > maxBytes) {
            fail(new OutboundError('too_large', `The response is larger than ${maxBytes} bytes.`));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish(false));
        res.on('error', fail);
      },
    );
    if (policy.deadlineMs !== undefined) {
      deadline = setTimeout(() => {
        fail(new OutboundError('timeout', `No answer within ${policy.deadlineMs} ms.`));
        req.destroy();
      }, policy.deadlineMs);
      deadline.unref?.();
    }
    req.setTimeout(timeoutMs, () => {
      fail(new OutboundError('timeout', `No answer within ${timeoutMs} ms.`));
      req.destroy();
    });
    req.on('error', fail);
    req.end(init.body);
  });
}

/**
 * The SHA-256 fingerprint (`AB:CD:…`) of the leaf certificate a home-network https server presents, from a bare TLS
 * handshake under the policy: nothing is written to the socket, so no request and no token goes out. What a person
 * compares with what the device shows before pinning it (connections-catalog.md CX-D33). Home-network addresses only,
 * as a pin. Throws `OutboundError`.
 */
export function presentedCertSha256(raw: string, policy: OutboundPolicy = {}): Promise<string> {
  const probe: OutboundPolicy = { ...policy, homeNetworkOnly: true };
  delete probe.pinnedCertSha256;
  let url: URL;
  try {
    url = checkOutboundUrl(raw, probe);
  } catch (err) {
    return Promise.reject(err);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const timeoutMs = Math.min(policy.timeoutMs ?? DEFAULT_TIMEOUT_MS, policy.deadlineMs ?? DEFAULT_TIMEOUT_MS);
  return new Promise<string>((resolve, reject) => {
    const socket = tls.connect({
      host,
      port: Number(url.port || 443),
      ...(isIP(host) ? {} : { servername: host }),
      lookup: safeLookup(probe),
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new OutboundError('timeout', `No handshake within ${timeoutMs} ms.`));
    }, timeoutMs);
    timer.unref?.();
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const fingerprint = socket.getPeerCertificate()?.fingerprint256;
      socket.destroy();
      if (fingerprint && normalisedPin(fingerprint)) resolve(fingerprint.toUpperCase());
      else reject(new OutboundError('network', 'The server presented no certificate.'));
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(outboundErrorOf(err));
    });
  });
}

/** The most of a datagram's answer that is kept. */
const DATAGRAM_MAX_BYTES = 4096;

/**
 * One UDP datagram to the host and port of `raw` under the policy, and the first answer from that address (at most
 * 4 KiB), or null when none came within the policy's timeout (default 1.5 s). The host and every address it resolves
 * to are checked first, as for a request; a refusal throws `OutboundError`. A socket error is no answer.
 */
export async function outboundDatagram(
  raw: string,
  payload: Buffer,
  policy: OutboundPolicy = {},
): Promise<Buffer | null> {
  const url = checkOutboundUrl(raw, policy);
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new OutboundError('bad_url', 'A datagram needs a port.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const timeoutMs = Math.min(policy.timeoutMs ?? 1_500, policy.deadlineMs ?? 1_500);
  const address = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    if (isIP(host)) {
      const dialled = policy.dialAddress ? policy.dialAddress(host) : host;
      resolve({ address: dialled, family: isIP(dialled) });
      return;
    }
    safeLookup(policy)(host, { family: 0, all: false }, (err, a, family) => {
      if (err) reject(err instanceof OutboundError ? err : new OutboundError('network', String(err)));
      else resolve({ address: String(a), family: Number(family) || isIP(String(a)) });
    });
  });
  return new Promise<Buffer | null>((resolve) => {
    const socket = createSocket(address.family === 6 ? 'udp6' : 'udp4');
    let done = false;
    const finish = (answer: Buffer | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      resolve(answer);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    socket.on('message', (msg, from) => {
      if (from.address === address.address) finish(msg.subarray(0, DATAGRAM_MAX_BYTES));
    });
    socket.on('error', () => finish(null));
    socket.send(payload, port, address.address, (err) => {
      if (err) finish(null);
    });
  });
}
