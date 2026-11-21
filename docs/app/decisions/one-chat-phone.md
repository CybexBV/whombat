# One Chat on the phone (AP-8920…AP-8929; AP-7820…AP-7839, AP-7960…AP-7971)

John, 2026-11-07, later the same day (Whombat `docs/decisions/one-chat.md` CODE-40…CODE-45): “We implemented a separate
Code section, this was a mistake and I want to revert it back. We will only use Chat.” He approved Settings as a tab
again. The work line, the live cards and the top row stay; T3 Code's job view moves into the thread (job-view.md
AP-8940…AP-8943).

| ID | Decision | Why |
|---|---|---|
| AP-8920 | **The tabs are Chat, Inbox, Overview, Automations, Settings** (`data/shell.ts` `TABS`), on our bar, the Duo's side rail and iOS's own tabs (`gearshape.fill`). Settings is a tab screen again, with Places at the top left and Search at the top right as every tab; its pages (the assistant, Skills, …) go back to it, and Search's way back too. | CODE-45: Settings left the tabs only for Code. |
| AP-8921 | **Settings' dot is on its tab**, with its words for a screen reader; Places' ☰ and Places' Settings row carry none. | One dot in one place. |
| AP-8922 | **No Code on the phone**: no tab, screen, Settled, New job page, pointer, moved line or ⋯ Move menu; Chat's room, its Settled and a thread read every thread (no `place` asked, no `chats.place` sent), and the Duo's resting right page is Chat's alone. | CODE-40: one list. |
| AP-8923 | **What a phone kept from Code turns into Chat**: a saved thread whose way back was Code goes back to Chat, a saved Code's Settled opens Chat's, `whombat://code` opens Chat, an outbox item that carried a place sends as a Chat thread; a draft typed in Code's box and the `whombat.codeTab` key are left unread (drafts go after 30 days). | CODE-43: nothing a phone kept leads nowhere. |
| AP-8924 | **The demo world keeps the work and the jobs** (`EXPO_PUBLIC_WHOMBAT_CODE=1` or `jobs`, `fixtures/code.ts`): its councils, checklists and T3 Code jobs in Chat, with no place; `chats.place` answers the thread as it is. | Every work line and job state without a box. |

## The first build: Code on the phone

The top row (AP-7820, Settings now a tab), the work line (AP-7826, AP-7827) and the live cards (AP-7828…AP-7830) are in
force.


John, 2026-11-07: Code, the place for software work (Whombat `docs/decisions/one-chat.md` CODE-01…CODE-32), on the
iPhone, the iPhone Duo and Android, from the shared words and rows of `@whombat/client` (then `code.ts`: `CODE_WORDS`,
`threadWorkLine`, `codeRow`, `codeSections`, `councilSteps`). The phone's own rules were `apps/mobile/src/data/code.ts`; the work line's are `data/workLine.ts`.

## The shell

| ID | Decision | Why |
|---|---|---|
| AP-7820 | Superseded by AP-9370 (chat-inbox-phone.md). **The row above a tab: Places (☰ and the word) at the left, Search (the word and the magnifier) at the right** (`ui/topRow.tsx`). Pages pushed over the tabs keep ‹ Back at the left, with Places at the right where they show it (Search, Files, Vault, Usage). | CODE-32: where people look for each. |
| AP-7821 | Superseded by AP-8920, AP-8921, AP-8922. **The tabs are Chat, Code, Inbox, Overview, Automations** (`data/shell.ts` `TABS`), on our bar, the Duo's side rail and iOS's own tabs (`code-xml`, SF Symbol `chevron.left.forwardslash.chevron.right`). | CODE-30: room for Code without a sixth tab. |
| AP-7822 | Superseded by AP-8920, AP-8921, AP-8922. **Code's tab shows from the first thread the server says is in Code** (`place: 'code'`; a Whombat from before Code lists threads without a place, which don't count) **and then stays**: the Whombat's slug is kept in the secure store (`whombat.codeTab`), read as the app starts, so the tab is there from the first frame of the next start. Until then Places and Search leave Code out, and a saved or linked Code tab opens on Chat. | Tabs that come and go would move under the thumb; a place that can't open shouldn't be listed. |
| AP-7823 | Superseded by AP-8920, AP-8921, AP-8922. **Settings is a page over the tabs** (`Settings` in the stack, `whombat://settings`), opened from Places with ‹ Back and Places at the right; every way into it (links, Search, the pages' back fallbacks) opens that page. With two pages it opens on the right page. | CODE-30: Settings lives in Places only. |
| AP-7824 | Superseded by AP-8920, AP-8921, AP-8922. **Settings' dot moves to Places**: on the ☰ glyph and on Settings' row in the sheet (a newer app is ready, AI or this Whombat needs the person), said in words to a screen reader. | The tab that carried it is gone; the news shouldn't be. |
| AP-7825 | Superseded by AP-8920, AP-8921, AP-8922. **Code's tab has a dot while an open thread in Code has unread replies** (`chats.unread` against Code's list); Places' Code row too. | What's new in Code without opening it. |

## The work line

| ID | Decision | Why |
|---|---|---|
| AP-7826 | **Where a Chat row said “Handed over”, the work line stands on its own line under the replies** (`ui/workLine.tsx`, from `threadWorkLine` with the thread's `work` and its hand-overs, `threadHandoffs`): a council's provider marks overlapping (or a dot, breathing while it works), who (500), what now, the clock in mono at the right, and a 3pt hairline. When it waits for the person it replaces “Waiting for you” too, in amber. | CODE-10…12: what it does and how far, subtly. |
| AP-7827 | **The hairline is segments for a count** (done filled, the ones at work breathing, at most twelve) **and a soft sweep without one**; Animated on the native driver, still with Reduce Motion. A screen reader hears the line's words once, with whole minutes on the app's clock. | CODE-11; no motion for people who asked for none. |

## The live cards

| ID | Decision | Why |
|---|---|---|
| AP-7828 | **A live council shows its members in the card**, not under Details: mark (the turning ring), name with its provider beside it, what it does now, score · verdict or its state, and its time; “Read its answer” on a member that answered. Details keeps the earlier rounds and the plan. Ended, it folds to its result with Read the answers, as before. | CODE-20. |
| AP-7829 | **The council's five steps under its title** (`councilSteps`, `councilStepIndex`): done filled, the current one ringed with its word stronger, amber at the go-ahead; one stop for a screen reader (“Plan, step 2 of 5”). Hidden once it stopped. | CODE-21. |
| AP-7830 | **Stop steps back on the council and the checklist**: a quiet “□ Stop” at the bottom right, level with Details (44pt), and in the card's ⋯ on the status line with Change who sits on it (the council's) and Stop… — iOS's own menu on iPhone, the sheet elsewhere. Both still ask with the alert. A checklist's tasks stay on the card while they work. | CODE-22: rare and only undone by starting again. |

## Code

| ID | Decision | Why |
|---|---|---|
| AP-7831 | Superseded by AP-8922. **Code's screen is T3 Code's thread list**: the large title with New job, filter chips (All · Needs you · At work · Done, with counts where they help), sections under small mono headings, rows of three lines — the project's letter mark and name with its state in colour (a pulsing dot while it works or waits), the job (two lines), branch · `#PR` with the council's marks or the clock — settled rows quieter. Pulled left an open row settles where it can (Chat's swipe row). Loading, empty and failed in `CODE_WORDS`. | CODE-31. |
| AP-7832 | Superseded by AP-8922. **A job opens as its thread with “‹ Code”**, on the right page with two pages (the split stack's own rule); beside Code with nothing open, “Pick a job to see it here.” | One thread, two lists; the Duo as Chat. |
| AP-7833 | Superseded by AP-8922. **A thread in Code has its job's head** under the header: project · branch in mono, the job, and the `#48` chip, which opens the app's pull request page for a GitHub address or `#n`, any other address in the browser. | CODE-31: repository, branch and pull request on top. |
| AP-7834 | Superseded by AP-8922. **Opened while Chat still points to it, the thread says it was seen in Code once** (`chats.place` with `seen`). | CODE-07: the pointer goes once it has done its job. |
| AP-7835 | Superseded by AP-8922. **New job is the new-chat sheet with Code's words**; the thread it starts is placed in Code at once and opens with “‹ Code”. | CODE-31: in Code from the start. |

## Code like Chat (AP-7960…AP-7971)

John, 2026-11-07: “Code section should behave similarly as Chat. I want the chat input to be the exact same as in Chat
(bottom of the page), only the chat pre-fill text should not say ‘Ask Dusty anything’ but ‘What do you want to build
today?’. Same with settled code threads, show them similarly as in Chat.” The sections, the chips and the rows stay.

| ID | Decision | Why |
|---|---|---|
| AP-7960 | Superseded by AP-8922. **Code is laid out as Chat**: Chat's header (“Code” 24/700 and a hairline, `RoomHeader`) with Settled, then the chips and the list where Chat has its messages, and Chat's box at the bottom with “What do you want to build today?” (`CODE_WORDS.composer`; `ChatView`'s `list` in place of the messages, with `fresh`, so none are read or marked read). The large title and New job go. | John: the box exactly as Chat's, at the bottom of the page. |
| AP-7961 | Superseded by AP-8922. **The box is Chat's own** (what answers, files, voice typing, the outbox, the keyboard and the insets) **with a draft and a recording of its own** (`place: 'code'`: draft `<chat>#code`, voice key `…:code`), so Chat's top-level draft stays Chat's. What it sends starts a thread of the Chat, placed in Code at once (`chats.place`), which opens as a job does (“‹ Code”, the right page with two pages). One it held while offline waits under Code's box, not Chat's, and goes to Code once it is sent. | One box, two places: what is typed for Code mustn't turn up in Chat, or start a Chat thread. |
| AP-7962 | Superseded by AP-8922. **Code's list has the open jobs only** (`chats.threads` with `state: open`, `place: code`, one cached list for Code, its tab's dot, Chat's room and a thread; `openCodeThreads` drops one settled here at once): sections Needs you · At work · Open, chips All · Needs you · At work (no Done), the rows and their swipe to settle as before. | John: settled code threads as in Chat, the working and other sections as now. |
| AP-7963 | Superseded by AP-8922. **Code's header has Settled**, Chat's outlined 44pt header button, which opens Settled with `place: 'code'` (`whombat://settled?place=code`, restored as Chat's): the settled jobs (`state: settled`, `place: code`; only `place: code` kept, since an older Whombat ignores the place), “Code” where Chat's says Chat, a row opening the job as Code does (“‹ Code”), Open again putting it back in Code's list. | As Chat's settled threads: out of the list, a tap away. |
| AP-7964 | Superseded by AP-8922. **Chat's Settled has Chat's own threads only** (`place: chat`, a job left out), and a settle or Open again changes only the cached lists of the thread's place (`listOfPlace`; one whose place isn't known goes by the other rules). | A settled thread is under the Settled of the place it was in, once. |
| AP-7965 | Superseded by AP-8922. **With two pages Code's list has New job where its box was** (`NewChatBar`, as Chat's New chat), and the right page while nothing is open is the new job (`NewChatPage` with `place: 'code'`): “New job”, the assistant's face and “Tell Dusty what to build or fix. Each job gets its own thread.” (the phone's own words, `CODE_PHONE_WORDS`; the web has no such page), Code's box with the cursor in it after New job. The two pages are keyed by their tab, so switching tabs never carries a box's text into the other's draft. | The Duo as Chat (AP-6300, AP-6301). |
| AP-7966 | Superseded by AP-8922. **Beside Code the list can be hidden with nothing open too** (`RESTING_PAGE_TABS`: Chat and Code), the new job then taking the whole width. | Its right page is a page of its own now, as Chat's. |
| AP-7967 | Superseded by AP-8922. **The tab still shows from the first job when every job is settled**: until it has shown on this phone and while no open job is listed, the tab reads Code's Settled too (the same cached list as the screen). A thread opened from Code's Settled finds its job's head there. | The list of open jobs alone would lose them. |
| AP-7968 | Superseded by AP-8922. **The new-chat sheet has no place any more**; Ask about … and the Automations' Tell Dusty keep it. | Code's jobs start in Code's box. |
| AP-7969 | Superseded by AP-8922. **The demo world answers `chats.threads` with `state` and `place` together**, its settled count that of the place asked for (`fixtures/chatChannel.ts`). | Code's Settled and the tab's check work without a box. |
| AP-7970 | Superseded by AP-8922. **A job started in Code's box has no Moved to Code line**: a thread placed in Code within 10 seconds of its first message started there (`STARTED_IN_CODE_MS`, as the web's). | It never moved; every job typed in Code's box would otherwise say it did. |
| AP-7971 | Superseded by AP-8922. **Code's Settled names a job by the job's name** (`code.title`, else its first line), as Code's list does. | The same job reads the same in the list and under Settled. |

## Moving

| ID | Decision | Why |
|---|---|---|
| AP-7836 | Superseded by AP-8922. **Chat's room leaves out the threads in Code**; one not yet opened there keeps a slim pointer where it was (`</>` Moved to Code · *job* ›, `sf2`, 44pt), which opens it from Code. A left-out thread's day and New line go to the next row, as settled threads'. | CODE-07: nothing disappears without a word. |
| AP-7837 | Superseded by AP-8922. **In a thread in Code a dashed line after the last message from before it moved** says Moved to Code and why, with Open in Code (not when it was opened from Code) and Keep in Chat. | CODE-03. |
| AP-7838 | Superseded by AP-8922. **The thread's header has a ⋯ with Move to Code or Move to Chat** (Chat's threads only); Move to Chat says “Moved back to Chat.”. | CODE-03: the person's choice either way. |

## The demo world

| ID | Decision | Why |
|---|---|---|
| AP-7839 | Superseded by AP-8924. **`EXPO_PUBLIC_WHOMBAT_CODE=1` puts threads in Code in the demo world** (`fixtures/code.ts`): a council at work (2 of 3), T3 Code running the tests on `fix/backup-list` with #48, a checklist needing Mara's OK, T3 Code waiting for the checks on #212, a settled job, and one Chat still points to; `chats.threads` by place, `chats.place` and `conversations.handoffs` answer. | Every state without a box. |
