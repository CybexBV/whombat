# Workstream: agent-setup (AI provider discovery, choice and onboarding)

Prompted on 2026-09-24 by dev.whombat.com: the maintainer hired Nugget on a live Whombat (Claude Code and Codex
both installed and logged in on the host) and it answered “On it. I’ll post back here when I have something
worth reading.”, the ScriptedProvider's canned line. `DEFAULT_AGENT_RUNTIME.provider` was `scripted`, nothing in
the web sent a provider, and a live runner still claimed `scripted`, so every agent on a live Whombat was the
demo bot. Nothing told anyone whether Claude Code or Codex could run.

Maintainer answers (2026-09-24): setup is an extra onboarding step named **“Set up AI provider”**, before
“Meet your agents”; new agents get a **default provider plus a picker**; Whombat must **discover whether
Claude Code and Codex are installed and usable and offer the usable ones as active options**.

Builds on `self-hosted.md` (S-13 access), `runtime-server.md` and `runner-selfhost.md`. Supersedes the
“default in dev, tests and demo” half of A-08 for live instances (it stays the default of `WHOMBAT_AGENTS`), and
SP-W01's “the modal does not edit the model”.

## Decisions

- **AS-01 Live never runs scripted.** With `WHOMBAT_AGENTS=live` the runner claims only the live providers
  that are ready (`registry.claims()`); an agent still configured `scripted` is answered by the server
  (AS-04). Scripted mode is unchanged: it claims everything and runs every agent as the demo.
- **AS-02 Discovery is the runner's, and it keeps checking.** The runner calls each provider's `available()`
  at start, again every 30 s while one isn't ready and every 10 min while it is (to notice a logout), and at
  once when the server asks (“Check again”). `available()` says why a provider isn't ready (`kind`:
  `missing`, `logged_out`, else `error`; `unavailableKind` classifies older reasons). Logging in on the host
  needs no restart.
- **AS-03 The runner reports in its heartbeat.** Every beat (10 s) carries `status: RunnerStatus` (mode, one
  `ProviderCheck` per live provider — with the models the CLI lists itself, model-effort.md ME-04 — the sandbox
  checks, when it checked); the heartbeat answer may carry
  `recheck: true`. The server keeps the last report per runner in memory, like the runner list itself, so a
  restarted server knows it within one beat. No new table: it is host state, not burrow data.
- **AS-04 Unrunnable dispatches get a quiet reply.** The lease sweep also ends a queued dispatch whose agent's
  provider no connected runner claims (`sweepUnrunnable`): `failed` with a `refusal` (final, no retry; the
  existing path posts it as the agent and stops “thinking”; search dispatches mark their answer failed). It
  waits 5 s after the dispatch was created when a runner is connected, and 60 s when none is (and only
  once the server has been up 60 s, so a restart before the runner reconnects doesn't answer anything). The
  sweeper starts with the server, not only on the first runner contact. Copy (`unrunnableReply`):
  - no runner: “I can’t reply yet: Whombat’s agent runner isn’t running on the host. Ask me again once it’s back.”
  - provider not ready: “I can’t reply yet: {Claude Code|Codex} isn’t set up on this Whombat. Once it is
    (Settings → AI provider), ask me again.”
  - still scripted: “I can’t reply yet: I’m not connected to Claude Code or Codex. Pick one in Configure
    {name}, then ask me again.”
- **AS-05 Onboarding has five steps.** Step 3 “Set up AI provider” (Claude Code or Codex) sits between
  “Connect your code” and “Meet your agents”; the mock has four, so the step list and `STEP N OF 5` are
  masked in the onboarding visual spec and the mock's steps 3–4 compare against the app's 4–5. The step shows
  the AI provider panel (AS-07) and “YOUR FIRST AGENTS USE” with the picker; the pick is saved with the
  progress (`onboarding.provider`) and used by “Open {burrow}” for the first crew. Continue is never blocked:
  a burrow can be set up before the host is. Stored progress from before this step keeps its index (an
  onboarding in progress at “Meet your agents” resumes at the new step 3).
- **AS-06 Default provider and the picker.** A new agent's provider, when nobody picks one, is
  `defaultAgentProvider`: scripted mode → `scripted`; live → the first ready of Claude Code, Codex; none
  ready → Claude Code (it works once that is set up). The hire modal (live only) and Configure (a new
  “AI PROVIDER” row, “Runs on”, saved with `agents.update`, key `agents.manage`) show a segmented
  Claude Code / Codex control; a provider that isn't ready is disabled unless it is the agent's current one,
  and the line under it says its state and where to fix it. Scripted mode shows no picker (the hire modal
  still matches the mock).
- **AS-07 The AI provider panel** (`AiProviderPanel`, not mocked — onboarding's repo card and Settings' rows):
  rows for the agent runner, Claude Code and Codex with a status dot, the state (`Ready · {version}`,
  `Installed, not logged in`, `Not installed`, `Can’t start`, `Not checked yet`) and, when not ready, the
  command that fixes it in the GitHub notice pattern (`npm i -g @anthropic-ai/claude-code` / `claude` then
  `/login`; `npm i -g @openai/codex` / `codex login` — Whombat's Codex home is prepared from the operator's
  login, so a plain `codex login` is enough; `whombat start` for the runner; `whombat doctor` otherwise). A
  ready provider whose sandbox can't run says guarded agents run without it. “Check again” is for owners who
  are admins of this Whombat (it starts both CLIs on the host), throttled to one per 5 s; everyone else sees
  the state and, when nothing is ready, “Ask an admin of this Whombat…”. It is in onboarding step 3 and in
  Burrow settings → AI PROVIDER (`#ai-provider`).
- **AS-08 Shell notice.** While agents can't reply on a live Whombat (no runner, or neither provider ready),
  one quiet line sits above every burrow screen: “Agents can’t reply yet: …” with “Set up AI provider”
  (→ Settings → AI provider). Hidden on Settings and in scripted mode.
- **AS-09 Contracts.** `@whombat/core`: `domain/providers.ts` (`LIVE_PROVIDERS`, `PROVIDER_LABELS`,
  `ProviderCheck`, `RunnerStatus`, `ProviderSetup`, `AgentSetupStatus`, `defaultAgentProvider`,
  `providerRunnable`, `agentsCanReply`), copy in `text/copy.ts`, `host.agents` (GET, burrow members) and
  `host.recheckAgents` (POST), `runner.heartbeat` `status` / `recheck`, `ONBOARDING_STEP_COUNT = 5`,
  `ONBOARDING_PROVIDER_STEP`, `OnboardingState.provider`, `provider` on `onboarding.update` and
  `onboarding.complete`. Mobile has no hire or onboarding; its agents' quiet replies are ordinary messages.
- **AS-10 Joining a burrow you just made.** Not provider work, found while verifying it: the `/:burrow`
  guard checked the cached session, which predates a burrow created in onboarding, so “Open {burrow}”
  bounced to the first burrow. The guard now fetches the session again before redirecting.

## Verified

- Unit: core (`providers.test.ts`), runner (registry re-check, heartbeat status and `recheck`), web
  (onboarding with the new step, the picker's disabled option).
- Server integration (`runtime/agent-setup.int.test.ts`, throwaway database): status before and after a
  report, “Check again” round trip, hire default, the three quiet replies, a claimable provider left alone.
- Live, 1440×900 light and dark, `WHOMBAT_AGENTS=live`, throwaway database: with both CLIs pointed at missing
  binaries — shell notice, Settings and onboarding show “Not installed” with the install commands, and
  mentioning a scripted agent gets the quiet reply in ~7 s; with the host's real CLIs — both “Ready”, the
  onboarding pick (Codex) reaches the first crew, Configure moves Clover to Claude Code and Clover answers
  through Claude Code.
- Visual suite: onboarding against the mock (steps 1, 2, 4, 5), agents (hire modal unchanged in fixture
  mode), shell, baselines (the “Connect GitHub” baseline now shows five steps).
