# The sidebar's agent dot only while busy (AP-946…AP-948)

John, 2026-10-09: “In the sidebar we have the agents which show a dot (Status icon) even when they do nothing. I only
want to see the status icon when they are actually busy, waiting for something, etc.” This revises AP-307, where the
dot stayed for every status once the status word went.

| ID | Decision | Why |
|---|---|---|
| AP-946 | **An idle agent's AGENTS row has no dot.** The row shows the dot (labelled, with its `title`) only for `working` and `waiting`; for `idle` nothing takes its place, so the name keeps the room. The row's accessible name follows: “Banjo, Developer, working”, “Waffle, Developer, waiting”, but “Pippa, Associate” when idle (`STATUS_WORDS.idle` is empty). DIRECT rows had no status dot and still don't. | A grey dot on every quiet agent is noise: the dots that are left now mean “look, something is happening”. Idle is the normal state, so the absence of a dot says it; the screen-reader name says what the eye sees. |
| AP-947 | **Only the sidebar.** The Agents page roster keeps its “Idle” pill, the profile pane its RIGHT NOW (“Nothing right now.”), and the phone's Agents tab its dot for every agent. | Those are rosters where every agent's state is the subject of the screen, and John asked about the sidebar. |
| AP-948 | **Tests, release.** Unit: `sidebarRoles.test.tsx` checks an idle row has no `[data-sidebar-status]` dot and no status in its name, and busy rows keep theirs. `pnpm visual` masks the end of each agent row (`[data-sidebar-agent]`: the 60px status-word slot plus the 7px dot inside the row's 10px padding) where it masked only the word beside a rendered dot, because the mock draws a grey dot for idle agents. Released as **whombat-app 0.57.1** (web only; the APK stays 0.57.0). | DEV is fast (one `pnpm check`). |
