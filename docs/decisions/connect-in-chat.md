# Setting things up in chat cards (CIC)

The “effortless” work of 2026-10-30 for John: make Whombat as easy as possible for people who aren't developers, with
the assistant doing the work. This stream is the review's Journey 3 (3.1…3.5) and its Direction rule 5: setting things
up happens in chat cards, and the person types only what only they know — a password, or a yes. Built on `server_add`'s
card (server-signin.md SI-10), the guide card's write-only `form` block (assistant-guides.md), the Vault
(vault-self-serve.md), the connect form (connections-setup.md) and Found on your network (CS-14, desk-found.md).

Code: `packages/core/src/domain/connect-ask.ts`, `packages/core/src/contracts/mcp-setup.ts`,
`apps/server/src/connections/ask.ts`, `apps/server/src/vault/ask.ts`, `apps/server/src/guides/ask.ts`,
`apps/server/src/connections/found-servers.ts`, `packages/client/src/hosts/install.ts` (`installFailureCard`); tests
`connections/connect-in-chat.int.test.ts` (Postgres: the commit pipeline, the Vault's sealed store and the dispatch queue
together) and `connect-in-chat.test.ts`.

## Connecting from the chat (3.4)

| # | Decision | Why |
|---|---|---|
| CIC-01 | **`connection_add`**, a personal MCP tool of Whombat's own (not a Servers connection tool: it is about every connection and must be there with none yet), puts a card (topic `add_connection`) in the turn's thread: “Connect Home Assistant at 192.168.1.20”, where it is, how it signs in and the level in plain words, one button to the connect form filled in. Only in a turn for the person; the card is a link, so it is `done` at once and holds no thread open. | “Connect my Home Assistant” works in chat: one tap, then the password. The password is typed into the form, never into chat (SI-10's rule). |
| CIC-02 | **The address comes from the scan.** Left out, it is the first find of that entry the person hasn't connected or hidden (DF-03's order); a bare host the person named is replaced by the find on that host (its scheme and port). Nothing found: the form asks where it is. A service already connected at that host — or at all, when nothing new was found — is not asked again: the agent hears which connection it is. | The scan knows the port and scheme people don't. |
| CIC-03 | **The certificate rides with the address, not the link.** The form identifies the address at once and trusts a home-network server's own certificate (CS-54) — the one the scan saw — so the link carries only `url` and `access`. | A fingerprint in a link would be a second, stale copy of what identifying reads anyway. |
| CIC-04 | **Look only or Manage by risk** (`suggestedAccess`): Manage where everyday use is changing things and a mistake is easy to undo (Home Assistant, ESPHome, Pi-hole, AdGuard, Plex, Sonarr, Radarr, Overseerr, SABnzbd, NZBHydra, Todoist), and where a service is connected to hand work over (T3 Code's coding agents, `t3code.md` T3-14); Look only for everything else (a NAS, photos, the router, doors and cameras, DNS, money, code). The card says it in the entry's own words, of the assistant (“Look only to start: Dusty can see … You can switch it to Manage on its page.”). The connect form's own default follows the same rule (it was Manage for every entry); a link's `&access=` wins. | The review: “Manage for Home Assistant and Pi-hole, Look only for a NAS.” One rule wherever a level is first chosen. |
| CIC-05 | **Sign in once stays the form's first sign-in**, so it is the default from the card; the card says what it does (“Whombat makes its own key and forgets the password”), or that the form shows how to give a sign-in key where the entry has no Sign in once. | Already the recommended first choice (CS-50). |
| CIC-06 | **The link** is the connect form's address, `/settings?tab=connections&connection=<id>&url=…&access=…`. The web reads `access` from the address as it is (Settings' own search is left alone); the phone opens it at its own Connect screen (`connectCardAppUrl`), the level along. | No new place to connect: the form people already have. |
| CIC-07 | **The tool's description teaches when to use it** (“when they want a service connected”, “the card says it all: end your turn”), and the agent hears only facts (`status`, `address`, `found`, `access`, `server`, a refusal's reason and words). | Agent-facing words go to the agent, never into the chat. |

## A write-only field for a secret (3.5)

| # | Decision | Why |
|---|---|---|
| CIC-10 | **`vault_ask`** puts a card (topic `secret`) in the turn's thread: “Dusty needs the UniFi password” (“… a sign-in key for Cloudflare” for a token), the agent's reason, where it is saved, and a form with one write-only field (and the username when not known), plus No. The kinds are `vault_save`'s (`login`, `token`, `basic`); with `entry`, one of the person's entries gets the new secret (a password that stopped working). Only the person's own assistant in a turn for them, in their Chat (where cards are answered). | It can ask for exactly the secret it needs, in the thread, safely: the value never passes the model. |
| CIC-11 | **The card carries where the value goes** (`GuideCard.vaultAsk`: kind, name, address, username, description, entry), written by the server when it posts and read back from the stored card when the form comes. Nothing a client sends can point it elsewhere. | No new table or migration; the card is server-made and stored as it is. |
| CIC-12 | **Checked before asking**: a new entry's address passes the Vault's destination rule (VT-11…VT-13) and the 50-entry limit when the card is posted, and again when it is saved. | Never ask for something that can't be kept. |
| CIC-13 | **Saved as the person who typed it**, in `guides.act` (already a secret op): `vault.create` (signed by them, the assistant's key given in the same commit, VS-01) or `vault.setSecret`. The value goes only there: `guide_act` gets the entry's id and name, the locked card says “Saved to your Vault · UniFi”, and a refusal comes back on the field in the Vault's words. A second send of the same card while one saves is refused (`guide_closed`), so a double tap makes one entry. | Generalises the guide `form` block (`saveAppFromForm`) beyond Google's client. |
| CIC-14 | **The agent is woken in the card's thread** with the card as what woke it; the answer keeps the entry (`GuideAnswer.vaultEntryId`), so its history reads `[guide: …; you chose Saved to your Vault · UniFi; Vault entry vlt_…]` and the turn's preface says it is saved (or that the person said no: carry on without it). The new entry reaches the turn as any entry does. If a turn is already queued in that thread, the wake joins it (one queued turn per thread) and the history line tells it. | “The agent gets only ‘saved’ + the Vault handle.” |
| CIC-15 | **Never in logs, model context or chat history** — tested: after a save the value is in no message, no signed event, no realtime frame, no log line (the app's and the services') and not in the woken turn's `DispatchContext`; only the sealed entry holds it. Pasting a secret into chat keeps working as a safety net (`vault_save` blanks it, VS-07). | The brief's security bar. |

## Servers found on the network (3.1, 3.2)

| # | Decision | Why |
|---|---|---|
| CIC-20 | **Port 22 joins the scan** (CS-14's ports). On an open one Whombat reads the SSH greeting (the banner the server sends first; at most 255 bytes in 1.5 s; nothing is sent) and a computer is found as `server` (`FOUND_SERVER_ID`, `ssh://host`), named by its system (“Debian server”, else “Server”). Dropbear's banner (routers, appliances) isn't a computer Whombat's helper runs on: left out. | Nothing found servers before; the review: “include SSH hosts”. |
| CIC-21 | **One row per machine.** An SSH find at a host where Proxmox VE, its Backup Server or Unraid was found is that entry's row (which adds it as a server itself); at a host where an appliance was found (UniFi, OPNsense, Synology, QNAP, TrueNAS, Home Assistant) it is left out: those are looked after through their connection. Services on a general computer (Plex, Pi-hole…) keep their rows beside the server's. | Two rows for one box would ask the person to tell them apart. |
| CIC-22 | **Added already is left out**, as connected is (CS-52): a found server, or an entry best added as one, at the address a Whombat server's helper last reported (`/agents`, cached by the hosts service) names it in `DiscoveredService.serverIds`. No hosts service: nothing is known to be added. | Every added Linux server answers SSH. |
| CIC-23 | **“Add as a server” for a computer, Proxmox VE, its Backup Server and Unraid** (`CatalogEntry.asServer`), in Found on your network (web row and strip chip, phone row) and on the connect page above the form (“Add it as a server instead”), opening Add a server with the host filled in. The API-token connection stays possible below. The assistant's `connection_add` card for such an entry has “Add as a server” first and “Connect it instead” quiet. | 3.2: one recommended route; Whombat's helper sees more than the API and needs no sign-in key. |
| CIC-24 | **A found server's address shows as the host**, not `ssh://…`; its version line is its system's name, already in the name. Its logo is the server icon. | `ssh://` is a developer's word. |

## Add a server's failures (3.3)

| # | Decision | Why |
|---|---|---|
| CIC-30 | **A failed install ends in one plain card** (`installFailureCard`, web and phone): what happened in a sentence, what to do in a second, and the one step that helps as the button. `cant_reach_whombat` → “Run this one line on it instead” (the Run a command tab, the level kept); `host_key_changed` → “Its key changed since last time. Trust the new one?” with No; the rest in plain words with Try again; the installer's or destination rule's own words where nothing better is known (`failed`, `not_allowed`). | 3.3: errors assumed a shell (“Install one of them”, “trust its new key in the Vault first”). |
| CIC-31 | **The command path is offered honestly**: the card says that if the server is on another network it can't reach the Whombat either way — the one line dials the same address. | Don't promise what it can't do. |
| CIC-32 | **“Trust the new one” is the Vault's own Trust this server** (`vault.trustSshHostKey`) for each of the person's Vault SSH servers that trusted the old key at that host and port — named in the failed job (`HostInstall.pins`) — with the key the server showed; the Vault reads the key again and refuses one that changed meanwhile. Then the form again, the password cleared. Without such pins the card says where to trust it and offers Try again. A changed key's note shows the new key (“It shows a new key now”), not “the one your Vault trusts”. | One trust path, re-checked; no new endpoint or session operation. |

## Not now

- Typing a connection's password into the chat card itself (Sign in once from the card, with its second factor and
  certificate steps): the card opens the form, which already does all of it.
- The assistant's welcome from the scan (“I found X, Y, Z on your network”): the first-day stream's.
- Hiding a found server's row by its name rather than its address; reverse DNS names for found servers.
- `server_add`'s own card still goes to the top of the conversation (its Servers connection call has no thread); the
  new cards go in the turn's thread.

## Rows for DECISIONS.md

Section “GitHub, connections, the Vault”:

| # | Decision |
|---|---|
| CIC-01…CIC-07 | **Connecting happens from the chat**: `connection_add` posts a card that opens the connect form filled in (the scan's address, Sign in once first, Look only or Manage by risk); the person types the password there, never in chat. (`connect-in-chat.md`) |
| CIC-10…CIC-15 | **The agent asks for a secret with a write-only card** (`vault_ask`): what the person types goes straight to their Vault as them, and the agent gets only the entry; never in a message, event, log or the model's context. (`connect-in-chat.md`) |
| CIC-20…CIC-24 | **Found on your network finds servers** (SSH) and offers Add as a server for them and for Proxmox VE, its Backup Server and Unraid; servers added already are left out. (`connect-in-chat.md`) |
| CIC-30…CIC-32 | **A failed Add a server ends in one plain card** with the one step that helps: the one line to run, trusting a changed key, or Try again. (`connect-in-chat.md`) |
