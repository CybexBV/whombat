/**
 * What development and tests stand in for (hermes-engine.md HE-49): one runtime mode, the appliance's, without a
 * manager, provisioning or control on the developer's machine.
 *
 * - **The identity**: the box's content key (Ed25519, libp2p protobuf, as provisioning writes it) made at the first
 *   start under `WHOMBAT_HOME/identity/content.key` (0600 in a 0700 directory) and kept from then on, so the box's
 *   PeerId stays the same across restarts.
 * - **The manager's socket**: a small HTTP server on a unix socket (`WHOMBAT_HOME/manager.sock`) answering the paths
 *   the runtime calls (`MANAGER_PATHS`) as a box without control does: reports are taken, nothing is pushed or
 *   renewed, there are no AI client bundles (the scripted Hermes needs none), the feedback drop is unsupported and
 *   the box's measurements, hardware and network aren't there. No relay: the boot doesn't open the relay endpoint.
 * - **The Whombat Team** (team-reports.md): a small team in memory that takes reports, numbers them and answers each new
 *   one a few seconds later (“Looking into it”), so the reports' pages, the Inbox and the push can be tried with
 *   `pnpm dev`. Nothing leaves the machine.
 * - **Tailscale** (hermes-engine.md HE-S236): a stand-in that turns on with a login link — on the person's own login server
 *   when one is named, else Tailscale's — and signs itself in a few seconds later as `whombat-dev.tail0000.ts.net`
 *   (no HTTPS, no certificate), so the app's setup and This Whombat can be tried against `pnpm dev`. Never the
 *   machine's own tailscaled.
 *
 * Never in production: the boot refuses to start without `WHOMBAT_MANAGER_SOCKET` and `WHOMBAT_CONTENT_KEY_FILE`
 * there (`productionIssues`).
 */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { defaultWhombatHome } from '@whombat/agent-runtime/host';
import { LOCAL_API_VERSION, MANAGER_PATHS } from '@whombat/control-contracts/local';
import { TAILSCALE_OFF, type TailscaleStatus } from '@whombat/protocol/session';
import { generateIdentity, serializeIdentity } from '@whombat/secure-channel';
import type { Config } from '../config';
import { FakeTeam, FakeTeamRefusal } from './fake-team';

/** Where development keeps the box's content key. */
export function devIdentityFile(home: string): string {
  return join(home, 'identity', 'content.key');
}

/** The content key under `home`, made on the first call; the path. */
export async function ensureDevIdentity(home: string): Promise<string> {
  const file = devIdentityFile(home);
  if (existsSync(file)) return file;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const identity = await generateIdentity();
  writeFileSync(file, serializeIdentity(identity), { mode: 0o600, flag: 'wx' });
  return file;
}

export interface StandInManager {
  path: string;
  /** Paths asked, in order (tests). */
  readonly asked: string[];
  close(): Promise<void>;
}

type Answer = { status: number; body: unknown };

const ok: Answer = { status: 200, body: { ok: true } };
const refused = (status: number, code: string, message: string): Answer => ({
  status,
  body: { error: { code, message } },
});

/** How long the stand-in Tailscale takes to “sign in” after it showed its link. */
export const STAND_IN_TAILSCALE_SIGN_IN_MS = 5_000;

/** The stand-in's Tailscale (development only): off, a login link, then on by itself (HE-S236). */
export class StandInTailscale {
  private running = false;
  private signedIn = false;
  private linkAt: number | null = null;
  private loginServer: string | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly signInMs = STAND_IN_TAILSCALE_SIGN_IN_MS,
  ) {}

  status(): TailscaleStatus {
    if (this.running && !this.signedIn && this.linkAt !== null && this.now() - this.linkAt >= this.signInMs) {
      this.signedIn = true;
      this.linkAt = null;
    }
    const server = this.loginServer ? { loginServer: this.loginServer } : {};
    if (!this.running) return { ...TAILSCALE_OFF, ...server };
    if (!this.signedIn)
      return {
        ...TAILSCALE_OFF,
        state: 'needs_sign_in',
        loginUrl: this.loginServer
          ? `${this.loginServer}/register/nodekey:whombatdev`
          : 'https://login.tailscale.com/a/whombatdev',
        ...server,
      };
    return {
      state: 'on',
      loginUrl: null,
      name: 'whombat-dev.tail0000.ts.net',
      addresses: ['100.64.0.1'],
      tailnet: 'development',
      https: false,
      problem: null,
      ...server,
    };
  }

  /** Two made-up devices on the stand-in tailnet while it is on (tailnet-reach.md TN-06), never this machine's tailnet. */
  peers() {
    if (this.status().state !== 'on') return [];
    return [
      {
        name: 'nas.tail0000.ts.net',
        addresses: ['100.64.0.2'],
        os: 'linux',
        online: true,
        lastSeen: null,
        routes: [],
        exitNode: false,
      },
      {
        name: 'router.tail0000.ts.net',
        addresses: ['100.64.0.3'],
        os: 'linux',
        online: false,
        lastSeen: '2026-10-30T08:00:00Z',
        routes: ['192.168.50.0/24'],
        exitNode: true,
      },
    ];
  }

  on(body: { loginServer?: unknown }): TailscaleStatus {
    const server = typeof body.loginServer === 'string' ? body.loginServer : undefined;
    if (server !== this.loginServer) this.signedIn = false;
    this.loginServer = server;
    this.running = true;
    if (!this.signedIn) this.linkAt = this.now();
    return this.status();
  }

  off(body: { signOut?: unknown }): TailscaleStatus {
    this.running = false;
    if (body.signOut === true) this.signedIn = false;
    this.linkAt = null;
    return this.status();
  }

  signIn(): TailscaleStatus {
    this.running = true;
    this.signedIn = false;
    this.linkAt = this.now();
    return this.status();
  }
}

/** How long the stand-in team takes to answer a new report. */
export const STAND_IN_TEAM_REPLY_MS = 5_000;

/** The stand-in team's answer to one team report path; control's refusals as the manager passes them on. */
function teamAnswer(team: FakeTeam, path: string, body: Record<string, unknown>): Answer {
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  try {
    switch (path) {
      case MANAGER_PATHS.teamReportsList:
        return { status: 200, body: team.list() };
      case MANAGER_PATHS.teamReportsGet:
        return { status: 200, body: team.get({ reportId: text(body.reportId) }) };
      case MANAGER_PATHS.teamReportsCreate:
        return {
          status: 200,
          body: team.create({ requestId: text(body.requestId), payload: text(body.payload) }),
        };
      case MANAGER_PATHS.teamReportsReply:
        return {
          status: 200,
          body: team.reply({
            requestId: text(body.requestId),
            reportId: text(body.reportId),
            payload: text(body.payload),
          }),
        };
      default: {
        const action = body.action;
        if (action !== 'works' && action !== 'still_happening' && action !== 'withdraw')
          return refused(400, 'bad_request', 'Not an action on a report.');
        return {
          status: 200,
          body: team.act({ requestId: text(body.requestId), reportId: text(body.reportId), action }),
        };
      }
    }
  } catch (err) {
    if (err instanceof FakeTeamRefusal)
      return refused(502, 'control_refused', `refused ${err.code}: control refused it: ${err.message}`);
    throw err;
  }
}

/**
 * What the stand-in answers for one path (POST or GET); `tailscale` keeps its Tailscale between calls and `team` the
 * reports to the Whombat Team.
 */
export function standInAnswer(
  path: string,
  body: Record<string, unknown> = {},
  tailscale: StandInTailscale = new StandInTailscale(),
  team: FakeTeam = new FakeTeam({ replyAfterMs: STAND_IN_TEAM_REPLY_MS }),
): Answer {
  const state = (status: TailscaleStatus): Answer => ({
    status: 200,
    body: { v: LOCAL_API_VERSION, tailscale: status },
  });
  switch (path) {
    case MANAGER_PATHS.claimed:
    case MANAGER_PATHS.revocations:
    case MANAGER_PATHS.feedbackAck:
    case MANAGER_PATHS.feedbackReporters:
      return ok;
    case MANAGER_PATHS.push:
      return { status: 200, body: { accepted: 0, invalidHandles: [], rateLimited: false } };
    // No control here: the stand-in keeps the passkey-locked backup details as control would (backup-passkey.md).
    case MANAGER_PATHS.kitEnvelopes:
      return {
        status: 200,
        body: { stored: Array.isArray(body.envelopes) ? Math.min(body.envelopes.length, 64) : 0, skipped: 0 },
      };
    case MANAGER_PATHS.clients:
      return { status: 200, body: { v: LOCAL_API_VERSION, clients: [], channel: null } };
    case MANAGER_PATHS.clientsInstall:
    case MANAGER_PATHS.clientsRemove:
      return refused(503, 'unavailable', 'There are no AI client bundles in development.');
    case MANAGER_PATHS.licenceRenew:
      return { status: 200, body: { v: 1, renewed: false, error: 'unreachable' } };
    case MANAGER_PATHS.ticket:
      return refused(503, 'unavailable', 'There is no relay in development.');
    // No own address in development (own-address.md): no relay door, and a new label per reset would spend the
    // certificate authority's weekly limit.
    case MANAGER_PATHS.ownAddressState:
      return { status: 200, body: { v: LOCAL_API_VERSION, enabled: false, acme: { state: 'idle' } } };
    case MANAGER_PATHS.feedbackCards:
    case MANAGER_PATHS.feedbackPull:
    case MANAGER_PATHS.sharePut:
    case MANAGER_PATHS.shareDelete:
    case MANAGER_PATHS.shareViews:
      return refused(501, 'not_supported', 'There is no control in development.');
    // Tailscale (direct-connection.md DC-13): the stand-in, never this machine's tailscaled (HE-S236).
    case MANAGER_PATHS.tailscaleState:
      return state(tailscale.status());
    case MANAGER_PATHS.tailscaleOn:
      return state(tailscale.on(body));
    case MANAGER_PATHS.tailscaleOff:
      return state(tailscale.off(body));
    case MANAGER_PATHS.tailscaleSignIn:
      return state(tailscale.signIn());
    case MANAGER_PATHS.tailscaleCert:
      return refused(409, 'tailscale.no_https', 'The stand-in Tailscale has no HTTPS certificate.');
    case MANAGER_PATHS.tailscalePeers:
      return { status: 200, body: { v: 1, peers: tailscale.peers() } };
    case MANAGER_PATHS.teamReportsList:
    case MANAGER_PATHS.teamReportsGet:
    case MANAGER_PATHS.teamReportsCreate:
    case MANAGER_PATHS.teamReportsReply:
    case MANAGER_PATHS.teamReportsAct:
      return teamAnswer(team, path, body);
    default:
      return refused(404, 'not_found', 'Not on this development box.');
  }
}

/** Starts the stand-in manager on `path` (a stale socket file there is replaced). */
export async function startStandInManager(path: string): Promise<StandInManager> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const asked: string[] = [];
  const tailscale = new StandInTailscale();
  const team = new FakeTeam({ replyAfterMs: STAND_IN_TEAM_REPLY_MS });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (chunks.reduce((n, b) => n + b.length, 0) < 64 * 1024) chunks.push(c);
    });
    req.on('end', () => {
      const route = (req.url ?? '/').split('?')[0] ?? '/';
      asked.push(route);
      let input: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
      } catch {
        input = {};
      }
      const answer = standInAnswer(route, input, tailscale, team);
      const body = JSON.stringify(answer.body);
      res.writeHead(answer.status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  chmodSync(path, 0o600);
  return {
    path,
    asked,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * The configuration a development or test boot runs with: the content key and the manager's socket it lacks, stood in
 * (production returns it as it is; `loadConfig` has refused it without them). `manager` is the stand-in to close.
 */
export async function withStandIns(
  config: Config,
): Promise<{ config: Config; manager: StandInManager | null; relay: boolean }> {
  if (config.NODE_ENV === 'production') return { config, manager: null, relay: true };
  const home = defaultWhombatHome({ WHOMBAT_HOME: config.WHOMBAT_HOME });
  const keyFile = config.WHOMBAT_CONTENT_KEY_FILE ?? (await ensureDevIdentity(home));
  const manager = config.WHOMBAT_MANAGER_SOCKET
    ? null
    : await startStandInManager(join(home, 'manager.sock'));
  return {
    config: {
      ...config,
      WHOMBAT_CONTENT_KEY_FILE: keyFile,
      WHOMBAT_MANAGER_SOCKET: config.WHOMBAT_MANAGER_SOCKET ?? manager?.path,
    },
    manager,
    // A real manager hands out relay tickets; the stand-in has no relay to give.
    relay: manager === null,
  };
}
