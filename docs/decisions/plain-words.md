# Plain words (PWD)

The “effortless” work of 2026-10-30 for John: make Whombat easy and effortless for people who aren't developers, with
the assistant doing the work. This stream is the plain-words sweep: everything a person reads says it in the shared word
list (common brief; `copy.md`'s word list), and lines that cry wolf go quiet. The review behind it is `copy.md` §3–§6
and “Noisy checks”, and `visual.md` #9, #11, #12, #14, #17, #20, #21, #26, #27, #33, #36, #38 (#38 was already done by
STG-08). Every finding was checked against the code as wave 1 left it; what was fixed already was left alone.

Code: shared words in `@whombat/core` (`domain/host-watch.ts`, `domain/schedules.ts`, `automations/schedule.ts`
`cronWords`, `text/turns.ts`, `text/copy.ts`, `keys/catalog.ts`) and `@whombat/client` (`http/problem.ts`, `chat/settle.ts`,
`chat/runtime.ts` `ranOnMarked`, `hosts/agent-updates.ts`, `hosts/format.ts`, `home/quiet.ts` `noticeLink`,
`home/thingPage.ts` `runsOnParts`); the server's words in `apps/server/src/hosts/` (`agent-updates.ts`, `sources.ts`,
`words.ts`), `apps/server/src/things/` (`quiet/items.ts`, `panels.ts`, `machine.ts`, `runs-on.ts`, the kinds),
`connections/notify.ts`, `automations/` (`notice.ts`, `steps/`), `schedules/commands.ts`, `vault/withhold.ts`,
`deployments/commands.ts`, `app.ts`; the web's `components/MoreDetail`, `features/automations/GlanceRow.tsx`,
`features/chats/runtime/RanOn.tsx`. No contract, schema or migration changes.

| # | Decision | Why |
|---|---|---|
| PWD-01 | **“burrow” is never said to a person.** Errors, labels, toasts, key descriptions and the agent's tool words say “your Whombat” / “this Whombat” (the 404 page, Search, “Couldn’t reach your Whombat”, “This Whombat already has a repository called …”, the key group This Whombat). Identifiers, contracts' developer summaries, comments and the recipes' instructions to the agent keep the word. Onboarding and the claim screens are the first-day stream's. | An internal name; to a person their box is their Whombat. |
| PWD-02 | **The program on a server is “Whombat’s helper”**: its update hints (“Whombat’s helper didn’t update” · “It’s still on the version it had. Try again on the System tab.”, “Whombat’s helper needs one more install”), the switch “Keep Whombat’s helper up to date”, install steps, empty tabs (“No word from this server about its disks yet.”), the phone's card and every refusal. Update titles don't carry the server: they always show on or with it. Proxmox's own guest agent is “Proxmox’s helper”, and its line “It doesn’t report what’s inside”. | “Agent” is the assistant's word; two meanings in one app confused both. |
| PWD-03 | **What Whombat watches names its checks as people say them** — machines, apps, storage, background services, Whombat’s helper (“Machines with an old backup”, “Slowed down by its host”, “Background services stopping”, “Storage missing a disk”, “App updates”) — and each Ignore sentence reads after “Ignored by John” (“until there’s another one”, “until it checks in again”). Needs you's way-outs and a server line's buttons say backup plan, automatic restore points and “See …” (“Add it to a backup plan.”, “Install it on the System tab.” for one update, “Check that Proxmox’s helper runs inside it.”). The host fixtures carry the titles whombat-hosts writes now (HS-200, HS-201), so screens and tests show a real Whombat. | The menu is where people decide what to keep watching; jargon there means they can't. |
| PWD-04 | **At most three lines per check on a connection's Worth a look**: every item when there are three or fewer, else two and one “N more” line (`ITEM_LINES_MAX = 3`, `splitItems`). | Eight lines per check, each with its own ⋯, made the card a wall. |
| PWD-05 | **Updates are one line**: a service's own is “{Product} has an update” with the version in the detail; UniFi firmware is one line for every device (“3 devices have updates” · “Hallway AP and 2 more”), Nextcloud's apps one line (“4 Nextcloud apps have updates”), Hetzner's backups and delete protection one heads-up each for all servers; their Ignore lasts while the same set waits (`shortHash`). Those checks are no longer per item. | One way to say one thing, and routine news said once. |
| PWD-06 | **Amber only when the person should act this week.** Home Assistant's error count in its log makes no line (one integration flooding it still does); a TrueNAS pool never checked yet makes no line until its schedule is missed; a connection's disk at 75–89 % with no fill-up in sight and “Whombat couldn’t read it just now” are grey heads-ups. | Lines that are always there, or amber without anything to do, teach people to ignore the card. |
| PWD-07 | **Whombat's own title, the service's words as the detail**: TrueNAS alerts by class (“A disk reports a problem”, “The clock is wrong”, “Storage isn’t working properly”), Sonarr/Radarr health (“Sonarr: search sites failing”), Pi-hole's and OPNsense's messages (“Pi-hole has a warning”); TrueNAS speaks of storage and data checks (“Check now”), a service's own clear button says where it acts (“Clear in TrueNAS”, “Clear in SABnzbd”). | Admin log lines as titles; the service's text still helps whoever reads the detail. |
| PWD-08 | **A lost sign-in reads “needs you to sign in again”** with the button **Sign in again**, on every page, card, toast and the chat message, which the assistant says plainly: “Google stopped accepting my sign-in, so I can’t use it for now. You can sign in again in Settings → Connections.” The generic connection lines: “Whombat can’t reach it”, “It’s answering with errors”, “Whombat can do 2 new things here”. | The word list's one phrase for one situation. |
| PWD-09 | **A connection line's ask button is “Ask {assistant}”** whatever its kind wrote (`noticeLink(n, askLabel)` on the web and the phone), named for a screen reader “Ask Neo about {title}” so it never repeats the head's Ask. | 58 kinds wrote “Look into it”; the shared words say Ask {assistant}. |
| PWD-10 | **A machine is named by its name and its server**: “homeassistant (pve-02)”, “Runs in homeassistant on pve-02”; Proxmox's number (“CT 131”) only for a guest without a name. The runs-on picker and the page head read the same shape (an older runtime's “pve-02 · CT 131” still splits). | Numbers mean nothing to most people. |
| PWD-11 | **Schedules in words**: “Every weekday at 08:30”, “Every Friday at 16:00”, “On the 1st of every month at 09:00”, another zone named by its city (“(New York time)”), and “On its own schedule” for what words can't say — never a cron expression, never the Whombat's own zone. One describer (`cronWords`) for the assistant's schedules and automations. The chat line is the schedule itself (“Every weekday at 08:30 · Check last night’s backups…”), the message “I’ll come back to this every weekday at 08:30.”, the tab “Reminders and checks {assistant} set for itself.” with Next · Stops · Times run in the UI font. | #27: cron and time zones. |
| PWD-12 | *Superseded by inbox.md IBX-08: a thread put away is Settled.* **Settle is Done**: Mark as done, Done threads, “Done 2 hours ago”, “Mark quiet threads as done”, “Mark done when a pull request merges”; the action and its rules are as before (CS-*). | “Settle” is an internal word; people finish things. |
| PWD-13 | **Chat says nothing that needs nothing**: a fast reply that was only busy or briefly unavailable gets no line (credits or an organisation's setting still do), and the provider's mark after a reply's time shows only where more than one AI can answer (`ranOnMarked`: two providers ready); the full line stays on hover. | The note and a mark on every reply were noise with one AI. |
| PWD-14 | **Posts name the automation and link the run**: ““Weekly invoices” didn’t finish. {Whombat's reason}. [See what happened](…)”, “… is waiting for you to check a step.”, “… was stopped.”; change titles “Ran “X””; a step's summary drops “(request #34)”; its AI limit is “This run reached its AI limit.” A GitHub deploy ends “failed”, “was cancelled”, “took too long”, the run's page as the deploy's link. | Run numbers, request numbers, bare addresses and enum values in people's words. |
| PWD-15 | **What failed says it plainly**: after a yes, the platform's error goes through `taskReason` (“I couldn’t restart web on pve-02: the server didn’t allow it.”, else no reason); a failed reply reads “I couldn’t get started.”, “This took too long, so I stopped.”, “I was interrupted before I could finish.”, its pill COULDN’T START, TOOK TOO LONG, INTERRUPTED, AI SERVICE PROBLEM, PROJECT PROBLEM; “part of Whombat is restarting” for a runner that is down; the Vault's take-back is in the first person without capitals. | Sandboxes, runners, turns and raw hub text in chat. |
| PWD-16 | **One plain-reason helper for errors** (`@whombat/client` `problemOf` / `problemText`, the web's `writeProblem` and the phone's `errorText`): the server's own sentence stands; a bare status (“Request failed with status 502”), an endpoint's id, a schema's wording or a network error's name becomes “Can’t reach your Whombat. Check your connection and try again.”, “Your Whombat didn’t answer properly. Try again in a moment.”, “Check what you typed and try again.”, “This app needs an update for that.”, “That’s too big to send.”; the raw words are its `detail`, shown under **More detail** where there is room (Files' dialogs, `components/MoreDetail`). The server's own Fastify 4xx words go to `details.said`, the message plain. | A dozen sites showed `e.message`. |
| PWD-17 | **Dates day first**: server pages say “6 Oct, 14:00”, a parity check before this year “10 Jul 2024”, in the Whombat's time zone. | “Oct 6” is US order; the brief's “2 Oct”. |
| PWD-18 | **An automation's card is calm**: its name, its sentence, how the last run went in words (“Done 23 Sep · Next run 09:00”, no run bars, no number), one link when something waits (“{Assistant} needs your yes · Open”, “Waiting for you: a change to look at”), **Talk about it** and ⋯ (Run now or Try it, Details, Delete), the switch; its page's crumb drops VERSION n. | #26: four equal buttons, run bars and numbers. |
| PWD-19 | **Monospace and capitals stay for code and ids**, applied sparingly here: the schedule facts and an automation's last run are in the UI font. The spec's mono status pills are unchanged: changing them is a design decision for the references (visual.md #14). | Mono reads as code; the mocks still win on the rest. |
| PWD-20 | **Smaller words**: server cards count “13 of 21 machines running” (“apps” on a Docker-only server, “Nothing running on it”), the fleet line “66 of 133 running”, “Everything running on your servers”; Search “Search everything”, “answers from your chats and files, with sources”; “Every reply and task uses this”; the heat pump being learned says what the assistant can read and asks one thing (Choose). | The rest of copy.md §5 that wave 1 left. |

## Not done (and why)

- **Skills as a plain “{assistant} can…” list** (#20) and **AI usage meters only near a limit** (#21): Settings → Advanced
  pages the settings stream just rebuilt; left for a later pass rather than reworked again the same day.
- **The Connections grid as one plain line per card** (#12): only its words changed (machines and apps); the tiles stay
  until a design for the card exists.
- **Status pills, tile labels and section headers in mono** (#14): the spec defines them; a design decision first.
- **“burrow” in onboarding and on the phone's first-run** (`OnboardingScreen.tsx`, `packages/client/src/managed/copy.ts`,
  `apps/mobile/src/managed/ApplianceRoot.tsx` “Burrow name”, “Whombat couldn’t load your burrow.”): the first-day stream's
  files.
- **“What Whombat watches” only for the server's kind** (copy.md §5 #8): a list change, not words.

## Superseded rows

- `docs/decisions/quiet-notices.md` QN-03 in part (“past eight, the rest is one line”: three, PWD-04; update checks no
  longer per item, PWD-05).
- `docs/decisions/chat-runtime.md` CR-07 in part (the mark after every reply: only where more than one AI can answer,
  PWD-13) and CR-08 in part (the busy and unavailable fast-reply lines, PWD-13).
- `docs/app/decisions/chat-settle.md` in part (the words Settle, Settled, Settle thread: PWD-12).

## Rows for DECISIONS.md

- PWD-01…PWD-03 **People read plain words**: never “burrow” (your Whombat), never “agent” for the program on a server
  (Whombat’s helper), check names and way-outs in the word list (machines, apps, storage, backup plan). (`plain-words.md`)
- PWD-04…PWD-07 **A connection's Worth a look stays short**: at most three lines per check, updates one line, amber only
  when the person should act this week, Whombat's own titles with the service's words as the detail. (`plain-words.md`)
- PWD-08…PWD-15 **Chat and pages say it like a colleague**: “needs you to sign in again”, “Ask {assistant}”, machines by
  name, schedules in words, Done for Settle, no notes or marks that need nothing, automations and failures without
  numbers or raw errors. (`plain-words.md`)
- PWD-16…PWD-20 **Errors in plain words with More detail; dates day first; Automations cards with one button.**
  (`plain-words.md`)
