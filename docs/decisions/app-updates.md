# Safe app updates with automatic rollback (APU)

Part of the “look-after” work of 2026-11-28 for John (stream app-updates). Whombat's helper already said when a Docker
container had a newer image; updating it was the person's chore, done by hand on the server. Now Whombat updates a
Docker Compose app itself, one service at a time, watches it come up, and puts the previous version back by itself
when it doesn't — asked through the same approval card as everything else, from the server's page, a service's page,
the assistant or the care plan.

Contracts (additive): `HostGuest.app` (`HostGuestApp`), `HostTask.apps` (`HostAppResult`), the `hosts.manage` op
`app.update` (`HostAppUpdateParams`) and its answer's `approvalNumber`, the pure rules in `@whombat/core`
(`domain/app-updates.ts`), the Servers tools `app_updates` and `app_update`, the care plan's `apps` automation
(`CareAutomationKind`). Session protocol minor 22 (`APP_UPDATES_MINOR`). No migration. The hosts service: the agent's
`app.update` task and its apps report, the hub's `POST /servers/{id}/apps/update` (hosts `docs/MANAGE.md` 2.11,
`AGENT-PROTOCOL.md`). It changes CPL-03 (marked there).

## What happens

| # | Decision | Why |
|---|---|---|
| APU-01 | **Only apps Docker Compose started are updated.** A container with Compose's labels (its project's folder, its files and its service) is an app; one `docker run` started stays watch-only, and its server's page says “Whombat can update apps started with Docker Compose.” | Compose keeps the app's own files and settings: recreating the one service from them is what the person would do by hand. A `docker run` container's options exist nowhere Whombat could read them back from. |
| APU-02 | **One update is one task on the server: pull, recreate the one service, watch, and go back by itself.** The agent writes down the running image, tags it `…:whombat-previous-<service>`, pulls the service's image, recreates only that service (`docker compose up -d --no-deps`), then watches: running, not restarting, healthy when it has a health check, for 30 seconds (a health check gets up to 5 minutes). When it doesn't come up, it tags the previous image back and recreates the service without pulling. Up to ten apps in one task, one after another, 30 minutes each and three hours at most; one app task at a time per server. | A failed update must not leave the app down until someone looks: going back is part of the update, not a second request. The service's own files decide everything else, so nothing but its image changes. |
| APU-03 | **Every update asks through the existing approval card** (*Yes, now · Yes, tonight · No*). Update on a page doesn't run anything: the box commits the assistant's `app_update` for the person, with `ask: true`, in their own Chat; the card goes to the Inbox too and the page opens it. There is no second way to say yes. | One approval path: what the card says is what runs, *Tonight* means the quiet hours for changes, and the yes is in the audit log like every other. |
| APU-04 | **A database's update and a new major version always ask, and the card says why.** A database is known by its image's name (postgres, mariadb, mysql, mongo, redis, valkey and the like); a major jump by the versions the image labels say. The card says that going back can't undo what a database's update did to its data. An image whose version isn't known (`:latest`) may update; its card says the version isn't known. On a server set not to ask, the other apps update without a card; these never do: the tool refuses them without a yes whose reasons cover them. | Those are the updates that can break or lose data; going back to the old image doesn't undo a migration, so the person decides knowing that. A plain version bump of an ordinary app is what people want done for them. |
| APU-05 | **A snapshot first when the server is a Proxmox guest Whombat watches.** The page's Update takes one by itself (the card says so); the assistant offers it (`snapshotFirst` in `app_updates`, `snapshot: true`). A snapshot that fails stops the update. A server that isn't such a guest updates without one. | A snapshot is the one way back that also undoes a database's change, at no cost to the person; it is offered, never required. |
| APU-06 | **One plain line where the yes came from.** “immich_server is updated to 2.4.”, “immich_server 2.4 didn’t start, so I put 2.3 back.”, one sentence per app (four at most, then how many more). Done recently records it as Whombat's own work, and the server is kept quiet while it runs and 15 minutes after (planned work, monitoring.md). | The person wants to know whether it worked, not the log; a restart Whombat caused itself is no alarm. |
| APU-07 | **The care plan updates apps on Sunday night.** A server with Compose apps gets “Update your apps on Sunday night at 03:00”: an automation Whombat turns on with Go ahead, running at the start of the quiet hours of the night from Sunday to Monday (Sunday itself when they start in the evening). It updates only the apps safe to update by themselves (`hold_major`: an app whose new version turns out to be a major one stays as it is) and asks about the others in one card. | Apps get updated without becoming a weekly chore, never on the night the system updates may restart the server, and the risky ones wait for a person in the morning. |
| APU-08 | **The assistant reads and updates apps with two tools.** `app_updates` lists each server's apps with a newer version, which ask first and why, and how the last update went; `app_update` updates them. Before an update a person asked for, the assistant may read the app's release notes in the turn; Whombat keeps no release-notes crawler. | The same facts and the same path as the page; reading release notes is the assistant's judgement, once, when it matters. |
| APU-09 | **Old and new work together both ways.** An agent from before app updates reports no apps: the page says the server needs Whombat's newer helper, which it gets by itself, and the tools say so. An older hub never sends apps, so a new agent's apps are simply not offered. An app from before minor 22 shows nothing about app updates on a box that doesn't send them. | Agents update themselves on their own schedule; nobody should see a button that can't work or a note that blames the wrong part. |
| APU-10 | **Not now:** Compose apps outside Compose's labels (Portainer stacks without them, Unraid's own templates keep `container_update`), a change log of what changed in an image (another stream), updating several servers' apps in one card, and the fake fleet simulating app updates. | Kept to what is safe and testable today. |

## Server details

| # | Detail | Why |
|---|---|---|
| APU-S01 | The newer image's version is read from its version label (`org.opencontainers.image.version`) once per new digest, with the same registry read as the update check (one more request for the config). A version of 1000 or more is a calendar version: it has no major number. | No extra polling, and a year changing isn't a breaking change. |
| APU-S02 | An image named by digest is `pinned`: it isn't offered (its Compose file says which exact image runs). This Whombat's own containers (`whombat.service`) are never updated by the tool. | Pulling again would change nothing, and Whombat updates its own services itself. |
| APU-S03 | The card's words come from the call's `reasons` (`database`, `major`, `version_unknown`) and `snapshot`, so the card and the run agree; a yes whose reasons no longer cover the apps' refuses and asks again. | A card can't read the server; the call carries what it must say. |
| APU-S04 | The hub's route needs Full control, a recent sign-in and `confirm`, and answers 409 `agent_outdated` when the server reports Compose projects but no apps. The capability is the apps report itself, not a flag. | Same guard as installing system updates; the report already says what the agent knows. |

## Rows for DECISIONS.md

| # | Decision |
|---|---|
| APU-01…APU-06 | **Whombat updates Docker Compose apps and goes back by itself**: one service at a time, watched until it runs and is healthy, the previous image put back when it doesn't come up; always through the approval card (page, service page or assistant), a database's or a new major version's update always asks and says going back can't undo it, a snapshot first on a Proxmox guest, one plain line after. (`app-updates.md`) |
| APU-07 | **The care plan updates apps on Sunday night**: safe apps by themselves in the quiet hours, the others as one question. (`app-updates.md`) |
