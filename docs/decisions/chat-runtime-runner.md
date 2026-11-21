# Chat runtime — the runner's side

Stream R of `chat-runtime.md` (CR-01…CR-11): each Claude Code and Codex turn asks for fast replies where the model offers
them, and every completion says what the turn ran on (`CompleteBody.ran`, contracts 0.96). Built 2026-10-19 in
`packages/agent-runtime` and `apps/runner`.

Checked 2026-10-19, offline only (no model request, no fast turn):
- Claude Code 2.1.283 (the pin) and 2.1.303: the stream-JSON schema in the binary defines `fast_mode_state` as `off` ·
  `cooldown` · `on` and `fast_mode_disabled_reason` as `free` · `preference` · `extra_usage_disabled` · `network_error` ·
  `unknown` · `not_first_party` · `disabled_by_env` · `model_not_allowed` · `sdk_opt_in_required` · `pending`, on
  `system:init`, `initialize` and every `result` (also in the 2.1.283 protocol fixture). A fast request refused for usage
  credits (`out_of_credits`, `org_spend_cap_reached`, `org_level_disabled_until`) is retried at the standard speed and
  fast mode stays `on`; stream-JSON then has a `system` `notification` with key `fast-mode-overage-rejected` (“Fast mode
  disabled · usage credits exhausted” / “… usage credit limit reached”). Other credit refusals turn it off with
  `extra_usage_disabled`; an organization refusal with `preference`; its own rate limit (429) or an overload (529) puts it
  in `cooldown`.
- `initialize` in `-p` with an empty config dir and non-essential traffic off: no flag setting → `off`,
  `sdk_opt_in_required`; `--settings {"fastMode":true}` → `on` (with an API key or none, with or without a skip
  variable); `CLAUDE_CODE_DISABLE_FAST_MODE` in the flag settings' `env` → `off`, `disabled_by_env`, so that `env` reaches
  the fast-mode check (`live-models.test.ts`).
- Codex 0.157.0 (the pin) and 0.163.0 (`app-server generate-json-schema`): `turn/start` takes `serviceTier` (“for this
  turn and subsequent turns”) and `serviceTierForTurn` (“only when this request starts a new turn. Use "default" for
  standard speed. Omitted or null inherits the thread's tier. Does not change the thread's tier”), both stable. No turn,
  item, usage or settings event reports the tier a turn actually ran on (`thread/settings/updated` has the thread's
  configured tier only).

## Details

| ID | Decision | Why |
| --- | --- | --- |
| CR-R01 | **The runner decides each turn's fast replies** (`TurnInput.fast`): `turnFast(runtime.fast, modelFast(list, model))` with its own model list, so only where the turn's model offers them; an unknown list or model sends nothing (`turnFast`'s rule). `ctx.agent.runtime.fast` is the agent's, or the Chat thread's choice when the server puts it there. ACP runtimes and the scripted demo get none. | The same footing as effort (ME-D01): one place keeps a turn within what its model can do. |
| CR-R02 | **Claude Code: `fastMode` in the turn's flag settings** (`--settings`, true or false; nothing when the turn doesn't say) and, when true, **`CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS=1` in the same settings' `env`**, not `…_ORG_CHECK`. Whombat runs Claude Code with non-essential traffic off, so the availability check never runs and counts as failed (`unknown`); the network-errors variable treats a failed check as available and still honours an organization's “disabled” answer whenever one is known, where the org-check variable would skip that too. In 2.1.283/2.1.303 `fastMode: true` in the flag settings already gets past a failed check on its own; the variable is what the docs prescribe for proxies, gateways and no-traffic setups and keeps working should that change. In the settings' `env`, never the process environment: the managed sandbox passes no unknown variable (MSB-18). | The documented `-p` form (≥ 2.1.205; the pin is 2.1.283); the API's own answer decides every request either way. |
| CR-R03 | **Codex: `serviceTierForTurn`** `priority` (true) or `default` (false) on every `turn/start`, nothing otherwise — not `serviceTier`, which Codex keeps for the thread's later turns: a later turn that says nothing would inherit an earlier turn's speed instead of the model's own default (`defaultServiceTier`). Nothing on `thread/start`/`thread/resume` or `turn/steer`. | Speed is per turn and stays out of the session (CR-02, CR-06). |
| CR-R04 | **Claude's speed from its result**: a `speed` event (`TurnEvent`) before each result's answer or failure — `fast_mode_state` `on` is fast, unless the credits notice came during the turn (sticky). Why not, only when the turn asked (`fastSkippedFrom`, pure): the notice → `credits`; `cooldown` → `busy`; `extra_usage_disabled`, `free` → `credits`; `preference`, `model_not_allowed` → `org`; `network_error`, `unknown`, `pending`, `not_first_party`, `disabled_by_env`, `sdk_opt_in_required`, `off` without a reason and anything unknown → `unavailable`. A result without the fields (an older CLI) gives no event. | Read from the binary's own schema, not guessed; an unknown value never fails a turn. |
| CR-R05 | **`CompleteBody.ran` on every completion of a Claude Code or Codex turn that reached the provider** (done, failed, cancelled, handed back): `model` sent (null: the tool's default, also after ME-05), `effort` sent (null: none), `fast`, and `fastSkipped` only when fast was wanted or sent and it didn't run fast. None when the turn was refused before the provider started, for ACP and scripted, or when it wouldn't pass `TurnRanReport` (a model id over 120 characters). The last attempt counts. | What answered, as the runner knows it; never a reason the person didn't ask about. |
| CR-R06 | **Codex says nothing of its speed**: `ran.fast` is what was sent, and with nothing sent the model's own default (`fast: 'on'` in the runner's list, e.g. gpt-6-sol); no `fastSkipped` from Codex itself. | No event carries the tier used (checked in 0.157.0 and 0.163.0). |
| CR-R07 | **The ME-05 retry decides fast again for the default model**: kept when the default offers fast replies, else nothing sent and `ran` says `fastSkipped: 'unavailable'` beside `modelFallback`. | The fallback's turn is the default's; the reply still says why it came at the normal speed (CR-08). |
| CR-R08 | **Never fast through the AI gateway**: a gateway turn sends nothing about speed (Claude Code's check and Fusebox's handling are unverified, CR-06), reports `fast: false`, and `fastSkipped: 'unavailable'` when the runtime wanted fast replies on a model that offers them. | Not offered there until checked against a real Fusebox; honest when an older default asks anyway. |
| CR-R09 | **Model lists keep fast replies** (ME-04): Claude Code's `supportsFastMode: true` → `fast: 'off'` (off unless a turn asks); Codex's `priority` in `serviceTiers` → `on` when it is the `defaultServiceTier`, else `off`; nothing otherwise. Recorded lists: Opus (and the default it is) offer them, Fable/Sonnet/Haiku don't; gpt-6-sol and gpt-6-luna `on`, the other six `off`. | The server shows the toggle from the list it is given (`ProviderSetup.models`). |
| CR-R10 | **Tests use fakes only**: the mapping, settings, turn params and `ran` through `runDispatch`; the pinned-binary test (fake Messages API) sees `speed` `fast: false` on an ordinary turn; `live-models.test.ts` checks `initialize`'s fast mode state with the real binary when `WHOMBAT_CLAUDE_PATH` names it. No fast-mode turn was run, against Anthropic or the fake API. | Fast mode bills usage credits; everything else is checkable offline. |
