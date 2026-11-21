# Push words

John, 2026-11-03: “Occasionally I receive a push message ‘Whombat needs you’. This is often not the case and more
importantly the notification itself is useless and doesn't provide any information.” In one week DEV sent 88 `security`
pushes, nearly all when remote help started a visit to Home (support works in many short visits, mostly agents
running `dev/support`). None of them had words: a `security` push carried no preview, so control put “Whombat needs
you” on the iPhone and the web for every kind, and a tap opened the Inbox with “not found”.

| # | Decision | Why |
|---|---|---|
| PW-01 | **A remote help visit is told in the Chat, not pushed on its own.** The assistant's line in the person's Chat is the notice (said once per visitor per 12 hours, RH-15), and it reaches the phone like any message from the assistant (preview, quiet hours, held while the person is using Whombat). A `security` push goes only to someone without a Chat to say it in. The same for five wrong help codes. Visits stay recorded step by step and signed. | Every visit buzzed the phone with a wordless push, all day during support work, although nothing needed the person. The Chat line already says who is looking and where to stop it. |
| PW-02 | **Every `security` push says what happened**, in fixed words as its preview (`managed/security-push.ts`): a new device signed in with a passkey, a device signed in at the screen, wrong letters at the screen, a recovery kit being made or replaced and then saved, support looking (without a Chat), remote help locked out. The words hold nothing from the person's data. Someone who turned off message text in notifications gets the phone's generic line for `security`. A recovery kit's begin and confirm share one subject, so the confirm's notification replaces the begin's. | A notification that doesn't say what happened makes the person open the app to find out, or ignore it. |
| PW-03 | **A tap on a `security` push opens the page it is about**: Settings → This Whombat's Devices for devices and the screen, its About for remote help, This Whombat for the recovery kit. `ControlPush` remembers what it sent for as long as a push lives (`PUSH_TTL_S`) and answers `push.resolve` for the account it went to. | A tap that opened the Inbox with “not found” gave the person nothing to do. |
| PW-04 | **Control words a push without a preview by its kind** (control CL-149): the app's `PUSH_TEXT` lines on APNs and Web Push too, so “Whombat needs you” is left only for `generic`, which nothing sends. | One sentence for every kind told the person nothing, and “needs you” was wrong for most of them. |
