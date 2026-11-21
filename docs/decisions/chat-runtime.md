# Provider, model, effort and fast replies in Chat

John, 2026-10-19: “In the chat with Dusty, we should be able to change: the provider (e.g., OpenAI or Claude), the
effort, fast mode, if applicable. How would you implement this? Can you show me some designs?” After the mockup
(app `docs/design-handoff/chat-runtime/index.html`): “I love it. Implement this fully.”

Before this, provider, model and effort were the agent's alone (`AgentModelRuntime`, Configure → Model, ME-01…ME-07);
nothing per conversation, per thread or per dispatch; nothing recorded which model answered a message; fast mode was
not wired anywhere (`list.ts` dropped Claude's `supportsFastMode` and Codex's `serviceTiers`).

Facts checked 2026-10-19:
- Claude Code fast mode (research preview): `"fastMode": true` in `--settings` works with `-p` since 2.1.205, on Opus
  only (`supportsFastMode` on `default`/`opus` in `initialize`). Up to 2.5× faster at twice Opus's price ($8/$40 per
  Mtok on Opus 5.5). On subscriptions it is paid **only from usage credits**, never from the plan; usage credits must
  be on; Team/Enterprise owners must enable it. Turning it on in a conversation pays that conversation's whole context
  once at the fast price. Its availability check goes straight to api.anthropic.com and is skipped by
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (Whombat sets it) and fails with gateway/helper keys; the skip variables
  `CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS` / `CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK` restore it, and the API's own
  answer still decides (a refused fast request is retried at standard speed). Cooldown after its own rate limit;
  result events carry `fast_mode_state` and `fast_mode_disabled_reason`; out of credits in stream-json shows a
  `system`/`notification` “Fast mode disabled · usage credits exhausted”.
- Codex: `model/list` gives each model `serviceTiers` (`{id: "priority", name: "Fast", description: "2x speed,
  increased usage"}` on all eight) and `defaultServiceTier` (`priority` on gpt-6-sol and gpt-6-luna). `turn/start`
  takes `serviceTier` (`"priority"`, or `"default"` for standard speed; null inherits).

## Decisions

| ID | Decision | Why |
| --- | --- | --- |
| CR-01 | **One button in the Chat's composers** (the top-level box and a Chat thread's reply box, web and Android), Chat room only — not Feedback, task chats or other rooms. It shows the provider's mark, the model's label, “· <effort>” and a bolt when fast replies are on (“Opus · Automatic”, “GPT-6.1 Sol · High ⚡”). It opens a popover (web) / sheet (Android): “<Name> answers with” as a two-way switch (Claude · ChatGPT), one usage line, the model list, Effort (Automatic + the model's levels), Fast replies, and a footer: the scope (“For this thread” / “For your next question”) and “Make this <Name>’s default”. Hidden when the assistant isn't on Claude Code or Codex, and on runtimes without feature `chat.runtime`. | The mockup John approved: one quiet control where you type; the same on the phone. |
| CR-02 | **Superseded in part by HN-06 (hermes-native.md)**: in a thread that has a turn only the same provider’s model, effort and fast replies change; the provider is chosen with a new chat (HN-L01). **The choice belongs to a thread.** A thread's choice is stored with it; none (null) follows the assistant's own runtime. The top-level box's choice goes with the thread's first message — `messages.send` `runtime` (0.96.1: the Chat box sends with `messages.send`, which files need; found by stream M) and `chats.start` `runtime` for the other places that start a thread — stored before the assistant is woken so the first answer runs on it, and the box goes back to the assistant's default after sending. Inside a thread a change is saved at once (`chats.setThreadRuntime`) and applies from the thread's next turn; a turn already running finishes as it started. A choice equal to the assistant's current runtime is stored as null. | Like the chat apps people know; one thread can be quick and another careful without touching the assistant. |
| CR-03 | **Only the Chat's person** reads and changes their threads' choices. Everything else the assistant does — automations, Watch, schedules, the Feedback room, guides, runs started outside a Chat thread — keeps the assistant's own runtime. “Make this <Name>’s default” saves the whole choice with `agents.update` `runtime` (ME-01's rules, Keys lines), shown only to people allowed to (`canSetDefault`). | A thread choice is a conversation preference, not a setting of the assistant. |
| CR-04 | **Providers are named for the sign-in:** `claude` → “Claude”, `codex` → “ChatGPT”, with the Claude and OpenAI marks. One that can't run for this person (no runner/CLI, not signed in, no organization key, no gateway switch) is greyed: “ChatGPT isn’t set up on this Whombat.” with “Set it up” (the sign-in page). A thread on a provider that can no longer run is refused as today (readiness words), never silently moved. | People know the products by those names; a silent switch would surprise. |
| CR-05 | **Superseded in part by HN-06 (hermes-native.md)**: a started thread offers no other provider, so its reset applies to a new chat only (HN-L04). **Models and efforts come from the tools** (`ProviderSetup.models`, ME-04), the default marked DEFAULT; the web popover shows four, then “3 more…” opens the rest in place. Changing the provider resets model, effort and fast to that provider's defaults; changing the model keeps the effort within what it takes (`turnEffort`) and drops fast when it has none. | The rules Configure → Model already follows. |
| CR-06 | **Superseded in part by HN-02 (hermes-native.md)**: ChatGPT's fast replies are Hermes's priority tier (`agent.service_tier`) where Hermes's `openai-codex` offers it (HN-C02), not Codex's `serviceTierForTurn`; the words and the rest stand. **Fast replies** where the model offers them (`ProviderModel.fast`: `off` offered and off unless asked, `on` offered and on by default; absent: none — Claude's `supportsFastMode`, Codex's `priority` tier and `defaultServiceTier`). `fast` on a runtime: true/false, absent = the model's own default. Claude Code: `fastMode: true` in `--settings` plus a skip-check variable, else `fastMode: false`; Codex: `serviceTierForTurn` `priority` / `default` on every `turn/start` (not `serviceTier`, which sticks to the thread; CR-R), nothing when absent. Not offered through the AI gateway (“Fast replies don’t go through the AI gateway.”) until checked against a real Fusebox. Words: Claude “Up to 2½× faster. Paid from usage credits on your Claude account, not from your plan.”; ChatGPT “About twice as fast. Uses up your ChatGPT plan quicker.”; turning it on in a Claude thread that has replies adds “Turning it on now reads this whole thread once at the fast price.” | Honest about what it costs; only where it can work. |
| CR-07 | **Superseded in part by ui-refresh-chat.md UIR-68 (the mark only where the model changed).** **Superseded in part by PWD-13 (plain-words.md): the mark shows only where more than one AI can answer.** **Each assistant reply in Chat says what answered it** (`Message.ranOn`: provider, model, effort, fast): a small provider mark after the time, with the full line on hover/long-press (“Claude · Opus · High effort · Fast”). Before a reply that ran on something else than the thread's previous reply, a quiet divider: “Switched to ChatGPT · High effort” (`runSwitchText`). | You see what you chose took effect, without a chat message about it. |
| CR-08 | **Superseded in part by PWD-13 (plain-words.md): no line when fast replies were only busy or unavailable.** **When fast or the model didn't happen, the reply still comes** with one quiet line under it (`ranOn.fastSkipped`, `ranOn.modelSkipped`): “Fast replies were busy, so this one came at the normal speed.”, “Fast replies need usage credits on your Claude account, …”, “Fast replies are turned off for your Claude organization, …”, “Fast replies weren’t available, …”, “Fable wasn’t available, so this one came from Opus.” A thread's refused model doesn't touch the assistant's own `model_fallback` (ME-05). | Never an error for a speed or model preference. |
| CR-09 | **Usage line**: “This 5 hours: Claude 38% used · ChatGPT 12% used” from `subscription_usage` (the 5-hour window of the sign-in this person's turns run on); a provider without a known window is left out; no line when none is known or for gateway/org-key providers. | Helps pick a provider without opening Settings. |
| CR-10 | **Configure → Model gets Fast replies too** (web Model tab under EFFORT, Android Runs on), same words and rules; `agentModelSummary` adds “· Fast”; Keys line “Turned on fast replies for Dusty” / “Turned off …”. | Dusty's default can be fast; one place to see it. |
| CR-11 | **Feature `chat.runtime`** (contracts 0.96): clients show the button and the Configure toggle only on runtimes with it. | An older runtime would drop the choice. |
| CR-12 | **Superseded in part by ui-refresh-chat.md UIR-61 (the mark sits after File).** **The button is an icon in the box** (2026-10-20, whombat-app 0.100.1, app `chat-runtime-icon.md` AP-2960…AP-2964): the provider's mark as a round icon before the paperclip, on the web and the phone, with a bolt on it when fast replies are on; the model and effort show on hover (web) or a long press (phone), in the popover or sheet (unchanged) and on each reply. This replaces CR-01's “mark, model, · effort” button and the phone's row above the box. | John: the button above the box didn't look right, the popover did; one clean box. |

## Shape (contracts 0.96.0, CT-456…)

- `AgentModelRuntime.fast?: boolean`; `ProviderModel.fast?: 'off' | 'on' | null`.
- `ChatProvider = 'claude' | 'codex'`; `ChatRuntime {provider, model?, effort?, fast?}`.
- `RanOn {provider, model: ModelId|null, modelLabel: string|null, effort: AgentEffort|null, fast: boolean,
  fastSkipped?: 'busy'|'credits'|'org'|'unavailable'|null, modelSkipped?: ModelId|null}`; `Message.ranOn?: RanOn|null`.
- `ChatThread.runtime?: ChatRuntime|null`.
- `chats.runtime` GET `/burrows/:burrow/chats/runtime?thread=<rootId>` → `ChatRuntimeView {assistantId, assistantName,
  default: ChatRuntime|null, thread?: ChatRuntime|null, canSetDefault, providers: [{provider, ready, models,
  fastBlocked: 'gateway'|null, usage: {usedPct, resetsAt}|null}]}`.
- `chats.setThreadRuntime` PUT `/burrows/:burrow/chats/threads/:rootId/runtime` `{runtime: ChatRuntime|null}` →
  `{thread: ChatRuntime|null}`; realtime `chat.thread_runtime` to the person's devices.
- `chats.start` body `runtime?: ChatRuntime`; 0.96.1 (CT-469): `messages.send` body `runtime?: ChatRuntime`, kept for a
  top-level message in the sender's own Chat room.
- Runner: `CompleteBody.ran?: {model, effort, fast, fastSkipped?}` (what the turn actually ran).
- Words: core `text/chat-runtime.ts`.
