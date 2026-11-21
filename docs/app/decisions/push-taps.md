# A tapped notification opens its item, not the Inbox first (2026-11-03)

John, 2026-11-03: “In the iPhone app (perhaps Android also) when I click on a notification I get routed to the
“Inbox” first before I go to the actual chat message.” A managed Whombat's push carries only a kind and an opaque ref
(content-free through control), so the phone must ask the Whombat (`push.resolve`) what it is about. Until it answered,
both phones showed the Inbox, and the answer waits for the session to reconnect after the app was in the background or
closed: the Inbox showed for a second or several, then the chat opened over it. Phone only: no contract change.

| # | Decision | Why |
|---|---|---|
| AP-6600 | **A tapped push opens nothing until the Whombat says what it is about, then that** (`usePushTaps`; the linking config ignores `whombat://push?…`). A tap while the app ran keeps the screen the person was on; one that started the app shows the Chat tab, the first tab, as any cold start without a saved place. The Inbox opens only when the answer names nothing (gone, offline, or a push the app has no screen for), with the quiet note when it is gone. Supersedes NYL-09's landing on Needs you. | The Inbox in between looked like a wrong turn, and most pushes are about a chat, so the Chat tab under it is the likelier place anyway. The strip already says “Connecting…” while the session comes back. |
| AP-6601 | **What a ref is about is kept for the app's life and shared** (`push/knownRefs.ts`): the shade check, which looks up the notifications on screen once the session is open, and each tap's own answer fill it, and a tap looks there first. Tapping a notification while the app is open (a banner, or one in the shade the app has already seen) opens at once. | The shade check already asked the Whombat about each notification; the tap asked again and waited for it. A ref always names the same item, so the answer doesn't go stale (a gone item stays gone). |

Not done: carrying where to open in the push itself. Control passes a preview through (CT-286) but no link, and adding
one changes control, the relay path and the contracts (a new optional field, a contracts release and control's copy).
Worth it only if the wait after a cold start still bothers anyone once AP-6600 is out; an end-to-end encrypted hint the
app opens without the session would be the shape.
