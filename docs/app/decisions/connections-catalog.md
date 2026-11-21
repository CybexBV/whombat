# The connections catalog on web and Android (AP-755…AP-770)

John, 2026-10-05: “For Whombat Connections I would like to extend the connections a lot, for example Home Assistant,
Dropbox, Notion, Todoist, Nextcloud, Moneybird, etc.” and “I agree, implement this fully”. The spec is Whombat
`docs/decisions/connections-catalog.md` (CX-01…CX-75, CX-D*); contracts 0.48.0 (CT-266…CT-273). Decided by the
implementer (feedback-decide-yourself). Not in the mocks (B-05): the screens follow Settings → Connections as it was
(overview rows and tiles, a provider page with its header and bordered cards), the Google page's form and setup steps
and the Vault's tool rows. Tokens only; hex only in the providers' marks.

## Web

- **AP-755 The overview with the catalog** (feature `connections.catalog`, CX-70, CX-75). CONNECTED lists the builtins
  as before, then catalog connections (shared before personal, by label): logo, label, a `Tag` “Shared” / “Only you”,
  a line with the detail (account, or the host when the label doesn't already say it), “Connected by {name}” for a
  shared one and the tool count — or, when it needs connecting again, why — and the state (Connected · Needs connecting
  again · Needs attention). ADD A CONNECTION groups every tile — builtins not connected and every connectable entry, a
  second Home Assistant is fine (CX-05) — under the catalog's category headings in `CATALOG_CATEGORIES` order, with a
  search box (name, line or category, every word). An entry the Whombat turned off has no tile; an `app_oauth` entry
  with no app says “Not set up on this Whombat yet.” (admins: Set up). The overview waits for the catalog's two reads
  so its layout doesn't change under the pointer. The intro names the wider list. Without the feature: today's overview.
- **AP-756 The connect page** (`?tab=connections&connection=<catalogId>`, CX-71). Header: logo, name, line,
  Documentation. CONNECT card: WHO IT’S FOR as two radio rows when the entry allows both, the entry's default first
  (“For everyone in {burrow}” · “All agents can use it.” / “Just for me” · “Only your assistant uses it.”); shared is
  disabled with the reason for people who can't manage the burrow, and the form starts on personal for them. HOW IT
  SIGNS IN as a segmented control when there are several. Fields: `fieldsFor` without `fromService` fields and without
  an optional username that belongs to another token shape. The token is a password input (`autocomplete=new-password`),
  never prefilled, with its help and “Open {name}” to `resolveTokenUrl` once the address is known. A Custom entry's
  header or query shape asks for the header / parameter name (sent as `auth`). Name (optional; placeholder
  `defaultConnectionLabel`). An http address warns that the token crosses the network unencrypted (CX-40). The button
  says Connect (token, none), Sign in with Nextcloud, or Continue to {name} (OAuth). Success goes to the connection's
  page with a toast. Nextcloud: a blank tab opens on the click (so no popup blocker), is pointed at the login URL, and
  the page polls every `pollEveryMs` until connected, expired or failed, with minutes left, the login link again and
  Cancel. OAuth: `startOAuth` with `returnTo` = this page, then a full-page navigation. Custom MCP: “Check the address”
  runs `probe` and picks the matching sign-in (No sign-in, Sign in, a token), with a line saying what it found.
- **AP-757 The connection page** (`&id=<connectionId>`, CX-72). Head with the label and Rename (inline), “{entry} ·
  Shared|Only you”. CONNECTION: the state with why (or tools and the handle), each check line, CONNECTED BY, ACCOUNT or
  ADDRESS, AGENTS CALL IT, LAST USED, and the Google page's footer with “Checked …” and Check again. SIGN-IN (managers
  only): Replace token inline (checked before it replaces, CX-10) or Reconnect (OAuth with `connectionId`, Nextcloud's
  login again), Remove with an inline confirm that says who loses it. TOOLS: name (mono), New, Always asks, “Reads” /
  “Changes things” and the description, and Allowed · Asks · Off; a sensitive tool shows Asks when its tier is Allowed
  and Allowed can't be chosen for it. Members read a shared connection: no Rename, no SIGN-IN, the tier as text, and
  “Only people who manage {burrow} can change shared connections.” (CX-25). A 404 says it isn't here or isn't yours.
- **AP-758 Addresses.** `connection=` takes any known catalog id; `id=con_…` only with a connectable entry. A sign-in's
  return carries `connected=<catalogId>` and `connection=<con_…>` (CX-D04): the id may stand where the page is (or next
  to it), and the page is taken from `connected`. `connect_error=` takes Google's and `ConnectionConnectError`'s codes;
  it shows above the connect page's form, once, then leaves the address. Changing tabs clears `connection` and `id`.
- **AP-759 Keys.** “Connected services” needs no screen of its own: All keys (Configure) shows `connections.write` in
  three states like `packs.tool.write` and the Assistant's switches list both keys, from the contracts' options. Only a
  Whombat with `connections.catalog` gets them (`KeysHere.connections`; a hire's always-on keys too).
- **AP-760 Logos** (CX-01). The providers' marks are path data from Simple Icons 16.34.0 in `@whombat/brand`
  (`connectionMarks.ts`, part of `BRAND_MARKS`), so web and Android draw the same; their own colours, `currentColor` for
  Notion's black. Forgejo's mark is CC BY-SA 4.0 (attributed); the rest CC0; THIRD_PARTY_NOTICES names them and the
  owners' trademarks. Custom MCP is lucide `Plug`, Custom API `Braces`; Moneybird and Mollie (no Simple Icons mark) a
  monogram in ink2 on the same 40px tile.
- **AP-761 A refused home-network address** (CX-41). The sentence is `destinationRefusedText`; an admin gets “Add this
  network” (`allowNetwork`, note = the entry's name), then the form sends again by itself. Other destination refusals go
  under Address. The home network list also shows in This Whombat (with the catalog), and its intro says the Vault and
  Connections use the same list (CX-73).
- **AP-762 An `app_oauth` entry's app** (Dropbox, CX-14). “{NAME} APP” above CONNECT, for admins (members see whether
  it's set up only while it isn't): four numbered steps like Google's — create the app (Scoped access, Full Dropbox or
  App folder) with the console link, tick the entry's scopes, add the redirect URI (copy button), paste the app key and
  the optional secret (PKCE) — then “Saved · App key …” with Replace and Remove (confirm: everyone's connections need
  connecting again).
- **AP-763 A `connection_call` approval** (CX-21). Card and modal show a JSON code block labelled
  “CALL · {service} · {label} · {tool}” with `argumentsPreview` pretty-printed when it parses — for deciders only (the
  server fills it). Without the detail the card shows no call; the modal says only deciders see what it sends.
- **AP-764 Fixtures.** `VITE_FIXTURE_CONNECTORS=connected|none` also serves the catalog (`catalogFixtures.ts`): Home
  Assistant (shared, six tools, one New, one Always asks, an http warning), Todoist, a Nextcloud that needs connecting
  again, Dropbox without its app. 192.168.x.y is refused until Add this network, Moneybird asks for the administration,
  the token `wrong` fails, OAuth comes straight back connected, Nextcloud connects on the second poll, the probe reads
  `oauth` / `token` / `down` in the address.

## Client

- **AP-765 Hooks.** `useConnectionsCatalog`, `useCatalogConnections`, `useConnectionTools`; `useConnectionWrite(ep,
  burrow)` for every `connections.*` write (a write that answers a connection refreshes the list and its tools;
  `setTool`'s answer goes into the tools at once; `disconnect` drops them; `allowNetwork` replaces the home network
  list) and `useConnectorAppWrite` for `connectors.setApp/removeApp` (the answer is the catalog's status). Over a managed
  session the op names and secret ops come from the contracts (`SECRET_API_OPS`), nothing per op here.
- **AP-766 A managed sign-in's return** (CX-15, CX-D04). The hosted UI's `/connect/<catalogId>` (any id but Google's
  and Microsoft's) reopens the Whombat held in this tab and finishes with `connections.finishOAuth` (`code`, `state`,
  `error`, `iss`), then goes to the return path. The held connect is marked `flow: 'connection'`, so a sign-in that
  comes back to `/connect/google` instead finishes the same way.

## Android (CX-74)

- **AP-767 What's listed.** Settings → Connections (with `connections.catalog`, not in the demo world) opens a
  read-only screen: CONNECTED — catalog connections (to their detail) and the viewer's own Google and Microsoft accounts
  (“Only you”, to their web page) — and ADD A CONNECTION by category, every row opening the web page.
- **AP-768 Available entries.** Entries turned off are hidden; an app nobody set up stays with “Not set up on this
  Whombat yet”. No search box on the phone.
- **AP-769 The detail.** State, check lines that warned or failed, connected by, scope, and the tools with a tier pill
  (Allowed ok · Asks warn · Off neutral; a sensitive Allowed shows Asks with “Always asks”, New marked); the guide under
  FOR AGENTS when there is one. The button says Connect on the web (manager, not active), Manage on the web (manager) or
  Open on the web (member); the demo world gets a quiet line instead.
- **AP-770 The logo tile.** 40dp, radius 10, line border, sf, the `@whombat/brand` mark at 20dp; Plug, Code and
  MessageSquare icons for Custom MCP, Custom API and Website feedback; a monogram for Moneybird and Mollie.
- **AP-771 Checked against the integrated server (Whombat CX-D30).** The OAuth return (`connected=<catalogId>` with
  `connection=<connectionId>`, or `&id=`), field errors keyed `fields.<id>` and `secret`, members reading a shared
  connection's tools with `canManage` false, and the approval's `argumentsPreview` all match. One gap closed: the
  server keys a Custom header shape's problem `auth`, which the form now shows under the header name (`authName`).

Released in whombat-app 0.40.0 (`app-v0.40.0`, contracts 0.48.0, API level 32), APK 0.40.0 with Firebase on DEV.

## Homelab and infrastructure (2026-10-08)

- **AP-842 Nine more entries and a certificate to use** (contracts 0.60.0, CT-313; Whombat CX-80, CX-D33). The
  catalog's new entries need no screen of their own: they are tiles under Infrastructure (Proxmox Backup Server, UniFi
  Network, OPNsense, Tailscale, Cloudflare, Portainer, Unraid, Grafana) and Home (UniFi Protect) with their marks from
  Simple Icons 16.34.0 in `@whombat/brand` — Ubiquiti's for both UniFi entries, Proxmox's for Proxmox Backup Server,
  Tailscale's in `currentColor` (published black). When a check fails on a home-network certificate and the server
  sends `certificateSha256`, the connect form's problem keeps its sentence (which names the fingerprint and says to
  compare it with what the device shows) and adds **Use this fingerprint** beside it (as “Add this network”, CX-41): it
  fills the Certificate fingerprint field and connects again. Android lists the entries with their marks and connects
  in the browser, as before (AP-767).

## Setting up (2026-10-08)

John, 2026-10-08, on the Proxmox connect form: “instead of guiding the user to "Documentation" and "figure it out
yourself", I'd rather guide the user more”; sign in once and a network scan are fine, no assistant for now. The spec is
Whombat `docs/decisions/connections-setup.md` (CS-01…CS-51); contracts 0.61.0 (CT-314). Decided by the implementer.
Not in the mocks (B-05): the CONNECT card takes the Google page's numbered step rows, the services picker's radio rows
and its copy list; Found on your network takes the overview's connected rows. Tokens only.

- **AP-843 The connect form as steps** (runtime feature `connections.sign_in_once`; `SetupForm`). Older runtimes keep
  today's form, without sign in once and Tailscale's OAuth client (`signInChoices(entry, false)`; a token sign-in keeps
  its index for `method`).
  - *Where is it?* (entries with an address; cloud services start at the next step). The address is identified on
    blur and on Continue (`connections.identify` with the entry, once per address): the field takes the address the
    server answers (`pve.local` → `https://pve.local:8006`), and a line under it says what answers — “Proxmox VE
    9.0.10 · Found at …” (green number), something else (“This looks like Home Assistant”, “Something else answers
    here”; the person may go on), or nothing (“Nothing answered”, with the server's reason). An entry without probes
    (GitLab) only says it answers. The next steps open once the address is identified, at once for an address with a
    default or a Custom entry (the Custom MCP server keeps “Check the address”, CX-61). A refused address holds the
    form at this step with “Add this network”, which identifies again. A certificate that doesn't verify shows its
    fingerprint in mono with “Compare it with what {Name} shows ({where}), then trust it.” — `{where}` from the entry's
    fingerprint field — and **Trust this certificate**, which fills `fingerprint`; then “Whombat trusts this certificate
    and only this one.” with Undo. An entry that can't pin one only says the certificate can't be verified. A
    `check_failed` with `certificateSha256` on connect keeps **Use this fingerprint** (AP-842).
  - *How should Whombat sign in?* Radio cards of the entry's sign-ins, each with a line: sign in once its `creates`;
    a guided token “Make it in {Name} with the steps below, then paste it here.”; Nextcloud's login and the OAuth
    sign-ins as before. The first one is **Recommended** when it makes a lasting key of Whombat's own (sign in once, an
    OAuth client). One sign-in only: no cards.
  - *Sign in once*: the account (`account` label, placeholder, help; `fixed` shown as text, not asked), Password
    (“Used once to make Whombat’s own key, then forgotten.”, autocomplete off), and the code (“Code from your
    authenticator app”) — from the start for `optional` (“… (optional)”), else when the server answers
    `second_factor_needed`: its words become the field's help, the field takes focus, the password stays in memory and
    the same request goes again with `login.code`. The button says **Sign in and connect**; while it runs, “Signing in
    to {Name} and making Whombat’s key…”. An http address warns that the password and Whombat's key cross the network
    unencrypted. `login.account`, `login.password`, `login.code` field errors sit under their fields.
  - *Refusals*: `sign_in_refused` says its message above the button (our words when the server sends none); `code`
    sits under the code field; `second_factor` with `method` offers that sign-in (“Sign in with Nextcloud instead”),
    and `single_sign_on`, `unsupported` and `second_factor` without one offer the token (“Make a token by hand
    instead”, CS-09). The button only switches; the person then signs in there.
  - *The token made by hand, guided* (`token`, `client_credentials`): the numbered `steps` with their values in the
    Google page's copy list (templates filled from the form), **Open {Name}** as a button to the level's link (or the
    entry's `tokenUrl`; hidden while a field it needs is empty), and one paste box (“Paste what {Name} shows, or drop
    the file”) — a paste, a dropped file or text, a chosen file, or typed text on blur — read with `pasteValues`: it
    fills the fields and the secret and says so (“Filled in Token ID and Token secret.”); a lone word none of the
    patterns knows is the secret; prose fills nothing and says so; the box never keeps the text; files over 64 kB are
    refused. The fields stay below, editable. Without steps: the secret's help and Open {Name} under the field, as
    before. The OAuth client is sent as `signIn: 'client_credentials'` with its secret.
  - *More options* (closed, with a one-line summary: “For everyone in Burrow HQ · named “Proxmox VE · pve.local:8006””):
    Who it’s for, Name and the Certificate fingerprint field. It opens by itself when one of them has a problem.
- **AP-844 What may agents do? comes before the sign-in** (Look only / Manage radio rows with `accessText`, Manage by
  default; sent as `access`). CS-50 lists it last; it moves up because both ways of signing in depend on it: sign in
  once asks the service for a key at that level (CS-07), and the guided token's link and steps are for a level
  (Cloudflare's “fills in the permissions for the level you chose”, Tailscale's “Choose Read … to look only”). With
  sign in once at a service that can't limit the key (`serviceLimits: false`) a line says Whombat keeps agents to the
  level. Sign-ins elsewhere take no level (CT-314): Nextcloud's login is set to Look only with `connections.update` as
  soon as it connects; an OAuth sign-in at Look only says to set it on the connection's page afterwards.
- **AP-845 The connection's level.** With the feature, CONNECTION gets a block WHAT AGENTS MAY DO: Look only or Manage
  with what it means, and Change (for those who may change it) → the two radio rows, Save / Cancel
  (`connections.update` `access`; toast “{label} set to Look only.”). Raising one to Manage where the entry's sign in
  once has `serviceLimits` says “If this key was made by signing in once at Look only, {Name} itself keeps it to
  looking. Sign in again to make one that can manage.” with **Sign in again** (the connect page with its address).
  The overview's row adds “Look only” to its line; TOOLS says that everything that changes things stays off.
- **AP-846 Found on your network** (feature `connections.discover`, people who manage the burrow; `FoundOnNetwork`
  between CONNECTED and ADD A CONNECTION). Opening the overview asks `connections.discover` without `rescan` (the
  server reuses a recent scan or starts one) and asks again every 1.5 s while it scans, with a spinner and “Looking at
  312 of 1 016 addresses…” (digits grouped with a no-break space). Each service found the app knows: logo, name,
  version, address in mono, and Connect (the connect page with `&url=`, identified at once) — or “Connected” and View
  when the viewer can open that connection. Scan again (`rescan: true`); Look in another network opens a NETWORK field
  checked here (an IPv4 CIDR in 10/8, 172.16/12 or 192.168/16, a /22 or smaller) and sent as `networks` with a
  rescan. The card ends with “Looked in 192.168.1.0/24 and 10.0.10.0/24 · just now”; nothing found is one line. A 4xx
  (not a manager, an older server) hides the section; anything else says so once and stops asking. `&url=` is kept
  only on a catalog entry's connect page without `id`, http(s), one line, at most 300 characters.
- **AP-847 Android** shows the level as a small tag beside “Shared” / “Only you” on a connection's page (and in its
  accessibility label) where the runtime has levels; connecting stays on the web (CX-74).
- **AP-848 Fixture mode** (`VITE_FIXTURE_CONNECTORS`): identify knows `pve` (Proxmox VE 9.0.10 on its own
  certificate), `ha` / `homeassistant` (Home Assistant over http) and `down` (unreachable), and adds the entry's scheme
  and port to a bare host; a scan runs for three polls, then finds Proxmox VE, Home Assistant (connected) and
  Portainer; sign in once refuses the account `wrong`, asks for a code for the password `2fa` (the code `000000` is
  refused), sends Nextcloud's `2fa` to its login, and otherwise connects at the level asked; `update` takes `access`.
  Update notes name the two features (“signing in once to connect a service”, “finding services on your network”).

## Found on your network on the screen, Synology and QNAP (2026-10-20)

John, 2026-10-20: the screen shows what the box found on the network, and the box connects Synology and QNAP. The spec is
Whombat `docs/decisions/desk-found.md` (DF-01…DF-14, NS-01…NS-08); contracts 0.110.0 (CT-700…CT-729). The app's part:
the marks, the assistant's link, the taglines on the found rows, and the connect form for the two new entries. Decided
by the implementer (feedback-decide-yourself). Not in the mocks (B-05): Settings → Connections as it is.

- **AP-3800 Synology's and QNAP's marks** from Simple Icons 16.34.0 (CC0), the same source and processing as AP-842:
  path data unchanged on the 24-unit box, in `@whombat/brand` (`connectionMarks.ts`, so web and Android draw them),
  stored as `assets/marks/synology.svg` and `qnap.svg` with their `SOURCES.md` rows. Both are wordmarks and both are
  drawn in `currentColor`: Simple Icons' Synology grey (#B5B5B6) is about 2:1 against the light theme's tile (`--sf`
  #fffdf9) and Synology publishes its wordmark black (white on dark); QNAP's navy (#0C2E82) is about 1.3:1 against the
  dark theme's tile (#24201c), the way Pterodactyl's and CentOS's vanished (AP-2200, AP-2774). The console takes the same
  files (DF-12). Being wide wordmarks, a symbol's middle half of the tile left the names a few pixels tall: `WORDMARKS`
  (`@whombat/brand`) draws them across the tile instead — the web's `ProviderLogo` at 16/26/32/38 px in its 20/32/40/48
  squares, Android's `ConnectionLogo` at the tile less 8 dp.
- **AP-3801 `/settings?tab=connections&found=1`** is the link the assistant posts after the first scan (DF-05). It
  opens Add a connection with the **On your network** chip picked, so the full section (Connect, Hide, Scan again) is
  the page, right under the chips; the search box doesn't take the focus there (the person came to look at the list),
  All is one click away, and “← All connections” goes back as before. `found=1` alone stands for `connection=add`
  (the search says `connection: 'add', found: true`); another page (`connection=github`, a catalog entry, a
  connection's id or a sign-in's return) wins and `found` is dropped; other tabs drop it; changing tabs clears it.
  Where the viewer can't scan (a member, an older runtime) the chip isn't there and the page shows All, as AP-1162
  says. The chip is the page's own state, not the address: choosing All doesn't rewrite the link.
- **AP-3802 Found rows say what a service is** (DF-08): the entry's `tagline` (contracts 0.110, CT-702) before the
  address on the row's second line — “Storage, Docker and VMs · https://192.168.1.50:5001”, the line in `--ink2`, the
  dot in `--mut`, the address in mono as before (muted with the rest of a hidden row). `FoundRow.tagline`
  (`foundList`, `taglineOf`) is null for an entry without one (an older runtime's catalog), and the row is as it was.
  The overview's chips keep the name only; their tooltip says “{tagline} · {address}”.
- **AP-3803 Android's found rows** show the same tagline on a line of its own between the name and the address (13, ink2,
  one line), cheap because `FoundRow` carries it.
- **AP-3804 Android opens `found=1`** as Add a connection (`settings/connections/add`), where Found on your network is
  at the top under the search field; another page in the link wins, as on the web.
- **AP-3805 A refused session sign-in keeps the server's words.** Since 0.97 a token sign-in may be a password
  Whombat signs in with for a session (Pi-hole, Nginx Proxy Manager; now Synology and QNAP). The server's `check_failed`
  says why in the person's words — wrong name or password, the account switched off, two-step sign-in on for this
  user, too many tries, the password expired (NS-04) — but carries the login's status, and the form replaced a 401/403
  with “The service didn’t accept that token …”. `connectProblem(err, fallback, signIn)` now takes the sign-in that was
  tried; for a session (`signsInForSession`) `checkFailedText` keeps the server's sentence, and without one says
  “Whombat couldn’t sign in with that. Check the address, the account and the password.” — never “token”. Passed by
  the connect form (web `SetupForm` and the older `ConnectPage`, Android's Connect {Name}) and by Replace on a
  connection's page (web and Android). A refusal that names the sign-in already in use (`sign_in_refused` with
  `second_factor` on a token sign-in) offers no switch to it: the web's form and Android's `fixButtons(…, current)`
  leave that button out.
- **AP-3806 Fixtures** (`VITE_FIXTURE_CONNECTORS=connected`, contracts 0.110.0): the scan also finds Synology DSM 7.2.2
  at https://192.168.1.50:5001 and QNAP 5.2.4 at https://192.168.1.60, each on its own certificate, so the strip shows
  four chips and “+1 more” and On your network counts 5. Identify knows `synology` / `diskstation` and `qnap` in a host
  (their certificate untrusted, as Proxmox's). A session's password (Pi-hole, Nginx Proxy Manager, Synology, QNAP) is
  refused with `check_failed` when it is `wrong`, `disabled`, `denied`, `2fa`, `locked` or `expired`, in the entry's
  words for that reason (its `failures[].text`, else `sessionLoginFailureText`); a reason the entry's service doesn't
  tell apart is its “refused” (QNAP), with status 200 where the entry reads `failures`, else 401 — as the server's
  check sends it. A refusal comes after the certificate is trusted, as on the wire.
- **AP-3807 A session's guided steps make a user, with nothing to paste.** The paste box (CS-15) reads a token the
  service shows; for a password Whombat signs in with (`takesPaste` false for a session without paste patterns: Nginx
  Proxy Manager, Synology, QNAP) it asked to “Paste what Synology DSM shows”. Web and Android leave it out there; the
  steps' list is named “Making a user for Whombat” (`guideLabel`) instead of “Making the password”. Account, Password,
  Open {Name} and the certificate under More options stay as the catalog gives them.
- **AP-3808 Checked.** Unit tests: the `found=1` search, the phone's link, `foundList`'s tagline and every findable
  entry having one, `connectProblem` with a session, `takesPaste` / `guideLabel`, the marks (brand's catalog test and
  Android's `connectionLogo`). Fixture-app tests: `found=1` opens Add a connection at On your network (the chip
  pressed, no tiles, the search box not focused, All brings the tiles); the found rows and strip with the two NAS and a
  tagline; Pi-hole's refused password says why without “token” and offers no switch; Synology's form trusts its
  certificate, asks the account and password, has no paste box and says why DSM refused; QNAP connects. Looked at in
  the browser with the fixtures (Vite, `VITE_FIXTURES=1`), light and dark: `found=1` and the overview's strip at
  1440×900, Synology's and QNAP's refused forms at 1440×2000 (the page is longer than one screen). Not in the mocks
  (B-05), so no `pnpm visual` comparison. Not checked: Android on a device (the tagline line, the wordmarks at 40 dp,
  the `found=1` link opening Add a connection), and the forms against a real Synology or QNAP (NS-08).
