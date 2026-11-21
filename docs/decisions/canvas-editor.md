# Workstream: canvas editor (web side of TODO 11.1–11.3)

The live collaborative canvas in `apps/web/src/features/canvas`: a Tiptap editor on `@whombat/canvas-schema/tiptap`
bound to the canvas Y.Doc over `/collab`. The server side is `collab-server.md`; the screen's scope and the
Resolve/Reply affordances are `canvas-onboarding.md` (still valid; its "static body" parts are superseded here).

## Layout

```
apps/web/src/features/canvas/
  CanvasScreen.tsx        header (presence from awareness, connection state), article, comments, "Comment" button
  collab/types.ts         CanvasCollabSession {ydoc, awareness, snapshot(): {status, synced, scope}}
  collab/hocuspocus.ts    the session on the server's /collab (HocuspocusProvider, collab tokens)
  collab/local.ts         LocalCollabHub: peers synced in memory (fixture mode, component tests)
  collab/fixture.ts       fixture mode: the seed's document + the mock's collaborators (Sketch writing)
  collab/session.tsx      useCanvasCollab(target), CanvasCollabProvider (override the factory)
  collab/users.ts         CollabUser of a principal, collaborators from awareness, "N here"
  editor/CanvasEditor.tsx the editor (useEditor + EditorContent), author tint variables
  editor/extensions.ts    canvasExtensions + node views + Collaboration + presence + comment focus
  editor/nodeViews.tsx    title block (h1 + provenance), plan block, plan step rows
  editor/presence.ts      carets (y-prosemirror cursor plugin), "{name} is writing", our own `writing`
  editor/anchors.ts       comment anchors ⇄ positions, block tops
  comments/               CommentsColumn (threads, composer, reply, resolve), layoutThreads
apps/server/src/demo/sketch.ts   Sketch writing the third rule during the demo (see below)
```

## Decisions

| # | Decision | Reason |
|---|---|---|
| CE-01 | **The session is an interface** (`CanvasCollabSession`: Y.Doc, awareness, status / synced / scope). The app uses Hocuspocus; fixture mode and tests use `LocalCollabHub`, which relays document and awareness updates between in-memory peers like the server (a read-only peer's changes are not relayed, as Hocuspocus drops them). The factory comes from `CanvasCollabProvider`, else `services.fixtures` picks fixture vs server. | The screen, editor and tests do not care where the document lives; visual specs and component tests run without a server. |
| CE-02 | **Fixture mode builds the seed's document**: `buildCanvasYDoc` (new in `@whombat/canvas-schema`, the pure part of the seed's `seedCanvasDocument`) with the fixtures' Markdown (`CANVAS_MARKDOWN`, now exported from `@whombat/fixtures`) and client id 1, so the fixtures' comment anchors resolve exactly as on the seeded server. The plan canvas's local hub has Sketch as a peer: `writing: true`, caret after "keyed by invoice number and locale" (`FIXTURE_WRITERS`). | The mock's live moment comes from real awareness state, not markup; the same rendering path as production. |
| CE-03 | **Tokens**: the provider's `token` is a function; tokens are cached until 30 s before they expire (5 min TTL), so every reconnect after that fetches a fresh one. A 4xx from `canvases.collabToken` (or a keys-engine outcome) is a refusal → `denied`, the socket stops reconnecting. Network failures retry with backoff (1, 2, 5, 10, 30 s). A server-side `permission-denied` drops the cached token and retries once with a fresh one, then `denied`. Reconnects themselves are the provider's (exponential backoff). | "Reconnects, token refresh" without hammering the server after access is revoked (the server closes revoked connections, `collab-server.md`). |
| CE-04 | **The editor mounts once the document has synced** (a static h1 + provenance holds the layout until then). Editable = synced ∧ scope `read-write` ∧ not denied. The header says so quietly: "Read only", "Reconnecting…", "You can’t edit this canvas any more" (mono badge type, muted; not in the mock, B-05). | Typing into an unsynced empty Y.Doc would duplicate the document on sync; agents with an `ask` canvas key get read-only connections (server). |
| CE-05 | **Carets**: y-prosemirror's cursor plugin used directly (not `@tiptap/extension-collaboration-caret`), because our colors are token variables (`var(--role-architect)`) and both the Tiptap extension and y-prosemirror only accept `#rrggbb` (the extension blanks them, y-prosemirror warns on every render). The plugin's awareness filter keeps the identity in `collabUser` and hands the plugin a hex placeholder; our caret builder colors from the role / tone. Caret = the mock's 2px × 20px bar (`vertical-align: -4px`, 1px margin); selections are the author color at 20%. No name labels on carets: the mock has none — the "is writing" tag names the writer. | Mock caret exactly; no console noise. |
| CE-06 | **"{name} is writing"**: for every other collaborator with `writing: true` and a caret, the row the caret is in (its list item, plan step or top-level block) gets `canvas-live` (hi background, 10px radius, `padding: 6px 10px; margin: 0 -10px` for rows and paragraphs) and a tag widget (absolute, `right: 10px; top: -11px`, role accent, `--on-solid` text, 18px avatar at 25% on-solid). Several writers in one row share one tag strip. People are named by first name ("Mara is writing"), agents by name. Our own `writing` is set on local document changes and cleared 2.5 s after the last one or on blur. | Exactly the mock's Sketch paragraph, for anyone. |
| CE-07 | **Presence ("N here")** is awareness: each principal once, in the awareness map's order (our own state first), until synced the server's `presentIds`. Presence avatars are 24px in a 28px ring: `--bg` for people, the role accent for agents (the mock's Sketch ring). Avatars carry the person's / agent's name as their label. | Mock + accessibility. |
| CE-08 | **Plan block**: React node views. Rows show the live Plan (`CanvasDetail.plan`, patched by `plan.updated` frames) matched by `stepId`, falling back to the block's attributes (which the server syncs anyway); markers from `planStepMarker` (same as the plan card). Titles are the editable text: edits (and new lines, Enter) go through the document and the server turns them into Plan changes (`collab-server.md`). Owners show the principal's full name (as before). | "Live Plan rows" and "editing through the doc" without a second write path. |
| CE-09 | **Highlights**: the `authorHighlight` mark renders `<mark class="canvas-highlight" style="background: var(--hl-bg-<id>, var(--sel)); border-bottom-color: var(--hl-line-<id>, …)">`; the editor root sets those variables for every principal: researcher → `--mark`, reviewer → `--mark2` (the README's two tints), other roles → the role accent at 16% (24% dark) via `color-mix`, people → `--brand` at 14% (22% dark); underline = role accent (people: `--brand`), 2px, `padding: 0 2px`. | Marks re-render only when the document changes; CSS variables keep tints live as principals load, and theme-aware. |
| CE-10 | **Comments column (≥1200px)**: threads are placed with `layoutThreads`: each wants the top of the top-level block its anchor is in (anchor → position via the binding's relative-position mapping), never above the column start (320px, the mock's `canvasPad`), never overlapping the previous thread (16px gap); threads whose anchor is gone go last. Below 1200px they stack under the article in the order they were started. The mock's layout falls out of the rule (Pippa's thread at 320, Hazel's stacked under it). Relayout on document updates (next frame), resizes (ResizeObserver on the article and each thread) and comment changes. | "Next to their anchors" and the mock's exact positions. |
| CE-11 | **New comments**: a non-empty selection in one textblock shows a floating "Comment" button above its end (and Mod-Alt-M); the composer opens in the column at the selection's block (stacked first below 1200px), the quoted words keep a focus background while you type, ⌘/Ctrl-Enter sends, Esc cancels. The anchor is a relative position on the first quoted character with the default association — y-prosemirror's `absolutePositionToRelativePosition` associates with the character *before* (right for carets), so it is re-created from its absolute position — i.e. exactly what the server's `anchorForQuote` makes (tested: the posted anchor equals it). Selections spanning blocks are cut at the first block's end; quotes ≤ 500 chars. Hovering a thread highlights its words. | Anchors stick to the quoted words when someone types just before them; the server can mark them. |
| CE-12 | Editor events and awareness changes can fire while React renders a node view; screen state that follows them (selection button, thread layout, collaborators) is updated on the next frame / microtask. | No "update while rendering" warnings. |
| CE-13 | The canvas screen subscribes to `canvas:<id>` so `canvas.updated` (provenance, "edited by …, 12 min ago") and `canvas.comment` frames reach its cache. | Provenance from real data. |
| CE-14 | Visual fixes on the canvas header found while diffing: title 17px/600 (was the 21px header token), Share without an icon (the mock's plain button). The plan canvas fixture's `updatedAt` is 11:10 (was 14:07, after the seeded "now"), so the provenance reads "12 min ago" at 11:22 like the mock. | Mocks win. |

## Demo: Sketch writes the third rule (`apps/server/src/demo/sketch.ts`)

`DemoDirector.play()` starts `SketchWriter` (a small additive hook in the director; `rewind()`/`close()` stop it,
`settled()` waits for it, `afterRun` finishes it):

1. The rule ("PDFs are generated on request …") restarts from its first words and Sketch types it in four
   `edit_canvas` commits (signed as Sketch under "Write canvases"), 650 ms apart, ending at "…keyed by invoice number
   and locale" — the mock's moment, reached within ~2 s of play. A canvas without the rule gets it appended.
2. He then stays writing at the end of the rule: every 3 s his awareness is renewed (`participantWriting` +
   `participantWrote` with his caret after the last word), so whoever opens the canvas sees exactly the mock.
3. When Banjo's run is done he writes the full stop; writing lapses (4 s) and his presence expires (60 s) as after
   any agent edit.

Verified against a real server during the demo (the screen matches the reference apart from the relative time and
the Resolve/Reply controls) and in `sketch.int.test.ts`.

## Tests and verification

- Component tests (jsdom, local hub): `CanvasEditor.test.tsx` — two editors converge, see each other's caret (role
  color) and "Pippa is writing" on the right row; plan rows from the live Plan and plan edits through the document;
  author tint variables; a read-only peer cannot type and its local changes are not relayed. `CanvasScreen.test.tsx` —
  fixture canvas with "2 here", Sketch's tag and caret, other canvases' documents, Share, reply, resolve, and a new
  comment from a selection (Mod-Alt-M) posting the anchor `anchorForQuote` gives. Unit: tokens (`hocuspocus.test.ts`),
  thread layout, awareness readers, `buildCanvasYDoc`.
- e2e (`e2e/canvas.spec.ts`, real server + Postgres): Joris and Priya in two browser contexts see "2 here", each
  other's text, carets (tone colors) and "… is writing"; a reload loads both edits; provenance "edited by Priya, Joris…"
  (Mara is left to `login.spec.ts`, which runs in parallel and reads the same mail log). `e2e/support/auth.ts` signs in.
- Visual (`visual/canvas.spec.ts`, fixture mode, frozen clock): 1440 light/dark 0.035%, 1100 light/dark 0.008%
  (main column; at 1440 the column below the first thread's last comment is masked for the Resolve/Reply controls).
- Server: `sketch.int.test.ts` (Sketch's signed edits, writing + caret after "locale" for early and late joiners, the
  full stop, replay).

## Shared files touched

- `packages/canvas-schema/src/build.ts` (+ test, `index.ts` export): `buildCanvasYDoc`, `SEED_CLIENT_ID`. The server's
  `seedCanvasDocument` still has its own copy (same algorithm); folding it onto `buildCanvasYDoc` is a follow-up.
- `packages/fixtures/src/canvas.ts` / `seed.ts`: `CANVAS_MARKDOWN` moved to `canvas.ts` and exported (seed unchanged);
  plan canvas `updatedAt` 14:07 → 11:10.
- `apps/server/src/demo/director.ts`: 13 lines (construct / start / finish / stop `SketchWriter`, `settled`).
- `apps/web/package.json` + lockfile: `@tiptap/{core,pm,react,extension-collaboration,y-tiptap}` 3.31.3,
  `@hocuspocus/provider` 4, `yjs`, `y-protocols`, `lib0`, `@whombat/canvas-schema`.

## Follow-ups

- The server's `seedCanvasDocument` can call `buildCanvasYDoc`.
- Resolved threads stay in the column (dimmed) with "Reopen"; a "show resolved" toggle would declutter long canvases.
- Formatting UI (bold/italic/headings) is keyboard-only (Tiptap's shortcuts); the mock shows no toolbar.
- Mobile has no canvas editor yet (read-only rendering could reuse `readCanvas` + the same awareness shapes).
