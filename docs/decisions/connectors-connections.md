# Workstream: connectors — connections

The admin's Google app, each person's Google connection, tokens and the Settings → Connections UI
(`connectors.md` CN-02…CN-08), built on `connectors-foundation.md` on 2026-09-24. The spec's decisions are not
repeated; these are the ones it left open.

## OAuth flow (CN-04)

- **CC-01 The callback belongs to the signed-in account.** `GET /api/v1/connectors/google/callback` reads the
  session cookie and only accepts a state row of that account. Anything else (no session, another account, an
  unknown, used or expired state) answers `connect_error=invalid_state`. Otherwise a link started by someone
  else could connect their Google account to yours, or yours to theirs. When the state gives no return path,
  the browser goes to the account's first burrow's `settings?tab=connections`, or to `/`.
- **CC-02 State and PKCE.** The state is `oas_` plus 43 random characters (about 256 bits). The verifier is 64
  random bytes in base64url. The state is taken with a single `UPDATE … WHERE used_at IS NULL AND expires_at >
  now()`, so it can be used once. Starting a new sign-in deletes the account's expired and used states.
- **CC-03 What gets connected.** Services are the ones Google granted, out of those asked for now, plus those
  already connected when it is the same Google account (the same `sub`; `include_granted_scopes` keeps them).
  A different Google account replaces the old services. Three failures store nothing:
  - Google granted none of the services asked for (people can untick them on its consent screen):
    `access_denied`.
  - No refresh token came back: `exchange_failed`.
  - Any other Google `error=` than `access_denied`: `exchange_failed`.
- **CC-04 The fake Google (CN-08) needs no app.** In `WHOMBAT_GOOGLE=fake`, `start` works without an admin
  setting up Google, so dev, tests and the demo can connect right away. The panel says so in a neutral notice.
  The fake behaves like Google in these ways:
  - it grants scopes cumulatively;
  - revoking any token ends the whole grant;
  - a revoked refresh token answers `invalid_grant`;
  - every access token is `fake-token`, the one the fake Workspace expects. *Superseded by `connectors.md`
    IN-03: the token is derived from the grant's refresh token, stable across refreshes.*
- **CC-05 `WHOMBAT_GOOGLE=off`.** The status is still served (`mode: 'off'`). `start` answers 409, the callback
  answers `no_app`, and the tab shows the reason with no Connect button.

## The app (CN-02, CN-03)

- **CC-06 Replacing the client.** `SetGoogleAppBody.clientId` is optional as well (a contract change): clients
  only know `clientIdHint`, so “Save this choice” for the audience sends `{ userType }` alone. When a different
  client id is saved, every Google connection becomes `needs_reauth` (`app_removed`), as it does when the app
  is removed, because refresh tokens belong to the client that issued them.
- **CC-07 Setup facts.**
  - `supportEmail` is the caller's email for admins and null for everyone else.
  - `authorizedDomain` is the registrable domain of the `PUBLIC_URL` host, because Google wants a “top private
    domain”: `dev.whombat.com` → `whombat.com`, `app.example.co.uk` → `example.co.uk`. A localhost or IP host
    is returned as it is, and the UI leaves that copy row out.
  - `tested` is true when any active Google connection on this Whombat has at least one `ok` check.
- **CC-08 Config wins.** When the app is set in config, `setGoogleApp` / `removeGoogleApp` answer 409 for
  admins and 403 for everyone else (the admin check comes first). The panel shows “Set in this Whombat’s config
  · Client ID …” with no steps. Admins still see the troubleshooting list.

## Tokens (CN-05)

- **CC-09 One token store for every mode.** `StoredConnectionTokens` needs a real `connections` row in fake
  mode too. The foundation's “`fake-token` for anyone” is gone, so tests of connector tools insert a connection
  first (for example through `storeGoogleConnection`, or through `start` and the callback). `last_used_at` is
  written at most once a minute. A refresh that fails for a network or client reason throws the
  `GoogleOAuthError` and leaves the connection as it is. Only `invalid_grant` marks `needs_reauth`. With no
  app, real mode throws `ConnectionUnavailableError('no_app')`.
- **CC-10 `testing_expired` versus `revoked`.** On `invalid_grant`, the reason is `testing_expired` when the
  grant is 6 to 8 days old and the app's audience is not `internal`. An app set in config has an unknown
  audience, so a 7-day expiry counts as Testing there as well. Every other `invalid_grant` is `revoked`.
- **CC-11 Disconnect.** It revokes the refresh token at Google on a best-effort basis (15 s timeout; failures
  are logged) and then deletes the row either way.

## Service checks (CN-06)

- **CC-12 Where the checks live.** The checks are in `connectors/checks.ts`: `checkGoogleServices` for a whole
  connection and `checkGoogleService` for one service. When the tools stream's real Workspace lands,
  `GoogleWorkspace.checkService` should call `checkGoogleService`, so that only one implementation exists. The
  calls:
  - People: `people/me/connections?pageSize=1&personFields=names`. Google requires `personFields`.
  - Docs and Sheets: they reuse Drive's `about.get`. When the Drive scope was not granted, their scope alone
    counts as `ok`.
  - A service whose scope was not granted is `no_scope` and makes no call.
- **CC-13 Activation links.** The link comes from the ErrorInfo `activationUrl`, then the Help link, then a URL
  in the message. It is kept only when it is https on `console.developers.google.com` or
  `console.cloud.google.com`. People see this link, and it comes from a remote response.
- **CC-14 Only Google's hosts.** Every outbound call goes through `googleFetch`. It refuses any URL that is not
  https on `GOOGLE_HOSTS`, never follows redirects (`redirect: 'error'`) and times out after 15 s.

## Web

- **CC-15 Reaching the tab.**
  - The Settings tabs gain “Connections” (`?tab=connections`); the page subtitle stays as it was.
  - Before this, members could not open Settings from the account menu. The menu now has “Connected accounts”
    for everyone, which opens `settings?tab=connections`.
  - The settings search keeps `connected=google` and `connect_error=<code>`. A success shows a toast (“Google
    connected: {email}.”). An error shows a notice above the YOUR ACCOUNTS card. Both are then dropped from the
    URL (replace).
- **CC-16 Step dots.** Whombat cannot see the Cloud console, so steps 1 to 5 turn green once the app is saved.
  Step 6 turns green when `tested` is true and shows amber while the app is saved but untested. Once the app is
  saved and tested, the steps fold behind “Show setup steps”. The step 3 audience choice is saved with step 5,
  or later on its own with “Save this choice”.
- **CC-17 Step 5 input.** The `client_secret_*.json` file is read in the browser only:
  - a file with an `installed` key is refused as a Desktop client (the spec's copy);
  - a Web client fills both fields;
  - when the file's `redirect_uris` do not include this Whombat's URI, a `redirect_uri_mismatch` warning shows.

  When replacing an app, the secret can be left empty to keep the saved one.
- **CC-18 The Connect Google callout.**
  - It renders, and fetches `/connectors`, only for the agent's owner (`agent.ownerId === me.id`). It shows
    while no Google connection is active; a connection that needs reauth gets “Reconnect Google”.
  - Its button connects every service and comes back to Settings → Connections, where the outcome shows.
    “Choose services” links to that tab.
  - It sits at the top of the profile pane's body. In the DM, it goes below the suggestions of the empty
    state, through a new `children` slot on `DmEmptyState`.
