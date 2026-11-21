# How Hermes Agent implements and uses skills (state on 2026-10-18)

Research for Whombat: how Nous Research's Hermes Agent stores skills, how they reach the model, and how it keeps
them cheap (token cost, progressive disclosure, prompt caching).

**Sources**

- Fresh shallow clone of `github.com/NousResearch/hermes-agent` at
  `~/.cache/wb-tmp/research/2026-10-18-skills/hermes-src`, commit `22063fc0` (2026-10-18 08:02 -0700). The source
  was read only, never run. All paths below are relative to that clone.
- John's local install, read only: checkout `/home/me/.hermes/hermes-agent` at `dce1e9b3` (2026-10-09), plus
  `~/.hermes/skills` and the `skills:` and `curator:` blocks of `~/.hermes/config.yaml`.
- Docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills (matches
  `website/docs/user-guide/features/skills.md` in the repo), `website/docs/user-guide/features/curator.md`,
  https://agentskills.io/specification.
- Secondary sources, which are partly out of date (see §12):
  [Security Boulevard](https://securityboulevard.com/2026/06/8-self-evolving-skills-hermes-agent-writes-on-its-own/),
  [Teknium's Curator announcement](https://x.com/NousResearch/status/2049719457808093231),
  [awesome-hermes-agent](https://github.com/0xNyk/awesome-hermes-agent).

---

## 1. Skill format

**A skill is a directory.** It holds `SKILL.md` (YAML front matter plus Markdown) and optional `references/`,
`templates/`, `scripts/` and `assets/` folders. The docs also mention `examples/`. See the header of
`tools/skills_tool.py` and `SKILL_SUPPORT_DIRS` in `agent/skill_utils.py:31`. Support folders are never scanned as
separate skills. The scanners stop descending at a folder that holds a `SKILL.md`. Legacy flat `<name>.md` files
still resolve.

### Front matter fields

Field lists are in `skills/AGENTS.md`, the user docs, `agent/skill_utils.py` and `tools/skills_tool_setup.py`.

| Field | Meaning |
|---|---|
| `name` | At most 64 chars (`MAX_NAME_LENGTH`). `skill_manage` enforces `^[a-z0-9][a-z0-9._-]*$`. Falls back to the directory name. |
| `description` | Spec limit 1024 chars. The prompt index cuts it to **60 chars** (`SKILL_PROMPT_DESC_LIMIT = 60`, `agent/skill_utils.py:827`): the first 57 chars plus `...`. `skill_manage create` rejects new skills over 60 chars. If missing, the first non-heading body line is used (`skills_tool.py` `_skill_catalog`). |
| `version`, `author`, `license` | Informational. House rule: credit the human author first. |
| `platforms: [macos, linux, windows]` | OS gate, matched against `sys.platform` (`skill_matches_platform`). |
| `metadata.hermes.tags`, `.category`, `.related_skills` | Returned by `skill_view`. Top-level `tags:` and `category:` are accepted too. |
| `metadata.hermes.fallback_for_toolsets`, `requires_toolsets`, `fallback_for_tools`, `requires_tools`, `session_platforms` | Conditional activation (`_CONDITION_KEYS`, `agent/skill_utils.py:722`). See §4. |
| `metadata.hermes.config: [{key, description, default, prompt}]` | Non-secret settings stored under `skills.config.<key>` in config.yaml. Prompted during setup and injected when the skill loads. |
| `environments: [kanban, docker, s6]` | Relevance gate for offering the skill. An explicit load ignores it. |
| `requires_apps: [...]` | Hidden unless the host declares the app as available. Fails closed. |
| `required_environment_variables: [{name, prompt, help, required_for, optional}]` | Also accepts `setup.collect_secrets` and legacy `prerequisites.env_vars` (`tools/skills_tool_setup.py:46`). Missing secrets are asked for only when the skill loads, and only in the local CLI. Variables that are set pass through to the `terminal` and `execute_code` sandboxes. |
| `required_credential_files` | Registered for remote sandboxes. Missing files set `setup_needed`. |
| `deps: [ffmpeg]` | `pm.ensure(dep)` runs when `skill_view` loads the skill. A failure becomes a `deps_note` in the result. |
| `compatibility`, `allowed-tools` | agentskills.io fields. `compatibility` is passed through in `skill_view`. `allowed-tools` only raises a low, informational guard finding (`allowed_tools_field`). |

### agentskills.io compatibility

The docs state compatibility outright. Hermes reads the spec fields `name`, `description`, `license`,
`compatibility`, `metadata` and `allowed-tools`, and puts its own extensions under `metadata.hermes.*`. The
spec's limits (64-char name, 1024-char description) are the validation limits. Its progressive-disclosure model is
about 100 tokens of metadata per skill, under 5k tokens per SKILL.md, and resources loaded on demand. Hermes goes
further: it sets a 60-char description budget for the always-loaded index.

### House authoring standard

`skills/AGENTS.md` sets the standard, and `tests/skills/test_authoring_standards.py` enforces it:

- Description at most 60 chars, one sentence, ending in a period.
- Prose names Hermes tools in backticks (`read_file`, not `cat`).
- Sections in a fixed order: When to Use, Prerequisites, How to Run, Quick Reference, Procedure, Pitfalls,
  Verification.
- About 100 to 200 lines per skill. Logic goes in `scripts/`, not inline.

One rule matters for cost: *"No `offset`/`limit` pagination on skill-loading tools — the agent must read a skill
fully."* Size is therefore controlled by authoring, not by paging.

## 2. Where skills live and what ships

- **Primary location:** `~/.hermes/skills/<category>/<skill>/` (per profile: `~/.hermes/profiles/<p>/skills`). The
  category is the first path segment. Nested categories (`mlops/training/...`) are allowed. An optional
  `DESCRIPTION.md` gives the category a description for the index.
- **Bundled sync** (`tools/skills_sync.py`):
  - Repo `skills/` is copied into the profile, with origin hashes tracked in `.bundled_manifest` (`name:hash`).
  - A skill updates only if upstream changed *and* the user's copy still matches the origin hash. Edited copies are
    skipped.
  - Skills the user deleted are not re-added.
  - `hermes skills opt-out` (marker file `.no-bundled-skills`) and `opt-in --sync`, `list-modified`, `diff`, `reset
    [--restore]`.
- **Search roots, in precedence order** (`get_skill_search_roots`, `agent/skill_utils.py:397`):
  1. Trusted project dirs: `<repo>/.hermes/skills` and `<repo>/.agents/skills`, only for repos listed in
     `skills.trusted_project_dirs` (`hermes skills trust`/`untrust`). They are scanned and quarantined if dangerous.
  2. The local profile dir.
  3. `skills.create_dir`: optional redirect for newly created skills, such as a shared "brain" repo.
  4. `skills.external_dirs`: `~` and `${VAR}` are expanded, missing paths are skipped. These dirs are *not*
     write-protected; the agent patches skills where they live.

  The list, prompt index, slash commands, `skill_view`, preload and cron all share this one ordering. If two
  different skills share a name within one tier, Hermes refuses to guess and lists them by exact relative path.
- **Plugins** can register skills (`plugin:skill` names). They appear in the index under a `plugin` category.
- **Counts at commit `22063fc0`:**
  - **58 bundled** skills in 12 categories: apple 4, autonomous-ai-agents 5, creative 10, devops 1, email 2,
    media 3, note-taking 1, productivity 14, research 4, social-media 1, software-development 12, web 1.
  - `skills/index-cache/` holds hub index JSON, not skills.
  - **153 optional** skills in 23 categories under `optional-skills/`. Largest: mlops 36, creative 31, research 15,
    productivity 10, finance 9. Also autonomous-ai-agents, blockchain, communication, data-science, devops,
    dogfood, email, gaming, health, mcp, migration, payments, security, smart-home, social-media,
    software-development, web-development, yuanbao.
  - Optional skills install with `hermes skills install official/<cat>/<skill>`.
- **John's box:** `~/.hermes/skills` holds 166 skills in 25 categories, from an older and larger bundled set plus
  local ones. **51 of them have descriptions over 60 chars**, which the index truncates.

## 3. How skills reach the model

### Three levels of disclosure

The docs show it this way:

```
Level 0: skills_list()           → [{name, description, category}, ...]   (~3k tokens)
Level 1: skill_view(name)        → Full content + metadata       (varies)
Level 2: skill_view(name, path)  → Specific reference file       (varies)
```

But in the current code, **level 0 is mostly the system-prompt index**, not a tool call. The `skills_list` tool
still exists (`tools/skills_tool.py:290`). It returns name, description and category, plus a `categories` list, an
optional `category` filter, and the hint `"Use skill_view(name) to see full content, tags, and linked files"`.

**`skill_view(name)`** (`tools/skills_tool.py:592`) returns JSON with these fields:

- `content` (the full SKILL.md, preprocessed), `description`, `tags`, `related_skills`
- `path`, `skill_dir`
- `linked_files` grouped by references, templates, assets and scripts, plus a `usage_hint` such as `"call
  skill_view(name, file_path) where file_path is e.g. 'references/api.md'"`
- readiness fields (`setup_needed`, missing env vars, `setup_note`)
- `metadata` and `compatibility`

`skill_view(name, file_path)` serves one support file. It is checked for path traversal, and binary files return a
stub.

Tool schema descriptions (`tools/skills_tool.py:697-735`):

> `skills_list`: "List available skills (name + description). Use skill_view(name) to load full content."
>
> `skill_view`: "Skills allow for loading information about specific tasks and workflows, as well as scripts and
> templates. Load a skill's full content or access its linked files (references, templates, scripts). First call
> returns SKILL.md content plus a 'linked_files' dict showing available references/templates/scripts. To access
> those, call again with file_path parameter."

### What the system prompt contains

The index is built by `agent/prompt_builder.py:1245` (`build_skills_system_prompt`), rendered by
`_render_skills_index` at line 1321, and wired in by `agent/system_prompt.py:301`. It is **grouped by category**,
with the category's `DESCRIPTION.md` text, sorted, and one line per skill with the description cut to 60 chars:

```
## Skills
Before replying, scan the skills below. If a skill matches or is even partially relevant to your task, you MUST
load it with skill_view(name) and follow its instructions. Err on the side of loading — it is always better to have
context you don't need than to miss critical steps, pitfalls, or established workflows. Skills contain specialized
knowledge — API endpoints, tool-specific commands, and proven workflows that outperform general-purpose approaches.
Load the skill even if you think you could handle the task with basic tools like {web_search or terminal}. Skills
also encode the user's preferred approach, conventions, and quality standards for tasks like code review, planning,
and testing — load them even for tasks you already know how to do, because the skill defines how it should be done
here.
If a skill has issues, fix it with skill_manage(action='patch').
After difficult/iterative tasks, offer to save as a skill. If a skill you loaded was missing steps, had wrong
commands, or needed pitfalls you discovered, update it before finishing.

<available_skills>
  apple:
    - apple-notes: Manage Apple Notes via memo CLI: create, search, edit.
  ...
  software-development:
    - github: GitHub via gh CLI: PRs, issues, reviews, repos, auth.
    - systematic-debugging: 4-phase root cause debugging: understand bugs before fixing.
  web: Skills for reaching web content when direct access fails — blocked, paywalled, rate-limited, or bot-walled pages.
    - blocked-page-recovery: Use when a fetch fails: 403/429, paywall, WAF, bot wall.
</available_skills>

Only proceed without loading a skill if genuinely none are relevant to the task.
```

Details of the rendering:

- Trusted-project skills get a `[project] ` prefix on their description.
- If the session has no `web_search` tool, the text names only `terminal`.
- The prompt has no token budget and no cap on the number of skills. The only size control is the 60-char
  description limit plus the "focus" demotion described below.
- The source comment says to *"NEVER drop entries — agent-created skills are the model's project memory and it
  won't rediscover them via skills_list."*
- **Focus/coding posture** (`agent/coding_context.py:139`) collapses clearly non-coding categories (apple,
  communication, creative, email, finance, media, productivity, smart-home, social-media, …) into one names-only
  line, `  creative [names only]: a, b, c`, with the note *"(Categories marked [names only] are outside the current
  coding context, so their descriptions are omitted — the skills work normally and load with skill_view(name) as
  usual.)"*

**Measured size**, computed by me from the front matter with the same 60-char cut:

| Skill set | Skills | Index lines | Tokens (approx.) |
|---|---|---|---|
| 58 bundled | 58 | 5,683 chars | ~1.4k, plus ~0.3k for the header |
| 153 optional, if all installed | 153 | ~12.9k chars | ~3.2k |
| John's 166 local skills | 166 | ~15.8k chars | ~4k |

### Prompt-caching interaction

- **The system prompt is built once per session and frozen.** It is rebuilt only after context compression
  (`agent/system_prompt.py` docstring: *"Built once per session and reused across turns (only context compression
  triggers a rebuild) so the upstream prefix cache stays warm"*).
- **The prompt has three tiers:**
  - `stable`: identity, guidance, the coding brief, and **`skills.auto_load` pinned skill bodies**.
  - `context`: AGENTS.md and other context files, the workspace snapshot.
  - `volatile`: **the skills index first**, then memory and USER.md, the profile line, a timestamp, and runtime
    hints.

  The comment reads: *"Skills are runtime-mutable, so the index leads the volatile band: on a longest-prefix backend
  an unchanged index stays inside the reused prefix; a changed one re-prefills from here."* Anthropic gets four
  `cache_control` breakpoints: the static prefix, the end of the system prompt, and the last two messages
  (`agent/prompt_caching.py`).
- **Building the index is cached in two layers.** An in-process LRU with 32 entries is keyed on skills dir, extra
  roots, a file manifest (mtime and size of every SKILL.md and DESCRIPTION.md), available tools and toolsets,
  platform, disabled set, focus categories, one-shot flag and plugin rows. Behind it, a disk snapshot
  `~/.hermes/.skills_prompt_snapshot.json` (version 4, validated against the manifest) makes cold starts fast. Host
  facts such as platform and installed apps are re-checked against the snapshot.
- **A skill created mid-session does not change the frozen prompt.** It reaches the model through a delta note
  (`agent/skills_index_delta.py`, *"ported from cloudflare/cloudflare-os#267"*):
  - Every turn compares the prompt's `<available_skills>` block with what the session would build now.
  - The difference is appended once to the current **user message**, through the per-turn note channel behind the
    cached prefix.
  - Each note states the full difference against the prompt, so the prompt plus the newest note always tells the
    model the whole state.
  - Once compaction rebuilds the prompt, the next note says the index is accurate again.

  Note text:
  > `[System: The skills available in this conversation changed after its system prompt was built.` / `Now
  > available (load with skill_view(name) when relevant, like the skills listed in the system prompt):` /
  > `    - name: description` / `No longer available: a, b]` — or `... The skills listed in the system prompt are
  > accurate again; earlier skill-change notes are superseded.]`
- `skill_manage` clears the in-process index cache and the snapshot after a write (`_record_success`), but the open
  conversation's prompt is not rebuilt.
- `/reload-skills` refreshes only the slash-command map. It *"Does NOT invalidate the skills system-prompt cache:
  skills are called by name, so /reload-skills costs no cache reset"* (`agent/skill_commands.py:758`).
- `/skills install|uninstall|reset` defer cache invalidation to the next session by default. `--now` invalidates
  immediately; the source says it *"costs more money"* (`hermes_cli/skills_hub.py`, slash table comment).

**Description truncation:** `extract_skill_description` cuts to 57 chars plus `...`. `skill_manage` returns a
`system_prompt_preview` when a description will be cut. The curator prompt reminds the model that *"long
descriptions are truncated to 57 chars in the system prompt skill index — keep the trigger class in that window."*

## 4. Conditional activation and disabling

All of these are **offer-time** gates (index, `skills_list`, slash commands) unless noted otherwise.

- **`platforms:`** checks the host OS. `skill_view` also refuses the skill on an unsupported OS (`"not supported on
  this platform"`).
- **`environments:`** (kanban, docker, s6) and **`requires_apps:`** hide the skill from offers, but an explicit
  `skill_view` or `--skills` still loads it.
- **Toolsets** (`_skill_should_show`, `agent/prompt_builder.py:1180`): a skill is hidden when a `fallback_for_*`
  tool or toolset *is* available, or a `requires_*` one *is not*. Example: `optional-skills/research/duckduckgo-
  search` has `fallback_for_toolsets: [web]`, so it shows only when the Firecrawl-backed `web` toolset is missing.
  `metadata.hermes.session_platforms` limits a skill to gateway channels such as telegram or slack, and fails open
  when the platform is unknown.
- **Disable config:** `skills.disabled: [...]` applies globally. `skills.platform_disabled.<platform>: [...]` applies
  per platform (cli, telegram, discord, …). The effective set is the union, minus `ESSENTIAL_SKILLS =
  {"hermes-agent"}`, which can never be disabled (`agent/skill_utils.py:263-280`). A disabled skill is gone from
  the index, `skills_list` and slash commands, and `skill_view` refuses it with *"Skill 'x' is disabled. Enable it
  with `hermes skills` …"*.
- **`hermes skills config`** (`hermes_cli/skills_config.py`) is an interactive curses checklist:
  - Choose "All platforms (global default)" or one messaging platform.
  - Toggle individual skills (`name (category) — description[:55]`), or whole categories.
  - Saves `skills.disabled` or `skills.platform_disabled[platform]`.

  The dashboard's `PUT /api/skills/toggle` does the same per profile.
- **One-shot runs** (`hermes chat -q`, `-z`; `agent/oneshot_footprint.py`) hide `skill_manage` and use a lean
  header:
  > "## Skills\nScan the skills below and load one with skill_view(name) only when it carries domain knowledge you
  > lack for THIS task (an API, a tool's commands, a project's conventions). Do not load general process skills
  > (testing, debugging, review methodology) for work you already know how to do, and do not create or edit skills:
  > this is a one-shot run with no later session to reuse them."

  The reason, measured: *"across 21 one-shot benchmark trajectories the agent authored 7 new skills … 37 of ~215
  tool calls were skill_view/skill_manage, and skill text was 34% of every tool-result byte fed back into
  context."*
- A "safe worker" policy disables skills entirely. Agents without any skills tool get no index, and a variant of
  the help text that does not mention `skill_view`.

## 5. Autonomous skill creation and improvement

### The `skill_manage` tool

Source: `tools/skill_manager_tool.py`.

- **One advertised call shape:** `{"operations": [ ... ]}`, applied atomically. Any failure rolls back every skill
  the batch touched.
- **Each action has its own schema branch** with `additionalProperties:false`. The reason: a 27B model kept putting
  `file_content` on `create`.
- **Actions:**
  - `create`: name, content, optional category. Must come before other ops on the same skill.
  - `patch`: `old_string`/`new_string`/`replace_all`, optional `file_path`. Preferred.
  - `patch` with `content`: full rewrite. `edit` is the legacy alias.
  - `write_file` and `remove_file`: paths must start with references/, templates/, scripts/ or assets/.
  - `delete`: must be the only op. `absorbed_into` is used only for curator consolidation.
- **Limits:**
  - SKILL.md at most 100,000 chars (*"~36k tokens"*), with a hint to split into references/.
  - Support files at most 1 MiB.
  - Front matter must include name and description. New skills must keep the description within 60 chars.
- **On every write:**
  - Per-skill file lock.
  - Audit ledger entry with before and after blobs (`~/.hermes/skills/.curator_ledger.jsonl`, `hermes curator
    rollback`).
  - Advisory lint findings returned in the result. Rules include `incident-log-shape`, `references-sprawl` (more
    than 60 files) and `oversized-body` (body over about 24k chars).
  - Prompt index cache cleared.
  - Usage telemetry bumped (`~/.hermes/skills/.usage.json`).

Tool description (`_skill_manage_description`, line 822):
> "Create, update, or delete skills — your procedural memory for recurring task types. The call is an operations
> array (a single edit is a list of one); it applies atomically — any failure rolls every touched skill back. Ops:
> create (full SKILL.md; lands in the profile's skills directory or configured skills.create_dir; must precede that
> skill's other ops), patch (targeted old_string/new_string fix — preferred; content alone REPLACES the whole file,
> read it via skill_view() first), write_file/remove_file (supporting files), delete (sole op only). Existing skills
> are modified wherever they live. Keep the description's first 57 chars a self-contained trigger: 'Use when
> <trigger>. <one-line behavior>.' Write lessons, not logs: imperative rule + why, no PR numbers/dates/incident
> narration, one rule per lesson, references/ named by topic (extend before adding). skill_view() shows format
> conventions."

### When the prompt asks for skill creation

**In the system prompt** (`SKILLS_GUIDANCE`, `agent/prompt_builder.py:258`, included only when `skill_manage` is
available):
> "When you work out a non-trivial workflow, record it with skill_manage for future reuse.
>
> ## Skill Safety Rule
> A skill placeholder containing `[SKILL_PRUNED]` lost its content in context compression and is inaccessible —
> reload it with skill_view(name='...') before acting on anything that depends on it. …"

The index header adds *"After difficult/iterative tasks, offer to save as a skill. If a skill you loaded was
missing steps, had wrong commands, or needed pitfalls you discovered, update it before finishing."*

The old wording *"After completing a complex task (5+ tool calls), fixing a tricky error, or discovering a
non-trivial workflow, save the approach as a skill…"* was **removed on purpose**. A code comment explains that
Anthropic's server-side filter rejected it on subscription OAuth credentials with a billing-shaped HTTP 400, and
warns: *"re-verify against a subscription OAuth token"*. Blogs that still quote "5+ tool calls" are out of date.

### Nudges: a background review fork, not an in-context reminder

Sources: `agent/turn_iteration_prep.py:166`, `agent/tool_executor.py:749`, `agent/turn_finalizer.py:763-787`,
`agent/background_review.py`.

- **Counting:** `_iters_since_skill` goes up by one per tool-calling iteration, and resets whenever `skill_manage`
  runs.
- **Trigger:** at the end of a turn, if the count is at least `skills.creation_nudge_interval`, the counter resets
  and a background review runs.
  - The code default is 10; `cli-config.yaml.example` and John's config use 15; 0 turns it off.
  - The review also requires a final response, no interruption and no `skip_background_review` (cron skips it,
    citing *"~30K tokens / event"*).
  - The memory nudge counts user turns (`memory.nudge_interval`, default 10). If both fire, a combined prompt is
    used.
- **The fork runs after the reply has been delivered**, in a daemon thread.
- **It is built for cache parity** (`build_cache_parity_fork`):
  - Same provider, model and credentials.
  - A **byte-identical system prompt and `tools[]`**, with the tool snapshot frozen.
  - The same session id, so the provider prefix cache is warm.
- **Tool access is limited at dispatch, not in the advertised list.** Allowed: the `skills` toolset (the memory tool
  only when the memory trigger fired), plus `read_file` and `search_files`, plus optional
  `auxiliary.background_review.extra_tools`.
- **Limits and routing:** at most 16 iterations. If `auxiliary.background_review.{provider,model}` routes to a
  different model, the cache is cold anyway, so older turns are compressed into a digest and the last 24 messages
  are kept.
- **Isolation:** the fork's turns are never written into the real session.
- **Feedback:** results show to the user as short lines, for example `📝 Skill 'x' patched: "old" → "new"`.
- **Read-before-write is enforced.** The fork must call `skill_view` on a skill or file during the review before
  patching it; transcript copies do not count.

Key review prompt text (`_SKILL_REVIEW_PROMPT`, `agent/background_review.py:448`):
> "Review the conversation above and update the skill library. Be ACTIVE — most sessions produce at least one skill
> update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome.
>
> Target shape of the library: CLASS-LEVEL skills, each with a SKILL.md of always-on rules and a small `references/`
> set of topical depth. …
>
> Signals to look for (any one of these warrants action): • User corrected your style, tone, format, legibility, or
> verbosity … are FIRST-CLASS skill signals, not just memory signals. • User corrected your workflow … • Non-trivial
> technique, fix, workaround, debugging path, or tool-usage pattern emerged … • A skill that got loaded or consulted
> this session turned out to be wrong, missing a step, or outdated. Patch it NOW.
>
> Preference order … 1. UPDATE A CURRENTLY-LOADED SKILL … 2. UPDATE AN EXISTING UMBRELLA … 3. ADD A SUPPORT FILE
> under an existing umbrella … 4. CREATE A NEW CLASS-LEVEL UMBRELLA SKILL … The name MUST NOT be a specific PR
> number, error string, feature codename, library-alone name, or 'fix-X / debug-Y / audit-Z-today' session artifact."

The shared `_LESSON_LAYER_BLOCK` covers how to write a skill:

- Procedure first.
- A pitfall is a general rule plus one clause of why.
- No PR numbers, dates or quotes.
- The same lesson learned twice becomes one rule.
- Don't repeat what AGENTS.md or the tool schemas already say.
- Always-on rules go in SKILL.md; references/ only for occasional depth, named by topic.
- Fix a wrong rule in place; don't append "UPDATE: …".

`_DO_NOT_CAPTURE_BLOCK` lists what not to save:

- Environment-dependent failures.
- Negative claims about tools (*"These harden into refusals the agent cites against itself for months"*).
- Transient errors.
- One-off task stories.
- Unresolved dead ends written up as a "reliable workflow".

### Improvement during use, and review

- **Self-improvement in the foreground:**
  - The index header says to update a loaded skill that was wrong.
  - The memory guidance says *"Skills come first … record it in the skill you used or built for the task."*
  - The background fork's first preference is to patch skills loaded in that session, *"whoever wrote it:
    hand-written, installed, bundled, and pinned skills are all yours to improve."*
- **Review and approval (both off by default):**
  - `skills.write_approval: true` stages every write, foreground or background, in
    `~/.hermes/pending/skills/<id>.json`. Skills are always staged rather than asked about inline because *"Skills
    are too big to review inline"* (`tools/write_approval.py:201`). Review with `/skills pending | diff <id> |
    approve <id|all> | reject <id|all> | approval on|off` (`hermes_cli/write_approval_commands.py`).
  - `skills.guard_agent_created: true` runs the security scanner on agent writes. See §7.
- **Curator** (`agent/curator.py`, `hermes curator status|run|pause|resume|pin|unpin|archive|restore|prune|backup|
  rollback`):
  - Starts on inactivity: `interval_hours` 168 and `min_idle_hours` 2 by default.
  - The deterministic pass marks unused agent-created skills `stale` after 14 days and archives them to
    `~/.hermes/skills/.archive/` after 30 days. It never deletes.
  - Exempt: pinned skills and skills referenced by cron.
  - Never-used skills get a grace period.
  - `prune_builtins: true` also archives unused **bundled** skills. John has this on.
  - The optional LLM "umbrella-building" consolidation pass (`consolidate: true`, about 50 to 100 API calls,
    `auxiliary.curator` model) merges clusters into class-level skills. Its prompt says *"A SKILL.md body over ~24k
    chars is a consolidation target on its own: skill_view loads all of it into context for the rest of the
    session"*.
  - Takes a tar.gz backup before each run (`backup.keep`).
  - Hub-installed and external skills are never touched.
- **John's config:** curator `enabled`, `consolidate: false`, `prune_builtins: true`, `stale 14 / archive 30`,
  backup keep 5. Skills: `write_approval: false`, `guard_agent_created: false`, `creation_nudge_interval: 15`,
  `template_vars: true`, `inline_shell: false`.
- **`/learn <anything>`** (`agent/learn_prompt.py`) is an explicit way to author a skill. It builds a normal turn
  with the authoring standard. Large sources (books, specs) become a knowledge-base skill: a lean SKILL.md index plus
  one file per chapter under `references/`, so *"query cost stays proportional to the answer, not the source."* It
  is also in the dashboard's "Learn a skill" panel.

## 6. Skills Hub

Sources: `tools/skills_hub*.py`, `hermes_cli/skills_hub.py`, `hermes_cli/subcommands/skills.py`.

**Source router order** (`tools/skills_hub_search.py:99`):

1. `OptionalSkillSource`: official, from repo `optional-skills/`.
2. `HermesIndexSource`: a central JSON index on the docs site, rebuilt daily by CI. Search and path lookup cost zero
   GitHub API calls.
3. `SkillsShSource`: skills.sh.
4. `WellKnownSkillSource`: `/.well-known/skills/index.json` on any site.
5. `UrlSource`: a direct URL to a SKILL.md, plus the support files it references.
6. `GitHubSource`: default taps openai/skills (`.curated`, `.system`), anthropics/skills, huggingface/skills,
   NVIDIA/skills, garrytan/gstack, and science buckets (K-Dense-AI, synthetic-sciences/openscience), plus taps from
   `taps.json`.
7. `ClawHubSource`.
8. `LobeHubSource`.
9. `BrowseShSource`: site-specific browser skills.

Unfiltered searches use the cached index first. On a miss, the live registries get at most 8 seconds.

**CLI:** `hermes skills browse | search <q> [--source …] | install <id|url> [--category] [--name] [--force] |
inspect | list [--source hub|builtin|local] [--enabled-only] | check | update [--force] | audit [--deep] | uninstall
| reset [--restore] | list-modified | diff | opt-out [--remove] | opt-in [--sync] | repair-official | publish <path>
--to github|clawhub --repo o/r | snapshot export|import | tap list|add|remove | trust | untrust | config`. In chat,
`/skills …` offers the same commands, and also handles `pending/approve/reject/diff/approval` for write approval.

**Trust levels** (`tools/skills_guard.py:23-32`):

| Trust level | Source | safe | caution | dangerous |
|---|---|---|---|---|
| `builtin` | official skills (from `official` or `optional-skills`) | allow | allow | allow |
| `trusted` | the 4 repos in `TRUSTED_REPOS` | allow | allow | block |
| `community` | everything else | allow | block (`--force` overrides) | block (`--force` cannot override) |
| `agent-created` | the agent's own writes | allow | allow | "ask" (returned to the agent as an error) |

**Lock file and quarantine:**

- Downloads go to `skills/.hub/quarantine/<name>`. There they are scanned with the content-hash scan cache, plus an
  optional advisory NVIDIA SkillEvaluator Tier 1 scan.
- After the scan they move into the skills dir.
- `skills/.hub/lock.json` records source, identifier, trust, verdict, `sha256` content hash, install path, files and
  scanner version.
- `skills/.hub/audit.log` gets INSTALL and UNINSTALL lines.
- `update` compares the upstream bundle hash and skips locally edited skills unless `--force` is given.

## 7. Security: skills_guard

`tools/skills_guard.py` is `SCANNER_VERSION = "skills-guard-v10"`. It is a regex static scan with **136 patterns**:

| Category | Patterns |
|---|---|
| exfiltration | 27 |
| persistence | 20 |
| injection | 19 |
| obfuscation | 14 |
| supply_chain | 10 |
| network | 9 |
| destructive | 8 |
| execution | 7 |
| credential_exposure | 7 |
| privilege_escalation | 6 |
| traversal | 5 |
| mining | 2 |
| structural | 2 |

Severity spread: 51 critical, 45 high, 34 medium, 6 low.

**What it looks for:**

- Env and secret exfiltration via curl, wget, fetch or requests.
- Reads of `~/.ssh`, `~/.aws` and `.hermes/.env`.
- Markdown image or link URLs with `$VAR`.
- "Ignore previous instructions", role hijack, system prompt override, hidden HTML div or comment, jailbreak
  phrasing.
- `rm -rf /`, mkfs, dd.
- Cron, shell rc files, systemd, launchd, sudoers, ssh backdoors.
- Reverse shells and tunnels.
- base64, eval and exec obfuscation.
- `curl | sh`, unpinned pip or npm installs.
- Modifying agent config (AGENTS.md, CLAUDE.md, `.hermes/config.yaml`, `.claude/settings`) by shell redirect or by
  imperative prose.
- Leaked keys.
- "Send the conversation history" style context exfiltration.
- Invisible Unicode (zero-width characters and similar).

**Structure checks:** at most 50 files, 5 MB total and 256 KB per file; suspicious binaries are flagged.
`.skillignore` and `.clawhubignore` are honored.

**Verdict:** any critical finding makes it `dangerous`; any high finding makes it `caution`; medium and low alone
leave it `safe`. Community skills get some findings in .md files demoted, such as `sudo_usage`.

**Agent-created versus hub-installed skills:**

- **Hub installs** are always scanned in quarantine and the policy above is enforced.
- **Agent writes are not scanned by default** (`guard_agent_created: false`). The config comment explains: *"the
  agent can run the same code via terminal() ungated, so it mostly blocks prose with risky keywords."*
- When the guard is on, a write that gets a `dangerous` verdict is rolled back. The result goes back to the agent as
  an error so it can retry without the flagged content (`_security_scan_skill`, `_guarded_write`).
- `configuration.md` says the guard "surfaces as an approval prompt"; the code does not do that (see §12).

**Other guards:**

- Trusted project skills are scanned and quarantined when dangerous. The scan cache lives in
  `~/.hermes/cache/project_skill_scans/`.
- `skill_view` logs, but does not block, a warning for a file outside the trusted roots or a short list of injection
  phrases.
- `inline_shell` (`!`cmd`` in SKILL.md) is off by default, and community installs never auto-execute it.

## 8. Slash commands

- **Every skill that resolves uniquely becomes `/slug`** (`agent/skill_commands.py:516`, `scan_skill_commands`).
  Unicode names are kept. Telegram shows at most 60 commands in its menu (`hermes_cli/commands_platforms.py:101`);
  the rest still work when typed.
- **Stacking:** `/a /b do X` loads up to 5 skills.
- **Bundles:** YAML aliases in `~/.hermes/skill-bundles/` (`agent/skill_bundles.py`). A bundle wins over a skill
  with the same slug.
- **Injection happens as a user message**, never by changing the system prompt (`build_skill_invocation_message`,
  line 816; `_build_skill_message`, line 366). The message contains:
  - the header `[IMPORTANT: The user has invoked the "<name>" skill, indicating they want you to follow its
    instructions. The full skill content is loaded below.]`
  - the preprocessed SKILL.md body (`${HERMES_SKILL_DIR}` and `${HERMES_SESSION_ID}` substituted)
  - `[Skill directory: /abs/path]` and *"Resolve any relative paths in this skill … against that directory, then
    run them with the terminal tool using the absolute path."* This saves a `skill_view` round trip.
  - injected `skill.config` values
  - a setup note
  - a list of support files with the `skill_view(name, file_path)` hint
  - finally `The user has provided the following instruction alongside the skill invocation: <text>`
- **Caching:** the builder registers everything before the user's instruction as a stable prefix
  (`agent/prompt_cache_boundary.py`). The Anthropic cache planner puts a breakpoint at that boundary, so the static
  skill scaffold is cached separately from the instruction that changes. The docs note: *"Bundles do not invalidate
  the prompt cache. They generate a fresh user message at invocation time … no system prompt mutation."*
- **Session preload:** `hermes -s <skill>` loads the skill into the session start as "preloaded … active guidance
  for the duration of this session". `skills.auto_load: [...]` pins full skill bodies into the **stable** system
  prompt tier for every new session.
- **Gateway:** `channel_skill_bindings` (Discord, Slack) and topic auto-load put the skill payload in front of the
  first user message of a new session (`gateway/run_turn_prepare.py:460`).
- **Memory providers** use `extract_user_instruction_from_skill_message`, so they store what the user typed, not the
  expanded skill body.

## 9. Memory versus skills

**Memory:** `MEMORY.md` (target `memory`, 2,200 chars by default) and `USER.md` (target `user`, 1,375 chars). Both
are injected into every turn, in the volatile tier.

**Skills:** procedural memory, loaded only when relevant.

System prompt text (`build_memory_guidance`, `agent/prompt_builder.py:192`):
> "You have persistent memory, carried across sessions and loaded into each new session's context; the memory
> tool's schema defines what belongs there. Skills come first: when you learn something while doing a task — a
> procedure, a pitfall, and the user's preferences and corrections for that kind of work — record it in the skill
> you used or built for the task (skill_manage), where it loads only when relevant. Memory is the narrow exception
> for facts that apply to EVERY session regardless of task (who the user is, environment facts, standing
> conventions with no task home); it has a hard character budget, so when it fills, replace or consolidate stale
> entries rather than skipping the save. Write entries as declarative facts, not instructions to yourself … A fact
> stale within a week belongs in session history; procedures and workflows belong in skills."

The memory tool schema (`tools/memory_tool.py:373`) says the same: *"Anything learned while doing a task
(procedures, pitfalls, and the user's preferences and corrections for that kind of work) belongs in the task's skill
via skill_manage, where it loads only when relevant; memory is injected into every turn and must stay small."*

The review prompt adds: *"Memory says 'who the user is and what the current situation and state of your operations
are'; skills say 'how to do this class of task for this user'. A user-preference lesson lives in exactly ONE place."*
`skill_manage` itself is described as "your procedural memory for recurring task types".

## 10. User interfaces for skills

- **CLI:** `hermes skills config` (curses checklist, global or per platform, by skill or by category) and the full
  `hermes skills …` hub CLI. `hermes curator …` manages the lifecycle.
- **Chat slash commands** (CLI, TUI and every gateway platform):
  - `/skills <hub subcommand>`
  - `/skills pending|approve|reject|diff|approval`
  - `/reload-skills`
  - `/learn`
  - `/<skill>` and stacked `/a /b`
  - `/suggestions`, which lists skill suggestions the hub offered
- **TUI:** the slash catalog refreshes on a gateway `skills.changed` event (`published_scopes_signature`). Only the
  command maps refetch; the conversation's stored system prompt is never rebuilt.
- **Web dashboard** (`web/src/pages/SkillsPage.tsx`, API in `hermes_cli/web_routers/skills.py`):
  - Routes: `GET /api/skills` (with `enabled`, `usage` and `provenance`), `PUT /api/skills/toggle`, `GET`/`PUT
    /api/skills/content` (view and edit SKILL.md), `POST /api/skills` (create).
  - A hub browser to search, preview, scan, install and update, with connected-hub status.
  - A "Learn a skill" panel.
  - Everything is profile-scoped.
- **Desktop app:** the `hermes://skill/install?identifier=…` deep link from the website's Skills Hub cards. It shows
  a confirmation dialog and then runs the normal install pipeline. Open conversations are told about the new skill
  on their next message.

## 11. Other efficiency techniques

1. **60-char routing budget per skill**, enforced when skills are created and by tests, so the always-loaded index
   stays at about 25 tokens per skill. The index never drops entries.
2. **Index at the start of the volatile tier**, a frozen prompt per session, and **mid-session changes sent as a
   one-time delta note on the user message**. Adding or removing a skill never invalidates the cached prefix.
3. **Cheap change detection everywhere:**
   - The prompt index cache is keyed by a file manifest, with a disk snapshot for cold starts.
   - `skills_list` and slash maps use a directory-tree signature (mtime plus child names, depth 6), with a 30-second
     time limit for edits in place (`_SKILLS_CACHE_TTL_SECONDS`).
   - The hub uses a central index (0 GitHub calls) and caches scans by content digest.
4. **Repeat `skill_view` returns a stub** (`tools/skills_tool_dedup.py`). The sha256 of the served result is kept
   per task. A byte-identical repeat returns *"Skill content unchanged since it was loaded earlier in this
   conversation — refer to the earlier skill_view result; it is still current and complete. (Re-issued after
   context compression, this returns the full content again.)"*
   - Results that need setup are never deduplicated.
   - The cache is cleared on compression and on pruning of tool results.
   - The background fork never deduplicates, so its read-before-write check works.
5. **Compression keeps track of lost skills** (`agent/context_compressor.py:843-918`):
   - A pruned `skill_view` body becomes `[SKILL_PRUNED: content lost in compression; reload with
     skill_view(name='x')]`.
   - Markers the summarizer drops are added back under `## Pruned Skills`.
   - Bodies loaded in the last 10 messages, or named in a user message in the kept tail, survive the first prune
     pass.
   - A todo snapshot carried across compaction comes with a reload notice.
6. **Background reviews reuse the parent's cache:** byte-identical system prompt and `tools[]`, the same session id,
   tool limits applied at dispatch. They run after delivery and are skipped for cron and one-shot runs.
7. **One-shot mode** drops `skill_manage` and the coaching text, based on the measured 34% of tool-result bytes
   (§4).
8. **Focus/coding posture** shows non-coding categories as names only.
9. **Slash-skill scaffolds register a stable prefix**, so the cache breakpoint falls between the static body and the
   instruction that changes.
10. **The absolute skill dir and the support-file list ship with slash invocations**, so the model can run
    `scripts/` without another `skill_view`. `skill_view` itself returns `linked_files` and a `usage_hint`.
11. **Patch is preferred over rewrite**: only the diff appears in the tool call. Operations are batched and atomic.
12. **Size discipline:**
    - Lint `oversized-body` above about 24k chars, because *"skill_view loads the whole file and it stays in
      context for the rest of the session"*.
    - Lint `references-sprawl` above 60 files.
    - Hard limit of 100k chars on SKILL.md.
    - The curator distills skills into umbrellas plus topical `references/`.
    - `/learn` builds knowledge bases as an index plus per-chapter references.
13. **Lifecycle pruning:** the curator archives unused agent-created skills (and, optionally, unused bundled ones), so
    the index does not grow without limit.
14. **`/reload-skills` and installs do not reset the prompt cache.** `--now` is the explicit, paid opt-in.
15. **`deps:` installs tools at load time**, and declared env vars are passed through automatically, so the model
    spends no turns on setup.
16. **`hermes-agent` is an essential skill.** The help guidance that points at `skill_view(name='hermes-agent')` is
    included only when that skill appears in the rendered index, so the prompt never names a skill that is missing.

## 12. Discrepancies to be aware of

- **"5+ tool calls" no longer applies.** Blogs and older docs say a skill is created after a complex task of 5+ tool
  calls. Current code removed that sentence (see the Anthropic OAuth filter note in §5). The nudge counts **tool
  iterations since the last `skill_manage`** (default 10) and spawns a **background review fork**. The comment in
  `cli-config.yaml.example` ("remind the model") is out of date.
- **Curator defaults:** secondary articles say stale after 30 days and archived after 90. Code and docs say **14 and
  30** (`agent/curator.py:31-35`, `hermes_cli/config_defaults.py`).
- **`guard_agent_created`:** `configuration.md` says a flagged write "surfaces as an approval prompt". The code
  rolls the write back and returns a tool error to the agent (`INSTALL_POLICY["agent-created"]` with "ask", which
  becomes an error).
- **Index cost:** the docs give "~3k tokens" for the level-0 listing. The real index for the 58 bundled skills is
  about 1.4k tokens. It grows to about 4k with 150+ skills, as on John's box.
- **`skills/AGENTS.md`** lists 14 optional categories; the repo has 23.
- **John's local checkout** is from 2026-10-09 (`dce1e9b3`). Everything above is from the 2026-10-18 clone; the
  mechanisms are the same, but line numbers may differ.
