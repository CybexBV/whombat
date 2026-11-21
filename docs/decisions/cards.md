# Workstream: chat cards (`apps/web/src/features/cards`)

TODO 6.1–6.6 and the web half of 8.2 (run card streaming). Builds on `web-shell.md`, `client.md`,
`core-contracts.md`, `tokens-primitives.md` and `avatars.md`.

## Layout

```
MessageCard.tsx     the seam the message list renders for `message.card` (props unchanged, + optional
                    `variant: 'message' | 'thread'`); reads the cached bootstrap for names, wires links
                    and the approval container (optimistic decide / undo, toasts, Details → ?approval=)
PlanCard, ResearchCard, RunCard, ReviewCard, ApprovalCard, ListCards (Commits, Pill, Answer)
                    presentational cards: contract types in, callbacks / `onNavigate` out
parts.tsx           CardLink / CardAction (in-app links styled as the mock's buttons), PrincipalAvatar,
                    DiffStatText, principal / name lookups
links.ts            where each card's links go (`linkPath()`)
cardStates.ts       every card state as data (fixtures + the mock's states): stories, tests, visual harness
```

## Decisions

| # | Decision | Reason |
|---|---|---|
| CD-01 | **Live cards come from the cache, not from card-local state.** Plan, run and approval cards embed the live object; the client's reducers patch it on `run.updated` (every `run_log` / `run_step` / `run_tests` publishes one, so "Now: …", progress, tests and the diff stream), `plan.updated` and `approval.updated`. The card never subscribes itself: the screen that lists the messages holds `conv:` and the burrow topic. `run.log` lines only feed the run page. | One source of truth; the card, the modal, the plan step and the inbox can never disagree. |
| CD-02 | Card CTAs that navigate ("Open plan canvas", "Watch run", "Branch room", receipts, "Open in search") are **links** styled as the mock's buttons, routed in-app on plain left clicks; modified clicks open new tabs; external receipts open in a new tab. Approve / Details / Undo are buttons. | Accessibility (real links for navigation), same pixels. |
| CD-03 | **Receipts**: an answer that came from a search (`card.query`) sends every receipt and "Open in search" to `/search?q=<query>` (as the mock does); other answers deep-link each receipt to its `LinkRef`; a receipt without a link searches for its source. | The mock's `r.go` opens search with the query; DMs have no query to go back to. |
| CD-04 | **Approve** shows the toast from `approvalView().toasts.approve` immediately ("Approved in advance. Dusty will deploy when checks are green." / "Approved. Dusty is deploying to staging.") and flips the card optimistically. A `blocked` result shows the server's message, `pending_approval` shows "That needs a person to approve it first.", network errors "Couldn’t reach Whombat. Nothing changed, try again."; each rolls the card back (the client restores its snapshot). Undo has no toast (the mock has none). Decline lives in the approval modal (approvals workstream). | Mock behaviour; outcomes from C-13. |
| CD-05 | Approve is hidden for viewers who cannot decide (`approvalView().canApprove`: approvers + owners); Details stays. Undo shows while decided and not executed (B-02), so DEPLOYED shows no Undo — the mock still shows it. | B-02; people without the right don't see a button that would be blocked. |
| CD-06 | Label states are all `approvalView()`: NEEDS A PERSON, APPROVED · WAITING FOR CHECKS / FOR REVIEW, APPROVED · DEPLOYING, DEPLOYED, DEPLOY FAILED, DECLINED. The 1.5px warn border is only on `pendingBorder` (pending); decided cards keep 1.5px in `--line` so the height never jumps. | core-contracts "Approvals". |
| CD-07 | Run statuses beyond the mock (paused, failed, taken over) reuse the run card: label `RUN · PAUSED` etc. from `formatRunLabel`, dot without halo in waiting / bad / mut, "Now:" replaced by `runNowText()` ("Paused: …", the summary when finished). The halo only shows while live. | B-05: nearest mocked pattern. |
| CD-08 | Plan markers: done = filled ok circle, active = developer-green outline, queued = `--line2` outline, gate = warn outlined square rotated 45°. Each marker is `role="img"` with a word ("Done", "In progress", "Queued", "Needs a person"). Owner avatars are decorative (name beside them). | Spec + accessibility. |
| CD-09 | Diff lines in the review card are one `<pre><code>` with screen-reader prefixes ("Added:", "Removed:"); code colours are the README's fixed code-block tokens. | Readable by screen readers, same pixels. |
| CD-10 | The met-condition ✓ is Lucide's check (TP-14) at 12px inside the 18px circle. | Deliberate icon difference, masked in the visual spec. |
| CD-11 | A receipt's `where` sits beside the source when it fits (the mock's [24px · 1fr · auto] look, unchanged for a few words) and wraps under it when it doesn't: the source and `where` share a wrapping flex line, the source at least 16em wide; long unbroken ids wrap anywhere. The contract describes `source` (one source) and `detail` (a few words: who, state, count, section; not the finding), and the persona and runner prompts say the same; `detail` keeps its 120-character limit so existing agents' calls don't start failing. | Asked for by the user (2026-09-25): agents wrote sentences into `detail`, the `auto` column squeezed the source to a word per line and an id spilled over the detail. |

## Shared files touched

- `packages/fixtures/src/messages.ts`: the research rows, the review diff + comments and the commits footer
  now use the mock's literals from `renderVals()`, and the #incidents answer carries its search query
  (`query: SEARCH_QUERY`, the mock's `search: true` → "Open in search"). Copy only; no schema change.
- `apps/web/visual/cards.html` + `cardsHarness.tsx`: a dev-only Vite page that renders `<MessageCard>`
  inside the app's providers, either every state from `cardStates.ts` (fixtures) or a real conversation's
  cards over the socket (`?live=billing-v2`, `?live=pr/482`; sign in at `/login` first).

## Verification

- `pnpm visual` → `apps/web/visual/cards.spec.ts`: each card cropped from the reference (channel: plan,
  research, run, approval; after "Approve in advance": waiting; after 8 faked 2.6 s ticks: run done, plan
  finished, DEPLOYED, and "Approve and deploy" without approving; Details → Decline: DECLINED; branch:
  commits, status pill, review; #incidents: receipts) vs the same card from the harness at the same
  sub-pixel offset, light and dark. Every card is 0.000 % except the plan (0.02–0.035 %, avatar
  anti-aliasing at 22px, AV-02). DEPLOYED compares the part above the mock's Undo row (CD-05).
  Diffs in `tmp/visual/cards/`.
- Not capturable: the thread pane's compact receipts (the mock's "5 replies" does not open its pane).
- Live: a throwaway database seeded with `pnpm db:seed`, server + scripted runner + web on free ports,
  `?live=billing-v2`, Approve in advance, `pnpm demo:play`: the run card streamed every LIVE line
  ("Now: Editing billing/pdf/format.ts" … "✓ 41 of 41 tests passed"), progress 55 → 70 → 90 → 100, tests
  turned ok at 41 of 41, RUN · DONE with the summary and +250 −20; the approval went WAITING FOR CHECKS →
  WAITING FOR REVIEW → DEPLOYING → DEPLOYED and the plan steps followed to Done/Approved/Deployed, with no
  reload.
- Unit / component tests: `cards.test.tsx` (every card and state, links, a11y labels) and
  `MessageCard.test.tsx` (optimistic approve + toast + undo, blocked and pending outcomes roll back,
  Details → `?approval=12`, run and plan streaming through `applyRealtimeEvent`).
