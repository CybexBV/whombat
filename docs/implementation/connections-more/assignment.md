# More connections — build brief (2026-10-19)

Decisions: `docs/decisions/connections-more.md` (CM-01…CM-30). **Read it first**, then §1, §2 and your stream's part of
§3. The contract shapes written there (CM-10 `session`, CM-13 `SocketSpec`, CM-14 `call`, CM-18 `queryReads`, CM-19
`imap`) are what every stream builds against; contracts 0.97.0 makes them real. Background: `connections-catalog.md`
(CX-*), `connections-setup.md` (CS-*: sign in once, discovery, access levels), `connectors.md` +
`connectors-personal-agents.md` (mail tools, Google and Microsoft), `marks.md` (logos), `local-network.md`.

Repos and branches (integration branches are the lead's; never commit to them):

| Stream | Repo | Worktree | Branch (from) | Ids |
|---|---|---|---|---|
| C contracts | whombat-contracts | `~/Code/.wt/contracts-cm` | `cm` (main) | CT-470…CT-499, 0.97.0 |
| S server | Whombat | `~/Code/.wt/whombat-cm-server` | `cm-server` (`cm`) | CM-S01…, migration 0120 if needed |
| E mail | Whombat | `~/Code/.wt/whombat-cm-mail` | `cm-mail` (`cm`) | CM-M01…, migration 0119 |
| W web | whombat-app | `~/Code/.wt/app-cm-web` | `cm-web` (`cm`) | AP-2760…AP-2809 |
| A Android | whombat-app | `~/Code/.wt/app-cm-mobile` | `cm-mobile` (`cm`) | AP-2810…AP-2859 |

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`contracts: …`, `server: …`, `mail: …`, `web: …`,
  `mobile: …`), every message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never
  merge into `main` or `cm`, never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`,
  `~/Code/whombat-contracts`): other sessions work there. The lead merges and vendors.
- **Contracts 0.97.0 arrives on `cm`.** S, E, W and A start before it lands: build what doesn't need the new types
  first (S: the socket client and its two dialects against fakes, the session exchange; E: the IMAP/SMTP adapter, the
  search translation, autoconfig; W: the marks, the Email (IMAP) page from fixtures; A: the phone's rows and IMAP form).
  When the lead says contracts are vendored on `cm`, `git merge cm` and switch to the real types. Need a contract change?
  Don't edit the vendored tarballs: message the lead (SendMessage `main`) with the exact additive change.
- **DEV fast** (John's rule): one quick check at the end — `pnpm format` then `TMPDIR=~/.cache/wb-tmp pnpm check` in your
  repo, plus `pnpm test:server` once (S and E). Run single test files while you work. No VM tests, no repeated full
  suites, no CI waits. Own ports (S 4480, E 4482, W 4484/5197, A 4486) and throwaway databases; the shared
  `docker compose` (Postgres :55432, Mailpit) is never stopped or reset (`down -v` never). `/tmp` runs out of inodes:
  `TMPDIR=~/.cache/wb-tmp`. A temporary container (GreenMail for IMAP) only through `/usr/local/bin/agent-resource`
  (read `/home/me/Code/dashboard/docs/agent-resources.md` first; `agent-resource run --task … --ttl 2h -- …`).
- **Tests** (`docs/decisions/test-speed.md`): unit-test logic (dialects, session exchange, query reads, search
  translation, autoconfig parsing, MIME → summary); fakes in process (a `ws` server playing TrueNAS and the Device
  Builder, an http server playing Pi-hole and Nginx Proxy Manager, `smtp-server` for SMTP). A new `*.int.test.ts` needs
  a reason to need Postgres. Check facts (ids, tool names, a key phrase), never long literal text. Wait on events or
  inject short timeouts, never sleep.
- **Never call John's real services** (his ESPHome at 10.100.0.11, Plex, Overseerr, SABnzbd, UniFi, Home Assistant …)
  or his DEV box from tests or scripts, and never read his secrets (`~/.hermes/.env`, `~/.hermes/**`). The lead checks
  the real ones after the merge.
- **Copy**: plain, short English a non-developer understands (`docs/decisions/concise-replies.md`), curly quotes (’ “ ”),
  `·`, `−`, `…`. No ids, paths or stack traces in visible words. Guides for agents may name paths and methods.
- **Tokens only** (CSS variables) for UI; match the surrounding code's style and comment density.
- Record your own decisions in your stream's file (S: Whombat `docs/decisions/connections-more-server.md`; E: Whombat
  `docs/decisions/connections-more-mail.md`; W: whombat-app `docs/decisions/connections-more-web.md`; A: whombat-app
  `docs/decisions/connections-more-android.md`; C: add to the contracts CHANGELOG/notes as that repo does).
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is
  left, what the lead must check live). Don't wait for anything after that.

## 2. How it fits together

- **Catalog entries** are data in `@whombat/core` (`domain/connections-catalog.ts`): the web and phone draw the forms
  from them; the server's generic connect, check, sync, call and discovery code runs them. Group 1 needs no server code
  beyond CM-18 (query reads) and Plex's sign in once (CM-06).
- **Session sign-in** (CM-10…CM-12): a `token` sign-in whose `auth.type` is `session`. The form is a token form; the
  server's `connections/credentials.ts` makes the credential like `client_credentials` does (`client-credentials.ts`).
- **Socket transport** (CM-13…CM-17): `transport: 'socket'`, `socket: SocketSpec`, one `call` tool built from the spec
  (like `request`'s `requestToolDef`), a `socket` check kind, and a socket opened with `lib/outbound.ts`
  `outboundConnectOptions` (as Home Assistant's sign in once does, `connections/provision/homeassistant.ts`).
- **Mail** (CM-19…CM-27): the connectors side, not the catalog side. `connectors/` has Google (`workspace-real.ts`) and
  Microsoft (`microsoft-workspace.ts`) behind the `GoogleWorkspace` interface (`connectors/types.ts`) and
  `providers.ts`; IMAP is a third implementation of its mail methods, with its own connect route (no OAuth). The
  catalog's builtin `imap` entry only puts it on the overview.

## 3. Streams

### C — contracts 0.97.0 (`~/Code/.wt/contracts-cm`, branch `cm`)

1. Schema, exactly as the decisions write it: `TokenAuth` `session` (CM-10) and `tokenCredential` → null for it;
   `CONNECTION_TRANSPORTS` + `'socket'`, `SocketSpec`, `CatalogEntry.socket`, `CatalogCheck` `socket` (CM-13);
   `SOCKET_TOOL_NAME = 'call'`, `socketReads(entry, method)`, `socketStreams`, `socketRefused`, a `socketToolDef` helper
   if it belongs in core (CM-14); `RequestSpec.queryReads` / `writes` and `isReadRequest(…, query?)` (CM-18);
   `callAccess` / `sensitiveReason` handling `call` like `request`. Keep every existing entry parsing unchanged.
2. The fifteen entries of CM-01 with sign-ins, steps, paste patterns, fields (`urlField`, `certificateField` where
   self-signed is usual: UniFi Access, TrueNAS, Pi-hole/AdGuard when https), checks, request prefixes, reads, guides
   (≤ 1 500 characters, CM-30), sensitive rules (CM-03), access sentences, discovery (CM-04), docs and token links.
   **Check every entry against the vendor's current API docs** (WebFetch: TrueNAS 25.04/25.10 JSON-RPC docs, the
   ESPHome device-builder `docs/API.md` on GitHub, Pi-hole v6 API, Nginx Proxy Manager `/api` schema, SABnzbd API,
   NZBHydra2 API, Plex, Overseerr, AdGuard Home `openapi.yaml`, UniFi Access developer API, Pterodactyl client API,
   Airtable, HubSpot, Pipedrive, Plausible Stats API v2). Write what a doc leaves open into the guide.
   Plex: the `password` sign-in (CM-06) first, the `X-Plex-Token` token second; `Accept: application/json` always.
3. Mail (CM-19…CM-21): `CONNECTOR_PROVIDERS` + `'imap'` with labels (`CONNECTOR_PROVIDER_LABELS`, the service labels:
   neutral names for the services it doesn't have), `CONNECTOR_PROVIDER_SERVICES` (google and microsoft: all six;
   imap: mail), the builtin catalog entry `imap`, `ImapServerSettings` (`imap: {host, port, security: 'tls'|'starttls'}`,
   `smtp: {…}`, `username`), the endpoints `connectors.imapDiscover` (`{ email }` → `{ settings | null, source, hint }`)
   and `connectors.imapConnect` (`{ email, password, settings? }` → the connection view, or errors with codes the form
   can say: the IMAP or SMTP side refused or unreachable), check details for it, `IMAP_PROVIDER_HINTS` (CM-21). Look at
   how `contracts/connectors.ts` defines Google's and Microsoft's endpoints and views and follow it.
4. `CATALOG_IDS` in overview order (builtins first, `imap` after `microsoft`; then by category), fixtures if the
   fixtures package lists catalog connections, cross-language output (`pnpm gen`, `pnpm gen:check`), the version
   0.97.0 for the packages that change, the API level as the repo bumps it, CHANGELOG lines CT-470… .
5. `pnpm check`, commit, then `pnpm release` to build `dist-release/0.97.0` in the worktree (provisional: no tag, no
   push, no merge). Tell the lead (SendMessage `main`) the commit and the dist path as soon as it is built — the other
   streams wait for it — then finish tests and polish in later commits (each later dist rebuild: tell the lead).

### S — server: catalog side (`~/Code/.wt/whombat-cm-server`, branch `cm-server`)

1. **Socket transport** (CM-13…CM-17): a socket client under the destination policy (`lib/outbound.ts`
   `outboundConnectOptions`, connect 10 s, whole call `CONNECTION_CALL_DEADLINE_MS`), the two dialects (`jsonrpc`:
   `{"jsonrpc":"2.0","id":n,"method","params"}` → `result`/`error`; `esphome`: server info first, `auth/login` when
   `requires_auth`, `{command, message_id, args}` → `result`, `event`s, `error_code`), login templates, the `call` tool
   (definition stored and hashed like `request`'s, reads/writes/streams/refused, Look only, `sensitive`), the `socket`
   check (version in the check line; the too-old sentences of CM-05/CM-07; TrueNAS refusing `http://`), output cut at
   64 KiB, the echo guard. Everything in `connections/` that switches on `transport` handles `socket`.
2. **Session sign-in** (CM-10…CM-12) in `connections/credentials.ts` + a `session.ts` like `client-credentials.ts`:
   sealed in the access-token columns, single-flight, retry on 401/403, `needs_reauth` on a refused password, sign out
   of the replaced session, checks through it.
3. **Query reads** (CM-18) in `connections/request.ts` (`requestReads` passes the query) and wherever reads are decided
   (`call.ts`, Look only).
4. **Plex sign in once** (CM-06): a provisioner in `connections/provision/` like the others (2FA code; a refused
   password → `sign_in_refused`; `second_factor_needed` when Plex asks for the code).
5. **Discovery**: the new probes run in `connections/discover.ts` as they are (check one fixture per kind).
6. **Skills** (CM-09): edit the shipped skills in `packs/` (`airtable`, `pterodactyl-panel`, `pihole-adguard`,
   `reverse-proxy-tls`, `truenas`, `email-inbox-triage`); keep their style; run the pack checks the repo has.
7. Tests with fakes (§1). Then `pnpm check` + `pnpm test:server` once.

### E — server: mail over IMAP and SMTP (`~/Code/.wt/whombat-cm-mail`, branch `cm-mail`)

1. The adapter: `imapflow` (IMAP), `nodemailer` (already a dependency; SMTP), `mailparser` (MIME), implementing the mail
   methods of the `GoogleWorkspace` interface (`mailSearch`, `mailRead`, `mailAttachment`, `mailDraft`, `mailGetDraft`,
   `mailSendDraft`, `mailOrganize`, `checkService`) per CM-22…CM-27; the other methods refuse (“Email (IMAP) only does
   mail.”). Sockets go to the address the destination policy's lookup checked, with `servername` for TLS (CM-23).
2. Storage: migration 0119 for the server settings on the person's connector connection (the password sealed like
   connector tokens, never shown); the connection's `services` is `['mail']`.
3. Connect side: `connectors.imapDiscover` (CM-20: ISPDB, autoconfig, MX → ISPDB, SRV; every fetch under the outbound
   policy, small deadlines; DNS through the policy's resolver), `connectors.imapConnect` (CM-22 check of both sides,
   then the connection), disconnect and Check again as for Google/Microsoft, and every place that branches on the
   provider (`providers.ts`, `access.ts`, `tokens.ts`, the persona's connected-accounts lines, the mail digest,
   reminders, guides) handling `imap`.
4. Tests: unit tests for search translation, ids, autoconfig parsing (recorded XML), MIME → summaries, draft/send
   flow against fakes; one real run against GreenMail through `agent-resource` (an env-gated test or a script you run
   once, documented in your decisions file). Then `pnpm check` + `pnpm test:server` once.

### W — web (`~/Code/.wt/app-cm-web`, branch `cm-web`; owns `packages/brand` and `packages/client`)

1. **Marks first** (CM-28): the sixteen marks in `packages/brand` (SVG files, sources and licences in `SOURCES.md`,
   `export-marks`, the sync test), `thingMark` for the new ids. Commit them first and tell the lead (the Android stream
   merges them).
2. The new entries everywhere connections show (overview tiles, connect form, page, check line, “Found on your
   network”): mostly free from the catalog; check `session` forms (the secret's label), `socket` connections (no
   `request` line, the `call` tool in the tools list), the TrueNAS https refusal, Use this fingerprint, Plex's sign in
   once with the 2FA field.
3. **Email (IMAP)** (CM-29): the page next to Google's and Microsoft 365's, its connect form (email, password, the
   found-servers line with Change, the server fields, the provider hint), connected state, Check again, Disconnect; the
   client hooks in `packages/client`; fixtures so it renders in the demo.
4. Visual check in both themes at 1440×900 against the existing Google/Microsoft page and a catalog connection's page;
   `pnpm check`.

### A — Android (`~/Code/.wt/app-cm-mobile`, branch `cm-mobile`)

1. The new connections' rows and pages show right on the phone (marks once W's are merged into `cm`; tolerant of
   `socket`).
2. Email (IMAP) on the phone as far as the phone connects accounts today (look at how Google and Microsoft 365 are
   offered there): if the phone has their connect flow, add IMAP's form (44 px targets, labels); if it only shows them,
   show IMAP the same way.
3. Check on the emulator (`export ANDROID_HOME=$HOME/Android/Sdk`), `pnpm check`.
