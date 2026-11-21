# Workstream: setting up connections (sign in once, Look only, found on your network)

John, 2026-10-08, on the Proxmox connect form (address, token ID, certificate fingerprint, token secret, name): “We need
to make the configuration / setting up as simple as possible for the user, instead of guiding the user to
"Documentation" and "figure it out yourself", I'd rather guide the user more.” On the proposal: “Password once is
okay, network scan is also okay, Let's skip the agent for now. … I like the approach of one times a password and then
Whombat sets it up correctly. So if we can do this for the other services also, that would be huge and perfect.
Otherwise, find solutions per connection to simplify the configuration.”

Contracts CT-314 (0.61.0). Numbering: CS-01… here; app AP-843…; implementation notes CS-D*. Every service sequence
below was read from the vendor's docs or source on 2026-10-08 (research notes in `~/.cache/wb-tmp/research*`);
anything marked *unverified* is handled defensively.

## Sign in once (CS-01…CS-09)

- **CS-01 One sign-in kind, one provisioner per service.** `password` in the catalog (CT-314); the server's
  `connections/provision/` has a provisioner per catalog id (`PROVISIONERS`): sign in, make Whombat's own key at the
  level asked, clean up the session, answer the key as the entry's token sign-in `tokenMethod`. The connection is then
  stored exactly as if the person had pasted that key (`signIn` stored as `token`, the token's `auth`), so checks,
  tools, Replace token and every call work unchanged.
- **CS-02 The password is used once and kept nowhere.** It arrives in `connections.create`'s `login` (already a secret
  op on managed boxes), is passed to the provisioner, and is dropped when the call ends: never logged, never in an
  error, an event, an audit line or a check. Provisioners keep no session either: tickets, cookies and short tokens are
  dropped (and logged out where the service can) before the call ends.
- **CS-03 A second factor is a second request.** When the service wants a code, the server answers
  `second_factor_needed` (with what kind, in words) and the form sends the same request again with `login.code`; the
  provisioner signs in from the start with the code. Nothing is held on the server between the two (services that hold a
  challenge — Proxmox, Home Assistant, UniFi — get a fresh one). `secondFactor: 'optional'` services (OPNsense,
  Forgejo) can't tell a missing code from a wrong password, so the form offers the code field from the start.
- **CS-04 Never hammer a login.** A refused password is never retried by the server (Unraid locks after 3 tries,
  UniFi and Grafana pause sign-ins); the one exception is Proxmox's realm (CS-20: at most two tries). The refusal says
  plainly what to fix (`sign_in_refused` reasons, CT-314), in our words.
- **Superseded in part by CS-54** (a home-network server's own certificate is trusted, not offered). **CS-05 The certificate first.** On an https address the password goes only to a server whose certificate verified
  or was pinned: an unverified certificate refuses before signing in with CX-D33's offer (“It presents AB:CD…; if
  {Name} shows the same fingerprint, use it …”). The form identifies the address first (`connections.identify`, CS-13),
  so the person trusts the certificate before typing the password. Over plain http on the home network the form warns
  that the password crosses the network unencrypted, as for a token (CX-40).
- **CS-54 A home-network server's own certificate is trusted.** When an entry's address is https on the home network,
  nothing is pinned yet and its certificate doesn't verify (self-signed, as Unraid, Proxmox and a NAS make for
  themselves), Whombat pins the certificate it presents and goes on: connecting, Sign in once, signing in on the
  service's page, Nextcloud's login and Sign in again. Every entry with an address takes a certificate fingerprint for
  this. A certificate that verifies is never pinned (it renews), and nothing is pinned for an address outside the home
  network. The connect forms fill the fingerprint as soon as the address is identified and say “Whombat trusts this
  certificate and only this one.” with Undo. *Why:* John, 2026-10-27: Unraid's sign-in stopped at “if Unraid shows the
  same fingerprint, use it”, which Unraid shows nowhere; servers on the home network always use their own certificate,
  so it should be accepted by default.
- **CS-55 A refused sign in once answers in its own words over the session.** When a provisioner stops with
  `sign_in_refused` or `second_factor_needed` (a wrong password, the code asked for, CS-03, CS-04, CS-D30), its requests
  count as undone, so the session answers that refusal and the form can show it, instead of “This may have happened…”
  (command-safety.md CS-02). `connections.create` is never sent again by itself, so nothing runs twice. *Why:* John,
  2026-10-27: Sign in once for Unraid with a wrong password only said “That didn’t work. Try again in a moment.”: the
  login's POST pinned the command, and the session replaced Unraid's refusal with an unknown outcome. Every two-step
  code prompt hit the same wall. The REST tests never went through the session; a session test does now.
- **CS-06 Names.** What Whombat makes is called `Whombat` (or `whombat`, `whombat-2` where names are ids). An existing
  item of the same name that Whombat can't tell is its own is never deleted: the next free suffix is taken.
- **CS-07 Access level.** Sign in once asks the service for a key at the level where it can (`serviceLimits`):
  Proxmox VE and Backup Server roles, Immich permissions, Unraid roles, Grafana roles, Forgejo scopes. Where it can't
  (Home Assistant, Nextcloud, Paperless-ngx, UniFi, OPNsense, Portainer) the key has the account's rights and Whombat
  keeps it to the level (CS-10).
- **CS-08 What the person reads afterwards.** A provisioner's `note` becomes a check line (warning) on the connection:
  e.g. Proxmox without `Permissions.Modify` (CS-20). The connect form shows `creates` before the person signs in.
- **CS-09 Where it can't.** Each refusal that means “sign in once can't work here” (`single_sign_on`, `unsupported`,
  `second_factor`) leads to the entry's other sign-in: the guided token (CS-15) or Nextcloud's login flow.

## Look only, Manage (CS-10…CS-12)

- **CS-10 Whombat's own limit.** `catalog_connections.access` (`read` | `manage`, migration 0090, default `manage`).
  On a connection that looks only, every write is refused before anything is sent (`accessTier`; the agent hears
  `lookOnlyText`): a `request` that isn't a read, a typed tool whose access is `write`, an MCP tool listed as write.
  `connection_tools` shows those as Off. The prompt line says “look only” (CT-314). Holds whatever the key could do.
- **Superseded in part by one-person.md OP-S50**: the person changes a connection's level, signed as `connection.changed` for every connection. **CS-11 Changing the level** (`connections.update` `access`): a manager (shared) or the owner (personal); signed as
  `connection.changed` for shared connections (“Set {label} to Look only|Manage”). Raising a key the service limited
  (`serviceLimits` and made by sign in once) doesn't widen the key: the page says to sign in again for a key that can
  manage.
- **CS-12 Tailscale's OAuth client** (`client_credentials`): connect checks the secret by exchanging it (`POST
  tokenUrl`, form `grant_type=client_credentials&client_id=<anything>&client_secret=<secret>&scope=<level's scopes>`)
  and calling the entry's check with the access token; the token (1 h) is cached sealed like an OAuth access token and
  exchanged again when due (single-flight, CX-D19); a refused secret marks the connection `needs_reauth`.

## Finding and naming (CS-13…CS-16)

- **CS-13 `connections.identify`**: normalise the address (add `https://` when no scheme is given and the entry's
  discovery says https, or the port the entry's targets name), check the destination (`destination_refused` as on
  connect), run the entry's discovery probes (or every entry's when no entry is given) with certificate verification
  off for these probes only (nothing secret is sent), read the leaf certificate's SHA-256 and whether it verifies
  normally, and answer the entry, version and certificate.
- **Superseded in part by one-person.md OP-S50**: Found on your network is the person's, with no managers' gate. **CS-14 Found on your network** (`connections.discover`, managers of the burrow):
  - *Where*: with the local network open (LN-01), the IPv4 networks of this Whombat's own interfaces (the /24 around
    its address when the network is larger; *amended by desk-found.md DF-13: as it is up to a /22, else the /22
    around the address*), the /24 of every connection's host on a private address, the home network
    list's IPv4 networks of at most 1 024 addresses, and the networks given (each at most 1 024 addresses); private
    ranges only, never this Whombat itself nor LN-02's closed ranges. With it closed, only the home network list's
    networks, on their listed ports.
  - *How* (*amended by connect-in-chat.md CIC-20…CIC-22: port 22 too, a computer that answers SSH is found as a server, one row per machine, servers added already left out*): a TCP connect to each catalog discovery port on each address (concurrency 128, 400 ms each; *256 since
    desk-found.md DF-14, DF-S01*), then each
    entry's probes on the open ports (`probeMatches`, `probeVersion`, 3 s each, certificate captured, never verified,
    nothing secret sent). One scan per burrow at a time; the last result is kept in memory (lost on restart, which is
    fine) and answered until a rescan; a new scan without `rescan` reuses one younger than 10 minutes.
  - *What*: each match as `DiscoveredService` with the connections already on that host and port.
- **CS-15 Making a token by hand, guided.** The token sign-ins carry numbered `steps` with values to copy, `paste`
  patterns (the form fills the fields from a pasted dialog or a dropped file; anything unmatched is the secret), and
  `links` per level where the service fills its own form from the link (Cloudflare, GitLab, Unraid, Grafana).
- **CS-16 Cloud services** (sign in once is impossible: SSO, 2FA, captchas):
  - Cloudflare: the token form pre-filled per level (personal token link with `permissionGroupKeys`).
  - GitLab: the personal access token form pre-filled (`name`, `scopes`; since 14.1; the path `/-/user_settings/…`).
  - Tailscale: the OAuth client (CS-12), the API access token as the second choice.
  - Hetzner, Mollie, Moneybird, Todoist: steps and the deep link.
  - Notion: unchanged (MCP OAuth first).
  - *Not now*: Todoist's open client registration (its OAuth mixes comma- and space-separated scopes and revokes
    everything on a reused refresh token; no live test possible) and Moneybird's (the token's acceptance on `/api/v2`
    is unverified). While checking Moneybird's registration endpoint the research created an orphan OAuth client there
    (`client_id 1ce5c469ae4bc36472b9d79789aa2ae2`, name `x`, redirect `https://example.invalid/cb`, no user, no access;
    no way to delete it from the API).

## The services (CS-20…CS-35)

Each: sign in, second factor, the key per level, what is stored, clean-up, refusals. `{base}` is the base URL.

- **CS-20 Proxmox VE** (`https://host:8006`).
  - Realm: an account with `@realm` is used as typed; else `GET /api2/json/access/domains` (public) → the realm marked
    `default`, else `pam` for `root`, else try `pve` then `pam` — at most two tries (each failure costs 3 s and a syslog
    line).
  - `POST /api2/json/access/ticket` (form `username=<user@realm>&password=…`) → `data.ticket`,
    `data.CSRFPreventionToken`, `data.username`. Second factor: `data.NeedTFA=1` (ticket starts `PVE:!tfa!`); without a
    code → `second_factor_needed` (“the code from your authenticator app”); with one → `POST /access/ticket` form
    `username=<userid>&tfa-challenge=<ticket>&password=totp:<code>` (recovery keys `recovery:<key>`). Security keys only
    (WebAuthn/U2F) → `refused unsupported` (make a token by hand).
  - Authenticated calls: `Cookie: PVEAuthCookie=<ticket>`; writes add header `CSRFPreventionToken`.
  - Rights: `GET /access/permissions?path=/` — does the account hold `Permissions.Modify` on `/`?
  - Token: `POST /access/users/{userid}/token/{tokenid}` form `privsep=1&comment=Whombat` (no expiry) → `full-tokenid`,
    `value`. Id `whombat`, then `whombat-2`… on `400 Token already exists`.
  - With `Permissions.Modify`: `PUT /access/acl` form `path=/&tokens=<full-tokenid>&roles=<roles>&propagate=1`; Look
    only `PVEAuditor`; Manage `PVEVMAdmin,PVEDatastoreAdmin,PVEPoolAdmin,PVESDNAdmin,PVEMappingUser,PVEAuditor`
    (filtered by `GET /access/roles`; never `PVEAdmin`: it can manage users). `limited: true`.
  - Without it: delete that token, make it again with `privsep=0` (the token has the account's own rights), `limited:
    false`, note “Proxmox didn’t let this account hand out permissions, so the token has the account’s own rights;
    Whombat keeps agents to the level you chose.”
  - Verify with the token: `GET /access/permissions?path=/` (`Authorization: PVEAPIToken=<id>=<value>`).
  - Stored: `tokenId` = full token id, secret = value. Clean-up: none (stateless tickets).
  - Refusals: `401 authentication failure` → `password` (“Wrong username, password or realm.”); `TOTP limit reached`
    → `locked`.
- **CS-21 Proxmox Backup Server** (`https://host:8007`). As CS-20 with: the account must include its realm (`@pam`,
  `@pbs`; without one: `@pam`); second factor when the ticket starts `PBS:!tfa!` (`CSRFPreventionToken` = `invalid`);
  the ticket only as `Cookie: PBSAuthCookie=<url-encoded ticket>`; token `POST /access/users/{userid}/token/{name}`
  (`comment`) → `tokenid`, `value`; no privsep: every token needs its own ACLs, which a user may set on their own
  tokens: one `PUT /access/acl` per role (`path=/&role=<role>&auth-id=<tokenid>&propagate=1`). Look only `Audit`,
  `RemoteAudit`, `TapeAudit`; Manage `DatastoreAdmin`, `RemoteAdmin`, `TapeAdmin`, `Audit` (+ `RemoteDatastoreAdmin`
  when the roles list has it). `limited: true`. Wrong login: `401 permission check failed.` → `password`.
- **CS-22 Home Assistant** (`http://host:8123`).
  - `POST /auth/login_flow` JSON `{client_id: <publicUrl>/, handler: ['homeassistant', null], redirect_uri: <publicUrl>/}`
    → `flow_id` (no `code_challenge`). `POST /auth/login_flow/{flow_id}` `{client_id, username, password}`:
    `errors.base = invalid_auth` → `password`; `step_id: 'select_mfa_module'` → send the first module; `step_id: 'mfa'`
    → without a code `second_factor_needed`, with one `{client_id, code}` (`invalid_code` → `code`); `type:
    create_entry` → `result` (the code). `404 Invalid handler` → `unsupported`; `403 … local only` → `rights` (“This
    account may only sign in from the home network.”).
  - `POST /auth/token` form `grant_type=authorization_code&code=…&client_id=…` → access and refresh token.
  - WebSocket `/api/websocket`: `auth_required` → `{type: 'auth', access_token}` → `auth_ok`; lists
    `auth/refresh_tokens` to pick a free name (`Whombat`, `Whombat 2`, …; one long-lived token per name); never deletes
    one; `{id, type: 'auth/long_lived_access_token', client_name: <name>, lifespan: 3650}` → the long-lived token.
  - Clean-up: `POST /auth/revoke` form `token=<refresh_token>`. Stored: bearer. `limited: false`.
- **CS-23 Nextcloud.** `GET /ocs/v2.php/core/getapppassword` with Basic auth, `OCS-APIRequest: true`, `Accept:
  application/json`, `User-Agent: Whombat (<name>)`, no cookies → `ocs.data.apppassword`. `403 You cannot request an
  new apppassword with an apppassword` → the password typed is an app password: use it as is. `401`: one `PROPFIND
  /remote.php/dav/` (Depth 0) with the same credentials; a body with `password login forbidden` → `refused
  second_factor`, `method: nextcloud_login` (“This account uses two-step sign-in. Sign in with Nextcloud instead.”);
  else `password`. Stored: `username` = the account as typed, secret = app password. `limited: false`. Clean-up: none.
- **CS-24 Paperless-ngx.** `POST /api/token/` JSON `{username, password, code?}` → `token`. `400 MFA code is required`
  → `second_factor_needed`; `Invalid MFA code` → `code`; `Unable to log in with provided credentials` → `password`;
  `429` → `locked`. Paperless keeps one token per user (shared with the person's other clients; a Regenerate there
  breaks Whombat's copy — said in the note). `limited: false`.
- **CS-25 Immich.** `GET /api/server/features`: `passwordLogin: false` → `unsupported`. `POST /api/auth/login`
  `{email, password}` → `accessToken`; `POST /api/api-keys` (bearer) `{name, permissions}` → `secret` (and `id` or
  `apiKey.id`); `POST /api/auth/logout`. Manage `['all']`; Look only by version (`GET /api/server/version`): `activity.read
  album.read album.download archive.read asset.read asset.view asset.download face.read library.read memory.read
  partner.read person.read sharedLink.read stack.read tag.read timeline.read timeline.download`, plus `user.read
  server.about duplicate.read` from 2.0, plus `map.read map.search folder.read` from 3.3; a 400 naming an unknown
  permission → retry once without the version-specific additions. `limited: true`. `401` → `password`.
- **CS-30 UniFi OS (Network and Protect)** (`https://console`, UniFi OS Server `:11443`).
  - `POST /api/auth/login` JSON `{username, password, token: <code or ''>, rememberMe: false}` → cookie `TOKEN` (or
    `UOS_TOKEN`) and header `X-CSRF-Token`. `499` (`MFA_AUTH_REQUIRED`, or `api.err.Ubic2faTokenRequired`) → without a
    code `second_factor_needed` (“the code from your authenticator app, or the one UniFi just emailed you”); with one,
    send again with `token` and the `UBIC_2FA` cookie (from the 499's body `data.mfaCookie` or its `Set-Cookie`). `401`/
    `403` `AUTHENTICATION_FAILED_INVALID_CREDENTIALS` → `password`; `429` → `locked`.
  - Key: `POST /proxy/users/api/v2/user/self/keys` (cookie, `X-CSRF-Token`, follow `X-Updated-CSRF-Token`) `{name,
    description}` → `data.full_api_key` (parse defensively; `self` 404 → `/user/<unique_id>/keys` from the login body);
    `401`/`403` → `rights` (“Sign in as the console’s Owner or a Super Admin.”).
  - Clean-up `POST /api/auth/logout`. Stored: `X-API-KEY`. `limited: false`. The same key serves Protect; an existing
    UniFi connection's key isn't reused (a key per connection). `/api/system` 404/401 → `unsupported` (“This is the older
    Network Server: API keys need a UniFi OS console.”).
- **CS-31 OPNsense** (25.1 or later). `GET /` (keep `PHPSESSID`), read the hidden CSRF input (random name and value);
  `POST /` form `<name>=<value>&usernamefld=…&passwordfld=…&login=1`: `302` signed in; `200` with “Wrong username or
  password” refused. A code: try `<code><password>`, then `<password><code>` (two tries, the only CS-04 exception after
  Proxmox's realm). Key: `POST /api/auth/user/add_api_key/<urlencoded user>` `{}` with the cookie and `X-CSRFToken` →
  `key`, `secret`; `403` → `rights`; `404` → `unsupported` (“older than 25.1”). Clean-up `GET /?logout`. Stored:
  `apiKey` = key, secret. `limited: false`.
- **CS-32 Unraid** (7.2 or later). `POST /login` form `username=root&password=…` → `302` and the `unraid_<…>` cookie;
  `200` with “Invalid username or password” → `password`; “Too many” → `locked`. `GET /Dashboard` → `var csrf_token =
  "…"`; `POST /graphql` (cookie, `x-csrf-token`) `mutation { apiKey { create(input: {name: "Whombat", description:
  "…", roles: [VIEWER|ADMIN]}) { id key } } }` (name: letters, digits and spaces only); `404`/`502` → `unsupported`.
  `GET /logout`. Stored: `x-api-key`. `limited: true`.
- **CS-33 Portainer.** `POST /api/auth {Username, Password}` → `jwt` (`422 Invalid credentials` → `password`; `422 Only
  initial admin …` → `single_sign_on`; `429` → `locked`); `GET /api/users/me` → `Id`; `POST /api/users/{Id}/tokens
  {description: <name>, password}` → `rawAPIKey`; `POST /api/auth/logout`. Stored: `X-API-Key`. `limited: false`.
- **CS-34 Grafana** (self-hosted; a `*.grafana.net` address → `unsupported`, “Grafana Cloud signs in through
  grafana.com: make a token instead.”). Basic auth on each call: `POST /api/serviceaccounts {name, role:
  Viewer|Editor}` → `id` (`400 already exists` → `GET /api/serviceaccounts/search?query=<name>`, exact name, `PATCH`
  its role when it differs); `POST /api/serviceaccounts/{id}/tokens {name: <name> <yyyymmdd-hhmm>}` → `key`. `401
  Invalid username or password` → `password`; `Login temporarily blocked` → `locked`; `403` → `rights` (“isn’t an
  organisation admin”). Basic auth off: `POST /login {user, password}` → `grafana_session` cookie, the same calls with
  the cookie and no `Origin`, then `GET /logout`. Stored: bearer. `limited: true`.
- **CS-35 Forgejo / Gitea.** `POST /api/v1/users/{account}/tokens` Basic auth (+ `X-Forgejo-OTP` and `X-Gitea-OTP` with
  a code) `{name: whombat-<yyyymmdd-hhmm>, scopes}` → `sha1`. Look only `read:repository read:issue read:organization
  read:user read:package read:notification read:misc`; Manage `write:repository write:issue write:organization
  write:package write:notification write:misc read:user`. `401` with “WebAuthn” → `unsupported` (security key: make a
  token by hand); other `401` → `password` (“Wrong username or password, or the 2FA code is missing or expired.”).
  Stored: `Authorization: token`. `limited: true`.

## The connect form (app, AP-843…)

- **CS-50 Steps instead of a field list.** (1) *Where is it?* — the address, identified as it is entered (version,
  “Its own certificate: AB:CD… — compare it with what {Name} shows, then Trust it”); skipped for cloud services.
  (2) *How should Whombat sign in?* — Sign in once (recommended, with `creates`), or the other sign-ins (the guided
  token: steps with copy buttons, the link per level, one paste box that fills the fields). (3) *What may agents do?*
  — Look only / Manage with the entry's `access` texts. Who it's for and the name under “More options”, with their
  defaults. A second factor's code field appears when the server asks (or from the start for `optional`).
- *Amended by connect-in-chat.md CIC-23: a found server, Proxmox VE, its Backup Server and Unraid offer Add as a server instead of Connect.* **CS-51 Found on your network** on the overview (managers, runtime feature `connections.discover`): what the last
  scan found, each with Connect (the connect page with the address filled and the certificate already shown), already
  connected ones marked; Scan again; “Look in another network” (a CIDR). Connected ones left out since CS-52.

## Found again, and hidden (CS-52…CS-53)

John, 2026-10-08, on his box's Found on your network (Home Assistant, two Proxmox VE hosts, Unraid and UniFi Network
listed as Connected between the new ones): “Devices that are already connected shouldn't be discovered again,
furthermore I would like to have the ability to hide a discovered device.” Contracts 0.63.0 (CT-316).

- **CS-52 Connected ones aren't found again.** A found service is connected when the person can see a connection of
  the same entry on its host — any port, a host name that resolves to the address counts — or of an entry no scan finds
  (Custom API, Custom MCP) on its host and port. The app leaves those out of the list; the answer still names them
  (`connectionIds`), so an empty list can say “Everything Whombat found on your network is connected already.” Another
  entry on the same address and port (a UniFi console's Protect next to its Network connection, Unraid next to Proxmox)
  is still found. This replaces CS-D27's “same host and port, any entry”.
- **CS-53 Hide a found service.** Each new row has Hide next to Connect (managers, runtime feature
  `connections.hide_found`). `connections.hideFound` hides that entry at that host and port for the whole burrow — the
  scan is the burrow's and only its managers see it (CS-14), so a hide is a decision about the burrow's network, not a
  personal view — kept in `connection_found_hidden` (migration 0093) across scans and restarts, and signed
  `connection.found_hidden` (“Hid Proxmox VE at https://10.100.0.240:8006 from Found on your network”). The footer's
  “Show 2 hidden” lists them with Unhide (`connection.found_shown`, “Showed … in Found on your network again”). A
  device that moves to another address is found again: Whombat can't know it is the same one.

## Decided while building

### Home services (CS-20…CS-25)

- **CS-D30 An answer no step expects.** A 5xx, a body without the field a step needs, or a WebSocket that closes or
  times out stops sign in once with `sign_in_refused` `unsupported`: “{Service} gave an answer Whombat didn’t expect
  ({status}), so Whombat stopped. Try again, or make a token by hand.” (Nextcloud: “sign in with Nextcloud”, Immich:
  “make a key by hand”). Never the service's text, so the person can retry or take the other sign-in (CS-09). A key
  Whombat made in the same call and couldn't finish (a refused ACL, a check with the token that fails, an answer
  without the secret) is deleted again: Whombat knows it is its own (CS-06). Names: ids take `-2` (`whombat-2`),
  display names a space (`Whombat 2`, `Whombat (Lumio) 2`), up to 20, then a refusal saying to remove unused ones.
- **CS-D31 Proxmox VE realms.** Typed with `@realm`: as typed. `root`: `root@pam` first, then the realm Proxmox marks
  default when that's another one. Anyone else: the default realm, or `pve` then `pam`. Never more than two tries.
  Proxmox Backup Server: `@pam` without asking (CS-21).
- **CS-D32 Proxmox details.** The rights are read before the token is made: with `Permissions.Modify` on `/` a
  privilege-separated token and one ACL with the level's roles (filtered by `/access/roles`); without it straight to
  `privsep=0` and the note, so no token is made only to be deleted; when Proxmox refuses the ACL anyway, the separated
  token is deleted and made again with `privsep=0` (CS-20's fallback). The token's comment is the name (`Whombat` or
  `Whombat (<name>)`). The code: six to eight digits → `totp:`, a YubiKey OTP (modhex) → `yubico:`, anything else
  when recovery keys exist → `recovery:`. An account with a YubiKey and no authenticator app is asked for “a one-time
  password from your YubiKey”; security keys only → `unsupported`, even with recovery keys left (the form never shows
  a code field for them). `NeedTFA` without a `!tfa!` ticket (Proxmox VE 6) → `unsupported`. Proxmox answers every
  failed sign-in “authentication failure”, so `locked` (TOTP limit) is recognised only when the text says so; else a
  wrong code. A PBS ticket's `CSRFPreventionToken` of `invalid` (the half-signed-in ticket) is never sent.
- **CS-D33 Home Assistant's tokens and codes.** An existing long-lived token is never deleted or replaced, not even
  one Whombat made: another connection (a second Home Assistant connection, one in another burrow) may still use it.
  Sign in once takes the first name no long-lived token has (`Whombat`, `Whombat 2`, …; Home Assistant allows one per
  name; a sign-in session's name doesn't count). Whombat's tokens carry `client_icon: mdi:paw` (a real icon, in case
  Home Assistant shows it) as a mark only. At `select_mfa_module` the authenticator app (`totp`) is
  chosen when offered, else the first module. The `notify` module sends a new code for every flow, which a second
  request (CS-03) can never match: `unsupported`. Other modules: “Enter your Home Assistant sign-in code.” A 403 when
  the flow starts is an IP ban → `locked`; a 403 later saying “remotely” → `rights` (home network only), any other
  403 → `rights` (“Check that it’s active”); an `abort` with `too_many_retry` → `locked`. An unfinished flow is
  aborted (`DELETE /auth/login_flow/{id}`); the session is revoked whatever happened. The IndieAuth client is
  `<publicUrl>/`, without PKCE (the code never leaves the call).
- **CS-D34 Nextcloud.** The app password's name in Devices & sessions is the `User-Agent`: the name (`Whombat` or
  `Whombat (<name>)`), which replaces the fetch's default `User-Agent`. A 403 that isn't about app passwords →
  `rights` (app passwords off, or an impersonated session); 429 (Nextcloud's brute-force delay at its maximum) →
  `locked`; a PROPFIND answering anything but 401 without the hint → CS-D30.
- **CS-D35 Paperless-ngx.** 429 (its `login` throttle, 5 a minute) → `locked`, “Wait a minute”; a blank field
  counts as a wrong password; spaces in the code are dropped. The note (CS-08): “Paperless keeps one API token per
  account, shared with your other apps: regenerating it in Paperless stops Whombat’s copy too.”
- **CS-D36 Immich.** Immich takes two keys of one name, but the person couldn't tell them apart: the next free name
  is taken (`Whombat 2`). A 400 at login (not an email address) counts as a wrong password. Features or version that
  don't answer: go on (no version: the read permissions every version knows). The retry without the newer
  permissions happens only for Look only, and only when the first list had them. `externalName` is Immich's
  `userEmail`; Proxmox's is the user id (`root@pam`); the others leave it to the check.

### Network services (CS-30…CS-35)

- **CS-D40 Shared rules of the network provisioners.** Every request goes through `input.fetch`: paths under the base
  URL (so a Grafana or Forgejo under a sub-path works), except UniFi, which signs in at the base URL's origin (the
  entry's base URL ends in `/proxy/network/integration`). Codes lose their spaces. An answer a provisioner doesn't know
  is `unsupported`, “{Service} answered in a way Whombat doesn’t know (HTTP n). Make … by hand instead.” (only the
  status, never the service's text), so the form offers the guided token (CS-09). Names: `Whombat`, `Whombat 2` …
  `Whombat 10`, then refused. Clean-up (logout) runs in `finally`, best-effort: it never fails or hides the call's own
  answer. The cookie jar (`provision/cookies.ts`) ignores domain and path: one origin per call; an expired or emptied
  cookie is dropped.
- **CS-D41 UniFi.** `GET /api/system` first, so a Network Server never gets the password. The key's body is
  `{name, description: "Made by Whombat for its agents"}`. The CSRF token comes from `X-CSRF-Token`, else
  `X-Updated-CSRF-Token`, else the session JWT's `csrfToken` claim (*unverified*: some consoles send no header). With a
  code the first login already carries `token: <code>`; any refusal after the 499 challenge is the code (`code`); a
  401/403 naming a limit or lock is `locked`. A key name refused as existing (400/409/422 saying so; *unverified*,
  UniFi may allow repeats) takes the next name.
- **CS-D42 OPNsense.** The CSRF field is the hidden input with `autocomplete="new-password"` (else the first other
  hidden input), in any attribute order; its value is the API's `X-CSRFToken`. A 302 or 303 is signed in. With a code,
  failing both orders is `password` (“Wrong username, password or code.”): OPNsense can't tell which was wrong.
  `{"result": "failed"}` (no local user of that name: LDAP, RADIUS) is `unsupported`. The DNS-rebinding page instead of
  the login form is `unsupported` with the way out (its IP address, or Alternate Hostnames), before the password is
  sent.
- **CS-D43 Unraid.** `apiKey.create` answers the existing key when the name is taken, with that key's roles: the names
  in use are read first (`query { apiKeys { name } }`) and the next free one is made, and a created key whose roles
  aren't exactly the level's is refused, never used. The mutation takes its input as GraphQL variables (the same
  `CreateApiKeyInput`); description “Made by Whombat (Look only|Manage)”; the name keeps letters, digits and spaces
  (`Whombat (Home)` → `Whombat Home`). Signed in means a 302 with an `unraid_*` cookie; a redirect from an http address
  to https is `unsupported` with “use the address from Settings → Management Access”. The third wrong password says
  Unraid now pauses sign-ins.
- **CS-D44 Portainer.** The JWT travels as `Authorization: Bearer`, never as its cookie (Portainer's CSRF check covers
  cookie sign-ins only). The user's id from `/api/users/me`, else the JWT's `id` claim. The token's description is the
  name (`Whombat`); descriptions may repeat, so there are no suffixes. A 422 naming OAuth, the initial admin or an
  unsupported login method is `single_sign_on`.
- **CS-D45 Grafana.** Signing in is `GET /api/user` with basic auth (it also gives the login for the connection's
  row). Only a 401 that names neither the password (“Invalid username or password”, `password-auth.*`) nor a block
  means basic auth is off and leads to the login form, so a refused password is never sent twice (CS-04); the form
  refused for anything but the password is `single_sign_on`. The service account of exactly the name is Whombat's: its
  role is PATCHed when it differs and it is turned back on when disabled; “already exists” without an exact match (the
  `sa-` login clashes) takes the next name. Token names `Whombat 20261008-1405` (UTC), then `… 2`. Basic auth needs
  no clean-up.
- **CS-D46 Forgejo / Gitea.** One request per name (newer Gitea uses a code up on its first use): token name
  `<name as an id>-<yyyymmdd-hhmm>` in UTC (`whombat-20261008-1405`, `whombat-home-…`), then `-2`. A 401 after a taken
  name with a code is `code` (“The server used up that code …”). Older servers that name the OTP in their 401 get
  `second_factor_needed` or `code`; newer ones the combined password message (CS-35). `auth method not allowed` (basic
  auth off) and a 400 naming a scope (before scoped tokens) are `unsupported`; a 404 with an `@` in the account is
  `password`, “Sign in with your username, not your email address.”, else `unsupported`.

### Wiring (core)

- **CS-D10 The order of sign in once** (`connect.ts` `createPasswordConnection`): the entry must offer `password` and
  have a provisioner (else `not_supported`, “Whombat can’t sign in to {Name} by itself yet. Make a token instead.”);
  `login` is required (field errors `login.account`, `login.password`); then the password form's fields, room (before
  signing in, so no key is made for a connection that can't be stored), the base URL, the destination (base and MCP
  URL), the certificate (CS-D12), the provisioner, the made key checked as the entry's token sign-in `tokenMethod`,
  saved as `signIn: 'token'` with that method's `auth`. A `fixed` account is used whatever the form sends. `secret` is
  ignored on this path, `login` on every other.
- **CS-D11 Name and address.** What Whombat makes is called `Whombat`: this Whombat has no configured instance name (a
  burrow's name is the team's, not the Whombat's), and services shared by several Whombats tell them apart by CS-06's
  suffixes. `publicUrl` is `redirectOrigin` (`PUBLIC_URL` self-hosted, the hosted app on managed boxes): the same origin
  as Home Assistant's OAuth `client_id` (`haClientId`).
- **CS-D12 The certificate first** is `HEAD /` under the same policy as the provisioner (the pin included): any answer
  passes; an unverified or mismatched certificate refuses with CX-D33's sentence and `certificateSha256` (entries with
  a fingerprint field), any other failure (unreachable, timeout) refuses with `outboundText`; either way before the
  password is sent. Plain http skips it (the check's http warning stays, CX-40).
- **CS-D13 The note** replaces the credential check line with a `warning` carrying it (`CatalogCheckResult` has one line
  per id and no id for notes). It lasts until the next check records what it finds (Check again, Replace token).
  `limited` isn't stored (no contract field): the app gives CS-11's “sign in again for a key that can manage” from the
  entry (`serviceLimits: true`).
- **CS-D14 Look only on the tools side.** `callTier` takes the connection's level (`accessTier`) and says `lookOnly`;
  `connection_call` answers `blocked` (`eventId: null`, `lookOnlyText`) before anything is committed or sent, and the
  command refuses it again in `apply` (a write approved after the switch). `connection_tools`: the guide starts with
  `lookOnlyText`, write tools are listed Off, and `request` is listed as `read` at its read tier
  (`requestCallTier(tier, 'read')`), because reads through it still work. The people's tools page
  (`connections.tools`) keeps the stored tiers: the app greys the writes from `connection.access`, and Manage brings
  them back unchanged.
- **CS-D15 `DispatchConnection.access`** is sent only for `read` (absent means manage), like `ownerName`.
- **Superseded in part by one-person.md OP-S50**: the level's event is signed for every connection. **CS-D16 The level's event**: “Set {label} to Look only|Manage” (System, `Settings · Connections`); with a rename in
  the same update “Renamed {old} to {new} and set it to Look only|Manage”; the payload adds `access`. A personal
  connection's change is a log line (PA-09). Lifecycle `tiers` follows a level change.
- **CS-D17 The OAuth client (`client_credentials`).** `client_id=whombat`, the secret in the form body, `scope` left out
  when the level names none. Minting a token changes nothing in the service, so exchanges are idempotent effects
  (`connections.update` stays a receipt op). 400/401 is a refused secret; `invalid_scope` is its own refusal on the
  connect side (“{Name} won’t give this client what {Level} needs. Give it those scopes in {Name}, or choose …”) and
  marks `needs_reauth` (`token_invalid`) at call time like a refused secret. The token's write is conditional on
  `credential_version` (a new secret or level that landed meanwhile wins). A new level exchanges at its scopes and
  runs the check before it is saved. A 401 on a call is retried once with a fresh token (as OAuth, CX-D19); answers
  are checked against the token and the client secret (VT-D22).
- **CS-D18 What a failed sign-in says.** `ProvisionError` → its own message (at most 500 characters) and reason/method;
  `OutboundError` → `check_failed` in our words (`outboundText`); anything else → `check_failed` “Whombat couldn’t
  finish signing in to {Name}. Try again, or make a token instead.” with only the error's name logged. A made key that
  doesn't fit the token sign-in's fields, or that the check refuses, is `check_failed` saying Whombat made its key (it
  stays in the service: the person can remove it there; the provisioner's suffixes keep the next try apart).
- **CS-D19 The run** (`provision/run.ts`): 15 s per request or handshake (what is left of 45 s at most), answers and
  WebSocket messages up to 1 MiB, `User-Agent: Whombat` unless the provisioner sends its own (Nextcloud's
  `Whombat (<name>)`), a request off the base URL's origin is `OutboundError` `destination`, every request after the
  deadline is refused, at most 256 unread socket messages, `next()` waits 10 s by default (never past the deadline),
  and every socket is terminated when the run ends. The socket uses `lib/outbound.ts`'s lookup and pin
  (`outboundConnectOptions`). Tests register stand-ins with `useProvisionerForTests` (refused outside
  `NODE_ENV=test`).

### Finding (identify, discover)

- **CS-D20 The address as typed becomes candidates, tried at once.** The query and fragment are dropped (a browser's
  Proxmox address carries `#v1:…`), a trailing slash is stripped, a path is kept and tried first, then the root (a
  deep link like `/lovelace/0`). With a port: the scheme typed, else the schemes the entry's targets name for that
  port in their order (Home Assistant's 8123: http, then https), else http, then https. Without one: the entry's
  targets in order (only those of the scheme typed), then the typed scheme's own port. No entry given: every entry
  with discovery, in catalog order. All candidates are probed in parallel; the first in that order whose probes all
  match answers, else the first that answered at all. An entry without discovery (GitLab, Custom API) gets https
  unless typed and one `GET /` that only says whether something answers and which certificate it has.
- **CS-D21 One refusal, as on connect.** The host is resolved once and each candidate checked with core's destination
  rule (`at: 'save'`); refused candidates are skipped quietly (a public host's http ones). Only when none passes does
  identify answer `destination_refused` with the first candidate's problem — the same body and words connect gives
  (`destinationRefusedText`, `canAdd` for admins). A typed address Whombat can't read is `validation_failed` on `url`.
- **CS-D22 The words.** Nothing answered: “Nothing answered at that address.” Answered but not the entry: “That address
  answered, but it isn’t a {Name}.” (“an” before Immich, OPNsense, Unraid). No entry given and nothing recognised:
  “That address answered, but Whombat doesn’t recognise what’s there.” A public address whose certificate didn't verify
  is reachable, without a certificate: “That address is on the internet and its certificate isn’t valid, so Whombat
  didn’t go on.”
- **CS-D23 The probe request is its own function** (`lib/probe.ts`), not a mode of `outboundRequest`: its agent dials
  only what `safeLookup` allowed (which now reports every resolved address, for the home-network test), keeps Node's
  host-name check so `trusted` means chain *and* name, and refuses an unverified certificate on a public address before
  the request is written. The policy's pin, `homeNetworkOnly`, body caps and longer deadlines don't apply; the body is
  cut at 64 KiB (not failed); it sends `user-agent: Whombat`. Within one identify, or one address of a scan, the same
  request goes out once (UniFi Network and Protect share `/api/system`).
- **CS-D24 Where a scan never looks.** Interfaces marked internal and container or VM bridges by name (`lo`, the
  computers' `wbc*`, `incusbr*`, `lxdbr*`, `docker*`, `br-*`, `virbr*`, `veth*`, `cni*`, `flannel*`, `cali*`,
  `kube*`, `podman*`); every address of this machine; any address core doesn't class `private` (the metadata addresses
  inside private space included); a network's own and broadcast addresses (wider than /31). Home network list entries
  wider than /22 are left out, the local network open or closed. At most 64 networks. *The box's own networks are
  looked in as they are up to a /22, else the /22 around its address (desk-found.md DF-13).*
- **CS-D25 Networks asked for.** IPv4, a /22 or narrower, private, else `validation_failed` on `networks.<i>`. With the
  local network closed each must lie inside a listed network (“With the local network closed, Whombat looks only in
  the home network list. Add this network there first.”) and is looked in on that network's listed ports. They are
  remembered per burrow (the last 8, in memory) and looked in again by later scans, so “Scan again” keeps them; one not
  asked before starts a new scan even within the 10 minutes.
- **CS-D26 How a scan runs and reads.** One unit of progress is an address and port: the TCP connect and, when open,
  that port's probes; `total` is known when the scan starts. On an open port the entries that name it are probed in
  parallel, each through its schemes for that port in turn. One `DiscoveredService` per entry, address and port (a
  UniFi console with Protect shows both). `progress` and `finishedAt` are null while scanning and when done
  respectively; while a scan runs, `found` is what it found so far plus what the last one found. Shutdown stops the
  scans (`closeConnections`); a restart forgets them.
- **CS-D27 Already connected (until CS-52).** A found service's `connectionIds` are the caller's visible connections
  (the burrow's shared ones and their own) whose base URL has the same port and the same host, or a host name that
  resolves to the found address (resolved when a scan is planned, and on first sight when answering).
- **CS-D28 Who.** **Superseded in part by one-person.md OP-S06, OP-S50**: identifying and scanning are the person's, with no admins' or managers' gate. `connections.identify`: anyone signed in, as `connections.probe` (admins get `canAdd` on a refusal).
  `connections.discover`: people who manage the burrow (`managers_only`).
- **CS-D29 The test seam.** `useDiscoveryNetForTests` (`connections/finder.ts`, `NODE_ENV=test` only) supplies the
  interfaces and `dial(address, port)` — where a checked address and port are really dialled, null for nothing
  listening — applied after the destination check and DNS (names resolve through the Vault's seam), for the scan's
  TCP connects and every probe.
- **CS-D47 Hiding, the details** (CS-53). Only an entry a scan finds, at a private IPv4 address, can be hidden
  (`validation_failed` on `catalogId` or `url` otherwise); the url's scheme only shapes the event's text. Hiding what
  is hidden, or showing what isn't, changes nothing and signs nothing. At most 500 per burrow: past that the
  longest-hidden one shows again (no refusal for a list nobody reads). The answer is the running or last scan, as
  `connections.discover` gives it, without starting one. `connection.found_hidden` and `connection.found_shown` (kind
  System) aren't in core's `EVENT_TYPES` yet (any dotted type is allowed); they go in with the next contracts minor.
