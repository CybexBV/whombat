# Page speed — 2026-10-19

John: “When I click on Home Assistant service, the page is loading very slowly. Why and can you think of ways to
improve this and other connections also?” Measured on his box: Home Assistant's read waited 5 s for a system health
`finish` that never came (fixed first, `connection-pages-server.md` CP-S23: 5.0 s → 0.31 s); UniFi answers in about
0.1 s, Proxmox and Unraid in about 20 ms, the hosts service's address index takes about 0.5 s every 10 minutes and a
guest's figures about 30 ms. Still, a page waited for every live read, a service that doesn't answer held its page for
its whole 15 s deadline, and the health pass looked at one connection after another. John chose three improvements
(“Let's do 1, 2 and 3”); the app's part (the page's head at once, loading on hover) is in the app's
`docs/decisions/page-speed.md` (AP-2650…).

| # | Decision | Reason |
|---|---|---|
| PS-01 | **A page shows the last reading when a fresh one is slow.** The kinds' reads (Home Assistant, UniFi, Hetzner and Hetzner's per-server metrics) keep their last outcome for 15 minutes (`KIND_KEEP_MS`, past the health pass's 5). A page (`latestRead`) gets the outcome of the last 30 s as it is; older, it starts a read (or joins the one under way) and waits up to 1 s (`PAGE_WAIT_MS`) for it, else shows the last outcome. Only a connection read for the first time since the server started waits for the read itself. A failure is kept for 30 s for pages, so a service that doesn't answer says so at once instead of holding every page for its deadline; the health pass (`cachedRead`) still reads again after a failure and shares the same entry, so it keeps every page's reading warm. A new credential reads again. | The page waited on the service each time (the reads were kept 30 s and a page polls every 60 s); with the health pass reading every 5 minutes there is nearly always a recent reading to show. 1 s is longer than a healthy read here (0.1–0.3 s), so a page normally still shows a fresh reading. |
| PS-02 | **A page shown from its last reading asks again after 5 s** (`refreshS: 5`, the contract's floor, instead of 60) while a newer reading is under way, so the fresh figures replace it within seconds. No new contract field: both clients already poll on `refreshS`. | The reading under way finishes on the server either way; the page only needs to come back for it. |
| PS-03 | **The address index and the machine's figures serve their last ones while new ones are read.** The index (what a connection runs on, rebuilt every 10 minutes, about 0.5 s) answers with the last index while the next is built; a failed build keeps the last. A machine's figures (kept 30 s) wait up to `PAGE_WAIT_MS` for a new read, else the last ones of the past 15 minutes serve. The first ones are still waited for (within 5 s, as before). | Nothing on a page should wait on a rebuild that changes nothing most of the time. |
| PS-04 | **The health pass looks at four connections side by side** (`sideBySide`, `PASS_PARALLEL`). On John's box UniFi's check started 5.3 s into the pass because Home Assistant's came first. Four keeps the outbound load of a pass small (a pass has at most 50). | One slow service held up every other tile and the readings pages show (PS-01). |
