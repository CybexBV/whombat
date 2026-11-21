# Whombat Feedback — implementation checklist

Decisions and architecture: `docs/decisions/feedback.md` (FB-01 … FB-26). Branch `feedback-widget`.
Owner of shared contracts, the migration and the lockfile: the orchestrator (workers ask, never edit them).

## Phase 0 — frozen contracts (orchestrator)

- [x] Decision record with trust boundaries, schema, endpoints, runtime and failure behaviour
- [x] `@whombat/core`: `domain/feedback.ts`, `domain/feedback-card.ts` (report card in `MessageCard`/`StoredCard`),
      `contracts/feedback.ts` (`api.feedback.*`, public paths), `feedback/sanitize.ts` (no imports),
      `feedback/install.ts` (snippets, ids, the `WhombatFeedbackApi` loader contract), dispatch trigger `feedback`,
      principal `system: 'feedback'`, id prefixes `fbi`/`fbr`/`fba`; unit tests
- [x] Migration `0027_feedback` (`feedback_integrations`, `feedback_reports`, `feedback_assessments`)
- [x] Config `WHOMBAT_FEEDBACK`, `WHOMBAT_WIDGET_DIST`; `/embed` is a server prefix; `services.feedback`
- [x] Server skeleton `apps/server/src/feedback/{index,embed,public,service,cards}.ts`; report cards resolve on read
- [x] `apps/widget` package; `pngjs` + `jpeg-js` on the server (lockfile)

## Workstream A — ingress, persistence, routing, authorization (server)

- [x] Feedback system principal per burrow (lazy, like GitHub's)
- [x] Integration commands (create/update/intake/assessment) with owner + channel + agent + repo checks, signed events
- [x] `api.feedback.*` integration and report routes (list/get with snippets and health; status, redact)
- [x] Public config + submission endpoints: Origin check, body caps, token buckets, trusted-proxy client IP
- [x] Image validation: sniff, header dimensions, full decode with caps, re-encode, semaphore
- [x] Atomic intake: report, root message (inert text, `mentions: []`, `dispatch: false`), attachments, signed event
- [x] Idempotency (same receipt / 409), durable daily cap
- [x] Automations ignore feedback-principal messages
- [x] Retention sweep and manual content removal
- [x] Integration tests (real Postgres): all of the above, counts of accounts/principals/members unchanged

## Workstream B — widget, SDK, embedding (apps/widget + server embed.ts)

- [x] Loader: shadow-DOM launcher, `WhombatFeedback` API, `data-*` attributes, declarative triggers, bridge
- [x] Frame UI: form, types, contact fields, screenshots with preview, context preview, states, receipt
- [x] Accessibility: focus trap/restore, Escape, labels, live regions, validation; themes; narrow screens
- [x] `frame.html` with per-integration `frame-ancestors`, strict CSP; hashed assets; cache headers
- [x] Build (`dist/v1`), size report, unit tests (bridge validation, sanitizing, API before load)

## Workstream C — internal UI (web + mobile)

- [x] Settings → Feedback tab: list, create/edit form, enable/disable, pause, snippets, CSP, health
- [x] Report card on web with details (submitted data, context, screenshots, assessment), status, retry, handoff, remove
- [x] Mobile report card; fixtures, card states, stories; visual baselines light/dark

## Workstream D — assessment and handoff

- [x] Assessment worker: budget, concurrency, revalidation, atomic dispatch start, observation, timeout
- [x] Restricted dispatch context, persona, runner restrictions (read-only, no network, guarded only)
- [x] MCP restriction for `feedback` dispatches; `submit_assessment`, `feedback_similar_reports`
- [x] Retry path; honest failed/blocked states; crash-window tests
- [x] Handoff approval (bound, revalidated), tested with deterministic agents

## Workstream E — review, browser tests, packaging, docs

- [x] Independent security review of the integrated branch; fixes verified (review-1.md intake/widget → F1;
      review-2.md assessment/handoff → F2; review-3.md verification of both on the integrated branch)
- [x] Playwright: separate-origin plain HTML + SPA demo, custom launcher, keyboard, themes, narrow, 3P cookies
      blocked, hostile embedding, wrong-origin messages
- [x] Packaged build serves `/embed/v1` without Vite; `whombat start` builds the widget
- [x] `docs/feedback.md` (install, CSP, proxy, exposure, private networks, backup), examples (plain, SPA, Cybex)
- [x] ARCHITECTURE.md / DECISIONS.md summaries

## Integration log

| Step | Branch / merge | Result |
|---|---|---|
| Contracts frozen | `d0a8585` | core, schema, skeleton; unit tests |
| A ingress | `fb/a-ingress` (ff) | intake, idempotency, images, authorization |
| B widget | `fb/b-widget` → `cd0736a` | loader, frame, `/embed` serving, packaging |
| C internal UI | `fb/c-ui` → `8f6dc4e` (+ `b9e4d15` membership/provider alignment) | settings, card, Android, baselines |
| D assessment | `fb/d-assess` → `e8b7faa` | worker, restricted turn, retry, handoff |
| E2 verification | `fb/e-verify` → merge | real-server browser suite, packaged run, examples, docs |
| Review 1 fixes | `fb/f1-fixes` → `f998a6f` | R1-1…R1-9 |
| Review 2 fixes | `fb/f2-fixes` → `79d990c` | F1…F9 |
