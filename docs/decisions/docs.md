# Documentation that describes the present (DOC)

John, 2026-10-26: refactor Whombat's documentation so it describes the system as it is now; history belongs in git.
Measured on main `56ffc162`: `ARCHITECTURE.md` was 1,020 lines dense with decision codes and “superseded by / no
longer / since 0.26” chains, `DECISIONS.md` 294 lines with superseded rows annotated in place, `docs/decisions/` 234
files (~20,800 lines, ~735 superseded notes), and the runtime's comments about 9,400 decision-code references. Agents
read these on every task, so their length and staleness cost time and context.

| # | Decision | Why |
|---|---|---|
| DOC-01 | **`ARCHITECTURE.md` describes only how Whombat works today**, in plain English a new engineer reads in one sitting (about 450 lines). It has no history (“used to”, “no longer”, “since x.y”, migration stories), no long lists of operation names and no decision codes; where a reader needs the reasoning it links the decision file. A change rewrites the section in place. | Agents read it on every task; history is in git and in the decision files. |
| DOC-02 | **`DECISIONS.md` lists only decisions in force, one short row each.** A superseded row is replaced, never annotated. Rows keep their original ids (D-06, A-04, C-12, OP-17…) so citations in code still find them; a row that merges several decisions names them all. The maintainer's D-01, D-04, D-06, D-07 and D-08 stay, restated as they hold now; D-02, D-03, D-05 and D-09 went (scope, stack choice, CLI wrappers and avatars were settled differently later). | A stale row misleads an agent told not to reopen decisions. |
| DOC-03 | **A decision file is archived when its subject is gone** (several agents or people, self-hosting, packs, Whombat's own skill library, the agent's computer) and nothing in it still defines how the code behaves. It moves with `git mv` to `docs/decisions/archive/`, and full-path references (`docs/decisions/<file>.md`) in docs, `CLAUDE.md`, `AGENTS.md` and code comments point there; bare filename mentions stay as they were. A file with rows that still define current behaviour stays, marked *in part* in `docs/decisions/README.md`. | Fewer files to read, without losing the reasoning behind code that cites a row. |
| DOC-04 | **Where the rule bent**: `agent-computer.md` stays (its command-guard rows AC-22, AC-31, AC-34, AC-41 and AC-42 are the guard the commands' wrapper uses); so do `bp-acp.md` (the ACP client's permission and stream rows), `bp-memory.md` (BP-B17, a failed resume retried fresh), `bp-distribution.md` (release manifests, reproducible archives, signatures, the migration lock), `memory-pool.md` (a command's OOM score), `channel-clear.md` (threads with work survive a clear), `vault-asks.md` (VA-02, VA-03), `skills-library.md` (Files-tree names, Vault defusing), `feedback-sources.md` (still in the code), `cli.md` (CLI-02) and `auth-selfhost.md` (AH-09). `delegation.md`, `assistant-name.md`, `assistant-name-server.md`, `skill-store.md`, `all-skills*.md`, `five-agents.md`, `production.md`, `reply-to.md` and `agent-responsibilities.md` were archived although a comment cites one of their rows: the row is incidental (a test helper's temporary folder, leftover handling of removed data) or restated by the decision that replaced the file (OA-08 for the agent's name). | Code that cites a living rule keeps a living file; a stray citation doesn't keep 280 lines of history in front of every agent. |
| DOC-05 | **Code comments say why in plain words.** New or changed code cites no decision codes; it links a decision file only when the reader needs its reasoning. Existing citations stay until the code around them changes. | Codes force a lookup and go stale when rows are superseded. |
| DOC-06 | **`REFERENCE_NOTES.md` is history**: the 2026-09-23 Buzz study, measured against the first architecture. It moved to `docs/history/REFERENCE_NOTES.md` under its own name, so the code's “REFERENCE_NOTES §n” mentions still find it; its adopted recommendations are DECISIONS.md C-08. | It no longer describes Whombat; its conclusions are in force elsewhere. |
| DOC-07 | **What this pass left alone**: the decision files' own text (only paths changed), `docs/implementation/` (plans and ledgers, history by nature), `docs/design-handoff/` (kept verbatim, including the crew handoff's `PROMPT.md`, which still names `docs/decisions/five-agents.md`), and references to whombat-app's decision files of the same name. | Out of scope, or verbatim by design. |
| DOC-08 | **`BUGFIX_PROGRESS.md` is history**: the 2026-11-01 reliability investigation's working notes. It moved to `docs/history/BUGFIX_PROGRESS.md` (2026-11-07); the web failures it left open are explained and fixed in `test-speed.md` TS-08. | The root holds what a reader of the repository needs now; DOC-06 moved the other working notes the same way. |

## Classification

Every file in `docs/decisions/` was read against its header, `DECISIONS.md`, the superseded notes and the code (code
comments citing its rows, the modules it names). `README.md` lists the current files with what each covers; files
that are partly superseded are marked *in part*.

Archived (32): agent-handoffs, agent-keys-handles, agent-responsibilities, agent-roles, agents, all-skills,
all-skills-agent, all-skills-server, ask-agent, assistant-name, assistant-name-server, avatars, bp-packs,
burrow-settings, channel-menu, connectors-personal-agents, delegation, five-agents, general-welcome, mobile-server,
one-assistant-computer, production, providers, reply-to, role-consolidation, runner-selfhost, self-hosted,
selfhost-foundation, selfhost-polish, skill-store, skills-settings, sidebar-menus.
