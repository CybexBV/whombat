# Workstream: connections catalog (many services in Settings → Connections)

John, 2026-10-05: “For Whombat Connections I would like to extend the connections a lot, for example Home Assistant,
Dropbox, Notion, Todoist, Nextcloud, Moneybird, etc. (move GitHub to this section).” Proposal agreed the same day
(“I agree, implement this fully”): a **catalog** instead of one hand-written integration per service, **personal and
shared** connections, sign-in methods that need **no admin app registration** wherever the service allows it, tools that
**reuse the existing MCP proxy machinery**, a **home-network allowance** for services on the LAN, and a **Custom**
connection for the long tail. GitHub has been on the Connections overview since SS-05 (app 0.37.0); it becomes a
regular catalog entry there.

Decided by the implementer (feedback-decide-yourself). Not in the mocks (B-05): the UI follows Settings → Connections
as it is (overview rows and tiles, provider page with header and bordered cards) and the Vault's entry form.

Numbering: CX-01… here; contracts CT-266…; app AP-755…; implementation notes may add CX-D* (decided while building).

## Model

- **Superseded in part by one-person.md OP-S50**: the catalog stands; an entry has no `scopes` or `defaultScope` (contracts 3.0). **CX-01 A catalog in `@whombat/core`** (`domain/connections-catalog.ts`, pure data + helpers, unit-tested). One
  `CatalogEntry` per provider: `id` (slug, e.g. `homeassistant`), `name`, `category`
  (`productivity|files|home|business|developer|infrastructure|custom|accounts`), `description` (one line, the tile),
  `scopes` (`personal`, `shared`, or both) with `defaultScope`, `signIn` (one or more `SignInMethod`s, below),
  `fields` (what the person fills in: URL, username, administration id … with label, placeholder, help, validation),
  `transport` (`mcp` | `rest` | `builtin`), `baseUrl` (template over fields, or fixed), `check` (one cheap read that
  proves the credential works), `tools` (typed tools a server adapter provides, if any), `request` (for `rest`: the
  allowed path prefixes, which methods are reads), `guide` (short notes for agents: what the API is and how to use it,
  ≤ 1 500 characters), `sensitive` (rules that force a tool call to Ask, CX-31), `docsUrl` and `tokenUrl` (deep links
  where the person creates a token). The web, Android and the server all read the same catalog; logos live in the web
  (drawn, never fetched).
- **CX-02 Builtin entries** keep their own pages and code: `github` (burrow GitHub, unchanged, AGH-*), `google`,
  `microsoft` (connectors.md, unchanged), `feedback` (Website feedback). They are catalog entries with
  `transport: 'builtin'` so the overview lists everything from one list.
- **CX-03 Two scopes.** **Superseded by one-person.md OP-S50, OP-S51**: every connection is the burrow's, which is the person's; the agent uses it in the person's turns and never in an outsiders' turn.
  - **Personal** (`scope: 'personal'`): belongs to one Whombat **account** (like Google, CN-04/CN-07: connect once,
    used in every burrow). Only that person's **Assistant** (personal agent) uses it, only in that person's turns
    (PA-05). Approvals go to the owner's DM, the owner is the only approver (as connector writes today).
  - **Shared** (`scope: 'shared'`): belongs to one **burrow**. Set up, changed and removed by people who may manage
    the burrow (owners, `burrow.manage`, people-only). Every agent of the burrow — team agents and each member's
    Assistant — may use it under the catalog keys (CX-20), whoever's turn it is (unlike Vault entries, VT-22: a shared
    connection is the team's, like GitHub). The person who connected it is shown (“Connected by Mara”); if they leave
    the burrow it keeps working (the credential is the burrow's; owners can replace or remove it).
- **CX-04 Not on top of Vault entries.** Vault entries are per person per burrow, and anyone else's turn needs the
  owner's pass (VT-22). A shared connection must not, and a personal one is account-wide. Connections have their own
  rows but reuse the Vault's machinery: the MCP client pool (`vault/pool.ts`, generalised), the destination policy and
  the admins' home-network list (`vault_networks`, VT-12/VT-13), sealing with `KeyCustody`, and the
  scrub/“retrieved data is data” rules.
- **CX-05 Limits.** **Superseded in part by one-person.md OP-S50**: one limit of 50 connections per burrow, any number of the same provider, each with a label and a handle unique in the burrow. 30 shared connections per burrow, 20 personal per account, any number of the same provider
  (two Home Assistants are fine) with a distinct **label** (default: the provider's name, then the host:
  “Home Assistant · home.lan”). Each connection has a short **handle** (`homeassistant`, `homeassistant-2`), unique
  among the connections an agent can see, used by agents to name it.

## Sign-in methods (CX-10…CX-16)

- **CX-10 `token`**: the person pastes an API token / app password (with `fields` such as the URL). Header shape per
  entry: `bearer` (default), `header{name}`, `basic{usernameField}`, `query{name}`. The form links to `tokenUrl`
  (“Create a token in Todoist → Settings → Integrations → Developer”). Secret 1–8 000 characters, write-only,
  sealed with AAD `connection:<id>:secret`; the API never returns it.
- **CX-11 `nextcloud_login`**: Nextcloud Login Flow v2. The person enters the server URL; Whombat `POST`s
  `<url>/index.php/login/v2`, opens the returned login link in a new tab and polls the token endpoint (every 2 s, at
  most 10 min) until Nextcloud returns `server`, `loginName`, `appPassword`; the app password becomes the secret
  (basic auth). Paste of an app password stays available (`token`).
- **CX-12 `ha_oauth`**: Home Assistant's own OAuth (no registration: `client_id` is this Whombat's public URL,
  `redirect_uri` on the same host). Code → access token (30 min) + refresh token. Paste of a long-lived access token
  stays available (`token`) and is the first option (it works when the browser and Whombat see Home Assistant at
  different addresses).
- **CX-13 `mcp_oauth`**: MCP authorization for remote MCP servers (Notion, any Custom MCP server that answers 401 with
  `WWW-Authenticate: Bearer resource_metadata=…`): protected-resource metadata (RFC 9728) → authorization-server
  metadata (RFC 8414 / OIDC discovery) → dynamic client registration (RFC 7591, one registration per authorization
  server per Whombat, kept sealed in `connection_clients`) → authorization code + PKCE S256 + `resource` parameter →
  tokens with refresh. No admin step.
- **CX-14 `app_oauth`**: an OAuth app an admin of this Whombat registers once (Dropbox), guided like Google (CN-03:
  deep links, copy buttons for the redirect URI, test). PKCE always; the client secret is optional where the provider
  allows public clients (Dropbox does). Stored in `connector_apps` (provider = catalog id).
- **Superseded in part by one-person.md OP-S52**: the OAuth plumbing and refresh stand, and `invalid_grant` tells the person once. **CX-15 OAuth plumbing is shared**: `oauth_states` (provider = catalog id, plus `connection_id` for reconnects and
  the pending fields), the callback `GET /api/v1/connections/<provider>/callback`, the return path rules (IN-19), and
  on managed boxes the same return route Google uses. Token refresh is single-flight and conditional like
  `tokens.ts` (IN-22); `invalid_grant` marks the connection `needs_reauth` and tells the owner (personal: their DM;
  shared: the person who connected it, else the owners) once.
- **CX-16 Managed appliances**: secrets travel only as secret ops in the end-to-end session (VT-58):
  `connections.create` and `connections.setSecret` join `SECRET_API_OPS`. Every other connections op is ordinary.

## Data (CX-17…CX-19)

- **Superseded in part by one-person.md OP-S53**: `catalog_connections` (CX-D01) has no `scope` or `account_id`, and its `burrow_id` is required. **CX-17 `connections` grows** (one table for old and new): `scope` (`personal|shared`, existing rows `personal`),
  `burrow_id` (shared only), `account_id` (personal: the owner; shared: who connected it), `catalog_id` (= `provider`
  for new rows), `label`, `handle`, `base_url`, `fields jsonb` (non-secret values), `auth jsonb` (header shape),
  `secret_enc` (token kinds), `refresh_token_enc` becomes nullable, `tool_count`, `transport`. The unique index
  `(account_id, provider)` stays for `google|microsoft` only (partial index). Migration hand-written with
  `compat.json` (`expand`), MD-* rules.
- **CX-18 `connection_tools`**: `connection_id`, `name`, `description`, `input_schema jsonb`, `access`
  (`read|write`, from the catalog, a typed tool's definition, or an MCP tool's `readOnlyHint`; unknown = `write`),
  `tier` (`can|ask|off`; defaults: read → `can`, write → `ask`), `hash` (canonical definition), `is_new`,
  `updated_at`. Refreshed on connect, on “Check again” and at most hourly on use; a tool whose definition changed is
  marked new and keeps its tier only if its access did not widen (read → write resets to `ask`). At most 128 tools per
  connection (the rest ignored with a note).
- **CX-19 `connection_clients`**: dynamic client registrations per authorization server (`issuer`, sealed
  `client_id`/`client_secret`, `redirect_uri`, `registered_at`).

## Keys, approvals, audit (CX-20…CX-25)

- **CX-20 Catalog keys** (group `connections`, “Connected services”): `connections.read` (agentMaxTier `can`, default
  `can`) and `connections.write` (agentMaxTier `can`, default `ask`). Team agents get both by default (GitHub default
  access, 2026-10-04). Personal agents may hold them (they apply to shared connections and to the owner's personal
  ones). The tier of a call is the stricter of the agent's key and the tool's tier; `off` refuses (“{Tool} is turned
  off for {Connection}.”).
- **Superseded in part by one-person.md OP-S51, OP-S62**: Ask makes a `connection_call` approval the person decides in the conversation it was asked in, where the result is posted. **CX-21 Ask** creates an approval of type `connection_call` (connection, tool, hash, arguments sealed for the
  deciders' preview, never in the log). Personal: the owner decides in their DM. Shared: whoever decides key asks in
  the burrow (owners and members with `approvals.decide`). Approved → the call runs once and its result is posted
  where the agent asked (as pack tools, BP-D14). The approval binds the tool hash; a changed tool needs a new one.
- **Superseded in part by one-person.md OP-S50**: every connection change is a signed burrow event; there are no account-level ones. **CX-22 Shared connection changes go through the commit pipeline** as signed burrow events: `connection.added`,
  `connection.changed` (label, URL, tool tiers), `connection.removed`, `connection.needs_reauth`. Personal connection
  changes stay account-level (CN-07, `services.log`).
- **Superseded in part by one-person.md OP-S51**: uses are recorded without arguments or output, naming the tool and the connection, for every connection. **CX-23 Uses** are recorded as `connection.tool_called` / `connection.tool_finished` (connection, tool, tier,
  outcome, ms, output bytes — never arguments or output). A personal connection's events name no content (PA-09).
- **CX-24 Removing** a connection deletes its tools, pending approvals and secret, revokes OAuth tokens best effort,
  and evicts its pooled MCP client.
- **Superseded by one-person.md OP-S50**: the person sees, changes and removes every connection. **CX-25 Only the owner sees a personal connection**; members see shared connections (label, provider, who connected,
  state, tools and tiers) but only managers change them.

## Tools for agents (CX-30…CX-36)

- **CX-30 Two fixed MCP tools, whatever the number of connections** (prompt size, prompt-efficiency): 
  `connection_tools({ connection })` returns the connection's guide and its tools (name, description, input schema,
  access, tier), and `connection_call({ connection, tool, arguments })` calls one. `connection` is the handle.
  Both are listed only when the agent can see at least one active connection. Tool definitions coming from a remote
  server are data, scrubbed like Vault MCP tools.
- **CX-31 Sensitive calls always Ask**, whatever the tiers: the catalog's `sensitive` rules match a tool and its
  arguments. Home Assistant: any call whose arguments name the domains `lock`, `alarm_control_panel`, `cover`,
  `valve`, `siren`, `garage` or an entity id in those domains, and REST `POST /api/services/<those domains>/…`.
  Moneybird: sending invoices, payments, deletes. Every provider: `DELETE` requests.
- **CX-32 `mcp` transport**: the generalised MCP pool (`connections/pool.ts` over the Vault pool's client) keyed by
  connection and credential version, credentials added per request, one retry after a forced refresh on 401, the
  destination policy of CX-40, 30 s per call, 64 KiB output kept. Tools from `tools/list`.
- **CX-33 `rest` transport**: a typed adapter where the catalog defines `tools` (Todoist `tasks_*`, Dropbox and
  Nextcloud `files_*`), and always a `request` tool (`method`, `path`, `query`, `body`, `headers` limited to
  `Accept`/`Content-Type`/provider-specific allowed ones) restricted to the base URL and the entry's path prefixes;
  `GET`/`HEAD` (and the entry's `readPaths`, e.g. WebDAV `PROPFIND`/`REPORT`) are reads, everything else writes.
  Response bodies: JSON/text up to 64 KiB, binary as a note with size and type.
- **CX-34 Neutral typed tools** where services overlap, the same names and shapes on each provider:
  `files_list(path)`, `files_search(query)`, `files_read(path)` (text ≤ 64 KiB; binary → note), `files_write(path,
  content)`, `files_move(from, to)`, `files_delete(path)` (Dropbox, Nextcloud); `tasks_list(filter?)`,
  `tasks_add(content, due?, project?)`, `tasks_update(id, …)`, `tasks_complete(id)`, `projects_list()` (Todoist).
- **Superseded in part by one-person.md OP-S51, OP-S87**: the prompt lists the connections the agent can use, one line each, without saying whose they are. **CX-35 The prompt** lists the connections an agent can use, one line each (“homeassistant — Home Assistant ·
  home.lan (shared). Use connection_tools to see what it can do.”); personal ones say whose they are. Not connected
  or needing reauth: one line saying so and who can fix it. `DispatchContext.connections` carries
  `[{handle, catalogId, name, label, scope, status}]`.
- **CX-36 Where agents run doesn't matter**: calls are made by the server (VT-10), never by the runner or the
  agent's computer; the credential never leaves the server.

## Destinations (CX-40…CX-41)

- **CX-40 Public hosts**: `https` only, every resolved address public, no redirects (outbound.ts). **Home network**:
  a URL that resolves to a private address is allowed only inside a network on the admins' home-network list with
  its port (`vault_networks`, VT-12, one list for the Vault and Connections); `http` allowed there with a warning that
  the token crosses the network unencrypted. Checked when saved and on every call (VT-13).
- **CX-40a The call-time check reads scheme, host and port only** (2026-10-08). A `request` with a query
  (`/v1/servers?per_page=50`) was refused as “address isn’t allowed any more”, because the Vault's address rule refuses
  any `?…` and the call handed it the whole request URL (Dusty on Hetzner Cloud). `connectionPolicy` drops the query and
  fragment before the rule; the request itself still goes out with them.
- **Superseded in part by one-person.md OP-S06**: the form still says how to fix a refused address, and the person gets the **Add this network** button. **CX-41 The form says how to fix a refused address**: a member sees “That address is on your network. Ask an admin
  to add 192.168.1.0/24 port 8123 to the home network list.”; an admin gets an **Add this network** button (adds the
  /24 or /64 and the port, then retries). The list is managed in This Whombat (and still from the Vault).

## Catalog v1 (CX-50…CX-62)

Everything below verified against the providers' current docs when built; where a doc says otherwise, the build
follows the doc and notes it as CX-D*.

- **CX-50 GitHub** (builtin, shared) · **CX-51 Google** · **CX-52 Microsoft 365** (builtin, personal) ·
  **CX-53 Website feedback** (builtin, shared).
- **CX-54 Home Assistant** (`home`, shared default, personal allowed): URL field (`http://homeassistant.local:8123`),
  sign-in long-lived token (bearer) or `ha_oauth`; transport `mcp` at `<url>/api/mcp` (the Model Context Protocol
  Server integration; when it answers 404 the check says “Add the Model Context Protocol Server integration in Home
  Assistant” and the connection still works through `request`); `request` on `/api/` (`GET` reads; `POST
  /api/services/…` writes; CX-31 sensitive rules). Check: `GET /api/`.
- **CX-55 Notion** (`productivity`, personal default, shared allowed): `mcp_oauth` to Notion's hosted MCP server;
  or an internal integration token (`token`, bearer + `Notion-Version` header) with `request` on
  `https://api.notion.com/v1/` (`POST /v1/search` and `POST /v1/databases/*/query` count as reads).
- **CX-56 Todoist** (`productivity`, personal default): API token (bearer); `rest` on the Todoist API with typed
  `tasks_*` tools + `request`. Check: list projects.
- **CX-57 Nextcloud** (`files`, personal default, shared allowed): URL + `nextcloud_login` or app password (basic,
  username field); typed `files_*` over WebDAV (`/remote.php/dav/files/<user>/`) + `request` on the server
  (`PROPFIND`/`REPORT` reads; covers CalDAV/CardDAV and OCS for agents that know them; guide says how). Check:
  `PROPFIND` depth 0 on the user's root.
- **CX-58 Dropbox** (`files`, personal default, shared allowed): `app_oauth` (admin registers a Dropbox app once,
  scoped access, offline tokens); typed `files_*` + `request` on `api.dropboxapi.com`/`content.dropboxapi.com`.
- **CX-59 Moneybird** (`business`, shared default): API token (bearer) + administration (picked after the token is
  checked, from `GET /api/v2/administrations`); `request` on `https://moneybird.com/api/v2/<administration>/`;
  guide with the main resources (contacts, sales invoices, documents, financial mutations); CX-31 rules.
- **CX-60 Token services on `request` + guide** (shared default, personal allowed): **Paperless-ngx** (URL + token,
  header `Authorization: Token …`), **Immich** (URL + API key, header `x-api-key`), **Proxmox VE** (URL + API token,
  header `Authorization: PVEAPIToken=…`; self-signed certificates: home-network only, a pinned certificate
  fingerprint field), **Hetzner Cloud** (token, bearer), **Mollie** (API key, bearer), **GitLab** (URL default
  gitlab.com + token, bearer), **Forgejo / Gitea** (URL + token, `Authorization: token …`).
- **CX-61 Custom MCP server** (`custom`, both scopes): URL; sign-in none / bearer / header / `mcp_oauth` (detected:
  Whombat probes the URL and offers OAuth when the server asks for it).
- **CX-62 Custom API** (`custom`, both scopes): base URL + header shape + token; `request` only; a description field
  becomes the guide (“What should agents know?”).

## Surfaces (CX-70…CX-75)

- **Superseded in part by one-person.md OP-S50**: the overview stands without the “Shared” and “Only you” tags. **CX-70 Overview**: intro line, CONNECTED (personal and shared rows, each with logo, label, detail —
  account/host —, “Shared” or “Only you” tag, state), ADD A CONNECTION as tiles grouped by category with a search
  box; tiles of builtins keep their own state lines (CX-02).
- **Superseded in part by one-person.md OP-S50**: the connect page stands without the scope choice. **CX-71 Connect page** (`?tab=connections&connection=<catalogId>`): header (logo, name, description, docs link),
  scope choice when both are allowed (“Just for me — only your assistant uses it” / “For everyone in {burrow} — all
  agents can use it”; shared only offered to managers), sign-in method choice when there are several, the entry's
  fields, the token field with the deep link, Connect. Errors in a sentence with the fix.
- **CX-72 Connection page** (`&id=<connectionId>`): state and last check (“Check again”), label, who connected,
  TOOLS (each with Allowed / Asks / Off, sensitive ones marked “Always asks”, new ones marked New), Replace token /
  Reconnect, Remove (with confirm).
- **CX-73 The Vault and the home-network list** link to each other; nothing about the Vault changes otherwise.
- **CX-74 Android** shows Connections read-only (overview list + connection detail) and opens the web page to connect. *Reversed 2026-10-19 by PC-01 (`phone-connect.md`): the phone connects.*
- **CX-75 Feature flag** `connections.catalog` (runtime feature); clients without it show today's overview.

## Not now

IMAP/SMTP and CalDAV/CardDAV as mail/calendar for the Assistant's existing tools; Exact Online and bunq (partner
apps and request signing); Slack/Telegram/WhatsApp bridges into channels; giving a connection's credential to an
agent's computer; per-agent allow lists on shared connections (keys and tool tiers cover it).

## Decided while building

- **CX-D01 Catalog connections get their own table** (`catalog_connections`, migration 0074) instead of growing
  `connections` (CX-17 amended). Old binaries list an account's `connections` and parse each row's provider as
  `google|microsoft`; new rows there would break a rollback, and nothing in Google's or Microsoft's code needs to change.
  `connection_tools`, `connection_clients` and `connection_pending` (the OAuth and Nextcloud pending sign-ins, sealed)
  complete it. A dynamic-registration client is kept per issuer.

### Connect side

Implementation notes of the server's connect side (`apps/server/src/connections/{store,views,crypto,errors,http,checks,
oauth,clients,pending,redirect,connect,oauth-connect,nextcloud,admin,commands,notify,lifecycle,refresh,routes}.ts`).

- **CX-D02 Whose a row is.** **Superseded in part by one-person.md OP-S50, OP-S53**: every row is the burrow's (`burrow_id` required) and names the person in `connected_by_id`; deleting a burrow still takes its rows by cascade. A shared row keeps `account_id` null and names its connector in `connected_by_id`, so the
  connector's account going never cascades to the burrow's connection; a personal row's `account_id` is its owner and
  `burrow_id` is null. Deleting a burrow or an account takes their rows, tools and pending sign-ins by cascade (the
  runtime has no other account or burrow deletion path, so no other hook); registered OAuth clients are per issuer and
  stay. A connector who leaves keeps their name on the row (`connectedBy.id` null).
- **CX-D03 Handles avoid what the same agents see.** **Superseded by one-person.md OP-S50**: a handle is unique per burrow. A new shared connection avoids the burrow's shared handles and the
  personal handles of the burrow's people (their Assistants see both); a new personal one avoids the account's personal
  handles and the shared handles of every burrow the account is in. Someone joining a burrow later can still meet a
  shared handle equal to one of their personal ones: the tools side resolves it for agents (CX-D20, `<handle>-mine`).
- **CX-D04 Where OAuth comes back.** Self-hosted: `{PUBLIC_URL}/api/v1/connections/<catalogId>/callback` (a browser
  route with the session cookie, like Google's). Managed: the hosted UI's `{WHOMBAT_APP_URL}/connect/<catalogId>`, which
  hands `code`, `state` and `iss` to `connections.finishOAuth` over the session (as `/connect/google`, AG-14). Home
  Assistant's `client_id` is that origin plus `/`. The same redirect is what an admin pastes into Dropbox
  (`ConnectionsCatalogStatus.entries[].app.redirectUri`). The return path gets `connected=<catalogId>` and
  `connection=<connectionId>` (the contract's), or `connect_error=<ConnectionConnectError>`; IN-19's guard applies.
- **CX-D05 MCP clients.** A Client ID Metadata Document at `/api/v1/connections/oauth/client.json` (public PKCE client,
  every MCP redirect URI) is used when the authorization server advertises `client_id_metadata_document_supported` and
  this Whombat is self-hosted at a public https address whose host resolves only to public addresses (a tailnet- or
  LAN-only Whombat can't be fetched); otherwise one dynamic registration per issuer (`connection_clients`, sealed),
  registering every MCP redirect URI at once and registered again when that list changes; neither: the start refuses
  with a sentence. Metadata without PKCE S256 is refused; `iss` must match, and must be present when the server
  advertises `authorization_response_iss_parameter_supported`. A connection's `client_id` column holds the literal client
  id for Home Assistant and metadata documents (`https://…`), the registration's id (`ccl_…`) for a registration, null
  for an admin's app. The protected-resource metadata's `resource` must share the MCP URL's origin and be a prefix of its
  path; it is sent as `resource` on authorize, code exchange and refresh.
- **CX-D06 Keys for existing agents.** Migration 0075 queues every live agent in `keys_upgrades` again; the startup
  backfill (`backfillAlwaysOnKeys`, core `alwaysOnUpgrade`) adds `connections.read` at can and `connections.write` at ask
  with one signed `keys.upgraded` per agent; the mock world is left alone (RA-DC04).
- **CX-D07 Refusal shapes.** Field errors are `validation_failed` keyed `fields.<id>` (the body's path), `secret` and
  `auth`. `destination_refused` carries `{problem, cidr, port, canAdd}` and the sentence `destinationRefusedText`, or the
  Vault's reason when there is nothing to add. `check_failed` carries the HTTP status when there was one and a sentence in
  our words (“The service refused the token. Check it and try again.”).
- **CX-D08 The check.** Token entries and REST entries without a sign-in run the catalog's `request` or `reach`
  check. An MCP sign-in (`mcp_oauth`) or an MCP connection without a sign-in proves itself with MCP `initialize`
  instead (Notion's REST check doesn't take its MCP token). Socket entries use their socket check. A failed check
  refuses saving (`check_failed`; after OAuth `connect_error=check_failed`). A home-network address over http adds a
  `destination` warning line when a credential crosses it. Home Assistant's missing MCP Server integration is the tools side's sync to report (its
  `ToolSyncResult.checks`), whose lines are recorded after the credential's.
- **CX-D09 “Check again” and state.** **Superseded in part by one-person.md OP-S50**: “Check again” and the states stand; the person makes every change, with no `burrow.manage` gate. A refused credential makes the connection `needs_reauth` (`token_invalid` for a
  token, `revoked` for OAuth); another failure makes it `error`; a pass makes it `active`. Members may check a shared
  connection (CX-25), so a change of state alone is signed by whoever looked (no key: “House works again”, “House isn’t
  answering”); every other shared change needs `burrow.manage`.
- **CX-D10 Needs-reauth nobody caused.** **Superseded in part by one-person.md OP-S50, OP-S52**: a dead grant nobody caused is signed by the person, and the repair message goes to them in their Chat. A dead grant found by a refresh or a removed app is signed by the shared
  connection's connector while they are a member, else its first owner. The repair message goes once per 24 hours
  (`repair_notified_at`): a personal connection's owner in their most recent burrow's Assistant DM; a shared one's
  connector in its burrow, else every owner.
- **CX-D11 Address changes.** A token, Home Assistant or Nextcloud connection's new address or fields are checked with
  the stored credential and bump `credential_version`; an `mcp_oauth` or `app_oauth` connection refuses
  (`not_supported`, “Connect it again to use another address.”): its tokens are bound to the server.
- **CX-D12 An admin's app.** `connector_apps` with provider = the catalog id; a public PKCE client stores an empty
  `client_secret_enc` and `user_type` `external` (both columns are not null; no schema change); the secret is sealed with
  `connector_app:<catalogId>`. A new client id or removing the app marks its connections `needs_reauth` (`app_removed`).
  No catalog app comes from config (`app_in_config` is never raised in v1).
- **CX-D13 Mode.** `ConnectionsCatalogStatus.mode` is always `real`: there are no fake providers (tests run stub servers
  behind virtual home-network addresses), and v1 has no switch to turn the catalog off.
- **CX-D14 The lifecycle hook.** `onConnectionLifecycle(services, listener)` (`connections/lifecycle.ts`) tells the
  tools side after each commit: `removed`, `credential` (new token, reconnect, new address or fields, needs reauth) and
  `tiers`, so pooled clients and cached tools can go.
- **CX-D15 Pending sign-ins.** OAuth states and Nextcloud flows are `connection_pending` rows with ids `oas_…` (the
  contract's `OAuthStateId`), sealed, single use, 10 minutes, bound to the account; housekeeping drops an account's used
  and expired ones on its next start. Nextcloud's poll endpoint must be on the server's own host; requests carry
  `User-Agent: Whombat` (Nextcloud names the app password after it).
- **CX-D16 Removing.** **Superseded in part by one-person.md OP-S50**: removing a connection still withdraws its pending `connection_call` asks and revokes its OAuth tokens. Pending `connection_call` asks are withdrawn (signed `approval.declined`, “Withdrew request #n: …
  was removed”; a personal connection's in each burrow by its owner's person, naming nothing). OAuth tokens are revoked
  best effort after the commit: RFC 7009 at the MCP server's `revocation_endpoint`, Home Assistant's `/auth/revoke`,
  Dropbox's `/2/auth/token/revoke` with the access token.
- **CX-D17 Event texts** (System, `Settings · Connections`): “Connected {label} for everyone in the burrow”, “Renamed
  {old} to {new}”, “Changed {label}”, “Replaced the token of {label}”, “Connected {label} again”, “Removed {label}”,
  “{label} needs to be connected again”; Keys: “Set {tool} on {label} to Allowed|Asks|Off”. Payloads carry the
  connection id, catalog id and handle, never fields, tokens or tool arguments.
- **Open point (connect side).** Moneybird ids are read as JSON: Moneybird sends them as strings; a numeric id beyond
  2^53 would lose precision. (Proxmox's certificate fingerprint: CX-D32.)

### Tools side

- **CX-D18 One MCP client pool, one destination rule.** The Vault's pooled streamable-HTTP client (version reconnect,
  `tools/list` paging and scrub, 30 s, 64 KiB, echo withholding) moved to `mcp/client-pool.ts`; `VaultMcpPool` wraps it
  unchanged and `connections/pool.ts` keys it by connection (version = `credential_version` + MCP address). Calls go
  through the Vault's per-call destination policy (`vaultDestinationPolicy`, re-exported as `connectionPolicy`), so the
  home-network list is one list and checked on every call. `evictConnection(services, id)` is what the connect side
  calls after removing a connection or changing its credential, address or sign-in.
- **CX-D19 Credentials per request.** Every request (each JSON-RPC message too) reads the connection as it is now and
  is signed in last (`connectionFetch`), so a refreshed OAuth token needs no reconnect. Only OAuth connections retry once
  after a forced refresh on 401; a refused pasted token comes back to the agent as the service's 401. An answer holding
  a form of the credential is withheld whole (VT-D22) and the pooled client evicted.
- **CX-D20 Handles an agent sees.** **Superseded by one-person.md OP-S50, OP-S53**: handles are unique per burrow; the migration renamed a clashing personal handle `<handle>-mine` once. Shared handles are unique per burrow, personal ones per account; when a personal
  handle meets a shared one in the same turn, the personal one reads `<handle>-mine`.
- **CX-D21 Who sees what.** **Superseded in part by one-person.md OP-S51**: the agent sees every connection in the person's turns when it holds a connections key, and none in an outsiders' turn, a search answer or a reflection. Shared: every agent of the burrow holding a catalog key (`connections.read` or
  `connections.write` at Allowed or Asks; holding one lists them, CT-271). Personal: only the owner's Assistant, in a turn
  for nobody or for the owner, and a call whose on-behalf-of person is the owner. Nobody in a Feedback assessment, a
  search answer or a reflection. Connections needing reauth are still named in the instructions; the two tools are
  listed only with at least one active connection.
- **CX-D22 A call is the agent's `call_connection_tool` command.** The call's tier (`effectiveTier` of the agent's key
  for this call's access, the tool's tier and the sensitive rules) is the only grant the keys engine counts (the
  `call_pack_tool` precedent), so Ask is a normal pipeline approval of type `connection_call` with the real catalog key
  (`connections.read` for a sensitive read). A tool turned Off refuses before anything is signed (`blocked`, no event);
  a key the agent doesn't hold is a signed Blocked. The arguments live sealed in the deferred command
  (AAD `connection_call:<callId>`), opened only to decide, to run, and for the deciders' preview; the apply re-checks the
  tool's hash, so a tool that changed since the ask refuses and must be asked again.
- **CX-D23 Where a yes's result goes.** **Superseded by one-person.md OP-S51, OP-S62**: a yes's result is posted where the agent asked, for every connection. A shared connection's result is posted where the agent asked. A personal one's
  goes to the owner's DM with the Assistant, where the approval was (PA-09), never into a channel. An Assistant's asks
  are its owner's alone also for shared connections (the existing PA-09 rule in `createApproval`).
- **CX-D24 The `connection_call` executor refuses.** **Superseded in part by one-person.md OP-S51**: a yes always runs the deferred command, and its log names the tool and the connection. A yes always runs the deferred command; an approval without one has
  nothing to run and fails saying so (EA-03). The executed text of a personal call names no tool or connection.
- **CX-D25 Destructive MCP tools.** A write tool whose server sets `destructiveHint` is stored with origin
  `mcp-destructive` and always asks; `toolRowAlwaysAsks(entry, tool)` is the “Always asks” mark for the tools view.
- **CX-D26 Sync details.** The first sync marks nothing New; later new or changed definitions are New. When the MCP
  server can't be listed (other than missing), its stored tools stay as they were, tiers included, and the check says
  why; a 404 with the entry's `mcpMissingHint` is a warning and leaves only the REST tools. `syncTools` writes the tools,
  `tool_count` and `tools_synced_at` and returns its checks (`mcp`, `credential`, `tools`); the connect side merges them
  into the connection's checks on connect and “Check again”. Lazy refresh on use when never synced or over an hour old,
  single-flight per connection.
- **CX-D27 The `request` tool.** Agent headers: Accept, Content-Type, If-None-Match, If-Match, If-Modified-Since,
  Prefer and the entry's `allowedHeaders` (a WebDAV `Destination` must stay on the same server under the prefixes;
  `Dropbox-API-Arg` gets non-ASCII escaped). Paths are made canonical first (percent-escapes of letters and digits
  decoded), so sensitive rules can't be spelled around. A JSON body goes as `application/json`, a string as text, at most
  256 KB. The answer reads `HTTP <status>`, the Vault's response headers plus `X-Next-Page`, `X-Total`, `X-Total-Pages`,
  `Dropbox-API-Result`, then the body (JSON or text up to 64 KiB, binary as a note). At most 4 calls run per connection.
- **CX-D28 Adapters as built.** Dropbox: `list_folder` (+`continue`, up to 2 000 entries), `search_v2` (100),
  `download`/`upload` on the content base (`mode: add` unless `overwrite`), `move_v2`, `delete_v2`. Nextcloud: PROPFIND
  depth 1, SEARCH (`basicsearch`, display name like the words, 100), MKCOL for folders on the way, PUT with
  `If-None-Match: *` unless overwriting, MOVE with `Overwrite: F`, DELETE; the login name is the `username` field.
  Todoist API v1 as CT-268 checked it (its reference page could not be read whole on 2026-10-05): `/tasks`,
  `/tasks/filter?query=`, `POST /tasks`, `POST /tasks/<id>`, `POST /tasks/<id>/close`, `/projects` (a project may be
  named); a `due` of `YYYY-MM-DD` is `due_date`, words are `due_string`. File reads: text up to 64 KiB (an
  `application/octet-stream` answer is sniffed), anything else a note with type and size.
- **CX-D29 The prompt.** One heading line and one line per connection (`connectionPromptLine`) after the Vault's lines;
  Codex names `connection_tools` and `connection_call` when one is active. The session fingerprint has no connections
  part (`SessionParts` is a contract type), so adding or removing a connection doesn't start a fresh session by itself;
  `/mcp`'s tool list and every call follow the connections as they are now. A contract field would close it (open).

### Wiring the two sides (integration, 2026-10-05)

- **CX-D30 One path for both sides.** `connections/http.ts` holds both outbound helpers: `connectionFetch` (unsigned:
  checks, discovery, token exchanges, Nextcloud's login flow; an external effect) and `signedConnectionFetch` (as the
  connection: tools, the pooled MCP client). Both take their policy from `destination.ts` (`connectionPolicy`), and a
  save refuses an address with `connectionDestinationProblem(services, url, 'save')`, so `destination_refused` carries
  `{problem, cidr, port, canAdd}` from the one rule. The credential is the tools side's `credentialFor` over
  `crypto.ts` (one AAD scheme, `catalog_connection:<id>:secret|access|refresh`); the connect side's checks use it too
  (`credentialOf`, which also tries a token connection that needs reauth, for “Check again”). A Nextcloud login is a
  basic-auth token row with the login name in the `username` field on both sides. A refresh refuses only
  `needs_reauth` (a connection in `error` still refreshes). Every lifecycle event but `tiers` evicts the pooled MCP
  client (`onConnectionLifecycle` → `evictConnection`, subscribed in `createServices`); the tools view marks “Always
  asks” with `toolRowAlwaysAsks` (destructive MCP tools too). The connect side's suites run the real destination policy
  and the real `syncTools` (the stub Home Assistant and MCP servers answer MCP); the tools side's OAuth retry runs the
  real refresh against a stub authorization server; one suite (`end-to-end.int.test.ts`) goes from connecting over REST
  to an approved call with no stand-ins.
- **CX-D31 A token refused at call time.** A call answered 401 (the `request` tool's status, an adapter's, or the MCP
  server's after the OAuth retry) has the connect side check the stored credential with the entry's check in the
  background (`refused.ts` `confirmRefusedCredential`, outside the call's session command): refused there too →
  `markNeedsReauth` (`token_invalid`, OAuth `revoked`) with its signed event and repair message; a path the token may
  not use alone doesn't take the connection down. The agent hears the service's 401 either way.
- **CX-D32 Pinned certificates (Proxmox, CX-60).** The catalog's optional `fingerprint` field (SHA-256, `AB:CD:…`) is
  `pinnedCertSha256` on every request of that connection (its check, `request`, adapters). `lib/outbound.ts` accepts it
  only for `https:` and only when the IP literal or every address the host resolves to is non-public (the home network;
  the destination rule still has to allow it), and then accepts exactly the leaf certificate with that fingerprint —
  no chain or host-name check, any other certificate fails `certificate` (“Its certificate isn’t the one pinned for
  this connection.”). The fingerprint is checked after the handshake and before the request is written (the socket is
  handed to the request only then), so the token never reaches another server. No contracts change: the field is in
  0.48.0's catalog. Without a fingerprint a self-signed Proxmox still fails its check, as before.

## Allowed by default, Home Assistant's MCP server by Whombat (2026-10-08)

John, after connecting Home Assistant on his box: the tool asked by default, but “We add this connection ourselves, we
need the agents to freely use it fully”; the missing MCP Server integration “should be dealt with automatically”; and
he agreed to keep the always-ask rule for opening, unlocking and deleting (contracts CT-310).

- **CX-20a Allowed by default.** Every tool of a connection starts Allowed, writes included (`defaultToolTier`), and
  agents get “Change things in connected services” at On (`CAN_BY_DEFAULT_KEYS`: team agents, the Assistant, hires;
  still Off · Ask · On under Configure's All keys). The catalog's sensitive rules (CX-31) and a server's destructive
  tools still ask whatever the tiers. A tool whose access widens from read to write still resets to Ask (CX-18).
  Migration 0086 sets every existing tool that asked to Allowed and queues every live agent for the startup backfill,
  which raises the key from ask to can unless a person's last change of it chose Ask or Off (`personKeyChoices`). A
  tool a person had set to Ask is raised too: tool tiers keep no record of who set them, and the catalog was three days
  old with one real burrow.
- **CX-54a Whombat turns Home Assistant's MCP server on.** When `/api/mcp` answers 404, the sync (connect, Check again,
  the hourly refresh on use) adds the Model Context Protocol Server integration through Home Assistant's config flow
  API as the connection (`connections/mcp-setup.ts`: `POST /api/config/config_entries/flow {handler: mcp_server}`, then
  the form; an older version's LLM API question is answered with Assist), waits up to 5 s for it to answer and lists
  its tools; the check says “Whombat turned on Home Assistant’s MCP server.” A token that isn't an administrator's
  (401/403) says so before the old hint; the integration allows one entry, so an existing but silent one says to check
  that it's enabled. Once it answers the MCP line says what agents see: the devices exposed to Assist
  (`mcpReadyNote`). A failed attempt repeats at most with each sync (hourly on use).

## Ask only for what is risky (2026-10-08)

John, with Home Assistant's MCP server on (127 tools, 102 marked “Always asks”, every one New, a long MCP line): “Do we
really need all the information at MCP Server?” and “I want the default to be Allowed as much as possible (not only for
Home Assistant, for all connections), unless they pose a security issue (locks, deletion, etc)” (contracts CT-311).

- **CX-31a A server's destructive hint doesn't ask.** MCP's `destructiveHint` is set on nearly every action (Home
  Assistant's turning on a light); calls ask only for the catalog's rules, a tool named for deleting (every
  connection: `deletesByName`), a `DELETE` request, or a typed tool marked so. A read (`callAccess`) skips the rules on
  arguments, so reading a lock's state doesn't ask. The `mcp-destructive` origin stays (it is in the tool's hash) but
  marks nothing. Home Assistant's rules now catch prefixed tool names (`assist__intent__HassTurnOff`), English and
  Dutch words for locks, alarms, gates and doors in an action's arguments, scripts named that way
  (`assist__script__poort_openen`) and raw KNX writes (`knx__send_group_value_write`); covers ask only when named a
  garage, gate or door.
- **CX-18a An MCP server's first listing marks nothing New**, also after the connection's first sync (Whombat turning
  Home Assistant's server on added 126 New tools). Migration 0087 clears the mark on every tool once.
- **CX-54b The MCP line says “Working”.** No “Whombat turned on …” and no note on what Assist exposes; that note is in
  Home Assistant's guide, so an agent that can't find a device tells the person where to expose it.

## More services: homelab and infrastructure (2026-10-08)

John, 2026-10-08, asking for more connections (“Proxmox, UniFi Network, UniFi Protect, CloudFlare, Tailscale”) and
saying yes to the first group of the list he was given: services that sign in with a pasted token, so each is a catalog
entry with a guide and no new code (contracts CT-313, 0.60.0). Every entry was checked against the vendor's current
docs on 2026-10-08; anything a doc left open is said in the entry's guide or below.

- **CX-D33 A certificate that can't be verified names its fingerprint.** Most of these run on the home network with a
  self-signed certificate (UniFi consoles, Proxmox Backup Server, OPNsense, Portainer on 9443, Unraid), and the only way
  to pin one (CX-D32) was to dig its SHA-256 out of a browser. `lib/outbound.ts` now fails a certificate that doesn't
  verify (self-signed, unknown authority, expired, another name) as `untrusted_certificate` instead of `network`, and
  `presentedCertSha256` reads the leaf a home-network https server presents from a bare TLS handshake (nothing is
  written, so no request and no token goes out; public addresses refused, as for a pin). When an entry with a
  certificate fingerprint field fails its check that way, or its pinned fingerprint isn't the one presented (a renewed
  certificate), the check says “… It presents AB:CD:…; if {Name} shows the same fingerprint, use it as the certificate
  fingerprint.” and `check_failed` carries `details.certificateSha256`; the web's connect form offers **Use this
  fingerprint**, which fills the field and connects again (app AP-842). The sentence asks the person to compare it with
  what the device shows: it is trust on first use, by a person, never automatic. “Check again” on a connection says
  the same in its check line.
- **CX-80 The entries** (all token sign-ins, shared by default, personal allowed, `rest` with a guide; contracts
  CT-313): **Proxmox Backup Server** (`proxmox_backup`, `PBSAPIToken={tokenId}:{secret}` — a colon, not Proxmox VE's
  `=` —, a new token has no permissions until it gets a role), **UniFi Network** (`unifi_network`, the console's
  official Integration API at `{url}/proxy/network/integration`, `X-API-KEY`; the older `/api/s/<site>` paths aren't
  offered: a key isn't documented there), **UniFi Protect** (`unifi_protect`, Home, `{url}/proxy/protect/integration`,
  the same key), **OPNsense** (basic auth: the API key is a field, the secret is the token; firewall changes ask when
  staged, not on `apply`), **Tailscale** (`Accept: application/json` always, so the policy file isn't HuJSON),
  **Cloudflare** (checked with `GET /client/v4/accounts`: `/user/tokens/verify` refuses account-owned tokens),
  **Portainer** (`X-API-Key`; `/api/users/me` as the check, `/api/status` is public), **Unraid** (GraphQL; every call
  a write, so the rules on mutations always apply) and **Grafana** (service account token; `POST /api/ds/query`
  reads). None has an official remote MCP server Whombat could use as it is (Cloudflare's runs code for the whole API,
  which would step around the path rules; Grafana's hosted one is Cloud and OAuth only; the others are community
  projects), so all are REST. They ask only for deleting, doors and keys (firewall, NAT, VPN, policy file, Zero Trust
  Access, tunnels, Wi-Fi networks, API keys and tokens, users and roles), the alarm and outputs that may open a door
  (Protect), pruning and wiping (PBS, Docker), and powering off or restarting what the rest runs on (PBS, OPNsense, a
  UniFi device — the API can't tell the gateway from an access point, so every device restart asks — and Unraid's
  array). Cache purges, DNS records, guest access, containers and stacks, dashboards and alerts are Allowed.
- **CX-D34 A check can read the answer** (`okJsonPath`, CT-313). Unraid's GraphQL answers a wrong key 200 with
  `errors` and `data: null`; its check asks `{ me { name } }` and passes only when `data.me.name` is there, otherwise
  it is a refused token (“The service refused the token …”, and `needs_reauth` on Check again). A call answered that
  way doesn't take the connection down by itself (CX-D31 looks for a 401).
- **CX-D35 Docker's log stream reads as text.** Portainer passes the Docker Engine API through, and container logs come
  as `application/vnd.docker.multiplexed-stream` (8-byte frame headers) or `raw-stream` (a TTY, or frames from an
  engine before API 1.42), which the `request` tool answered as “[binary …; not shown]”. `dockerStreamText` takes the
  frames apart (stderr lines marked “stderr: ”) and the answer is text like any other, cut at 64 KiB.
- **Known limits.** A Grafana with anonymous access may let a wrong token pass the check (the agent then sees what an
  anonymous visitor sees); Tailscale access tokens last at most 90 days (the guide tells agents a 401 means making a new
  one); UniFi Protect's events only come over a WebSocket, so agents read the sensors' state instead; a stack update
  with `Prune: true` on Portainer doesn't ask (rules see strings, not booleans).
