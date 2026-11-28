/**
 * Where the harness keeps things (IN-04) and the local integrated environment's ports (MA-14). Everything lives
 * under `~/.cache/whombat-mgd/` (override `WB_MGD_HOME`), never in /tmp. Ports can be overridden for parallel
 * runs; the defaults are the architecture's.
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `harness/` in the appliance's checkout. */
export const HARNESS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The the appliance's checkout (integration worktree). */
export const REPO_DIR = resolve(HARNESS_DIR, '..');
export const MANIFEST_DIR = join(REPO_DIR, 'manifest');
export const REPORTS_DIR = join(HARNESS_DIR, 'reports');

/**
 * `p` without symbolic links in the part that exists (the rest is created later). The update helper refuses paths
 * through a link, and `~/.cache` is one on a host whose caches live on another disk.
 */
export function withoutLinks(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(withoutLinks(parent), basename(abs));
}

export const STATE_HOME = withoutLinks(process.env.WB_MGD_HOME ?? join(homedir(), '.cache', 'whombat-mgd'));
/** Shared-host temp dir (the host `/tmp` runs out of inodes). Made when missing: a fresh machine without `TMPDIR`,
 * such as a CI runner, has no such folder yet. */
export const TMP_DIR = process.env.TMPDIR ?? madeDir(join(homedir(), '.cache', 'wb-tmp'));

function madeDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const paths = {
  home: STATE_HOME,
  /** Persistent clean clones at pinned commits, reused by `dev/up` (`<name>@<commit12>`). */
  src: join(STATE_HOME, 'src'),
  /** Fresh scratch clones of one manifest build run. */
  scratch: join(STATE_HOME, 'scratch'),
  /** Tools the harness builds (rest-server). */
  bin: join(STATE_HOME, 'bin'),
  /** The running local environment. */
  env: join(STATE_HOME, 'env'),
  envFile: join(STATE_HOME, 'env', 'env.json'),
  logs: join(STATE_HOME, 'env', 'logs'),
  run: join(STATE_HOME, 'env', 'run'),
  /** The dev runtime's console state (WHOMBAT_CONSOLE_FILE, CC-08); `dev/console` draws it (IN-33). */
  console: join(STATE_HOME, 'env', 'run', 'console.json'),
} as const;

const port = (name: string, dflt: number) => {
  const v = process.env[name];
  return v ? Number.parseInt(v, 10) : dflt;
};

/** MA-14 defaults. */
export const ports = {
  postgres: port('WB_MGD_PG_PORT', 55490),
  control: port('CONTROL_PORT', 4600),
  controlAdmin: port('CONTROL_ADMIN_PORT', 4601),
  relay: port('RELAY_PORT', 4610),
  relayAdmin: port('RELAY_ADMIN_PORT', 4611),
  runtime: port('RUNTIME_PORT', 4620),
  /**
   * The runtime's direct listener (Whombat HE-50, IN-419): the same Noise session as through the relay, on loopback
   * here (a box: 4480 on its LAN and Tailscale).
   */
  direct: port('WB_MGD_DIRECT_PORT', 4621),
  web: port('WEB_PORT', 5190),
  restic: port('RESTIC_PORT', 4630),
  /** Dev TUF repository for the real manager (harness choice, next to restic). */
  tuf: port('WB_MGD_TUF_PORT', 4639),
  /** The Feedback widget's embed origin (Whombat FD-31, IN-54): the static embed tree. */
  embed: port('EMBED_PORT', 4640),
  /** Control's operator panel listener (BL-27, IN-69): the admin app and the operator API with cookie sessions. */
  controlPanel: port('CONTROL_PANEL_PORT', 4602),
  /**
   * The hosts service's agents' TLS listener (Whombat ONE-15, NX-155): what monitored servers dial; 8443 on a box. The
   * hub's API is a Unix socket (no port).
   */
  hostsAgent: port('WB_MGD_HOSTS_AGENT_PORT', 4643),
} as const;

/**
 * A public instance behind a reverse proxy on loopback (a Cloudflare tunnel, IN-32): the origins people use for the
 * hosted UI, control and the relay. Unset (the default): everything is loopback. Internal traffic (provisioning, the
 * manager, JWKS) stays on loopback either way; only what clients see and what control signs changes.
 */
export interface PublicUrls {
  /** Hosted UI origin, e.g. https://app.example.com (magic links, CORS, the relay's allowed origin). */
  web: string;
  /** Control origin, e.g. https://api.example.com (the tickets' issuer, the web build's control URL). */
  control: string;
  /** Relay origin, e.g. https://relay.example.com (the worker URL wss://…/v1/connect and its own origin). */
  relay: string;
  /**
   * The Feedback widget's origin, e.g. https://embed.example.com (`WB_MGD_PUBLIC_EMBED`, FD-31, IN-54): the snippet
   * base, control's `CONTROL_EMBED_ORIGINS`. Null: not set, no embed origin (the runtime falls back to the web origin).
   */
  embed: string | null;
  /**
   * The operator panel's origin, e.g. https://admin.example.com (`WB_MGD_PUBLIC_ADMIN`, IN-69): shown by `dev/up` and
   * `dev/status`; the tunnel routes it to the panel listener. Null: not set.
   */
  admin: string | null;
  webauthnRpId: string;
  /** File holding the SMTP URL for real mail (else the shared Mailpit). */
  smtpUrlFile: string | null;
  mailFrom: string | null;
}

const origin = (name: string, v: string) => {
  const u = new URL(v);
  if (u.protocol !== 'https:' || u.pathname !== '/')
    throw new Error(`${name} must be an https origin, not ${v}`);
  return u.origin;
};

function publicUrlsFromEnv(): PublicUrls | null {
  const web = process.env.WB_MGD_PUBLIC_WEB;
  const control = process.env.WB_MGD_PUBLIC_CONTROL;
  const relay = process.env.WB_MGD_PUBLIC_RELAY;
  if (!web && !control && !relay) return null;
  if (!web || !control || !relay)
    throw new Error('set all of WB_MGD_PUBLIC_WEB, WB_MGD_PUBLIC_CONTROL and WB_MGD_PUBLIC_RELAY, or none');
  const w = origin('WB_MGD_PUBLIC_WEB', web);
  return {
    web: w,
    control: origin('WB_MGD_PUBLIC_CONTROL', control),
    relay: origin('WB_MGD_PUBLIC_RELAY', relay),
    embed: process.env.WB_MGD_PUBLIC_EMBED
      ? origin('WB_MGD_PUBLIC_EMBED', process.env.WB_MGD_PUBLIC_EMBED)
      : null,
    admin: process.env.WB_MGD_PUBLIC_ADMIN
      ? origin('WB_MGD_PUBLIC_ADMIN', process.env.WB_MGD_PUBLIC_ADMIN)
      : null,
    webauthnRpId: process.env.WB_MGD_WEBAUTHN_RP_ID ?? new URL(w).hostname,
    smtpUrlFile: process.env.WB_MGD_SMTP_URL_FILE ? expandHome(process.env.WB_MGD_SMTP_URL_FILE) : null,
    mailFrom: process.env.WB_MGD_MAIL_FROM ?? null,
  };
}

export const publicUrls: PublicUrls | null = publicUrlsFromEnv();

/**
 * The Feedback widget's embed origin (FD-31, IN-54): `WB_MGD_PUBLIC_EMBED` on a public instance (null when it isn't
 * set there), else the local embed server `http://127.0.0.1:<EMBED_PORT>` (http is allowed on loopback outside
 * production by control and the runtime). A different origin from the web app and from any website.
 */
export function embedOrigin(): string | null {
  if (publicUrls) return publicUrls.embed;
  return `http://127.0.0.1:${ports.embed}`;
}

/** Control's URL as browsers use it (the hosted UI, the widget's frame): public, else loopback. */
export function browserControlUrl(): string {
  return publicUrls?.control ?? `http://127.0.0.1:${ports.control}`;
}

/** The relay worker URL clients and the appliance are assigned. */
export const relayConnectUrl = (p: PublicUrls) => `${p.relay.replace(/^https:/, 'wss:')}/v1/connect`;

/**
 * How the dev runtime's agents run (IN-38, IN-403): Hermes runs every turn in the managed sandbox, either the runtime's
 * scripted Hermes (`scripted`, the default: deterministic, no provider sign-ins, no model calls; every scenario assumes
 * it) or the image's Hermes (`live`, `WB_MGD_AGENTS=live`: with the installed Claude Code and ChatGPT on Hermes's own
 * provider, on each person's own sign-in — real model calls, billed to whoever signed in).
 */
export type AgentsMode = 'scripted' | 'live';

function agentsModeFromEnv(): AgentsMode {
  const v = (process.env.WB_MGD_AGENTS ?? '').trim();
  if (!v || v === 'scripted') return 'scripted';
  if (v === 'live') return 'live';
  throw new Error(`WB_MGD_AGENTS must be scripted or live, not ${v}`);
}

export const agentsMode: AgentsMode = agentsModeFromEnv();

/**
 * The dev runtime's Google (IN-49): `real` (Google itself; each Whombat's own OAuth client, a public environment),
 * `fake` (the runtime's `WHOMBAT_GOOGLE=fake`: connect completes as you@example.com without Google, runtime MR-64) or
 * `off`. `WB_MGD_GOOGLE`; unset leaves `WHOMBAT_GOOGLE` unset, which the runtime reads as `real`. Scenarios that need
 * Google switch their own environment to `fake` (scenario m) and never run against a public instance.
 */
export type GoogleMode = 'real' | 'fake' | 'off';

function googleModeFromEnv(): GoogleMode | null {
  const v = (process.env.WB_MGD_GOOGLE ?? '').trim();
  if (!v) return null;
  if (v === 'real' || v === 'fake' || v === 'off') return v;
  throw new Error(`WB_MGD_GOOGLE must be real, fake or off, not ${v}`);
}

export const googleMode: GoogleMode | null = googleModeFromEnv();

/** The shared Mailpit (never started or stopped by the harness). */
export const mailpit = {
  smtp: process.env.MAILPIT_SMTP ?? 'smtp://127.0.0.1:51025',
  api: process.env.MAILPIT_API ?? 'http://127.0.0.1:58025',
} as const;

export const PG_CONTAINER = process.env.WB_MGD_PG_CONTAINER ?? 'whombat-mgd-pg';
export const PG_VOLUME = `${PG_CONTAINER}-data`;
export const PG_IMAGE = 'postgres:17';
export const PG_USER = 'whombat';
export const PG_PASSWORD = 'whombat';

export function pgUrl(database: string, p: number = ports.postgres): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${p}/${database}`;
}

export function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}
