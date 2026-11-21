# Workstream: collab-server (collaborative canvas, server side)

TODO 11.1, 11.2 and 11.3 (server). ARCHITECTURE.md ("Canvas"), DECISIONS.md A-10, `server-core.md`,
`runtime-server.md` and `core-contracts.md` still apply; this file records what they left open. The web
editor (Tiptap) is a later workstream; everything it needs from the server and the document model is here.

## Layout

```
packages/canvas-schema/src/        @whombat/canvas-schema — pure, used by the server and the web editor
  tiptap.ts     the Tiptap extensions that define the schema (the web editor adds node views / keymaps)
  schema.ts     canvasSchema (getSchema(canvasExtensions)), DocJSON, docFromJSON
  markdown.ts   canvas Markdown ⇄ ProseMirror JSON (seed, canvas_read / canvas_edit, search text)
  ydoc.ts       read/write the Y.Doc exactly as @tiptap/y-tiptap does (fragment "default")
  edits.ts      canvas_edit ops (append / insert_after / replace / delete), applyEditsToYDoc
  plan.ts       plan block ⇄ Plan (syncPlanIntoDoc, planStepsFromDoc, mergePlanEdits)
  anchors.ts    comment anchors and carets as Yjs relative positions, comment marks
apps/server/src/collab/
  token.ts      collab tokens         store.ts     snapshot + updates, compaction
  document.ts   build / export docs   awareness.ts identities, server-published participants
  commands.ts   record_canvas_edit, edit_canvas (MCP canvas_edit)
  service.ts    CollabService (Hocuspocus, flushing, plan sync, comment marks, presence, search)
  routes.ts     GET /collab (WebSocket)
apps/server/src/test/collab.ts      headless collaboration client (Hocuspocus provider + Y.Doc)
```

## Document model (`@whombat/canvas-schema`)

- `doc = title block+`. The **title** node is the article h1 ("Invoice PDF export"; the canvas's `title`
  column keeps "Invoice PDF export · plan" for lists and breadcrumbs). Blocks: paragraph, heading (h2, h3),
  bullet and ordered lists, **planBlock**. Marks: bold, italic, code, **authorHighlight** (`authorId`) and
  **commentAnchor** (`commentId`, overlapping — several comments can cover the same words).
- **planBlock** (`planId`) holds **planStep** nodes (`stepId`, `ownerId`, `state`, `stateLabel`; text = the step
  title). The Plan is the truth for state; the block is an editable copy the editor renders like the mock.
  `stepId` is null for a line someone typed that the Plan does not have yet.
- The schema is defined once, as Tiptap extensions (`canvasExtensions`); the server builds the same
  ProseMirror schema from them with `getSchema`, so the web editor and the server cannot drift. Only
  schema-level config lives there (names, content, attributes, HTML parse/render).
- The Yjs encoding is y-tiptap's (Y.XmlFragment `default`, overlapping marks hashed), read with
  `initProseMirrorDoc` and written with `updateYFragment` — the functions the editor binding itself uses.
  Writes are diffs, so untouched paragraphs keep their Yjs items (and every anchor and caret in them).
- **Several edits are written one at a time** (`applyEditsToYDoc`): diffing a document that gained a paragraph
  *and* changed its neighbour in one go makes y-prosemirror rewrite the neighbour in place, which moves
  anchors. One diff per edit is what an editor produces when a person makes the same changes.
- **Canvas Markdown** is the agents' and the seed's dialect: CommonMark-like blocks and inline marks, `# Title`
  on the first line, `==text=={author=prn_pippa}` for author highlights, and
  `:::plan{id=pln_…}` … `:::` for a plan block (the listing inside is only readable text; the steps come from
  the Plan). `docToMarkdown` writes the plan listing as `- [x] Pick a PDF library · Pippa · Done`. Italic is
  written `_…_` so `**bold _both_**` round-trips.

## Transport and auth (TODO 11.1)

- **Hocuspocus 4** (`@hocuspocus/server`, y-websocket compatible protocol) is used as a library: its
  `handleConnection` is fed from a Fastify `@fastify/websocket` route at `COLLAB_PATH` (`/collab`), so it shares
  the server's port, logging and lifecycle. Document names are `canvas:<canvasId>` (`collabDocumentName`).
- **Collab tokens** (`canvases.collabToken`, `POST /burrows/:burrow/canvases/:slug/collab-token`): stateless,
  `wct_<base64url(payload)>.<hmac>`, HMAC-SHA256 under a key derived from `WHOMBAT_MASTER_KEY` (the development
  key when unset), **5 minutes**. Payload: canvas, burrow, principal, session (web/mobile) or dispatch (agents).
  Issuing checks read access like `canvases.get` (members of the canvas's conversation; 404 otherwise).
- **At connect** (the provider sends the token in its first message) everything is re-checked: token
  signature and expiry, canvas ↔ document name, principal and canvas in the token's burrow, membership, the
  session not revoked/expired, the dispatch still live. Failures answer `permission-denied`.
- **Write access**: people write. Agents write only when the keys engine says `allow` for "Write canvases"
  (`canvas.write`); an `ask` key cannot type live, so such agents get a **read-only** connection (Hocuspocus
  drops their updates). Agents normally edit through MCP `canvas_edit` anyway.
- **Revocation**: the service listens to the bus's control messages — leaving the conversation
  (`membership.removed`) or logging out (`session.revoked`) closes that principal's canvas connections at once.
- The token rides in the protocol, not a cookie, so there is no Origin check on `/collab`. Incoming frames
  are bounded by the server-wide WebSocket `maxPayload` (64 KiB); a paste larger than that in one update
  closes the socket (follow-up if it matters).

## Storage (TODO 11.1)

- A canvas's state is `canvases.ydoc` (snapshot, from server-core's schema) plus `canvas_updates` rows (new
  table, migration `0004_canvas_updates`: bigserial id, canvas, update bytea, author, time), merged on load.
- **People's edits** are buffered per document and author and flushed on Hocuspocus's debounced store
  (1 s after typing stops, at least every 5 s) as the command **`record_canvas_edit`**, committed as that
  author: the merged update row, provenance, the exported Markdown and a hidden signed **`canvas.edited`**
  event whose payload pins the update (`updateId`, `bytes`, `sha256`) — one transaction, so the audit chain
  covers the document's content. A failed flush puts the updates back and Hocuspocus keeps the document in
  memory. Shutdown flushes every open document.
- **Server-side changes** are computed on a scratch copy of the current state and stored *before* they are
  applied to the live document (origin `{source: 'local', skipStoreHooks}`), so a failed commit never leaves
  the live document ahead of the database:
  - agent edits (`edit_canvas`) — update row + signed event in the command's transaction;
  - plan syncs and comment marks — derived projections of a signed change (the `plan.updated` / comment event),
    stored as unsigned update rows (`author_id` null), like the search index.
- A canvas that has never been opened (created by `canvases.create`) is built from its Markdown on first load
  and its snapshot stored (first writer wins under a row lock).
- **Compaction** folds snapshot + updates into a new snapshot (through a Y.Doc, so Yjs GC applies) and deletes
  the folded rows: after a flush once a canvas has ≥ 64 updates, and when a document is unloaded (last client
  gone). Rows appended meanwhile stay.
- `canvases.markdown` is now the **export** of the document (kept current by every stored edit, and the
  seed's input); search indexes its plain text when no live text is passed. `canvas_read` reads the document
  itself.
- Per-document work (flushes, plan syncs, comment marks) runs through one promise chain per document, so it
  never interleaves.

## Provenance and events

- "Drafted by Sketch from Priya’s request · edited by Mara, Pippa · 12 min ago": `provenance.editorIds` is
  **most recent first** and never contains the drafter (`createdById`), who is named apart; `updatedAt` moves
  with every stored edit. (runtime-server's Markdown `edit_canvas` appended editors at the end; that test now
  expects the drafter not to be listed.)
- Every edit signs a hidden `canvas.edited` (Messages, `text: null`) — like chat, edits are internals; the
  log shows the canvas creation and the comments' summaries. Plan-block edits sign `plan.updated` (hidden,
  server-core's type) as the editor.
- Every stored edit publishes `canvas.updated` on `canvas:<id>` (the client's canvas cache and provenance line).

## Awareness (presence, carets, "is writing")

- Awareness is relayed by Hocuspocus. `CollabAwarenessState` (core, from the WIP contract) is
  `{user: CollabUser, writing, cursor}`; `cursor` is y-prosemirror's `{anchor, head}` relative-position JSON,
  which Tiptap's CollaborationCaret reads, and `user` is what it labels carets with.
- **The server stamps `user`** on every inbound awareness state from the authenticated connection
  (`beforeHandleAwareness`), whatever the client claimed, and coerces `writing` to a boolean. Colors:
  agents `var(--role-<role>)` (the caret and "Sketch is writing" pill are the role accent), people their
  avatar tone.
- **Agents editing through MCP have no socket**: the server publishes their awareness itself under a stable
  synthetic Yjs client id (FNV-1a of the principal id, high bit set; clocks start from the time so a restarted
  server stays ahead). `writing: true` goes out before the edit is applied; after it lands the agent's caret
  (relative position just after what it wrote) is published with `writing: true`, which lapses after 4 s; the
  agent stays present for 60 s after its last edit (renewed every 15 s, under y-protocols' 30 s timeout), then
  is removed.
- `CanvasDetail.presentIds` ("2 here") = principals connected to the document (in arrival order) plus agents
  the server shows. It was always `[]` before.

## Plan block ⇄ Plan (TODO 11.2)

- **Plan → document**: every `plan.updated` frame on the bus (runs finishing, approvals moving, reviews, the
  demo, `update_plan_step`, block edits) syncs the plan's canvas: steps get the Plan's ids, owners, states and
  labels; a step keeps its text node (and comment marks) when its title did not change. Buffered edits of that
  document are flushed first, so a pending rename is not overwritten by the sync.
- **Document → Plan**: the service keeps the plan block as of the last flush/sync (baseline). A flush whose
  document differs sends `{before, after}` with the last author's `record_canvas_edit`; `edit_canvas` does the
  same for agents. `mergePlanEdits` applies **only what the edit changed** — title, owner or state edits,
  removed steps, reordering, typed lines (new queued steps owned by the editor, placed after their
  neighbour) — onto the Plan's *current* steps, so a stale document never undoes a step the pipeline just
  advanced. Owners must be burrow principals (else the editor). The new steps' ids flow back through the sync.

## Agent edits (`canvas_edit` / `canvas_read`)

- `edit_canvas` (runtime-server's command, now on the Y.Doc; `commands/agent-tools.ts` re-exports it) keeps
  its key (`canvas.write`: allow / ask / blocked) and membership check, applies the edits one at a time on a
  scratch copy of the live state, and stores the difference (see Storage). Edits that cannot apply ("Couldn’t
  find “…” in the canvas.", "The title can be changed, not removed.") are 400s with that message.
- Highlights an agent writes (`==…==`) are always attributed to the agent; `:::plan{…}` blocks must name the
  canvas's own plan.
- `canvas_read` returns the live document as canvas Markdown (owners named in the plan listing).

## Comments (TODO 11.3)

- Anchors are Yjs relative positions (base64 of `Y.encodeRelativePosition`) created on the text item where the
  quote starts — what y-prosemirror's `absolutePositionToRelativePosition` gives the editor for a text
  position — plus the quote. `canvases.addComment` now refuses anchors that are not well-formed relative
  positions (400 "The comment anchor is not a position in this canvas."). CRUD stays on the existing endpoints;
  `canvas.comment` realtime frames were already there.
- Open anchored comments are **marked** in the text (`commentAnchor` mark over the quote, if the quote is still
  where the anchor points); resolving unmarks, reopening marks again — driven by the `canvas.comment` frames.
- Anchors survive edits before, after and around the quote (tested across clients and a reload);
  `resolveAnchor` reports `intact: false` once the quoted words themselves are rewritten.

## Seed

- The loader builds each seeded canvas's Yjs document from its Markdown (plan bound from the seed's plans)
  with a **fixed Yjs client id (1)**, so snapshots and anchors are reproducible; comments are re-anchored on
  their quotes and marked. `canvases.markdown` holds the export.
- `@whombat/fixtures`' plan canvas Markdown is now the mock's article verbatim: Goal, Steps (plan block bound
  to `pln_invoice-pdf`), Rules to keep (Pippa's and Hazel's highlights, and the rule Sketch is still writing,
  without its final full stop), Out of scope. The two comment quotes now match that text ("Build the export
  endpoint", "Round VAT per line, half-up, before formatting.") and their `relativePosition`s are the values
  the seed computes, so `createFixtureFetch()` and the seeded server agree (fixtures.int.test).
- The test world's canvas gained a plan block.

## Search

- Canvases are indexed with the document's **plain text** (no Markdown syntax), re-indexed 2 s after a change
  (bursts index once). `indexCanvas(db, id, text?)` takes the live text; without it, the export's plain text.

## Contract changes (`@whombat/core`, additive)

1. `COLLAB_PATH`, `collabDocumentName`, `parseCollabDocumentName`.
2. `CollabUser`, `CollabAwarenessState` (awareness shape for the web editor).
3. `CollabTokenResponse` (the existing `canvases.collabToken` response, named).

## Tests

- Unit: `@whombat/canvas-schema` (Markdown round trip, Y.Doc round trip and convergence, minimal diffs, edits,
  plan sync and merge, anchors through edits, marks), collab tokens and awareness helpers.
- Integration (`collab.int.test.ts`, headless Hocuspocus clients against a listening server): token issue and
  rejection (tampered, wrong document, expired, non-member), the seeded document, two clients converging with
  signed per-author edits and provenance, awareness stamping, persistence and compaction across a restart,
  plan block both ways, Sketch's MCP edit visible with "is writing" and a caret, read-only agents, comment
  anchors surviving edits plus marks, search, removal closing the connection, first open of a new canvas.

## Follow-ups

- Web editor (Tiptap + Collaboration + CollaborationCaret) on `canvasExtensions`, the plan block node view,
  author-tinted highlight styles, the comments column reading anchors with `relativePositionToAbsolutePosition`.
- The mock's "Sketch is writing" is a live state; the demo storyline could have Sketch write the third rule.
- Large pastes over the 64 KiB WebSocket frame limit; per-route `maxPayload` if needed.
- Agents with an `ask` canvas key get read-only live connections; asking per keystroke makes no sense, their
  `canvas_edit` goes through the approval flow instead.
