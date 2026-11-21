# Workstream: connecting from the phone (2026-10-19)

John, 2026-10-19 (main checkout): “In the Android app, when I go to connections and add a new connection, I get a
list of all the available connections. When I click on a new connection that I want to add, I get presented with the
connection overview page again instead of the configuration for that connection. … Research both issues and implement
it fully.”

The cause: a row of Add a connection opened the entry's web page (`connectionsWebPath`:
`/settings?tab=connections&connection=<id>&burrow=<slug>`, wrapped as `https://<ui>/appliances/<device>/…` on a
managed Whombat). The managed app claims `/appliances/` as a verified App Link, so Android handed the link straight
back to the app, whose link parser (`settingsScreenUrl`) dropped `connection=` and opened Settings → Connections.
Connect / Manage / Open on the web on a connection's page, the account rows and the Custom footer looped the same way.
The self-hosted app has no https App Links, so there it opened the browser.

Decided by the lead (feedback-decide-yourself). Not in the mocks (B-05): the phone's screens follow Add a server
(AP-1697) and the web's connect form (CS-50 SetupForm) word for word.

Numbering: PC-01… here; app AP-2900…AP-2959 (`phone-connect.md` in whombat-app); contracts CT-500…CT-529 if a contract
change is needed (0.98.0).

- **PC-01 The phone connects.** This reverses CX-74's “opens the web page to connect”, the app's AP-767/AP-847 (every
  row opening the web), AP-2810/AP-2813 (no connect form on the phone), and for connections AG-15/SUB-11 (sign-ins in
  the browser) — as SI-12 reversed AP-1367 for servers.
  *Why:* on the managed app the web page can't be reached from a link at all (the App Link brings it back), and John
  expects to set a connection up where he found it. Every piece the form needs is already on the phone: the catalog
  ships in `@whombat/core`, the writes are `useConnectionWrite`, secrets travel as secret ops (CX-16) as the Vault's do.
- **PC-02 Links to a connection open the phone's own screens.** `/settings?tab=connections&connection=<id>` opens
  Connect {Name}, with `&url=` filled in; `&id=con_…` opens that connection's page; `connection=add` opens Add a
  connection; `google`, `microsoft`, `imap`, `github`, `feedback` open their own screens. Chat links, guide cards and
  push taps reach the same screens. Nothing on the phone opens a Whombat web page it would catch itself.
- **PC-03 Connect {Name}: the web's steps, words and rules** (`connections.sign_in_once`'s SetupForm): Where is it?
  (Address, read on leaving the field, “Looking at the address…”, the found service and version, the certificate's
  fingerprint and Trust this certificate), What may agents do? (Look only · Manage), How should Whombat sign in? (the
  entry's sign-in cards, Recommended on the first; sign in once: account, password, the code when asked; a key: the
  guided steps with Copy, Open {Name}, Paste — from the clipboard, which fills what it finds the way a dropped file does
  on the web; client credentials; no sign-in), More options (Who it's for, Name, the fingerprint). The server's answers
  bring the same buttons as on the web: Add this network, Use this fingerprint, the choice list (Moneybird's
  administration), the code field, the switch to a hand-made token. The gates too: turned off, app not set up,
  shared-only.
- **PC-04 One set of words and rules for both.** The web's pure connect helpers (`features/connectors/catalog.ts`'s form
  part, `setup.ts`, `words.ts`, the error mapping, the probe note, the Nextcloud wait) move to `@whombat/client`
  (`connections/`); the web imports them from there and doesn't change.
- **PC-05 Sign-ins in a browser (OAuth).** Dropbox, Notion's and Home Assistant's own sign-in, a Custom MCP server that
  wants one, Google and Microsoft: on the managed app the phone starts the sign-in over its own session, the provider's
  page opens in the browser, and the provider's return (`https://<ui>/connect/<id>?code=…&state=…`) comes back to the
  app through a new App Link path, which finishes it over its own session (the state is the account's, so the server
  checks it as for the web). The self-hosted app opens the web page in the browser (its return lands on the server's
  cookie route). Nextcloud's login flow opens the browser and the phone waits, as the web does. If `/connect/` serves
  flows the app can't finish (an account sign-in), the app finishes only connection returns and opens the rest in the
  browser; that check is the build's first step.
- **PC-06 Email (IMAP) gets its form** (the shared `imap.ts` words and rules: address, password, the found servers,
  Change).
- **PC-07 Setting up a provider's app (Dropbox, admins)** is a small form on the phone too: the redirect address to
  copy, the console link, client id and secret.
- **PC-08 Found on your network on the phone's Add a connection** (managers, with `connections.discover`): the found
  services first, Hide and Unhide, Connect opening Connect {Name} with the address.
- **PC-09 A connection's page** gets what the web's has for changing it: a new key or password, Look only · Manage,
  Name, Who it's for, Check again, Disconnect (with the web's confirm). “Open on the web” goes.
- **PC-10 After connecting:** “{label} connected.” and the connection's page replaces Connect {Name}, as on the web.
- **PC-11 Phone layout:** Add a server's pattern (keyboard avoiding, the button in a sticky footer, step titles as
  section headers), 44dp targets, TalkBack labels on every field, card and button, secrets masked with no autofill.
