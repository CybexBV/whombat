# OpenClaw skills: implementation and efficiency (state on 2026-10-18)

Research date: 2026-10-18. Primary source: a shallow clone of `github.com/openclaw/openclaw` `main` at
commit `14a53244238016c712d2313640c7d72e7e46181e` (committed 2026-10-18 16:57 UTC, `package.json` version
`2026.10.4`; latest GitHub release `v2026.10.4`, 2026-10-16) in
`~/.cache/wb-tmp/research/2026-10-18-skills/openclaw-src`. Only files were read; no code was run.
Paths below are relative to that clone unless they are URLs. Live docs at docs.openclaw.ai were spot-checked
and match `main`.

John's local install (`/home/me/openclaw`) is **2026.9.4**. It is older than what is described here: it has no
`skills_search`/`skills_read` tools (merged 2026-10-01, PRs #158090/#158091) and still has the proposal-based
Skill Workshop (`autonomous.mode: off|propose|auto`). `~/.openclaw/openclaw.json` has no `skills` block and no agent
skill allowlists (agents `main` and `dozer` inherit everything); `~/.openclaw/skills` is empty.

---

## TL;DR on efficiency

- The system prompt holds only a catalog with **name, description and location** (path) for each eligible skill.
  It's an XML block (`<available_skills>`). The SKILL.md body is **never** inlined. The model loads it on demand
  with its `read` tool (or the newer `skills_read` tool) when a task matches.
- Cost formula (documented and matching the code): **fixed base + ~97 chars per skill + len(name) + len(description)
  + len(location)**, about 24 tokens per skill before the fields. With the bundled skills' average description
  (93 chars) and a `~/…` path, that is about 250–260 chars, or about 65 tokens per skill.
- Hard budget: by default **18,000 chars** (`skills.limits.maxSkillsPromptChars`) and **150 skills**
  (`maxSkillsInPrompt`). If the full format doesn't fit, it degrades in steps: first it keeps as many
  **identities** as fit (name and location, no descriptions); then it binary-searches the longest description
  length, between 4 and 220 chars, that still fits; then it adds a "⚠️ Skills truncated / compact format" note.
  Small-context models get an extra pass that caps the catalog at `contextTokens/5` chars. Descriptions shrink to
  as few as 64 chars, but names and locations are never dropped.
- Skills cut from the prompt stay reachable through **`skills_search`**, a lexical in-memory index over names,
  descriptions and bounded body prefixes, and **`skills_read({name})`**.
- **Gating happens at load time.** A skill whose required binary, env var or config path is missing never reaches
  the prompt. `disable-model-invocation: true` skills stay out of the prompt but can still be called with
  `/name` or `$name`.
- **Snapshot per session.** It is built at session start and reused. Refresh happens only on real content or
  eligibility changes: a background worker polls about once a minute, and explicit actions trigger an immediate
  rescan. The Skills section sits **below the prompt-cache boundary**, so a catalog refresh doesn't invalidate the
  cached prefix. On Anthropic and OpenAI Responses routes, refreshed sections go in as instruction messages after
  the current user turn.
- The home directory is collapsed to `~/` in prompt paths. The Claude CLI backend gets the skills as a temporary
  Claude Code plugin (`--plugin-dir`) instead of the XML catalog, so the listing is never duplicated.

---

## 1. Skill format

**SKILL.md** is a directory containing `SKILL.md`, with YAML front matter and a Markdown body. OpenClaw follows the
**AgentSkills** spec (agentskills.io). Source: `docs/tools/skills.md` ("SKILL.md format"), parser in
`src/skills/loading/frontmatter.ts`.

- Required: `name` and `description`. If `name` is missing, the directory name is used.
  - Names are lowercase, digits and hyphens. Keep the directory name and `name` aligned
    (`docs/tools/creating-skills.md`).
  - The docs ask for one line under 160 characters for `description`. The Workshop hard cap is 1–1024 bytes,
    with an advisory at more than 160 bytes (`src/skills/workshop/skill-lint.ts`).
- Parsing: front matter is parsed as YAML first, with a single-line-only fallback. A nested `metadata` block is
  flattened to a JSON string and re-parsed as JSON5. A missing closing delimiter produces a warning; invalid files
  are reported and skipped while their siblings still load.
- `{baseDir}` in the body is a convention for "this skill folder". The catalog preamble and the `skills_read`
  result tell the model to resolve relative paths against the SKILL.md directory (`src/skills/loading/skill-contract.ts`,
  `src/agents/skill-instruction-result.ts`). No literal text substitution was found.
- Optional top-level keys (`docs/tools/skills.md`, `src/skills/loading/frontmatter.ts#resolveSkillInvocationPolicy`):
  - `homepage`: the "Website" link in the UI.
  - `user-invocable` (default `true`): expose the skill as a slash command.
  - `disable-model-invocation` (default `false`): keep it out of the model's prompt and the `$` picker, while
    explicit `$name` and `/name` still work.
  - `command-dispatch: tool`, `command-tool: <tool name>`, `command-arg-mode: raw`: the slash command bypasses the
    model and calls a tool with `{ command: "<raw args>", commandName, skillName }`.
  - `skill-creator` also lists `license` and `allowed-tools` as accepted AgentSkills fields
    (`skills/skill-creator/SKILL.md`). `allowed-tools` is accepted, but no enforcement exists in `src/skills`.
- `metadata.openclaw` (types in `src/skills/types.ts#OpenClawSkillMetadata`):
  - `always`: include whenever the OS matches, bypassing bins/env/config checks.
  - `os`: `darwin|macos|linux|win32`, a hard filter that `always` cannot override.
  - `requires.bins`: all must be on PATH.
  - `requires.anyBins`: at least one must be on PATH.
  - `requires.env`: set in the process, in `skills.entries.<key>.env`, or via `apiKey` when it equals `primaryEnv`.
  - `requires.config`: `openclaw.json` paths that must be truthy. Defaults: `browser.enabled` and
    `browser.evaluateEnabled` count as true.
  - `primaryEnv`: links `skills.entries.<key>.apiKey` to an env var.
  - `skillKey`: an alternative config key.
  - `emoji`, `homepage`.
  - `install[]`: installer specs, `{id, kind: brew|node|go|uv|download, label, bins, os, formula|package|module|url,
    sha256, archive, extract, stripComponents, targetDir}`. Each spec is validated with strict regexes
    (`normalizeSafeBrewFormula`, npm spec validation, an http(s)-only URL, and a 64-hex `sha256`).
  - The pre-July-2026 `metadata.clawdbot` block is no longer read.

Example (bundled `skills/github/SKILL.md`):
```yaml
name: github
description: "GitHub CLI for issues, PRs, CI/check logs, comments, reviews, releases, repos, and gh api queries."
metadata: { "openclaw": { "emoji": "🐙", "requires": { "bins": ["gh"] },
  "install": [{ "id": "brew", "kind": "brew", "formula": "gh", "bins": ["gh"], "label": "Install GitHub CLI (brew)" }] } }
```

Supporting files go next to the SKILL.md. The Workshop enforces `references/`, `templates/`, `scripts/` and `assets/`,
with each file at most 256 KiB. ClawHub installs may carry a generated `skill-card.md`, a regular file of at most
256 KiB.

## 2. Sources and precedence

The table below is from `docs/tools/skills.md` ("Loading order"), with implementation in
`src/skills/loading/skill-precedence.ts`, `workspace-skill-sources.ts` and `skill-root-discovery.ts`. It lists
sources from highest precedence to lowest.

| Priority | Source | Path |
|---|---|---|
| 1 | Workspace | `<workspace>/skills` |
| 2 | Project agent | `<workspace>/.agents/skills` |
| 3 | Personal agent | `~/.agents/skills` (default state dir only) |
| 4 | Managed/local (ClawHub `--global`) | `<state-dir>/skills` = `~/.openclaw/skills` |
| 5 | Workshop (agent-learned) | `<state-dir>/agents/<agentId>/agent/workshop-skills` |
| 6 | Bundled, plus Custodian skills (Custodian agent only) | shipped `skills/`, `custodian-skills/` |
| 7 | Extra dirs and plugin skills | `skills.load.extraDirs` and each plugin's `openclaw.plugin.json` `skills` dirs |

- When two sources have a skill with the same name, the higher source wins. Workspace skills overriding bundled
  ones log a warning; other overlaps log at info level. Identical content stays silent.
- A separate execution workspace (worktree) adds its own `skills/` and `.agents/skills/` after the agent catalog.
- Grouped layouts: a `SKILL.md` anywhere up to **6 levels deep** under a root is found, and traversal stops below
  it. The folder path is organizational only; the identity comes from `name`.
- Other origins:
  - Node-hosted skills come from a paired headless node's `~/.openclaw/skills`. They are visible only while the
    node is connected and get a node-prefixed name on collision.
  - A per-profile **Personal skill library** on shared Gateways stores immutable revisions in SQLite plus
    `skill-library/<id>/revisions/<hash>/`. A new session selects at most 64 enabled library skills. Bundles are
    limited to 256 files, 1 MiB per file and 8 MiB in total.
- Codex's `$CODEX_HOME/skills` is not a skill root (migrate with `openclaw migrate codex`).
- Discovery limits, from `skill-root-discovery.ts`:
  - `maxCandidatesPerRoot`: 300.
  - `maxSkillsLoadedPerSource`: 200.
  - `maxSkillFileBytes`: 256,000.
  - 10,000 raw entries per directory scan.
  - Path containment is enforced. Symlinks outside a root are refused unless the target is in
    `skills.load.allowSymlinkTargets`.
- **Bundled count:**
  - **49** skills in `skills/` (1password, apple-notes, apple-reminders, bear-notes, blogwatcher, blucli, camsnap,
    clawhub, coding-agent, control-ui, diagram-maker, eightctl, gemini, gh-issues, gifgrep, github, gog, goplaces,
    healthcheck, himalaya, mcporter, meme-maker, model-usage, nano-pdf, node-connect, node-inspect-debugger, notion,
    obsidian, openai-whisper, openai-whisper-api, openhue, oracle, ordercli, peekaboo, python-debugpy, sag,
    sherpa-onnx-tts, skill-creator, songsee, sonoscli, spike, spotify-player, summarize, things-mac, tmux, trello,
    visualize, weather, xurl).
  - Plus **4** Custodian skills (add-model-provider, cloud-image-bake, configure-channel, diagnose-gateway).
  - Plus **20** plugin-shipped skills under `extensions/*/skills` (for example browser-automation, discord, slack,
    lobster, canvas, voice-call, feishu-*).
  - Bundled SKILL.md files average 3.2 KB. Their descriptions average 93 chars (median 90, max 170).
  - `coding-agent` is opt-in (`skills.entries.coding-agent.enabled: true`).

## 3. How skills reach the model

**Renderer:** `src/skills/loading/skill-contract.ts` (`formatSkillCatalog`, `formatSkillsForPromptCore`,
`formatSkillsCompactForPrompt`, `compactSkillsPromptForContext`). The budgeter is
`src/skills/loading/skill-prompt-limits.ts`, and the section wrapper is `src/agents/system-prompt-skills.ts`.

Exact injected text in the full format:

```
## Skills
Scan <available_skills> for a matching workflow.
Known name or clear match: use `skills_read` with its exact name; read the complete instructions before task actions and follow them.
Before work involving files, specialized tools, or a reusable workflow, use a listed match or search with `skills_search` for an applicable skill. Read the best match before implementing the workflow yourself.
Search by the task goal and distinctive terms. Simple conversation or a self-contained answer does not need a search. Search covers installed skills; it does not install skills.
Several: most specific. No relevant skill: read none.
Up-front max one. Never invent paths.
External writes: batch safely; no tight loops; honor 429/Retry-After.


The following skills provide specialized instructions for specific tasks.
Read a skill's file at its listed location when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>github</name>
    <description>GitHub CLI for issues, PRs, CI/check logs, comments, reviews, releases, repos, and gh api queries.</description>
    <location>~/…/openclaw/skills/github/SKILL.md</location>
  </skill>
  …
</available_skills>
```

How the section varies:
- **Without** the `skills_read`/`skills_search` tools (for example in 2026.9.x, or where policy denies them), the
  second line becomes ``Clear match: read exact <location> with `read`; obey.`` and the two search lines go away.
- **In Code Mode** it becomes `skills.read("<name>")` / `skills.search(query)` inside `exec`.
- A `<location_note>` is added for node-hosted or remote skills.
- Workspace-hosted files on a remote node use a virtual `workspace-skill://workspace/<name>/SKILL.md` location
  (`src/skills/workspace-skill-read-path.ts`).
- The section is rendered only when the model can actually read skills: a `read` tool, `skills_read`, or a CLI
  backend (`src/agents/system-prompt.ts` ~l.511).
- With no eligible skills and no search tool, the section is omitted.

**Token cost** (the "Token impact" section of `docs/tools/skills.md`, verified against the code):
- Per skill: the fixed XML lines come to exactly 97 chars (`  <skill>`, `<name>`, `<description>`, `<location>`,
  `  </skill>` with indentation and newlines). Add the name, description and location lengths, plus XML-escaping
  growth for `& < > " '`. "At ~4 chars/token, 97 chars ≈ 24 tokens per skill before field lengths."
- Base, counted by me from the strings above:
  - About 370 chars for the catalog preamble and wrapper.
  - About 270 chars for the `## Skills` guidance lines (read-only variant), or about 740 chars with the
    search/read tools.
  - Roughly 160–280 tokens in total.
- Practical example: 20 eligible bundled-style skills come to about 20 × 260 + 1,100, or about 6.3k chars
  (about 1.6k tokens).

**Limits and truncation:**
- `prepareSkillsForPrompt` in `skill-prompt-limits.ts`:
  - Defaults: `DEFAULT_MAX_SKILLS_IN_PROMPT = 150` and `DEFAULT_MAX_SKILLS_PROMPT_CHARS = 18_000`. The global
    override is `skills.limits.*`; the per-agent one is `agents.entries.*.skillsLimits.maxSkillsPromptChars`.
  - Skills are sorted by name (`localeCompare` "en"), except when merged workspace order must be preserved.
  - Sequence:
    1. Try the full format.
    2. If it doesn't fit, binary-search the largest count that fits in compact format **without** descriptions.
    3. Binary-search the description length (4 to `COMPACT_DESCRIPTION_MAX_CHARS = 220`) that fits. Truncated
       descriptions end in `...`.
    4. Prefix a note:
       ``⚠️ Skills truncated: included N of M (compact format, descriptions shortened). Run `openclaw skills check` to audit.``
       or ``⚠️ Skills catalog using compact format (descriptions omitted)…``. In compact mode the loading line
       changes to "…matches its name or description" or "…matches its name".
- `compactSkillsPromptForContext(prompt, contextTokenBudget)`:
  - Applies to embedded runs. The target is `floor(contextTokens/5)` chars, which is about 5% of the window at
    4 chars per token.
  - It binary-searches description length between 64 and 220 chars and only shortens; names, locations and notes
    are an "identity floor".
  - Example: a 32k-token model gets a 6.4k-char target. A 128k model (25.6k chars) is unaffected by default.
- Skills omitted by the budget remain findable through `skills_search` ("Search installed skills" in
  `docs/tools/skills.md`):
  - In-memory lexical index (BM25-like, reusing Tool Search's ranker), with no embeddings and no persistence.
  - Names and descriptions weigh twice as much as body text, and exact names rank first.
  - Body indexing covers at most 1,024 skills, with at most 16 KiB per body and 4 MiB in total, read 4 at a time.
  - Results return name, location and a shortened description (at most 512 chars), 5 by default and 20 at most.
    They include `coverage {bodyIndexed, metadataOnly, truncatedBodies}`.
  - Constants are in `src/agents/installed-skill-catalog.ts`; the tools are in
    `src/agents/tools/installed-skill-tools.ts`.
- The motivation was issue #61740 ("Runtime Skill Discovery"). Maintainers measured a metadata-only baseline that
  found the relevant skill for 40% of positive queries (PR #160524).

**When the body is read:**
- The model reads `SKILL.md` at `<location>` with its `read` tool, or calls `skills_read({name})`. The second
  returns `Skill location: …\nResolve relative resource paths from the directory containing this SKILL.md.\n\n<unchanged body>`.
- Instructions omitted from the prompt directory are refused above 256 KiB, not truncated.
- Since 2026.8.1, prompt-listed skills are "served whole instead of rejecting read windows" (PR #130286): partial
  reads of SKILL.md are not allowed.
- Explicit references (`$name` or a leading `/name`) do **not** inline the body either. They prepend a short prefix
  (`src/skills/discovery/chat-command-invocation.ts`):
  ```
  Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:
  - github
  - release-notes (SKILL.md: /path/…)   ← path added only for model-hidden skills
  
  User request:
  
  <original text>
  ```
  This is capped at 8 skills per message, 512 chars per line and 1,000 chars for the whole prefix.

**Snapshot, caching and hot reload** (`docs/tools/skills.md` "Snapshots and refresh",
`src/skills/runtime/session-snapshot.ts`, `refresh.ts`, `discovery.worker.ts`):
- The eligible list is snapshotted **when a session starts** (`SkillSnapshot`: prompt, skills, skillFilter,
  `version`, `promptFormatVersion = 8`). It is persisted on the session entry and reused until a refresh trigger.
- An in-process cache keeps up to 10 projections.
- One background discovery worker scans all roots. With `skills.load.watch` (default `true`) it polls for passive
  edits about once per minute.
- Install, update, uninstall, edit, a skills-relevant config change, Gateway start or a new eligible node trigger
  an immediate rescan.
- Existing sessions pick up changed file-backed skills on their **next turn**. An unchanged name, source, winner
  and SKILL.md content keep the same snapshot version, with no notifications (2026.9.6 "Refresh Skills when their
  contents change").
- Content hashes were removed from catalogs (PR #126951).
- Prompt cache (`docs/concepts/system-prompt.md`):
  - Stable content (Project Context, workspace instructions) sits **above** the internal cache boundary. Tooling,
    **Skills**, Memory and other catalogs sit **below** it, so a catalog refresh leaves the cached prefix
    byte-identical.
  - On direct Anthropic API-key and OpenAI Responses routes, refreshed sections are appended as instruction
    messages after the current user turn, so earlier prompt and history bytes stay intact.
- Library skills are pinned to exact revisions until an explicit attach or refresh.

**Backends:**
- **Claude CLI** backend (`src/agents/cli-runner/claude-skills-plugin.ts`, `prepare.ts` ~l.1220–1395):
  - Eligible skills are symlinked (or copied) into a temporary Claude Code plugin `openclaw-skills/skills/*`,
    passed as `--plugin-dir`.
  - When that plugin exists, the OpenClaw prompt catalog is set to `""`. Claude Code's native progressive
    disclosure takes over, with no double listing.
- **Codex:** native Codex turns receive the catalog as parent-local model-request instructions, and the OpenClaw
  `skills_*` tools as dynamic tools.
- **Sandboxed runs** read materialized copies of the skills. Remote-exec delivery is limited to 256 skills and
  8 MiB.

## 4. Eligibility, gating, allowlists and env injection

- **Gating:** `src/skills/loading/config.ts#shouldIncludeSkill`. A skill is excluded when any of these hold:
  - `skills.entries.<key>.enabled === false`.
  - Its configured secret failed to resolve at startup.
  - It is bundled and not listed in `skills.allowBundled` (when that list is set).
  - It fails `evaluateRuntimeEligibility` (os, bins, anyBins, env, config).
- Binary probes are batched once per snapshot (`prepareSkillBinaryProbe`).
- A Linux Gateway can treat macOS-only skills as eligible when a connected **macOS node** has the binaries. Offline
  nodes clear their cached matches.
- `requires.bins` is checked on the **host**. A sandbox needs the binary too (`sandbox.docker.setupCommand`).
- The docs separate three states: **inventory** (found), **readiness** (requirements met) and **visibility**
  (exposed to this agent after allowlists and invocation flags). `openclaw skills check [--agent id]` reports all
  three.
- **Per-agent allowlists** (`src/skills/discovery/agent-filter.ts`):
  - `agents.defaults.skills` is the baseline.
  - `agents.entries.<id>.skills` **replaces** it (no merge). `[]` means no skills; omitting it inherits.
  - The allowlist applies to the prompt, slash commands, sandbox sync and snapshots.
  - Sessions can carry a sparse `skillOverrides` overlay (`isSessionSkillEnabled`: an override of `true` wins, an
    override of `false` hides).
  - **Workshop (learned) skills bypass allowlists**; archive one to hide it.
  - The docs warn that allowlists are a visibility filter, not a security boundary, while the agent has `exec`.
- **Per-skill config:** `skills.entries.<key>`, keyed by `name` or `metadata.openclaw.skillKey`:
  - `enabled`.
  - `apiKey`: plaintext or SecretRef `{source, provider, id}`, mapped to `primaryEnv`.
  - `env`: injected only if not already set.
  - `config`: a free-form bag.
- **Env injection** (`src/skills/runtime/env-overrides.ts`):
  - Values are applied to `process.env` for the duration of the **host** agent run, ref-counted across concurrent
    runs, and then restored.
  - Dangerous keys (`isDangerousHostEnvVarName`, `OPENSSL_CONF`…) are blocked.
  - Keys injected this way are stripped from ACP harness child processes (issue #36280).
  - There is no injection into sandboxes; use `sandbox.docker.env`.

## 5. Install, update and discovery

- **OpenClaw CLI** (`docs/cli/skills.md`, `src/cli/skills-cli.ts`, `src/skills/lifecycle/*`):
  - Commands: `openclaw skills search [q]` (no query means ClawHub Trending), `install @owner/slug
    [--version] [--global|--agent id] [--force] [--force-install]`, `install skills-sh:owner/repo/slug`,
    `install git:owner/repo[@ref]`, `install ./path --as name`, `update <ref>|--all [--global]`,
    `verify @owner/slug [--card]`, `list [--eligible] [--json] [--verbose]`, `info <name>` and `check`.
  - Installs default to the workspace `skills/`; `--global` targets `~/.openclaw/skills`.
- **Tracking:** `.clawhub/lock.json` in the workspace and `.clawhub/origin.json` in each installed skill. The old
  `.clawdhub` directory is no longer read.
  - Updates compare install digests and preserve local edits unless `--force`.
  - Only ClawHub installs update; Git and local sources must be reinstalled.
  - The ClawHub CLI also has `pin`/`unpin` to freeze local copies.
- **ClawHub** ([clawhub.ai](https://clawhub.ai), repo `openclaw/clawhub`, MIT):
  - Built on Convex with GitHub OAuth.
  - Search is semantic: OpenAI `text-embedding-3-small` plus Convex vector search.
  - Skills are versioned with semver, tags (`latest`), changelogs, stars, downloads and scan summaries.
  - The standalone `clawhub` CLI handles `login`, `skill publish`, `sync --all`, `uninstall`, `inspect`, `rename`
    and `merge`.
  - Install telemetry is opt-out with `CLAWHUB_DISABLE_TELEMETRY=1`.
- **Agent self-discovery and install:** the bundled `clawhub` skill (`skills/clawhub/SKILL.md`) tells the agent to:
  - search plugins by default and skills only when explicitly asked (`openclaw skills search`);
  - "Install when the user asks. Verify the selected skill first";
  - "Search before claiming that a requested capability is unavailable."
  So the agent searches and installs through its shell. `skills_search` covers installed skills only and never
  queries ClawHub.
- **Dependency installers:**
  - The Gateway picks one installer in the order brew → uv → node manager (`skills.install.nodeManager`: npm,
    pnpm, yarn or bun) → go → download.
  - Download specs can pin a `sha256`, are capped at 256 MiB and extract to `~/.openclaw/tools/<skillKey>`.
  - Go installs go into an OpenClaw-managed bin directory.
  - Private zip uploads (`skills.upload.*`) are off by default (`skills.install.allowUploadedArchives`).

## 6. Security

- **Incidents:**
  - **ClawHavoc** (first malicious skill on 2026-01-27, named on 2026-02-01): Koi Security found 341 malicious
    skills among the 2,857 it audited. 335 of them used fake "prerequisites" to drop the Atomic Stealer (AMOS) on
    macOS and a keylogger on Windows. One account, `hightower6eu`, published more than 300 of them. Antiy CERT
    later counted up to 1,184.
  - On 2026-06-23, **Unit 42** reported 5 skills that passed VirusTotal and ClawScan between February and May:
    - TradingView lures pointing to a rentry paste with a Base64 command;
    - `omnicogg`, an AMOS dropper followed by **22 MB of padding** to exceed scanner size limits;
    - `money-radar`, which injected affiliate links;
    - `letssendit`, a SOL front-running scheme.
    OpenClaw banned the accounts and deleted the skills.
- **Changes since:**
  - 2026-02-07: **VirusTotal** partnership. Each bundle is zipped deterministically with `_meta.json`, hashed with
    SHA-256 and uploaded for Code Insight (Gemini) analysis. "Benign" is auto-approved, "suspicious" gets a
    warning and "malicious" is blocked from download. All active skills are **rescanned daily**.
    ([openclaw.ai/blog/virustotal-partnership](https://openclaw.ai/blog/virustotal-partnership))
  - **ClawScan**: an LLM (Codex) agent combines static analysis, VirusTotal and **NVIDIA SkillSpector**, and since
    about 2026-09 Tencent **A.I.G** 0.2.1, with provenance, metadata and moderation history. It follows the OWASP
    Agentic Skills Top 10 and asks whether name, summary, metadata, requested authority and content are coherent.
    - Statuses: `Pass`, `Review`, `Warn`, `Malicious`, `Pending`, `Error`.
    - Risk levels: `Low`, `Medium`, `High`.
    - `.pyc`, `.pyo` and `.pyd` files are rejected (A.I.G cannot inspect bytecode).
    ([docs.openclaw.ai/clawhub/security-audits](https://docs.openclaw.ai/clawhub/security-audits))
  - 2026-06-01: NVIDIA **Skill Cards** are generated by ClawHub (not self-declared) for every skill: publisher,
    capabilities, scan results and provenance. Shown with `openclaw skills verify --card`.
  - Since July 2026, publishes are held by a prepublication worker until scanned.
  - Other measures: a GitHub account age gate for uploads, reports, moderation holds, auto-warnings at a
    "potential-ban threshold", bans that revoke tokens, and appeals at appeals.openclaw.ai.
- **Client side:**
  - `openclaw skills install/update` checks ClawHub release trust **before downloading**. Malicious or blocked
    releases are refused; `Review` prints the audit and continues. Official publishers and bundled skills bypass
    the check.
  - `verify` returns the `clawhub.skill.verify.v1` envelope, including the full SARIF/JSON scanner reports.
  - `skills-sh:` mirrored skills are labelled "Not scanned by ClawHub".
  - An operator-owned **`security.installPolicy`** exec hook (JSON over stdin/stdout, `allow|warn|block`) runs on
    every skill or plugin install and update path, and fails closed.
  - A local static scanner (`src/skills/security/scanner.ts`) covers JS and TS files with rules for
    dangerous-exec, dynamic-code-execution, crypto-mining, suspicious-network, potential-exfiltration,
    obfuscated-code, env-harvesting, shell-pipe-to-shell, secret-exfiltration, destructive-delete and
    unsafe-permissions. It also detects literal secrets in Workshop writes.
  - Path and symlink containment on all roots.
  - Env and API key injection is host-only and scoped to the run.
  - The docs say: "Treat third-party skills as untrusted code… Prefer sandboxed runs."

## 7. Agent-created skills: Skill Workshop and self-learning

Sources: `docs/tools/skill-workshop.md`, `docs/tools/self-learning.md`, `src/skills/workshop/*`,
`src/agents/skill-workshop-prompt.ts`.

**Where they live:**
- Learned skills are stored per agent in `<state-dir>/agents/<id>/agent/workshop-skills/<name>/`.
- `.archive/<name>/<versionId>/` keeps a full copy before every change, retaining the newest 10 versions.
- A change feed in SQLite keeps 500 entries per agent.

**The `skill_workshop` tool** (in the `coding` tool profile, not available in sandboxed runs):
- Actions: `list`, `view`, `create`, `patch` (exact unique span), `write_file`, `remove_file`, `archive` (with
  `absorbed_into` for merges) and `restore`.
- Every mutating action takes a one-line `reason`.
- Validation:
  - name: 1–63 characters, lowercase letters, digits and hyphens;
  - `description`: 1–1024 bytes;
  - `SKILL.md`: at most `skills.workshop.maxSkillBytes` = 40,000;
  - support files: only in the four subdirectories, 256 KiB each;
  - a critical scanner finding refuses the write.
- Non-blocking advisories from `skill-lint.ts`: description over 160 bytes or opening with "This skill", body over
  250 lines or 12 KB ("move reference only some runs need into references/"), no-op emphasis
  (`IMPORTANT`, "comprehensive"…), three or more Never/Don't lines, update notes or dates.

**System prompt section:** about 600 chars, telling the agent to:
- patch a learned skill that misled it;
- save a procedure after hard multi-step work the user will repeat;
- keep codebase knowledge in AGENTS.md, not in skills;
- edit user-owned skills directly, never through `skill_workshop`.

**Background review** (on by default, `skills.workshop.autonomous.mode: auto`):
- Trigger: after **10 model iterations** in a session, it waits 30 s of idle time.
- Inputs: an excerpt of at most 64 events / 32 KiB.
- Run settings: a minimal prompt with **only** `skill_workshop`, and **no** skill catalog or bootstrap files. The
  context budget is 16,384 tokens, output is capped at 2,048 tokens, reasoning effort is low, it times out after
  2 minutes, and fallbacks are off.
- Scope: at most one change per review.
- Excluded sessions: cron, heartbeat, subagent and Incognito.
- Rate limits pause reviews for 15 minutes, escalating to 30 minutes and then 1 hour.

**Other learning paths:**
- `/learn [request]` runs a foreground turn; `/learn undo <id>` reverts without a model call.
- "Learn from history" (Control UI).
- **Unused-skill cleanup** archives a learned skill after 30 days without a read or view.

**Visibility and history:**
- Changes apply immediately. They show as a 💾 **Learned** row with **Undo** in the Control UI chat; channel
  notices are optional.
- 2026.8.1 had reviewable proposals (apply/reject/quarantine). 2026.10.x replaced them with direct apply plus undo;
  `doctor --fix` migrates `propose` to `off`.

The bundled `skill-creator` skill guides hand-authored skills (contract → invocation → structure → draft →
validate with `scripts/quick_validate.py`).

## 8. UI

**Control UI** (`ui/src/pages/skills/*`, `ui/src/lib/skills-grouping.ts`, strings in
`ui/src/i18n/locales/en-skills-browser.ts`):
- Location: **Plugins → Skills** (one hub with Plugins and Skill Workshop since 2026.8.1).
- Tabs: **All / Ready / Needs Setup / Disabled**.
- Filter box ("Filter installed skills", "{count} shown") and an agent picker.
- Groups: Workspace, Learned, Built-in, Installed, Extra, Other.
- Each card shows an emoji, a status dot (ok/warn/danger/muted, with a tooltip listing missing requirements and
  reasons), source chips, an "eligible/blocked" chip and a "disabled" chip.
- ClawHub search pane ("Search ClawHub skills…"):
  - results show publisher, "Latest: vX", platforms and an **Install** button;
  - the verdict chip reads Clean / Pending / Review / Blocked / Unavailable / "Not scanned by ClawHub";
  - links to a "Full security report".
- Detail dialog:
  - **Overview** and **Skill Card** tabs;
  - "Missing requirements", "Reason";
  - an **Enabled/Disabled** toggle;
  - an **install button** shown only when an installer provides a currently missing binary (label taken from the
    spec);
  - an **API key** field named after `primaryEnv`, with **Save key** and "Get your key:" linking to the homepage;
  - source, the installed ClawHub ref `@owner/slug@version`, and an invalid-link warning.
- Data comes from the `skills.status` Gateway method (`SkillStatusEntry` in `src/skills/discovery/status.types.ts`),
  with these fields: eligible, disabled, blockedByAllowlist, blockedByAgentFilter, platformIncompatible,
  modelVisible, userInvocable, commandVisible, requirements, missing, configChecks, install[], primaryEnv,
  clawhub, skillCard.
- Mutations go through `skills.update` (patches `enabled`, `apiKey`, `env`) and `skills.install`.
- The Gateway emits `skills.changed`.

**Agents → Skills panel** ("Per-agent skill allowlist and workspace skills"):
- Toggles per skill. Disabling one creates a per-agent allowlist.
- Shows whether the allowlist is inherited or custom.
- Learned skills are marked "archive in Workshop to hide".

**Skill Workshop page:**
- Learned skills are sorted by use, with the latest change and **Undo**; skills idle for 2 weeks are flagged.
- History, compare and restore, archive and restore.
- A learning-mode switch and "Learn from history".

**Other apps:**
- **macOS app:** there is no native pane any more; **Dashboard → Skills** embeds the same Control UI
  (`docs/platforms/mac/skills.md`).
- Android has `SkillsSettingsScreen.kt`.
- The chat composer's `$` picker inserts `$skill_name` references.

## 9. Slash commands from skills

Source: `docs/tools/slash-commands.md`, `src/skills/discovery/command-specs.ts`, `chat-command-invocation.ts`,
`src/auto-reply/reply/get-reply-inline-actions.ts`.

- User-invocable skills become `/name`. Names are sanitized to `a-z0-9_`, at most 32 chars, with numeric suffixes
  on collisions; reserved built-ins push the skill to `/dashboard_2`, for example.
- `/skill <name> [input]` always works.
- Native registration on Discord and Telegram is controlled by `commands.nativeSkills: "auto"` (off for Slack).
- Default dispatch: the command becomes a model turn with the "explicitly referenced skills… read SKILL.md" prefix.
- With `command-dispatch: tool` the skill's tool runs directly: no model call, no tokens, reply `✅ Done.` or the
  tool's text.
- Claude-bundle commands with a `promptTemplate` expand `$ARGUMENTS`.
- In WebChat, choosing a skill from slash completion inserts `$name` into the draft instead of sending.
- Unauthorized senders are ignored.

## 10. Other efficiency techniques

1. **Catalog only, bodies on demand.** Progressive disclosure, with an "Up-front max one" rule and "No relevant
   skill: read none."
2. **Gating before the prompt.** Unready, disabled, OS-incompatible and allowlist-hidden skills cost zero tokens.
   `allowBundled` trims the 49 bundled skills.
3. **A hard char budget with graceful degradation.** Identities come first, then binary-searched description
   lengths, plus a context-window-proportional cap (`ctx/5`) for small models.
4. **Search and read tools** let large catalogs stay mostly out of the prompt. Prompt-listed identities still let
   the model skip searching for a clear match.
5. **Short, stable prompt text.** Guidance is telegraphic ("Several: most specific."). `~/` replaces the home path.
   No content hashes or versions appear in the catalog. Descriptions are whitespace-normalized.
6. **Cache-friendly placement.** The Skills section sits below the prompt-cache boundary. Refreshes append
   instructions rather than rewriting earlier bytes, and unchanged content keeps the same snapshot version.
7. **Session snapshots** avoid rescanning per turn. One shared discovery worker reads each root once per pass.
   Binary probes are batched.
8. **Explicit references are tiny**: at most 1,000 chars of prefix and no inlined body.
9. **Tool-dispatch commands** skip the model entirely.
10. **Native-harness delegation.** Claude Code gets a plugin dir and an empty OpenClaw catalog, so it is never
    listed twice. Codex gets catalog instructions plus dynamic tools.
11. **Sub-agents** use `promptMode: "minimal"`, which drops memory, aliases, messaging and other sections. The
    Skills section is kept when supplied, and sub-agents inherit the parent's library selections
    (`src/agents/subagents/spawn/subagent-spawn-session-patch.ts`). OpenClaw does **not** strip skills from
    sub-agents. Background Workshop reviews **do** run without the catalog.
12. **Authoring pressure on size.** Descriptions aim for 160 bytes or less (a hard cap of 1024). The Workshop caps
    SKILL.md at 40 KB and advises at 250 lines or 12 KB, telling authors to move branch-only detail into
    `references/`. Learned skills nobody uses are archived after 30 days, so the catalog doesn't grow without bound.
13. **Tool Search** applies the same approach to tool schemas (`docs/tools/tool-search.md`): a bounded directory
    that scales with the context window, with descriptions shortened before names.

## Patterns worth copying (for a Whombat skills design)

- Render a name/description/location catalog with a char budget and a degrade path (drop descriptions before
  dropping skills), plus a `skills_search`/`skills_read` pair for overflow.
- Gate on declared requirements (bins, env, config, os) at snapshot time. Report inventory, readiness and
  visibility separately in the UI ("Needs setup" with a one-click install or API key field).
- Snapshot per session and refresh on content change only. Place the catalog after cache-stable prompt content.
- For Claude CLI agents, use Claude Code's native skills via `--plugin-dir` rather than a second catalog.
- Keep learned skills separate from user-owned ones, with automatic versioning, undo and unused-skill expiry. Run
  the background learner in a tiny, catalog-free context.
- Treat registry skills as untrusted: pre-download trust checks, an operator install-policy hook, host-only secret
  injection, and labelling of unscanned sources.

## Sources

Code and docs (clone at `14a5324`, 2026-10-18):
- `docs/tools/skills.md`, `docs/tools/skills-config.md`, `docs/tools/creating-skills.md`, `docs/tools/skill-workshop.md`,
  `docs/tools/self-learning.md`, `docs/tools/custodian-skills.md`, `docs/tools/slash-commands.md`, `docs/tools/tool-search.md`,
  `docs/concepts/system-prompt.md`, `docs/cli/skills.md`, `docs/platforms/mac/skills.md`, `docs/releases/2026.8.1/skills.md`
- `src/skills/loading/skill-contract.ts`, `skill-prompt-limits.ts`, `skill-prompt-catalog.ts`, `workspace-skill-prompt.ts`,
  `frontmatter.ts`, `config.ts`, `skill-paths.ts`, `skill-root-discovery.ts`; `src/skills/types.ts`;
  `src/skills/discovery/agent-filter.ts`, `chat-command-invocation.ts`, `status.types.ts`; `src/skills/runtime/env-overrides.ts`,
  `session-snapshot.ts`, `run-usage.ts`; `src/skills/security/scanner.ts`; `src/skills/workshop/skill-lint.ts`
- `src/agents/system-prompt.ts`, `system-prompt-skills.ts`, `skill-workshop-prompt.ts`, `skill-instruction-result.ts`,
  `installed-skill-catalog.ts`, `tools/installed-skill-tools.ts`, `tool-catalog.ts`, `cli-runner/claude-skills-plugin.ts`,
  `cli-runner/prepare.ts`, `embedded-agent-runner/skill-runtime.ts`
- `src/auto-reply/reply/get-reply-inline-actions.ts`; `src/config/zod-schema.root-shape.ts`
- `ui/src/pages/skills/view.tsx`, `skill-status.tsx`, `ui/src/lib/skills-grouping.ts`, `ui/src/i18n/locales/en-skills-browser.ts`, `en.ts`
- `skills/clawhub/SKILL.md`, `skills/skill-creator/SKILL.md`, `skills/github/SKILL.md`, `skills/weather/SKILL.md`
- `CHANGELOG/2026.9.6.md`, `2026.9.4.md`, `2026.9.8.md`

Web:
- [docs.openclaw.ai/tools/skills](https://docs.openclaw.ai/tools/skills), [Skill Workshop](https://docs.openclaw.ai/tools/skill-workshop), [Skills CLI](https://docs.openclaw.ai/cli/skills), [Creating skills](https://docs.openclaw.ai/tools/creating-skills)
- [docs.openclaw.ai/clawhub](https://docs.openclaw.ai/clawhub), [ClawHub security audits](https://docs.openclaw.ai/clawhub/security-audits), [ClawHub moderation](https://docs.openclaw.ai/clawhub/moderation), [ClawHub security](https://docs.openclaw.ai/clawhub/security)
- [github.com/openclaw/clawhub](https://github.com/openclaw/clawhub)
- PRs: [#158090](https://github.com/openclaw/openclaw/pull/158090), [#158091](https://github.com/openclaw/openclaw/pull/158091), [#160524](https://github.com/openclaw/openclaw/pull/160524), [#165173](https://github.com/openclaw/openclaw/pull/165173), issue [#61740](https://github.com/openclaw/openclaw/issues/61740)
- [OpenClaw blog: VirusTotal partnership (2026-02-07)](https://openclaw.ai/blog/virustotal-partnership), [The Hacker News](https://thehackernews.com/2026/02/openclaw-integrates-virustotal-scanning.html)
- [OpenClaw blog: NVIDIA skill security (2026-06-01)](https://openclaw.ai/blog/openclaw-nvidia-skill-security), [IT Brief](https://itbrief.co.nz/story/openclaw-adds-nvidia-skillspector-to-clawhub-checks), [openclaw.ai/security](https://openclaw.ai/security)
- [Unit 42: OpenClaw skill marketplace supply-chain risk (2026-06-23)](https://unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk/)
- [eSecurityPlanet](https://www.esecurityplanet.com/threats/hundreds-of-malicious-skills-found-in-openclaws-clawhub/), [The Decoder](https://the-decoder.com/malicious-skills-turn-ai-agent-openclaw-into-a-malware-delivery-system/), [Cyberpress (Antiy 1,184)](https://cyberpress.org/clawhavoc-poisons-openclaws-clawhub-with-1184-malicious-skills/)
