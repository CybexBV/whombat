# Whombat — implementation TODO

Instructions for the implementing agent:
- Read `README.md` fully before starting. It is the spec; the HTML files in `design/` are the visual reference (open them in a browser).
- Reference product: **Buzz — https://buzz.xyz**. Use it for architecture and behavior decisions the mocks don't cover. Mocks win on visuals, copy and layout.
- Work top to bottom. Check a box only when the item works end to end and matches the mock. Commit per task.
- Use the seed data from `design/Whombat Desktop.dc.html` (`AG0`, `PP`, `CONVS`, `DMS`, `THREAD`, `LOG`, `RESULTS`, `OB`) as fixtures.
- Keep copy verbatim from the mocks.
- If a decision isn't covered by README, Buzz or the mocks, write it to `DECISIONS.md` and move on.

## 0. Setup
- [x] 0.1 Confirm stack (default: React + TypeScript, Vite or Next.js, Postgres, WebSockets). Scaffold repo, lint, format, test runner, CI.
- [x] 0.2 Study buzz.xyz. Write `REFERENCE_NOTES.md`: what Buzz does for agent/human messaging, realtime, permissions, integrations, and which patterns Whombat adopts or rejects.
- [x] 0.3 Storybook (or equivalent) with light/dark toggle.
- [x] 0.4 Load Bricolage Grotesque (400–700, opsz) and DM Mono (400/500).

## 1. Design tokens and primitives
- [x] 1.1 Theme tokens for light and dark exactly as in README (CSS variables). `prefers-color-scheme` default, user toggle, persisted.
- [x] 1.2 Type scale, radii, spacing, shadow tokens.
- [x] 1.3 Primitives: Button (primary/secondary, sizes), Chip/Filter (with count), Segmented control, Toggle, Input, Section label, Role badge, Status dot, Pill, Tag, Toast, Modal (overlay click + Esc), Side pane (inline ≥1240px, overlay below).
- [x] 1.4 Human avatar (initials + tone).
- [x] 1.5 Pick one icon set; replace glyph placeholders.

## 2. Agent avatars
- [x] 2.1 Produce 6 role avatars (architect, developer, researcher, reviewer, operator, support) matching `WhombatAvatar.dc.html` direction B (sweater). Prefer SVG exports; port CSS only if SVG isn't feasible.
- [x] 2.2 `crop="head"` variant for ≤32px. Check legibility at 22px.
- [x] 2.3 Optional: silhouette state (loading/unknown) and directions A/C behind a flag.

## 3. Domain model and backend
- [x] 3.1 Schema per README "State / data model": Burrow, Person, Agent, Channel (channel | branch | dm), Message, Thread, Plan, Run, Approval, AuditEvent, Canvas, Keys.
- [x] 3.2 Seed script from mock fixtures.
- [x] 3.3 Auth + burrow membership; people and agents are both principals.
- [x] 3.4 Signing: every write produces an AuditEvent signed by the actor's key (personal key for people, agent key for agents); store fingerprint; verify on read.
- [x] 3.5 Keys engine: `can` / `ask` / `cannot`. `ask` creates an Approval. Hard-coded non-grantable keys for agents (merge into main, deploy without asking). Blocked attempts log a `Blocked` event with the key needed.
- [x] 3.6 Realtime channel (WebSocket) for messages, typing, run updates, approval state, presence.

## 4. App shell (desktop)
- [x] 4.1 Layout: 256px sidebar, main, optional right pane.
- [x] 4.2 Sidebar sections: burrow name + theme toggle, search button (⌘K), nav (Agents, Canvases, Audit log), Channels with unread badges, Branch rooms with status dot, Agents with live status, Direct, current user footer.
- [x] 4.3 Routing for every screen; deep links for channel, DM, branch room, run, agent, canvas, log filters, search query.
- [x] 4.4 Global keyboard: ⌘K search, Esc closes modal/pane/search.

## 5. Messaging
- [x] 5.1 Conversation header (channel / branch / DM variants), member stack, header actions.
- [x] 5.2 Message list with day dividers, @mention highlighting, reactions, thread link.
- [x] 5.3 Composer with `@ agent` autocomplete, `/ command`, `+ file`, Enter to send.
- [x] 5.4 Thread pane (400px) with replies and reply box.
- [x] 5.5 Agent DM + empty state with role-specific suggestion chips.
- [x] 5.6 Mentioning an agent (or any DM message) dispatches to that agent; show "{name} is thinking"; stream the reply.
- [x] 5.7 Agent runtime adapter: interface for connecting agents to an LLM/tooling backend (follow Buzz patterns noted in 0.2). Stub with canned replies first.

## 6. Chat cards
- [x] 6.1 Plan card (done / active / queued / gate markers, owner, state).
- [x] 6.2 Research card (verdict pills).
- [x] 6.3 Run card (live dot, progress, current step, tests, diff stat).
- [x] 6.4 Review card (diff block + numbered comments).
- [x] 6.5 Approval card (pending warn border, conditions, approve/details/undo, all 4 label states).
- [x] 6.6 Commits list, status pill, receipts block (deep links).

## 7. Agents
- [x] 7.1 Roster grid with status, activity, keys summary.
- [x] 7.2 Agent profile pane: actions, Right now, Keys, Channels, Recent, "Full audit trail →" (log filtered to agent).
- [x] 7.3 Hire modal: role picker with live avatar preview, name, key toggles (locked keys), creates agent + audit event + toast, opens profile.
- [x] 7.4 Configure agent (edit keys, channels) — not mocked; follow hire modal patterns; every change is a `Keys` audit event.

## 8. Runs
- [x] 8.1 Run page: header, Pause / Take over, steps timeline, live log (bottom-anchored, last N lines), keys used, files touched.
- [x] 8.2 Stream run events; update run card, plan steps, branch checks and sidebar status in realtime.
- [x] 8.3 Pause and Take over behavior (define in DECISIONS.md; check Buzz).

## 9. Approvals
- [x] 9.1 Approval modal (what happens, conditions, explainer, decline/approve).
- [x] 9.2 Approve-in-advance: execute automatically when remaining conditions are met.
- [x] 9.3 Undo, decline notifications, audit events for every decision.
- [x] 9.4 Notifications (desktop + mobile push) for "Needs you" items.

## 10. Code integration (GitHub)
- [x] 10.1 Connect repos (GitHub App); only switched-on repos visible to agents.
- [x] 10.2 Branch rooms auto-created per PR; Conversation + Files changed tabs.
- [x] 10.3 Branch side pane: checks, reviewers, staging status, Merge into main (people only; disabled until green).
- [x] 10.4 Mirror PR events (commits, checks, reviews) into the room as messages/cards.

## 11. Canvas
- [x] 11.1 Collaborative doc (CRDT, e.g. Yjs) with presence and per-author carets ("Sketch is writing").
- [x] 11.2 Plan block synced with Plan objects.
- [x] 11.3 Author-tinted highlights and side comments (column ≥1200px, stacked below).
- [x] 11.4 Canvases index (sidebar "Canvases") — not mocked; simple list.

## 12. Search
- [x] 12.1 Index messages, threads, patches, runs, canvases.
- [x] 12.2 Agent answer card with inline numbered citations tied to results; actions (post to channel, open source).
- [x] 12.3 Type filters with counts; result rows; "receipt n" markers.

## 13. Audit log
- [x] 13.1 Append-only event list grouped by day; filters (actor type, agent, kind) with counts.
- [x] 13.2 Expandable detail: signed by + fingerprint, key used/needed, on behalf of, decided, signature verified, deep link.
- [x] 13.3 Export CSV of current filter.

## 14. Onboarding
- [x] 14.1 4-step flow: name burrow (slug preview), connect repos, pick agents, invite team. Clover tips per step.
- [x] 14.2 Creates burrow, agents with default keys, invites by email.

## 15. Mobile
- [x] 15.1 Decide native (React Native/Expo) vs PWA; record in DECISIONS.md.
- [x] 15.2 Inbox with filters and sections; inline Approve.
- [x] 15.3 Approval detail with sticky Decline/Approve → Undo.
- [x] 15.4 Agent DM with bubbles and receipts.
- [x] 15.5 Tab bar (Inbox, Channels, Agents, Search); light/dark.

## 16. Quality
- [x] 16.1 Visual regression vs the HTML references for every screen, light and dark.
- [x] 16.2 Accessibility: 4.5:1 text contrast, focus rings, keyboard nav, 44px mobile targets, screen-reader labels for avatars and status dots.
- [x] 16.3 Tests for keys engine, approval conditions, audit signing/verification.
- [x] 16.4 Empty, loading and error states for every list (not mocked; keep them quiet and in the same visual language).
