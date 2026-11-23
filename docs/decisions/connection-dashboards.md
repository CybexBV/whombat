# A dashboard for every connection

John, 2026-11-23: “When I click on a connection we sometimes get a dashboard (like Hetzner), but sometimes we get a
summary (like FindMy). I want (when possible) to have all connections show dashboards when we click on them by
default.” He had the connections researched (Fable 5.2, Muse Wonder Full and Opus), read the plan and said “Go” to
its first step: everything the server can do without a contract change or an app release. Pages for accounts
(Google, Microsoft 365, Email, GitHub, Website feedback) need both and come later.

What the research found: 43 of 60 catalog entries already opened on a page in slots. The rest opened on Find My's
near-empty Summary, on the generic “How it answers” page (Notion, Airtable, Dropbox, the AI gateway, the report
tracker, Custom connections without a recipe, Proxmox and Unraid), on an empty page for the first sign-in (Todoist,
Mollie, Cloudflare with “Sign in with …”), or on Settings (the accounts).

| id | decision | why |
|---|---|---|
| CDB-01 | **A kind may name the tab its page opens on** (`KindView.lead`): that tab comes first, its other tabs after it, the Summary last, and the Summary gets no answer-time slots. Both apps open the first tab, so no app changes. An app below session minor 5 still opens on the Summary. | Find My's decision said its page opens on the map (FMC-03), but the server always put the Summary first, and that Summary only had answer times for a connection that sends nothing anywhere. |
| CDB-02 | **Find My opens on its map**, then the Timeline, then the Summary (what needs a look, Changes here, What Whombat may do). | The map and the people are the dashboard; nothing new is read. |
| CDB-03 | **The page of a connection Whombat can't see inside is “With Whombat”** (was “How it answers”): its answers and answer time as before, and when Whombat last used it (“3 h ago”, “Not yet”). A Custom connection without a page also offers “What’s inside” under Show more here, which asks the assistant to build its page. | Answer times alone said nothing a person cares about. What Whombat may do already lists the tools, so they aren't repeated. |
| CDB-04 | **No uses-per-day counter for that page.** | It needs a new counter and a migration for a page few connections reach once the kinds below exist; Last used says the same in one line. |
| CDB-05 | **A report tracker's page comes from what Whombat keeps of it**, no call to the tracker: Live “Fixes on their way” (pull request open, merged, on development; linked to the pull request), Inventory “Reports” (open with new this week, open bugs, open feature requests, fixed and out to customers in 30 days), Trend reports per day, People “Who reports most” by organization (two or more), and the installation the poller reads with when it last did. A tracker no automation listens to says so instead of showing noughts. Kept a minute. | The tracker is read only by its poller; the box's mirror already has everything a person asks first. |
| CDB-06 | **A generic AI gateway's page** (LiteLLM, a company's gateway): Inventory “Through the gateway” (Claude Code and ChatGPT on or off, turns today with how many failed and how many go now, its models from `GET /v1/models`), Trend turns per day from Whombat's own turns (each keeps the provider it went through the gateway for; a burrow has one gateway, so turns since it was connected count). Models kept 15 minutes and never read by the health pass. | A gateway has no management API Whombat knows; what Whombat sent through it is the useful part. |
| CDB-07 | **Every catalog entry opens on a dashboard or is named with where it opens instead**, checked by a test (`kinds/landing.test.ts`): Custom connections (their recipe), a device (its readings page), Whombat's servers (each server's page), and the accounts (Settings, until they get pages). | A new service can't ship with only the generic page by accident again. |
| CDB-08 | **One way to read a connection's MCP tools for a page** (`kinds/mcp-read.ts`): only tools the server marks read-only, with the kinds' deadline; recipes and kinds share it. | Kinds now read through “Sign in with …” connections too. |
