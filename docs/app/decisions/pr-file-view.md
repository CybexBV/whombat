# The file view: a pull request's file, whole (AP-664, AP-665)

John, 2026-10-02: clicking a file in a branch room's Files changed should open “a full editor (view only default)” that
shows the changes with the `+ −` colours. Contracts CT-241 (`prs.file`, 0.40.0); the runtime side is Whombat
`docs/decisions/pr-file-view.md`.

| ID | Decision | Why |
|---|---|---|
| AP-664 | **Each Files changed row is a link to the file's view**, `?tab=files&file=<path>` (validated: a string up to 4096 characters without control characters, kept only with `tab=files`; switching tabs drops it). The view replaces the table in the room's body — the header, tabs, composer and side pane stay — with a bar: ← Files changed (back to the table), the path in DM Mono, `+add −del`, “New file”/“Deleted” when so, a **View only** chip, the change count with ↑/↓ to step through changes (“Change 2 of 5”), and ‹ › to the previous and next file. Below, the whole file on the code surface the review card uses (13px/1.6 DM Mono, `--code`, the README's fixed code colours): old and new line numbers (`--code-timestamp`, not selectable), a `+`/`−` mark, removed lines on `--code-removed-bg` in `--code-removed`, added lines on `--code-added-bg` in `--code-added`, unchanged lines highlighted by the file's extension with the message code blocks' highlighter (lazy, `renderToken`; changed lines stay plain green or red, as the mock's diff block). The code scrolls on its own both ways; it opens at the first change when that is below the first screen; blocks of 400 lines use `content-visibility: auto` so 20 000-line files scroll smoothly. Binary and too-large files say so (`PR_FILE_SHOWN_TEXT`); a path the PR doesn't change says “This pull request doesn’t change <path>.”. A new push (the PR's `headSha` changes) reads the file again. Screen readers hear “Added:”/“Removed:” before changed lines; the code region is labelled “<path>, view only”. Rows open only on a runtime with feature `prs.file`; an old link on one without says “Update your Whombat to use opening a pull request’s files.” **View only** is the whole mode for now: editing would be a commit on the branch through the commit pipeline, a separate change. Android has no file view yet. | The PR showed only counts; the people approving it need to read what changed in context, in the room where they decide. |

### AP-665 whombat-app 0.29.0

AP-664, contracts 0.40.0 (CT-241). Checks: `pnpm check` once and a look at the file view at 1440×900 in both themes
against the fixture world (DEV fast). Released like 0.28.4.

| ID | Decision | Why |
|---|---|---|
| AP-666 | **An open file takes the whole room** (John, 2026-10-02: “full view would be better … the sidebar on the right is not needed”). With `?file=` the branch room shows no side pane (checks, reviewers, staging, Merge into main) and no composer (`ConversationRoom` `composer={false}`); the header and the Conversation / Files changed tabs stay, so the room is one click away. Back to Files changed brings both back. | Code needs the width (long lines) and the height; reading a file is not the moment to merge or comment. |

### AP-667 whombat-app 0.29.1

AP-666, no contract change. Checks: `pnpm check` once and a look at the file view at 1440×900 in both themes (DEV fast).
