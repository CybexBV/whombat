# Decision files

One file per workstream: the decisions taken while building it, each with its reason. `DECISIONS.md` lists what is
in force across the project; `ARCHITECTURE.md` describes the system as it is. Read a file here when you need the
reasoning behind a part of the code, or when a code comment points to it.

A row marked **Superseded** no longer holds (the marker says what replaced it and, when part of it holds, what).
Files marked *in part* below were written for a Whombat that has since changed (several agents or people, the
agent's computer, self-hosting, Codex, packs); read their rows against the files that replaced them.

`archive/` holds files whose subject is gone (the ones archived before the repository went public are in the
maintainers' private archive). They are history: never follow them, and don't add to them.
How the split was made: `docs.md`.

## Foundations

- `one-person.md` — a Whombat is one person's device; outsiders' turns; no computer, commands in wrappers, Podman.
- `membership.md` — no conversation membership: every room is the person's with the agent; outsiders' turns stay in theirs.
- `outsiders-turns.md` — outsiders' turns are deny by default: an allowlist of tools, their own thread, and every turn calls only what it is served; they run one at a time, queued at the claim.
- `one-agent.md` — exactly one agent, made with the Whombat; no roles, hiring, delegation or channels (*in part*).
- `hermes-engine.md` — every turn on Hermes Agent: profiles, ACP, tools, policy, memory, sessions (*in part*).
- `hermes-native.md` — Hermes's own loop for ChatGPT, one pod, a thread keeps its provider, housekeeping (*in part*).
- `hermes-skills.md` — the agent's skills are Hermes's: built-ins, the hub, learned skills, Settings → Skills (*in part*).
- `claude-directsdk.md` — Claude subscriptions through Nous's DirectSDK provider on unpatched Hermes.
- `hermes-updates.md` — how new Hermes versions reach a box, and where Settings shows the version.
- `managed-runtime.md` — the runtime on the appliance: session endpoint, enrolment, durable commands, events (*in part*).
- `managed-db.md` — schema compatibility classes and floors, checkpoints, migration authority, the CLI's commands.
- `write-lock.md` — a write holds the burrow lock briefly: outside calls after the commit, a guard, a one-minute limit.
- `managed-sandbox.md` — the two-stage bubblewrap sandbox, cgroups, egress, runner generations.
- `net-openings.md` — a production server's opening in the commands' wall closes by itself when its time is up.
- `managed-providers.md` — pinned provider runtimes, eligibility, sign-in flows, the person's GitHub (*in part*).
- `buzz-parity.md` — cross-cutting rules from the Buzz study: no private content in signed events, data is data (*in part*).

## The box, the session and the desk

- `direct-connection.md` — clients reach the box over the local network or Tailscale with the same Noise session.
- `tailnet-reach.md` — the agent reaches everything on the person's tailnet; routes, DNS and sign-out on the box.
- `signin-at-box.md` — a new device joins with six letters shown on the box's screen.
- `shared-passkey.md` — one shared passkey across appliances, authenticated discovery, one default setup and shared status, finishing existing setup with one authorization, safe retirement and verified recovery.
- `passkeys.md` — one-touch sign-in on a new device, verified by the Whombat itself.
- `whombat-link.md` — Whombat Link, the one paid service: one image, the Link state, HTTPS only and the installer's choice, updates from GitHub Releases on two channels, control as the Link service, push through the box, the DEV move.
- `link-email.md` — email through Whombat Link: the owner's two choices, the offline warning, notification emails as a count, notices by email.
- `legal-texts.md` — the legal texts: the seller's details, the Privacy Policy's third parties, when the accepted terms get a new version, the Dutch voice's restrictions, the What's new page.
- `one-environment.md` — one environment, Link on production: one image, Production and Beta updates, release ids and keys, moving a box to production, the yearly price, promotion codes and free time, guarded admin, Easy/Expert words, the website, the installer download, shipping.
- `own-address.md` — each Whombat's own page at `<name>.whombat.app`: the name (random or chosen, changed with a 30-day overlap), the door, the certificate and its watch, the claim and link there, box passkeys.
- `../app/decisions/whombat-link-app.md` — Whombat Link in the apps: the one setup on the box's page, Reach and Updates in Settings, the Link-ended strip, joining a box on the phone without a cloud account, push through the box, nothing to buy on the iPhone.
- `../app/decisions/link-account-site.md` — the account site under Whombat Link: open sign-up, `/link`, Your Whombats
  with the Link subscription, what left the hosted flow.
- `../app/decisions/account-home.md` — the account site's home (every Whombat, Add a Whombat, the account page) and the
  menu under a box's name with the account's other Whombats.
- `../app/decisions/own-address.md` — the own address in the apps: the setup at the address, the box's passkey, the link
  code at the account, the address in Settings, the phone following it.
- `remote-help.md`, `remote-help-server.md` — support access the person grants and can stop.
- `box-status.md` — How it's doing: processor, memory, disk and network from the manager.
- `box-health.md` — event overflow and subscription order, control-plane outages in the log (*in part*).
- `hardware-support.md`, `hardware-support-server.md` — hardware report, sound server, Wi-Fi.
- `network-move.md`, `network-move-server.md` — Wi-Fi only, servers moving with the box, what owners hear about its network.
- `bluetooth.md`, `bluetooth-server.md` — pairing keyboards, mice and speakers with the box.
- `local-network.md` — the home network is open to the agent by default (*in part*).
- `open-speed.md` — opening over a bad network path, prepared web sessions, bounded admission and local phase timings.
- `command-safety.md` — what a session command's receipt says after a lost answer.
- `pg-guard.md` — a lost Postgres session never crashes the process (the postgres.js patch).
- `desk-display.md`, `desk-display-server.md`, `desk-display-talk.md` — the box's own screen: glance, asks, Talk.
- `dictation.md` — voice typing: a mic in every composer, speech models on the box downloaded after install, its settings.
- `done-today.md` — the desk's Done today: what the assistant finished, in its own words (`report_done`).
- `status-line.md` — the honest status sentence (Connections), no status line in Chat, Files from Chat's head.
- `desk-found.md` — what the box found on the network, on its screen; Synology and QNAP.
- `email-templates.md` — the HTML layout of every email Whombat sends.

## The agent's turns

- `agent-setup.md` — checking Hermes and the CLIs, claiming only what can run, the quiet reply (*in part*).
- `agent-status.md` — the runtime keeps the agent's status honest around its turns.
- `agent-voices.md` — the agent's face decides how it talks (`SOUL.md`).
- `agent-search.md` — what the agent's search may read.
- `web-search.md` — the agent's web search on the person's Brave Search key: the setting, the check, how Hermes gets the key.
- `concise-replies.md` — short replies, “More detail” on request; one plain line when Whombat wakes the agent (CW).
- `model-effort.md` — the agent's model and effort, checked against the CLI's own list (*in part*).
- `chat-runtime.md`, `chat-runtime-server.md`, `chat-runtime-runner.md` — provider, model, effort and fast replies per thread (*in part*).
- `provider-subscriptions.md` — the person's own Claude and ChatGPT subscriptions, and why that is permitted (*in part*).
- `claude-extra-usage.md` — Claude subscription routes and extra-usage refusals.
- `claude-native-gateway.md` — native Claude Code through the AI gateway.
- `ai-gateway.md` — a burrow's AI gateway (Fusebox or another) for Claude and ChatGPT turns (*in part*).
- `fusebox-page.md` — Fusebox's page and usage (*in part*).
- `spend.md` — read-only sums of what turns used (*in part*).
- `steering.md` — a follow-up of the same person joins the running turn.
- `turn-retries.md` — a turn cut off after it posted carries on.
- `working-signal.md` — “{name} is thinking” after the agent said something.
- `goal-first.md` — agents work toward the goal (*in part*).
- `resourceful-agents.md` — keys by risk, one prompt that finishes the job, schedules (*in part*).
- `task-feedback.md` — true answers and the same choices on every surface (*in part*).
- `prompt-efficiency.md` — lean tool schemas, billed tokens (*in part*: Codex and prompt-hash rows are gone).
- `turn-efficiency.md` — warm sessions and forks, served tools by turn shape (*in part*).
- `turn-overhead.md` — Claude Code's tool search stays off; a short answer is the final message (*in part*).
- `turn-completion.md` — successful delivery, final answers after progress, bounded recovery of missing Chat answers, when a turn may end silently.
- `update-wait.md` — the box stays usable while an update waits for running work: sessions while draining, commands that wait out a short drain.
- `ask-before-updating.md` — the owner's switch: every update waits for their yes, enforced by the box's manager.
- `check-for-updates.md` — Check for updates: the box looks for a newer release now; by itself it still looks hourly.
- `weather-news.md` — where this Whombat is, MET Norway's forecast, the news sites the person chooses, their widgets and tools.
- `agent-efficiency.md` — checks that match the change, runs on a pull request's branch (*in part*).
- `agent-outcomes.md` — evidence on completion, capacity admission, evaluations (*in part*).
- `agent-computer.md` — *in part*: only the command guard holds (git control files, keys decide, Allow once/for this
  task/always, taking a key back); the computer itself is gone.
- `memory-pool.md` — *in part*: only what each row says still holds (a command's OOM score).
- `bp-memory.md` — *in part*: Whombat's own memory is gone; a failed resume is retried on a fresh session.
- `bp-acp.md` — *in part*: the ACP client's mechanics (permissions, a broken stream); host-configured runtimes are gone.
- `runtime-server.md` — runner protocol, MCP server, runs, pause and take over, the scripted provider, the demo (*in part*).
- `essentials-agents.md` — approvals that never claim work that didn't happen, push approvals, failed turns (*in part*).
- `key-requests.md` — the agent asks for a key with one button to give it (*in part*).
- `health-run-start.md` — a run's turn starts at once.
- `health-command-loops.md` — the same command failing the same way (*in part*).
- `run-checkout.md` — a run always works in a checkout of its branch.
- `run-reconciliation.md` — durable recovery of unfinished runs, approval ownership and activity updates.
- `run-line.md` — a quick run isn't announced.
- `card-settle.md` — cards settle into a line when nothing is active.

## Conversations, Home and notifications

- `chat-channel.md`, `chat-channel-server.md` — one threaded Chat with the agent, Feedback beside it (*in part*).
- `chat-asks.md` — asks and answers stay in the chat they came from; a command's card says why (*in part*).
- `chat-clear.md` — Clear chats, and the web sidebar's right-click menus.
- `chat-settle.md` — settling finished threads in Chat and Feedback, by hand or by themselves.
- `chat-inbox.md` — Chat and Feedback as an inbox: two-line rows, unread, filters, Mark as unread, settling read threads, the growing message box.
- `thread-unread.md` — which threads of Chat and Feedback have something new: a marker per thread, a dot, the badge.
- `channel-threads.md` — the agent answers a top-level message in a thread under it (*in part*).
- `channel-clear.md` — *in part*: clearing keeps threads with work in progress (Clear chats reuses it).
- `essentials-conversations.md` — edit and delete, pins, link previews (*in part*: channels are gone).
- `essentials-people.md` — notification levels, Do not disturb, quiet hours, email digests (*in part*).
- `notifications.md` — push through control, the box's own transports, live activities (*in part*).
- `push-words.md` — what a security push says and opens; a remote help visit is told in the Chat, not pushed.
- `rich-messages.md` — light Markdown, quick replies, the digest card.
- `visual-replies.md` — pages, charts and diagrams in a message: the app's theme, fit to height, `page_preview`, Mermaid on the phone.
- `page-sets.md` — a folder of pages shown as one file on a message (`show_pages`), its format, check, upload and viewer.
- `message-polish.md` — small changes to how messages show.
- `bp-attachments.md` — files in conversations for the person and the agent.
- `files-space.md` — Files per conversation and `~/files` (*in part*).
- `person-avatars.md` — the person's photo (*in part*).
- `search-pagination.md` — complete search with keyset paging and exact counts.
- `review-features.md` — Stop a turn, deploy records, thread pages, thumbnails (*in part*).
- `ui-improvements.md` — subscription usage probes, alerts (*in part*).
- `work-supervision.md` — plans, observed activity, searchable outcomes (*in part*: the Work view is gone).
- `work-removal.md` — the Work view is gone (server side).
- `one-whombat.md` — one Whombat for servers, home and services (*in part*).
- `one-whombat-assistant.md` — Done recently with Undo, widgets, snoozes (*in part*).
- `home-redesign.md` — Home and an honest Done recently.
- `quiet-notices.md` — what Whombat watches, and Ignore.
- `watch-defaults.md` — which checks Whombat watches from the start: only the very important ones it can act on.
- `monitoring.md` — monitoring servers, networks and services: your own checks, keeping quiet, one push per outage, one cause, uptime and outage history.
- `../app/decisions/monitoring-web.md` — monitoring on the web: Keep quiet… and End now, the hold under a page's head,
  What happened, Change the limit, catalog fields that follow another.
- `on-purpose.md` — stop watching what is set up so on purpose (the assistant asks and switches it on your word, the
  Inbox's More), and an Ignore that outlasts a blip.
- `look-research.md` — the assistant looks into a problem by itself and says what is wrong and what it can do.
- `looks-ahead.md` — the assistant checks what is on the person's calendar the afternoon before and tells them only a sourced mismatch.
- `needs-you-list.md` — one Needs you list (Watch merged), split by who has to act, one count, Ask in the thing's own
  thread, every push opens its item.
- `inbox.md` — Needs you is the Inbox: Later and Settled at its foot, Settle and More (hand it over, talk it over, remind,
  stop watching), the phone's swipe; Settled instead of Done for threads.
- `approval-card.md` — one approval card in the thread, its dialog, the Inbox and the phone: facts, permission and the
  exact later time before equal answers; an answer that may have gone through; the Inbox's one way forward and read states.
- `ui-refresh-status.md`, `ui-refresh-inbox.md`, `ui-refresh-chat.md` — the 2026-11-04 UI refresh from the design council: the status scale and its marks, the Settings row, the phone bar and drawer, Overview's pills and connection words (its cards are `overview-one-page.md`'s); Inbox rows, Settle's Undo, the Settled bar and approval cards; Chat's waiting chip, reply rows, thread header, the one composer and a service page's head.
- `overview-server-connection-final.md` — the final Overview, server page and connection page: the broken thing first, the same words on Overview and a server's page, each reading's own time, read states, heads-ups folded (*in part*).
- `overview-one-page.md` — Overview on one page: Servers, Connections and Pinned as sections with jump links; servers one list with the same columns (a card each on a narrow page and in the phone app), connections small tiles, Add in their headings.
- `overview-arranged.md` — the Overview arranged by the person: one layout per Whombat, Arrange as a mode with a gear on each tile (what it shows, its time span, its size, its place, Remove), the summary card with four chosen figures, Today, tiles read as the desk's widgets.
- `../app/decisions/phone-refresh-asks.md`, `../app/decisions/phone-refresh-status.md` — the 2026-11-05 phone refresh from the phone-app design council: approvals, screen readers, Inbox and Chat; status, Overview, headers, back and service page heads.
- `handle-it.md` — the assistant looks into every line of a thing, offers one plan with Go ahead, and asks in plain words.
- `care-plan.md` — a care plan when a server is added (one yes for backups and updates), quiet hours for changes, automation
  ideas from what is connected.
- `plain-words.md` — everything a person reads in the word list (your Whombat, Whombat’s helper, machines, apps), three
  lines per check, plain errors with More detail, schedules in words, Done for Settle.

## Automations and Feedback

- `bp-automations.md` — supervised automations: definitions, engine, leases, approvals bound to an action (*in part*).
- `automation-chat.md` — automations made and changed by talking to the agent: plan cards, turning on, not now.
- `automation-recipes.md` — recipes, GitHub issues, fixing bugs, Delete (*in part*).
- `automation-list.md` — the Automations list at a glance.
- `automation-run-review.md` — what run #9 taught us (*in part*).
- `report-trackers.md` — customers' reports in a report tracker through automations, tracker drivers as plugins,
  and the bridge that moved the first tracker's automations and the database to the next migration chain.
- `refactor-automation-engine.md`, `refactor-automation-steps.md` — the engine as a coordinator, step handlers.
- `feedback.md` — the embeddable bug-report widget and its assessments (*in part*).
- `feedback-drop.md` — reports reach the box through the encrypted drop.
- `share-links.md` — a thread of Chat shared by link: a sealed copy at control, the key in the link, 7 days by default.
- `team-reports.md` — reports to the Whombat Team: a Link person's problems and ideas, kept at control, followed on
  the box, drafted by the assistant only for the person's press.
- `kept-sites.md` — a website the agent asked to stay signed in to between its turns: its cookies sealed for a few
  hours, put back into each fresh browser, stopped in What it may do.
- `feedback-reporters.md` — the navigation trail and reporter sign-in (*in part*: the self-hosted routes are gone).

## GitHub and code work

- `github.md` — the mirror, its commands, copy and actors (*in part*).
- `github-gh.md` — polling instead of webhooks; identity on GitHub (*in part*: the host's `gh` is gone).
- `polling.md` — each repo polled on its own cadence.
- `agent-gh.md` — the agent's `gh`, run by Whombat for it.
- `agent-repos.md` — every repository the GitHub account owns is the agent's; others it names are added.
- `repositories.md` — repositories created on the Whombat.
- `merge-own-account.md` — merging an agent's pull request that GitHub shows as your own.
- `fast-testing.md` — Repositories and the build servers removed; `fast-test` is how work is tested; checklists merge by default and then go to DEV as the repository's AGENTS.md says, never production; what keeps a run short (a test retries by itself, the full check in parallel, the kept module cache, dependents instead of the full check, a throwaway Postgres).
- `pr-file-view.md` — a pull request's file, whole.
- `health-checks-wake.md` — a finished round of checks wakes the agent (*in part*).
- `ssh-upload.md` — copying a build to a server.

## The Vault and the browser

- `vault.md` — the person's logins and API keys for the agent (*in part*).
- `vault-self-serve.md` — the agent holds keys by default, saves what it is sent (*in part*).
- `vault-asks.md` — *in part*: a run's turn stays in the thread it was asked in.
- `vault-simplify.md` — the Vault for one person: one switch per entry, Hermes's plugin doors, MCP entries in Connections, one card that asks for every sign-in.
- `onepassword-sync.md` — a 1Password vault kept in step with the Vault, both ways: logins and API tokens, Whombat wins a clash, a guard on removals.
- `../app/decisions/onepassword-sync.md` — its screens on the web and the phone: the Vault's tag and line, KEPT IN STEP on
  the connection's page, the Inbox card's two answers, Remove's choice for the entries.
- `browser.md` — Vault logins in the browser, previews (*in part*: Whombat's own browser host is gone).

## Connections and servers

- `connectors.md`, `connectors-foundation.md`, `connectors-connections.md`, `connectors-google-tools.md` — Google
  accounts, the OAuth client, tokens and the 18 connector tools (*in part*: personal agents are gone).
- `accounts.md` — the person's accounts (Google, Microsoft 365, Email, GitHub) as connections, trashing mail, and
  what the assistant may do on each account's page.
- `ps5-connection.md` — PlayStation 5 homebrew, library, storage, approved updates, optional remote reboot and calm availability.
- `connections-catalog.md` — catalog connections (*in part*).
- `approved-connection-calls.md` — an approved connection call ends its approval as the call did, is settled after a crash without being sent twice, is signed only as the connections the yes was for, and an Undo goes only where its change went; a page's action signs only as the connection it was checked on.
- `connections-setup.md` — sign in once, Look only, found on your network (*in part*).
- `connection-signin.md` — connections that sign in properly (two-step, single sign-on).
- `connect-in-chat.md` — setting up from the chat: the connect card, the write-only Vault card, servers found on the network, Add a server's failure card.
- `connect-by-talking.md` — any MCP server or API connected by talking: the assistant fills in a Custom entry, the card takes the key and connects.
- `connection-dashboards.md` — every connection opens on a dashboard: a kind's own tab first when that is its dashboard (Find My's map), pages from Whombat's own records (report tracker, AI gateway), Notion, Airtable, Dropbox, Proxmox VE and Unraid, reads through “Sign in with …” connections, and the test that every catalog entry has one.
- `connection-looks.md` — a Custom connection's own logo (SVG turned into path shapes) and its page from a recipe the assistant writes.
- `connections-more.md`, `connections-more-server.md`, `connections-more-mail.md` — more connections, mail over IMAP/SMTP.
- `connections-page.md` — the page at `/connections`, Overview now (*in part*).
- `connection-pages.md`, `connection-pages-server.md` — a page per connection and device.
- `dashboards.md`, `dashboards-server.md` — one Summary for servers, connections and devices.
- `service-dashboards.md` — a page per service (Plex, Home Assistant…).
- `service-settings.md` — a service's settings on its page, changed by a switch, a sheet or the assistant, checked and put back.
- `service-slots.md` — a service's Summary in slots (Worth a look strip, Live, Inventory, Shelf, Trend, People, Machine) on phone, foldable and desktop.
- `t3code.md` — T3 Code through its MCP server for outside agents: a pairing code, 30-day sign-ins, its tools, its page,
  and its threads waking the agent.
- `council.md` — the council: several AI models of different providers on one question, each in its own T3 Code
  thread and copy of the project, led by the agent to one answer, plan or result; its card, its plan built through a
  delegation and checked.
- `prompts.md` — the person's prompts: after `/` in Chat, shipped ones in code, one used on a repository goes to a new
  T3 Code thread through the agent with its words unchanged.
- `delegate.md` — handing a list of tasks to T3 Code from one checklist card: ticks, a thread and branch per task, a few
  at once, checks passing and merged in turn, pictures, progress on the card, waking the agent only when needed, and
  talking about the card to change it.
- `delegation-recovery.md` — retrying independent GitHub verification without another review, narrow handling of plan
  restrictions, cleanup of completed T3 threads, and separate implementation, merge and deployment evidence.
- `one-chat.md` — one Chat: software work stays in Chat (Code removed), a thread row's work line, live cards' steps and
  quiet Stop, the phone's tabs and top row.
- `../app/decisions/one-chat-web.md`, `../app/decisions/one-chat-phone.md` — one Chat on the web and on the phone.
- `../app/decisions/job-view.md` — a T3 Code job's progress in its thread: plan, pull request, changes, checks,
  answers, receipt; no stage track.
- `../app/decisions/job-result.md` — a T3 Code job's result as a message: the report's parts, answering what is left
  for you, the facts line.
- `../app/decisions/council-web.md`, `../app/decisions/delegation-web.md` — the council and delegation cards on the web.
- `../app/decisions/prompts-web.md`, `../app/decisions/prompts-phone.md` — the person's prompts on the web and the phone.
- `card-moves.md` — a live council's or checklist's card moves to its thread's end with its next news, the words it
  left link to it, and where the person talked about it the card as it was stays, folded.
- `../app/decisions/code-job-chat.md` — a code job in a long chat thread on the web and the phone: a moved card's link,
  a permission said once, a council waiting for its checklist's Hand over.
- `chat-threads-cards.md` — the final design's Chat rows (stage from the thread's flags, your face but no name on your own messages, one ⋯ on phones) and the cards' one layout (plan, council, checklist, run).
- `server-pages.md` — a server's and a machine's page opens with a verdict; Technical details folded; temporary machines hidden.
- `page-speed.md` — page speed of connection pages.
- `marks.md` — logos for servers and connections.
- `one-whombat-servers.md` — servers through the hosts service (*in part*).
- `one-whombat-consoles.md` — consoles through the session.
- `one-whombat-devices.md` — devices Whombat doesn't support yet (*in part*).
- `proxmox.md`, `proxmox-server.md` — full Proxmox support.
- `incus-unraid.md`, `incus-unraid-server.md` — Incus, unRAID and QEMU/KVM.
- `server-signin.md`, `server-signin-server.md` — add a server by signing in once.
- `server-asks.md`, `server-asks-server.md` — per-server “Asks you first”.
- `server-names.md` — names people give servers, renaming servers and connections where they are listed.
- `server-updates.md`, `server-updates-server.md` — software updates on servers.
- `macos-servers.md` — Macs as servers: the macOS agent, the screen through Screen Sharing, Whombat Helper.
- `findmy-connection.md`, `../app/decisions/findmy-connection.md` — Find My as a connection through a Mac: its check, background reads, arriving and leaving automations, the assistant's tool.
- `findmy-timeline.md` — a Find My connection's timeline: what the box keeps of whom and for how long, reading for it, its routes and map, the assistant's `findmy_timeline`.
- `../app/decisions/findmy-timeline.md` — a Find My timeline in the apps: the Timeline tab, before it's on, the strips and a colour per place, the map's marks, whose and the assistant switch.
- `findmy-watch.md` — one-time Find My watches: “tell me when Noor leaves”, the rule that says it happened, its card, pace and ends, the assistant's `findmy_watch`.
- `agent-updates.md`, `agent-updates-server.md` — servers' agents keep themselves up to date.

## Skills, guides, backups

- `skills-library.md` — *in part*: packs and Whombat's library are gone; some Files-tree and Vault-defuse rows hold.
- `assistant-guides.md` — guided setup with cards in the Chat (*in part*).
- `assistant-settings.md` — the assistant finds, reads and changes every setting for the person: the settings map, four tools, the `settings.change` key, the `whombat:settings` skill.
- `brief-removed.md` — there is no morning or evening brief: what went with it and what stays for old data.
- `first-day.md` — from the claim to a useful assistant: Connect your AI as a claim step (web and phone), the welcome built
  from what the network scan found, backups proposed from what is there, first screens with one step.
- `less-is-more.md` — the hosts service's OOM alert, narrow charts (*in part*).
- `backup-file.md` — the encrypted backup file: make and restore (*in part*).
- `backup-options.md` — the list of backups, the options (how often, what to keep, the space limit, the weekly check) and bringing a Whombat back (its kit rows *in part*: see `backup-passkey.md`).
- `backup-look.md` — getting one thing back from a backup: the box opens it for reading, lists it, and brings the picked things back through the backup file's restorer (only adds); the assistant's `backup_bring_back`.
- `backup-passkey.md` — the passkey as the key to the backups: arming in one touch, locking again, the copy next to the backups (the place's kit user), bring back from the account or the network, the paper copy, the Inbox's ask.
- `backup-places.md` — a NAS or server that keeps this Whombat's backups: the backup app, cleanup, places, moving, by hand.

## Server internals

- `server-core.md` — schema, key custody, commit pipeline, dispatch queue, approvals engine, realtime (*in part*).
- `collab-server.md` — the collaborative canvas, server side.
- `preview-security.md` — preview resource isolation, offline Mermaid and box browser credential removal.
- `security-fixes.md` — design choices from the September security review (*in part*).
- `refactor-runtime-boundaries.md` — atomic dispatch, durable GitHub merges, shared recovery, catalog modules, handler contexts and runtime browser tests.
- `server-efficiency.md` — read indexes, background hooks, the runner’s long poll, housekeeping jobs and their deadlines.
- `reliability-audit.md` — stream ownership and cancellation, session failure isolation, event delivery recovery.
- `stack-optimization.md` — bounded/grouped reads and replay, automation hydration, transfer cancellation, shared activity redaction, desk identities, client pages and terminal styles, frame/console buffering, CIDR parsing, event queues, cron and Markdown; the web page's boot preloads and calmer renders, once-per-request Home/desk/MCP/poller reads, command launch and production lookups, shared web/phone and contract logic, local test caching and ordering.
- `refactor-dispatch-context.md`, `refactor-home-reads.md`, `refactor-node-http.md`, `refactor-archive-parsing.md`,
  `refactor-runner-api.md`, `refactor-runner-turn.md` — runtime-only refactors and their boundaries.
- `installer-signature.md` — what the installer's checksum proves, and the signature planned for it.
- `bp-distribution.md` — *in part*: release manifests, reproducible archives, signatures, the migration lock;
  self-hosted install and upgrade are gone.
- `cli.md` — *in part*: only CLI-02 holds (the CLI imports `@whombat/server/host` alone).
- `auth-selfhost.md` — *in part*: only AH-09 holds (route checks use the matched route, not the raw URL).
- `seed-wiring.md` — the mock world in the seed (*in part*).

## Clients, contracts and design (`apps/web`, `apps/mobile`, `apps/widget`, `packages/`)

whombat-app's and whombat-contracts' own decision files, from before they moved into this repository, are in
`docs/app/decisions/` (AP- codes) and `docs/contracts/decisions/` (CT- codes).


- `core-contracts.md` — `@whombat/core` layout and conventions.
- `fixtures.md` — the mock world as typed fixtures.
- `client.md` — `@whombat/client`.
- `tokens-primitives.md`, `brand.md`, `crew.md` — tokens, the logo, the five faces' art (*crew in part*).
- `web-shell.md`, `messaging.md`, `cards.md`, `runs-approvals.md`, `audit-search.md`, `canvas-editor.md`,
  `canvas-onboarding.md`, `states.md`, `accessibility.md`, `visual-regression.md` — the web app's workstreams
  (*messaging, canvas-onboarding in part*).
- `web-push-connect.md` — desktop push and the needs-you indicator (*in part*).
- `sidebar.md`, `settings-sidebar.md`, `settings-simplify.md` — sidebar and Settings copy (*settings-simplify in part*).
- `sidebar-tabs.md` — Servers and Connections as sidebar tabs, Overview, Settings → Connections.
- `final-shell-web.md` — the web's nine places in one order, the phone bar and Places drawer, the grouped Search, Usage.
- `final-settings-vault-files-usage.md` — the final design's Settings home, Vault rows, Files home and Usage (the Spend report).
- `settings-phone-link.md` — Settings' Phone app row, Devices' Add a phone / Add a computer, one fingerprint card, the Mobile
  app page by state and on a phone, Settings at a phone's width, the home's rows saying how things are, plainer words,
  Connections on the home, Phone app inside the app, Advanced cleaned up (keys and home networks in What it may do, GitHub
  and Website feedback as connections, schedules in Automations).
- `settings-groups.md` — Settings in groups (You · the assistant · Connections · This Whombat · Advanced), what the assistant may
  do in three words, old addresses, connections added on Connections, developer things gated, the Vault in plain words.
- `mobile-app.md`, `mobile-live.md`, `phone-connect.md`, `bp-fix-mobile.md` — the Android app (*mobile-app in part*).
- `../app/decisions/phone-audit-1112.md` — the phone after the 2026-11-12 audit: failures in an alert, never a toast; the updater has no Stop.
- `phone-shell-final.md` — the phone's final shell: the tabs with Search and Places above them, the Places sheet, Back
  first on pushed pages, the Search page, readable iPhone badges, Spend shown as Usage.

## Tests, CI and documentation

- `test-speed.md` — what makes tests fast; when a test needs Postgres.
- `fake-contracts.md` — the apps' fakes keep to the contract: a test fails when the app left part of a fake's answer out.
- `test-pruning.md` (and `test-pruning-audit.json`) — the 20 % test reduction and its audit.
- `ci-performance.md`, `local-ci.md`, `local-ci-infra.md`, `local-ci-tests.md` — CI on The Titan.
- `ci-selection.md` — PR unit-test dependency selection, exact base validation and conservative full-suite fallbacks.
- `runtime-ci.md` — the runtime check's CLI and Hermes plugin phases, deleted review-shot specs, pinned-CLI test isolation, node on a development host's commands PATH.
- `polish-ci.md`, `post-merge-regressions.md` — flaky tests and regressions traced to their cause.
- `ci-app-journeys.md` — the `app` job's browser journeys: a bundled build instead of the dev server, own output folders, the real chat smoke test.
- `public-copy.md` — working in public: the public root commit, what is public and what lives in whombat-ops, the guard list, public CI, pull requests, commit identity.
- `refactor-runtime-docs.md` — runtime documentation after the repository split (*in part*).
- `one-repo.md` — whombat-app and whombat-contracts merged into this repository: layout, versions, releases, CI; and
  the appliance and the hosts service as the folders `appliance/` and `hosts/`: copies, the sync, the checks.
- `build-deployment-speed.md` — DEV delivery: one runtime build, shared source preparation, parallel page builds and comparable timings.
- `licence-notices.md` — `THIRD_PARTY_NOTICES.md`: what the generator must describe, what isn't open source, the check.
- `docs.md` — how ARCHITECTURE.md, DECISIONS.md and this folder are kept.
- `public-readme.md` — the README as the public front door, its pictures from the demo world (`pnpm readme:shots`), the developer guide in `docs/development.md`.
- `decision-ids.md` — one file defines each decision id, ids cited in code are in the docs, a shrinking list of exceptions.
- `automations-final.md` — the final Automations list: compact one-link rows, run results in words, its loading, empty and failed states.
