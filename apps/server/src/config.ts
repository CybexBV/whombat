import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { defaultWhombatHome } from '@whombat/agent-runtime/host';
import { DEFAULT_UPLOAD_MAX_BYTES, parseVaultSshPorts, UPLOAD_MAX_BYTES_CEILING } from '@whombat/core';
import { DEFAULT_EDITION, EDITIONS, type Edition } from '@whombat/protocol';
import { LICENCE_GRACE_S, LicenceKeySet } from '@whombat/protocol/licence';
import { PASSKEY_ANDROID_ORIGINS } from '@whombat/protocol/session';
import { z } from 'zod';
import { mergeRerunProblem } from './automations/merge-rerun';
import { isDatabaseUrl } from './db/url';
import { hostPathIssues } from './lib/host-paths';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const masterKey = z
  .string()
  .refine(
    (v) => Buffer.from(v, 'base64').length === 32,
    'WHOMBAT_MASTER_KEY must be 32 bytes, base64-encoded',
  );

/** The development database (docker compose). */
export const DEV_DATABASE_URL = 'postgres://whombat:whombat@localhost:55432/whombat';

/** The local Mailpit (docker compose): the SMTP default outside production. */
export const DEV_SMTP_URL = 'smtp://localhost:51025';

/** The hosted UI's origin outside production (`WHOMBAT_APP_URL`): the web app's development server (`pnpm dev:web`). */
export const DEV_APP_URL = 'http://localhost:5180';

export const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /**
     * The manager's unix socket (admission tickets, `claimed` and revocation reports, push requests). Required in
     * production; unset in development and tests, a stand-in manager runs in this process (`managed/dev-manager.ts`,
     * hermes-engine.md HE-49).
     */
    WHOMBAT_MANAGER_SOCKET: z.string().optional(),
    /** The manager's ACME socket for the own address's validations (own-address.md); default its fixed path. */
    WHOMBAT_MANAGER_ACME_SOCKET: z.string().optional(),
    /**
     * This runtime's admin socket for the manager (`GET /health`, `POST /drain`, `POST /resume`); default
     * `/run/whombat/admin.sock` in production (NX-20, MR-37), `$WHOMBAT_HOME/admin.sock` elsewhere, created 0660 with
     * the group `WHOMBAT_ADMIN_GROUP`.
     */
    WHOMBAT_ADMIN_SOCKET: z.string().optional(),
    /** The admin socket's group (the manager's and the backup service's users are its members). */
    WHOMBAT_ADMIN_GROUP: z.string().min(1).max(64).default('whombat-admin'),
    /**
     * The box's content identity (Ed25519 libp2p key, `/persist/identity/content.key`). Required in production; in
     * development and tests `$WHOMBAT_HOME/identity/content.key`, made at the first start (HE-49).
     */
    WHOMBAT_CONTENT_KEY_FILE: z.string().optional(),
    /**
     * Provisioning's public identity of the box (`/persist/identity/device.json`: its device id, environment, appliance
     * route, keys and serial). The runtime reads whether control registered the box (an appliance route other than
     * `local`) and signs its part of Whombat Link's registration from it (whombat-link.md). Unset: development and
     * tests, where `WHOMBAT_EDITION` stands in for it.
     */
    WHOMBAT_DEVICE_FILE: z.string().optional(),
    /**
     * Provisioning's claim record (`/persist/identity/claim.json`: `{v, deviceId, secretHash, algorithm}`,
     * MA-04 §1). `secretHash` is the card method's PAKE password (CT-66), null without a card (CC-10); the secret
     * itself is never stored.
     */
    WHOMBAT_CLAIM_FILE: z.string().optional(),
    /**
     * The claim console file (CC-08; the appliance sets `/run/whombat/console/console.json`): `ConsoleState`
     * for `whombat-console` on tty1, replaced atomically on every change, mode 0640. Unset: no file (MR-52).
     */
    WHOMBAT_CONSOLE_FILE: z.string().optional(),
    /**
     * The desk socket for the console server (docs/decisions/desk-display.md DK-12; the appliance sets
     * `/run/whombat/console/desk.sock`), made 0660 in the console's setgid directory. Unset: no desk screen, and the
     * `desk` feature isn't advertised.
     */
    WHOMBAT_DESK_SOCKET: z.string().optional(),
    /**
     * Managed: the direct listener's port (hermes-engine.md HE-50, direct-connection.md DC-02): clients reach the box
     * on it over the local network and Tailscale, browsers get the box's page there. `off`: no direct listener.
     * Default 4480 (`DIRECT_PORT`, the port the image's firewall opens); outside production `PORT + 80`, so several
     * development servers on one machine don't collide (4400 → 4480).
     */
    WHOMBAT_DIRECT_PORT: z.union([z.literal('off'), z.coerce.number().int().min(0).max(65535)]).optional(),
    /**
     * Managed: where the direct listener answers, a comma list (DC-03): `lan` (the box's own network cards), `tailscale0`,
     * `loopback`, or interface names. Default `lan,tailscale0`; outside production `loopback`.
     */
    WHOMBAT_DIRECT_INTERFACES: z.string().optional(),
    /** Managed: names the box answers to on the direct listener besides its addresses and Tailscale names (DC-04). */
    WHOMBAT_DIRECT_HOSTNAMES: z.string().optional(),

    /**
     * The Vault's home network list for the appliance's firewall (docs/decisions/vault.md VT-59): when set, the server
     * writes `{"version":1,"networks":[{"cidr":"192.168.1.0/24","ports":[8123]}]}` there at boot and after every change
     * (temp file + rename, mode 0644, sorted, no notes or names). Unset: no file (development and tests).
     */
    WHOMBAT_VAULT_NETWORKS_FILE: z.string().optional(),
    /**
     * The ports the Vault's SSH keys may reach servers on the internet on (docs/decisions/vault.md VT-S06, VT-S14):
     * `22` (the default), `22,2222`; 1–16 ports. The appliance sets it from the same option its wall opens; servers on
     * the home network use the person's list instead.
     */
    /**
     * Whether Whombat's own calls (Vault entries, Connections, SSH) may reach every private address
     * (docs/decisions/local-network.md LN-01, LN-04): `on` (the default) or `off` never. Where it is open, the person
     * still closes it with “Agents may reach your local network”; closed, only the home network list (VT-12)
     * opens private addresses.
     */
    WHOMBAT_LOCAL_NETWORK: z.enum(['on', 'off']).default('on'),
    WHOMBAT_VAULT_SSH_PORTS: z
      .string()
      .refine(
        (v) => parseVaultSshPorts(v) !== null,
        '1–16 different ports 1–65535, comma-separated, like 22,2222',
      )
      .optional(),
    /**
     * The container engine's socket (docs/decisions/one-person.md OP-16, OP-19; brief I-2): rootless Podman with
     * Docker's API, `/run/whombat-containers/podman.sock` on the appliance. The server lists and stops the agent's
     * services through it. Unset (development without Podman): the services say they aren't available here.
     */
    WHOMBAT_CONTAINERS_SOCKET: z.string().refine(isAbsolute, 'an absolute path').optional(),
    /**
     * The hosts service (docs/decisions/one-whombat.md ONE-11, one-whombat-servers.md): its API's unix socket, e.g.
     * `/run/whombat-hosts/api.sock`. Unset: this Whombat has no servers (`hosts.status` says so) and nothing else changes.
     */
    WHOMBAT_HOSTS_SOCKET: z.string().refine(isAbsolute, 'an absolute path').optional(),
    /** The hosts service's service token (the file it writes on its first start, e.g. `/persist/hosts/service-token`). */
    WHOMBAT_HOSTS_TOKEN_FILE: z.string().refine(isAbsolute, 'an absolute path').optional(),
    /**
     * The desk screen's speech (docs/decisions/desk-display.md DK-06, desk-display-talk.md DK-T02): the voice service's
     * socket, `/run/whombat-voice/voice.sock` on a box. Unset: no voice (Talk takes typing only).
     */
    WHOMBAT_VOICE_SOCKET: z.string().refine(isAbsolute, 'an absolute path').optional(),
    /**
     * `fake`: Whombat's own fake voice and fake speech model fetcher in process (development, tests, the appliance's dev
     * world); `off`: none.
     */
    WHOMBAT_VOICE: z.enum(['fake', 'off']).optional(),
    /**
     * Voice typing's speech models (docs/decisions/dictation.md): the model fetcher's socket,
     * `/run/whombat-voice-models/models.sock` on a box. Unset: nothing is downloaded (the speech service runs what it has).
     */
    WHOMBAT_VOICE_MODELS_SOCKET: z.string().refine(isAbsolute, 'an absolute path').optional(),
    /**
     * The desk screen's camera (docs/decisions/desk-display.md DK-28…DK-33, desk-display-server.md DK-S36): the presence
     * service's socket, `/run/whombat-presence/presence.sock` on a box. Unset: no presence (no switch in Settings).
     */
    WHOMBAT_PRESENCE_SOCKET: z.string().refine(isAbsolute, 'an absolute path').optional(),
    /** `fake`: Whombat's own fake presence service in process (development, tests); `off`: none. */
    WHOMBAT_PRESENCE: z.enum(['fake', 'off']).optional(),
    /**
     * The box's Bluetooth (docs/decisions/bluetooth.md BT-09, bluetooth-server.md BT-S02): the Bluetooth service's socket,
     * `/run/whombat-bluetooth/bluetooth.sock` on a box. Unset: no Bluetooth (`host.bluetooth` says `not_managed`).
     */
    WHOMBAT_BLUETOOTH_SOCKET: z.string().refine(isAbsolute, 'an absolute path').optional(),
    /** `fake`: Whombat's own fake Bluetooth service in process (development, tests, the dev world); `off`: none. */
    WHOMBAT_BLUETOOTH: z.enum(['fake', 'off']).optional(),
    /**
     * Remote help (docs/decisions/remote-help.md RH-06, remote-help-server.md RH-S02): the support service's socket,
     * `/run/whombat-support/api.sock` on a box. Unset: remote help isn't available here (`remoteHelp.get` says so).
     */
    WHOMBAT_SUPPORT_SOCKET: z.string().refine(isAbsolute, 'an absolute path').optional(),
    /**
     * `fake`: Whombat's own fake support service in process, as on a test Whombat (Forever, no help code); `fake-prod`:
     * as on a customer's (a help code, no Forever). Development and the app's e2e (RH-S10). `off`: none.
     */
    WHOMBAT_SUPPORT: z.enum(['fake', 'fake-prod', 'off']).optional(),
    /**
     * 1Password for the Vault's sync (docs/decisions/onepassword-sync.md): `real`, 1Password's SDK in its worker for
     * every token; `fake`, Whombat's own stand-in 1Password in process answers tokens that start with `ops_dev_` (its
     * made-up vaults and items) and the worker the rest. Unset: the stand-in in development, `real` in tests and
     * production. Never `fake` in production.
     */
    WHOMBAT_ONEPASSWORD: z.enum(['real', 'fake']).optional(),
    /**
     * The machine's boot id (docs/decisions/desk-display.md DK-75, desk-display-server.md DK-S73), for a runtime whose
     * sandbox hides `/proc/sys` (the appliance's `ProcSubset=pid`): systemd's `%b`. Unset (or not a boot id): read from
     * `/proc/sys/kernel/random/boot_id`; neither: an unlock that stays never outlives a restart.
     */
    WHOMBAT_BOOT_ID: z.string().optional(),
    /** The console file's group (`whombat-console`), set when this process is a member. */
    WHOMBAT_CONSOLE_GROUP: z.string().min(1).max(64).default('whombat-console'),
    /**
     * The backup service's quarantine marker (`/persist/backup/quarantine.json`, appliance BK-13).
     * While it exists the runtime runs no schedules, automations, runner turns, approved executions or outbound
     * effects.
     */
    WHOMBAT_QUARANTINE_FILE: z.string().optional(),
    /** The backup service's local API (`/run/whombat-backup/api.sock`), for the person's backup ops. */
    WHOMBAT_BACKUP_SOCKET: z.string().optional(),
    /**
     * The hosted UI's origin (`https://app.whombat.com`, `https://dev.whombat.com`). Links the server writes (run
     * notices, burrow addresses, invites) point there at this appliance, `/appliances/<device id>/…` (MR-45).
     * Required in production (`serverIssues`): https, or http on a loopback address outside production, where it
     * defaults to `DEV_APP_URL`.
     */
    WHOMBAT_APP_URL: z
      .string()
      .url()
      .refine((u) => /^https?:\/\/[^/?#]+\/?$/.test(u), 'an origin only, e.g. https://app.whombat.com')
      .optional(),
    /**
     * The origin the feedback widget is served from (docs/decisions/feedback-drop.md FD-31), a dedicated
     * embed origin such as `https://embed.whombat.com`: the snippet's base. Unset: the origin of `WHOMBAT_APP_URL`.
     * Same rules as `WHOMBAT_APP_URL` (https, or http on a loopback address outside production).
     */
    WHOMBAT_EMBED_URL: z
      .string()
      .url()
      .refine((u) => /^https?:\/\/[^/?#]+\/?$/.test(u), 'an origin only, e.g. https://embed.whombat.com')
      .optional(),
    /**
     * WebAuthn origins the Whombat accepts for passkeys besides `WHOMBAT_APP_URL`'s and the Android app's
     * (`PASSKEY_ANDROID_ORIGINS`), comma-separated (docs/decisions/passkeys.md PK-02): tests and local stacks. The RP
     * ID is always `WHOMBAT_APP_URL`'s host.
     */
    WHOMBAT_PASSKEY_EXTRA_ORIGINS: z.string().max(4_000).optional(),
    /** The release id the manager activated (reported by `GET /health`). */
    WHOMBAT_RELEASE_ID: z.string().optional(),
    /**
     * Per-identity provider credential homes, `<root>/<account>/<provider>` (MA-10): the appliance sets it; default
     * `$WHOMBAT_HOME/credentials`.
     */
    WHOMBAT_CREDENTIALS_ROOT: z.string().optional(),
    /**
     * The AI clients (SUB-09, CT-72): where this runtime keeps the client status the runner reads before each turn —
     * the manager's `LocalClientsStatus` as last pushed (set it for the server and the runner alike).
     */
    WHOMBAT_CLIENTS_FILE: z.string().optional(),
    /**
     * The image's old edition switch (hermes-engine.md HE-58; contracts `Edition`, CT-1300), inert on a box since Whombat
     * Link (whombat-link.md LNK-01): every box is the same, and Link's features follow Link's state. Read only where a
     * box has no `device.json` (development, tests), as whether control registered it (`link/origin.ts`). Phase 2
     * deletes it.
     */
    WHOMBAT_EDITION: z.enum(EDITIONS).default(DEFAULT_EDITION),
    /**
     * The appliance licence (LC-06…LC-11), inert since Whombat Link (whombat-link.md LNK-04): the runtime runs without one
     * whatever this says (`LicenceService.fromConfig`, `LicenceGate`). Kept so an older unit file still parses.
     */
    WHOMBAT_LICENCE: z.enum(['on', 'off']).optional(),
    /**
     * The licence public keys pinned in the image (LC-03; the NixOS module `whombat.licence.keys` installs
     * `/etc/whombat/licence-keys.json`, 0444): a `LicenceKeySet {v: 1, env, keys}` file. Required while the licence is
     * on (`serverIssues`, MR-55); never fetched over the network.
     */
    WHOMBAT_LICENCE_KEYS_FILE: z.string().optional(),
    /**
     * Dev/test key sets only (the key set's `env` is `local`, `dev` or `test`; refused otherwise, MR-60):
     * the licence grace period in seconds instead of `LICENCE_GRACE_S` (30 days), so a harness can show a lapse.
     */
    WHOMBAT_LICENCE_GRACE_S: z.coerce.number().int().min(0).max(LICENCE_GRACE_S).optional(),
    /**
     * Dev/test key sets only (MR-60): seconds added to the local clock the licence sees (negative: a clock
     * rolled back, positive: one run ahead), to exercise the high-water mark and the clock mark (LC-06, LC-07).
     */
    WHOMBAT_LICENCE_CLOCK_OFFSET_S: z.coerce
      .number()
      .int()
      .min(-10 * 365 * 86_400)
      .max(10 * 365 * 86_400)
      .optional(),
    /**
     * Who runs provider sign-in CLIs and touches credential homes (managed-providers.md PV-12): `runner` (the
     * default: the runner's user owns every home, the server relays over the runner protocol) or `local` (this
     * process; tests).
     */
    WHOMBAT_SIGNIN_EXECUTOR: z.enum(['runner', 'local']).optional(),
    /**
     * Runner executor: serve the runner's sign-in routes on this unix socket only (e.g.
     * `/run/whombat/signin.sock`, created in a directory only this user can write, mode 0666 — the runner token still
     * authenticates the runner). The loopback port then answers 404 for them, and the runner, which checks the
     * socket's owner, can't be fooled by another local process that binds the port (review I-1, MR-34).
     */
    WHOMBAT_SIGNIN_SOCKET: z.string().optional(),
    /** The session event log keeps events this many hours … */
    WHOMBAT_SESSION_EVENTS_MAX_AGE_HOURS: z.coerce
      .number()
      .min(0.01)
      .max(24 * 90)
      .default(72),
    /** … and at most this many (the oldest go first). Older cursors get `snapshot_required`. */
    WHOMBAT_SESSION_EVENTS_MAX_COUNT: z.coerce.number().int().min(10).max(10_000_000).default(200_000),
    /** Finished command receipts are kept this many hours (a retry within it replays the result). */
    WHOMBAT_COMMAND_RECEIPT_HOURS: z.coerce
      .number()
      .min(0.01)
      .max(24 * 90)
      .default(7 * 24),
    /**
     * The loopback listener (MA-10, MR-04): the runner protocol, agents' MCP and the AI gateway relay, nothing else.
     * People and their devices reach Whombat only through encrypted sessions.
     */
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(0).max(65535).default(4400),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /**
     * The database. Unset: the development database (docker compose, :55432). libpq's unix-socket form
     * `postgresql://user@/db?host=/run/postgresql` (the appliance's) is accepted too (MR-75).
     */
    DATABASE_URL: z.string().refine(isDatabaseUrl, 'Invalid URL').optional(),
    WHOMBAT_MASTER_KEY: masterKey.optional(),
    WHOMBAT_DEMO: bool.default(false),
    /**
     * A runner whose Hermes is the scripted stand-in (its version ends in `(scripted)`) runs turns without anyone's
     * sign-in (hermes-engine.md HE-46): the dev stack, the demo and tests set it; an appliance image never does.
     * Unset, such a runner's turns get a sign-in and are refused without one, as a real Hermes's are.
     */
    WHOMBAT_ALLOW_SCRIPTED: bool.default(false),
    /**
     * Where the box's own email goes (notification digests; hermes-engine.md HE-56: the community edition has no
     * control to mail through). Optional; outside production it defaults to the local Mailpit; `off` disables it.
     */
    SMTP_URL: z.string().optional(),
    /** Sender of every email (must be a domain the SMTP provider may send for). */
    MAIL_FROM: z.string().min(3).default('Whombat <hello@whombat.com>'),
    /** SMTP connection timeout, ms: generous for a remote provider (Mailgun), short for the local Mailpit in tests. */
    SMTP_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(15_000),
    /** Comma-separated runner tokens (`dev-runner-token` outside production when unset). */
    RUNNER_TOKEN: z.string().min(1).optional(),
    /** Shorthand for `WHOMBAT_GITHUB=fake` (the in-memory FakeGitHub). */
    WHOMBAT_FAKE_GITHUB: bool.default(false),
    /** The built web app (default: this checkout's `apps/web/dist`, `pnpm build:web`). */
    WHOMBAT_WEB_DIST: z.string().optional(),
    /**
     * Whombat Feedback (docs/feedback.md): `on` (default) takes website feedback through the encrypted drop
     * (docs/decisions/feedback-drop.md FD-25), `off` withdraws every site card and stops collecting.
     */
    WHOMBAT_FEEDBACK: z.enum(['on', 'off']).default('on'),
    /**
     * Link previews under messages (docs/decisions/essentials-conversations.md EC-21): `on` fetches the pages messages
     * link to (public addresses only), `off` never does. Default `on`, `off` in tests. The person also turns them off
     * per burrow (`Burrow.linkPreviews`).
     */
    WHOMBAT_LINK_PREVIEWS: z.enum(['on', 'off']).optional(),
    /**
     * GitHub (docs/github.md): `gh` = each burrow's GitHub as the GitHub sign-in of the person who connected it
     * (PV-06), `fake` = the in-memory FakeGitHub (dev, tests, demo), `off`. `auto` (default): gh in production, the
     * fake otherwise.
     */
    WHOMBAT_GITHUB: z.enum(['auto', 'gh', 'fake', 'off']).default('auto'),
    /**
     * How often the poller reads a switched-on repo while the person is active, ms (0: never on its own;
     * tests poll by hand). The fast and idle cadences below are relative to it (docs/decisions/polling.md PL-01).
     */
    WHOMBAT_GITHUB_POLL_MS: z.coerce.number().int().min(0).max(3_600_000).default(30_000),
    /** …while an agent's run, push, deploy or pull request checks are live there, ms (0: as `WHOMBAT_GITHUB_POLL_MS`). */
    WHOMBAT_GITHUB_POLL_FAST_MS: z.coerce.number().int().min(0).max(3_600_000).default(10_000),
    /** …while nothing is live there and nobody is active in the burrow, ms (0: as `WHOMBAT_GITHUB_POLL_MS`). */
    WHOMBAT_GITHUB_POLL_IDLE_MS: z.coerce.number().int().min(0).max(3_600_000).default(180_000),
    /** Deploy workflows: `deploy.yml`, or `owner/repo:env=file.yml,…` with `*` defaults (github/deploy.ts). */
    GITHUB_DEPLOY_WORKFLOW: z.string().optional(),
    /**
     * Which failed GitHub Actions jobs an automation's merge runs once more: `once` (default) or `infrastructure`, or
     * `owner/repo=infrastructure,…` with `*` defaults (automations/merge-rerun.ts).
     */
    WHOMBAT_MERGE_RERUN: z
      .string()
      .max(4_000)
      .optional()
      .superRefine((v, ctx) => {
        const problem = mergeRerunProblem(v);
        if (problem) ctx.addIssue({ code: 'custom', message: problem });
      }),
    /** FakeGitHub keeps real bare repositories here (the runner clones and pushes to them). */
    WHOMBAT_FAKE_GITHUB_GIT_ROOT: z.string().optional(),

    /**
     * Google accounts for the agent (docs/decisions/connectors.md CN-08): `real` = Google's REST APIs with
     * the OAuth client the person set up, `fake` = an in-memory mailbox, calendar and drive (connecting skips
     * Google), `off`. Default: `real`, except `fake` in tests and the scripted demo (`WHOMBAT_DEMO`).
     */
    WHOMBAT_GOOGLE: z.enum(['real', 'fake', 'off']).optional(),
    /**
     * The Google OAuth client, set in config instead of Settings (CN-02): both or neither. When set, the
     * Connections panel shows “Set in this Whombat’s config” and is read-only.
     */
    WHOMBAT_GOOGLE_CLIENT_ID: z.string().min(10).max(200).optional(),
    WHOMBAT_GOOGLE_CLIENT_SECRET: z.string().min(8).max(200).optional(),

    /**
     * Whombat's own directory on the host (self-hosted S-03): `workspaces/`, `codex-home/`, `logs/`… Absolute
     * or `~/…`; default `~/.whombat`. Every path in it stays overridable by its own variable.
     */
    WHOMBAT_HOME: z.string().optional(),
    /**
     * The longest a turn may run, minutes: the runner's wall time for a sandboxed turn (same name and default as the
     * runner's, 8 hours since resourceful-agents.md RA-14). A live turn's agent token slides with its beats and tool
     * calls up to this plus a margin after its claim (docs/decisions/essentials-agents.md EA-04).
     */
    WHOMBAT_SANDBOX_WALL_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(480),
    /**
     * The runner's workspaces root (default `$WHOMBAT_HOME/workspaces`): the server makes local repositories' origins
     * in it (`.origins/`), which the runner reads. The runner reads the same setting.
     */
    WHOMBAT_WORKSPACES: z.string().optional(),

    /**
     * Attachments (docs/decisions/bp-attachments.md): where uploaded bytes live (default `$WHOMBAT_HOME/files`),
     * the largest file (bytes, default 250 MiB, BP-A22; core's `DEFAULT_UPLOAD_MAX_BYTES` since contracts 0.49, files-space.md
     * FS-13), how long an upload may wait unsent before it is removed (hours),
     * uploads per uploader per hour (default 0: no hourly limit) and a fixed storage quota for files (bytes; unset, the
     * default: the disk is the limit, less a reserve; docs/decisions/page-sets.md PG-19, PG-20).
     */
    WHOMBAT_FILES_DIR: z.string().optional(),
    /**
     * Backup files (docs/decisions/backup-file.md BF-10, BF-D03): where made and uploaded files wait, default
     * `$WHOMBAT_HOME/backup-files` (a directory with a `CACHEDIR.TAG`). Set by tests; nothing else needs to.
     */
    WHOMBAT_BACKUP_FILES_DIR: z.string().optional(),
    WHOMBAT_UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(UPLOAD_MAX_BYTES_CEILING)
      .default(DEFAULT_UPLOAD_MAX_BYTES),
    WHOMBAT_UPLOAD_ORPHAN_HOURS: z.coerce
      .number()
      .min(0.01)
      .max(24 * 90)
      .default(24),
    WHOMBAT_UPLOAD_RATE_PER_HOUR: z.coerce.number().int().min(0).max(100_000).default(0),
    WHOMBAT_BURROW_QUOTA_BYTES: z.coerce
      .number()
      .int()
      .min(1024 * 1024)
      .optional(),

    /** Web push (VAPID). Generate a pair with `pnpm --filter @whombat/server push:vapid` (docs/push-setup.md). */
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    /** `mailto:` address or URL the push service may contact about this sender. */
    VAPID_SUBJECT: z.string().default('mailto:push@whombat.com'),
    /**
     * Tests and local mocks only: outbound requests to user-supplied URLs (web push endpoints) may use plain
     * `http:` and private addresses, and skip the push-service host list (lib/outbound.ts). Refused in production.
     */
    WHOMBAT_OUTBOUND_ALLOW_PRIVATE: bool.default(false),

    /** Android push: FCM HTTP v1, authenticated with a Google service account. Skipped (logged) when unset. */
    FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
    /**
     * Development only: post each FCM message to this URL instead of Google (no Firebase project needed).
     * `apps/mobile/scripts/push.mjs relay` delivers them to an emulator (docs/push-setup.md).
     */
    FCM_RELAY_URL: z.string().url().optional(),

    /** iOS push (APNs), token-based auth. Skipped (logged) when unset. */
    APNS_KEY_ID: z.string().optional(),
    APNS_TEAM_ID: z.string().optional(),
    /** PEM-encoded .p8 private key; `\n` in env values is unescaped. */
    APNS_PRIVATE_KEY: z.string().optional(),
    APNS_BUNDLE_ID: z.string().optional(),
    APNS_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  })
  .superRefine((cfg, ctx) => {
    for (const issue of hostPathIssues(cfg)) ctx.addIssue({ code: 'custom', ...issue });
    // No public HTTP listener (MA-10); the loopback listener serves only the runner and agents' MCP.
    if (!['127.0.0.1', '::1', 'localhost'].includes(cfg.HOST))
      ctx.addIssue({
        code: 'custom',
        path: ['HOST'],
        message: 'must be loopback (127.0.0.1): clients reach Whombat only through sessions',
      });
    // Production-only rules: `productionIssues`, so every problem is listed at once.
    if (Boolean(cfg.WHOMBAT_GOOGLE_CLIENT_ID) !== Boolean(cfg.WHOMBAT_GOOGLE_CLIENT_SECRET))
      ctx.addIssue({
        code: 'custom',
        path: [cfg.WHOMBAT_GOOGLE_CLIENT_ID ? 'WHOMBAT_GOOGLE_CLIENT_SECRET' : 'WHOMBAT_GOOGLE_CLIENT_ID'],
        message: 'set WHOMBAT_GOOGLE_CLIENT_ID and WHOMBAT_GOOGLE_CLIENT_SECRET together (or neither)',
      });
  })
  .transform((cfg) => ({
    ...cfg,
    DATABASE_URL: cfg.DATABASE_URL ?? DEV_DATABASE_URL,
    // The licence is inert (LNK-04): off unless something still asks for it.
    WHOMBAT_LICENCE: cfg.WHOMBAT_LICENCE ?? 'off',
    // A box's own page stands for the hosted app (`useBoxPageAsApp`, HE-S202, LNK-01); development and tests that
    // play a box control registered get the local hosted app.
    WHOMBAT_APP_URL:
      cfg.WHOMBAT_APP_URL ??
      (cfg.NODE_ENV === 'production' || cfg.WHOMBAT_EDITION === 'community' ? undefined : DEV_APP_URL),
    WHOMBAT_GOOGLE: cfg.WHOMBAT_GOOGLE ?? (cfg.NODE_ENV === 'test' || cfg.WHOMBAT_DEMO ? 'fake' : 'real'),
    WHOMBAT_LINK_PREVIEWS: cfg.WHOMBAT_LINK_PREVIEWS ?? (cfg.NODE_ENV === 'test' ? 'off' : 'on'),
    /** Where the database is: `url` (DATABASE_URL) or `dev`. */
    DATABASE_SOURCE: (cfg.DATABASE_URL ? 'url' : 'dev') as 'url' | 'dev',
    // Mail is optional in production (no silent fallback to a local Mailpit); development and tests keep it.
    SMTP_URL:
      cfg.SMTP_URL?.toLowerCase() === 'off'
        ? undefined
        : (cfg.SMTP_URL ?? (cfg.NODE_ENV === 'production' ? undefined : DEV_SMTP_URL)),
  }));

export type Config = z.output<typeof ConfigSchema>;

/**
 * Secrets that may come from a file instead of the environment: `<NAME>_FILE=/path` (mode 600) is read at
 * startup, so the value never sits in a unit file, a shell history or a parent's environment.
 */
export const SECRET_FILE_KEYS = [
  'WHOMBAT_MASTER_KEY',
  'RUNNER_TOKEN',
  'DATABASE_URL',
  'SMTP_URL',
  'VAPID_PRIVATE_KEY',
  'FCM_SERVICE_ACCOUNT_JSON',
  'APNS_PRIVATE_KEY',
  'WHOMBAT_GOOGLE_CLIENT_SECRET',
] as const;

/** A file holding a secret must not be readable by group or others (production refuses it). */
export function looseModeIssue(path: string): string | null {
  try {
    const mode = statSync(path).mode & 0o777;
    return mode & 0o077
      ? `${path} is readable by group or others (mode ${mode.toString(8)}); run chmod 600 ${path}`
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether `file` is in this unit's systemd credentials directory (`$CREDENTIALS_DIRECTORY`, NX-20) and that directory
 * gives others no access. systemd creates credential files 0440 there; only the unit can open the directory, so the
 * group/others rule for secret files doesn't apply to them (MR-74).
 */
export function inPrivateCredentialsDir(file: string, env: Record<string, string | undefined>): boolean {
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir || !isAbsolute(dir) || resolve(dirname(file)) !== resolve(dir)) return false;
  try {
    return (statSync(dir).mode & 0o007) === 0;
  } catch {
    return false;
  }
}

/**
 * Replaces every `<NAME>_FILE` with the file's contents (surrounding whitespace trimmed). Setting both the
 * value and its `_FILE`, a relative path, an unreadable or empty file are errors; in production so is a
 * file readable by group or others. Returns the resolved env and the problems found.
 */
export function resolveSecretFiles(
  env: Record<string, string>,
  keys: readonly string[] = SECRET_FILE_KEYS,
): { env: Record<string, string>; issues: string[] } {
  const out = { ...env };
  const issues: string[] = [];
  const production = env.NODE_ENV === 'production';
  for (const key of keys) {
    const fileKey = `${key}_FILE`;
    const file = env[fileKey];
    delete out[fileKey];
    if (file === undefined) continue;
    if (env[key] !== undefined) {
      issues.push(`${key}: set either ${key} or ${fileKey}, not both`);
      continue;
    }
    if (!isAbsolute(file)) {
      issues.push(`${fileKey}: must be an absolute path (got ${file})`);
      continue;
    }
    let value: string;
    try {
      value = readFileSync(file, 'utf8').trim();
    } catch (err) {
      issues.push(`${fileKey}: cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? String(err)})`);
      continue;
    }
    if (!value) {
      issues.push(`${fileKey}: ${file} is empty`);
      continue;
    }
    const loose = production && !inPrivateCredentialsDir(file, env) ? looseModeIssue(file) : null;
    if (loose) {
      issues.push(`${fileKey}: ${loose}`);
      continue;
    }
    out[key] = value;
  }
  return { env: out, issues };
}

/** The admin socket in production unless `WHOMBAT_ADMIN_SOCKET` says otherwise (NX-20). */
export const DEFAULT_ADMIN_SOCKET = '/run/whombat/admin.sock';

/**
 * systemd credentials (`LoadCredential=`/`SetCredential=`, NX-20): under a unit that has them, `$CREDENTIALS_DIRECTORY`
 * holds one file per credential. A setting that is neither set nor pointed at a file comes from its credential when
 * that file exists: `master-key` → `WHOMBAT_MASTER_KEY_FILE`, `runner-token` → `RUNNER_TOKEN_FILE`,
 * `content-identity` → `WHOMBAT_CONTENT_KEY_FILE`, `claim` → `WHOMBAT_CLAIM_FILE` (MR-37). Explicit settings win.
 */
export const SYSTEMD_CREDENTIALS: Readonly<Record<string, { key: string; file: string }>> = {
  'master-key': { key: 'WHOMBAT_MASTER_KEY', file: 'WHOMBAT_MASTER_KEY_FILE' },
  'runner-token': { key: 'RUNNER_TOKEN', file: 'RUNNER_TOKEN_FILE' },
  'content-identity': { key: 'WHOMBAT_CONTENT_KEY_FILE', file: 'WHOMBAT_CONTENT_KEY_FILE' },
  claim: { key: 'WHOMBAT_CLAIM_FILE', file: 'WHOMBAT_CLAIM_FILE' },
};

export function withSystemdCredentials(env: Record<string, string>): Record<string, string> {
  const dir = env.CREDENTIALS_DIRECTORY;
  if (!dir || !isAbsolute(dir)) return env;
  const out = { ...env };
  for (const [name, { key, file }] of Object.entries(SYSTEMD_CREDENTIALS)) {
    if (out[key] !== undefined || out[file] !== undefined) continue;
    const path = join(dir, name);
    if (existsSync(path)) out[file] = path;
  }
  return out;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Production must be configured on purpose: its own database, a public HTTPS origin, a master key, a strong
 * runner token and no development shortcuts. `_raw` is the environment before defaults were applied (unused now:
 * the config says where the database comes from).
 */
export function productionIssues(_raw: Record<string, string>, cfg: Config): string[] {
  if (cfg.NODE_ENV !== 'production') return [];
  const issues: string[] = [];
  if (!cfg.WHOMBAT_MASTER_KEY)
    issues.push('WHOMBAT_MASTER_KEY: required in production (or WHOMBAT_MASTER_KEY_FILE)');
  if (cfg.WHOMBAT_OUTBOUND_ALLOW_PRIVATE) issues.push('WHOMBAT_OUTBOUND_ALLOW_PRIVATE: tests only');
  if (cfg.FCM_RELAY_URL) issues.push('FCM_RELAY_URL: development only');
  if (cfg.WHOMBAT_DEMO)
    issues.push('WHOMBAT_DEMO: the demo needs the seeded mock world, never in production');
  if (cfg.DATABASE_SOURCE === 'dev')
    issues.push('DATABASE_URL: required in production (never the development database)');
  const tokens = (cfg.RUNNER_TOKEN ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) issues.push('RUNNER_TOKEN: required in production (or RUNNER_TOKEN_FILE)');
  else if (tokens.some((t) => t.length < 32))
    issues.push('RUNNER_TOKEN: every token must be at least 32 random characters in production');
  if (cfg.WHOMBAT_GITHUB === 'fake' || cfg.WHOMBAT_FAKE_GITHUB)
    issues.push('WHOMBAT_GITHUB: the fake GitHub is for development, tests and the demo');
  if (cfg.WHOMBAT_FAKE_GITHUB_GIT_ROOT) issues.push('WHOMBAT_FAKE_GITHUB_GIT_ROOT: development only');
  if (cfg.WHOMBAT_GOOGLE === 'fake')
    issues.push('WHOMBAT_GOOGLE: the fake Google is for development, tests and the demo');
  if (cfg.WHOMBAT_VOICE === 'fake') issues.push('WHOMBAT_VOICE: the fake voice is for development and tests');
  if (cfg.WHOMBAT_PRESENCE === 'fake')
    issues.push('WHOMBAT_PRESENCE: the fake presence service is for development and tests');
  if (cfg.WHOMBAT_BLUETOOTH === 'fake')
    issues.push('WHOMBAT_BLUETOOTH: the fake Bluetooth service is for development and tests');
  if (cfg.WHOMBAT_SUPPORT === 'fake' || cfg.WHOMBAT_SUPPORT === 'fake-prod')
    issues.push('WHOMBAT_SUPPORT: the fake support service is for development and tests');
  if (cfg.WHOMBAT_ONEPASSWORD === 'fake')
    issues.push('WHOMBAT_ONEPASSWORD: the stand-in 1Password is for development and tests');
  if (!cfg.WHOMBAT_CONTENT_KEY_FILE)
    issues.push("WHOMBAT_CONTENT_KEY_FILE: required in production (the box's content identity)");
  if (!cfg.WHOMBAT_MANAGER_SOCKET) issues.push('WHOMBAT_MANAGER_SOCKET: required in production');
  return issues;
}

/**
 * What the **server** needs beyond `loadConfig` (MR-45): a hosted app's origin, when one is named, must be HTTPS. No
 * box needs one any more (its own page stands for it, LNK-01), nor the licence's key set (inert, LNK-04). Checked when
 * the server boots (`assertServer`), not in `loadConfig`, because the appliance's `whombat schema-check|migrate --env`
 * share this configuration and write no links.
 */
export function serverIssues(cfg: Config): string[] {
  return appUrlIssues(cfg);
}

/** The image's old edition switch (HE-58), inert since Whombat Link (LNK-01): kept for phase 2 to delete. */
export function editionOfConfig(cfg: Pick<Config, 'WHOMBAT_EDITION'>): Edition {
  return cfg.WHOMBAT_EDITION;
}

/**
 * Whether the image's old switch says `community` (HE-58). Inert since Whombat Link (LNK-01): the runtime asks whether
 * control registered the box (`managed/link/origin.ts`) and Link's state instead. Kept for phase 2 to delete.
 */
export function isCommunity(cfg: Pick<Config, 'WHOMBAT_EDITION'>): boolean {
  return cfg.WHOMBAT_EDITION === 'community';
}

function appUrlIssues(cfg: Config): string[] {
  // A box's own page is its app when no hosted one is named (HE-S202, LNK-01).
  const issues: string[] = [];
  for (const key of ['WHOMBAT_APP_URL', 'WHOMBAT_EMBED_URL'] as const) {
    const value = cfg[key];
    if (!value) continue;
    const { protocol, hostname } = new URL(value);
    if (protocol === 'https:') continue;
    if (protocol === 'http:' && cfg.NODE_ENV !== 'production' && LOOPBACK_HOSTS.has(hostname)) continue;
    issues.push(`${key}: must be an https:// origin (http:// only on a loopback address outside production)`);
  }
  return issues;
}

/** Key set environments whose appliances may take the licence's dev overrides (MR-60). */
export const LICENCE_DEV_ENVS: ReadonlySet<string> = new Set(['local', 'dev', 'test']);

/**
 * Reads the pinned licence key set (`WHOMBAT_LICENCE_KEYS_FILE`, LC-03): a `LicenceKeySet`, or the problem with it.
 * Also refuses the dev overrides (`WHOMBAT_LICENCE_GRACE_S`, `WHOMBAT_LICENCE_CLOCK_OFFSET_S`) for a key set that
 * isn't a dev or test one (MR-60).
 */
export function readLicenceKeySet(
  cfg: Pick<
    Config,
    'WHOMBAT_LICENCE_KEYS_FILE' | 'WHOMBAT_LICENCE_GRACE_S' | 'WHOMBAT_LICENCE_CLOCK_OFFSET_S'
  >,
): { ok: true; keySet: LicenceKeySet } | { ok: false; issues: string[] } {
  const file = cfg.WHOMBAT_LICENCE_KEYS_FILE;
  if (!file)
    return {
      ok: false,
      issues: [
        'WHOMBAT_LICENCE_KEYS_FILE: required while the licence is on: the licence key set pinned in the image, e.g. /etc/whombat/licence-keys.json',
      ],
    };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      issues: [`WHOMBAT_LICENCE_KEYS_FILE: cannot read ${file} (${code ?? 'not JSON'})`],
    };
  }
  const parsed = LicenceKeySet.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      issues: [
        `WHOMBAT_LICENCE_KEYS_FILE: ${file} is not a licence key set (${parsed.error.issues[0]?.message ?? 'invalid'})`,
      ],
    };
  const issues: string[] = [];
  if (!LICENCE_DEV_ENVS.has(parsed.data.env)) {
    for (const key of ['WHOMBAT_LICENCE_GRACE_S', 'WHOMBAT_LICENCE_CLOCK_OFFSET_S'] as const)
      if (cfg[key] !== undefined)
        issues.push(
          `${key}: only with a local, dev or test licence key set (this one is ${parsed.data.env})`,
        );
  }
  return issues.length ? { ok: false, issues } : { ok: true, keySet: parsed.data };
}

/** Refuses to boot a server without what it needs (`serverIssues`), listing every problem. */
export function assertServer(cfg: Config): void {
  const issues = serverIssues(cfg);
  if (issues.length > 0)
    throw new Error(`Invalid server configuration:\n${issues.map((i) => `  ${i}`).join('\n')}`);
}

/**
 * The hosted UI's origin without a trailing slash (MR-45). Throws when it isn't configured: the server never writes
 * relative links (the session contracts require absolute URLs).
 */
export function managedAppOrigin(cfg: Pick<Config, 'WHOMBAT_APP_URL'>): string {
  // A box claimed on its own pages names them, even where the image also names the hosted app (whombat-link.md LNK-01).
  const url = boxPages.get(cfg)?.() ?? cfg.WHOMBAT_APP_URL ?? null;
  if (!url) throw new Error('WHOMBAT_APP_URL is required (MR-45)');
  return url.replace(/\/$/, '');
}

/** The box's own page per configuration, where it stands for the hosted UI (`useBoxPageAsApp`). */
const boxPages = new WeakMap<object, () => string | null>();

/**
 * A box claimed on its own pages (HE-S202; whombat-link.md LNK-01): its own page — its own address, else the first of
 * its direct ways, as its links name it (`DirectAddresses.routes`) — is where links, the console and the app's origin
 * point, before `WHOMBAT_APP_URL`. `page` is read per call, so a new address or Tailscale coming up needs no restart;
 * null while the box has no way in yet (then `WHOMBAT_APP_URL`, if any).
 */
export function useBoxPageAsApp(cfg: Pick<Config, 'WHOMBAT_APP_URL'>, page: () => string | null): void {
  boxPages.set(cfg, page);
}

/**
 * The WebAuthn relying party a Whombat verifies passkeys for (docs/decisions/passkeys.md PK-02): the RP ID is
 * the hosted UI's host, the origins are its origin, the Android app's (`PASSKEY_ANDROID_ORIGINS`) and
 * `WHOMBAT_PASSKEY_EXTRA_ORIGINS`.
 */
export function managedPasskeyRelyingParty(
  cfg: Pick<Config, 'WHOMBAT_APP_URL' | 'WHOMBAT_PASSKEY_EXTRA_ORIGINS'>,
): { rpId: string; origins: string[] } {
  const app = new URL(managedAppOrigin(cfg));
  const extra = (cfg.WHOMBAT_PASSKEY_EXTRA_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return { rpId: app.hostname, origins: [...new Set([app.origin, ...PASSKEY_ANDROID_ORIGINS, ...extra])] };
}

/**
 * Where a Whombat's feedback widget is served from (FD-31): `WHOMBAT_EMBED_URL`, else the hosted UI's origin.
 * An origin without a trailing slash; the snippet's base and the `Origin` every genuine drop arrives with (FD-23).
 */
export function managedEmbedOrigin(cfg: Pick<Config, 'WHOMBAT_APP_URL' | 'WHOMBAT_EMBED_URL'>): string {
  return new URL(cfg.WHOMBAT_EMBED_URL ?? managedAppOrigin(cfg)).origin;
}

/**
 * Parse and validate configuration from an env-like object. Empty strings count as unset; `<NAME>_FILE`
 * variables are read (`SECRET_FILE_KEYS`). Throws one error listing every problem.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned = withSystemdCredentials(
    Object.fromEntries(
      Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== ''),
    ),
  );
  const { env: resolved, issues } = resolveSecretFiles(cleaned);
  // The admin socket lives in the unit's RuntimeDirectory unless configured (NX-20); outside production in
  // WHOMBAT_HOME (HE-49).
  if (!resolved.WHOMBAT_ADMIN_SOCKET)
    resolved.WHOMBAT_ADMIN_SOCKET =
      resolved.NODE_ENV === 'production'
        ? DEFAULT_ADMIN_SOCKET
        : join(defaultWhombatHome(resolved), 'admin.sock');
  const result = ConfigSchema.safeParse(resolved);
  if (result.success) issues.push(...productionIssues(resolved, result.data));
  else issues.push(...result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  if (!result.success || issues.length > 0) {
    throw new Error(`Invalid server configuration:\n${issues.map((i) => `  ${i}`).join('\n')}`);
  }
  return result.data;
}

/**
 * Loads an env file into `env` without overriding variables that are already set: `WHOMBAT_ENV_FILE` when
 * given (it must exist; in production it must not be readable by group or others), else the repository
 * root `.env` if present. A packaged release (`WHOMBAT_APP_DIR` set) has no repository: only
 * `WHOMBAT_ENV_FILE` counts there (docs/decisions/bp-distribution.md BP-F02).
 */
export function loadDotEnv(env: Record<string, string | undefined> = process.env): void {
  const explicit = env.WHOMBAT_ENV_FILE;
  if (!explicit && env.WHOMBAT_APP_DIR?.trim()) return;
  const file = explicit || resolve(import.meta.dirname, '../../../.env');
  if (!explicit && !existsSync(file)) return;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    throw new Error(`Invalid server configuration:\n  WHOMBAT_ENV_FILE: cannot read ${file} (${code})`);
  }
  const parsed = parseEnv(text);
  if (explicit && (env.NODE_ENV ?? parsed.NODE_ENV) === 'production') {
    const loose = looseModeIssue(file);
    if (loose) throw new Error(`Invalid server configuration:\n  WHOMBAT_ENV_FILE: ${loose}`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
}

/**
 * Where the built web app is: `WHOMBAT_WEB_DIST`, else `web/` of a packaged release (`WHOMBAT_APP_DIR`), else this
 * checkout's own build of it, `apps/web/dist` (`pnpm build:web`).
 */
export function webDistDir(
  config: Pick<Config, 'WHOMBAT_WEB_DIST'>,
  env: Record<string, string | undefined> = process.env,
): string {
  if (config.WHOMBAT_WEB_DIST) return resolve(config.WHOMBAT_WEB_DIST);
  const app = env.WHOMBAT_APP_DIR?.trim();
  return app ? resolve(app, 'web') : resolve(import.meta.dirname, '../../web/dist');
}
