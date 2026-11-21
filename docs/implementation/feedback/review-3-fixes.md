# Whombat Feedback: review 3 fixes (worker F3)

Fixes for the third, independent review of Whombat Feedback (NEW-1 … NEW-6, the F6 race, and the second pass's
N2, N3, N4, N6, N7), on `fb/f3-fixes` from `feedback-widget` `31f1fc5`. Decisions: `docs/decisions/feedback.md`
FB-F3-01 … FB-F3-12 (FB-21, FB-F10 and FB-F2-07 updated). No migration, no dependency change.

| Finding | Fix | Commit | Proving tests |
|---|---|---|---|
| NEW-1 (medium-low) Codex assessor reads the owner's files | For trigger `feedback` the Codex profile extends nothing: `:minimal`, the turn's directory, the toolchains and the Codex install, read-only; the home, working-directory roots, `WHOMBAT_HOME`, the workspaces and other turns' directories aren't in the sandbox. `/proc` of other processes: already out of reach (PID namespace), verified. FB-F3-01. | `0a5133a` | `packages/agent-runtime/src/codex/assessment-profile.test.ts` (generated rules and args; toolchain selection; Codex install lookup; and a run in Codex's real sandbox, skipped where it isn't available) |
| NEW-2 (low) verified commit ≠ exported tree | `prepareCwd` reports `exportTree`'s return value. FB-F3-02. | `f378390` | `apps/runner/src/feedback-workspace.test.ts` “reports origin’s commit, not a local commit in Whombat’s own worktree” |
| NEW-3 (low) search bypasses the untrusted wrapper | `feedback_assessment` messages aren't indexed (an existing document is dropped on re-index) and `search` leaves out older documents of such messages; the handoff message stays searchable. FB-F3-03. | `c694898` | `apps/server/src/domain/search-index.int.test.ts` “assessor output is not searchable” (new message; a document indexed before) |
| NEW-4 (low) `defuseFeedback` misses spellings | Invisible characters and bracket look-alikes normalized, then every `[[`-like run broken whatever tag follows. FB-F3-04. | `58056b3` | `packages/agent-runtime/src/persona/feedback.test.ts` “defuse every [[-like pair …” (each listed spelling, a run of three, readable ordinary text) |
| NEW-5 (low) handoff note truncated on the card | Note capped at 240 (contract, command, web `maxLength`), one line, shown whole; longer pending ones refused at execution. FB-F3-05. | `67d4b6f` | `apps/server/src/feedback/handoff.int.test.ts` “what the approver sees is what the developer gets” (whole note on the card = command input; 241 refused) |
| NEW-6 (info) unverified revision outside the block | Prompt and card say “commit not reported by the runner (unverified)”; the assessor's text only inside `[[assessment]]`. FB-F3-06. | `af8db20` | `apps/runner/src/feedback-provenance.test.ts` “an unverified revision stays inside the assessment block”; `handoff.int.test.ts` “never quotes the assessor’s own revision text on the card” |
| F6 race (info) | Queue-deadline settle cancels and settles only a still-`queued` dispatch (`onlyIfQueued`, compare-and-set); the pass checks `queued` too. FB-F3-07. | `55a3fcd` | `apps/server/src/feedback/review2.int.test.ts` “the queue deadline never cancels a claimed turn” |
| N2 (low-medium) screenshots reach unrestricted agents | `dispatchAttachmentRows` leaves out a report root's files except for the assessment and the approved handoff's developer; both prompt builders mark the root as a visitor's untrusted report and hide its files; docs recommend a dedicated channel. FB-F3-12. | `22f11ad` | `apps/server/src/feedback/review3.int.test.ts` “N2” (thread and channel mentions: no attachment, `read_attachment` and runner fetch refused; handoff developer gets it); `feedback-provenance.test.ts` “a report’s root message …”; `persona/feedback.test.ts` “mark a report’s root message …” |
| N3 (low-medium) removal leaves the assessor's words | `removeContent` redacts the assessment's free text (`redactedAssessment`), replaces the text of the assessor's thread messages, drops their search documents, names them in the signed event and republishes; the card hides the summary. FB-F10 and docs corrected. FB-F3-11. | `6f96b67` | `review3.int.test.ts` “N3”; `packages/core/src/feedback/feedback.test.ts` “redactedAssessment” |
| N4 (low) system principals editable | Agent commands, `open_dm`, `create_channel`, `add_members` refuse system principals; mention resolution and web autocomplete skip them. FB-F3-10. | `e61bfa4` | `review3.int.test.ts` “N4”; `apps/web/src/features/messaging/model.test.ts` “never offers a system principal” |
| N6 (info) older runners | Docs: upgrade server and runner together (`docs/feedback.md` Upgrading, `docs/upgrade.md`). FB-F3-09. | `d7a4dec` | docs only |
| N7 (test flake) | Cause reproduced: with the runtime's timed sweep running, a queued assessment that waited past `unrunnableMs` (a loaded machine) while the test runner had last claimed for another provider was failed `unrunnable:provider`, so `startAndClaim` claimed nothing (forced with `sweepMs: 20, unrunnableMs: 0`: 3 failures, “claimed nothing … its dispatch failed unrunnable:provider”). The suites switch the timed sweep off, end claimed/running turns after each test, and the helper reports what it claimed. FB-F3-08. | `45238f6` | `review2.int.test.ts` and `handoff.int.test.ts` (stable in repeated runs alongside `src/feedback src/runtime src/mcp`) |

Each fix's test was also run against the code without the fix and failed there (NEW-2, NEW-3, NEW-4, NEW-5/6, the
F6 race, N2, N3, N4).

## NEW-1: `codex sandbox` verification (codex-cli 0.157.0)

Run locally, no model involved; only harmless files read, only whether a read succeeded printed. The turn directory
was a scratch directory under `~/.cache/wb-tmp` holding `inside.json`; the profile is exactly what
`codexProfileArgs` generates for a feedback turn on this host (`codexInstallPaths('codex')` =
`~/.local/lib/node_modules/@openai/codex`), passed as `codex sandbox -P whombat -C <turn> -c 'permissions.whombat = { filesystem = { ":minimal" = "read", "<turn>" = "read", "~/.cargo/bin" = "read", "~/.local/bin" = "read", "~/bin" = "read", …, "~/.local/share/mise" = "read", "~/.cache/node/corepack" = "read", "~/.config/mise" = "read", "~/.local/lib/node_modules/@openai/codex" = "read" }, network = { enabled = false } }' -c 'default_permissions = "whombat"' -c 'features.network_proxy = false' -- sh -c …`.

| Check | Old profile (`:read-only` + credential denies) | New feedback profile |
|---|---|---|
| `cat ~/Code/Whombat/package.json` | **allowed** (the finding) | denied |
| `ls ~/Code` | **allowed** | denied |
| `cat ~/.bashrc` | **allowed** | denied |
| `ls ~/.ssh`, `ls ~/.whombat` | denied | denied |
| `cat inside.json` (turn dir) | allowed | allowed |
| `touch x` in the turn dir | denied | denied |
| `cat /proc/<pid of a host process>/environ` | denied | denied |
| numeric `/proc` entries visible | 5 (own PID namespace: the sandbox helper and the command) | 5 |
| `node --version`, `git --version`, `pnpm --version` | run | run (v24.18.0, 2.47.3, 12.3.4) |

Also seen while building it:

- Denying `$HOME` and re-allowing the turn directory and the toolchains inside it doesn't work: bubblewrap mounts
  the deny over the whole home and the re-allowed reads stay unreadable (the sandbox fails to start, “bwrap: execvp
  …/codex: Permission denied”, because the Codex binary under the home is hidden too). Hence the allowlist that
  extends nothing (a profile without `extends` is accepted; `:minimal` covers `/usr`, `/bin`, `/lib*`, `/etc`,
  `/dev`, `/proc`, `/nix`, not `/tmp`, `/var`, `/opt`, `/home`).
- Without the Codex install in the allowlist the sandbox can't start (“bwrap: execvp …/codex: No such file or
  directory”): Codex re-runs its own binary inside. `codexInstallPaths` finds it; if it can't, the turn fails
  closed.
- Without Corepack's cache `pnpm` tried to download itself (no network): `~/.cache/node/corepack` is allowed.
- Two denied files that exist still break bubblewrap (“Can't write data to file …: Bad file descriptor”), as with
  0.156; the new profile adds denies only where they'd be visible, which in practice is none.
- The command's environment (`/proc/1/environ` of the sandbox helper and its own) follows
  `shell_environment_policy`: a variable excluded there is in neither.

The same checks run on every `pnpm check` on a host with a working Codex sandbox: `assessment-profile.test.ts`
“an assessment in Codex’s real sandbox” (a fake home under `/var/tmp` with `Code/app/package.json` and `.env`,
the turn directory and another turn's directory in a runner tmp there): own dir, `node` and `git` OK; owner code,
`.env`, listing the home, the other turn's directory, writing and the host process's `environ` denied.

Not verified: a full `codex app-server` turn with the profile (that needs a model call). `codex sandbox` loads the
same `-c` configuration and uses the same sandbox helper as the app-server's command execution.

## Commands run

- `TMPDIR=~/.cache/wb-tmp pnpm check` — passes (206 files, 2160 tests passed, 6 skipped; biome's 4 warnings are
  pre-existing, in files this work doesn't touch).
- `cd apps/server && TMPDIR=~/.cache/wb-tmp npx vitest run --config vitest.int.config.ts src/feedback src/runtime src/mcp src/automations src/routes/endpoints.int.test.ts`
  — 30 files passed, 2 skipped; 263 tests passed, 11 skipped.
- `cd apps/server && TMPDIR=~/.cache/wb-tmp npx vitest run --config vitest.int.config.ts src/domain src/commands src/files src/read src/github`
  (the commands, messages, search and attachment code this touches) — 168 passed, 1 failed: `commands/agent-runtime.int.test.ts › host.info`,
  the known artefact of a `TMPDIR` under `$HOME`, unrelated.
- `pnpm --filter @whombat/runner test` — 71 passed. `pnpm --filter @whombat/agent-runtime test` — 225 passed, 6
  skipped (live smoke tests); the real-sandbox assessment test ran.
