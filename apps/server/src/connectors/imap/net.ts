/**
 * Mail servers under the destination policy (docs/decisions/connections-more.md CM-23, connections-more-mail.md CM-M09):
 * a server's host is resolved by the policy's lookup (the Vault's, `vault/net.ts`), every address it resolves to is
 * checked with the same rule as any connection (public addresses; a home-network address only when the person listed it
 * with that port, or the local network is open), and the socket goes to one of exactly those addresses, with the host
 * name kept for TLS. Public servers are reached on any port: nothing crosses the internet unencrypted (CM-22).
 *
 * Discovery's fetches (CM-20) are https to public addresses only, DNS pinned, 5 seconds and 256 KB each; MX and SRV
 * lookups use the system resolver with a 3 second timeout.
 *
 * Tests reach fakes through `useMailNetForTests` (refused outside `NODE_ENV=test`): an in-memory IMAP account or a CA
 * for an in-process TLS server, and discovery answers. The address checks run as in production (the Vault's seam maps a
 * checked home-network address to 127.0.0.1).
 */
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { type MailServer, vaultDestinationProblem } from '@whombat/core';
import { outboundRequest } from '../../lib/outbound';
import type { Services } from '../../services';
import { vaultNetOf } from '../../vault/net';
import { destinationReach } from '../../vault/store';
import type { DiscoverDeps } from './discover';
import { MailError, type MailSide } from './errors';
import { type MailEndpoint, type MailTimeouts, type OpenImap, openImapflow } from './session';
import { nodemailerSmtp, type SmtpClient } from './smtp';
import type { ImapAccount, MailConnector } from './workspace';

export interface MailNet {
  openImap?: OpenImap;
  smtp?: SmtpClient;
  /** A certificate authority to trust besides the system's (an in-process TLS server's). */
  ca?: string;
  timeouts?: Partial<MailTimeouts>;
  discover?: Partial<DiscoverDeps>;
}

const overrides = new WeakMap<Services, MailNet>();

/** Tests only: fakes for the mail servers and discovery. Refused outside `NODE_ENV=test`. */
export function useMailNetForTests(services: Services, net: MailNet): void {
  if (services.config.NODE_ENV !== 'test') throw new Error('The mail network seam is for tests only.');
  overrides.set(services, net);
}

export function mailNetOf(services: Services): MailNet {
  return overrides.get(services) ?? {};
}

/** The pseudo URL the destination rule reads: scheme https (nothing goes out in plain text), the host, the port. */
function ruleUrl(host: string, port: number): string {
  return `https://${isIP(host) === 6 ? `[${host}]` : host}:${port}/`;
}

/**
 * Where a server may be reached now: one checked address, or a `MailError` `not_allowed` with the rule's reason
 * (`at: 'save'` the reason in full, with the network to add; `call` the short “isn't allowed any more”).
 */
export async function mailEndpoint(
  services: Services,
  side: MailSide,
  server: MailServer,
  at: 'save' | 'call' = 'call',
): Promise<MailEndpoint> {
  const host = server.host.replace(/^\[|\]$/g, '').toLowerCase();
  const net = vaultNetOf(services);
  let resolved: string[] = [];
  if (isIP(host)) resolved = [host];
  else {
    try {
      resolved = (await net.resolve(host)).map((a) => a.address);
    } catch {
      resolved = [];
    }
    if (resolved.length === 0) throw new MailError(side, 'unreachable', host, server.port);
  }
  const problem = vaultDestinationProblem({
    url: ruleUrl(host, server.port),
    resolved,
    ...(await destinationReach(services)),
    at,
  });
  if (problem) throw new MailError(side, 'not_allowed', host, server.port, problem.message);
  const address = resolved[0] as string;
  return {
    address: net.dialAddress ? net.dialAddress(address) : address,
    host,
    port: server.port,
    security: server.security,
  };
}

/** The connector the adapter uses: both sides opened under the policy. */
export function mailConnector(services: Services): MailConnector {
  const net = () => mailNetOf(services);
  const extra = () => ({
    ...(net().ca ? { ca: net().ca } : {}),
    ...(net().timeouts ? { timeouts: net().timeouts } : {}),
  });
  const smtpOptions = async (account: ImapAccount) => ({
    ...(await mailEndpoint(services, 'smtp', account.smtp)),
    user: account.user,
    pass: account.password,
    ...extra(),
  });
  return {
    async imap(account) {
      const endpoint = await mailEndpoint(services, 'imap', account.imap);
      return (net().openImap ?? openImapflow)({
        ...endpoint,
        user: account.user,
        pass: account.password,
        ...extra(),
      });
    },
    async smtpVerify(account) {
      await (net().smtp ?? nodemailerSmtp).verify(await smtpOptions(account));
    },
    async smtpSend(account, envelope, raw) {
      return (net().smtp ?? nodemailerSmtp).send(await smtpOptions(account), envelope, raw);
    },
  };
}

const DISCOVERY_FETCH_MS = 5_000;
const DISCOVERY_MAX_BYTES = 256 * 1024;

/** Discovery's fetches and lookups (CM-20). */
export function discoverDeps(services: Services): DiscoverDeps {
  const seam = mailNetOf(services).discover ?? {};
  const resolver = new Resolver({ timeout: 3_000, tries: 2 });
  return {
    fetchText:
      seam.fetchText ??
      (async (url) => {
        try {
          const res = await outboundRequest(
            url,
            { method: 'GET', headers: { accept: 'application/xml, text/xml' } },
            {
              resolve: vaultNetOf(services).resolve,
              maxBytes: DISCOVERY_MAX_BYTES,
              timeoutMs: DISCOVERY_FETCH_MS,
              deadlineMs: DISCOVERY_FETCH_MS,
            },
          );
          return res.status === 200 ? res.body.toString('utf8') : null;
        } catch {
          return null;
        }
      }),
    mx: seam.mx ?? ((domain) => resolver.resolveMx(domain)),
    srv: seam.srv ?? ((name) => resolver.resolveSrv(name)),
  };
}
