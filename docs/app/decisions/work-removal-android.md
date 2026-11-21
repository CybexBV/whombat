# No Work view on Android (AP-856…AP-862)

John, 2026-10-08, looking at the Work page: “This is absolutely useless … Remove it fully.” Its “Recently done” listed
every chat reply as “Dusty’s turn · asked in a mention”. What it had that mattered already lives elsewhere on the phone:
NEEDS YOU is the Inbox's own top section (AP-703), a failed turn is a “Turn failed” card with Try again in its
conversation, a live run is its card or line in the thread, and a question that holds a run is a QUESTION item in NEEDS
YOU. Work was also the only way into two real screens, Plans and Deploys; they get their own ways in. No contract
change: the server's `work.overview` stays, it feeds NEEDS YOU and the Inbox badge. The web's side is removed in parallel.

| ID | Decision | Why |
|---|---|---|
| AP-856 | **No Work screen and no WORK section in the Inbox.** Gone: the `Work` stack screen and its route, `WorkScreen.tsx`, the Inbox's WORK card (the counts, two rows and “All work ›”), `inboxWorkSummary` / `INBOX_WORK_ROWS` / `INBOX_WORK_QUIET` / `WORK_EMPTY_TEXT`, Work's segments (`WORK_SEGMENTS`, `initialWorkSegment`) and `WorkRow`'s compact mode, which only that card used. Kept: the Inbox's NEEDS YOU with its rows and buttons (`WorkRow`, `useWorkActions`, `workSections`, `workRow`) and the Inbox tab's badge, both from `useWorkOverview`. `WorkRow.tsx` and `data/work.ts` keep their names: they still render `work.overview`'s `WorkItem`s, and renaming would only churn the files that import them (`StatusPill` too). | John's call. Everything the screen showed is either in NEEDS YOU or on the card of the conversation it happened in; the rest was noise. |
| AP-857 | **The Agents tab lists Automations, Plans and Deploys** above the roster, in one card without a label (it was an AUTOMATIONS section holding only Automations; `Section`'s title is now optional). Automations as before (where the server has them, `3 · 2 on`); **Plans** always, `2 open` from `plans.list?status=open` (the read the Plans screen opens with, so it shows at once), back “Agents”; **Deploys** only where the Whombat records deploys (`deployments`), back “Agents”. Nothing in the Settings sheet. | The phone has no sidebar; its burrow-wide pages sit where they belong (Files on the Channels tab, Vault and Audit log in Settings). Plans and Deploys are what the agents do across the burrow, so they go next to Automations, not into settings. |
| AP-858 | **Deploys is its own screen.** `Deploys` (`{ back? }`, `whombat://deploys`): “‹ back”, the large title “Deploys”, then the existing `DeploysPanel` (environments board, history with Load more, a deploy's sheet) and pull to refresh of both reads. A deploy card's “Deploys” opens it with the conversation as the back label (it opened `{type:'work', section:'deploys'}`). On a Whombat without `deployments` nothing leads there; reached anyway (a saved place, a web address), it pops back to the Inbox. Copy unchanged (`DEPLOYS_TEXT`). | It was Work's second segment; without Work it needs a page, and the content was already self-contained. |
| AP-859 | **Plans from a conversation's menu.** The conversation menu (“More” in the chat header) has **Plans** (Lucide `ListChecks`) after Pinned messages, in every conversation — channel, branch room, agent DM, direct — as the web's conversation header has “Plans”. It opens `Plans` with `conversationId`: that conversation's plans (`plans.list?conversationId=`), Open / All as everywhere on the phone, rows without the “where” line, the conversation's name as the back label, and its own empty text (“No open plans here. Make one from a message on the web, or ask an agent for a plan.” / “No plans here yet. …”). Without `conversationId` the screen is every plan, as before. Its default back label is “Inbox” (was “Work”). | The web shows a conversation's plans from its header; on the phone that header's extras live in the menu (pins, files, memory). |
| AP-860 | **Old Work links keep working.** A `{type:'work'}` link (deploy events still send `section: 'deploys'`, some plan steps `{type:'work', section}`) opens **Deploys** for `section: 'deploys'` where the Whombat records deploys, else the **Inbox** tab (it has no filter, and NEEDS YOU is its top). `routeForLink` takes the Whombat's `{ deployments }` from `useOpenLink` and the push taps; absent means yes, as on a self-hosted server. Web addresses: `/work` and `/<burrow>/work` open `whombat://inbox`, `/work/deploys` and `/<burrow>/work/deploys` `whombat://deploys` (`oldWorkScreenUrl`, read before the shared route list so it doesn't matter whether `@whombat/client`'s `BURROW_ROUTES` still lists them; a screen's first segment is never a burrow, so `/c/work` is a channel called work). Android's app links are unchanged: `/work` and `/.*/work` still open the app, now on the Inbox. | Servers, pushes and old messages carry these links for a long time; they should land somewhere useful, never on “not found”. |
| AP-861 | **A place saved on Work opens on the Inbox.** `Work` is no longer restorable, so the saved stack is cut there like any screen not listed (MN-01): saved on Work (or above it) over the Inbox, the app starts on the Inbox; a stack below it is kept. `Deploys` is restorable as a list; `Plans` too, a conversation's Plans only while the conversation is in the sidebar. | The general rule already does the right thing; no special case to keep. |
| AP-862 | **The web's new addresses open on the phone.** `/inbox` (with any `?filter=`, the phone's Inbox has none) opens the Inbox and `/deploys` the Deploys screen, burrow-less or after the burrow (`/burrow-hq/deploys`); shared work links now write these (`workPath` in `packages/client`, AP-851). | Added at the merge with the web's change: links copied from the web, and the welcome's and notifications' links built by `appPath`, would otherwise open in the browser. |

## Open

- **No visual check**: the phone app has no browser or screenshot harness here, and no emulator was booted for this.
  The Agents tab's card, the Deploys screen and the menu's Plans row are built from the audited primitives
  (`ListRow`, `Section`, the menu's existing row) and need a look on a device.
- **A future web `/deploys` address** isn't mapped yet: the web's side of this change decides the web's path. If it
  lands as `/deploys`, add it next to `oldWorkScreenUrl`. If the web also drops `/work` from `BURROW_ROUTES`,
  `burrowOfPath('/work')` reads “work” as a burrow (links.test.ts expects null); the phone's own mapping above doesn't
  depend on it.
- **Plans can't be made on the phone**: “Make a plan” stays on the web, as before.

### Checks

`pnpm check` once (biome, typecheck, unit tests: `persist.test.ts` for saved Work places, Deploys and a conversation's
Plans; `parity-links.test.ts` and `links.test.ts` for the old links; `work-supervision.test.ts` and
`deploysCanvas.test.ts` without the removed parts; the static touch-target, TalkBack-order and dynamic-type audits over
`DeploysScreen.tsx`). Android not run on a device or emulator.
