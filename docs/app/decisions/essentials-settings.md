# Essentials on the web: failed turns, branch rooms by repo, GitHub sign-in, members, notifications (AP-480…AP-499)

Stream W3 of the Whombat essentials (2026-09-30; Whombat `docs/implementation/essentials/assignment.md` items 4, 5, 6,
10 and 12's Settings → Notifications), on contracts 0.26.0 (CT-166…CT-184). The runtime is built in parallel (R1:
failed turns, GitHub sign-in; R3: members, notifications); this builds against the contracts and the fixture world.
None of these screens is in the mocks: they follow the nearest mocked pattern (B-05) — tokens only, the product's
curly quotes and middle dots, real buttons and links, 44px targets on touch screens. Every new operation is offered
only on a runtime that advertises its feature (AP-256): `dispatches.retry`, `prs.repo`, `github.signin`,
`members.manage`, `agents.retire`, `notifications.levels`.

## Failed turns (item 4)

### AP-480 The `turn_failed` card

The skill card's frame (18px 20px, 12px gaps) with the shared 1px line border: a failure is told by its label, not by
an alarming frame. The label is core's `TURN_FAILURE_LABELS[code]` (“NOT SIGNED IN”, “USAGE LIMIT”…) in the bad tone,
then the card's `reason` (the runtime's `turnFailureText`), then **Try again** (primary) for a viewer core's
`canRetryTurn(card, agent, viewer)` allows — a person who may wake that agent there; a personal agent: its owner only;
never a retired agent — on a runtime with `dispatches.retry`. Pressing it calls `dispatches.retry`; while it's on its way
the button reads “Try again…”. Once anyone pressed it the label goes muted and the row reads `turnRetriedText` (“Tried
again · 14:32”, the reader's zone) for everyone, with no button: one retry per failed turn (the runtime answers a second
press with the retry it already queued). The toast says “Asked Pippa to try again.”; a refusal stays on the card in the
bad tone (the server's words, else “Couldn’t reach Whombat. Nothing changed, try again.”). The runtime's 409 — the
agent was retired or the person the turn was for left — is final: its words stay on the card and the button goes.
Everyone else sees the card without a button.

### AP-481 The reason isn't said twice

The runtime writes the failure message and its card. If the message's own text is the reason sentence, the card leaves
it out and shows only the label and the action (the message's text is read from the cache by id, so the message list
needs no new prop). Any other text (“I couldn’t finish this.”) keeps the reason in the card.

### AP-482 A sign-in failure links to AI accounts

The `signin` sentence says “Sign in under Settings → AI accounts, then press Try again.”, so its card has a second,
secondary action “Open AI accounts” (`/settings?tab=ai`, an in-app link). Other codes are fixed by waiting, an owner or
trying again: no link. The link goes once the turn was tried again.

### AP-483 Try again in the Work view

The placeholder `retry_turn` case is replaced: ready when the item carries `refs.dispatchId` and its `failure` wasn't
tried again; offered only with `dispatches.retry` (`buttonActions(item, {retry})`, the Whombat's features passed in so
the model stays pure). It calls the same `dispatches.retry`, toasts “Asked Banjo to try again.” and reads the Work view
again. Its label is core's `TURN_RETRY_LABEL` (“Try again”, already the placeholder's).

### AP-484 A failed item says why

`WorkItem.failure.reason` is shown to everyone as the item's detail line (the server's `detail` only when it adds
something, `detailAdds`). `failure.detail` — filled by the runtime only for burrow owners and admins, redacted, at most
2000 characters — is behind a ghost “Technical detail” button beside “Show activity” (`aria-expanded`,
`aria-controls`): a mono block on the code surface, wrapped, at most 16 lines tall and scrolling. Never in a
channel. After a retry the item says “Tried again · 14:32” under the reason.

### AP-485 The retry in the client package

`useRetryTurn(burrow)` (`@whombat/client/react`) and `applyTurnRetry` / `markTurnRetried` / `markWorkRetried`
(`@whombat/client/query`, pure): after `dispatches.retry` answers, every cached `turn_failed` card of that turn and its
Work item are marked retried at once, then the runtime's `message.updated` (the card's `retriedAt`) confirms it for
everyone through the existing reducer. A card already marked keeps its time. The phone can use the same hook.

## Branch rooms by repo and number (item 5)

### AP-496 `/pr/:number?repo=owner/name`

- The route keeps its path; `?repo=owner/name` is a search parameter (`validateBranchSearch`, `owner/name` only, ≤ 200),
  so every old `/pr/482` link still opens. The screen is keyed by repo and number.
- With `repo`, `prs.get` and `prs.merge` are asked with `?repo=` (both accepted it before 0.26). Without it: the one
  sidebar room with that number (its repo from `BranchRoomSummary.repo`, else its link's `repo`); with several rooms of
  that number whose repos are known, the screen asks **“Which PR #1?”** — “Two repos have a pull request #1. Pick the
  one you meant.” and one row per room (status dot, repo in DM Mono, branch · state, the number), each a real link to
  `?repo=`, followed with `replace`. Never a silent pick. Rooms of an older runtime carry no repo and can't be told
  apart: the server picks, as before. This is how `prs.repo` gates it: only a runtime with it sends the repos.
- The shell reads `?repo=` (`parseShellLocation(pathname, search)`): the sidebar marks only the open room, and without
  a repo only a number no other room has; Alt+↑/↓ steps through rooms with their repo; the plans pane finds the room by
  repo too. The sidebar's room links (and “Files changed” in their menu) carry `?repo=` (the only change to
  `Sidebar.tsx`, W2's file).
- Cards, notifications, the Work view, search and plan links already go through `appPath(link)`, which writes `?repo=`
  from the runtime's `PrLink.repo` (CT-170); nothing else to change there.

### AP-497 Links from runs and automation steps

A run knows its PR's number and its repo's id, not the name. `usePrHref(burrow)` links such a PR: the room's own link
when the number is the sidebar's only one; when two repos share it, the name from `repos.list` (read only then); else
the bare number, where the room asks. Used by the run card (`RunCard`'s new optional `branchHref`), the run page and an
automation run's “PR #n” step link.

## GitHub on managed Whombats (item 6)

### AP-493 Software Dev: sign in, then connect

When `github.status` says `via: 'signin'` (on a runtime with `github.signin`) the GITHUB card no longer talks about gh
on the host:
- `signInNeeded` (an owner without a GitHub sign-in): “Not connected” · “Sign in to GitHub with your own account, then
  connect it for the burrow. Everything on GitHub happens as that account.” and, in the card, **Sign in to GitHub**
  (GitHub's device code) or “Use a token instead”.
- signed in, not connected: “You’re signed in to GitHub as @maraokafor. Connect it to bring in repos; everything on
  GitHub happens as @maraokafor.” and **Connect GitHub** (the existing `github.connect`).
- a member: “An owner connects GitHub with their own GitHub account.”
- connected: “Connected as @login” and the repo list, as before.
The host-admin lock (`ownerAdminLockedReason`) is for the host's gh only, and a problem's `fix` command is never shown
(there is no shell). Self-hosted (`via` absent or `gh`) keeps the host gh flow and text unchanged.

### AP-494 GitHub's device code and token

`DeviceCode` takes `kind="github"`: GitHub's words (`GITHUB_SIGNIN_TEXT.device`: “Open github.com”, “Enter this code”,
Copy code, the countdown, “GitHub then asks you to authorize the GitHub CLI for your account…”, “This is GitHub’s own
sign-in: Whombat shows you its code and never sees your password.”) and only an `https:` page on github.com (or a
subdomain) gets a button (`githubSignInUrl`). The same 3 s poll, “Get a new code”, Cancel. A token is a password field
(“GitHub token”, the repo and workflow scopes), sent once through `signins.loginStart {github, token}` +
`loginSubmit`, never shown again. The words live in `@whombat/client/signins` (`github.ts`) so the phone can show the
state and “Sign in on the web” with the same copy.

### AP-495 GitHub in AI accounts

YOUR AI SIGN-INS gets a GitHub row after Claude Code and Codex (“GitHub” · “Signed in as @maraokafor” / “Not signed
in”, Sign out, or the device code and the token) on a managed Whombat, or wherever `github.status.via` is `signin`,
with `github.signin`; and wherever the person has a GitHub sign-in anyway, so they can sign out. A self-hosted Whombat
reaches GitHub through its host's gh: no row. Signing in or out reads the sign-ins and `github.status` again.

## Members and agents (item 10)

### AP-486 The member menu

On a runtime with `members.manage` each member row gets a “More for {Name}” button (the plan step's tool button, 32px,
44px on touch) opening the sidebar's row menu: **Make owner** / **Make member** (core's `canSetMemberRole`: owners
only, a real change, never the last owner to member), **Remove from burrow…** (owners, `canRemoveMember`) and, on your
own row, **Leave burrow…**. Your row says “· you”. A role change calls `members.setRole` and toasts “Joris is an owner
now.”. On a managed Whombat the appliance's own “Make owner” (owner of this Whombat, G-06) stays where it was and is
named for the Whombat; the menu is the burrow's.

### AP-487 Removing and leaving ask first, and say what happens

Removing: “Remove Joris de Vries from Burrow HQ?” — “Joris loses access at once and leaves every conversation here.
Their personal assistant retires, their Vault entries in this burrow are deleted and their requests still waiting for
approval are cancelled.” (+ “Their devices can’t open this Whombat any more.” on a managed one), “Their messages and
signed history stay, marked “former member”. To come back, they need a new invite.” — Cancel / Remove Joris. Leaving:
“Leave Burrow HQ?” with the same in the first person, Stay / Leave burrow; leaving asks for the session again and goes
home (another burrow, or onboarding). The last owner is told “You’re the only owner of Burrow HQ. Make someone else an
owner first, then you can leave.” and nothing is sent. People the server still lists with `removedAt` are under
**FORMER MEMBERS · n** (“Left 18 Sep”, “Former member”, the avatar dimmed), never in MEMBERS.

### AP-488 Danger zone: Retire {Name}

The agent settings page gets its last tab, **Danger zone** (AP-386's follow-up), on a runtime with `agents.retire`,
for team agents (a personal assistant retires only with its person, so it has none). RETIRE (the bad tone) · “Retire
Banjo” · what happens · a bad-toned **Retire Banjo…**; for someone core's `canRetireAgent` refuses, the button is
disabled with “Only owners and Mara, who hired Banjo, can retire it.”. The confirm: “Retire Banjo?” — “Banjo stops at
once: its live runs stop, its queued turns are cancelled, its keys go and it leaves every channel.” “Its DM stays
readable and its name stays in the history, marked “retired”. @banjo stays taken, so no new agent gets its name.
Retiring can’t be undone.” — Cancel / Retire Banjo. Afterwards “Retired Banjo.” and the roster. A retired agent's
settings page says “Quill was retired on 21 Sep, so there is nothing to configure. Its DM and its history stay
readable.” and its role line ends “· retired”.

### AP-489 History keeps the names

Wherever history names someone who is gone, core's `principalStatusLabel` follows the name: a message's author
(“retired”, “former member” in the time's mono, muted), the audit log's actor (a tag), and a retired agent's profile
pane (“Retired” where the status was). Lists and pickers leave them out: the roster, a plan step's owner picker, the members
list, with core's `isActivePrincipal` (removed and retired principals stay in `Bootstrap.principals` for history); the
Danger zone names the hirer only while they're still a member. The sidebar's AGENTS and DIRECT are W2's, which filters
them the same way.

## Notifications (item 12)

### AP-490 Settings → Notifications

A tab for everyone, right after General (it's about you, like General's profile), gated by `notifications.levels`
(“Update your Whombat to use notification settings.” otherwise). A line on top points to the per-conversation bell. Then:
DO NOT DISTURB (the state with a dot — “Do not disturb is on until 12:22.” with **Turn off**, else “Off” — what it does,
and “Pause for” / “Change to” with core's `DND_PRESET_LABELS` and **Custom…**), QUIET HOURS (a switch with the summary
“Every day, 22:00–08:00 (until the next morning)”, then From / to time fields and the days as seven toggles in the
segmented control's shape), EMAIL (Off / Hourly / Daily with what each means) only where `Bootstrap.capabilities
.emailNotifications` is true, THREADS (“Replies in your threads”) and THIS BROWSER (the push subscription's state with
Turn on / Turn off, from a click only), left out where `capabilities.webPush` is false.

### AP-491 Saving: the whole `notifications`, only `notifications`

Every change saves at once. `me.updatePreferences` replaces `notifications` whole, so a change is applied to what the
server has now (read just before) and only `{notifications}` is sent — theme, time zone, the assistant's and the
avatars' preferences are never sent back. The caches show it at once and a failure puts the old value back with “That
didn’t save. Try again in a moment.”. Toasts only for Do not disturb (“Do not disturb until 12:22.”, “Do not disturb is
off.”); the rest shows in place.

### AP-492 Times are the person's

A custom end is a `datetime-local` read in the person's zone (`Preferences.timeZone`, else the burrow's) with core's
`zonedInstant`, not the browser's; it must lie ahead (“Pick a time that’s still to come.”). It opens two hours ahead on
the hour. Ends read “12:22”, “tomorrow at 08:00”, “Sat at 08:00”, “3 Oct at 08:00”. Quiet-hour times save once a whole
time rests for half a second; switching quiet hours on with no day picked picks every day. The hint says “A night that
starts on Friday ends on Saturday morning; the same time twice is the whole day.” (CT-175's rules).

## Coordination and fixtures

### AP-498 What this stream touched in W2's files

W2 owns the sidebar. Changed here, as small as the features allow: `Sidebar.tsx` — the branch-room links' `search`
(and “Files changed”); `sidebarModel.ts` — `RoomRow.repo`, the rooms' `selected`, `conversationPaths` with the repo,
`conversationPathOf`; `location.ts` / `BurrowShell.tsx` — the shell reads `?repo=`. Retired agents leaving the sidebar
is W2's (its `isActivePrincipal` filter). `MessageRow.tsx` (W1's) got the one “retired / former member” label.
Open, after W2 is on main: a retired agent's DM is readable but closed — `DmScreen` passes W2's
`ConversationRoom.readOnly` (AP-472) core's `retiredAgentText(name)` (“Banjo is retired. You can still read this
conversation.”); a “Notifications” entry in the account menu (members reach the tab through Settings today); the
footer's DND moon and the conversation bell are W2's.

### AP-499 The fixture world's essentials settings

`app/essentialsSettingsFixtures.ts`, only when asked for (`essentialsSettings: true` or
`VITE_FIXTURE_ESSENTIALS_SETTINGS=1`), so the mock's screens and the visual suite stay as drawn: Pippa's failed turn
(`signin`) in Mara's DM, two FAILED Work items (that turn with its detail; Banjo's sandbox that didn't start with “fs
sandbox helper failed: Read-only file system”) and `dispatches.retry`; PR #1 in whombat/web and whombat/infra beside
#482 (rooms, details, empty conversations); GitHub through Mara's own sign-in (`via: 'signin'`, connecting once the fake
AI side has her GitHub sign-in); Joris an owner, Sam a former member, `members.setRole` / `.remove`; Quill, a retired
writer, with a message in #general and `agents.retire`; `Bootstrap.capabilities`. The fake AI side
(`managed/fake/ai.ts`) signs in to GitHub too: modes `github:device` / `github:token`, the device page
`https://github.com/login/device`, the login `maraokafor`.
