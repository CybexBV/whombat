# The Automations list at a glance (contracts 0.72.0, CT-328)

John, 2026-10-10, on the Automations page: “I would like to improve the Automations page visually … perhaps we can add
the logo of the GitHub repo for example? How can we improve the UI, what do you suggest?” A mockup with six changes (a
tile per source with the GitHub owner's picture, trigger → agent → room chips, tags for what it may do, the run history,
a line when a run waits on someone, the On/Off switch in the list); John: “Yes, implement this fully”. Contracts
CT-328 (0.72.0), whombat-app `docs/decisions/automation-list.md` (AP-1080…AP-1099).

## Design

**AL-01 — What a row says comes from the runtime.** The glance (`Automation.glance`) is made by core's
`automationGlance` on the server, next to `summary`, with the same names per viewer (a room the viewer isn't in reads
“a private room”). Web and Android only draw it, so they can't disagree, and an older app ignores it.

**AL-02 — A repo's “logo” is its owner's picture.** GitHub repos have no logo of their own; the owner's picture
(person or organisation) is what GitHub itself shows. The app draws logos and never loads images from elsewhere (the
strict CSP, boxes without internet), so the Whombat fetches the picture and hands it over as a `data:` URL
(`github.avatar`). Without one, the app draws GitHub's mark.

**AL-03 — Tags say how far it reaches.** What an automation may do is shown mildest first, coloured by reach: reading
and answering plain, changing code or calling out amber, merging by itself red. A row that merges by itself is
visible at a glance; that was the point of the long subtitle, which goes.

**AL-04 — Waiting on a person is named, waiting on anything else isn't.** A run summary says when it waits for a
person's yes or review (`waitingOn`); a run waiting for an agent, checks or time is only an amber bar.

**AL-05 — On and off in the list** for people who may manage automations (`canManage` on the list), the same call and
rule as on the automation's page.

## Server

| # | Decision | Why |
|---|---|---|
| AL-S01 | **Superseded in part by one-person.md OP-S69**: the glance is still made on the server from the same definition, and it names every room for the person, with no “a private room” and no per-recipient frames. **The glance is made on the server, wherever an `Automation` is** (`toAutomation` in `automations/store.ts`, through `glanceAs` in `visibility.ts`): core's `automationGlance` of the live definition, else the valid draft — the definition `summary` describes —, null without one. Rooms and the tracker connections are named exactly as in `summary`: a room the viewer isn't in reads “a private room” (BP-C24). `definitionRooms` now includes a definition's own room (where a step editor's automation answers). Realtime `automation.updated` frames are stored with no room named and the hub names them per recipient (`personalizeAutomationFrames`), as for `summary`. | List, detail, publish, switch, run detail and frames say the same, and the web and Android only draw it. |
| AL-S02 | **Recent runs for the whole list in one query** (`recentRunSummaries`: a lateral join over the runs' `(automation_id, created_at)` index, ten per automation), newest first by when they were made, the run number breaking a tie. `lastRun` is its first entry: the same run as before. Every run counts, test runs too, and no room filter, as for `lastRun`: a summary carries no content, and opening a run still needs its room. One automation (detail, frames) reads its own with the same query. | No query per row however long the list; the history and `lastRun` can't disagree. |
| AL-S03 | **`waitingOn` in the same query**: `review` when the run needs review; `approval` when it waits and one of its steps waits on an approval that is still pending — any step that asks a person (`request_approval`, and an agent step, pull request, GitHub comment, the tracker write-back or merge whose key asks); null otherwise (an agent, checks, time). | Every one of these needs a person's yes in the thread; the list should say so whichever step asked. |
| AL-S04 | **The list's `canManage` is the detail's rule** (people who may publish: `agents.manage`, today every person, BP-C22). | One rule for the switch wherever it shows. |
| AL-S05 | **`github.avatar` shows only owners the burrow has a reason to show**, to its members (burrow route): the owner (any case) has one of the burrow's GitHub repos (`repos`, not `local/…` ones, which aren't on GitHub), or a repo an automation of the burrow that isn't deleted watches — GitHub triggers or a recipe's `when.repo`, of its live version or its saved draft (valid or not). Anyone else is a 404 before anything is fetched. | The Whombat must not become an open image proxy. |
| AL-S06 | **Fetched through the GitHub adapter, without a token** (`GitHubAdapter.ownerAvatar`): `GET https://github.com/<owner>.png?size=88`, redirects followed only to `https://avatars.githubusercontent.com/` (at most 3), 5 s for all of it, at most 48 KiB read. With no adapter (GitHub off) the same fetcher (`github/avatar.ts`) runs alone. The fake answers a 1×1 PNG for every owner and no picture for `nopicture`. | Pictures are public: they show with gh logged out, before anyone connected GitHub on a managed box, and with GitHub off. |
| AL-S07 | **Kept in memory only** (`GitHubService.avatars`): per owner (lowercase), a picture for 24 h, no picture or a failed fetch for 1 h, one fetch per owner at a time, at most 500 owners (the oldest out). No table, no migration, no commit pipeline; a restart starts empty. | It is a cache of public pictures, not something a person did: nothing to sign or audit. |
| AL-S08 | **The answer**: `{owner, image}` with `owner` as asked; `image` a `data:` URL typed from the bytes (PNG, JPEG, GIF, WebP; never SVG, never what GitHub said), or null when GitHub has none, couldn't be reached, sent something else or more than 48 KiB. A 404 means only “not an owner this burrow shows”; 400 is a parameter that isn't a GitHub login, 403 someone outside the burrow. | The client draws the GitHub mark for a null image and never retries a 404. |
| AL-S09 | **The runtime advertises `automations.glance`.** | Clients draw the new rows, the run history, the switch and the pictures only where all of the above is there. |
