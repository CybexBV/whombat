# Hosts service HTTP API (whombat-hosts, formerly the Rackoon hub)

This is the HTTP API of the hosts service as the code implements it
(`internal/hub`). The route table is `UIHandler` in `internal/hub/api.go`.
**Headless** (`serve --headless`, inside Whombat) only the data routes are
served, on a Unix socket, authenticated by the service token with
`X-Whombat-Actor`: `docs/WHOMBAT.md` is that contract and lists what is not
served headless (Auth, Tokens, Users, Single sign-on, Notifications, the
Assistant, the UI).
`docs/CONTRACT.md` is the older contract with the web UI; where the two differ,
this file follows the code.

## Basics

- The API is served on the UI listener (`--listen`, default `:8080`) under
  the base path **`/api/v1`**. Paths below are relative to it unless they
  start with another prefix. Agents use a separate listener
  (`--agent-listen`, see `docs/AGENT-PROTOCOL.md`).
- Bodies are JSON (UTF-8). A request body is at most 1 MiB, and unknown
  fields are refused (400 `bad_request`). Endpoints that accept an empty
  body say so.
- Timestamps are RFC 3339 in UTC with whole seconds
  (`"2026-10-13T14:00:00Z"`), except where noted (the audit log and
  `X-Next-Before` use fractional seconds).
- `GET` responses with status 200 carry a weak `ETag` (a matching
  `If-None-Match` answers 304), `Cache-Control: private, no-cache` and
  `Vary: Cookie`. Every other JSON response carries
  `Cache-Control: no-store`. `GET /auth/state` is always `no-store` and has
  no ETag.
- JSON bodies of 1024 bytes or more are gzipped when the request's
  `Accept-Encoding` allows it (`Content-Encoding: gzip`,
  `Vary: Accept-Encoding`).
- Any other path or method under `/api/` answers 404 `not_found` (a
  non-GET request without a valid CSRF token gets 403 `csrf` first).
- Every response carries security headers: a strict
  `Content-Security-Policy`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy:
  same-origin`, and `Strict-Transport-Security` when the hub serves TLS or
  its public URL is https.

Routes outside `/api/v1`: `GET /healthz` ([Hub](#hub)), `/ping/{token}`
([Checks](#checks)), `GET /install.sh` and `GET /download/{name}`
([Enrollments and agents](#enrollments-and-agents)). The signed
acknowledge link `POST /api/v1/alerts/{id}/ack-link` is under
[Alerts](#alerts). Everything else that is not under `/api/` serves the web
UI (GET and HEAD only).

In the route tables, **Role** is the minimum role the router checks
(`anyone`: no session needed). Some routes check a higher role inside the
handler; the table says so. **Reauth** means the handler calls the
re-authentication check (see below).

## Authentication

A request is authenticated by an API token (`Authorization: Bearer`) or,
when it has none, by the browser session cookie. The router then checks,
in this order: the Origin (403 `bad_origin`), that a session or token is
present where the route needs one (401 `unauthenticated`), CSRF (403
`csrf`), the kiosk and temporary-password limits, the role (403
`forbidden`).

### Browser sessions

- Signing in (`POST /auth/login`, `/auth/passkey/login/finish`,
  `/auth/setup`, `/auth/kiosk`) sets the cookie **`rackoon_session`**
  (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when the public URL is
  https or the hub has `--tls-cert`). It slides: each use renews it for 30
  days (renewed at most every 5 minutes), up to 90 days after sign-in.
- **CSRF.** Every request other than GET, HEAD and OPTIONS needs the header
  **`X-CSRF-Token`**, else 403 `csrf`:
  - signed in: the session's token, `csrf_token` of `GET /auth/state`;
  - not signed in (setup, login, passkey login, kiosk): `GET /auth/state`
    sets the pre-session cookie `rackoon_csrf` (`Path=/api/v1/auth`,
    `SameSite=Strict`, 1 hour) and returns the same value as `csrf_token`
    (double submit). After signing in, fetch `/auth/state` again for the
    session's token.
- **Origin.** A non-GET request whose `Origin` header is not the public URL,
  one of `--allowed-origins` or the request's own host gets 403
  `bad_origin`, before any other check. The console WebSocket requires an
  `Origin` header.
- **Kiosk sessions** come from `POST /auth/kiosk` with a token. Their role
  is capped at viewer, they never count as re-authenticated, and outside
  `/api/v1/auth/` any request other than GET, HEAD and OPTIONS gets 403
  `kiosk_read_only`. Deleting the token ends them.
- **Temporary password.** While a user must replace a temporary password
  (`password_change_required` in `/auth/state`), every request of a
  non-kiosk browser session outside `/api/v1/auth/` gets 403
  `password_change_required`.

### API tokens

- Send **`Authorization: Bearer rk_…`**. Tokens are created with
  `POST /tokens` (the secret is shown once). No cookie and no CSRF token
  are needed; the Origin check still applies when the request has an
  `Origin` header.
- The effective role is the lower of the token's role and its owner's
  current role.
- An unknown or expired token, or a kiosk-kind token, is ignored: the
  request is anonymous (401 `unauthenticated`) unless it also has a session
  cookie.
- Tokens cannot create tokens, change the password, manage passkeys or
  confirm a session (403 `forbidden`). They count as re-authenticated.
- The last use is recorded at most every 5 minutes.

### Roles

`viewer` < `operator` < `admin`. In short: viewers read everything except
the admin areas; operators also acknowledge alerts, manage maintenance
windows, open consoles, run power actions and change guests' configuration,
disks, backups and firewall (where the server allows it); admins also
manage servers, enrollments, agents, notifications, checks, tokens of
others, the audit log, backups, the host shell and host power actions, and
create, clone, delete and restore guests ([Manage](#manage)).

### Re-authentication

Sensitive calls answer 403 **`reauth_required`** unless the session signed
in or confirmed its credentials within the re-authentication window (10
minutes). Confirm with `POST /auth/reauth` (password) or
`POST /auth/passkey/reauth/begin` + `/finish`; the UI shows a dialog and
retries. API tokens count as re-authenticated; kiosk sessions never do.

Single sign-on accounts have no password: they confirm with a passkey or
with a fresh sign-in at the provider (`GET /auth/oidc/start?reauth=1`, see
[Single sign-on](#single-sign-on-oidc)).

Calls that check it: `POST /tokens`, `POST /users`, `PATCH /users/{id}`,
`DELETE /users/{id}`, `PATCH /servers/{id}` when it turns a
remote-control switch on, `POST /channels`, `PATCH /channels/{id}` when it
sets `url`, `headers` or `token`, `GET /hub/backup`, `POST /hub/restore`, `POST /agents/update`,
`POST /servers/{id}/console-sessions` with protocol `shell` or `vnc`,
`POST /servers/{id}/screen` for every step but `status`,
`POST /servers/{id}/actions`, the admin routes of [Manage](#manage), the
changing routes of [Assistant](#assistant) (settings, installs, sign-in),
and `POST /auth/password` when replacing a temporary password without
`current`.

### Rate limits

Limits answer 429 `rate_limited` with `Retry-After` (seconds) unless noted.

| What | Limit | Retry-After |
|---|---|---|
| Credential checks (setup, login, kiosk, reauth, password change, passkey login and reauth finish), per client IP | 10 per 5 min; successful attempts are not counted | 300 |
| The same, per user name (login, reauth, password change, passkey reauth) | 20 per 15 min | 900 |
| Credential checks in progress, hub-wide | 4 at a time | 5 |
| `POST /auth/passkey/login/begin` and `GET /auth/oidc/start`, per client IP | 30 per 5 min (one shared count) | 60; single sign-on redirects with `oidc_error=rate_limited` instead |
| Pending passkey ceremonies, hub-wide | 1000 | 60 |
| Thumbnails, per user | 240 per minute | 60 |
| Console, action, screenshot and manage requests after refusals, per user | 30 refusals (`insufficient_role`, `console_disabled`, `power_disabled`, `manage_disabled`; refused manage reads do not count) in 10 min | 600 |
| Open consoles | 5 per user, 10 per server, 20 per agent | 429 `session_limit`, no header |
| Heartbeat pings, per client IP | 120 per minute | plain-text 429, no header |

The client IP is the peer address, or the right-most untrusted
`X-Forwarded-For` hop when the peer is a trusted proxy
(`--trusted-proxies`, default loopback).

## Errors

API errors are `application/problem+json` with `Cache-Control: no-store`.
`title` is the HTTP status text, `code` the machine-readable reason,
`detail` a sentence for people.

```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json

{"code":"reauth_required","detail":"Confirm it's you to continue.","status":403,"title":"Forbidden","type":"https://rackoon.dev/problems/reauth_required"}
```

Problems of the [Manage](#manage) routes add `field_errors` (form field
or configuration key → message) when values failed validation.

Common codes (each route lists its specific ones):

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad_request` | Body missing, not valid JSON, or has an unknown field |
| 401 | `unauthenticated` | No valid session or token |
| 403 | `forbidden` | Role too low, or the call is not allowed for tokens or kiosk sessions |
| 403 | `csrf` | `X-CSRF-Token` missing or wrong |
| 403 | `bad_origin` | Cross-origin request |
| 403 | `kiosk_read_only` | Kiosk session tried to change something |
| 403 | `password_change_required` | Replace the temporary password first |
| 403 | `reauth_required` | Confirm the credentials, then retry |
| 403 | `insufficient_role` | Console, power or manage request below operator (admin for host access and the admin manage routes) |
| 404 | `not_found` | Unknown path or object |
| 404 | `server_not_found`, `guest_not_found` | Unknown server or guest |
| 409 | `agent_offline` | The server's agent is not connected |
| 429 | `rate_limited` | See rate limits; has `Retry-After` |
| 500 | `internal` | Unexpected error (logged by the hub) |
| 502 | `agent_error` | The agent did not answer or failed |
| 503 | `audit_unavailable` | The audit log cannot be written; consoles, actions, screenshots and backups are refused |

The plain routes (`/healthz`, `/ping/…`, `/install.sh`, `/download/…`)
answer errors as plain text.

## Auth

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /auth/state` | anyone | | 200 |
| `POST /auth/setup` | anyone | | 204, session cookie |
| `POST /auth/login` | anyone | | 204, session cookie |
| `POST /auth/logout` | anyone | | 204 |
| `POST /auth/password` | viewer | temporary password only | 204 |
| `POST /auth/reauth` | viewer | | 204 |
| `POST /auth/passkey/register/begin` | viewer | | 200 |
| `POST /auth/passkey/register/finish` | viewer | | 201 |
| `POST /auth/passkey/login/begin` | anyone | | 200 |
| `POST /auth/passkey/login/finish` | anyone | | 204, session cookie |
| `GET /auth/passkeys` | viewer | | 200 |
| `DELETE /auth/passkeys/{id}` | viewer | | 204 |
| `POST /auth/passkey/reauth/begin` | viewer | | 200 |
| `POST /auth/passkey/reauth/finish` | viewer | | 204 |
| `POST /auth/kiosk` | anyone | | 204, kiosk session cookie |

**`GET /auth/state`**. Signed in:

```json
{"setup_required": false, "authenticated": true, "user": {"name": "john", "role": "admin"},
 "passkeys": 1, "passkeys_available": true, "csrf_token": "…", "kiosk": false,
 "has_password": true, "source": "local", "password_change_required": false}
```

Not signed in: `{"setup_required", "authenticated": false, "user": null,
"passkeys": 0, "passkeys_available", "csrf_token"}`, and the `rackoon_csrf`
cookie is set. `oidc: {"name": "…"}` is added when single sign-on is
configured. `passkeys_available` is false unless the public URL is https
with a host name (or `http://localhost`). With an API token, `csrf_token`
is `""`.

**`POST /auth/setup`** `{"setup_token": string, "username": string,
"password": string}`. Works only while no account exists; the setup token
is printed in the hub log (new on every start). Creates the account as
admin and signs in. Errors: 409 `setup_done`, 403 `invalid_setup_token`,
400 `invalid_username` (1 to 64 letters, digits, `.`, `_`, `@`, `-`), 400
`weak_password` (10 to 1024 characters), 429 `rate_limited`.

**`POST /auth/login`** `{"username": string, "password": string}`. Errors:
401 `invalid_credentials`, 429 `rate_limited`.

**`POST /auth/logout`**, no body. Deletes the session, closes its consoles
and clears the cookie; 204 also without a session.

**`POST /auth/password`** `{"current": string, "new": string}`. Browser
sessions only (403 `forbidden` for tokens and kiosk sessions). Signs out
every other session of the account and closes their consoles. While a
temporary password is set, `current` may be `""`: the call then needs a
recent sign-in (reauth) and `new` must differ from the temporary password.
Errors: 403 `invalid_credentials` (wrong `current`), 400 `weak_password`,
400 `same_password`, 403 `reauth_required`, 429 `rate_limited`.

**`POST /auth/reauth`** `{"password": string}`. Marks the session as
re-authenticated now. Errors: 403 `forbidden` (token or kiosk), 403
`invalid_credentials`, 429 `rate_limited`.

**Passkeys.** Without passkey support the begin and finish routes answer
409 `passkeys_unavailable`. A begin call sets the cookie `rackoon_webauthn`
(5 minutes, `Path=/api/v1/auth`) that its finish call needs; begin
responses are go-webauthn options `{"publicKey": {…}}` with binary fields in
base64url, and finish bodies are the browser's `credential.toJSON()` (at
most 64 KiB).

| Route | Body | Response | Errors |
|---|---|---|---|
| `register/begin` | optional `{"name": string}` (≤64 chars, default `Passkey <date>`) | 200 creation options | 403 `forbidden` (token, kiosk), 400 `webauthn`, 429 |
| `register/finish` | credential | 201 `{"id": "<base64url>", "name": "…"}` | 400 `ceremony_expired`, 400 `webauthn` |
| `login/begin` | none | 200 request options (discoverable credentials) | 400 `webauthn`, 429 |
| `login/finish` | assertion | 204, session cookie | 400 `ceremony_expired`, 401 `invalid_credentials`, 429 |
| `reauth/begin` | none | 200 request options for the user's passkeys | 403 `forbidden`, 409 `no_passkeys`, 400 `webauthn`, 429 |
| `reauth/finish` | assertion | 204 | 403 `forbidden`, 400 `ceremony_expired`, 403 `invalid_credentials`, 429 |

**`GET /auth/passkeys`** →
`[{"id": "<base64url>", "name": "YubiKey", "created_at": "…", "last_used_at": null}]`.

**`DELETE /auth/passkeys/{id}`** (`id` in base64url). Errors: 403
`forbidden` (token, kiosk), 404 `not_found`.

**`POST /auth/kiosk`** `{"token": "rk_…"}`. Any unexpired token (API or
kiosk kind) opens a kiosk session as its owner with role viewer, and
records the token's `last_used_at`. The UI's kiosk link is
`<public URL>/kiosk#rk_…` (the fragment never reaches a server log). Errors:
401 `invalid_token`, 429 `rate_limited`.

Single sign-on adds `GET /auth/oidc/start` and `GET /auth/oidc/callback`
([Single sign-on](#single-sign-on-oidc)).

## Tokens

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /tokens` | viewer | | 200 |
| `POST /tokens` | viewer | yes | 201 |
| `DELETE /tokens/{id}` | viewer | | 204 |

**`GET /tokens`** lists the caller's tokens; `?all=1` lists everyone's
(admins; others get 403 `forbidden`). Kiosk sessions get 403 `forbidden`
(also for `GET /auth/passkeys`).

```json
[{"id": "tk_3f9a0c1d2e4b5a69", "name": "prometheus", "role": "viewer", "user": "john",
  "created_at": "…", "last_used_at": "…", "expires_at": null, "kind": "api"}]
```

**`POST /tokens`**. Browser sessions only (403 `forbidden` for tokens and
kiosk sessions).

| Field | Type | Notes |
|---|---|---|
| `name` | string | required, ≤64 characters |
| `role` | string | optional: `viewer` (default), `operator`, `admin`; at most the caller's role |
| `expires_days` | int | optional: 0 = never (default), up to 3650 |
| `kind` | string | optional: `api` (default, a bearer token) or `kiosk` (opens kiosk sessions only, role viewer) |

Response: the token object plus `"token": "rk_…"`, the secret, shown only
here. Errors: 400 `invalid_name`, 400 `invalid_kind`, 400 `invalid_role`
(unknown role, or a kiosk token with another role than viewer), 403
`invalid_role` (above the caller's role), 400 `invalid_expiry`, 403
`reauth_required`.

**`DELETE /tokens/{id}`**: own tokens; admins any. Others' tokens answer 404
`not_found`. Ends the kiosk sessions opened with the token.

## Fleet and servers

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /fleet` | viewer | | 200 |
| `GET /fleet/series` | viewer | | 200 |
| `GET /servers` | viewer | | 200 |
| `GET /servers/{id}` | viewer | | 200 |
| `GET /servers/{id}/metrics` | viewer | | 200 |
| `GET /servers/{id}/annotations` | viewer | | 200 |
| `GET /servers/{id}/guests/{guestId}/metrics` | viewer | | 200 |
| `GET /groups` | viewer | | 200 |
| `GET /servers/{id}/settings` | admin | | 200 |
| `PATCH /servers/{id}` | admin | when turning a switch on | 200 |
| `DELETE /servers/{id}` | admin | | 204 |

`range` is `1h`, `6h`, `24h` (default), `7d`, `30d` or `90d`; anything else is 400
`invalid_range`. `group` is a group name (case-insensitive); empty or `All`
means every server. A server's `status` is `online`, `warning` or `offline`:
`offline` when its agent's heartbeat is 60 s old (or it never connected),
else `warning` while one of its open alerts asks for attention (`attention`
in [Alerts](#alerts): not acknowledged, muted or suppressed), else
`online`. `status_note` is the note of the most severe of those alerts
(`offline`: `no heartbeat` / `never connected`; `online`: null).
`open_alerts` counts every open alert. A change of either (an alert
acknowledged, a snooze ending, maintenance starting or ending) sends
`server.updated`.

**`GET /fleet?group=&range=`** (range is only validated). Keys: `as_of`,
`groups`, `kpis`, `servers` (cards), `alerts` (open alerts of the group;
hub-level alerts only for the whole fleet), `hints`, `top_guests_by_cpu`,
`platform_summary`, `agents_connected`, `pending_enrollments`.

```json
{"as_of": "2026-10-13T14:00:00Z",
 "groups": [{"name": "All", "count": 5}, {"name": "Lab", "count": 3}],
 "kpis": {"servers_online": 5, "servers_total": 5, "cpu_avg_pct": 12.4, "memory_pct": 41.0,
          "open_alerts": 1, "open_alerts_attention": 1, "…": "…"},
 "servers": [{"id": "basalt", "hostname": "basalt", "group": "Lab", "status": "online",
              "status_note": null, "agent_connected": true, "via": "10.100.1.97", "open_alerts": 0, "console_on": true,
              "maintenance": null, "parent": null, "…": "…"}],
 "alerts": [], "hints": [], "agents_connected": 5, "pending_enrollments": 0, "…": "…"}
```

`servers[].via` is the hub's own IP address the server's agent connection
arrived at, absent when it isn't connected (as in `GET /agents`).

**`GET /fleet/series?group=&range=`**: sparklines (60 points per range) and
a CPU heatmap (48 buckets); `null` marks gaps. Per server also `net_mbps`
(host network in + out) and `temp_max_c` when stored. Cached in the hub for
5 s (1h, 6h), 30 s (24h) or 60 s (7d, 30d, 90d).

```json
{"range": "24h", "as_of": "…",
 "kpi": {"step_s": 1440, "timestamps": ["…"], "cpu_pct": [12.1, null], "mem_pct": [40.2, null]},
 "servers": {"basalt": {"step_s": 1440, "cpu_pct": [3.1, null], "mem_pct": [22.0, null], "net_mbps": [41.5, null], "temp_max_c": [61.0, null]}},
 "heatmap": {"buckets": 48, "bucket_s": 1800, "timestamps": ["…"], "cpu_pct": {"basalt": [3.4, null]}}}
```

**`GET /servers`**: the server list in card order:
`[{"id", "hostname", "group", "status", "status_note", "os", "detail_view", "os_family", "last_seen", "agent_connected", "open_alerts", "hosts_this_whombat"?, "backup_place"}]`.
`detail_view` is `macos` (a Mac), `proxmox` (a Proxmox VE node), `unraid`
(an Unraid server), `incus` (a host running Incus that is neither),
`libvirt` or `standard`, in that order of precedence; `os_family` is
`macos` for a Mac's agent and `linux` for every other server that reported
(absent before the first report; also on the fleet cards and in
`server.os_family` of the detail); a Mac's `os` is `macOS 27.2.1`;
`hosts_this_whombat` is present (true) when one of the host's guests is
the hosts service itself.

**`GET /servers/{id}?range=`**: the detail page. Keys: `as_of`, `range`,
`server`, `live`, `banner`, `hints`, `sensors`, `virtualization`, `disks`,
and per view (`server.detail_view`): `workloads` (standard), or `cluster`,
`storages`, `backups`, `guests` (proxmox), or the standard keys plus
`unraid` (unraid: the array, parity, disks, pools, flash, shares,
plugins, unread notifications, Docker and VM manager of an unRAID server,
`docs/CONTRACT.md` "Unraid"), or the standard keys plus `macos` (macos:
the Mac's facts, below). Proxmox VE wins over unRAID. Every view has
`backup_place` ("Backup places" under "Manage"; `null` from an older
agent).

After a server reports, `server.first_report_at` gives the time of its earliest retained reading.
For rolled-up history it gives the start of the bucket.

A Mac's `macos` block (`null` where the Mac doesn't say; snake_case of
the agent's `Report.MacOS`):

```json
"macos": {"version": "27.2.1", "build": "26B131", "model": "Mac14,14", "model_name": "Mac Studio", "chip": "Apple M2 Ultra",
          "sip": true, "filevault": false, "auto_login": "alice", "console_user": "alice",
          "screen": {"sharing": true, "account": "alice", "sign_in": "ok", "sign_in_at": "…", "locked": false, "w": 5120, "h": 2880},
          "helper": {"installed": true, "version": "1.0.0", "running": true, "ax": true, "user": "alice",
                     "latest": "1.1.0", "update": {"available": true, "version": "1.1.0", "installed": "1.0.0", "auto": true}}}
```

`console_user` is who is at the screen (`null`: the login window);
`screen.sharing` whether Screen Sharing answers on the Mac; `account`,
`sign_in` (`ok` | `failed`, `null` when not tried), `sign_in_at`,
`locked`, `w`, `h` come from the agent's screen part; `helper` is Whombat
Helper (`running`: it answered in the screen's session within the last
minute; `ax`: it has Accessibility; `latest`: the hub's helper build,
`null` without one; `update`: how this Mac's helper follows it, as `GET
/agents`' `helper`, [Agent updates](#agent-updates)).
`server.remote_control` holds
the caller's effective permissions (`console`, `power`, `host_shell`,
`host_power`, `manage`, `diagnose` (the assistant's read-only checks), the
agent's flags `agent_*`, and `*_reason` when refused; `manage` is true for
operators, the admin manage routes check the role themselves).
`sensors[].max_24h_c` is the maximum over `range`. A host whose agent
reports Incus adds `incus` (any view): `{version, clustered, projects:
[{name, description, instances, running}], pools: [{name, driver, status,
description, used_bytes, total_bytes, volumes}], networks: [{name, type,
managed, description, ipv4, ipv6, nat, used_by}], profiles: [{name,
project, description, used_by}], images: [{fingerprint, aliases,
description, type, architecture, size_bytes, uploaded_at, last_used_at,
auto_update, cached, project}], volumes: [{pool, name, project, type:
"custom", content_type, size_bytes, used_bytes, used_by: [hub guest ids],
description}]}` (bytes, addresses and times `null` when unknown;
`used_by` of networks and profiles is a count). Errors: 404
`server_not_found`, 400 `invalid_range`.

**`GET /servers/{id}/metrics?range=&series=`**. `series` is a
comma-separated list (at most 64; default: every stored series). Names:
`cpu_pct`, `mem_pct`, `load1`, `swap_pct`, `net_rx_mbps`, `net_tx_mbps`,
`disk_read_mbs`, `disk_write_mbs`, `temp_max_c`, `temp_<sensor id>_c`,
`guest_disk_io_mbs`, `guest_net_mbps`, `vol_pct:<fs:/mount|pool:name|storage:id>`.
Unknown names come back as all-`null` arrays with a `null` summary.
`timestamps[i]` is the end of bucket i; when `as_of` is not on a bucket
boundary, the last bucket is the current, partial one and its timestamp is
`as_of`.

```json
{"server": "basalt", "range": "1h", "step_seconds": 60, "points": 60, "as_of": "…",
 "timestamps": ["…"], "series": {"cpu_pct": [3.2, 4.1, null]},
 "summary": {"cpu_pct": {"avg": 3.8, "max": 9.5, "max_at": "…"}}}
```

Instead of `range`, a custom window: `?from=<RFC 3339>[&to=<RFC 3339>]`
(at least 10 minutes, within the last 90 days; `to` defaults to now):
about 120 buckets from the finest tier that covers it, `range` is
`"custom"` and `as_of` the end of the window. Otherwise 400 `invalid_range`.

**`GET /servers/{id}/guests/{guestId}/metrics?range=`** (or `from`/`to`):
a guest's history in the same shape plus `"guest"`. Series `cpu_pct`,
`mem_mb`, `net_rx_mbps`, `net_tx_mbps`, `disk_read_mbs`, `disk_write_mbs`,
sampled once a minute while the guest runs (up to 300 running guests per
host, the busiest first).

**`GET /servers/{id}/annotations?range=`** (or `from`/`to`): chart
markers, oldest first, at most 200: alerts that opened, the host's boot,
finished power / snapshot / host actions and agent updates.

```json
[{"at": "…", "kind": "alert", "severity": "warning", "text": "Disk nvme1n1 is 78% worn out"},
 {"at": "…", "kind": "action", "text": "web restarted by john"}]
```

**`GET /groups`** → `["Lab", "Production"]` (group names in card order,
without `All`).

**`GET /servers/{id}/settings`**:

```json
{"id": "basalt", "group": "Lab", "location": null,
 "remote_control": {"console": true, "power": false, "host_shell": false, "host_power": false, "manage": false, "diagnose": true},
 "agent_policy": {"console": true, "power": true, "host_shell": false, "host_power": false, "manage": false, "diagnose": true},
 "parent": "", "detected_parent": null}
```

`remote_control` are the hub's switches, `agent_policy` the flags in the
agent's `agent.toml` (both must be on). `parent`: `""` = detected, `"-"` =
none, else a server id.

**`PATCH /servers/{id}`**, every field optional (send at least `{}`):

| Field | Type | Notes |
|---|---|---|
| `group` | string | ≤64 characters, not empty, not `All` |
| `location` | string | ≤128 characters |
| `parent` | string | `""` detect, `"-"` none, or another server's id |
| `remote_control` | object | `console`, `power`, `host_shell`, `host_power`, `manage`, `diagnose` (bool, each optional) |

Response: the settings object. Turning a switch on needs reauth; turning
`console` off closes the server's guest consoles, `host_shell` off its host
shells. Errors: 404 `server_not_found`, 400 `invalid_group`, 400
`invalid_parent`, 403 `reauth_required`.

**`DELETE /servers/{id}`**: deletes the server with its reports, metrics and
alerts (the audit log stays), revokes its agent certificate, disconnects
the agent and closes its consoles. Errors: 404 `server_not_found`.

## Guests

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /servers/{id}/guests` | viewer | | 200 |
| `GET /servers/{id}/guests/{guestId}` | viewer | | 200 |
| `GET /guests` | viewer | | 200 |

A guest id is `<platform>:<id>`: `docker:pihole`, `incus:nixbuild`,
`libvirt:win11`, `pve:101`. Platforms: `docker`, `incus`, `libvirt`, `pve`;
kinds: `vm`, `container`. The keys depend on the platform: Docker has
`last_exit` and no `vcpu`, I/O or `snapshots`, and its `console` is always
`{"available": false}`; Proxmox adds `vmid`, `node`, `last_backup`, and when
the agent reports them `tags` (array), `pending_changes` (configuration
changes waiting for a restart), `guest_agent` (`running` or `not_running`:
the QEMU guest agent of a running VM that has it enabled), `oldest_snapshot`
(timestamp), `backup_job` (whether an enabled backup job covers the guest)
and `ha_state` (the HA manager's state of an HA resource). Docker guests on
unRAID add `autostart`, `template` (a dockerMan template exists: the
container can be updated) and `web_ui` (its web page, when known);
libvirt guests add `autostart`. Any platform: `self: true` (only when
true) marks the guest the hosts service itself runs in (its MAC is one of
the hub machine's own; `docs/MANAGE.md` 1); its server then has
`hosts_this_whombat: true` in `GET /servers`, the fleet cards and `server`
of `GET /servers/{id}`.

```json
{"id": "incus:nixbuild", "name": "nixbuild", "platform": "incus", "kind": "vm", "image": "nixos/26.05",
 "state": "running", "vcpu": 8, "cpu_pct": 21.5, "memory_used_mb": 10035, "memory_limit_mb": 16384,
 "disk_read_mbs": 42, "disk_write_mbs": 118, "net_rx_mbps": 12, "net_tx_mbps": 4, "snapshots": 3,
 "uptime_s": 518400,
 "console": {"available": true, "protocols": ["spice", "serial"], "default_protocol": "spice", "resolution": "1280x800"}}
```

`sort` is `cpu` (default), `memory`, `name` or `state` with an optional `-`
or `+` prefix (cpu and memory sort descending by default). `cursor` is the
previous page's `next_cursor` (`null` on the last page).

**`GET /servers/{id}/guests?platform=&kind=&q=&sort=&limit=&cursor=`** →
`{"guests": [...], "total": 12, "next_cursor": null}`. `platform` also
accepts the Proxmox tab names `vm` and `ct`. `q` matches name, id or image.
`limit` defaults to 50, at most 500. Errors: 404 `server_not_found`, 400
`invalid_platform`, 400 `invalid_kind`.

**`GET /servers/{id}/guests/{guestId}`** → the guest object. Errors: 404
`server_not_found`, 404 `guest_not_found`.

**`GET /guests?q=&state=&platform=&kind=&server=&tag=&sort=&limit=&cursor=`**:
every guest of the fleet; offline servers are listed from their last report.

```json
{"guests": [{"server": "basalt", "server_online": true, "id": "incus:nixbuild", "…": "…"}],
 "total": 1, "next_cursor": null,
 "counts": {"all": 1, "running": 1, "stopped": 0, "unhealthy": 0}, "platforms": {"incus": 1}, "tags": {}}
```

`state` is `running`, `stopped` or `unhealthy`; `sort` also accepts
`server`; `limit` defaults to 100, at most 500. With `q`, exact name
matches come first, then name prefixes, other name matches and id or image
matches. `tag` keeps the guests with that tag (case-insensitive, exact).
`counts`, `platforms` and `tags` (tag in lower case → guests with it) cover
the guests matching `q` and `server`, before the other filters. Errors: 400
`invalid_state`, `invalid_platform`, `invalid_kind`.

## Alerts

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /alerts` | viewer | | 200 |
| `POST /alerts/{id}/ack` | viewer, operator checked inside | | 200 |
| `DELETE /alerts/{id}/ack` | viewer, operator checked inside | | 200 |
| `POST /api/v1/alerts/{id}/ack-link` | the signed link | | 200, text |

The alert object (also in `GET /fleet` and the `alert.*` events):

```json
{"id": "al_5c1e9a2b7f30", "server": "basalt", "severity": "warning", "title": "/srv 91% full",
 "detail": "910 GB of 1 TB used", "opened_at": "…", "rule": "disk.space_high",
 "entity": "fs:/srv", "key": "disk.space_high:fs:/srv", "state": "open",
 "resolved_at": null, "link": "#storage",
 "acknowledged": {"at": "…", "by": "john", "note": "", "until": null},
 "muted": false, "suppressed_by": null, "attention": false}
```

`server` is `""` for hub-level alerts (checks, `security.denied_requests`).
`entity` is what the alert is about within its rule: a volume (`fs:<mount>`,
`pool:<name>`, `storage:<id>`), a disk device, a sensor id, a pool or array
(`pool:<n>`, `raid:<n>`), `ups:<n>`, `net:<iface>`, `fan:<source>`,
`cluster:<n>`, `repl:<id>`, a guest (`<platform>/<id>`), `vzdump`, `ceph`,
`host`, or for hub-level alerts `check:<id>` / `user:<name>`. `key` is
`<rule>:<entity>`: a server has at most one open alert per key, and a
recurrence opens a new alert (a new `id`) with the same key. Watch
settings switch rules off per server and entity
([Watch settings](#watch-settings)).
`muted`: the host is in maintenance; `suppressed_by`: the host it runs on is
offline; `attention`: open and none of acknowledged, muted, suppressed.

**`GET /alerts`** query parameters:

| Parameter | Values |
|---|---|
| `state` | `open` (default), `resolved`, `all` |
| `server` | a server id, or `hub` for hub-level alerts only |
| `group` | group name; hub-level alerts are included only without a group (or `All`) |
| `severity` | `critical` or `warning` |
| `rule` | exact rule, or a prefix ending in `.` (`check.`) |
| `q` | substring of title or detail |
| `since` | opened at or after this RFC 3339 time (for `resolved` and `all`) |
| `overlaps_since` | still open or resolved at or after this RFC 3339 time (for `resolved` and `all`) |
| `until`, `before` | opened before this RFC 3339 time (for `resolved` and `all`) |
| `limit` | 1 to 1000 (other values give 200); `resolved` and `all` only |

`open` lists the open alerts, most severe first, without paging.
`resolved` and `all` list newest first; when a full page came back, the
header `X-Next-Before` holds the last `opened_at` for the next `before=`.
Errors: 400 `invalid_state`, 400 `invalid_severity`, 400 `invalid_time`.

**`POST /alerts/{id}/ack`**, optional body `{"note": string (≤256),
"minutes": int}`. `minutes` 0 (default) acknowledges until the alert
resolves; 1 to 43200 snoozes it. Either ends early when the alert's
severity rises within its rule (`ups.on_battery` on battery → battery low,
`ceph.health` HEALTH_WARN → HEALTH_ERR): it asks for attention again. A
recurrence is a new alert, never acknowledged. Response: the alert. Errors:
403 `forbidden` (viewers), 400 `invalid_duration`, 404 `alert_not_open`.

**`DELETE /alerts/{id}/ack`** removes the acknowledgement. Response 200 with
the alert. Errors: 403 `forbidden`, 404 `alert_not_open`.

**`POST /api/v1/alerts/{id}/ack-link?e=<unix expiry>&t=<signature>`**: the
Acknowledge button of an ntfy notification about one alert (sent only when
the hub has a public URL). The link is the credential: no session, no CSRF
token, no Origin check. It works for 7 days and acknowledges as
`notification link`. Response: 200 `text/plain` `Acknowledged: <title>`.
Errors (problem+json): 403 `invalid_link`, 404 `alert_not_open`, 500
`internal`.

## Watch settings

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /servers/{id}/watch` | viewer | | 200 |
| `PUT /servers/{id}/watch` | operator | | 200 |

A server's alert rules can be switched off, for the whole server or for
one entity (a disk, a mount, a guest, a sensor: the alert's `entity`). An
off rule is not evaluated for that server (or entity): no alert opens, and
an open one resolves at once (`alert.resolved`). Switched on again, it is
evaluated again from scratch (a rule that must hold for a while waits
again). Hub-level rules (`check.*`, `security.*`) are not per server;
switch a check off with `PATCH /checks/{id} {"enabled": false}`. Hints are
not affected (an off rule's hint, such as `sensor.near_limit` below a
switched-off `sensor.temp_high`, can show). The settings are in the
database: they survive restarts, are in backups and go with a deleted
server.

**`GET /servers/{id}/watch`** returns rules switched off and custom limits, by rule and entity
(the whole rule first):

```json
{"rules": [{"rule": "disk.wear_high", "off": true, "by": "John Doe (pe_8f2c)", "at": "2026-10-22T09:30:00Z"},
           {"rule": "net.link_down", "entity": "net:eno2", "off": true, "by": "John Doe (pe_8f2c)", "at": "…"}],
 "limits": [{"rule": "disk.space_high", "entity": "fs:/srv", "value": 95}]}
```

`entity` is absent when the whole rule is off; `off` is always `true`
(only what is off is listed; `{"rules": []}` when nothing is). Errors: 404
`server_not_found`.

**`PUT /servers/{id}/watch`** `{"rule": string, "entity"?: string, "off":
bool}`: switches one rule off or on again, for the server (`entity` absent
or `""`) or one entity. The two are separate: switching the whole rule on
again keeps the entities switched off on their own. Unknown fields are
refused. Doing what is already so changes nothing (`by` and `at` stay).
A change is audited (`server.watch_changed`, details `rule`, `entity`,
`off`) and sent as `watch.changed` and `server.updated`. Response: the
server's settings as `GET`. `rule` is one of the server rules:
`agent.heartbeat_missing` (the server stays `offline` when it is, only
the alert is off), `sensor.temp_high`, `sensor.temp_critical`,
`sensor.fan_failed`, `disk.wear_high`, `disk.wear_critical`,
`disk.smart_failing`, `disk.smart_errors`, `disk.space_high`,
`disk.full_soon`, `fs.read_only`, `fs.inodes_high`, `pool.degraded`,
`pool.errors`, `raid.degraded`, `hypervisor.overcommit`,
`hypervisor.memory_assigned`, `pve.quorum_lost`,
`pve.replication_failed`, `backup.failed`, `ceph.health`,
`time.unsynced`, `ups.on_battery`, `net.link_down`, `host.oom`,
`guest.restart_loop` and `guest.stopped`. Errors: 400 `invalid_rule`, 400 `invalid_value`
(`off` missing), 400 `invalid_entity` (more than 200 bytes or control
characters), 400 `bad_request`, 403 `forbidden` (viewers), 404
`server_not_found`, 409 `too_many` (500 per server).

**`PUT /servers/{id}/watch`** also takes `{"rule": string, "entity"?: string, "limit": number | null}`.
Omit `entity` for a whole server. An item's limit takes precedence over the
server's limit, and clearing either with `null` restores what it inherits.
The hub checks its latest report as soon as the limit changes. An alert
that falls below its new limit resolves right away. Alerts still open with
the rule's usual delay. A server can keep up to 500 custom limits.
A change sends `watch.changed` and `server.updated`
and is audited with `limit` in the details.

| Rules | Limit |
|---|---|
| `disk.space_high`, `fs.inodes_high`, `disk.wear_high`, `disk.wear_critical` | 1 to 100 % |
| `sensor.temp_high`, `sensor.temp_critical` | 1 to 150 °C |

An optional `expected_limit` checks the old value, with `null` meaning no
custom limit at that scope. A mismatch gives 409 `limit_changed`.
A limit outside the range or on any other rule gives 400 `invalid_limit`.
Temperature and SSD wear warning limits must be below each affected item's
critical limit. A change that would violate that order also gives
400 `invalid_limit`, with the limit to stay above or below in `detail`.

## Maintenance

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /maintenance` | viewer | | 200 |
| `POST /maintenance` | operator | | 201 |
| `DELETE /maintenance/{id}` | operator | | 204 |

A window mutes alerts of its hosts (`muted: true`; no notifications). The
window object:

```json
{"id": "mw_9b2c4e1f0a7d3c55", "scope": "server", "target": "basalt", "starts_at": "…",
 "ends_at": "…", "weekdays": [], "start_time": "", "duration_min": 0, "tz": "UTC",
 "note": "Firmware update", "created_by": "john", "created_at": "…",
 "active": true, "active_until": "…", "next_start": null}
```

**`POST /maintenance`**:

| Field | Type | Notes |
|---|---|---|
| `scope` | string | `server`, `group` or `all` |
| `target` | string | server id or group name; ignored for `all` |
| `starts_at` | string | RFC 3339, default now |
| `ends_at` | string | one-off: the end |
| `duration_min` | int | one-off: length from `starts_at`; weekly: length, 1 to 10080 |
| `weekdays` | []int | weekly: 0 (Sunday) to 6; makes the window weekly |
| `start_time` | string | weekly: `HH:MM` |
| `tz` | string | IANA time zone, default `UTC` |
| `note` | string | ≤256 characters |

A one-off window needs `ends_at` or `duration_min`, must end after it
starts and last at most a year. Response: the window. Errors: 400
`invalid_scope`, `invalid_target`, `invalid_tz`, `invalid_time`,
`invalid_weekday`, `invalid_duration`.

**`DELETE /maintenance/{id}`** (also "unmute"). Errors: 404 `not_found`.

## Events

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /events` | viewer | | 200, `text/event-stream` |

Server-Sent Events. Each event is `id: <n>`, `event: <name>`,
`data: <JSON>`. The stream starts with `retry: 5000` and sends a
`: keepalive` comment every 20 seconds.

- **Resume** with the `Last-Event-ID` header (or `?last_event_id=`): the hub
  replays the missed events from a buffer of 4096. When the id is older
  than the buffer (or from a previous hub run) it sends `resync` with `{}`
  instead: refetch everything.
- The stream ends when the session is signed out or expired, or the token
  deleted (checked every 20 seconds), and when the client falls 512 events
  behind (reconnect with `Last-Event-ID`). A user has at most 16 streams;
  a new one closes the oldest. A stream keeps the role it was opened with;
  changing the user's role, signing the user out or deleting the account
  ([Users](#users)) ends their streams at once.

| Event | Sent to | Data |
|---|---|---|
| `server.updated` | everyone | `{"id", "status", "status_note", "current", "last_seen", "agent_connected"}` |
| `server.online` | everyone | `{"id", "at"}` |
| `server.offline` | everyone | `{"id", "at"}` (`at`: the last frame from the agent) |
| `server.settings_changed` | everyone | `{"id"}` |
| `server.deleted` | everyone | `{"id"}` |
| `guest.state_changed` | everyone | `{"server", "id", "state"}` |
| `alert.opened`, `alert.updated`, `alert.resolved` | everyone | the alert object; `alert.updated` when it is acknowledged or unacknowledged, a snooze lapses, or its severity changes (a rise also ends the acknowledgement) |
| `maintenance.changed` | everyone | `{}` |
| `watch.changed` | everyone | `{"server", "rule", "entity"?, "off" or "limit"}` ([Watch settings](#watch-settings)) |
| `checks.changed` | everyone | `{}` or `{"id"}` |
| `action.finished` | everyone | `{"action_id", "server", "guest", "action", "result": "ok"\|"error", "message", "state", "noop", "code"}` |
| `task.finished` | everyone | `{"server", "guest", "task", "op", "result": "ok"\|"warning"\|"error", "message", "new_id"?, "code"?}` ([Manage](#manage)) |
| `console.closed` | the console's user | `{"session_id", "reason"}` |
| `enrollment.pending` | admins | `{"id", "hostname"}` (not for a pre-approved enrollment) |
| `enrollment.approved` | admins | `{"id", "server_id", "hostname"}` (pre-approved or by hand) |
| `agent.update` | admins | `{"server", "state", "message"}`: `updating`, `failed` (+ `version`, `by`), `waiting` (+ `waiting_for`), `updated` (+ `from`, `to`, `by`: the update is done), `halted` (+ `version`), `""` (cleared) ([Agent updates](#agent-updates)) |
| `agent.helper_update` | admins | A Mac's Whombat Helper: the same states and fields as `agent.update`; `updated`'s `message` is what the agent said; `waiting_for` may be `agent` ([Agent updates](#agent-updates)) |
| `assistant.state` | admins | the assistant state ([Assistant](#assistant)) |
| `assistant.investigation` | admins | an investigation, created or changed |
| `assistant.event` | admins | `{"investigation", "event"}`: a new transcript entry |
| `assistant.deleted` | admins | `{"id"}` |
| `resync` | the reconnecting stream | `{}` |

## Enrollments and agents

| Route | Role | Reauth | Success |
|---|---|---|---|
| `POST /enrollments` | admin | `operate`, `full` | 201 |
| `GET /enrollments` | admin | | 200 |
| `POST /enrollments/{id}/approve` | admin | stored `operate`, `full` | 200 |
| `POST /enrollments/{id}/reject` | admin | | 204 |
| `GET /agents` | admin | | 200 |
| `GET /agent-install.sh` | admin | | 200, shell script |
| `GET /install.sh` | anyone | | 200, shell script |
| `GET /download/{name}` | anyone | | 200, binary |

Flow: create an enrollment, run its `install_command` on the host, the
agent enrolls on the agent listener (state `pending`, event
`enrollment.pending`), approve it. A new server has every remote-control
switch off but `diagnose`. A **pre-approved** enrollment skips the wait:
the hub approves it when the agent asks.

**`POST /enrollments`**, optional body (empty or `{}`: as before):

```json
{"approve": true, "control": "full", "name": "pve-03", "group": "Rack"}
```

- `approve` (default `false`): approve when the agent asks, in its enroll
  request (`202 {…, "state": "approved", "server_id"}`; the first poll
  returns the certificate). The server is named `name`, else the agent's
  host name (slugged as in approve); a taken name gets `-2`, `-3`, … up to
  `-99` (never an existing server's identity; past that the enrollment
  waits for an admin). Audited as `enrollment.approved` by the token's
  creator with `auto: "true"`; event `enrollment.approved`.
- `control`: `watch` (`diagnose` only), `operate` (`console`, `power`,
  `diagnose`) or `full` (all six switches): the server's switches when it
  is approved, automatically or by hand. `install_command` then ends with
  `--control <level>`, which sets the agent's own `[remote_control]` to the
  same level. `operate` and `full` need a recent sign-in from a browser
  session (as switching them on does).
- `name`: 1–63 printable characters with something left after slugging.
- `group`: default `Ungrouped`.

```json
{"id": "en_4d1f…", "token": "…", "expires_at": "…",
 "install_command": " curl -fsSL https://hosts.example.net/install.sh | sudo sh -s -- --token … --control full",
 "agent_url": "wss://hosts.example.net:8443", "ca_sha256": "…",
 "approve": true, "control": "full", "name": "pve-03"}
```

`control` and `name` are `null` when not given. Errors: 400
`invalid_control`, `invalid_name`, `invalid_group`, `bad_request`; 403
`reauth_required`.

Headless, the command fetches from the agent listener with its key pinned
(` curl -fsSL --insecure --pinnedpubkey 'sha256//…' https://<agents
address>:8443/install.sh | sudo sh -s -- --token …`) and the answer adds
`install_url` and `tls_pin`; 503 `no_agent_url` when the hub does not know
the agents' address.

The token is single use and expires after 1 hour. The command starts with
a space so shells that ignore space-prefixed lines keep it out of history.

**`GET /enrollments?state=`**: `pending` (default), `issued`, `approved`,
`rejected`, `expired` or `all`. Error: 400 `invalid_state`.

```json
[{"id": "en_4d1f…", "state": "pending", "hostname": "basalt", "os": "Debian GNU/Linux 13",
  "address": "10.100.0.7", "agent_version": "0.1.0", "requested_at": "…", "created_at": "…",
  "expires_at": "…", "server_id": null, "approve": false, "control": "operate", "name": null}]
```

**`POST /enrollments/{id}/approve`**, optional body `{"group": string,
"name": string}`. The server id is `name` (default: the enrollment's
`name`, else the reported hostname) in lower case with dashes, at most 63
characters (`The Titan` → `the-titan`). `group` defaults to the
enrollment's, else `Ungrouped`. The enrollment's `control` sets the
server's switches. Response:
`{"server_id": "the-titan"}`. Errors: 404 `not_found`, 409 `not_pending`
(not pending, or requested more than an hour ago), 400 `invalid_name`, 400
`invalid_group`, 400 `invalid_csr`, 409 `server_exists`.

**`POST /enrollments/{id}/reject`**. Error: 409 `not_pending`.

**`GET /agents`**:

```json
[{"server_id": "basalt", "hostname": "basalt", "group": "Lab", "location": null, "version": "0.1.0",
  "connected": true, "via": "10.100.1.97", "status": "online", "last_seen": "…", "address": "10.100.0.7", "clock_skew_s": 0.2,
  "collectors": [{"name": "docker", "ok": true, "error": null}],
  "remote_control": {"console": true, "power": false, "host_shell": false, "host_power": false, "manage": false, "diagnose": true},
  "agent_policy": {"console": true, "power": true, "host_shell": false, "host_power": false, "manage": false, "diagnose": true},
  "cert_expires_at": "…", "arch": "amd64", "install": "systemd",
  "update": {"available": true, "version": "0.1.1", "auto": true, "can_install": false}, "helper": null}]
```

`via` is the hub's own IP address the agent's connection arrived at
(absent when it isn't connected, or came through a local proxy with the
proxy protocol). `install` is `systemd`, `openrc`, `sysv`, `unraid`, `launchd` (a Mac) or `manual`. `update`
and `helper` (a Mac's Whombat Helper, `null` for other servers) are
described under [Agent updates](#agent-updates).

**`GET /install.sh`**: the agent installer with the hub's agent URL, CA
fingerprint and binary checksums filled in (`text/x-shellscript`,
`no-store`). Served on the UI listener (not headless) and on the agent
listener; from the agent listener it downloads the binary from there with
the listener's key pinned (`TLS_PIN`). Usage:
`curl -fsSL <hub>/install.sh | sudo sh -s -- --token <token>`. Options:
`--token TOKEN` (`-` reads the first line of stdin), `--control
watch|operate|full`, `--force`, `--hub wss://HOST:PORT`, `--download-base
URL` (also `file://`), `--sha256 HEX`, `--uninstall`, `--purge`. An agent
already enrolled with this hub (same CA) is upgraded in place and keeps
its identity (with or without a token); one of another hub is left alone
(exit 3) unless `--force`. The last stdout line is `whombat-agent: added
<server>`, `waiting <enrollment>`, `kept <server>` or `other-whombat`,
after `whombat-agent: os <system>`; errors end with stable `install.sh: …`
words. On a Mac (macOS 13 or later, `install.sh: macOS 13 or later is
needed` otherwise) it installs the LaunchDaemon `com.whombat.agent` and,
when `--agent-dist` has it, Whombat Helper. Details: `docs/WHOMBAT.md` §6.
A malformed `Host` gets 400 `bad host`.

**`GET /agent-install.sh`** (under `/api/v1`, admin): the agent listener's
`install.sh` for a client that runs it itself (Whombat over SSH): the
downloads and the agent URL are the agents' address with the listener's key
pinned, never the request's `Host`. 503 `no_agent_url` when the hub does
not know that address.

**`GET /download/{name}`** (UI and agent listener):
`whombat-agent-{linux,darwin}-{amd64,arm64}`, `whombat-helper-macos.zip`
and `whombat-helper-macos.json` from `--agent-dist`
(`application/octet-stream`, `application/zip`, `application/json`;
attachment, `Cache-Control: no-cache`, range requests work). Anything else
is 404. The installer offers the helper only when the zip's size and
SHA-256 match its JSON (`{"version", "sha256", "size"}`).

## Hub

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /hub` | admin | | 200 |
| `GET /hub/backup` | admin | yes | 200, `application/gzip` |
| `POST /hub/restore` | admin | yes | 202 |
| `POST /hub/agents/move` | admin | | 200 |
| `GET /healthz` | anyone | | 200, text |

**`GET /hub`**:

```json
{"version": "0.1.0", "schema": 14, "started_at": "…", "uptime_s": 86400, "go": "go1.27.2",
 "database_bytes": 52428800, "database_free_bytes": 1048576, "servers": 5, "agents_connected": 5,
 "consoles_open": 0, "public_url": "https://hosts.example.net", "agent_url": "wss://10.100.1.158:8443",
 "agent_url_previous": "wss://10.100.1.160:8443", "agent_url_changed_at": "2026-10-21T08:02:11Z",
 "restored_at": null, "restore_error": null,
 "headless": false, "ca_sha256": "…", "tls_pin": "sha256//…", "agents_url": "wss://hosts.example.net:8443",
 "reconnecting": {"since": "2026-11-03T10:00:00Z", "until": "2026-11-03T10:05:00Z", "reason": "move", "waiting": 2}}
```

- `agent_url`: the agents' address the hub tells its agents first
  (`--agent-url`, or auto's LAN address now; "" when it has none). Until
  2026-10-21 this was the `--agent-url` setting as given ("" for auto).
- `agent_url_previous`, `agent_url_changed_at`: when the agents' address
  differed from the one recorded (at a start, or the 30-second address
  check while it runs), the one before and when; they stay until the next
  change (null: never changed). A restore brings the backup's address as
  the recorded one, so a restore onto a box at another address shows the
  backup's address here.
- `restored_at`: when a backup was restored into this database (null:
  never).
- `restore_error`: the last staged backup that could not be applied at a
  start, `{"at", "code", "message"}` (`code`: `bad_backup`,
  `newer_schema` or `failed`), else null. A later successful restore
  clears it.
- `reconnecting`: null, or the hold while the hub reconnects to its
  servers: the hub's own address went away (or the agents' address
  changed), at least two thirds of at least 3 connected agents dropped
  within 30 s, or `POST /hub/agents/move` asked them to move. `reason` is
  the first trigger's: `address_changed`, `many_dropped` or `move`. While
  it lasts, the servers it covers (connected when it began, dropped in
  the 30 s before or during it) raise no `agent.heartbeat_missing`; those
  still away at `until` get it then. It lasts 5 minutes from `since`; a
  new trigger moves `until` to 5 minutes from then, at most 15 minutes
  after `since`. `waiting` is how many covered servers aren't back yet:
  not connected, or still on the connection they had through an address
  that went away or before they were asked to move. At 0 the hold ends
  early. `server.offline` events and the servers' status are not held.
  Audit `hub.reconnecting` `{reason}` once per hold (system). It lives in
  memory: a restarted hub has none (its start's alert grace covers that).

**`GET /hub/backup`**: a `.tar.gz` download (the box's checkpoints take
a plain tar, `hub.tar`, from `whombat-hosts backup`; the same files)
(`rackoon-backup-YYYYMMDD-HHMMSS.tar.gz`) with a consistent copy of the
database, the CA and `manifest.json` `{"format": 1, "hub_version",
"schema", "created_at", "agent_url", "ca_sha256"}` (`agent_url` "" when the
hub knew none). Not the agent listener's certificate: a restored hub makes
its own. It holds secrets (the CA key) and is audited before it is sent.
Errors: 403 `reauth_required`, 503 `audit_unavailable`.

**`POST /hub/restore`**: the body is a backup (`GET /hub/backup`'s file
or a plain tar such as `hub.tar`, told apart by their first bytes; at most
1 GiB). The hub checks it, keeps it as
`<data>/restore-staged.tar.gz` or, a plain tar, `restore-staged.tar`
(0600; an older staged file under the other name is removed) and answers `202 {"ca_sha256": "…",
"servers": 5, "agent_url": "wss://10.100.1.160:8443" | null}` (the backup's
CA, servers and agents' address); half a second later it stops on its own
(exit 0) and its service manager starts it again (`Restart=always`). At
start, before anything listens, a staged backup is applied — whoever put
it there under either name, whatever it holds (the API, the appliance's
console restore; with both, the newer one): the database, its
journal, the CA and the agent listener's certificate are kept as
`<name>.pre-restore-<time>.bak`, the backup's database and CA take their
place, the listener certificate is issued again by the restored CA for this
hub's addresses, and the service token file is left alone. A backup that
can't be applied is renamed `restore-failed-<time>.tar(.gz)`, the hub starts
with what it had and `GET /hub` answers `restore_error`. Audit:
`hub.restore_staged` (the person), `hub.restored` / `hub.restore_failed`
(system). Errors: 400 `bad_backup` (not a backup, damaged, without a CA,
over 1 GiB), 400 `newer_schema` (made by a newer hub), 409 `same_hub` (the
backup's CA is this hub's), 409 `hub_not_empty` (the hub has servers or
enrollments waiting for approval), 409 `restore_pending` (one is staged
already), 403 `reauth_required`, 503 `audit_unavailable`, 507 `no_space`.

**`POST /hub/agents/move`** `{"url": "wss://10.100.1.97:8443"}`: asks every
connected agent that isn't already connected through `url` to connect
there instead (the control message `hub_move`, `docs/AGENT-PROTOCOL.md`)
and opens a `reconnecting` hold with reason `move` for them. An agent
counts as already there when the host and port it dialled are `url`'s, or
its connection arrived at `url`'s IP and port. Answers `200 {"asked": 2,
"already": 4}` (the messages go out in the background; agents too old for
`hub_move` are asked too and ignore it). Whombat follows the move through
`via` in `GET /agents` or `GET /fleet`. Audit `hub.agents_moved` `{url,
asked}`. Errors: 400 `bad_request` unless `url` is a `wss://host:port` URL
(no path, query or user) that is one of the hub's own addresses now (the
list agents are told, HS-170).

**`GET /healthz`**: `ok` (200) when the database answers and the background
jobs run, else 503 `unhealthy: <reason>`. Plain text, `no-store`. The agent
listener serves it too.

## Notifications

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /channels` | admin | | 200 |
| `POST /channels` | admin | yes | 201 |
| `PATCH /channels/{id}` | admin | when `url`, `headers` or `token` is set | 200 |
| `DELETE /channels/{id}` | admin | | 204 |
| `POST /channels/{id}/test` | admin | | 200 |
| `POST /channels/test` | admin | | 200 |
| `GET /deliveries` | admin | | 200 |
| `GET /notification-settings` | admin | | 200 |
| `PUT /notification-settings` | admin | | 200 |

Alerts are notified once they have needed attention for 30 seconds
(alerts of a burst arrive in one message); failed sends are retried after
10 seconds and 1 minute. The channel object never contains the URL or
secrets: `target` keeps the scheme and host (and the ntfy topic), webhook
headers are listed by name only.

```json
{"id": "ch_2a7e…", "name": "Phone", "kind": "ntfy", "target": "https://ntfy.sh/rackoon-alerts",
 "min_severity": "warning", "groups": [], "send_resolved": true, "reminder_min": 0, "enabled": true,
 "header_names": [], "has_token": false, "created_by": "john", "created_at": "…",
 "last_delivery": {"id": 42, "channel": "ch_2a7e…", "at": "…", "kind": "opened",
                   "alert_ids": ["al_5c1e9a2b7f30"], "summary": "basalt: /srv 91% full",
                   "ok": true, "error": "", "attempt": 1}}
```

`format` is present for webhooks. `last_delivery` is filled by
`GET /channels` only (`null` in POST and PATCH responses).

**`POST /channels`** and **`PATCH /channels/{id}`** (every field optional in
PATCH):

| Field | Type | Notes |
|---|---|---|
| `name` | string | required, ≤64 characters |
| `kind` | string | `ntfy`, `webhook` or `shoutrrr` |
| `url` | string | ntfy: `http(s)://server/<topic>`; webhook: `http(s)://host/…`; shoutrrr: a Shoutrrr service URL (`discord://…`, `smtp://…`) |
| `min_severity` | string | `warning` (default) or `critical` |
| `groups` | []string | server groups to notify about; empty = all |
| `send_resolved` | bool | default true |
| `reminder_min` | int | repeat while open: 0 (off, default) to 10080 |
| `enabled` | bool | default true |
| `format` | string | webhook: `rackoon` (default) or `alertmanager` |
| `headers` | object | webhook: extra request headers; replaces all when given |
| `token` | string | ntfy access token; `""` clears |

Errors: 400 `invalid_name`, `invalid_kind`, `invalid_url`,
`invalid_severity`, `invalid_reminder`, `invalid_format`; 404 `not_found`
(PATCH, DELETE); 403 `reauth_required`.

**Tests.** `POST /channels/{id}/test` (no body) sends a test message to a
saved channel and logs it in the deliveries. `POST /channels/test` takes a
channel body (as POST, `name` defaults to `Test`) and sends without saving
or logging. Both wait up to 20 seconds and answer 200
`{"ok": false, "error": "…"}` whether or not the send worked. Errors: 404
`not_found`, and the field errors above.

**`GET /deliveries?channel=&limit=`**: send attempts, newest first; `limit`
is 1 to 500 (other values give 100). `kind` is `opened`, `resolved`, `reminder`,
`test` or `heartbeat` (the hub heartbeat logs failures and the first
success after them under channel `heartbeat`).

**`GET /notification-settings`**: the hub heartbeat, a URL the hub GETs
regularly so an outside monitor notices when the hub stops. The URL is
write-only, like channel URLs (it usually holds a secret): the answer only
says whether one is set and its scheme and host.

```json
{"heartbeat_set": true, "heartbeat_target": "https://hc-ping.com/…", "heartbeat_minutes": 5,
 "heartbeat_last": "…", "heartbeat_failing": false}
```

**`PUT /notification-settings`** `{"heartbeat_url": string,
"heartbeat_minutes": int}`: without `heartbeat_url` the saved URL is kept,
`""` turns the heartbeat off; minutes 1 to 60 (0 = 5). Response as GET.
Errors: 400 `invalid_url`, 400 `invalid_interval`.

**Outgoing webhook body** (format `rackoon`):

```json
{"version": 1, "source": "rackoon", "event": "opened", "status": "firing", "title": "basalt: /srv 91% full",
 "hub": "https://rackoon.example.net", "alerts": [{"id": "al_…", "…": "…", "url": "…", "group": "Lab"}]}
```

`event` is `opened`, `resolved`, `reminder` or `test`; `status` is `firing`
or `resolved`; `alerts[]` are alert objects plus `url` and `group`. Format
`alertmanager` sends the Alertmanager webhook document (version 4).

## Console and actions

| Route | Role | Reauth | Success |
|---|---|---|---|
| `POST /servers/{id}/guests/{guestId}/console-sessions` | viewer, operator checked inside | | 201 |
| `POST /servers/{id}/console-sessions` | viewer, operator inside (shell, vnc: admin) | protocol `shell`, `vnc` | 201 |
| `GET /console/{sid}` | viewer, operator inside | | 101, WebSocket |
| `GET /console-sessions` | admin | | 200 |
| `DELETE /console-sessions/{sid}` | viewer (own sessions; admins any) | | 204 |
| `POST /servers/{id}/guests/{guestId}/actions` | viewer, operator checked inside | | 202 |
| `GET /servers/{id}/guests/{guestId}/thumbnail` | viewer, operator checked inside | | 200, `image/jpeg` |
| `GET /servers/{id}/guests/{guestId}/screenshot` | viewer, operator checked inside | | 200, `image/png` |

**Permission checks**, in this order, for consoles, actions, thumbnails,
screenshots and inspect views:

| Status | Code | When |
|---|---|---|
| 403 | `insufficient_role` | below operator (below admin for host shell and host power) |
| 404 | `server_not_found` | |
| 403 | `console_disabled`, `power_disabled`, `host_shell_disabled`, `host_power_disabled` | the hub's switch or the agent's flag is off (`detail` says which) |
| 409 | `agent_offline` | |
| 404 | `guest_not_found` | |

Refusals are audited. 20 refusals for `insufficient_role`,
`console_disabled` or `power_disabled` in 10 minutes open the hub alert
`security.denied_requests`; at 30 the user's console, action and
screenshot requests get 429 `rate_limited` (thumbnail refusals do not
count).

**HTTPS.** Console sessions, the WebSocket, thumbnails and screenshots are
refused with 403 `insecure_transport` unless the request came over TLS,
through a trusted proxy with `X-Forwarded-Proto: https`, the public URL is
https, the host is localhost, or the hub runs with `--insecure-consoles`.

**`POST /servers/{id}/guests/{guestId}/console-sessions`**, optional body
`{"protocol": string, "switch_from": string}`. `protocol` is one of the
guest's `console.protocols` (`vnc`, `spice`, `serial`, `shell`, `tty`,
`logs`); the default is the guest's default. `switch_from` names one of the
caller's sessions: it is closed with reason `switched` and does not count
toward the limits.

```json
{"session_id": "cs_8e1d…", "url": "/api/v1/console/cs_8e1d…", "token": "…", "protocol": "spice",
 "expires_at": "…", "idle_timeout_s": 900, "requires_confirmation": false}
```

The token works once, for 30 seconds, for the same user and browser
session. Consoles need a browser session: API tokens and kiosk links get
403 `browser_only`. Errors: the permission checks, 403 `insecure_transport`, 409
`console_unavailable` (no protocols), 409 `protocol_unavailable` (`detail`
gives the reason when known), 409 `guest_not_running` (except `logs`), 429
`session_limit`, 429 `rate_limited`, 503 `audit_unavailable`.

**`POST /servers/{id}/console-sessions`**: a console on the host itself.
Protocol `logs` streams the systemd journal and needs the console
permission; `shell` is a root shell and needs admin, the host-shell switch
in the hub and the agent (`host_shell`) and reauth. A Mac's host also
offers `vnc`, its screen through Screen Sharing signed in as the screen
account, when Screen Sharing answers and the account is set; it needs what
`shell` needs and is then the default (else `logs`). Body, response and
errors as above, plus 403 `reauth_required`.

**`GET /console/{sid}`** (WebSocket):

- Offer the subprotocols `rackoon.console.v1` and `rackoon.token.<token>`
  (`new WebSocket(url, ["rackoon.console.v1", "rackoon.token." + token])`);
  the hub answers with `rackoon.console.v1`. Send an allowed `Origin` and
  the cookie of the session that created the console.
- Refusals before the upgrade are problem+json: 403 `insecure_transport`,
  403 `bad_origin`, 400 `subprotocol`, 403 `invalid_token` (wrong token,
  other user or session), 403 `token_used`, 403 `token_expired`, and the
  permission checks (repeated at upgrade).
- Every message is binary: `kind (1 byte) | channel (uint16, big endian) |
  payload`, at most 1 MiB of payload. Kind 0 is data for the channel
  (terminal, RFB or SPICE bytes; channel 0 is open from the start), kind 1
  is control (a JSON object).

| Direction | Control messages |
|---|---|
| browser → agent | `{"type":"resize","cols","rows"}` (1 to 1000), `{"type":"open","channel"}`, `{"type":"close","channel"}`, `{"type":"ping","id"}` |
| browser → hub | `{"type":"activity"}`: resets the idle timer (data frames do not) |
| agent → browser | `status`, `opened`, `closed` `{"channel"}`, `pong` `{"id"}`, `error` `{"code","message"}` |
| hub → browser | `{"type":"status","state":"connected","protocol","resolution"}` after opening; `{"type":"error","code","message"}` then close when the agent cannot open it (`agent_error`, `session_limit`, `audit_unavailable` or the agent's code); `{"type":"closed","reason"}` before the hub closes |

Close reasons: `idle_timeout` (15 minutes without `activity`), `max_age` (8
hours), `revoked` (signed out, password changed, role lowered, server
deleted, ended with `DELETE /console-sessions/{sid}`), `remote_control_disabled`,
`agent_disconnected`, `guest_stopped`, `switched`, `ended` (the agent ended
the stream, e.g. the shell exited). The hub re-checks live sessions every 2
seconds. Bandwidth is capped at 4 MiB/s to the agent and 32 MiB/s to the
browser.

**`GET /console-sessions?server=`**: live sessions.

```json
[{"session_id": "cs_8e1d…", "server": "basalt", "guest": "incus:nixbuild", "protocol": "spice",
  "user": "john", "client_ip": "100.64.0.5", "opened_at": "…", "bytes_in": 5120, "bytes_out": 8388608}]
```

**`DELETE /console-sessions/{sid}`** ends a session (reason `revoked`) or
cancels an unused token. Error: 404 `not_found` (also for others'
sessions, unless admin).

**`POST /servers/{id}/guests/{guestId}/actions`**:

| Field | Type | Notes |
|---|---|---|
| `action` | string | see below |
| `confirm` | bool | must be true for destructive actions |
| `snapshot` | string | snapshot actions: 1 to 40 of letters, digits, `.`, `_`, `-` (not first); create defaults to `whombat-YYYYMMDD-HHMMSS` |
| `description` | string | `snapshot_create`, ≤200 characters |
| `memory` | bool | `snapshot_create`: include the VM's memory |

| Guest | Actions |
|---|---|
| VMs | `start`, `shutdown`, `reboot`, `force_stop`, `ctrl_alt_del`, `pause`, `resume`, `snapshot_create`, `snapshot_restore`, `snapshot_delete` |
| Containers | `start`, `restart`, `stop`, `pause`, `resume`, and the snapshot actions (not Docker) |

Destructive (need `"confirm": true`): `force_stop`, `stop`, `reboot`,
`shutdown`, `restart`, `snapshot_restore`, `snapshot_delete`. Actions need
the power permission, `ctrl_alt_del` the console permission. Response:
202 `{"action_id": "act_…", "audit_id": "au_…"}`; the result arrives as the
`action.finished` event. One action per guest runs at a time. Errors: 400
`use_screenshot_endpoint` (action `screenshot`), 400 `invalid_action`, 400
`invalid_snapshot`, 400 `confirm_required`, the permission checks, 429
`rate_limited`, 409 `action_in_progress`, 503 `shutting_down`, 503
`audit_unavailable`.

**`GET …/thumbnail`**: a JPEG at most 320 pixels wide (`no-store`), VMs
and a Mac's host (`guestId` `host:host`; it needs the host shell switches
instead of console, operators may look). Captures are shared per guest and cached for 2 seconds. The first
thumbnail per user and server in 10 minutes is audited as
`screens.viewed`. Errors: 403 `insecure_transport`, the permission checks
(console), 404 `no_screen` (containers, or no screen), 409
`guest_not_running`, 429 `rate_limited`, 503 `busy` (a SPICE client holds
the screen), 502 `agent_error`, 503 `cancelled`.

**`GET …/screenshot`**: a full-size PNG, `Content-Disposition: attachment`,
audited as `console.screenshot`. Errors: as for thumbnails (without
`cancelled`), plus 503 `audit_unavailable`.

## Inspect, snapshots and host actions

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /servers/{id}/inspect/{kind}` | viewer, operator and console permission inside (`updates`: diagnose or console) | | 200 |
| `GET /servers/{id}/guests/{guestId}/snapshots` | viewer, operator and power or manage permission inside | | 200 |
| `POST /servers/{id}/actions` | viewer, admin and host power inside | yes | 202 |

**`GET /servers/{id}/inspect/{kind}`**: a view of the host asked from the
agent now (not stored). `kind` is `processes`, `ports`, `services` or
`updates`. The view is audited as `inspect.viewed` once per user, server
and view every 10 minutes.

```json
{"kind": "processes", "as_of": "…", "truncated": false,
 "items": [{"PID": 1, "PPID": 0, "User": "root", "Name": "systemd", "Command": "/sbin/init", "CPUPct": 0.1,
            "RSSBytes": 12582912, "State": "S", "Threads": 1, "Container": "", "Started": "…"}]}
```

The item keys are the Go field names of the agent protocol types:

| Kind | Item keys |
|---|---|
| `processes` | `PID`, `PPID`, `User`, `Name`, `Command`, `CPUPct`, `RSSBytes`, `State`, `Threads`, `Container`, `Started` |
| `ports` | `Proto`, `Address`, `Port`, `PID`, `Process` |
| `services` | `Name`, `Description`, `Load`, `Active`, `Sub`, `Enabled`, `Since` |
| `updates` | `Name`, `Current`, `New`, `Security`, `Source` |
| `snapshots` | `Name`, `Created`, `Description`, `Parent`, `WithMemory`, `Current`, `SizeBytes` |

On a Mac the views come from `ps`, `lsof` (listening TCP, bound UDP),
`launchctl list` (`Name` is the job's label; `Active` is `active` while it
runs, `failed` when it isn't running and its last exit wasn't clean,
`Description` says the pid, exit status or signal) and `softwareupdate
--list`, which asks Apple's servers (only this view and a check do; `Name`
is the label `packages.install` takes). Snapshots are `unsupported`.

Errors: 404 `unknown_view`, the permission checks (console), 502
`agent_error`, and the agent's codes: 501 `unsupported` or
`unsupported_action`, 403 `remote_control_disabled`, 404 `unknown_guest`,
others 502. `updates` needs the diagnose switch **or** the console one,
each in the hub and in the agent's `agent.toml` (SWU-11: the list is a
read-only check's answer); otherwise 403 `diagnose_disabled` (the hub's
reason when neither of its switches is on, else the agent's). Agents
older than this check the console switch themselves (403
`remote_control_disabled`).

**`GET /servers/{id}/guests/{guestId}/snapshots`**: the guest's snapshots,
same shape with `"kind": "snapshots"`. It needs the power switch **or**
the manage switch (each in the hub and in the agent's `agent.toml`), not
the console: snapshots are taken and restored under power. Otherwise 403
`power_disabled` ("Listing snapshots needs power actions or managing
guests turned on for this server.", or the agent's version of it). Agents
older than this check the console switch themselves (403
`remote_control_disabled` from the agent). Other errors as for inspect
(404 `guest_not_found` for a malformed or unknown guest id).

**`POST /servers/{id}/actions`**: reboot or shut down the host.
`{"action": "host_reboot" | "host_shutdown", "confirm": true}`. Needs
admin, the host-power switch in the hub and the agent (`host_power`), and
reauth. Response and errors as for guest actions (the `guest` of
`action.finished` is `host:host`), plus 403 `reauth_required`.

## Manage

Guest configuration and lifecycle on Proxmox VE, Incus and libvirt
(`docs/MANAGE.md`): configuration, disks, create, clone, convert to
template and delete, backups and scheduled backup jobs, ISO images and
container templates, the guest firewall, HA, replication and the tasks of
all of it. It is off by
default: it needs the server's Manage switch in the hub
(`remote_control.manage`, `PATCH /servers/{id}`, reauth to turn on) **and**
`[remote_control] manage = true` in the host's `agent.toml`. Manage does
not imply power or console, nor the other way round. Docker guests are
not managed (501 `unsupported`), except a container's update from its
unRAID template and autostart (Docker on unRAID; see "Unraid" below);
libvirt VMs are, see "libvirt" below. The web UI calls these routes
from `web/src/api/manage.ts`; the bodies and answers are the JSON of
`internal/proto/manage.go` (`web/src/api/manage-types.ts`).

All paths are under `/servers/{id}`. `{guestId}` is the hub guest id
(`pve:100`, `incus:web`); a Proxmox template (`pve:9000`) counts as a guest
here. Host routes take `platform` (`pve`, `incus`, `unraid` or `libvirt`,
in the body or the query; default `pve` when the host reports Proxmox VE,
else `unraid` on an unRAID server without Incus, else `libvirt` on a
server whose kind is `libvirt`, else `incus`).

| Route | Op | Role | Reauth | Body / query | Success |
|---|---|---|---|---|---|
| `GET …/guests/{guestId}/config` | `config.get` | operator | | | 200 config |
| `PUT …/guests/{guestId}/config` | `config.set` | operator | | `digest`, `set`, `delete`, `revert`, `confirm` | 200 / 202 |
| `POST …/guests/{guestId}/disks/{disk}/resize` | `disk.resize` | operator | | `size` | 202 |
| `POST …/guests/{guestId}/disks/{disk}/move` | `disk.move` | operator | | `storage`, `delete_source` | 202 |
| `GET …/manage/choices` | `choices` | operator | | `?platform=` | 200 choices |
| `POST …/guests` | `guest.create` | admin | yes | `platform`, `kind`, `new_id`, `name`, `set`, `start`, `image`, `profiles` | 202 |
| `POST …/guests/{guestId}/clone` | `guest.clone` | admin | yes | `new_id`, `name`, `full`, `storage` | 202 |
| `POST …/guests/{guestId}/template` | `guest.template` | admin | yes | `confirm` | 202 |
| `POST …/guests/{guestId}/migrate` | `guest.migrate` | admin | yes | `target`, `storage`, `digest`, `confirm` (required) | 202 |
| `DELETE …/guests/{guestId}` | `guest.delete` | admin | yes | `?confirm_name=&purge=1` | 202 |
| `GET …/guests/{guestId}/backups` | `backup.list` | operator | | | 200 `{items}` |
| `POST …/guests/{guestId}/backups` | `backup.create` | operator | | `storage`, `mode`, `compress`, `notes`, `protected` | 202 |
| `POST …/backups/restore` | `backup.restore` | admin | yes | `platform`, `volume`, `new_id` or `guest`, `storage`, `start`, `unique`, `confirm` | 202 |
| `PATCH …/backups` | `backup.update` | operator | | `platform`, `volume`, `notes`, `protected` | 200 |
| `DELETE …/backups` | `backup.delete` | admin | yes | `?platform=&volume=` | 200 / 202 |
| `GET …/storage/{storage}/content` | `content.list` | operator | | `?platform=&content=` | 200 `{items}` |
| `POST …/storage/{storage}/download` | `content.download` | admin | yes | `platform`, `content`, `url`, `filename`, `checksum`, `checksum_algorithm` | 202 |
| `DELETE …/storage/content` | `content.delete` | admin | yes | `?platform=&volume=` | 200 / 202 |
| `GET …/appliances` | `appliance.list` | operator | | `?platform=` | 200 `{items}` |
| `POST …/storage/{storage}/appliances` | `appliance.download` | admin | yes | `platform`, `template` | 202 |
| `GET …/guests/{guestId}/tasks` | `task.list` | operator | | | 200 `{items}` |
| `GET …/tasks` | `task.list` | operator | | `?platform=` | 200 `{items}` |
| `GET …/tasks/{task}` | `task.status` | operator | | `?platform=&log_start=` | 200 task |
| `DELETE …/tasks/{task}` | `task.stop` | operator | | `?platform=` | 200 |
| `GET …/guests/{guestId}/firewall` | `firewall.get` | operator | | | 200 firewall |
| `PUT …/guests/{guestId}/firewall/options` | `firewall.options` | operator | | `digest`, `set`, `delete` | 200 |
| `POST …/guests/{guestId}/firewall/rules` | `firewall.rule_add` | operator | | `rule` | 200 |
| `PUT …/guests/{guestId}/firewall/rules/{pos}` | `firewall.rule_update` | operator | | `digest`, `rule`, `move_to` | 200 |
| `DELETE …/guests/{guestId}/firewall/rules/{pos}` | `firewall.rule_delete` | operator | | `?digest=` | 200 |
| `PUT …/guests/{guestId}/ha` | `ha.set` | admin | yes | `state`, `max_restart`, `max_relocate`, `comment` | 200 |
| `DELETE …/guests/{guestId}/ha` | `ha.remove` | admin | yes | | 200 |
| `POST …/guests/{guestId}/replication` | `replication.add` | operator | | `target`, `schedule`, `rate`, `comment` | 200 |
| `DELETE …/guests/{guestId}/replication/{job}` | `replication.delete` | operator | | | 200 |
| `GET …/backup-jobs` | `backupjob.list` | operator | | | 200 `{items}` |
| `POST …/backup-jobs` | `backupjob.create` | admin | yes | a backup job (below) | 200 `{ok, id, audit_id}` |
| `PUT …/backup-jobs/{job}` | `backupjob.update` | admin | yes | the fields to change, `digest` | 200 `{ok, changes, audit_id}` |
| `DELETE …/backup-jobs/{job}` | `backupjob.delete` | admin | yes | `?confirm=1` (required) | 200 |
| `POST …/backup-jobs/{job}/run` | `backupjob.run` | operator | | | 202 |
| `GET …/guests/{guestId}/log` | `log.get` | operator | | `?lines=` (Incus) | 200 `{op, file, lines}` |
| `POST …/guests/{guestId}/rename` | `guest.rename` | admin | yes | `name` (Incus) | 200 / 202, `new_id` |
| `POST …/guests/{guestId}/move` | `guest.move` | admin | yes | `pool`, `project`, `confirm` (required) (Incus) | 202, `new_id` |
| `POST …/guests/{guestId}/publish` | `guest.publish` | admin | yes | `alias`, `description`, `snapshot` (Incus) | 202 (fingerprint in `task.finished.new_id`) |
| `GET …/incus/networks/{network}/leases` | `network.leases` | operator | | `?project=` | 200 `{op, items}` |
| `GET …/incus/profiles/{profile}` | `profile.get` | operator | | `?project=` | 200 `{op, profile}` |
| `POST …/incus/profiles` | `profile.create` | admin | yes | `name`, `description`, `copy_from`, `project` | 200 |
| `PUT …/incus/profiles/{profile}` | `profile.update` | admin | yes | `project`, `digest`, `set`, `delete`, `devices`, `description` | 200 `{changes}` |
| `DELETE …/incus/profiles/{profile}` | `profile.delete` | admin | yes | `?project=&confirm=1` (required) | 200 |
| `POST …/incus/pools/{pool}/volumes` | `volume.create` | admin | yes | `name`, `size`, `content_type`, `project`, `description` | 200 |
| `POST …/incus/pools/{pool}/volumes/{volume}/resize` | `volume.resize` | operator | | `size`, `project` | 200 `{changes}` |
| `DELETE …/incus/pools/{pool}/volumes/{volume}` | `volume.delete` | admin | yes | `?project=&confirm=1` (required) | 200 |
| `POST …/incus/images` | `image.download` | admin | yes | `alias`, `type`, `project`, `auto_update` | 202 (fingerprint in `task.finished.new_id`) |
| `POST …/incus/images/{fingerprint}/refresh` | `image.refresh` | operator | | `project` | 202 |
| `DELETE …/incus/images/{fingerprint}` | `image.delete` | admin | yes | `?project=` (`confirm=1` accepted) | 200 / 202 |

**Incus** (`docs/MANAGE.md` 2.5): the shared routes take the Incus
fields — `POST …/guests`: `project`, `pool` (the root disk's), `network`
(eth0's), `cloud_init` (user data, at most 64 KiB); `…/clone`: `name`,
`storage` (a pool), `project` (copy into another project),
`instance_only` (without snapshots); `…/backups`: `name` (default
`whombat-YYYYMMDD-HHMM`), `expires_at` (default 7 days), `instance_only`,
`optimized`, `compression` (`zstd`, `gzip`, `none`; no `storage`); `POST
…/backups/restore`: `platform: incus`, `guest` (whose backup), `volume`
(the backup's name), `name` (the new instance, default `<name>-restored`),
`storage` (a pool), `start` — always a **new** instance, so no `confirm`;
`DELETE …/backups?platform=incus&guest=&volume=`; `GET
…/manage/choices?project=` (adds `projects`, `project`,
`remote_images: [{alias, description, type}]`); `PUT …/config`: `devices`
(`{name: {options} | null}`, null removes; the same allowlist as
`device.<name>` keys) and `profiles` (a non-empty ordered list replaces
the instance's). `backup.list` answers Incus backups with `storage:
"incus"`, `format: optimized|tar`, `expires_at` and `notes: "expires
<time>"`; `task.list` answers `cancellable` for operations Incus can
stop. The `/incus/…` routes and log, rename, move and publish are 501
`unsupported` on a server or guest that is not Incus.

**The self guest** (`docs/MANAGE.md` 1): a change of the guest the hosts
service runs in (`self: true` in guest objects) outside contracts 0.83.0's
allow list — the manage changes `backup.create`, `backup.update`,
`backup.delete`, `guest.clone`, `replication.add`, `replication.delete`,
`task.stop`, a restore as a new guest; the actions `start`, `resume`,
`snapshot_create`, `snapshot_delete`; reads and consoles — answers 409
`self_guest` "That’s this Whombat itself." (audited as denied); the
unRAID guest routes (`…/update`, `…/autostart`) refuse it too.

The router only needs a session (viewer); the handler checks the role,
the switches and reauth itself and audits refusals. `GET` routes read;
every other route is a change. Whether a change answers 200 or 202 is the
platform's call (Proxmox runs most of them as tasks; a configuration
change is done at once unless Proxmox still works on it).

**Checks**, in this order:

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | the body is not a JSON object, or has a field the route does not take (also one another route takes) |
| 400 | `invalid_value` | a value cannot be valid (see below); `field_errors` names the fields |
| 404 | `guest_not_found` | a malformed guest id |
| 403 | `insufficient_role` | below operator; below admin for the admin routes |
| 403 | `reauth_required` | admin routes, without a sign-in or confirmation in the last 10 minutes |
| 429 | `rate_limited` | after 30 refusals in 10 minutes, as for consoles and actions |
| 404 | `server_not_found` | |
| 403 | `manage_disabled` | the hub's switch or the agent's flag is off (`detail` says which) |
| 409 | `agent_offline` | |
| 404 | `guest_not_found` | guest routes, and the `guest` of a restore |
| 501 | `unsupported` | a Docker or libvirt guest (but the Unraid routes below); an Unraid route on a server without unRAID |
| 400 | `confirm_required` | see Confirmations |
| 409 | `action_in_progress` | changes: another change or power action on the guest is still running |
| 503 | `shutting_down`, `audit_unavailable` | changes |

**Values** the hub refuses before asking the agent (the agent checks every
key and value against its own allowlist, `docs/MANAGE.md` 2.4):

| Field | Rule |
|---|---|
| `set`, `delete`, `revert` | keys `[A-Za-z0-9][A-Za-z0-9_.-]*`, at most 128 characters, together at most 300; values valid UTF-8, at most 64 KiB, no control characters but newline and tab; a key is not set and deleted at once. `firewall.options` keys: `enable`, `dhcp`, `ndp`, `radv`, `macfilter`, `ipfilter`, `policy_in`, `policy_out`, `log_level_in`, `log_level_out` |
| `digest` | at most 128 printable characters (from `config.get` / `firewall.get`) |
| `disk` (path), `storage`, `target`, `profiles[]` | `[A-Za-z0-9][A-Za-z0-9_.-]*`, at most 100 characters; `storage` is required for disk moves, backups, content and downloads |
| `size` | `+8G` (grow by) or the new total `40G`; units K, M, G, T or none |
| `kind` | `vm` or `container` (create) |
| `new_id` | 0 (next free) or 100 to 999999999; Proxmox only |
| `name` | up to 63 letters, digits, dots and dashes; Incus create and clone need one |
| `image` | Incus create, required: `images:debian/13`, a local alias or fingerprint (at most 255 characters, no spaces) |
| `volume` | `storage:path`, at most 500 characters; required for restore, backup update and delete, content delete |
| `guest` (restore) | a guest of this server and platform (`pve:100`); not together with `new_id` |
| `mode`, `compress` | `snapshot`, `suspend`, `stop`; `zstd`, `lzo`, `gzip`, `none` |
| `notes` | at most 1024 characters, newlines allowed |
| `content` | `iso`, `vztmpl` or `import` |
| `url` | `http://` or `https://` with a host, without user name or password, at most 2048 characters |
| `filename` | `[A-Za-z0-9._-]`, at most 200, ending in `.iso` / `.img` (iso), `.tar.gz` / `.tar.xz` / `.tar.zst` (vztmpl), `.ova` / `.qcow2` / `.vmdk` / `.raw` / `.img` (import) |
| `checksum`, `checksum_algorithm` | hexadecimal, 32 to 128 digits, with `md5`, `sha1`, `sha224`, `sha256`, `sha384` or `sha512` (both or neither) |
| `template` | an appliance file name from `GET …/appliances` |
| `task` (path) | a Proxmox UPID (`UPID:node:…`), `incus:<operation id>`, `unraid:<16 hex digits>`, `libvirt:<16 hex digits>` or `pkg:<16 hex digits>` (platform `host`, taken when none is given) |
| `pos` (path), `move_to`, `rule.pos` | 0 to 9999 |
| `rule` | required for `rule_add`; `rule_update` takes `rule`, `move_to` or both. `type` `in`, `out` or `group`; `action` `ACCEPT`, `DROP`, `REJECT` or a security group; `macro`, `proto`, `source`, `dest`, `sport`, `dport`, `iface`, `log`, `comment` one line each |
| `state`, `max_restart`, `max_relocate` | HA: `started`, `stopped`, `ignored`, `disabled`; 0 to 10 |
| `schedule`, `rate`, `comment` | replication: a Proxmox schedule (`*/15`), MB/s (`50`), one line |
| `job` (path) | replication: `<vmid>-<n>`; backup jobs: 1 to 100 of letters, digits, `_`, `-` (`backup-dc316015-ac2c`) |
| `project`, `pool`, `network`, `profile` (path), `copy_from` | Incus names: `[A-Za-z0-9][A-Za-z0-9_.-]*` (projects, pools, networks at most 100, profiles at most 128) |
| `volume` (Incus) | a backup or custom volume name, `[A-Za-z0-9][A-Za-z0-9._-]*`, at most 128 |
| `name` (Incus) | rename: `^[A-Za-z][A-Za-z0-9-]{0,62}$`, not ending in `-`; profiles, volumes, backups: `[A-Za-z0-9][A-Za-z0-9._-]*`, at most 128 |
| `size` (volumes) | a number with a unit (`10GiB`, `512MiB`, `+2G` to grow) |
| `content_type`, `compression`, `type` | `filesystem` or `block`; `zstd`, `gzip` or `none`; `container` or `virtual-machine` |
| `alias` | an image of `images:` (`debian/13`, `images:` optional), at most 200 |
| `fingerprint` (path) | 12 to 64 hexadecimal digits |
| `cloud_init`, `description` | text of at most 64 KiB, newlines allowed (`cloud_init` is audited as "set", never its text) |
| `devices` | at most 64 devices of at most 32 `key=value` options, one line each |
| `lines` (query) | 1 to 2000 |
| backup job fields | see "Backup jobs" below |
| `purge`, `log_start` (query) | `1` / `0`; a line number, `-1` for no log (default 0) |

**Confirmations** (400 `confirm_required` otherwise): `"confirm": true` for
a configuration change that deletes an `unusedN` disk (it destroys the
volume), for converting to a template, and for restoring over an existing
guest; `confirm_name` equal to the guest's name (its id when it has none)
for deleting it; `?confirm=1` for deleting a backup job; Incus:
`"confirm": true` for moving a guest, `?confirm=1` for deleting a profile
or a volume.

**Answers.** Reads answer the JSON of the agent's part: `config.get` the
configuration, `choices` the choices, `task.status` the task (with its log
from `log_start` on, at most 500 lines, and `log_next`), `firewall.get` the
firewall, the lists `{"items": [...]}`.

```json
{"platform": "pve", "kind": "vm", "digest": "4f1c…", "running": true,
 "values": {"memory": "8192", "cores": "4", "scsi0": "local-zfs:vm-104-disk-0,iothread=1,size=64G", "cipassword": "**********"},
 "pending": {"memory": "12288"}, "restricted": ["smbios1", "vmgenid"],
 "disks": [{"key": "scsi0", "storage": "local-zfs", "volume": "local-zfs:vm-104-disk-0", "size_bytes": 68719476736, "media": "disk", "boot": true}]}
```

A change that is done answers 200 with what changed (configuration
changes: `pending` when the value applies at the next restart); one the
platform still works on answers 202 with its task. `new_id` is the hub
guest id of a created, cloned or restored guest. `audit_id` is the
`manage.requested` record.

```json
{"ok": true, "changes": [{"key": "cores", "old": "4", "new": "6", "pending": true}], "audit_id": "au_…"}
{"ok": true, "task": {"id": "UPID:shale:0003A1B2:00C0FFEE:6710A000:qmclone:9000:whombat-manage@pve!agent-shale:"}, "new_id": "pve:123", "audit_id": "au_…"}
```

The hub follows every 202 task (`task.status` every 2 s, every 10 s while
the agent is offline, for up to 24 hours), then writes `manage.finished`
and sends the event `task.finished`
`{"server", "guest", "task", "op", "result": "ok"|"warning"|"error", "message"}`
(`guest`: the guest id, the new guest's for create and restore, `null` for
host operations; `new_id` when the task said at its end what it made: an
image fingerprint for `guest.publish` and `image.download`; `code` when it
ended with one: `task_failed`, `not_found` when the agent no longer knows
it, `timeout` after 24 hours, and a package task's own `busy` or
`timeout`). It does not follow tasks of a previous hub run.

**Agent refusals** keep the agent's code; the problem has `field_errors`
(field or configuration key → message) when the agent or Proxmox named
the fields:

| Status | Codes |
|---|---|
| 400 | `invalid_value`, `invalid_request` |
| 403 | `not_allowed` (outside Whombat's allowlist: change it in the platform's own UI), `remote_control_disabled` |
| 404 | `unknown_guest`, `not_found` (task, volume, storage, rule, job) |
| 409 | `digest_mismatch` (changed meanwhile: load and review again), `locked`, `guest_running`, `guest_not_running`, `protected`, `exists`, `busy`, `in_use` (a profile or volume something uses), `self_guest` (the hub's own refusal) |
| 501 | `unsupported`, `unsupported_action` |
| 502 | `platform_error` (the platform's message), any other code, `agent_error` (the agent did not answer) |
| 503 | `inventory_unavailable` |
| 504 | `timeout` |

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{"code":"invalid_value","detail":"Parameter verification failed.","field_errors":{"memory":"value must be a positive integer"},"status":400,"title":"Bad Request","type":"https://rackoon.dev/problems/invalid_value"}
```

**Backup jobs** (Proxmox VE only; 501 `unsupported` on other hosts) are
Proxmox's cluster-wide backup schedules. A job as answered:

```jsonc
{"id": "backup-dc316015-ac2c", "enabled": true, "schedule": "04:00", "storage": "PBS-BlackBox",
 "node": null,                         // "pve-01": runs on that node only
 "selection": "all",                   // all | guests | pool
 "guests": [],                         // selection guests: hub guest ids ("pve:101")
 "exclude": ["pve:100", "pve:101"],    // selection all: the guests left out
 "pool": null,                         // selection pool: the pool
 "mode": "snapshot",                   // snapshot | suspend | stop
 "compress": "zstd",                   // zstd | lzo | gzip | "0" (none) | null (Proxmox's default)
 "keep": {"last": 7, "hourly": 0, "daily": 14, "weekly": 8, "monthly": 6, "yearly": 0},  // null: the storage's own retention
 "notes_template": "{{guestname}}", "comment": null,
 "next_run": "2026-10-18T02:00:00Z",   // null when paused or not computable
 "digest": "9f2c…"}                    // SHA-256 of the job as stored
```

`keep` with every count 0 keeps every backup (Proxmox's `keep-all`).
`POST …/backup-jobs` takes the same fields without `id`, `next_run` and
`digest`: `schedule`, `storage` and `selection` are required, `guests`
with selection guests, `pool` with selection pool; `enabled` defaults to
true, `mode` to snapshot, `compress` to zstd (none set on a Proxmox Backup
Server, which compresses itself). `PUT …/backup-jobs/{job}` takes only
the fields to change and the `digest` from the list; `null`, `""` or
`[]` removes `node`, `compress`, `keep`, `notes_template`, `comment` or
`exclude` (other fields cannot be removed). Changing `selection` needs the
new selection's `guests` or `pool`; Proxmox drops the old one's.

| Field | Rule (hub; the agent checks the rest against the node) |
|---|---|
| `schedule` | 1 to 128 of letters, digits, space and `: , . * / ~ -`; Proxmox validates the calendar event (400 `invalid_value` on `schedule`) |
| `storage` | an active storage of this server offering `backup` |
| `node` | a node of the server's cluster |
| `guests`, `exclude` | at most 1000 hub guest ids `pve:<vmid>`; new ids must be guests of the cluster (ids a job already has may belong to deleted guests) |
| `pool` | an existing pool (`[A-Za-z0-9_][A-Za-z0-9_/-]*`) |
| `mode`, `compress` | as above |
| `keep` | `last`, `hourly`, `daily`, `weekly`, `monthly`, `yearly`, each 0 to 10000 |
| `notes_template`, `comment` | one line, at most 1024 characters (Proxmox allows 512 for `comment`) |
| `digest` | update: the job's `digest`; a job changed meanwhile answers 409 `digest_mismatch` |

The update answers what changed, by field (`guests` and `exclude` as
vmids, `keep` as "last 7, daily 14"):
`{"ok": true, "changes": [{"key": "enabled", "old": "true", "new": "false"}], "audit_id": "au_…"}`.
`POST …/run` backs the job's guests up on this server now, like Back up
now, and answers 202 with the vzdump task. A job with its own `keep` runs
without pruning (pruning through the API needs a right that would let the
agent's token change storages); its next scheduled run prunes. A job for
another node, or of guests none of which are on this server, is 501
`unsupported` (run it from that server); one without a storage is 403
`not_allowed`. Proxmox's errors map as for the other routes (`exists`,
`not_found` for an unknown job, `locked`, `invalid_value` with the field).

**Unraid** (`docs/MANAGE.md` 2.6). The array, parity, disks, mover,
plugins and notifications of an unRAID server, and two guest routes for
Docker and libvirt guests. Every command runs as an agent task (202 with
`task.id` `unraid:<16 hex>`, followed like the others; `task.finished`
carries the agent's outcome as `message`: “No errors.”, “3 errors
found.”, “The array is started.”, “plex is up to date.”); archiving
notifications and autostart answer 200. All bodies may also carry
`"platform": "unraid"` (guest routes: or the guest's own platform); other
values are 400 `invalid_value`. 501 `unsupported` on a server without
unRAID (`detail_view` is not `unraid`).

| Route | Op | Role | Reauth | Body | Success |
|---|---|---|---|---|---|
| `POST …/unraid/array/start` | `array.start` | admin | yes | | 202 |
| `POST …/unraid/array/stop` | `array.stop` | admin | yes | `confirm` (required) | 202 |
| `POST …/unraid/parity/start` | `parity.start` | operator | | `correct` (default false) | 202, ends when the check does |
| `POST …/unraid/parity/pause` · `/resume` · `/cancel` | `parity.pause` · `parity.resume` · `parity.cancel` | operator | | cancel: `confirm` (optional) | 202 |
| `POST …/unraid/disks/{disk}/spin-up` · `/spin-down` | `disk.spin_up` · `disk.spin_down` | operator | | | 202 |
| `POST …/unraid/mover` | `mover.start` | operator | | | 202 |
| `POST …/unraid/plugins/check` | `plugin.check` | operator | | | 202 |
| `POST …/unraid/plugins/{plugin}/update` | `plugin.update` | admin | yes | `confirm` (required) | 202 |
| `POST …/unraid/notifications/archive` | `notification.archive` | operator | | `id` (omitted: every unread one) | 200 |
| `POST …/unraid/containers/check` | `containers.check` | operator | | | 202 |
| `POST …/guests/{guestId}/update` | `container.update` | admin | yes | `confirm` (required) | 202; Docker guests on unRAID |
| `PUT …/guests/{guestId}/autostart` | `guest.autostart` | operator | | `on` (required) | 200 `{ok, changes: [{key: "autostart", old, new}]}`; Docker on unRAID, libvirt |
| `GET …/tasks?platform=unraid` | `task.list` | operator | | | 200 `{items}` (the agent's unRAID tasks of the last day) |
| `GET …/guests/docker:{name}/tasks` | `task.list` | operator | | | 200 `{items}` (the container's updates) |

| Field | Rule (hub; the agent checks the rest against unRAID's state) |
|---|---|
| `disk` (path) | `all`, or `[a-z][a-z0-9_-]*` up to 32 characters: an array or pool disk of the report (`disk1`, `parity`, `cache2`) |
| `plugin` (path) | `all` (every plugin with an update), or a plugin file `[A-Za-z0-9][A-Za-z0-9._+-]*.plg`; never `unRAIDServer.plg` (403 `not_allowed`: unRAID updates in its own page) |
| `id` | a notification id of the report (`[0-9A-Za-z_][0-9A-Za-z_.+@^%-]*`, up to 200) |
| `on`, `correct`, `confirm` | booleans |

Confirmations: `"confirm": true` for stopping the array, updating a
plugin and updating a container (400 `confirm_required`). The agent's
refusals: 409 `busy` (the state does not allow it: “The array is not
started.”, “A parity operation is already running.”, “The mover is
already running.”, “Another plugin check or update is still running.”),
403 `not_allowed` (a start needing a choice on unRAID's page or the
passphrase, a container without a template, `unRAIDServer.plg`), 404
`not_found` (a disk, plugin update, notification or task it does not
know), 400 `invalid_value` (`correct` without a parity disk), 501
`unsupported` (`task.stop` of an unRAID task; a command this unRAID does
not have). An unRAID task:

```json
{"id": "unraid:3f2a9c0d1e4b5a67", "type": "parity.start", "user": "root", "started": "2026-10-17T21:00:02Z",
 "ended": "2026-10-17T23:41:10Z", "status": "ok", "message": "No errors.",
 "log": ["$ /usr/local/sbin/emcmd cmdCheck=Check&optionCorrect=correct", "The parity check is running.", "12.4 % done, 0 errors so far."], "log_next": 3}
```

Audit details add `plugin`, `notification`, `correct` and `on`.

**Operating-system updates** (`docs/MANAGE.md` 2.9; Whombat
SWU-01…SWU-15). Check for and install the updates the server's package
manager has waiting (apt, dnf/yum, zypper, apk, pacman). Both answer 202
with a task `pkg:<16 hex>` the hub follows like the others; one package
task at a time per server. Needs the manage switches like the other
manage routes; audited as `manage.requested` / `manage.finished` (details
add `packages` and `package_count` when named; the task's end adds
`installed`, `kept_back`, `warning`).

| Route | Op | Role | Reauth | Body | Success |
|---|---|---|---|---|---|
| `POST …/packages/check` | `packages.check` | operator | | `{}` | 202 `{ok, task: {id}, audit_id}` |
| `POST …/packages/install` | `packages.install` | admin | yes | `packages` (optional: only these; each `[A-Za-z0-9][A-Za-z0-9+._:@~-]*` up to 128, at most 200; a Mac's labels may also hold spaces, `(`, `)`, `,` and `'`), `confirm` (required) | 202 |
| `GET …/tasks/pkg:{hex}?platform=host&log_start=N` | `task.status` | operator | | | 200, below |
| `DELETE …/tasks/pkg:{hex}?platform=host` | `task.stop` | operator | | | 200 for a check; 403 `not_allowed` for an install |
| `GET …/tasks?platform=host` | `task.list` | operator | | | 200 `{items}` (the package tasks of the last day) |

Refusals: 400 `confirm_required` (install without `confirm: true`), 400
`invalid_value` (`field_errors.packages`), 400 `bad_request` (a field the
route doesn't take, e.g. `packages` on a check); the agent's: 403
`not_allowed` (TrueNAS: “TrueNAS installs its updates itself, on its
Update page.”; pacman with named packages; stopping an install), 501
`unsupported` (no package manager the agent knows, NixOS, Unraid — the
agent's sentence —, or an agent older than this: “unknown operation”,
passed on unchanged), 409 `busy` (a package task already runs). A task
that ran but couldn't do its work ends `error` with `code`: `busy` (another
program held the package lock for two minutes: “Another program is
installing packages on <host> right now. Try again in a few minutes.”) or
`timeout` (a check past 10 minutes, an install past 2 hours). On a Mac a
check runs `softwareupdate --list` and an install `softwareupdate
--install <labels>|--all` (never `--restart`; on Apple silicon with the
Mac's screen account kept on the Mac, `--user <account> --stdinpass` with
the password on stdin); an update that waits for a restart ends with
`packages.warning` “The Mac needs a restart to finish installing.” and the
report's `reboot`. A package task:

```json
{"id": "pkg:3f2a9c0d1e4b5a67", "type": "packages.install", "user": "root", "started": "2026-10-19T21:00:02Z",
 "ended": "2026-10-19T21:03:40Z", "status": "ok", "message": "Installed 23 updates.",
 "log": ["$ apt-get -q -o DPkg::Lock::Timeout=120 update", "Hit:1 http://deb.debian.org/debian trixie InRelease"], "log_next": 2,
 "packages": {"installed": 23, "kept_back": ["zfs-dkms"],
              "warning": "The Proxmox enterprise repository refused (it needs a subscription); the other repositories were used."}}
```

`packages` and `code` appear once the task ended; `cancellable` is true
while a check runs. The server's report (`GET /servers/{id}` → `system`)
has `package_task` while one runs and `package_last` after
(`docs/CONTRACT.md`).

**libvirt (QEMU/KVM)** (`docs/MANAGE.md` 2.8). VMs that libvirt runs, on
every host with libvirt (a `libvirt` server, an unRAID server's VM
Manager too), through the shared routes with `platform` `libvirt`: guest
routes take it from the guest (`libvirt:web`); host routes from
`?platform=libvirt` or the body (default `libvirt` on a server whose kind
is `libvirt`); routes under `/libvirt/` and tasks `libvirt:<16 hex>` are
libvirt's anyway. Libvirt requests have their own value checks (below);
roles, re-authentication, the manage switches, refusals and the audit are
those of the other routes. Long work answers 202 with a task `libvirt:<16
hex>` (types `qmclone`, `vzdump`, `qmrestore`, `download`; `task.finished`
as for the others).

| Route | Op | Role | Reauth | Body / query | Success |
|---|---|---|---|---|---|
| `GET …/guests/libvirt:{vm}/config` · `PUT …/config` | `config.get` · `config.set` | operator | | `digest`, `set`, `delete`, `revert` (keys: MANAGE.md 2.8) | 200; a `name` change answers `new_id` |
| `POST …/guests/libvirt:{vm}/disks/{disk}/resize` | `disk.resize` | operator | | `size` (`+8G` or the new total); `{disk}` = `disk0` or `vda` | 200 `{changes}` |
| `GET …/manage/choices?platform=libvirt` | `choices` | operator | | | 200: `storages` (pools; `folder:domains`, `folder:isos` on unRAID), `bridges`, `networks`, `isos` (`volume` = what `cdrom<N>` and `iso` take: `pool/name` or the ISO folder's path), `cpu_types`, `os_variants` (`{id, label, firmware, tpm}`), `firmware` (`{uefi, secure_boot, tpm}`), `download` |
| `POST …/guests` | `guest.create` | admin | yes | `platform: libvirt`, `kind: vm`, `name`, `os_variant`, `set`, `iso`, `storage`, `disk_gb`, `network` or `bridge`, `start` | 200 `{new_id: "libvirt:<name>"}` |
| `POST …/guests/libvirt:{vm}/clone` | `guest.clone` | admin | yes | `name`, `storage` (stopped VMs) | 202, `new_id` |
| `POST …/guests/libvirt:{vm}/rename` | `guest.rename` | admin | yes | `name` (stopped VMs) | 200 `{new_id}` |
| `DELETE …/guests/libvirt:{vm}` | `guest.delete` | admin | yes | `?confirm_name=` (the VM's name), `purge` (default 1: its disks, NVRAM and TPM state too; `purge=0` keeps them) | 200 |
| `GET …/guests/libvirt:{vm}/backups` · `GET …/libvirt/backups` | `backup.list` | operator | | | 200 `{items}`: `volume` (`yyyymmdd-hhmmss`), `storage: "libvirt"`, `guest` (`libvirt:<vm>`), `kind`, `size_bytes`, `created`, `format: "qcow2"`, `notes`; the second lists every VM's (deleted ones too) |
| `POST …/guests/libvirt:{vm}/backups` | `backup.create` | operator | | `notes`, `compress` (accepted, not applied: qcow2 keeps the used space only) | 202 |
| `POST …/backups/restore` | `backup.restore` | admin | yes | `platform: libvirt`, `guest` (whose backup: `libvirt:<vm>` or the name), `volume`, `name` (default `<vm>-restored`), `storage`, `start` — always a new VM | 202, `new_id` |
| `DELETE …/backups` | `backup.delete` | admin | yes | `?platform=libvirt&guest=&volume=` | 200 |
| `POST …/libvirt/pools/{pool}/volumes` | `volume.create` | admin | yes | `name`, `size` (`10G`), `format` (`qcow2` default, `raw`) | 200 |
| `POST …/libvirt/pools/{pool}/volumes/{volume}/resize` | `volume.resize` | operator | | `size` (grow only) | 200 `{changes}` |
| `DELETE …/libvirt/pools/{pool}/volumes/{volume}` | `volume.delete` | admin | yes | `?confirm=1` (required) | 200 |
| `GET …/storage/{storage}/content?platform=libvirt&content=iso\|images` | `content.list` | operator | | `{storage}` a pool, `folder:isos` or `folder:domains` | 200 `{items}`; `images` add `format`, `used_bytes`, `used_by` (guest ids) |
| `POST …/storage/{storage}/download` | `content.download` | admin | yes | `platform: libvirt`, `url`, `filename` (`….iso`), `checksum`, `checksum_algorithm`; `{storage}` a pool or `folder:isos` | 202 |
| `DELETE …/storage/content?platform=libvirt&volume=` | `content.delete` | admin | yes | an ISO (`pool/name.iso` or the ISO folder's path) | 200 |
| `GET …/libvirt/networks/{network}/leases` | `network.leases` | operator | | | 200 `{op, items: [{hostname, address, hwaddr, type, guest_id}]}` (`guest_id` `libvirt:<vm>` or null) |
| `GET …/guests/libvirt:{vm}/log` | `log.get` | operator | | `?lines=` (1–2000, default 500) | 200 `{op, file, lines}` |
| `GET …/tasks?platform=libvirt` · `GET …/guests/libvirt:{vm}/tasks` · `GET …/tasks/libvirt:{id}` · `DELETE …/tasks/libvirt:{id}` | `task.list` · `task.status` · `task.stop` | operator | | `log_start` | as for the others; `cancellable` while running |
| `PUT …/guests/libvirt:{vm}/autostart` | `guest.autostart` | operator | | `on` | see “Unraid” (libvirt everywhere) |

| Field | Rule (hub; the agent checks the rest against libvirt) |
|---|---|
| `name` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` |
| `storage` | a pool name, or `folder:domains` / `folder:isos` (disks go into a pool or `folder:domains`, ISOs into a pool or `folder:isos`) |
| `iso`, ISO `volume` | `pool/name` or a clean absolute path, up to 1024 characters; ISO deletes end in `.iso` |
| `volume` (backups) | `yyyymmdd-hhmmss` (`-N` for a second one in that second) |
| `os_variant` | `[a-z0-9]{1,64}` (an id of `choices.os_variants`) |
| `disk_gb` | 0–65536 (0: the OS type's default, made only with `storage`) |
| `network`, `bridge` | one of them, names like storages |
| `new_id` | refused (libvirt VMs have names) |

Agent refusals as for the others: 400 `invalid_value` with `field_errors`
(also a preset the host cannot run: `os_variant` “Windows 11 needs UEFI
firmware (OVMF) and a TPM emulator (swtpm) on this server. …”), 403
`not_allowed` (a restricted key or device, cloning a VM with a whole-disk
passthrough, renaming a VM with snapshots, no backups folder), 409
`guest_running` (clone, rename, delete need a stopped VM), `in_use` (a
volume or ISO a VM uses), `exists`, `digest_mismatch`; 404 `not_found`.
501 `unsupported` on a server without libvirt. The guest the Whombat runs
in refuses changes as on the other platforms (409 `self_guest`). Audit details add `os_variant`, `iso`, `network`,
`bridge`, `pool`, `disk_gb` and `guest`.

**Backup places** (`docs/MANAGE.md` 2.10; Whombat's `backup-places.md`
BPL-01…BPL-16). A server with Whombat's agent and Docker keeps
Whombats' backups: per Whombat (`client`) a restic REST server that only
adds (`restic/rest-server`, `--append-only --private-repos`, one user) and
a weekly cleanup (`restic/restic`, `forget --keep-within <n>d --prune`).
Unraid also shares a folder over NFS for another server's backups, which a
Proxmox VE server adds as a storage. All need the manage switches on both
sides like the other manage routes; the place routes are refused on the
server this Whombat runs on or runs in (409 `self`, “That’s this Whombat
itself.”), except taking a place away. Answers are synchronous: the hub
waits up to 5 minutes for the agent (pulling an image can take a while),
and up to 60 minutes for an ensure that moves backups to another location
(the report shows the client in another location than `location`, or in
one it doesn't name). Audited as `manage.requested` / `manage.finished`
with `op`, `client`, `port`, `location`, `keep_within_days`,
`delete_data`, `name`, `clients`, `storage`, `server`, `export`,
`content` (finished adds `port`, `created`, `location`, `moved`); never a
password. One place change per server at a time (409
`action_in_progress`), a move included.

| Route | Op | Role | Body | Success |
|---|---|---|---|---|
| `POST …/backup-place/ensure` | `backup_place.ensure` | operator | `{client, rest_password, port, location}` | 200 `{client, port, addresses, path, created, location, moved, kit}` |
| `PUT …/backup-place/{client}/cleanup` | `backup_place.cleanup` | operator | `{repository_password, keep_within_days, keep_daily_days?, keep_weekly_days?, keep_monthly_months?, limit_bytes?}` | 200 `{set: true}` |
| `DELETE …/backup-place/{client}` | `backup_place.remove` | operator; admin + reauth + `confirm: true` with `delete_data: true` | `{delete_data, confirm}` (or no body) | 200 `{removed: true}` |
| `POST …/backup-place/nfs` | `backup_place.nfs` | operator | `{name, clients}` | 200 `{export, addresses}` |
| `POST …/proxmox/storages` | `storage.add` | operator | `{storage, type, server, export, content}` | 200 `{storage}` |

- **ensure** puts the client's backups in `location`, one of
  `backup_place.locations[].id` (absent: where they are now, and for a
  new client the dedicated share, `whombat-backups` on Unraid, `srv`
  elsewhere). It makes the root if it is missing (Unraid: the share
  `whombat-backups` through emcmd, not exported over SMB or NFS,
  `/mnt/user/whombat-backups`; in another share only its folder
  `whombat`, 0700, the share's own settings left as they are; other Linux
  servers `/srv/whombat-backups`),
  writes the REST server's two users (`<root>/.whombat/<client>.htpasswd`,
  each line kept when it already matches its password): the client and
  the **kit user** `kit` / `whombat-kit`, whose private repository
  `/kit/` (`<root>/.whombat/<client>.kit`) keeps the locked copies of the
  Whombats' backup details; pulls the pinned image when
  it is missing, creates or recreates `whombat-backup-<client>` (restart
  `unless-stopped`, labels `whombat.service=backup-place`,
  `whombat.client`, `whombat.role=server`, `whombat.port`, `whombat.kit`;
  on Unraid a dockerMan template and autostart) only when its settings or
  users changed, makes the cleanup again when the script it runs changed,
  and waits up to a minute until it answers HTTP. An ensure gives a REST
  server from before the kit user the kit user (it is made again once);
  `kit` is true in the answer when the REST server has it. `port` 0 keeps the port it
  has, else the first free from 8747 (no container publishes it and
  nothing listens on it); a given port moves it. `created` is true when
  the container is new. `client` matches `^[a-z0-9][a-z0-9-]{2,62}$`
  and isn't `kit`;
  `rest_password` is 24 to **72** printable ASCII characters (bcrypt reads
  at most 72 bytes). The box's repository is
  `rest:http://<address>:<port>/<client>/`; the kit user's is
  `rest:http://kit:whombat-kit@<address>:<port>/kit/` (made with `POST
  /kit/?create=true`, files stored with `POST /kit/keys/<sha256 of the
  body>`, never replaced or deleted; `docs/decisions/hosts.md` HS-259). **A move** (the client is in
  another location): the app and its cleanup stop, the data folder and
  the client's `.whombat/<client>.*` files are copied to the new root and
  compared (names, kinds, sizes), both containers (and their Unraid
  templates) are made again there with the same port, user line and
  repository password, and the old folder and files are deleted only
  once the app answers there; the box's repository URL, user and
  repository don't change. A failure on the way leaves the old folder
  and puts the containers back on it. `location` is the location the
  backups are in now, `moved` whether they were moved there.
- **cleanup** needs the client's REST server (404 `not_found` otherwise);
  writes `<root>/.whombat/<client>.pass` (0600) and creates or recreates
  `whombat-backup-<client>-cleanup` (no network). `keep_within_days` 0 or
  absent = 90, else 7…3650. Its first run is a week after it first
  started; the next run survives restarts.
- **remove** stops and removes both containers, their templates and
  autostart lines and the htpasswd, pass and status files in every
  location the client has anything in; the backups (`<root>/<client>`)
  and the kit folder (`<root>/.whombat/<client>.kit`) stay unless
  `delete_data`. Removing a client that isn't there is fine.
- **nfs** (Unraid only, 409 `unsupported` `not_unraid` elsewhere):
  `name` is `whombat-…` (`^whombat-[a-z0-9][a-z0-9-]{0,31}$`, not
  `whombat-backups`); `clients` 1…16 IPv4 addresses. Makes the share when
  it is missing (no SMB), exports it over NFS as Private and adds a rule
  `<address>(sec=sys,rw,no_root_squash)` per client that has none; rules
  already there stay. `export` is `/mnt/user/<name>`.
- **storages** (Proxmox VE only, 409 `unsupported` `not_proxmox`
  elsewhere): `storage` a PVE storage id, `type` `nfs`, `server` an IPv4
  address, `export` an absolute path, `content` from `backup`, `iso`,
  `vztmpl`, `snippets`. The same storage again is 200; a name taken by
  another storage is 409 `exists`.

Refusals: 400 `bad_request` (a field the route doesn't take, bad JSON),
**422 `invalid`** with `field_errors` (the hub's checks and the agent's;
`location` when it isn't one of the server's locations),
**409 `unsupported` with `reason`**: `no_docker`, `docker_down`,
`array_stopped`, `nfs_off`, `not_unraid`, `not_proxmox`, or
`agent_too_old` (an agent from before backup places, or one whose report
has no `locations` asked for a `location`); 409 `self`, 404
`not_found`, 409 `exists` (also: the new location already holds other
backups of this Whombat), 409 `busy`, 403 (the manage switches), 504
`timeout`, and **502 `agent_error`** with the agent's one sentence (a pull
that failed, a container that stopped right after it started, Unraid
refusing a share change, too little room for a move, a copy that didn't
match).

**`backup_place`** (`GET /servers/{id}` and every entry of `GET
/servers`; `null` from an agent that doesn't report it):

```json
"backup_place": {
  "supported": true, "reason": "", "platform": "unraid",
  "root": "/mnt/user/whombat-backups",
  "free_bytes": 1900000000000, "total_bytes": 2000000000000,
  "addresses": ["10.100.0.40", "10.100.1.23"], "nfs": true,
  "clients": [{
    "client": "whombat-home-4hxx", "location": "whombat-backups", "port": 8747, "running": true,
    "image": "restic/rest-server@sha256:…", "used_bytes": 123456789, "kit": true,
    "cleanup": {"set": true, "running": true, "keep_within_days": 90, "keep": "", "over_limit": false,
                "last_run_at": "2026-11-03T13:00:00Z", "last_ok": true, "last_error": ""}
  }],
  "locations": [
    {"id": "whombat-backups", "name": "whombat-backups", "free_bytes": 1979120929996, "is_new": false,
     "smb": "", "nfs": false, "primary": "array", "path": "/mnt/user/whombat-backups"},
    {"id": "Media", "name": "Media", "free_bytes": 47718804645478, "is_new": false,
     "smb": "private", "nfs": false, "primary": "data", "path": "/mnt/user/Media/whombat"}
  ]
}
```

`reason` is `""` when supported, else `no_docker`, `docker_down`,
`array_stopped` or `self` (set by the hub). `platform` is `unraid` or
`linux`. `free_bytes` / `total_bytes` are the root's file system (or its
nearest existing parent's), `null` when unknown (Unraid's array stopped).
`addresses`: the server's private IPv4 addresses, the default route's
interface first. `nfs`: Unraid with NFS on. A client's `running` is its
REST server's container; `cleanup.running` the cleanup's container;
`used_bytes` its data folder (measured every half hour, `null` until
then); `cleanup.last_run_at` / `last_ok` are `null` before the first run;
`keep_within_days` is 0 until a cleanup is set. A client's `kit` is true
when its REST server has the kit user and `/kit/`, false when it was set
up before the kit user (an ensure adds it), `null` from an agent that
doesn't know the kit user (Whombat asks for an ensure again once it is
updated). The cleanup also keeps only the newest 10 kit files of each
Whombat in `/kit/keys/`. A client's `location` is
the id of the location its data folder is in (`""`: none listed).
`locations` (empty from an agent that can't move backups): on Unraid the
dedicated share `whombat-backups` first (`is_new` while it doesn't exist:
ensure makes it; then `primary` is where a new share goes, the array or
the first pool, and `free_bytes` that storage's), then every other user
share but `system` (appdata, domains and isos too: Whombat filters), with
the share's `free_bytes` (`null` when unknown), `smb` (`public`,
`secure`, `private`, or `""` when not shared over SMB), `nfs`,
`primary` (`array` or a pool) and `path`, the data root
(`/mnt/user/<share>/whombat`); on other servers exactly one, `{"id":
"srv", "name": "this server", "path": "/srv/whombat-backups", "smb": "",
"nfs": false, "primary": ""}` with the root's space and `is_new` while
the folder doesn't exist.

**Audit.** A change writes `manage.requested` before it is sent (outcome
`denied` when refused) and `manage.finished` with the outcome (`ok` or
`error` with the code; for tasks when the task ends). Details: `op`, the
target fields that apply (`disk`, `size`, `storage`, `new_id`, `name`,
`kind`, `image`, `volume`, `url` without its query string, `filename`,
`content`, `template`, `task`, `target`, `job`, `pos`, `state`, `purge`,
`guest`) and `keys` (the changed keys, never their values; for backup
jobs the fields named, with `storage` and `job`);
`manage.finished` adds `requested_audit_id`, `changes` (`key: old → new;
…`, `(pending)` for values waiting for a restart, at most 2000
characters), `new_id`, `job` (a created backup job), `task`, `result` and
`message` for tasks, `error` for refusals. Secrets (`cipassword`, `password` and every value the agent
masks) never reach the audit log or the hub log. Reads are audited as
`manage.viewed` (`details.view` = the op) once per user, server, guest and
view every 10 minutes; refused reads as `manage.denied`, once per 10
minutes per user, server and code (the UI polls tasks).

## Assistant

AI investigations with Claude Code or Codex (`docs/ASSIST.md`: the
architecture, the tools and the TypeScript shapes of every object).

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /assistant` | admin | | 200 |
| `PUT /assistant/settings` | admin | ✓ | 200 |
| `POST /assistant/providers/{claude\|codex}/install` | admin | ✓ | 202 |
| `DELETE /assistant/providers/{provider}` | admin | ✓ | 200 |
| `POST /assistant/providers/{provider}/login` | admin | ✓ | 200 |
| `DELETE /assistant/providers/{provider}/login` | admin | ✓ | 200 |
| `GET /assistant/investigations?server=&alert=&limit=` | admin | | 200 |
| `POST /assistant/investigations` | admin | | 201 |
| `GET /assistant/investigations/{id}` | admin | | 200 |
| `POST /assistant/investigations/{id}/messages` | admin | | 202 |
| `POST /assistant/investigations/{id}/stop` | admin | | 200 |
| `POST /assistant/investigations/{id}/approvals/{approval}` | admin | | 200 |
| `DELETE /assistant/investigations/{id}` | admin | | 204 |

- **`GET /assistant`**: `{"settings", "runner": {"connected", "sandboxed",
  "error"}, "providers": {"claude": {...}, "codex": {...}}, "running"}`.
  The first call connects to the runner.
- **`PUT /assistant/settings`**: any of `enabled`, `provider` (`claude` |
  `codex`), `access` (`read` | `ask` | `full`), `auto_investigate` (`off` |
  `critical` | `all`), `auto_update`, `claude_model`, `codex_model`,
  `claude_channel` (`stable` | `latest`). Turning the assistant off stops
  the running investigations.
- **Install** answers at once; progress and the outcome arrive as
  `assistant.state` (`busy`, `progress`, `error`).
- **Login**: Claude Code takes `{"token"}` (from `claude setup-token`; an
  `sk-ant-api…` key also works) and answers when a short request proved it;
  Codex takes `{}` and answers with `login` (`verification_url`,
  `user_code`) set; it turns `signed_in` when the user finished.
- **`POST /assistant/investigations`**: `{"server"?, "alert"?, "prompt"?,
  "provider"?}`; an alert implies its server; neither: the whole fleet.
  409 `assistant_disabled`, `provider_not_installed`,
  `provider_signed_out`; 429 `too_many_running` (3); 503
  `runner_unavailable`.
- **`GET /assistant/investigations/{id}`**: `{"investigation", "events"}`.
- **Messages** continue the investigation (resuming the CLI session when it
  ended). **Approvals** (access `ask`): `{"approve", "reply"?}`; 404 when
  it was decided or expired (30 minutes).

## Diagnose and exec

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /servers/{id}/diagnose` | viewer, operator and the diagnose switches inside | | 200 |
| `POST /servers/{id}/diagnose` | viewer, operator and the diagnose switches inside | | 200 |
| `POST /servers/{id}/exec` | viewer, admin and the host shell switches inside | yes | 200 |
| `POST /servers/{id}/screen` | viewer; operator (`status`) or admin (every other step) and the host shell switches inside | every step but `status` | 200 |

The agent's read-only checks, one root command and a Mac's screen, for
Whombat's tools (the assistant used them as its own tools). Bodies, answers,
the screen's limits and errors: `docs/WHOMBAT.md` "Inspect, diagnose, exec".
Audited as `diagnose.ran`, `exec.requested` / `exec.finished`, and
`screen.<op>` for every screen step but `status` (`look`, `ui.apps` and
`ui.list` with the op and the app only, never what they saw).

## Checks

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /checks` | viewer | | 200 |
| `GET /checks/{id}` | viewer | | 200 |
| `POST /checks` | admin | | 201 |
| `PATCH /checks/{id}` | admin | | 200 |
| `DELETE /checks/{id}` | admin | | 204 |
| `GET`, `POST`, `HEAD /ping/{token}` and `/ping/{token}/{what}` (UI and agent listener) | the token | | 200, text |

Probes (`http`, `tcp`, `ping`, `dns`) run from the hub or from an agent;
`heartbeat` checks wait for pings. A probe that fails twice in a row, or an
overdue heartbeat, opens the hub-level alert `check.down` (critical); a
certificate close to expiry opens `check.cert_expiring` (warning). For
checks with an owner starting with `whombat:connection:`, Whombat's
connection handles those alerts.

```json
{"id": "ck_7d3a…", "name": "Website", "kind": "http", "target": "https://example.com", "runner": "hub",
 "interval_s": 60, "timeout_s": 10, "grace_s": 0, "options": {"keyword": "Welcome"}, "enabled": true,
 "status": "up", "stale": false, "since": "…",
 "last": {"at": "…", "ok": true, "latency_ms": 84, "status_code": 200, "cert_not_after": "…"},
 "last_ping": null, "uptime_24h": 100, "latency_24h": [82.1, null], "ping_url": null, "created_by": "john"}
```

`status` is `up`, `down`, `pending` (no result yet, or one failure) or
`disabled`. If the runner's reports or results stop coming, `stale` is
`true` and the check is `pending`. Its last result and timestamp stay
visible, and its alerts keep their state until a fresh result arrives.
The hub corrects result times for the agent's clock skew.
`last` also has `error` and `answer` (DNS) when set.
`uptime_24h` is a percentage and `latency_24h` holds 96 points over 24
hours. `GET /checks` includes both. The other routes answer `null` and
`[]`. `ping_url` is set for heartbeat checks when the caller is an admin.

`GET /checks/{id}?since=&until=` also reports `period_status` for the
retained samples in that period. Both times are RFC 3339. At second
precision the start is exclusive and the end inclusive. The status is
`down` if any sample failed, `up` if all recorded samples succeeded, or
`unseen` if the period contains no samples.

**`POST /checks`** and **`PATCH /checks/{id}`** (every field optional in
PATCH):

| Field | Type | Notes |
|---|---|---|
| `name` | string | required, ≤80 characters |
| `kind` | string | `http`, `tcp`, `ping`, `dns` or `heartbeat` |
| `target` | string | http: URL; tcp: `host:port`; ping: host or IP; dns: a name; heartbeat: ignored |
| `runner` | string | `hub` (default) or a server id (its agent runs the probe); heartbeat: always `hub` |
| `interval_s` | int | probes: 30 to 3600, default 60; heartbeat: expected period, 60 to 2678400 |
| `timeout_s` | int | probes: 1 to 60, default 10 |
| `grace_s` | int | heartbeat: 0 to 604800 |
| `options` | object | replaces all options, see below |
| `enabled` | bool | default true |
| `owner` | string | optional at creation, up to 160 bytes, returned by both GET routes |

`options`: `expect_status` (http, e.g. `"200-299,301"`, default
`200-399`), `keyword` (http: must appear in the body), `tls` (tcp: TLS
handshake), `insecure` (skip certificate verification), `dns_type` (`A`
by default, `AAAA`, `CNAME`, `MX`, `TXT`, or `any` for either an A or AAAA
answer on the chosen runner), `dns_server` (`host[:port]`), `expect` (dns:
substring of an answer), `cert_warn_days` (0 to 365, 0 = 14).
An `any` check uses two of the runner's probe slots.

A probe change resolves alerts for its previous settings and waits for a
new result. Until the first result, freshness counts from the change and
only newer report gaps count. A check-in gets its period plus grace from
when it is set up or resumed, until its first successful ping.
Response: the check. Errors: 400 `invalid_name`, `invalid_option`,
`invalid_interval`, `invalid_grace`, `invalid_runner`, `invalid_owner`, `invalid_check`
(kind, target, interval, timeout or options rejected); 404 `not_found`
(PATCH).

**`DELETE /checks/{id}`** also resolves its alerts. Error: 404 `not_found`.

**`/ping/{token}[/{what}]`**: a cron job or script reports in; the token
(from `ping_url`) is the credential. Methods GET, POST and HEAD (others
405).

| `what` | Meaning |
|---|---|
| none, `success`, `0` | success |
| `start` | the job started (the next ping records its run time as latency) |
| `fail` | failure |
| `1` to `255` | failure with that exit code |

Responses (plain text): 200 `ok`, 200 `paused` (check disabled), 404
`unknown check`, 404 `unknown ping`, 429 `too many pings`.

## Agent updates

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /agents/settings` | admin | | 200 |
| `PATCH /agents/settings` | admin | | 200 |
| `POST /agents/update` | admin | yes (not the service token) | 202 |

The hub keeps every server's agent on its signed build (`--agent-dist` with
`manifest.json`) by itself (HS-140…HS-169, Whombat `agent-updates.md`).

`GET /agents` reports per server whether its agent can be updated to the
build and how its update goes (every field but `available` and `version`
is left out when empty; `auto` and `can_install` are always there):

```json
"update": {"available": true, "version": "0.0.0-20261020120000.d2098f2", "auto": true,
           "state": "waiting", "waiting_for": "packages", "updated_at": "2026-10-19T08:00:00Z", "can_install": false}
```

- `reason_code` (with the English `reason`) says why not: `no_build` (no
  signed build), `not_connected`, `no_key` (installed without the update
  key), `other_key` (another signing key), `up_to_date` (the build's
  version), `turned_off` (`[update] allow = false` on the server),
  `newer_running` (the agent is newer than the build, or the two can't be
  ordered). Checked in this order, so a keyless agent on the build's
  version still says `no_key`.
- `auto`: the automatic round takes this server (the setting is on, the
  agent is older than the build, not failed for this version, not halted);
  a busy one once it is free.
- `state`: `updating` (now: `message` says the step), `failed` (this
  version failed here: `failed_version`, `message`; only Update now tries
  it again), `waiting` (busy: `waiting_for` is `packages` while a package
  task runs, `console` while a console or shell is open on the server,
  `task` while a libvirt or unRAID task the agent runs itself is followed)
  or `halted` (the build didn't come back on a server, so the round stopped:
  see the settings).
- `updated_at`: the last successful update (kept across restarts).
- The build is the manifest's file for the agent's system and
  architecture (`os` of the manifest entry: `darwin` for a Mac, absent for
  Linux); a Mac without its build says `no_build`.
- `can_install`: the agent has no update key (`no_key`, `other_key`), is
  connected, runs as a Linux service (`install` is not `manual` or
  `launchd`), is not newer
  than the build, and the host shell is allowed by both the hub's switch
  and the agent's policy: Update now does the one last install (below).

Versions are ordered by the build time in the appliance's
`0.0.0-<UTC YYYYMMDDHHMMSS>.<rev>`, else by semver; an agent never takes an
older version (`older_version`, docs/AGENT-PROTOCOL.md).

**Whombat Helper** (a Mac's) follows the hub's helper build, the
manifest's `whombat-helper-macos.zip` entry (`"os": "darwin", "arch":
"universal", "version"`), through the same setting and rollout. `GET
/agents`' `helper` (Macs only, else `null`):

```json
"helper": {"available": true, "version": "1.1.0", "installed": "1.0.0", "auto": true,
           "state": "waiting", "waiting_for": "agent", "updated_at": "2026-11-17T08:00:00Z"}
```

`version` is the hub's helper, `installed` the Mac's (absent: none);
`reason_code`, in this order: `no_build` (no helper entry),
`not_connected` (also before the Mac's first `macos` report),
`up_to_date`, `unsupported` (the agent doesn't report `helper_update`: it
can once it is updated), `no_key`, `other_key`, `turned_off`,
`host_shell_off` (the host shell is off on the hub's switch or in the
agent's policy), `newer_running` (newer, or not orderable). `auto`,
`state`, `message`, `failed_version`, `updated_at` as for the agent;
`waiting_for` adds `agent` (the agent's own update is due or running: it
goes first). A helper that didn't answer at the Mac's screen (the agent put
the previous one back) halts the helper's updates
(`helper_halted_version`, audit `agent.helper_update_halted`); another
failure marks only that Mac. Audit `agent.helper_updated`
(`details.version`, `from`, `by`, `message`). The hub sends the helper
after the agent's update in the same round, and waits until the Mac's
report names the new version.

**`GET /agents/settings`** → `{"auto_update": true, "halted_version": null,
"helper_version": "1.1.0", "helper_halted_version": null}`.
`auto_update` is “Keep server agents up to date” (default on; the helper
too); `halted_version` is the build the round stopped for (only while it
is the hub's build); `helper_version` the hub's helper (`null`: none) and
`helper_halted_version` the helper build whose updates stopped.

**`PATCH /agents/settings`** `{"auto_update": false}` → the same object;
audited `agent.settings_changed` (`details.auto_update`) when it changed.
Errors: 400 `bad_request` (another field, not JSON), 400 `invalid_value`
(`field_errors.auto_update`: missing).

**The automatic round** runs `--agent-update-grace` (2 minutes) after the
start, `--agent-update-after-connect` (1 minute) after an agent older than
the build connected, and every `--agent-update-interval` (15 minutes). It
updates one server at a time through the same rollout as Update now (a
manual rollout running makes it wait), skips busy servers (`waiting`) and
servers failed for this version, and never does the last install. A
server whose update failed is marked failed for that version; when the
agent didn't come back on the new version (it rolled back), the build is
halted (`halted_version`, audit `agent.update_halted`) and the round stops.
Audit `agent.updated` has `details.by`: `auto`, or the person.

**`POST /agents/update`**, optional body `{"servers": ["basalt", …]}`
(default: every agent that can take a signed update, and every Mac whose
helper can). The hub updates them one at a time, each server's agent and
then its helper (also a Mac whose agent can take the helper only once
updated), and stops at the first failure; it clears each listed server's
failed marks and the halts first. A named server with `can_install`
gets **the last install**: through the exec path as root (audited
`exec.requested` / `exec.finished` with `details.purpose: agent_install`),
a command that writes `/var/lib/whombat-agent/last-install.sh` and starts
it detached from the exec session (`systemd-run --collect
--unit=whombat-agent-reinstall-<unix time>` under systemd, `setsid`
elsewhere). The script runs `<fetch> https://<agents' address>/install.sh |
sh` (the install command without `--token`, `--control` or sudo, so the
identity and the server's own switches stay), logging to
`/var/lib/whombat-agent/last-install.log`; the hub waits up to 10 minutes
for the agent to come back with the build's version and key. Progress
arrives as `agent.update` events (the helper's as `agent.helper_update`).
Response: 202 `{"servers": ["basalt", "pve-01"], "installing": ["pve-01"],
"version": "…", "helpers": ["studio"], "helper_version": "1.1.0"}`
(`helpers`: the Macs whose helper is sent; `helper_version` `null` when
none). Errors: 403
`reauth_required` (a browser session), 409 `no_build`, 409 `needs_install`
(a named keyless agent the hub can't install: the install command must be
run on the server once; `detail` is the reason), 409 `nothing_to_update`,
409 `update_running`.

## Audit

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /audit` | admin | | 200 |
| `GET /audit/export` | admin | | 200, `text/csv` |

**`GET /audit?limit=&cursor=&server=&event=`**: newest first. `limit` is
1 to 1000 (other values give 100); `cursor` is the previous `next_cursor`;
`event` is an exact event or a prefix ending in `.` (`console.`).

```json
{"items": [{"id": "au_1b2c…", "at": "2026-10-13T14:00:00.123Z", "user": "john", "role": "admin",
            "client_ip": "100.64.0.5", "user_agent": "…", "server": "basalt", "guest": "incus:nixbuild",
            "platform": "incus", "event": "action.requested", "protocol": null, "outcome": "ok",
            "code": null, "duration_s": null, "bytes_in": null, "bytes_out": null,
            "details": {"action": "start", "action_id": "act_…"}}],
 "next_cursor": "1234"}
```

`outcome` is `ok`, `denied` or `error`. Events: `auth.setup`, `auth.login`,
`auth.logout`, `auth.reauth`, `auth.password_changed`,
`auth.passkey_added`, `auth.passkey_removed`, `token.created`,
`token.deleted`, `console.requested`, `console.denied`, `console.opened`,
`console.closed`, `console.switched`, `console.screenshot`,
`action.requested`, `action.finished`, `screens.viewed`, `inspect.viewed`,
`inspect.denied`, `manage.requested`, `manage.finished`, `manage.viewed`,
`manage.denied`, `remote_control.enabled`, `remote_control.disabled`
(`details.capability`: `console`, `power`, `host_shell`, `host_power`,
`manage`, `diagnose`), `assistant.settings_updated`, `assistant.installed`,
`assistant.uninstalled`, `assistant.signed_in`, `assistant.sign_in_started`,
`assistant.signed_out`, `assistant.started`, `assistant.stopped`,
`assistant.deleted`, `assistant.approved`, `assistant.declined`,
`assistant.command` and `assistant.action` (what the AI ran, with
`details.investigation`),
`server.updated`, `server.deleted`, `enrollment.created`,
`enrollment.requested`, `enrollment.approved`, `enrollment.rejected`,
`agent.policy_changed`, `agent.update_started`, `agent.updated`,
`agent.update_halted`, `agent.helper_updated`, `agent.helper_update_halted`,
`agent.settings_changed`,
`agent.certificate_renewed`, `agent.machine_id_mismatch`,
`alert.acknowledged`, `alert.unacknowledged`, `server.watch_changed`,
`maintenance.created`, `maintenance.deleted`, `check.created`, `check.updated`, `check.deleted`,
`notification.channel_created`, `notification.channel_updated`,
`notification.channel_deleted`, `notification.heartbeat_updated`,
`hub.backup_downloaded`, `audit.exported`.

**`GET /audit/export?server=&event=`**: every matching record as CSV
(attachment `rackoon-audit-YYYYMMDD-HHMMSS.csv`) with the columns `id`,
`at`, `user`, `role`, `client_ip`, `user_agent`, `server`, `guest`,
`platform`, `event`, `protocol`, `outcome`, `code`, `duration_s`,
`bytes_in`, `bytes_out`, `details` (`key=value; …`). If the database fails
midway, the last row is an `export.incomplete` marker. The export is
audited.

## Users

Admins manage accounts (Settings › Users in the UI). Changes are refused
for API tokens and kiosk sessions (403 `forbidden`), need a recent sign-in
(403 `reauth_required`) where marked, and are audited (`user.created`,
`user.role_changed`, `user.password_reset`, `user.signed_out`,
`user.deleted`; `user.oidc_linked` at a single sign-on account's first
sign-in). You change your own account on the Account page, not here
(409 `self`).

| Route | Role | Reauth | Success |
|---|---|---|---|
| `GET /users` | admin | | 200 |
| `POST /users` | admin | yes | 201 |
| `PATCH /users/{id}` | admin | yes | 200 |
| `DELETE /users/{id}` | admin | yes | 204 |
| `GET /users/{id}/sessions` | admin | | 200 |
| `DELETE /users/{id}/sessions` | admin | | 204 |
| `DELETE /users/{id}/sessions/{sid}` | admin | | 204 |

**User object** (`GET /users` returns an array of them, oldest first):

```json
{"id": 2, "name": "olive", "role": "operator", "source": "local",
 "created_at": "2026-10-13T21:14:44Z", "last_login_at": "2026-10-13T21:20:02Z",
 "passkeys": 1, "sessions": 2, "has_password": true, "must_change_password": false,
 "oidc_linked": false, "role_managed": false, "self": false}
```

`source` is `local` (password) or `oidc` (single sign-on, no password).
`last_login_at` is the last sign-in (kiosk sessions do not count), `null`
before the first. `sessions` counts live browser sessions, kiosk sessions
included. `must_change_password`: the account has a temporary password.
`oidc_linked`: a single sign-on account that has signed in (an account an
admin created is linked to the provider's subject at its first sign-in).
`role_managed`: the role comes from the provider (`--oidc-role-claim`).
`self`: the caller's own account.

**`POST /users`** `{"name": string, "role": "viewer"|"operator"|"admin",
"source"?: "local"|"oidc"}` (`source` defaults to `local`). A password
account gets a generated **temporary password**, returned once:

```json
{"user": {"id": 5, "name": "dana", "role": "operator", "source": "local", "must_change_password": true, "…": "…"},
 "temporary_password": "901e23-9f6ee7-b6e4ea-42d362"}
```

The user signs in with it and must choose a new password before anything
else (see [Authentication](#browser-sessions)). A single sign-on account
has no password and no `temporary_password`; its `name` must equal the
provider's username claim. Errors: 400 `invalid_username`, 400
`invalid_role`, 400 `invalid_source`, 400 `oidc_disabled` (single sign-on
is not configured), 409 `user_exists`, 403 `reauth_required`.

**`PATCH /users/{id}`** `{"role"?: string, "reset_password"?: bool}` (at
least one). Response `{"user": {…}}`, plus `temporary_password` after a
reset.

- `role`: applies at once to the user's sessions and tokens (a token's
  role is capped by its owner's). The user's event streams end and
  reconnect with the new role; consoles the new role may not hold close.
- `reset_password: true`: a new temporary password, and the user is signed
  out everywhere (sessions, consoles, event streams). Passkeys and API
  tokens stay.

Errors: 404 `user_not_found`, 409 `self`, 400 `invalid_role`, 409
`last_admin` (the only admin cannot be demoted), 409 `role_managed` (the
provider sets this user's role), 409 `no_password` (reset of a single
sign-on account), 403 `reauth_required`.

**`DELETE /users/{id}`**: the account with its sessions, passkeys and API
tokens; its consoles and event streams end at once. The audit log keeps its
records. Errors: 404 `user_not_found`, 409 `self`, 409 `last_admin`, 403
`reauth_required`.

**`GET /users/{id}/sessions`**: live sessions, most recently active first.

```json
[{"id": "3f9a0c1d2e4b5a69", "created_at": "…", "last_seen_at": "…", "expires_at": "…",
  "ip": "100.64.0.7", "user_agent": "Mozilla/5.0 …", "kiosk": false, "current": false}]
```

`id` is the first 8 bytes of the session's hash in hex; `current` marks the
caller's own session. Errors: 404 `user_not_found`.

**`DELETE /users/{id}/sessions`** signs the user out everywhere (your own:
every session but the current one). **`DELETE /users/{id}/sessions/{sid}`**
ends one session. Both close the sessions' consoles and the user's event
streams (other sessions reconnect). Errors: 404 `user_not_found`, 404
`session_not_found`, 409 `current_session` (use `POST /auth/logout`).

## Single sign-on (OIDC)

Off unless `--oidc-issuer` is set (flags in the README). When on,
`GET /auth/state` carries `"oidc": {"name": "Authentik"}` and the login page
shows "Sign in with Authentik". Both routes are browser navigations (not
`fetch`), role `anyone`; they answer with redirects, also for errors.

| Route | Success |
|---|---|
| `GET /auth/oidc/start?next=<path>[&reauth=1]` | 302 to the provider |
| `GET /auth/oidc/callback?code=&state=` | 302 to `next` (a sign-in) or `next?reauth=ok` |

The flow is the authorization code flow with **PKCE** (S256), a random
`state` that is also set in the cookie `rackoon_oidc` (`HttpOnly`,
`SameSite=Lax`, `Path=/api/v1/auth/oidc`, 10 minutes; the callback needs
both to match, and a state works once) and a `nonce` checked in the ID
token. The ID token's signature, issuer, audience (the client ID) and
expiry are verified (go-oidc). The redirect URL is
`<public URL>/api/v1/auth/oidc/callback`; register it at the provider.
`next` must be a path on this site (else `/`). Without `--oidc-issuer`
both routes answer 404 `not_found`.

**Accounts.** The account is found by the provider's subject (`iss` and
`sub`). At the first sign-in, an account an admin created with
`source: "oidc"` is linked when its name equals the username claim
(`--oidc-username-claim`, default `preferred_username`; with `email`,
`email_verified: false` is refused). Password accounts are never linked.
Unknown users are refused unless `--oidc-auto-create` is on (then created
as viewer, or with the mapped role). With `--oidc-role-claim` (e.g.
`groups`) the role follows `--oidc-role-map` at every sign-in (the highest
match; `*` matches everyone; no match refuses the sign-in); a change that
would demote the last admin refuses the sign-in instead.

**Re-authentication** (`reauth=1`, a signed-in single sign-on account):
the provider is asked for a fresh sign-in (`prompt=login`, `max_age=0`);
the ID token's `auth_time` must be at most 5 minutes old and its subject
the session's account. Success marks the session re-authenticated and
returns to `next?reauth=ok`; the change is then made again.

**Failures** return to `/login?oidc_error=<code>` (a re-authentication:
`next?reauth=<code>`) and are audited as `auth.login` (or `auth.reauth`)
with outcome `denied`:

| Code | Meaning |
|---|---|
| `denied` | The provider returned an error (the user cancelled, no access) |
| `expired` | No or a mismatched state cookie, or older than 10 minutes, or used before |
| `unavailable` | The provider's discovery document could not be fetched (retried after 10 s) |
| `failed` | The code exchange failed, or no `id_token` |
| `invalid_token` | The ID token failed verification (signature, issuer, audience, expiry) |
| `invalid_nonce` | The nonce does not match |
| `not_registered` | No account and no auto-create |
| `invalid_username` | Auto-create with a name Rackoon cannot use |
| `username_taken` | Auto-create, but the name belongs to another account |
| `unverified_email` | The username claim is `email` and it is not verified |
| `no_role` | The role claim matches no mapping |
| `last_admin` | The mapped role would demote the last admin |
| `rate_limited` | Too many starts from this address |
| `not_sso` | `reauth=1` without a signed-in single sign-on account |
| `stale`, `wrong_account` | Re-authentication: `auth_time` too old, or another account |

## Prometheus metrics

**`GET /metrics`** (outside `/api/v1`): the latest values in the Prometheus
text format 0.0.4 (`Content-Type: text/plain; version=0.0.4`), gzipped
when accepted. Authentication is an API token only, any role:
`Authorization: Bearer rk_…`; a session cookie is not accepted, and without
a valid token the answer is 401 problem+json with
`WWW-Authenticate: Bearer realm="rackoon"`. Kiosk links are not tokens here.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: rackoon
    scheme: https
    authorization: {credentials_file: /etc/prometheus/rackoon-token}
    static_configs: [{targets: ["rackoon.example.ts.net"]}]
```

Every metric is a gauge. Values come from each server's latest report and
are left out while the server is offline (`rackoon_server_up` is then 0),
so a scrape never presents stale numbers as current. Label values are
escaped (`\\`, `\"`, `\n`).

| Metric | Labels | Value |
|---|---|---|
| `rackoon_hub_info` | `version` | 1 |
| `rackoon_hub_servers` | | enrolled servers |
| `rackoon_hub_agents_connected` | | agents connected now |
| `rackoon_hub_consoles_open` | | console sessions open now |
| `rackoon_server_info` | `server`, `hostname`, `group`, `os`, `agent_version` | 1 |
| `rackoon_server_up` | `server` | 1 online or warning, 0 offline |
| `rackoon_server_last_seen_timestamp_seconds` | `server` | last frame from the agent (unix) |
| `rackoon_server_cpu_usage_percent` | `server` | CPU in use, I/O wait excluded |
| `rackoon_server_memory_usage_percent` | `server` | memory in use |
| `rackoon_server_load1` | `server` | 1-minute load |
| `rackoon_server_swap_usage_percent` | `server` | swap in use (servers with swap) |
| `rackoon_server_temperature_celsius` | `server`, `sensor`, `label` | per sensor group (`cpu_package`, `nvme_hottest`, …) |
| `rackoon_server_temperature_limit_celsius` | `server`, `sensor` | that sensor's limit |
| `rackoon_server_volume_used_percent` | `server`, `volume`, `label` | per filesystem, pool or Proxmox storage (`fs:/srv`, `pool:tank`, `storage:local`) |
| `rackoon_server_volume_used_bytes`, `rackoon_server_volume_size_bytes` | `server`, `volume`, `label` | bytes |
| `rackoon_server_guests` | `server`, `platform` | VMs and containers (`docker`, `incus`, `libvirt`, `pve`) |
| `rackoon_server_guests_running` | `server`, `platform` | running (unhealthy containers included) |
| `rackoon_alerts_open` | `severity` | open alerts, hub-level included (`critical`, `warning`) |
| `rackoon_server_alerts_open` | `server`, `severity` | open alerts of the server |
| `rackoon_check_up` | `check`, `name`, `kind`, `runner` | 1 when the latest result passed (checks with a result) |
| `rackoon_check_latency_seconds` | `check`, `name` | latency of the latest result |
| `rackoon_check_certificate_expiry_timestamp_seconds` | `check`, `name` | TLS certificate expiry (unix) |

```text
rackoon_server_up{server="basalt"} 1
rackoon_server_cpu_usage_percent{server="basalt"} 42.4
rackoon_server_temperature_celsius{server="basalt",sensor="cpu_package",label="CPU package"} 65.7
rackoon_server_volume_used_percent{server="basalt",volume="pool:tank",label="Pool tank"} 64
```
