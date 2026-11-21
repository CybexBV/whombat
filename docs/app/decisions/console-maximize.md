# The console fills the window (AP-7500…AP-7501)

John, 2026-11-05: a server's console (a guest's screen or shell, or the server's own shell) should open with the
guest list hidden, and next to Full screen offer to fill the current browser window.

| # | Decision | Why |
|---|---|---|
| AP-7500 | **The side list starts closed** at every width; **Guests** in the toolbar opens it, and it stays open while switching consoles in that dialog. Supersedes AP-1483's “starts open above 900 px”. | The screen is what the person came for; the list is for switching. |
| AP-7501 | **Maximize** sits after **Full screen** (`aria-pressed`, Expand icon; **Restore** with Shrink when on): the dialog fills the browser window (no margin, no rounded corners) and the screen, or the screen and the list, take the height that's left. Full screen hides it, as it hides Guests; on a phone (≤ 600 px) it is hidden because the console fills the screen already. The choice is kept in this browser (`localStorage`, `whombat.console.maximized`) for the next console. | Full screen takes the monitor and asks the browser; filling the window keeps the browser's tabs and other windows at hand. |
