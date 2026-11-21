# Workstream: more connections from the skills (2026-10-19)

John, 2026-10-19 (main checkout), after a list of services the installed skills use that have no connection yet:
“Implement group 1 and pi-hole + Nginx Proxy Manager + IMAP/SMTP + TrueNAS, ESPHome.” Group 1 was the services that
sign in with a pasted key: UniFi Access, SABnzbd, NZBHydra2, Plex, Overseerr, AdGuard Home, Airtable, Pterodactyl, and
the three listed with them for customers (HubSpot, Pipedrive, Plausible).

Decided by the lead (feedback-decide-yourself). Not in the mocks (B-05): the UI follows Settings → Connections as it is
(overview tiles, connect form, connection page) and the Google/Microsoft account pages for mail.

Numbering: CM-01… here; contracts CT-470…CT-499 (0.97.0); server stream CM-S01… (`connections-more-server.md`); mail
stream CM-M01… (`connections-more-mail.md`); app web AP-2760…AP-2809, Android AP-2810…AP-2859; migration 0119 (mail),
0120 if the server stream needs one; candidate 0.109.0 / IN-312.

## The entries (CM-01…CM-09)

- **CM-01 Sixteen new connections.** Fifteen catalog entries plus mail:

  | id | Name | Category | Sign-in | Transport |
  |---|---|---|---|---|
  | `unifi_access` | UniFi Access | home | token (Bearer) | rest |
  | `sabnzbd` | SABnzbd | home | token (`apikey` query) | rest |
  | `nzbhydra` | NZBHydra2 | home | token (`apikey` query) | rest |
  | `plex` | Plex | home | sign in once (plex.tv), token (`X-Plex-Token`) | rest |
  | `overseerr` | Overseerr | home | token (`X-Api-Key`) | rest |
  | `adguard` | AdGuard Home | home | token (basic: username field + password) | rest |
  | `pihole` | Pi-hole | home | token with a **session** (app password) | rest |
  | `nginx_proxy_manager` | Nginx Proxy Manager | infrastructure | token with a **session** (email + password) | rest |
  | `truenas` | TrueNAS | infrastructure | token (API key) | **socket** (JSON-RPC) |
  | `esphome` | ESPHome | home | none, or username + password | **socket** (Device Builder) |
  | `pterodactyl` | Pterodactyl | infrastructure | token (Bearer `ptlc_…`) | rest |
  | `airtable` | Airtable | productivity | token (Bearer) | rest |
  | `hubspot` | HubSpot | business | token (Bearer) | rest |
  | `pipedrive` | Pipedrive | business | token (`x-api-token`) | rest |
  | `plausible` | Plausible | business | token (Bearer) | rest |
  | `imap` | Email (IMAP) | accounts | email + password, builtin | builtin (mail connector) |

  Home-network services are shared by default, personal allowed; Airtable is personal by default, shared allowed; the
  business three are shared by default. Every entry is checked against the vendor's current docs while it is written
  (contracts stream); what a doc leaves open goes in the entry's guide or in CM-D below.
- **CM-02 Pasted keys are guided.** Each token sign-in has numbered `steps` (where the key is in the service's own
  words, with the values to copy) and a `paste` pattern where the key has a recognisable shape (`ptlc_…`, a 32-hex
  SABnzbd key, `pat…` for Airtable, `pat-…` for HubSpot). No new provisioners except Plex (CM-06): the others can't make
  a key from a password, or need a browser session to do it.
- **CM-03 What asks first** (CX-31, CX-31a: Allowed by default, ask only for what is risky). Deleting anything, and:
  UniFi Access unlocking, lock rules, emergency/evacuation modes, users and credentials (NFC cards, PINs, touch
  passes); SABnzbd deleting from the queue or history (`mode=queue&name=delete`, `mode=history&name=delete`), shutting
  down or restarting it, and reading its settings (`mode=get_config` shows the news servers' passwords); Plex deleting
  media (a `DELETE` removes files) and changing server settings (`/:/prefs`); Overseerr deleting requests or users and
  changing settings; AdGuard Home and Pi-hole switching protection off (`POST /control/protection` with
  `enabled:false`, `POST /api/dns/blocking` with `blocking:false`), restoring a backup (Pi-hole teleporter, AdGuard
  reset) and changing users or passwords; Nginx Proxy Manager users, permissions and certificates' deletion; TrueNAS
  destroying, exporting or wiping a pool, dataset, zvol, snapshot or disk, rolling back, rebooting or shutting down,
  installing an update, users, groups, API keys, the SSH service and certificates, `filesystem.*` writes; ESPHome
  flashing (`firmware/install`, `firmware/upload`, bulk installs, `bootloader`), deleting or renaming a device,
  `firmware/reset_build_env`, `config/set_secret`, `config/set_wifi_credentials`, `version_history/restore`;
  Pterodactyl killing a server, reinstalling it, deleting files, backups, databases or schedules, sub-users and API
  keys; HubSpot and Pipedrive deleting or archiving records (batch archive too), merging records; Plausible deleting a
  site or a goal.
- **CM-04 Found on your network.** Every home-network entry has `discovery` probes (unauthenticated, the service's own
  page or version endpoint): UniFi Access 12445/https, SABnzbd 8080/http, NZBHydra2 5076/http, Plex 32400/http
  (`/identity`), Overseerr 5055/http (`/api/v1/status`), AdGuard Home 80/3000/http, Pi-hole 80/http (`/admin/`),
  Nginx Proxy Manager 81/http (`/api/`), TrueNAS 443/https, ESPHome 6052/http, Pterodactyl 80/443. A probe never sends
  a credential.
- **CM-05 TrueNAS is a connection, not a server kind.** The list proposed it next to Unraid on Servers; that needs an
  agent installed on TrueNAS, whose appliance OS doesn't allow it (a read-only root since 24.10, changes undone by
  updates). The API key and its JSON-RPC API give agents what the skill uses (pools, datasets, snapshots, alerts,
  shares, apps, updates). Only **TrueNAS 25.04 or later** (`/api/current`); older ones get “This TrueNAS is older than
  25.04: update it, then connect it.” **https only**: TrueNAS turns a key off when it is used over plain http, so the
  form refuses `http://` with that reason. Self-signed certificates are pinned like Proxmox (`certificateField`).
- **CM-06 Plex signs in once.** Its token is hard to find (an item's “View XML”), so the first sign-in is the Plex
  account: email or username, password, and the 2FA code when there is one; Whombat signs in at plex.tv once (`POST
  https://plex.tv/api/v2/users/signin`, `X-Plex-Product: Whombat`, a stable client id per burrow), keeps the account
  token that answers, and forgets the password. Plex can't limit a token, so Whombat keeps it to the level chosen
  (`serviceLimits: false`). The pasted `X-Plex-Token` stays the second choice.
- **CM-07 ESPHome means the Device Builder** (`ws://<host>:6052/ws`, the multiplexed command protocol, ESPHome 2026).
  The nodes themselves (native API on 6053) stay with Home Assistant, which already talks to them; the older dashboard
  (no `/ws` server info) gets “This ESPHome dashboard is too old: update ESPHome, then connect it.” Sign-in: none (the
  Builder asks for nothing), or the Builder's username and password, sent with `auth/login` only when its server info
  says `requires_auth`. Builder tokens aren't used.
- **CM-08 Pi-hole means v6** (its REST API under `/api/`); v5's `api.php` isn't offered (“This Pi-hole is older than
  version 6: update it, then connect it.”). Its key is an **app password** (Settings → Web interface / API → Configure
  app password), which also skips two-step sign-in. **Nginx Proxy Manager** has no API keys: it signs in with an email
  and password for a token that lasts a day; the steps suggest a separate user for Whombat with only the permissions it
  should have. Two-step sign-in on that user can't be used (“Turn off two-step sign-in for the user Whombat signs in
  as.”).
- **CM-09 The skills point at the connections.** `airtable`, `pterodactyl-panel`, `pihole-adguard`, `reverse-proxy-tls`,
  `truenas`, `email-inbox-triage` (and the `homelab` pack's `SOURCES.md` where it lists services) say: with a
  connection, use it (`connection_tools` / `connection_call`); without one, the Vault entry or the computer path as
  today, and tell the person once that a connection makes it simpler (Settings → Connections).

## A session sign-in (CM-10…CM-12)

- **CM-10 No new sign-in kind: a token whose `auth` is `session`.** `SignInKind` and `ConnectionView` stay as they are
  (an older phone reads every row). The secret is the password; a field may hold the account (`username`). Whombat
  signs in with it for a session token and puts that token on every request:

  ```ts
  // TokenAuth gains (contracts 0.97.0):
  z.object({
    type: z.literal('session'),
    /** The sign-in request, relative to the base: Pi-hole POST /api/auth {"password":"{secret}"}. */
    login: z.object({
      method: z.enum(['POST', 'PUT']).default('POST'),
      path: z.string().startsWith('/').max(200),
      /** A JSON object whose string values are templates over {secret} and the fields ({username}). */
      body: z.record(z.string(), z.string().max(200)),
    }),
    /** Where the session token is in the JSON answer (`session.sid`, `token`). */
    tokenJsonPath: JsonPathText,
    /** Where its lifetime is: a number of seconds (`session.validity`) or an ISO time (`expires`). */
    expiresJsonPath: JsonPathText.optional(),
    /** Used when the answer doesn't say; at most a day. */
    ttlSeconds: z.number().int().min(60).max(86_400).default(1800),
    /** How the session token goes on each request: `{token}` in a header template, bearer, or a query parameter. */
    apply: z.discriminatedUnion('type', [
      z.object({ type: z.literal('bearer') }),
      z.object({ type: z.literal('header'), name: HeaderName, template: z.string().max(200).default('{token}') }),
      z.object({ type: z.literal('query'), name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/) }),
    ]),
    /** Signing out of a session Whombat drops (Pi-hole: DELETE /api/auth, so its 16 seats don't fill up). */
    logout: z.object({ method: z.enum(['DELETE', 'POST']), path: z.string().startsWith('/').max(200) }).optional(),
  })
  ```

  `tokenCredential` (core, pure) answers null for `session`; the server makes the credential (CM-11).
- **CM-11 The server keeps the session** sealed in the OAuth access-token columns with its expiry (as
  `client_credentials` does, CS-12), uses it while more than a minute is left, else signs in again (single-flight per
  connection, outside any caller's session command, an idempotent effect: signing in changes nothing). A 401 or 403
  answer is tried once more with a fresh session (`RENEWED_KINDS` covers it). A refused password at sign-in marks the
  connection `needs_reauth` (`token_invalid`, “Needs a new password”), like a refused pasted token. The replaced
  session is signed out (best effort). The check signs in, then sends the entry's check request with the session.
- **CM-12 Echo guard.** Answers are checked against the password and the session token (VT-D22): an answer holding
  either is withheld.

## A socket transport (CM-13…CM-17)

- **CM-13 A new transport `socket`.** `CONNECTION_TRANSPORTS` gains `'socket'` (an older app leaves such a row out
  through its tolerant decoding, AP-255); entries carry a `socket` spec and `request: null`:

  ```ts
  export const SocketSpec = z.object({
    /** jsonrpc: JSON-RPC 2.0 (TrueNAS). esphome: {command, message_id, args} with events (ESPHome Device Builder). */
    dialect: z.enum(['jsonrpc', 'esphome']),
    /** The socket's path from the base (`/api/current`, `/ws`); ws: from http:, wss: from https:. */
    path: z.string().startsWith('/').max(200),
    /**
     * Signing in on the socket once it opens: the method and its params (templates over {secret} and the fields,
     * inside strings of an array or object). `asked`: only when the server's first message asks (ESPHome's
     * requires_auth); `always`: right away (TrueNAS). Null: never (a `none` sign-in skips it too).
     */
    login: z
      .object({ method: z.string().min(1).max(100), params: JsonValue, when: z.enum(['always', 'asked']) })
      .nullable(),
    /** Methods that read (patterns over the method's name, whole name). Anything else is a write. */
    reads: z.array(Pattern).max(40),
    /** Methods that stream events until their result (ESPHome's devices/logs): bounded by `seconds`. */
    streams: z.array(Pattern).max(20).default([]),
    /** Methods never sent, whatever the tiers (signing in again, subscriptions that never end, core internals). */
    refused: z.array(Pattern).max(20).default([]),
  });
  ```

  `CatalogEntry` gains `socket: SocketSpec.nullable().default(null)`; `CatalogCheck` gains
  `{ kind: 'socket', method, params }` (TrueNAS `system.info`, ESPHome `config/version`).
- **CM-14 One tool, `call`** (`SOCKET_TOOL_NAME`), like `request` for REST: input `{ method: string, params?: array |
  object, seconds?: integer 1…25 }` (`params` positional for JSON-RPC, the args object for ESPHome; `seconds` only for
  a streaming method, default 10). Reads (`socketReads(entry, method)`) run at once; everything else follows the tool's
  tier; the entry's `sensitive` rules apply with `tools: ['call'], arg: 'method'`. Look only refuses every write, as for
  `request`. An answer is JSON up to 64 KiB (a stream: its events' text joined, then the result), cut and marked like
  `request`'s.
- **CM-15 The socket stays under the destination policy.** `outboundConnectOptions` (DNS checked and pinned, the home
  network list with its ports, a pinned certificate) opens it; a connect deadline of 10 s, a whole-call deadline of
  `CONNECTION_CALL_DEADLINE_MS`; one socket per call (no pool): sign in, send, read, close. TrueNAS jobs answer a job id;
  the guide says to follow it with `core.get_jobs`.
- **CM-16 Where the methods come from.** TrueNAS reads: `*.query`, `*.get_instance`, `*.config`, `system.info`,
  `system.version`, `alert.list`, `disk.temperatures`, `pool.dataset.details`, `update.status` and the like (the
  contracts stream lists them from the 25.04/25.10 API docs); refused: `auth.*` but none (only Whombat signs in),
  `core.subscribe`, `core.unsubscribe`, `core.arg_*`. ESPHome reads: the Builder API's read-only commands (`ping`,
  `config/version`, `devices/list`, `devices/get_states`, `devices/get_config`, `devices/list_archived`, `yaml/search`,
  `firmware/get_jobs`, `firmware/get_job`, `firmware/get_binaries`, `labels/list`, `config/get_secrets`,
  `version_history/*` reads); streams: `devices/logs`, `devices/validate`, `firmware/follow_job`; refused:
  `auth/login`, `auth`, `subscribe_events`, `firmware/follow_jobs`, `devices/subscribe_reachability` (they never end).
- **CM-17 A socket connection's check line** says the version it answered (“TrueNAS 25.10.1”, “ESPHome 2026.6.5”) and
  the too-old sentences of CM-05/CM-07 when the socket isn't there.

## Reads by a query parameter (CM-18)

- **CM-18 SABnzbd and NZBHydra2 do everything with `GET /api?mode=…`.** `RequestSpec` gains `queryReads: { name,
  values }[]` (default empty): when one names a parameter the call carries, the call reads only when its value is one of
  `values` (SABnzbd `mode`: `queue`, `history`, `version`, `fullstatus`, `status`, `server_stats`, `warnings`,
  `get_cats`, `get_scripts`, `showlog` …; NZBHydra2 `t`: `caps`, `search`, `tvsearch`, `movie`, `book` …). A call
  without the parameter falls back to the method rule. `isReadRequest` takes the query as a fifth argument. With
  `queue` + `name=delete` SABnzbd deletes: a call reads only when its other query values aren't a write either, so
  `queryReads` also takes `writes: { name, values }[]` that make a call a write whatever `mode` says (`name`: `delete`,
  `delete_all`, `purge`, `pause`, `resume`, `priority`, `change_cat`, `rename` …).

## Mail over IMAP and SMTP (CM-19…CM-27)

- **CM-19 A third mail provider.** `CONNECTOR_PROVIDERS` gains `'imap'` (connectors.md always said “`microsoft` and
  `imap` come later”); its services are mail only (`CONNECTOR_PROVIDER_SERVICES.imap = ['mail']`). The Assistant's mail
  tools (`mail_search`, `mail_read`, `mail_attachment`, `mail_draft`, `mail_send`, `mail_organize`) work on it as on
  Gmail and Outlook; the mail digest, reminders and the skills that use mail get it for free. A catalog builtin entry
  `imap` (“Email (IMAP)”, Accounts, personal: “Mail from any other provider, like Fastmail, iCloud or your own server,
  for your assistant.”) puts it on the overview next to Google and Microsoft 365. One IMAP account per person (like one
  Google and one Microsoft account): the tools' `provider` picks it.
- **CM-20 Connecting asks two things**: the email address and its password (an app password where the provider has
  them). Whombat finds the servers itself (`connectors.imapDiscover`), in this order: the Thunderbird ISPDB
  (`https://autoconfig.thunderbird.net/v1.1/<domain>`), the domain's own autoconfig
  (`https://autoconfig.<domain>/mail/config-v1.1.xml`, `https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml`),
  the ISPDB for the domain of its MX host, then SRV records (`_imaps._tcp`, `_imap._tcp`, `_submission._tcp`,
  `_submissions._tcp`, RFC 6186/8314). What it found shows as one line (“imap.fastmail.com and smtp.fastmail.com”) with
  **Change**, which opens the server fields (IMAP host, port, security; SMTP host, port, security; username when it
  isn't the address). Nothing found: the fields open with `imap.<domain>` / `smtp.<domain>` filled in.
- **CM-21 Known providers get a hint**, from a small table in core (`IMAP_PROVIDER_HINTS`, by domain and MX): Gmail and
  Google Workspace, Outlook.com, Hotmail and Microsoft 365 say “Use the Google (or Microsoft 365) connection instead: it
  can also do your calendar and files.” (Outlook.com no longer allows password sign-in over IMAP); iCloud, Fastmail,
  Yahoo, AOL, Zoho and GMX say where the app password is made, with the link; Proton says it needs Proton Mail Bridge
  on a computer the Whombat can reach.
- **CM-22 The check signs in to both**: IMAP `LOGIN` (or `AUTHENTICATE PLAIN`) and `LIST`, then SMTP `EHLO` and `AUTH`.
  What fails says which side, in words (“The mail server refused the password. If your provider uses app passwords,
  make one and use that.”, “Whombat couldn't reach smtp.example.com on port 587.”). Security is `tls` (implicit, 993 /
  465) or `starttls` (143 / 587); plain text without TLS isn't offered.
- **CM-23 Under the destination policy.** Mail servers are usually public; one on the home network needs the admins'
  home-network list with its ports, as any connection. The host is resolved and checked by the policy's lookup and the
  socket goes to that address, with the host name kept for TLS (SNI and certificate check). A self-signed certificate on
  a home-network server isn't accepted in this version (CM-D later).
- **CM-24 Ids.** A message id is `base64url(<mailbox>\0<UIDVALIDITY>\0<UID>)`; a thread is the message's
  `References` root (`THREAD=REFERENCES` when the server has it, else the message alone). A `UIDVALIDITY` that changed
  answers “That message isn't there any more: search again.”
- **CM-25 Search** takes Gmail's words the agents already know and turns them into IMAP `SEARCH`: `from:`, `to:`,
  `cc:`, `subject:`, `is:unread`, `is:read`, `is:starred` (`FLAGGED`), `newer_than:7d`, `older_than:`, `after:`,
  `before:` (`YYYY/MM/DD`), `in:<folder>` (default the inbox; `in:sent`, `in:drafts`, `in:trash`, `in:archive` through
  SPECIAL-USE), `"quoted words"` and plain words (`TEXT`), `-` before a term (`NOT`). Anything else is sent as words.
  The tool description says it is a subset. Newest first, at most the tool's limit.
- **CM-26 Drafts and sending.** A draft is appended to the Drafts mailbox (SPECIAL-USE `\Drafts`, else “Drafts”) with
  `\Draft`; sending goes through SMTP as the address, then a copy is appended to Sent (`\Sent`) unless the provider
  saves one itself (Gmail, Outlook, iCloud: from the hints table); sending a draft removes it from Drafts. Approvals for
  sending stay as they are for Gmail (the owner's yes in the DM when the keys say ask).
- **CM-27 Organising**: read/unread (`\Seen`), star (`\Flagged`), move to a folder, archive (`\Archive`, else
  “Archive”), trash (`\Trash`; deleting for good is not offered). Labels are folders on IMAP: the tool says so.

## Logos and surfaces (CM-28…CM-30)

- **CM-28 A mark for each** (marks.md AP-2200…2205): Simple Icons where it has one (Plex, AdGuard, Pi-hole, Nginx
  Proxy Manager, TrueNAS, ESPHome, Airtable, Pterodactyl, HubSpot, Plausible, Ubiquiti for UniFi Access); the project's
  own logo where its licence allows (SABnzbd, NZBHydra2, Overseerr, Pipedrive), else a Lucide icon (`mail` for Email
  (IMAP)). Stored as SVG files with sources, like the rest.
- **CM-29 Web and phone show them like every connection**: the tile, the connect form (token steps, paste, Use this
  fingerprint), the connection page. A session token's form is a token form (the secret is labelled “App password” or
  “Password”). The Email (IMAP) page follows the Google and Microsoft 365 pages: connect form (email, password,
  CM-20's found-servers line), then the account with its status, Check again and Disconnect.
- **CM-30 Agents' words.** Each entry's `guide` (≤ 1 500 characters) says what the API is, the paths or methods that
  matter, how lists page, and what asks first. Connection names in chat are the service's (“Pi-hole”, “TrueNAS”).

## Not now

CalDAV and CardDAV for IMAP accounts; several IMAP accounts per person; self-signed certificates on home-network mail
servers; TrueNAS before 25.04; Pi-hole v5; ESPHome nodes' native API and Builder tokens; Plex's PIN sign-in (a code on
plex.tv/link); dashboards (glances) for the new kinds — the generic facts show until someone asks; making Pterodactyl,
Overseerr or SABnzbd keys from a password.

## Decided while building

- **CM-D01 No trash for mail (CM-27 changed).** `mail_organize` has no trash on any provider and refuses the TRASH
  label, as before (IN-15: moving mail to the trash is deleting it without asking). IMAP organising is read/unread,
  star, move to a folder and archive. Labels are folders on IMAP: `addLabels` moves the message there.
- **CM-D02 Nothing found is a guess.** `connectors.imapDiscover` answers source `guess` with `imap.<domain>` and
  `smtp.<domain>` when no lookup finds the servers; the form opens the server fields for a guess.
- **CM-D03 A refused mail password has its own reason** (`password_refused` on the connector's reauth reason), so the
  account says what to fix instead of “access removed”.
