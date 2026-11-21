# Workstream: connections that sign in properly (two-step, single sign-on, the service's own page)

John, 2026-10-21 (main checkout): “We have lots of connections, but some of them don't work correctly regarding the
sign-in process. For example Plex auth is not working when it has 2FA. Can you research all Connections and see if we
can improve this?”

Research the same day, read-only (vendor source at pinned tags, official docs, public OAuth metadata; nothing signed in
to): `~/.cache/wb-tmp/cr/research-{home,infra,session,cloud}.md` with notes beside them. Anything below marked
*unverified* is handled defensively.

Numbers: SG-01… here (server notes SG-S01…), contracts 0.111.0 (CT-730…CT-769), app 0.113.0 (AP-3900…AP-3999),
migration 0128.

## What was wrong (the short list)

- **Plex:** sign in once posts the password to plex.tv. Plex's own guidance, every maintained client (python-plexapi,
  Overseerr/Seerr, Home Assistant, Kometa) and the services built on it sign in through Plex's PIN page instead, which
  handles two-step codes, Google/Apple/Facebook accounts and passkeys. The exact failure John saw isn't logged anywhere
  (no Plex connection on his box, provisioner refusals aren't logged); the PIN page removes the whole class.
- **UniFi (P1):** every UI.com account has two-step sign-in since July 2024; the emailed code belongs to the challenge
  UniFi made, and CS-03 dropped that challenge between the two submits, so an emailed code can never match.
- **Pi-hole (P1):** the main password with two-step on answers 400 “No 2FA token found in JSON payload”; Whombat said
  “refused the password” and later “Needs a new password”, for a password that is right.
- **Nextcloud (P1):** LDAP/AD accounts' user id isn't their login name (the default internal username is a UUID), and
  the check and file tools put the login name in `/remote.php/dav/files/<name>/` (404).
- **iCloud mail (P1):** sending used the IMAP username (the part before the @); Apple wants the full address.
- **Mollie (P1, likely):** an advanced token made for Look only fails the `GET /v2/methods` check.
- **Synology (P2, maybe P1):** every account with two-step sign-in is refused.
- **Many (P2):** single sign-on accounts were told “wrong password” with no way out; Home Assistant without the
  `homeassistant` provider answered 500, read as “try again”; Immich before 1.139 refused the key Whombat just made;
  Outlook's refusal told people to make an app password, which Microsoft no longer accepts; SABnzbd and NZBHydra2
  refusals were worded as the wrong problem; the MCP sign-in lost Vercel-style connections after an hour and reused a
  dead client registration forever.

## Sign in on the service's own page (SG-01…SG-05, SG-23)

- **SG-01 A sign-in kind for “sign in there, Whombat waits”.** `service_login` (CT-730): the person opens the
  service's own sign-in page in a new tab, signs in there however their account signs in (two-step, Google, Apple,
  passkey), allows Whombat, and the form polls until Whombat holds the token. The catalog entry says it in a sentence
  (`note`), and which token sign-in the result is stored as (`tokenMethod`, as `password`'s). It is generic (Nextcloud's
  Login Flow v2 has the same shape and stays on its own endpoints for compatibility); the server has one adapter per
  catalog id. Device-code services can use it later: the start answers a `userCode` to show (null for Plex).
- **SG-02 The endpoints.** `connections.startServiceLogin` (POST `/burrows/:burrow/connections/service-login/start`,
  body `{catalogId, scope, label?, fields, access, connectionId?}`) → `{loginUrl, flowId, pollEveryMs, expiresAt,
  userCode}`; `connections.pollServiceLogin` (POST `/connections/service-login/:flowId/poll`) → `pending | connected |
  expired | failed` exactly as Nextcloud's poll. The address is checked first (`destination_refused`), the flow is a
  `connection_pending` row bound to the account (single use, at most 10 minutes), `connectionId` reconnects. Both ops
  are `never` resent by a client (as Nextcloud's). Feature `connections.service_login`; `SESSION_API_LEVEL` 43.
- **SG-03 Stored as the token it is.** The connection is saved with `signIn: 'token'` and the token sign-in's `auth`, as
  sign in once does (CS-01): checks, tools, Replace token and every call work unchanged, and older clients (whose
  `ConnectionView.signIn` doesn't know `service_login`) still parse it. The level asked (`access`) is set on save.
- **SG-04 Plex.** Start: `POST https://plex.tv/api/v2/pins?strong=true` with `Accept: application/json`,
  `X-Plex-Product` and `X-Plex-Device-Name` = the provisioned name (`Whombat`), `X-Plex-Client-Identifier` = the burrow's
  stable client id (`provisionClientId`, CM-06) → `{id, code, expiresIn}`. The login URL is
  `https://app.plex.tv/auth#?clientID=<id>&code=<code>&context%5Bdevice%5D%5Bproduct%5D=<name>` (no `forwardUrl`: Plex
  checks it against the PIN's origin; the web form closes the tab itself). The flow lives `min(expiresIn, 10 min)`.
  Poll every 2 s: `GET https://plex.tv/api/v2/pins/<id>?code=<code>` with the same headers → `authToken` null: pending;
  404: expired; a token: `GET https://plex.tv/api/v2/user` with `X-Plex-Token` for the account's name (optional), then
  the entry's check against the server's address with the token, then save. The catalog's Plex entry becomes
  `[service_login “Sign in with Plex”, token]`; the password sign-in and its provisioner are removed (an older app that
  still sends it gets `not_supported`, “Make a token instead.”; phones update themselves). plex.tv calls go through
  the connection destination policy like any public https call.
- **SG-05 What the person reads.** Radio card: “Sign in to Plex in a new tab and allow Whombat.” Button: “Sign in with
  Plex”. While waiting: as Nextcloud's. A failed check after the token arrives says what Plex said in our words (“Plex
  let Whombat in, but this server didn’t accept your account. Is it the server’s owner?”).

- **SG-23 The page is ready before the click (web).** While the connect form shows *Sign in with Plex* with its address
  identified (and on a connection's page while it needs signing in again), the web starts the sign-in in the
  background, half a second after the last change to what the start takes (the address, the level, the name), and
  again a minute before it runs out (at most five times). The click then opens Plex's page itself (`window.open(url,
  '_blank', 'noopener')`) and waits as before; the form can't close that tab, Plex says it can be closed. Without one
  ready (still starting, or its start failed) the click starts it the old way, which shows why it failed. *Why:* John,
  2026-10-27: on his laptop the click opened a blank window and the form waited for Plex; a tab opened first and sent to
  Plex's page later stays blank where the browser doesn't let the page steer it (a Whombat installed as an app), while
  a page opened in the click itself opens everywhere. Chromium and Firefox sent the tab on in a test with
  dev.whombat.com's headers, so the old way stays as the fallback.

## Second factors that belong to a challenge (SG-06…SG-09)

- **SG-06 Amends CS-03.** CS-03 held nothing between the two submits. That stays true for the password. A *challenge*
  (UniFi's `UBIC_2FA`) is now handed back: the server seals it (custody `sealJson`, AAD `provision-challenge`) with the
  entry id, the base URL's origin, the account (lowercased) and an expiry of 10 minutes, and answers it as
  `details.challenge` with `second_factor_needed` (and with a `code` refusal that made a new one). The form sends it back
  as `login.challenge` with the code (CT-731). A challenge that doesn't open, belongs elsewhere or expired is ignored
  (the sign-in starts fresh, as before). It is useless without the password and never the password.
- **SG-07 UniFi.** First round: `POST /api/auth/login` *without* `token` → 499 (`MFA_AUTH_REQUIRED`): read the challenge
  (`data.mfaCookie` or the `UBIC_2FA` Set-Cookie) and `data.authenticators[].type`. Word the ask from the types: an
  authenticator app (“Enter the code from your authenticator app.”), email (“Enter the code UniFi just emailed to
  m•••@example.com.”, address masked), both. When no type takes a typed code (only push/UI Verify or a passkey; type
  names matched loosely, *unverified*) refuse `second_factor` with `method: 'token'`: “This UI.com account confirms
  sign-ins in the UI Verify app or with a passkey, which Whombat can’t answer. Use a local admin, or make an API key by
  hand.” Second round with code and challenge: one POST with `Cookie: UBIC_2FA=<value>` and `token: <code>` → 200 signed
  in; 499 again → `code` refused with the new challenge (“That code didn’t work. Enter the newest code.”). With a code but
  no usable challenge: start fresh as today.
- **SG-08 UniFi's help points to a local admin first.** Account help: “Best: a local admin (Admins & Users → Add Admin,
  Restrict to local access only, role Super Admin). A UI.com account asks for a code every time.”
- **SG-09 Synology two-step, asked once.** A session sign-in may say how its service asks for a code and how to be
  remembered (`twoStep`, CT-732): Synology `asked` = `error.code` 403, `wrongCode` = 404, the code as `otp_code`,
  `remember` = `enable_device_token=yes`, `device_name=Whombat` with the code, the trusted-device token at
  `data.device_id` or `data.did`, sent as `device_id` (with `device_name`) on every later sign-in, the way Home
  Assistant's Synology library does. Connect and Replace password take a `code` (CT-733); the server answers
  `second_factor_needed` without one. The device token is a credential: sealed in its own column (migration 0128,
  `catalog_connections.remembered_enc`), never shown, dropped with the connection or a new password. When DSM asks again
  later (the device was removed in DSM), the connection needs a new sign-in: “Synology asks for a two-step code again.
  Replace the password and enter a code.” 406 (two-step enforced, not set up) gets its own words: “DSM requires two-step
  sign-in for this user. Sign in to DSM as it once to set up a code, then connect.” QNAP keeps “turn off 2-step
  verification for this user” (whether its `qtoken` skips the code is *unverified*; a fix must read the token before the
  `need_2sv` rule, which a successful code sign-in also carries).

## Refusals that say the real problem (SG-10…SG-19)

- **SG-10 Pi-hole.** Catalog `failures`: `error.message` “No 2FA token found in JSON payload” / “Invalid 2FA token” /
  “Reused 2FA token” → `two_step` with “Pi-hole asks for a two-step code with that password. Make an app password in
  Pi-hole (Settings → Web interface / API → Expert → Configure app password) and use that instead.”; `error.key`
  `api_seats_exceeded` → `locked` with “Pi-hole has no free sign-in seats: other apps are signed in. Wait half an hour,
  or raise webserver.api.max_sessions in Pi-hole.” A failure may name the statuses it applies to (`status`, CT-734):
  200 with `session.validity` −1 → `denied`, “This Pi-hole has no password, so Whombat can’t sign in. Set one in Pi-hole
  (sudo pihole setpassword), then make an app password.” A stored connection's message uses the entry's words for
  `two_step` too (it said “turn off two-step sign-in” whatever the entry said).
- **SG-11 A check can name its refusals.** A request check may list `failures` (CT-735): statuses, a body pattern,
  whether it means the credential was refused (marks the connection) or not, and the words. SABnzbd: 403 “Access denied -
  Hostname verification failed” → not refused, “SABnzbd doesn’t accept the name in this address. Use its IP address, or
  add the name to host_whitelist in its settings.”; 403 “External internet access denied” → not refused, “SABnzbd only
  answers devices on its own network.”; 403 “API Key Incorrect|Required” → refused, “SABnzbd refused the key. Copy the API
  Key (not the NZB Key) from Config → General.” NZBHydra2: 404 with an empty body → refused, “NZBHydra2 didn’t accept that
  API key, or it’s older than version 9.” Plausible: 402 → not refused, “Your Plausible plan doesn’t include the Stats
  API (it needs a Business plan).”
- **SG-12 A check may depend on the token.** `forSecret` (CT-736): when the secret matches a pattern the check asks
  another request. Mollie: `access_…` tokens are checked with `GET /v2/permissions` (any advanced or OAuth token, no
  scope needed); API keys keep `GET /v2/methods`. Mollie's steps follow its one page: “+ Create access token”, a Standard
  API key to manage, an Advanced access token with read permissions to look only, copied right away (shown once).
- **SG-13 Single sign-on accounts get a way out.** Where a service can't tell a wrong password from an account without
  one (Grafana, Immich with OAuth on, Paperless-ngx, Forgejo/Gitea, Nextcloud), the wrong-password refusal adds one
  sentence (“If you sign in to {Name} through another service, make a token instead.”, Nextcloud: “…sign in with
  Nextcloud instead.”) and names the sign-in to switch to (`method`), so the form shows the switch button. Proxmox reads
  the realm's type from `/access/domains`, which it already fetches: an `openid` realm is refused `single_sign_on`
  before the password is sent.
- **SG-14 Home Assistant.** Read `GET /auth/providers` (public; a list, or `{providers}` since 2024.2) first: with
  `homeassistant` as now; else with `command_line` use that handler (same form, same steps); else refuse `unsupported`
  with `method: 'ha_oauth'`, “This Home Assistant doesn’t sign in with a username and password here. Sign in with Home
  Assistant instead.” A 500 at `/auth/login_flow` means the same. `notify` codes switch to `ha_oauth` too. “User is local
  only” reads as the local-only refusal. A 400 “Invalid client id” says: “Home Assistant doesn’t accept this Whombat’s
  address. Use this Whombat’s name, or make a token by hand.”
- **SG-15 Nextcloud.** (a) The user id is its own field `userId`, filled from the check's answer (`fromCheck`, CT-737;
  never asked, hidden in the form): the check becomes `GET /ocs/v2.php/cloud/user?format=json` (`OCS-APIRequest: true`,
  `ocs.data.id`), every DAV path and the guide use the user id, and existing connections fall back to the login name
  until their next check fills it. (b) A typed app password answered 403 with `X-NC-Auth-NotConfirmed: true` (Nextcloud
  32.0.12, 33.0.6 and later) is used as is, like the old “with an apppassword” answer. (c) One counted attempt per try:
  `PROPFIND /remote.php/dav/` first, `getapppassword` only after it worked. (d) Login Flow v2 behind a proxy: the poll
  goes to the poll path on the address Whombat uses, whatever scheme or host Nextcloud named (only a path ending in
  `/login/v2/poll` is accepted). (e) Refusals that mean “use the login flow” name it (`method: 'nextcloud_login'`):
  app passwords not allowed, wrong password (single sign-on). (f) “Sign in with Nextcloud” is listed first: no password,
  works for every account.
- **SG-16 Immich.** The check becomes `POST /api/auth/validateToken` (`authStatus` true; every key on 1.113…3.3);
  look-only permission gates move to 1.137 (`user.read`, `server.about`, `duplicate.read`) and 2.5 (`map.*`,
  `folder.read`).
- **SG-17 Forgejo/Gitea and Portainer.** Basic auth turned off reads as such on Forgejo 15+ (“basic authentication by
  username & password is disabled”) and on Gitea (403 “doer should be the site admin…” when Whombat wasn't signed in at
  all). Portainer's one-hour ban (403 “Access denied”, never 429) reads as `locked`.
- **SG-18 Email.** (a) iCloud: when the IMAP and SMTP usernames of the found settings differ and one is the full address,
  both use the full address. (b) Outlook.com/Hotmail/Microsoft 365: Microsoft takes no passwords over IMAP, not even app
  passwords: with Microsoft's own servers Whombat says so before trying (“Outlook and Microsoft 365 no longer let mail apps
  sign in with a password, not even an app password. Connect Microsoft 365 instead.”). (c) Gmail's “Application-specific
  password required” (IMAP alert, SMTP 534 5.7.9) says “Gmail wants an app password: turn on 2-Step Verification, then
  make one at myaccount.google.com/apppasswords.”; “Please log in via your web browser” says to sign in to Gmail in a
  browser once, without marking the password wrong; `CONTACTADMIN` says to contact the provider, not “busy”. (d) Hints:
  Gmail offers the app password beside the Google connection; iCloud with your own domain uses the @icloud.com address;
  Proton says it can't be connected yet (Bridge only answers on its own computer); Yahoo, Fastmail, GMX get their
  details.
- **SG-19 MCP sign-in.** (a) `offline_access` is asked (registration and authorize) when the authorization server lists
  it and the scope lacks it, and an issuer's stored registration without it is made again once (Vercel-style servers
  issue a refresh token only then). (b) A registration the server no longer knows (`invalid_client`,
  `unauthorized_client` at the exchange or a refresh) is dropped, so the next sign-in registers afresh. (c) Registration
  sends `application_type` (`web`; `native` for a loopback redirect). (d) `iss` is checked before an `error` in the
  redirect is acted on. (e) An http `PUBLIC_URL` that the server refuses says why (“Signing in needs this Whombat at an
  https address.”).

## Simpler sign-ins where the vendor has one (SG-20…SG-22)

- **SG-20 Vendor MCP servers first.** Todoist (`https://ai.todoist.net/mcp`), Airtable (`https://mcp.airtable.com/mcp`),
  Mollie (`https://mcp.mollie.com/mcp`) and Cloudflare (`https://mcp.cloudflare.com/mcp`) run official MCP servers that
  register any client (DCR, and CIMD) with PKCE: “Sign in with {Name}” (`mcp_oauth`, transport `mcp`, Notion's pattern)
  comes first, the token second. The token those give is the MCP server's (RFC 8707), so agents use the vendor's own
  tools there; Look only holds through the tools' write marks (CS-10). Moneybird (one URL per level) waits for a
  per-level MCP address in the catalog.
- **SG-21 Guided steps brought up to date** (catalog copy, all verified against the vendor's current docs on
  2026-10-21): UniFi Access “Never expires”; Moneybird Instellingen → Koppelingen → Externe applicaties (not
  Ontwikkelaars, whose tokens need the owner's approval); Tailscale's Read/Write picked in the All row; Cloudflare's
  pre-filled links make account tokens, and a pasted older 40-character token is recognised; GitLab's menu (Edit profile →
  Access → Personal access tokens) and instance prefixes (`mycompany-glpat-…`); HubSpot (who may make service keys; new
  private apps end 2026-10-26); Plausible (Business plan); Pelican's `pacc_` keys and Profile → API Keys; ESPHome as a
  Home Assistant add-on (port 6052 only with “Leave front door open”, then without a password) and 2026.7 or later;
  Seerr named beside Overseerr; Pipedrive's Company settings; Airtable's Builder Hub and an Enterprise admin's token
  lifetime; Nginx Proxy Manager's “Two-Factor Auth” words (a separate user starts without it).
- **SG-22 Dropbox's app setup says everything the first sign-in needs** (app copy): the Permissions tab ticked and
  submitted before anyone signs in, “Allow public clients” left on, and “Enable additional users” so people other than
  the admin can connect.

## Asking for what Whombat needs, and more when a task needs it (SG-24…SG-27)

John, 2026-11-01: “Sign in with Cloudflare” offered only Cloudflare's Minimal, Read only and Full access; he wants DNS and
tunnels without anything account-wide, like selling his domains. Cloudflare's MCP server preselects exactly the list a
client asks for (“This client asked for: …”) when it asks more than the required identity scopes, and asks for one
more in the middle of a task with an `insufficient_scope` challenge (MCP step-up).

- **SG-24 An `mcp_oauth` sign-in may ask a list** (`scopes`), on top of the server's own scope. Cloudflare's is what its
  manage token holds plus tunnels and their networks: change DNS, tunnels, tunnel connectors, private networks, Workers,
  routes, KV, R2, D1, Pages and purge caches; see domains and their settings, SSL, Zero Trust, Access and analytics.
  Nothing of the account: no registrar, members, API tokens, account settings or billing. A connection made through it
  manages, as every OAuth one does; Look only stays Whombat's own limit (CS-10).
- **SG-25 What a call needed is kept, and asked once.** A 403 `insufficient_scope` answer, or an error result that
  carries the same challenge in `_meta["mcp/www_authenticate"]` (how Cloudflare tells clients that read it there), ends
  the call `needs_permission`. The scopes it names that the connection doesn't hold go in `scopes_wanted`, and the first
  time one is asked a card in the thread (“Allow Dusty more on Cloudflare?”, the scopes in words, Allow on
  Cloudflare…) opens the connection's page. The agent hears to end its turn; asked again, it hears where the person
  allows it, without a second card. The card is a link, so the agent isn't woken when the person has allowed it: they
  tell it to carry on.
- **SG-26 Signing in again keeps what calls asked for** (`mcpSignInScope`): an entry with its own list asks that list
  and what calls asked for since, so an older, wider grant (Cloudflare's Full access) narrows to it; one without a list
  (Custom MCP, Notion) asks all it holds too. A reconnect keeps in `scopes_wanted` what the person allowed and drops what
  they declined (a call that needs it asks again); what waits is what is asked and not held. A token answer that names
  no scopes holds what was asked (RFC 6749 §5.1). While something waits, the connection's page (web and phone) opens at
  its sign-in, which says what in words and turns Reconnect into Allow on {Name}….
- **SG-27 Some things are never asked** (`scopesNever`): Cloudflare's registrar admin, members, API tokens, account
  settings and user details. A call that needs one gets no card; the agent hears that the person does it in Cloudflare
  itself.

## Not now (recorded so the next round starts here)

- TrueNAS: `auth.login_with_api_key` is removed in TrueNAS 27; `auth.login_ex` `API_KEY_PLAIN` needs the key's user
  (a new field and a way to fill it for existing connections). Before 27 ships.
- Waking the agent when the person allowed more (SG-25): the card would have to carry its thread through the
  connection page's sign-in.
- Tokens that expire (GitLab 365 days, Notion, Tailscale 1–90 days): an expiry probe and a warning 14 and 3 days ahead.
- MCP: a pasted OAuth client for servers that only take pre-registered ones (GitHub, Asana, Box, HubSpot); a Client ID
  Metadata Document for managed boxes (DCR is deprecated in MCP 2026-07-28); the 2026-07-28 stateless protocol.
- QNAP two-step (qtoken), Proton Bridge with a pinned certificate, Nginx Proxy Manager sign in once with a long-lived
  token, Home Assistant's OAuth sign-in turned into a long-lived token, session retries on 401 and `stale` only,
  Proxmox 7.1–7.4 `new-format=1`, Grafana servers that only allow expiring tokens.

## Server notes

### Sign-in kinds (stream S1, SG-S01…SG-S29)

| # | Decision |
|---|---|
| SG-S01 | A service-login flow is a `connection_pending` row with `sign_in = 'service_login'` (no new table): the account's, single use, the service's lifetime capped at `SERVICE_LOGIN_MAX_MS`. Its sealed state holds the label, fields, base URL, the level asked and the adapter's own state (Plex's PIN id and code: the code is a secret until used, never logged). |
| SG-S02 | One adapter per catalog id in `connections/service-login/` (`ADAPTERS`, `useServiceLoginForTests` for tests). An entry without a `service_login` sign-in, its stored token sign-in (`storedTokenSignIn`) or an adapter is `not_supported`; a live flow whose entry or adapter went answers `failed` and is used up. |
| SG-S03 | The adapter's sign-in origins (plex.tv) are checked with the address at start (`destination_refused` before anything is sent), and every call goes through `connectionFetch` (public https, DNS pinned, no redirects, 15 s), effect `connections.service_login`. |
| SG-S04 | A poll that isn't `pending` ends the flow: the token is taken before it is checked (the service answers it once, so a failed check or save means starting again), and a `failed` or `expired` answer uses it up too. plex.tv answering 429 or 5xx reads as `pending` (the flow's expiry ends it); a request that fails answers `failed` without using the flow up, as Nextcloud's poll. |
| SG-S05 | **Superseded in part by one-person.md OP-S53**: a reconnect keeps the connection's label, its own fields and its level; there is no scope. A reconnect (`connectionId`) keeps the connection's scope, label and its own fields (a field given replaces its own) and its level: `access` applies to a new connection only, the level is changed on the connection's page. |
| SG-S06 | Plex: the account's `authToken` is stored as the Plex token (`X-Plex-Token`); who it is comes from `/api/v2/user` (email, else username, else title; a failure leaves it out). A check of the server refused with it (401/403) reads “Plex let Whombat in, but this server didn’t accept your account. Is it the server’s owner?”; any other failure keeps the check's words. A strong PIN's `expiresIn` (30 minutes) is capped at 10; without one, 10. |
| SG-S07 | An older app's `signIn: 'password'` for an entry that has none (Plex since 0.111) is `not_supported`, “Whombat can’t sign in to Plex with a password. Make a token instead.” Plex's provisioner, its test and `PROVISION_ORIGINS` (with the run's off-origin https rule) are gone: provisioners stay on the service's own address. |
| SG-S08 | A handed-back challenge is `sealJson` under AAD `provision-challenge` of `{entryId, origin, account, value, expiresAt}` (the account trimmed and lowercased, 10 minutes). One sealed longer than 4096 characters (the contract's bound) isn't handed back. Opening checks every part; anything off is ignored and the sign-in starts fresh. Provisioners only see the raw value (`ProvisionInput.challenge`, `ProvisionError.challenge`); `connect.ts` alone seals and opens. |
| SG-S09 | UniFi's rounds: without a usable challenge the first POST has no `token` key; a 499 then asks (the challenge handed back), or with a code the code goes with that new challenge (as before SG-06, for authenticator-app codes). With a code and a challenge: one POST with `Cookie: UBIC_2FA` and `token`; a 499 to it is a `code` refusal with the new challenge (“That code didn’t work. Enter the newest code.”); a 401/403 after a challenge stays a `code` refusal without one. |
| SG-S10 | UniFi's authenticator types, matched loosely: `e-mail`/`email` an emailed code; `totp`, `otp`, `authenticator`, `google` an app; `push`, `verify`, `passkey`, `webauthn`, `fido`, `u2f`, `security key` nothing to type; anything else unknown. All listed have nothing to type: `second_factor` with `method: 'token'`. An unknown type, or none listed: the sentence naming both. App only: “Enter the code from your authenticator app.” Email: “Enter the code UniFi just emailed to m•••@example.com.” (the first letter, `•••`, the domain; “…emailed you.” without an address); both: the app sentence with “or the one UniFi just emailed to …”. |
| SG-S11 | A session's two-step answers are `SessionError` `code_needed` and `wrong_code` (`sessionTwoStepAsk` before `failures`; an `asked` answer to a code that was sent is a wrong code). At connect (Connect, Replace password) they are `second_factor_needed` and `sign_in_refused` with reason `code` (“Enter the code from your authenticator app.”, “That code didn’t work. Enter the current code from your authenticator app.”), carried as `CheckOutcome.twoStep`, not `check_failed`. On a stored connection both are the account's refusal: `needs_reauth` with `sessionTwoStepAgainText`. |
| SG-S12 | Migration 0128 `catalog_connections.remembered_enc`, AAD `catalog_connection:<id>:remembered`: written when a sign-in with a code answers a device token, replaced whenever a sign-in answers a new one, cleared by Replace password (the old token is never sent with a new password) and by any reconnect (a new credential). Edit fields keeps it and sends it to the new address; when the service asks for a code there, the change is refused with the entry's `again` words (an address change takes no code). |
| SG-S13 | The device token is not in backup files (the backup contract has no place for it): a restored Synology connection's first sign-in asks for a code, so it needs a new sign-in in SG-09's words. A token that no longer opens is ignored the same way. |
| SG-S14 | An app older than 0.111 that gets `second_factor_needed` for a token sign-in has no code field: it shows the words, and the person updates the app (phones update themselves). No server fallback. |
| SG-S15 | Pi-hole and session words: `asksTwoStep` reads only Nginx Proxy Manager's `requires_2fa` (the catalog's `failures` rule for it wins with its own words since 0.111); `sessionLoginFailure` gets the answer's status (`SessionFailure.status`); a stored connection's `two_step` message is the entry's text, else the old sentence. |
| SG-S16 | A check's `failures` are read for answers that aren't ok only (not for an `okJsonPath`/`okAnswer` miss); `catalogCheckFor` picks the request by the token connection's secret on every check (connect, Check again, health, the re-check after a refused call), never by a session's password. |
| SG-S17 | `fromCheck` values are merged into the fields when a connection is saved (Connect, sign in once, an OAuth client's secret, the service's page, Replace token, Edit fields) and written after every passing Check again or health check when they differ: no signed event (a fact the service told, like the check lines) and the credential version stays. Save paths of other streams (Nextcloud's login flow, the OAuth finish) pass `fromCheck: outcome.fromCheck`; until they do, the next health check (5 minutes) or Check again fills it. |
| SG-S18 | `connections.service_login` is advertised by every runtime (code-level, like `connections.sign_in_once`); the two ops reach the REST handlers through the session dispatcher's routes like every `api` op. |

## Server notes: services (SG-S30…SG-S49)

Stream S2, 2026-10-21. Finer decisions taken while building SG-13…SG-19 and the server side of SG-20.

- **SG-S30 The single sign-on sentence** (SG-13) is one helper (`wrongPasswordOrSingleSignOn`): the wrong-password words,
  then “If you sign in to {Name} through another service, make a token instead.” The reason stays `password`; the
  method is `token` (Nextcloud: `nextcloud_login`, ending “sign in with Nextcloud instead”; Immich: “make a key by hand
  instead”). Forgejo's entry is “Forgejo / Gitea”: the sentence says “Forgejo or Gitea”. Immich adds it only when
  `/api/server/features` says `oauth: true`. Portainer doesn't: its 422 texts tell single sign-on apart already.
- **SG-S31 Refusals that say “make a token” name it.** Grafana Cloud, Grafana's and Portainer's single sign-on, Immich
  with password sign-in off, Forgejo/Gitea's security keys and basic auth off, and Home Assistant's refused client id
  carry `method: 'token'`, so the form shows the switch there too.
- **SG-S32 Proxmox realms.** Proxmox VE now reads `/access/domains` for a typed realm too (one public GET more; before,
  only an account without a realm read it), so `mara@sso` of an `openid` realm is refused before the password goes.
  `root` still tries `pam` when the default realm is OpenID; anyone else without a realm whose default realm is OpenID
  is refused (no guess at `pve`/`pam`). Proxmox Backup Server is unchanged (CS-21: no realm list asked).
- **SG-S33 Home Assistant's providers** (SG-14): the login flow's handler is the listed provider's `[type, id]`,
  `homeassistant` before `command_line`. An answer Whombat can't read (400 `onboarding_required`, an unknown shape)
  keeps `['homeassistant', null]` as before. A 404 (older words) or 500 at the start is the missing provider; a 400
  “Invalid client id” at the start or at a step is `unsupported` with `token`. CS-22's “404 Invalid handler” is really
  a 500 since 2024.1. The provisioner still sends no PKCE (a `code_verifier` without a challenge is refused, CS-D33).
- **SG-S34 Nextcloud asks WebDAV first** (SG-15c): `PROPFIND /remote.php/dav/` Depth 0 asking only
  `current-user-principal`. 207 (or any 2xx) means the password worked; 401 with `password login forbidden` is two-step
  sign-in; any other 401 the wrong password; 429 paused. Then `getapppassword`: a 403 with
  `X-NC-Auth-NotConfirmed: true`, or either Nextcloud wording, keeps the typed app password (SG-15b); any other 403 is
  `rights` with `nextcloud_login`. The provisioner doesn't read the user id from the principal: the made key's check
  fills `userId` (`fromCheck`).
- **SG-S35 Login Flow v2's poll** (SG-15d): the endpoint's path must end in `/login/v2/poll`; a path under the address's
  own path keeps its place on Whombat's origin, any other keeps only the route (`/index.php/login/v2/poll` or
  `/login/v2/poll`) under the address. The old same-host check is gone: the poll can't leave the address any more,
  which is stricter. The login link stays as Nextcloud sent it (http or https only). The flow fills the check's
  `fromCheck` fields itself (`fieldsFromCheck`), as the OAuth sign-ins now do, so it doesn't depend on the save path.
- **SG-S36 Whose files** (SG-15a): DAV paths name `userId`, else `username`, else `loginName`; a blank `userId` counts
  as none.
- **SG-S37 Basic auth turned off** (SG-17) is matched on the answer's `message` (lower-cased), else its body: “password
  is disabled”, “auth method not allowed”, “basic auth… disabled / not allowed”, or exactly “auth required”. Gitea's
  403 “doer should be the site admin…” is the same refusal (`unsupported`), not `rights`.
- **SG-S38 Portainer's ban**: any 403 whose body says “access denied”, at `/api/auth` and at making the token, is
  `locked` (“…for an hour…”); another 403 at the token stays `rights`.
- **SG-S39 iCloud's user names** (SG-18a): only a side that names the full address (`%EMAILADDRESS%`) counts; a side
  without `<username>` leaves the other side's name as it was. Existing connections keep what they have.
- **SG-S40 Microsoft's mail servers** are `outlook.office.com`, `office365.com` and its subdomains, and subdomains of
  `outlook.com`. Connecting refuses before anything is opened (409 `imap_refused`, so older clients show it under the
  password); a stored connection or an SMTP refusal there gets the same words.
- **SG-S41 Mail answers read, never quoted** (SG-18c): imapflow's `response` (the tagged answer as text) and
  `serverResponseCode`, nodemailer's `response` and `responseCode`. Two new internal failures: `web_sign_in`
  (“Sign in to Gmail in a web browser once…”, “your mail” elsewhere) and `contact_provider` (`CONTACTADMIN`). Neither
  marks the password; the form gets `imap_unreachable` / `smtp_unreachable` as for the other non-password failures,
  tools `conflict`. Gmail's “Application-specific password required” (IMAP alert, SMTP 534 with 5.7.9) stays
  `refused`: the stored password no longer works there.
- **SG-S42 `offline_access`** (SG-19a) is added only to a scope that is asked: a sign-in asking none stays without one
  (`offline_access` alone could narrow what the server grants).
- **SG-S43 A stored registration is kept while it covers this sign-in's redirect URI** (it was: the exact list). SG-20
  adds four `mcp_oauth` entries: the exact-list rule would make Notion's registration again at its next sign-in, and
  that issuer's stored connections would then refresh with a client their refresh tokens weren't issued to. A new
  registration still covers every MCP redirect URI.
- **SG-S44 Made again once, unless it already refreshes.** The sealed registration records its scope; one without
  `offline_access` (every one made before) is made again under the same row, unless a connection signed in through it
  holds a refresh token: then the server issues them anyway, making it again would cut those connections off, and the
  sign-in asks its scope as before.
- **SG-S45 A dead registration** (SG-19b, the exchange or a refresh) is dropped only while the row still holds the
  client that was refused (one made again meanwhile stays). Connections still pointing at it sign in again.
- **SG-S46 `iss`** (SG-19d): only the order changed; the comparison still ignores a trailing slash (an exact match would
  refuse servers that print their issuer both ways).
- **SG-S47 `application_type`** is `native` only when every redirect URI is loopback (`localhost`, `*.localhost`,
  `127.0.0.0/8`, `::1`), else `web`. The Client ID Metadata Document is unchanged (served only on public https).
- **SG-S48 The https words** (SG-19e) come only from a refused registration whose redirect is plain http on a
  non-loopback host: Whombat still tries, since some servers take http.
- **SG-S49 Vendor MCP servers** (SG-20): nothing on the server names Notion. The transport, MCP address, check and tools
  come from the connection's sign-in (`connectionTransport`, `resolveMcpUrl`, `checkKindFor`, `ownDefinitions`), so a
  hand-made token keeps the REST API and the typed tools. Todoist's change words (“Added the task …”, Undo) apply only to
  its typed tools, never to a same-named tool of its MCP server. A unit test runs over every entry with a fixed
  `mcpUrl`.
