# The Work view is gone: the server side (WR-01…WR-03)

John, 2026-10-08, on the sidebar's Work page (his box, #general): “This is absolutely useless, what would a normal user
need with this? … ‘Asked in a mention’ doesn't say anything useful at all.” Then: “Remove it fully.” Its RECENTLY DONE
listed every chat reply of an agent as “Dusty’s turn · asked in a mention” (the dispatch's trigger, not what was asked),
with “Replied in the thread” twice per row.

The clients remove the view (whombat-app `docs/decisions/work-removal.md` for the web, `work-removal-android.md` for
Android; app 0.51.0). This file is what the server does about it: nothing in the code.

| ID | Decision | Reason |
|---|---|---|
| WR-01 | **`work.overview` stays, unchanged.** It is no longer a screen, but three things read it: the Inbox's NEEDS YOU (web WE-11, Android AP-703) with its controls, the agent profile's Stop (`RightNowStop`, WX-10: the agent's running or queued turn that offers `stop_turn`), and the Inbox and tab-bar badges. Apps older than 0.51.0 still show its other sections. No contract change: `WORK_SECTIONS`, `WorkSection` and the `{ type: 'work', section }` link stay in `@whombat/core`. | Removing the sections would break Stop and older apps for a few saved queries; the Inbox decides what a person sees. |
| WR-02 | **No new Needs-you items.** What only Work showed: blocked and failed items, live and queued work, recently done. A run held by its agent's question (`runs.attention`, RA-DS62) is already a QUESTION in Needs you, the question being an `asks` message; a failed turn is its “Turn failed” card with Try again in the conversation (essentials item 4); a live run is its card or line in its thread (card-settle QC-01…QC-05). Recently done is not kept anywhere: a chat reply is not work to look back on. | Each of these already lives where it happened; repeating them in the Inbox is the noise John removed. |
| WR-03 | **Links the server sends keep their shape.** Deploy events still carry `{ type: 'work', section: 'deploys' }` (`deployments/commands.ts`) and a plan step without a place `{ type: 'work', section }`; the clients open the Deploys page for `deploys` and the Inbox for the rest. | Old events in the log and older apps keep working; the clients own where a link goes. |

What is lost: the failed turn's technical detail for owners and admins was shown only in Work's FAILED rows
(`failure.ts`, `turnFailureDetail`); it stays in the runner's log and the dispatch row.
