# One Chat: software work stays in Chat, what a thread's row says, live cards (CODE)

John, 2026-11-07, later the same day (main checkout): “We implemented a separate Code section, this was a mistake and I
want to revert it back. We will only use Chat.” He approved the plan: Code goes everywhere; the row's work line, the
open live cards with a quiet Stop and Places at the top left stay; T3 Code's job view moves into the thread; Settings is
a phone tab again.

## One Chat

| # | Decision | Why |
|---|---|---|
| CODE-40 | **Every thread of the person's Chat is listed in Chat.** Nothing moves a thread elsewhere: a hand-over to T3 Code, a council on a project and a checklist of tasks leave it where it is. There is no Code list, page, tab, box, Settled, pointer, moved line or Move to Code / Move to Chat. Threads that were in Code show in Chat again, with their messages, cards and links as they were. | John: one place for conversations; the split hid threads and added a second list to keep up with. |
| CODE-41 | **An app from before one Chat keeps working**: `chats.threads` and `chats.unread` with `place: code` answer nothing (its Code list stays empty instead of showing every thread twice), with `place: chat` or none every thread; `chats.place` changes nothing and answers the thread as it is; `chat.placed` is never sent and a thread never carries `place` or `code`. The contract keeps these 3.20 shapes until the next major removes them; no contracts release and no session minor now. | The apps from 3.78 to 3.81 ask for both lists; nothing else reads them. Removing a field or an op is a major, which isn't worth a release on its own. |
| CODE-42 | **`thread_places` stays, unused, until a later release drops it** with `t3_watches.branch` and `project_id` (a `contract` migration, managed-db.md MD-03, MD-06). Nothing reads or writes them. | A box rolled back to the release before finds its table as it left it. |
| CODE-43 | **Old addresses lead to Chat**: the web's `/code` goes to `/chat` with its query (`?thread=`, `?settled=`), and the phone's `whombat://code` opens Chat. | Bookmarks, open tabs and saved pages still land somewhere sensible. |
| CODE-44 | **T3 Code's job view is in the thread** (app job-view.md): any thread with work handed to T3 Code, in Chat or Feedback, shows the stage track under its head and the job's plan, changes, checks, question, message box and receipt at its end, while the box lists the hand-over (an ended one with its receipt for up to 7 days). There is no repository, branch and pull request head: the changes and the receipt carry the pull request. | The job view was the useful part of a Code job; it needs the hand-over, not a separate list. |
| CODE-45 | **Settings is a phone tab again**: Chat · Inbox · Overview · Automations · Settings, with Settings' dot on its tab; Places keeps the other pages. Places at the top left and Search at the top right of a tab's screen stay (CODE-32). | Settings left the tabs only to make room for Code. |

## The first build: Code, a place for software work

The work line (CODE-10…CODE-12), the live cards (CODE-20…CODE-22) and the top row (CODE-32) are in force; the rows One
Chat superseded stay for their reasons.

John, 2026-11-07 (main checkout), four wishes:

1. “In the thread list we should see if a thread is currently working (for example when T3 Code is actively working or
   the Council is working, etc). Currently it says ‘Handed over’, but we should see what it's doing and what the
   progress is in a subtle way.”
2. “When a card appears (for example the Council card) it is collapsed and it doesn't show the council is working, I
   want to see this by default … On top of the card there is a very large button to STOP progress, in my opinion this
   should not be this prominent and certainly not above the council progress.”
3. “When we start a chat with Dusty in the ‘Chat’ screen and it turns out this is software development, I would like
   it to move to a new ‘Code’ screen / menu item which is dedicated to Software development … move ‘Settings’ to the
   hamburger menu ‘Places’ so we have room for ‘Code’ … I want the Code section to act similarly as T3 Code … and the
   descriptions should be rewritten to match what the job is.”
4. “On the mobile app (at least on iPhone Duo) … I want the hamburger menu on the top left and search on the top right.”

A mockup was shown and approved (“Yes, implement this. Make sure we do not interfere with other Whombat threads that are
currently active.”).

## Where a thread is listed

| # | Decision | Why |
|---|---|---|
| CODE-01 | Superseded by CODE-40. **A thread of the person's Chat is listed in Chat or in Code**; it stays a thread of the Chat conversation either way (`thread_places`, migration 0052: no row is Chat). Links, unread markers, cards, notifications, settling and the agent's sessions don't change when it moves. Feedback and other conversations have no Code. | Moving messages to another conversation would break every link and card that points into it; only the lists need to change. |
| CODE-02 | Superseded by CODE-40. **Work on a repository moves it, once**: the agent hands it to T3 Code (`t3_thread_launch` in a person's turn), starts a council on a project, or offers a checklist of tasks. In that commit (or, for a hand-over, right after the call) the thread moves, unless it has a place already. A question about code that starts no work stays in Chat. Threads that had work before this existed are never moved (no backfill). | The moment work starts is a fact the server already has; guessing from words would move threads that are only talk. Leaving older threads alone keeps the person's running work where they left it. |
| CODE-03 | Superseded by CODE-40. **The person moves it either way** (`chats.place`): Keep in Chat (the line in the thread), and Move to Code / Move to Chat in the thread's menu. Kept in Chat by its person, new work doesn't move it again. | The person's choice outlasts the automatic one. |
| CODE-04 | Superseded by CODE-40. **In Code a thread is named after the job**: the work's own name (the council's or checklist's title, the T3 Code thread's title without the assistant's name in front), else the first line of the person's message when they moved it. The first message stays as it was. | John: “the descriptions should be rewritten to match what the job is”; the agent already names the work when it starts it. |
| CODE-05 | Superseded by CODE-40, CODE-44. **A Code row knows its repository, branch and pull request**: the project of the council, checklist or T3 Code thread, and the newest branch and pull request of its hand-overs, tasks or council builder (the watcher keeps a hand-over's `branch` and `project_id`). | T3 Code's rows: repository and state, job, branch · pull request · model. |
| CODE-06 | Superseded by CODE-41. **`chats.threads` and `chats.unread` take `place`** (`chat` or `code`); without it they list both, so an app from before Code shows every thread in Chat as before. Moving tells the person's devices with `chat.placed` (topic `me`). Contracts 3.20, session minor 11. | Additive: older apps keep working, newer ones split the lists. |
| CODE-07 | Superseded by CODE-40. **Chat keeps a pointer** where a thread was (“Moved to Code · Fix the empty backup page”) until its person opens it in Code (`chats.place` with `seen`); moved by the person themselves, there is no pointer. | Nothing disappears without a word; the pointer goes once it has done its job. |

## What a thread's row says while work goes on

| # | Decision | Why |
|---|---|---|
| CODE-10 | **A thread's row says who is at work, what they do now and how far along it is**, in place of “Handed over”: `Council · 2 of 3 answered`, `T3 Code · running the tests`, `Tasks · 2 of 5 done`; amber and first when it waits for the person (`needs your go-ahead`, `needs your OK`). A council or checklist comes from the thread's `work` (the server reads the live council and its round, or the checklist and its tasks); a lone hand-over from the conversation's `Handoff`s. | John's wish 1; the server already knows each of these. |
| CODE-11 | **Progress is a hairline**: a bar of segments where there is a count (members answered, tasks done; the ones at work breathe), a soft sweep where there is none (T3 Code at work, a council building); still with reduced motion. A council's members show as their small provider marks. | “In a subtle way”: one line and a 3px bar, no card. |
| CODE-12 | **The same line everywhere a thread is listed**: Chat and the web's thread lists. The rows read it again when a council's or checklist's card changes (`message.updated` of that card) and when a hand-over moves on (`conversation.handoffs`). | One way to read where work stands. |

## The live cards

| # | Decision | Why |
|---|---|---|
| CODE-20 | **A live council or checklist card shows its work open**, on the phone too: the members (or tasks) with what each does, under the title and the sentence. Once it ended it folds to its result and Read the answers. | John's wish 2: who works and on what is the useful part. |
| CODE-21 | **The council's five steps on top** (Review · Plan · Go-ahead · Build · Check, the first named by what the council does), the current one marked. | Where it is, without reading. |
| CODE-22 | **Stop steps back**: a quiet word at the bottom of the card, under the progress, and in the card's ⋯ menu with Change who sits on it; it still asks first. Never a full-width button above the work. | Stopping is rare and undoable only by starting again; it shouldn't be the first thing to tap. |

## The shell

| # | Decision | Why |
|---|---|---|
| CODE-30 | Superseded by CODE-40, CODE-45. **Code is a place right after Chat** (Search, Chat, Code, Inbox, Overview, …): a tab on the phone where Settings was, Settings in Places only. The tab shows from the person's first thread in Code on, and stays. | Room for Code without a sixth tab; tabs that come and go would move under the thumb. |
| CODE-31 | Superseded by CODE-40. **Code works like T3 Code**: one list of jobs across the repositories, what needs the person first, then what is at work, open, and settled work quieter at the bottom; each row three lines (repository and state, the job, branch · pull request); a job opens as its thread with its repository, branch and pull request on top; New job starts a thread that is in Code from the start. | John: “act similarly as T3 Code”. |
| CODE-32 | **Places at the top left, Search at the top right** on a phone's tab screens; a page opened on top keeps ‹ Back at the top left. | John's wish 4; where people look for each. |
| CODE-33 | Superseded by CODE-40. **Code's box is Chat's own, at the bottom of the page**: the same composer (files, what answers, voice typing, `/` skills, the kept draft, its own for Code), only its words differ: “What do you want to build today?”. What is sent there is a new thread of the Chat, put in Code at once, and it opens as a job does; there is no New job button. With two pages on a phone the list has New job in the box's place and the new job is the right page, as Chat's New chat. | John, 2026-11-07: “I want the chat input to be the exact same as in Chat (bottom of the page)”. |
| CODE-34 | Superseded by CODE-40. **Settled jobs leave Code's list for Code's Settled**, as settled threads leave Chat: the head's Settled lists them (with Open again), Chat's Settled leaves them out, and the list holds what needs the person, what is at work and what is open, with the chips All · Needs you · At work. A job that may settle offers Settle on its row. | John: “the settled threads need to be moved the same as in Chat, but the working and the other should function as they do now”. |

## Not now

- Dropping `thread_places`, `t3_watches.branch` and `project_id` (CODE-42), and the 3.20 shapes with the next major
  (CODE-41).
- A repository and branch line on a thread with a T3 Code job.
