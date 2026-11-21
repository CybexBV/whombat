# Whombat agent capabilities: browser, skills, roles, spend — implementation orchestrator prompt

Give this entire file to the lead coding agent. It is an implementation assignment, not a study. The research behind
it is in `~/.cache/wb-tmp/research/2026-09-27-agent-platforms/whombat-vs-hermes-buzz.md` (sections 3 to 5); the
decisions below were taken with John on 2026-09-28 and are settled.

---

You are the lead architect and implementation orchestrator for Whombat. Use specialist sub-agents where work is
parallel; own the design, the integration, the commits and the completion yourself.

**Do the implementation. Do not stop after a plan, a spec, a contracts release or a list of TODOs.** Inspect the
real code, decide the open details, build all four tracks across the repositories, test them, fix what you find,
ship to the dev instance, and report.

## 1. Goal

Four capabilities that make agents useful beyond code, delivered as one workstream, one contracts release and one
appliance candidate:

1. **A headless web browser** agents use through Whombat, with logins kept in the Vault.
2. **A skills library**: skills switched per agent, linked to roles, agents proposing their own skills, a shipped
   catalog ported from Hermes Agent and Anthropic's skills, and a scratch workspace so non-coding agents can run a
   skill's scripts.
3. **Six new agent roles**: Lead, Tester, Product, Security, Analyst, Writer, with avatars, default keys and role packs.
4. **A Spend view** over the usage Whombat already stores.

Delegation (handoffs, `docs/decisions/archive/delegation.md` DG-01…DG-48) shipped on 2026-09-27; its teammates block already
lists each agent's skills and readiness, so the skills library and the new roles feed straight into it.

## 2. What exists (rely on it, do not rediscover it)

Runtime (`~/Code/Whombat`, main at 9e1c495 or newer; migrations end at `0047_delegation`, yours is `0048_capabilities`):

- Outbound rules: `apps/server/src/lib/outbound.ts` (public addresses only, DNS pinned, no redirects, caps); the Vault's
  per-call destination rule and admin-listed home networks: `apps/server/src/vault/{net,pool,use,networks}.ts`,
  `docs/decisions/vault.md` VT-10…VT-13, VT-22 (requester rule), VT-D22 (secret echo → withhold + take the key back).
  Entry kinds are `mcp | http | secret` (`packages/core/src/vault/schemas.ts` in contracts).
- Keys: `web.browse` = "Browse the web", read-only by definition, `agentMaxTier: can`, off by default, only the
  researcher's default (`docs/decisions/agent-search.md` ASR-02); it is what opens a guarded sandbox to the network.
- Tool selection per turn: `apps/runner/src/prompt.ts` (`sandboxFor`: `read-only` unless the turn has a writable
  checkout), `packages/agent-runtime/src/claude/index.ts` (built-in tools by sandbox and network; read-only guarded
  turns get Read, Grep, Glob and no shell), `packages/agent-runtime/src/codex/index.ts` (permission profile).
- MCP tools and per-agent listing: `apps/server/src/mcp/tools.ts`, `apps/server/src/mcp/server.ts` (`mcpToolList`),
  rate limits `apps/server/src/mcp/rate-limit.ts`. Activity kinds already include `web` and `delegate`.
- Packs and skills: `apps/server/src/packs/` (store, archive, tools, `PackMcpPool`), `docs/decisions/archive/bp-packs.md`
  (BP-D01 manifest, BP-D02 validation, BP-D12 per-turn materialization, BP-D20 front matter = name + description only),
  `apps/runner/src/skills.ts`, `packages/agent-runtime/src/persona/packs.ts`, shipped packs `packs/ui-review`,
  `packs/cybex-review` (with `SOURCES.md`). Managed appliances refuse pack MCP servers that run as processes (MR-44).
- Memory proposals as the approval pattern to mirror: `apps/server/src/memory/` (`propose_memory`, `decide_memory`,
  `docs/decisions/bp-memory.md` BP-B04…B08).
- Usage: `dispatches.usage` (tokens, cost when reported) and `agent_sessions.last_*`; handoff budgets and their sums in
  `apps/server/src/read/work.ts` and `docs/decisions/archive/delegation.md`; the Memory pane shows the last turn only.
- Guides in the personal assistant's DM: `apps/server/src/guides/{flows,copy}.ts`, `docs/decisions/assistant-guides.md`
  (AG-01…34; topics are an open set).
- Feedback assessor configuration: `docs/decisions/feedback.md` FB-18 (a guarded Claude or Codex agent in the channel).

Contracts (`~/Code/whombat-contracts`, 0.19.0, `docs/decisions/contracts.md` up to CT-118): roles and copy in
`packages/core/src/domain/roles.ts` (`AGENT_ROLES`, `HIREABLE_ROLES`, `ROLE_LABELS`, `ROLE_JOBS`, `ROLE_DUTIES`,
`ROLE_DEFAULT_NAMES`, `ROLE_DM_SUGGESTIONS`), default keys in `packages/core/src/keys/grants.ts` (`ROLE_DEFAULT_KEYS`,
`hireGrants`), catalog `packages/core/src/keys/catalog.ts` (`KEY_IDS` order, `implies`), pack manifest
`packages/core/src/packs/manifest.ts`, personal-agent names `packages/core/src/domain/personal.ts`, MCP tool schemas
`packages/core/src/contracts/mcp.ts`, runner context `packages/core/src/contracts/runner.ts` (teammates carry `skills`
≤ 12 and `readyCode`). Releases are vendored tarballs (`docs/publishing.md`).

App (`~/Code/whombat-app`, 0.10.0, `docs/decisions/app-managed.md` up to AP-193): avatars
`packages/avatars/src/roles.ts` (per-role palette, fur, expression and one accessory from `ACCESSORIES`; twelve
accessories for twelve roles; the family reference is `docs/design-handoff/design/WhombatAvatar.dc.html` and
`Whombat Avatar System.dc.html`), role colours `packages/tokens/src/roles.ts`, hire modal
`apps/web/src/features/agents/HireAgentModal.tsx`, Configure, onboarding step 3 (`features/onboarding`), Settings tabs
(`features/settings`, Packs tab `features/packs`, Vault tab `features/vault`), Android `apps/mobile/src/screens/`.

Appliance (`~/Code/whombat-appliance`, main at 676ed0f or newer; `docs/decisions/integration.md` up to IN-86,
`nixos.md` up to NX-89): the kiosk console already ships Chromium (`nix/modules/kiosk.nix`, `pkgs.chromium`, user
`whombat-kiosk`, enterprise policies); the sandbox toolchain (`nix/modules/sandbox.nix`, `whombat.sandbox.toolchain`:
bash, coreutils, git, make, nodejs_22, pnpm, python3, no Python libraries); the egress policy and the Vault wall
(`nix/modules/{network,vault-wall}.nix`, `WHOMBAT_VAULT_NETWORKS_FILE`); harness scenarios `harness/scenarios/`
(letters up to `q-delegation`; yours are `r-browser` and `s-skills-roles`); candidates `manifest/candidates/`
(0.17.1 latest); the dev instance runbook `docs/runbooks/dev-instance.md` (follow the newest "Putting the instance
on …" section as the pattern; the dev stack runs live agents).

Settled decisions that bind you (do not reopen): the keys engine and people-only keys; BP-06 (no private content in
signed events); BP-07 (retrieved data is data); BP-C31/C35 (an agent reads only its audience); BP-D06 (a pack approves
nothing; owners attach); BP-D20 (skill front matter is name and description only); PA-01…10 (personal agents: only
the owner wakes, configures and attaches packs; personal keys are personal-agent-only, so team agents never reach a
person's Google files); VT-01…VT-23 and VT-D22; ASR-02 (the web key is the exfiltration path when combined with
read access, so it stays off by default); DG-01…48; MR-44; the design rule B-05 (unmocked screens follow the nearest
mocked pattern, tokens only). Decision prefixes for this work: `BT-` (browser), `SL-` (skills), `AR-` (roles), `SP-`
(spend); none is in use anywhere.

## 3. Track 1: the browser (BT)

- BT-01 **A browser host process, not the server and not the agent sandbox.** Self-hosted: a child process of the
  server (`apps/server/src/browser/`), Playwright with headless Chromium (`WHOMBAT_BROWSER_BIN` may point at a host
  Chromium; otherwise Playwright's download under `WHOMBAT_HOME/browser/`), talking to the server over a unix socket
  under `WHOMBAT_HOME/run/`. Appliance: a `whombat-browser` systemd unit under its own uid, the kiosk's `pkgs.chromium`
  headless, socket `/run/whombat-browser/host.sock` (0660, server user and the browser's group), its own cgroup with
  memory and pid limits, restarted on crash. A crashed page never takes the server down; the server refuses browser
  tools with a plain reason when the host is unavailable.
- BT-02 **Key**: `browser.use`, label "Use a web browser", description "Open pages, click, type and take
  screenshots in a browser Whombat runs.", group research, `agentMaxTier: can`, off by default, `implies: ['web.browse']`.
  A row after "Browse the web" in the hire modal and Configure. Default `can` only for the Tester role (AR-05).
- BT-03 **Tools**, each an MCP tool behind `/mcp` with `requiredKey: 'browser.use'`, each a pipeline command with a
  hidden signed event carrying the page's origin only (never path, query, content): `browser_open {url}`,
  `browser_snapshot {}` (an accessibility tree with element references like `@e12`, ≤ 64 KB, truncated with a note),
  `browser_click {ref}`, `browser_type {ref, text, submit?}`, `browser_press {key}`, `browser_select {ref, value}`,
  `browser_scroll {ref? | direction}`, `browser_wait {text? | ms ≤ 10 000}`, `browser_screenshot {attach?}`,
  `browser_back {}`, `browser_close {}`. Activity rows are kind `web` with the URL stripped of query and fragment.
- BT-04 **Sessions**: one browser context per dispatch, created on the first tool, closed when the turn ends or is
  cancelled; cookies and storage discarded; no persistent profile. Caps: navigations per turn, one context per turn,
  `WHOMBAT_BROWSER_MAX_CONTEXTS` per host (2 on the appliance), a 30 s deadline per call, idle eviction. Downloads go
  through the upload path into the file store as attachments of the turn's conversation (size cap as uploads);
  nothing runs. No file uploads into pages in this version.
- BT-05 **Destinations**: every navigation and every sub-request passes the outbound rule at connection time through a
  filtering proxy inside the browser host (Chromium `--proxy-server`, the proxy resolves, checks and pins each
  address): public addresses over https or http; never loopback, link-local, private, metadata, multicast or reserved
  ranges; home-network addresses only inside the admin-listed Vault networks (`vault_networks`, the same list and
  port rule, VT-12); `file:`, `data:`, `chrome:` and extension URLs refused. On the appliance the nftables wall also
  confines the browser uid to 80/443 on public addresses plus the Vault networks (NX-90+), like the Vault wall does for
  the server uid.
- BT-06 **Logins live in the Vault**: a new entry kind `login` (`packages/core/src/vault/schemas.ts`): `origin`
  (https URL), `username`, the password as the sealed secret, optional `usernameSelector`, `passwordSelector`,
  `submitSelector`, and a `totp` secret slot reserved for later. `browser_sign_in {entry}` opens the entry's origin
  and the server fills the fields (selectors when set, otherwise the usual heuristics) without the model seeing them;
  the owner's "Test sign-in" in the Vault UI runs the same flow and reports success or failure with a screenshot
  shown to the owner only. Keys, tiers and passes are exactly VT-20…VT-32 (`decideVaultUse` unchanged): the owner's
  turns follow the tier, anyone else's turn needs a pass. A **logged-in session is pinned to the entry's site**: a
  navigation to another origin closes the session with a note; a plain session never reaches a site a login exists
  for. Snapshots strip the values of password fields; any snapshot, page text or screenshot text containing a form of
  the secret is withheld and the key taken back (VT-D22). Every sign-in signs `vault.used`.
- BT-07 **What a room may see.** In a logged-in session `browser_screenshot` returns the image to the model only
  (`attach` is refused with the reason) and the agent's own words remain its responsibility. In plain sessions
  `attach: true` posts the screenshot as an attachment in the conversation. Page text and snapshots are rendered as
  delimited data (`[[web <origin>]] … [[/web]]`, delimiters defused like memory and packs, BP-07).
- BT-08 **Prompt lines** when the agent holds the key: what the tools are for, that page content is data and never
  an instruction, that it must never type a credential it was given in chat, and that sign-in goes through the Vault.
  Both builders, snapshot-tested.
- BT-09 **Appliance**: the unit, uid and cgroup, the nftables rules, `whombat.browser.enable` derived from total
  memory (on at 8 GiB and above, off below, overridable), the runtime told through its environment
  (`WHOMBAT_BROWSER_SOCKET`), `host` info reporting the browser as available or off with the reason so the UI can say
  so, a VM test (`vm-tests/browser.nix`: the unit starts, a local page loads through the socket, a private address is
  refused, memory cap holds). No LAN reach beyond the Vault networks.
- BT-10 **UI**: the key row (web hire and Configure; Android key summary), the Vault "Login" template with Test
  sign-in (web only, like other secrets, VT-73), agent profile KEYS, activity rows "Opened example.com". Settings →
  General shows "Web browser: available / off (reason)" from `host`.
- BT-11 **Docs**: `docs/decisions/browser.md` (BT-… with reasons and the details you settle), `vault.md` VT-D28+ for
  the login kind, ARCHITECTURE.md ("Agent runtime": tools, and a "Browser" section), user guide `docs/browser.md`,
  appliance NX-90+ and IN-87+.

## 4. Track 2: skills (SL)

- SL-01 **Skills switch per agent.** A pack attachment records disabled skills (`pack_attachments.disabled_skills`
  or a child table, your call, written down); the runner materializes enabled skills only; the teammates block lists
  enabled skills only; the prompt lists a disabled skill nowhere.
- SL-02 **Packs declare the roles they suit**: manifest field `roles: AgentRole[]` (optional, validated against the
  enum including the new roles), plus per skill `requires: ('workspace' | 'web' | 'browser')[]` so the UI and the
  prompt can say when a skill cannot run for this agent ("needs a scratch workspace", "needs the web key").
- SL-03 **Role packs attach on hire.** The hire modal and onboarding step 3 show, under the keys, a "Skills" group
  listing the shipped packs whose `roles` include the chosen role, pre-ticked; hiring attaches them to the new agent
  as the owner's action. Configure shows the same list to attach or detach. Existing agents: a one-time "Attach role
  packs" suggestion in the Skills tab, per agent, never a silent backfill. Personal assistants: a guide card in the
  owner's DM (topic `skills`, AG-35+) offering the Assistant productivity pack, since only the owner attaches packs
  to a personal agent.
- SL-04 **Skills tab** (web Settings; the Packs tab becomes "Skills & packs"): Shipped (catalog grouped by role, each
  pack's skills with one-line descriptions and their `requires` labels, "Attach to …" per agent), Installed (per pack
  and attachment: skills with on/off switches), Proposed (agent-authored proposals awaiting approval, SL-06), Import
  (the existing upload). The agent profile's PACKS section shows skills with their switches. Android: the existing
  Packs screen gains per-skill switches (44 dp), nothing else.
- SL-05 **Scratch workspace.** Key `workspace.scratch`, label "Run tools in a scratch workspace", description "Run
  scripts and make files in a private, throwaway folder without a repository.", group code, `agentMaxTier: can`. A
  guarded chat turn of an agent holding it gets a per-turn writable directory under the runner's private scratch
  space with the `workspace-write` sandbox and the shell and file tools (Claude and Codex), no repository, no git
  credentials, network still only with the web key, the directory removed when the turn ends; the managed sandbox
  does the same. `sandboxFor` gains this branch; TurnAccess reports it; no run object is involved. Files the agent
  wants to share go through `upload_file` (and the prompt says so). Default `can` for Analyst, Writer, Designer,
  Finance, Tester and Product (AR-05).
- SL-06 **Agents propose skills.** Each agent gets an own pack (`own-<handle>`, publisher the agent) whose versions
  exist only through approvals. Tool `propose_skill {name, description, body, files? ≤ 8 (≤ 64 KB total), reason,
  supersedes?}` (key `skills.propose`, `agentMaxTier: can`, off by default, switched in the Skills tab like
  `memory.propose`): the proposal is scanned (SL-08), front matter sanitized (BP-D20), stored as a pending version and
  posted as a card in the conversation it came from; whoever may configure the agent approves or rejects (a
  personal agent: its owner); approval creates the immutable version and pins it. A usage ledger (`skill_uses`: agent,
  pack, skill, dispatch, at) fed from the runner's activity (the Skill tool calls) shows "Used 12 times, last
  Tuesday" in the tab. `created_by: agent` is visible on the version. Retiring stale skills is not in this version.
- SL-07 **"Learn this"**: a button on an agent's profile and in the Skills tab that posts, in the agent's DM or the
  current room, a request to build a skill from a URL, an attached document or the current thread; the agent reads
  (web key, attachments, `read_conversation`) and answers with `propose_skill`. Prompt guidance for the shape of a
  good skill (when to use, steps, pitfalls, verification) in `persona/packs.ts`.
- SL-08 **Scanner**: extend `validatePack` (core, pure, unit-tested) with categories and a verdict `safe | caution |
  dangerous`: exfiltration (network calls that carry environment or secrets, encoded payloads), instruction
  injection ("ignore previous instructions", role-override phrases, delimiter forgery), destructive commands
  (recursive deletes, disk tools, force pushes, migrations drops), persistence (cron, systemd, shell rc, git hooks).
  `dangerous` is refused; `caution` is shown on the pack and the proposal card. Applies to uploads, bundled packs and
  proposals alike.
- SL-09 **Slash commands**: typing `/<skill>` in the composer of a room where the mentioned (or DM) agent holds that
  skill sends the message with `skill: <name>`; the dispatch context carries it and the prompt adds "The person asked
  you to use the skill <name> for this." Web composer autocomplete; Android renders the chip and sends it if cheap,
  otherwise shows the chip only.
- SL-10 **Shipped packs** (content work, one sub-agent, MIT and Apache attributions in each `SOURCES.md` with origin
  URL and commit): `developer-craft` (systematic debugging, test-driven development, requesting code review with the
  reviewer sub-agent rewritten as a handoff, simplify code rewritten to handoffs, spike, grill-me, code wiki,
  REST/GraphQL debugging), `researcher-craft` (grounded citations rewritten to Whombat's search receipts, competitor
  monitoring, RSS reading, arXiv), `assistant-productivity` (inbox triage rewritten to `mail_*` tools, meeting and
  document action items, weekly review), `documents` (docx, xlsx, pdf, pptx: take Anthropic's versions from
  github.com/anthropics/skills when their licence permits, else the Hermes copies), `finance` (three-statement, DCF,
  comps, LBO, merger, excel author), `design` (sketch, design systems, design tokens file, architecture and concept
  diagrams delivered as HTML/SVG uploads), `lead-craft` (one-three-one briefs, decision questionnaire, plan briefs),
  `tester-craft` (dogfood, adversarial UX test, test-driven development), `product-craft` (document and meeting action
  items, release notes), `security-craft` (the security part of requesting code review, dependency audit, supply-chain
  forensics; nothing offensive), `writer-craft` (code wiki, humanizer trimmed, meeting notes, docx). Strip every
  front-matter key but name and description, rewrite Hermes tool names to neutral wording, mark scripts with
  `requires: ['workspace']`, keep each pack inside the pack limits, and never port the jailbreak or browser-only
  skills except `dogfood` (which requires `browser`).
- SL-11 **Appliance toolchain**: add python-docx, openpyxl, python-pptx and pypdf (and Pillow if a shipped skill
  needs it) to `whombat.sandbox.toolchain` (NX-9x), note the closure growth in the ledger; `whombat doctor` on
  self-hosted installs warns when a shipped skill's library is missing.
- SL-12 **Docs**: `docs/decisions/skills-library.md` (SL-…), `docs/packs.md` updated, user guide `docs/skills.md`,
  `bp-packs.md` cross-references, ARCHITECTURE.md ("Capability packs" → skills), contracts and app decision entries.

## 5. Track 3: roles (AR)

- AR-01 **Six roles** appended to `AGENT_ROLES` and `HIREABLE_ROLES`: `lead`, `tester`, `product`, `security`,
  `analyst`, `writer`. Labels Lead, Tester, Product, Security, Analyst, Writer. Default names Compass, Pepper, Maple,
  Bolt, Tally, Quill (verified free today; re-check against `PERSONAL_AGENT_NAMES` and crew names at build).
  The role is plain text (`principals.agent_role`), so roles need no migration.
- AR-02 **Copy** (`ROLE_JOBS`, `ROLE_DUTIES` three lines, `ROLE_DM_SUGGESTIONS` three each), in the product's voice:
  Lead "Plans work, hands it to the right agent or person, tracks it and reports back; never builds." Tester "Tries
  the product like a user, writes test plans, runs regressions and keeps the evidence before a step counts as
  done." Product "Turns feedback reports and threads into specs and priorities, grooms plans and writes release
  notes." Security "Reviews pull requests for security, audits dependencies and threat-models features; defensive
  only." Analyst "Works with sheets, CSV files, attachments and repository data to build reports and charts." Writer
  "Owns docs, changelogs, code wikis and meeting notes."
- AR-03 **Avatars**: extend `packages/avatars` with a palette, fur, expression and accessory per role in the family's
  style; add up to six new accessories to `ACCESSORIES` (for example compass, magnifier, shield, bar chart, quill, a
  bug net) drawn like the existing ones, else reuse accessories with distinct palettes. Role colours in
  `packages/tokens/src/roles.ts` with contrast checked in both themes. **Checkpoint**: as soon as the six avatars
  render, post a screenshot of the roster and the hire modal in both themes (bust and head crops, all three
  directions) to John and continue with everything else; merge the roles track only after his answer, changing what
  he asks.
- AR-04 **Prompt guidance per role** (`ROLE_GUIDANCE`, optional short lines rendered after the job in both builders):
  Lead: hand out work with `delegate`, track it, report progress to the person, never edit code or systems. Tester:
  evidence before "done", use the browser, report reproductions step by step. Security: defensive only, name the risk
  and the fix. Product: cite the feedback report or thread you draw from.
- AR-05 **Default keys** (`ROLE_DEFAULT_KEYS`): Lead: tasks.create, channels.read, messages.search, canvas.write, no
  branch keys. Tester: tests.run, repos.read, pr.comment, browser.use, workspace.scratch. Product: channels.read,
  messages.search, tasks.create, canvas.write, workspace.scratch. Security: repos.read_all, pr.comment,
  pr.request_changes, tests.run. Analyst: repos.read, workspace.scratch. Writer: repos.read, canvas.write,
  workspace.scratch. Designer and Finance gain workspace.scratch in their defaults too (existing agents unchanged).
- AR-06 **Role packs** (SL-02 `roles`): lead-craft → lead; tester-craft → tester; product-craft → product;
  security-craft → security; documents and finance → analyst and finance; writer-craft and documents → writer;
  developer-craft → developer and architect; researcher-craft → researcher; design → designer;
  assistant-productivity → assistant (via the guide card).
- AR-07 **Surfaces**: hire modal and onboarding picker list the new roles after the existing ones (the mock's three
  pre-picked roles stay); Configure; the roster; Android agent screens (labels, colours, avatars); fixtures' role
  tables (the mock world hires nobody new). Feedback integration settings suggest a Product agent as the assessor
  when one exists and none is set.
- AR-08 **Docs**: `docs/decisions/archive/agent-roles.md` (AR-…), the avatar note in the app's decisions, contracts entries.

## 6. Track 4: spend (SP)

- SP-01 **Read model** `spend.overview` per burrow: by agent and by requesting person, for today, 7 days and 30 days:
  turns, input and output tokens, cost where the provider reported it (labelled an estimate; providers without cost
  show tokens only), plus handoff and plan budgets used (from `read/work.ts`). Owners see everything; a member sees
  their own agents and turns. Informational only: no billing, no limits here (the terms forbid intermediating usage).
- SP-02 **UI**: Settings → Spend tab (owners), a one-line summary on the agent profile ("This week: 1.2M tokens ·
  about $3.40"), Android agent screen line only. No realtime frames; refetch on open.
- SP-03 **Docs**: `docs/decisions/spend.md` (SP-…).

## 7. Repositories, versions, numbering

| Repo | Branch | Version / ids |
|---|---|---|
| whombat-contracts | `capabilities` | 0.20.0, tag `contracts-v0.20.0`, CT-119+; `pnpm release`; vendor into Whombat and whombat-app |
| Whombat (runtime) | `capabilities` | migration `0048_capabilities`; decisions `browser.md`, `skills-library.md`, `agent-roles.md`, `spend.md`; ledger `docs/implementation/agent-capabilities/` |
| whombat-app | `capabilities` | 0.11.0, tag `app-v0.11.0`, AP-194+; `release:dist`; vendor into Whombat |
| the appliance | `capabilities` | scenarios `r-browser`, `s-skills-roles`; candidate `manifest/candidates/0.18.0.json`; IN-87+, NX-90+ |

Use worktrees under `~/Code/.wt/<repo>-capabilities`. One writer at a time for contracts, lockfiles and manifests.
Other people and agents work in these checkouts: never reset shared containers (`docker compose down -v` is
forbidden), use free ports and throwaway databases, run `pnpm check` with `TMPDIR=~/.cache/wb-tmp`. Contracts main
may move from other sessions; rebase before releasing.

## 8. Method and order

0. Read `CLAUDE.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `docs/decisions/{bp-packs,bp-memory,vault,delegation,
   agent-search,connectors,assistant-guides,feedback,runner-selfhost,managed-sandbox}.md` and the files in section 2.
   Write the four decision files first with the requirements above as decisions and the details you settle. Start
   the ledger (`docs/implementation/agent-capabilities/{plan,ledger,verification}.md`) and keep it current so the work
   survives context limits.
1. Contracts 0.20.0 in one release: the `login` Vault kind, the two keys, the six roles and their copy and defaults,
   the manifest fields, the browser and skills MCP tools, the proposal contracts, `spend.overview`, fixtures for the
   mock world, conformance vectors where Go bindings exist; release, tag, vendor.
2. In parallel on the vendored 0.20.0: track 1 (runtime browser host and tools, Vault login, appliance unit and wall),
   track 2 (runtime skills switches, scratch workspace, proposals, scanner, slash commands; app Skills tab and hire
   changes; the content sub-agent porting the packs; appliance toolchain), track 3 (app avatars and colours with the
   checkpoint, runtime role guidance and defaults), track 4 (runtime read model, app tab). The prompt builders and
   `mcpToolList` are shared: land changes there in small commits and rebase often.
3. Candidate 0.18.0: pin the merged commits, build, validate (gates, every scenario, demo), including the VM test for
   the browser unit.
4. Independent review, two lenses. Security: SSRF and DNS rebinding through the browser, exfiltration from logged-in
   sessions, the Vault fill path, prompt injection through pages and through proposed skills, the scanner's coverage,
   the scratch workspace's confinement, personal agents, signed-event content, spend visibility per member. Product:
   copy, the six avatars, the hire flow with skills, the Skills tab, Android screens. Fix every confirmed finding and
   rerun the affected tests.
5. Ship (section 10).

Sub-agents get owned files, inputs, outputs, tests and a completion criterion; they do not merge each other's work
or stop shared services. More than three concurrent agents is acceptable; use judgment about cost. Report progress
to John in percentages at each phase boundary, and post the avatar screenshots as early as they exist. A sub-agent's
success report never replaces an integrated run.

## 9. Verification (all must pass before shipping)

- Core unit tests: the scanner on every category with true and false positives, `requires` and `roles` validation,
  the login kind's schema and destination rules, `decideVaultUse` unchanged, the six roles in every role table,
  default keys, the spend arithmetic, snapshot tests of both prompt builders (browser lines, role guidance, skill
  hints, scratch workspace lines).
- Server integration tests (real Postgres): browser tools refuse without the key; a private, loopback, link-local and
  metadata address is refused at connection time, also after a redirect and with a name that resolves privately; a
  Vault network address is allowed; downloads become attachments; a logged-in session cannot leave its site, its
  screenshot cannot attach, a password value never appears in a snapshot, an echoed secret withholds the answer and
  takes the key back; a pass is needed for someone else's turn; per-skill switches change what the runner fetches;
  role packs attach on hire; a proposal flows proposed → approved → materialized and rejected proposals never load;
  `dangerous` refused and `caution` shown; slash command hint reaches the context; the scratch workspace turn reports
  `workspace-write` with no repository and is gone after the turn; spend sums match stored usage and members see only
  their own; the migration on a database with existing agents and packs.
- Runner tests: scratch workspace preparation and cleanup, skill materialization honouring switches, the browser
  prompt lines; agent-runtime tests for the tool lists per sandbox.
- Whombat: `TMPDIR=~/.cache/wb-tmp pnpm check` and `pnpm test:server`. Contracts: `pnpm check` and the release
  smoke. App: its `pnpm check` and the visual comparison of touched screens in both themes at 1440×900. Appliance:
  `harness validate` on candidate 0.18.0 (gates, all scenarios including `r-browser` and `s-skills-roles`, demo) and
  the browser VM test.
- Live checks on dev.whombat.com after deployment, with evidence in the ledger: a real agent with the browser key
  opens a public page, reads it and answers; an Analyst with the scratch workspace produces a spreadsheet and posts it;
  a Lead delegates to a Tester; a proposed skill approved and used in the next turn.

## 10. Delivery

- Merge each repo's `capabilities` branch into `main` with `git merge --no-ff`, check that `HEAD` moved, delete the
  branch, push `main` and the tags. Commit messages: imperative, one concern each, with the attribution line
  `CLAUDE.md` prescribes.
- Deploy dev: back up first (`~/.cache/wb-tmp/dev-backup-pre-capabilities-<timestamp>`), put the managed stack on
  candidate 0.18.0 per `docs/runbooks/dev-instance.md`, and update the monolith unit per `CLAUDE.md` (pull, install
  when packages changed, `systemctl --user restart whombat-dev`, wait for `"ok":true` on
  `http://127.0.0.1:4420/api/v1/health`). The dev monolith host needs a Chromium for the browser host; install
  Playwright's browser under `WHOMBAT_HOME/browser/` there and record it in the runbook.
- Production (app.whombat.com, the Hetzner host, `~/Services/whombat`, the prod ISO) is not deployed under this
  assignment.
- Finish with: what changed per repo with commits and versions, where to try each capability on dev.whombat.com, the
  evidence, the avatar decision John made, and what was left out and why.

## 11. Out of scope, and do not

- No file uploads into pages, no persistent browser profiles, no browser on LAN beyond the Vault networks, no TOTP
  yet (the slot only), no offensive security skills, no skill import from URLs or GitHub yet, no stale-skill curator,
  no database Vault kind for the Analyst yet, no spend limits or billing.
- Do not reopen settled decisions; do not give team agents personal keys; do not let a pack or a proposal grant
  anything; do not edit `docs/design-handoff/TODO.md` or the mocks; do not touch production configuration; do not run
  more agents than the work needs.
