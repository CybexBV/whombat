# Workstream E (buzz-parity): a generic ACP runtime adapter

Agents on any Agent Client Protocol runtime the host operator configures, beside Claude Code and Codex: diagnostics,
negotiation, sessions, prompts with attachments, progress and tool events, cancellation with process-group cleanup,
failures, usage, permission mediation and an explicit capability matrix — trusted only, because Whombat can't
confine a runtime. Binds: `buzz-parity.md` BP-03, BP-04, BP-07, BP-08; `runner-selfhost.md` (guarded / trusted,
TurnAccess); `agent-setup.md`; `bp-memory.md` (sessions); `bp-attachments.md` (delivery). User guide: `docs/acp.md`.

## Layout

```
packages/core/src/domain/acp.ts           AcpRuntimeId, AcpRuntimeDefinition (host config), AcpRuntimesFile, AcpNegotiated
packages/core/src/domain/providers.ts     'acp' label, ProviderCapabilities (schema), AcpRuntimeCheck, RunnerStatus.acp,
                                          AgentSetupStatus.acpRuntimes, providerRunnable(…, acpRuntime), acpRuntimeOf
packages/core/src/domain/roles.ts         AgentProvider 'acp', AgentModelRuntime.acpRuntime
packages/core/src/contracts/runner.ts     ClaimBody.acpRuntimes
packages/core/src/text/copy.ts            acpGuardedRefusal, unrunnableReply {kind: 'acp'}, CAPABILITY_LABELS, capabilityValue
packages/agent-runtime/src/acp/
  provider.ts      AcpProvider (available, turnAccess, runTurn), systemSection, whombatMcpServer
  stream.ts        bounded NDJSON stream (line cap, JSON-RPC shape) for the SDK
  capabilities.ts  negotiatedFrom, unusableReason, acpCapabilities
  permissions.ts   describeToolCall, decidePermission, permissionResponse
  events.ts        AcpEventMapper (session/update → TurnEvent, reply text, usage)
  config.ts        loadAcpRuntimes, acpRuntimesPath (WHOMBAT_ACP_RUNTIMES, $WHOMBAT_HOME/acp-runtimes.json)
  errors.ts        ProviderRefusal
  testing/         fake-agent.mjs (the fake runtime), index.ts (`@whombat/agent-runtime/testing/acp`)
apps/runner/src/registry.ts               ACP entries: check, claim by id, status, recheck
apps/server/src/runtime/service.ts        claim filter, setupStatus.acpRuntimes, sweepUnrunnable for ACP agents
apps/server/src/commands/agents.ts        assertAcpChoice (hire / update), event text
apps/server/src/memory/sessions.ts        the runtime id in the session fingerprint
apps/cli/src/doctor.ts                    acpCheck
apps/web/src/features/agents/{AiProviderPanel,ProviderPicker,ConfigureAgentModal}.tsx
apps/mobile/src/{data/runsOn.ts,screens/RunsOnSection.tsx}
```

## Decisions

| # | Decision | Why |
|---|---|---|
| BP-E01 | **Library and protocol.** `@agentclientprotocol/sdk` 1.5.0 (npm latest, 2026-09-21; dependency of `packages/agent-runtime` only) with its `client()` API (`ClientSideConnection` is deprecated), protocol version 1 (`PROTOCOL_VERSION`). Verified against agentclientprotocol.com (session setup: `session/new`, `session/load` needs `loadSession` and replays history, `session/resume` needs `sessionCapabilities.resume` and does not; MCP over HTTP needs `mcpCapabilities.http`) and the package's type definitions. The stdio stream is Whombat's own (`boundedNdJsonStream`), not the SDK's `ndJsonStream`, which answers a parse error and reads on. | The official library; strictness where the SDK is lenient (BP-E08). |
| BP-E02 | **Runtimes are host configuration.** `$WHOMBAT_HOME/acp-runtimes.json`, or the file `WHOMBAT_ACP_RUNTIMES` (config.env, `RUNNER_ENV_KEYS`) names: `{runtimes: [{id, label, command (absolute), args, env, trust, systemPrompt, sessionMeta, idleTimeoutSec, turnTimeoutSec}]}` (`AcpRuntimeDefinition`, strict). The file must not be group/other-writable; each entry is checked on its own (a broken one is listed in `problems`, the others still load); `env` never sets Whombat's settings or secrets (`ACP_FORBIDDEN_ENV`). An agent stores `provider: 'acp'` + `acpRuntime: <id>` only. The runner reads the file at start. | Editing an agent must never become running a command of someone's choosing. |
| BP-E03 | **Who puts an agent on a runtime.** `agents.update` / `hire` with `provider: 'acp'` need `acpRuntime`, an **owner of the burrow who is an admin of this Whombat** (the rule for what reaches the host, like `setAgentRuntime`) and a runtime a connected runner reported (“This Whombat’s runner has no ACP runtime called “x”.”). Personal agents never (“Tulip stays guarded, so it can’t run on an ACP runtime.”). The event is `Moved Banjo to Codex (ACP)` (the runtime's label). The hire modal and onboarding offer Claude Code and Codex only: a new agent starts guarded, where an ACP runtime would refuse; Configure (which also sets access) offers the runtimes. | A runtime runs trusted only, so choosing one is as consequential as making an agent trusted. |
| BP-E04 | **Trusted only; guarded turns are refused.** Whombat can't confine a runtime process to RS-09…14: the runtime needs its model login (in the paths guarded agents may not read) and Whombat's loopback MCP endpoint, so the same process — and every command it runs — would reach both, and without a network namespace plus a filtering proxy for the runtime there is no “no local addresses”. So `trust` is `trusted_only` (`guardable` is refused by the configuration: “Whombat can’t confine an ACP runtime yet…”), `guardedConfinement: 'none'`, and a guarded agent's turn is refused before the runtime starts (`turnAccess` throws `ProviderRefusal`, the runner completes with `refusal`, and the agent says: “I can’t run guarded on Codex (ACP): Whombat can’t sandbox an ACP runtime, so it runs only for trusted agents. An owner who is an admin of this Whombat can make me trusted in Configure Banjo, or move me to Claude Code or Codex.”). Trusted turns report `{mode: 'trusted', sandbox: 'off'}` (runs say “· trusted”). The environment is `agentEnv` trusted (the owner's minus Whombat's secrets) plus the agent's git identity / workspace repo plus the runtime's `env`. | Protocol compatibility is not a sandbox; claiming one would be false. |
| BP-E05 | **Negotiation and the capability matrix.** Every check and every turn does `initialize` with `clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}` and records `AcpNegotiated` (protocol version, agent, loadSession, resume, image, audio, embeddedContext, MCP http/sse, auth method names). Unusable: another protocol version, or no MCP over HTTP (“… can’t reach Whombat’s tools: it doesn’t support MCP over HTTP, so it can’t act in Whombat.”) → `available()` false, not claimed. Matrix: images = `promptCapabilities.image`; PDFs false (ACP has no document block); session resume = resume or load; skills false; cancel true (protocol); usage true once the runtime reported any (ACP makes it optional; the panel says “When it reports it” until then); guarded sandbox none. The native providers' matrix now travels too (`ProviderCheck.capabilities`), so the panel shows BP-03's matrix for every ready provider. | BP-03: unsupported is explicit; nothing is claimed that wasn't negotiated. |
| BP-E06 | **A turn.** Spawn (own process group, cwd = the turn's) → `initialize` → `session/resume` when advertised and the dispatch carries a session, else `session/load` (its replay is dropped: history, not this turn), else `session/new` `{cwd, mcpServers: [{type: 'http', name: 'whombat', url, headers: [Authorization: Bearer <dispatch token>]}], _meta}` → `session/prompt`. The **system prompt**: protocol v1 has no field for it, so by default a delimited `<whombat-instructions>` section opens the first prompt of a new session (a resumed session has it already); `systemPrompt: "meta"` sends `_meta.systemPrompt` instead (`claude-agent-acp` replaces its preset with it). `sessionMeta` is merged into `_meta`. Content: the prompt text, `image` blocks for fetched images when negotiated (else a line that the runtime can't take images), text files ≤ 64 KiB (256 KiB in all) as embedded `resource` blocks with `embeddedContext`, PDFs described (planned so by `planAttachments` from the matrix). `session/update`: `agent_message_chunk` → `text_delta`; thoughts, plans, compaction, notices → `thinking`; `tool_call` / `tool_call_update` → `tool_call` / `tool_result` (Whombat MCP tools by bare name, so the runner's posting and PR hooks work); `usage_update` → context size and cost. The **reply** is the runtime's last message (text after the last tool call or of the last `messageId`; all the text if that is empty) — live, both runtimes stream “I’ll set my status first.” before a tool call. `final` usage: `session/prompt`'s `usage` (input incl. cache reads/writes), else the last `usage_update`'s context size as input and 0 out; cost when reported in USD. A `session` event only for runtimes that can resume. | The same turn contract and prompts as Claude and Codex (`apps/runner/src/prompt.ts`); BP-07: attachment text is data. |
| BP-E07 | **Permission mediation** (`session/request_permission`). Whombat MCP tools — Whombat's own and approved packs' `pk_<pack>__<tool>` served through `/mcp` (BP-08, Workstream D) — allowed (the keys engine decides behind them). A tool is Whombat's only where a runtime names a tool — `_meta.claudeCode.toolName` (`mcp__whombat__x`), Codex's `is_mcp_tool_call` with `mcp.whombat.x` or `{server, tool}`, a `name`, or a title when the kind is `other` (a shell command's title is the command, which could spell anything); a request that names only the call id (codex-acp) is matched to the announced `tool_call`. Guarded: everything else rejected (second line; guarded turns don't start). Trusted: the trusted Claude turn's `canUseTool` — read, search, edit, move, delete, execute, think allowed; `fetch` only with “Browse the web”; `switch_mode` and unknown tools refused. Options by **kind**: `allow_once`; reject with `reject_once` (else `reject_always`); `allow_always` never; no fitting option → `cancelled`. Each decision is a `permission` tool event (tool, kind, allowed, reason). | Buzz's pattern; ids are the runtime's words. |
| BP-E08 | **Failures.** A line that isn't JSON, JSON that isn't JSON-RPC 2.0, or a line over 16 MiB (`ACP_MAX_LINE_BYTES`): non-retryable, the connection closed and the group killed. Crash / unexpected exit (with the stderr tail): retryable (the runner retries once). Nothing from the runtime for `idleTimeoutSec` (300): retryable. Longer than `turnTimeoutSec` (3600): not retryable. A failed resume / load: retryable (the server retries fresh, BP-B17). `stopReason: refusal`: not retryable; `cancelled` we didn't ask for: retryable. JSON-RPC errors (e.g. “Authentication required”) go through `isRetryableMessage`. A spawn `ENOENT`: `missing`, not retryable. Unknown agent → client requests: `-32601` (the SDK's “method not found”; no fs, no terminal handlers). | “Retryable or not”, never a silent degrade. |
| BP-E09 | **Cancellation.** Abort: every permission request open or arriving is answered `cancelled`, then `session/cancel`, a grace (`cancelGraceMs`, 3 s) for the prompt to end, then the process group is killed. `killProcessTree` is called **before** the runtime's stdin is closed: it snapshots the tree while the runtime is still the parent of what it started (closing stdin first let the fake exit and orphan a `setsid` grandchild — found by the fixture). After an abort the stream just ends (no `final`, no `error`), like the native providers. | Buzz's order; the tested kill path. |
| BP-E10 | **Claims, status, sessions.** `RunnerStatus.acp` carries each runtime's `AcpRuntimeCheck` (id, label, state, version, detail, trust, capabilities, negotiated) — never its command or env. A live runner claims `acp` with `acpRuntimes` = its ready ids; the server claims an ACP agent only for a runner naming its runtime (a scripted runner sends none: any). `host.agents.acpRuntimes` merges the runners' reports (ready wins). A queued ACP dispatch no runner can run gets “I can’t reply yet: Codex (ACP) isn’t ready on this Whombat. Once it is (Settings → AI provider), ask me again.” The session fingerprint's provider part is `acp:<id>`, so moving between runtimes starts a fresh session. `agentsCanReply` counts ready runtimes. | One source of truth: what the runner found. |
| BP-E11 | **UI (not mocked).** AI provider panel (onboarding step 3, Settings → AI provider): a row per configured runtime — status dot, label, “{state} · ACP · trusted agents only”, and when not ready its detail plus “Check its entry in acp-runtimes.json on the host, then run whombat doctor.” — and under every ready provider the matrix (Images, PDFs, Session resume, Skills, Cancel, Usage, Guarded sandbox: “Yes” / “Not supported” / “OS sandbox” / “Permission checks only” / “Not supported · trusted only” / “When it reports it”), a 4-column `<dl>` indented to the name. Configure's picker adds one “ACP runtime” option after Claude Code and Codex (disabled unless a runtime is ready and the person is an owner who is an admin; hint: “Only owners who are admins of this Whombat put an agent on an ACP runtime.”); picking it takes the first ready runtime and shows a second row, “Runtime”, with the runtimes by label (a single control with every runtime ran out of the modal at 1440×900 with three of them — seen in the screenshots); picked: “Ready · … ACP runtimes run only for trusted agents: make Banjo trusted below, or it will refuse to work.” / “… ACP runtimes run trusted, without a sandbox.” Android: RUNS ON on the agent screen (server mode, live): one row per option with its state, ✓ on the current one, tap → “Move Banjo to Codex (ACP)?” (“Its next turns run on Codex (ACP).”) under the same rules; notes as on the web. | Nearest patterns: the panel's rows, Configure's segmented rows, the profile's list sections. |
| BP-E12 | **The MCP token travels in `session/new`.** ACP's HTTP MCP servers take literal header values (no `${VAR}` expansion as Claude Code's own config has), so the runtime receives the per-dispatch token; `claude-agent-acp` passes it to Claude Code on its command line, readable by other processes of the same user. Accepted for trusted-only runtimes (a trusted agent's shell sees its token anyway, runner-selfhost follow-ups); it expires with the dispatch and grants only what the agent's keys allow. | The protocol has no other way; documented in `docs/acp.md`. |
| BP-E13 | **Doctor** (`acpCheck` in `EXTRA_CHECKS`): the configuration file's problems, then per runtime its command and `initialize` handshake, with the matrix on one line; fails when anything is broken (“fix the entries above in … (docs/acp.md)”), skips when none is configured or in scripted mode. `WHOMBAT_ACP_RUNTIMES` is one of the runner's config.env keys. | “Doctor checks each configured runtime.” |
| BP-E14 | **Only this user can change what a runtime runs** (security review SEC2-F8). The runtimes file is read with `lstat`: a symlink is refused (“… is a symbolic link; put the file itself there …”), so are a file owned by another user, a file writable by group or others, and a file whose directory is writable by group or others — the whole file is then ignored, with the reason in `problems`. Each entry's `command` (absolute, as before): links followed with `realpath`; the target must be a regular file, not writable by group or others, owned by this user or root; the directory of the command and of its target must not be writable by group or others (a world-writable `/tmp`, sticky or not, counts). Such an entry is dropped with the reason (“command … is writable by group or others (mode 777); run chmod go-w …”); the others still load. A command that doesn't exist yet stays a runtime whose check says “missing” (as before), unless its directory is one others could put it in. Checked when the runner reads the file (its start) and by `whombat doctor`. A host whose `/usr/local/bin` is group-writable (old Debian `staff`) has to tighten it or install the runtime elsewhere. | The file and the commands decide what the runner starts as the operator; anyone else able to swap either could run code as them. |

## Verification (2026-09-24)

- Unit (`pnpm check`): core `domain/acp.test.ts` (definitions, agent runtime, runnable, copy, claim body);
  agent-runtime `acp/acp.test.ts` — 28 tests against `testing/fake-agent.mjs` over real stdio: configuration file
  (defaults, mode, per-entry problems, `guardable` and Whombat secrets refused), negotiation and matrix, the
  permission policy per rule and option choice by kind, the event mapper and reply text, the stream's line cap and
  JSON-RPC check, `available()` (ready, no HTTP MCP, v2, missing, not executable), guarded refusal (runtime never
  started), a trusted turn against the stub MCP server (bearer header, tool events, reply, no Whombat secrets in the
  runtime's env), `systemPrompt: meta` + `sessionMeta`, images vs no images + embedded text, `session/load` (replay
  dropped) and `session/resume` (preferred; a failed one retryable), permissions end to end (MCP by id, trusted
  shell, mode switch and fetch refused), `-32601` for fs, usage, crash, malformed and oversize lines (group dead),
  refusal, auth error, idle and turn caps, cancel with a late permission request answered `cancelled` and the
  process family (incl. a `setsid` grandchild) dead, a runtime that ignores cancel. Runner `acp.test.ts` (registry:
  check, claims by id, status matrix, problems logged, scripted mode; guarded refusal; a trusted turn posted with
  usage; a runtime's `post_message` counts as the reply). CLI `doctor.test.ts` (skip, per-runtime lines, fail with
  fix, ok). Web `acp.test.tsx` (panel rows, matrix, picker locked / unlocked, hints). Mobile `runsOn.test.ts`.
- Server integration (`runtime/acp.int.test.ts`, throwaway database, the real runner with the fake runtime): the
  runtime and its matrix in `host.agents`; only an owner-admin moves Banjo onto it (member 403, unknown runtime and
  missing id 400, a path as id 400, a smuggled `command` dropped); guarded Banjo refused in the conversation; trusted
  Banjo's turn calls `set_status` on Whombat's MCP with the dispatch token (his “doing” changes) and posts
  “Done. mcp=ok”, access `trusted · off`, session remembered; an ACP agent whose runtime no runner has gets the
  quiet reply.
- Live (`runtime/acp-live.int.test.ts`, opt-in `WHOMBAT_ACP_LIVE=1`, own server and database, runtimes from a local
  `acp-runtimes.json` pointing at the on-disk installs; Codex's home a Whombat-prepared `CODEX_HOME` with the
  operator's `auth.json` linked): **codex-acp 1.6.2** (codex-cli 0.156.1), 6/6 —

  | Check | Result |
  |---|---|
  | Conversation through Whombat | Banjo (trusted, on Codex (ACP)) replied `KESTREL-1535` in ~4 s; access `trusted · off` |
  | Session | the next mention resumed the same session id (`session/resume`) and answered the code (~3 s) |
  | Image | a 64×64 red PNG as an image block → “red” |
  | Coding task | throwaway local repo: `hello.txt` written and committed as “Add hello” (~20 s; the commit's permission request allowed once) |
  | Cancel | abort during `sleep 120`: stopped in 39 ms, no process left in the turn's directory |
  | Unavailable | a runtime with a missing command: `missing` in `host.agents` and `available()` |

  Also a provider-level turn each on codex-acp and **claude-agent-acp 0.70.0** against the stub MCP server:
  both called `set_status` with the bearer token and answered; claude-agent-acp ran in bypass mode from the
  operator's settings, so it asked no permissions (see limitations). `whombat doctor` against the same file: two
  ready with their matrices, the missing one failed with the fix. Evidence: `~/.cache/wb-tmp/bp-e/evidence/`
  (`live-codex-acp.json`, `provider-turn-codex-acp.json`, `provider-turn-claude-agent-acp.json`, `doctor.txt`).
  `opencode acp` was not used (billed to a third-party key).

## Limitations and follow-ups

- **Guarded ACP turns** need Whombat to confine the runtime: a network namespace with a proxy that allows the model
  API and Whombat's MCP endpoint only, and the model login readable by the runtime but not by what it runs — which
  one process can't have. Until then, trusted only.
- **claude-agent-acp honours the operator's `permissions.defaultMode`**: with `bypassPermissions` (this host)
  Claude Code never asks, so Whombat's permission policy isn't consulted; and `settingSources: []` also drops a
  login kept in `~/.claude/settings.json`. The operator decides per runtime (`sessionMeta`); a Whombat-owned
  `CLAUDE_CONFIG_DIR` (as Codex's home) would fix both — not done.
- codex-acp uses the operator's `~/.codex` unless `CODEX_HOME` is set (the guide recommends Whombat's).
- Usage is learned from turns; the matrix says “When it reports it” until the runtime has.
- Skills (Workstream D) aren't delivered to ACP runtimes (`skills: false`, so the runner doesn't materialize them);
  pack MCP tools arrive through Whombat's `/mcp` as for every provider (BP-08) and are allowed like Whombat's own.
- codex-acp reads a repository's `AGENTS.md` and skills unless its `CODEX_HOME` config turns them off
  (`project_doc_max_bytes = 0`); Whombat's own Codex turns don't (BP-D13). Documented in `docs/acp.md`, not enforced.
- Merged with D after this branch's base: the session fingerprint there also includes pinned packs; the one-line
  `acp:<id>` provider part here is independent of it.
- The Android RUNS ON section was typechecked and unit-tested, not run on a device or emulator.
- Session modes (`session/set_mode`) and config options are not used: a runtime runs in its default mode.
