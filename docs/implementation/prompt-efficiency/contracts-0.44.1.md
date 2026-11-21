# Contracts 0.44.1 for the prompt-efficiency streams

Released as `contracts-v0.44.1` (whombat-contracts `main` 25a63c7, pushed; artifacts in
`~/Code/whombat-contracts/dist-release/0.44.1`). Vendored on `prompt-efficiency` (`vendor/whombat-contracts/0.44.1`,
commit 7cbbe968). Decisions: CT-259 in the contracts repository, PE-DC01…PE-DC04 in
`docs/decisions/prompt-efficiency.md`. A patch: `SESSION_API_LEVEL` stays 30, no feature names. All from `@whombat/core`.

## Usage (PE-04)

- `UsageCacheFields` — the optional zod shape `{cacheReadTokens, cacheWriteTokens, largestCallInputTokens}` (all `Count`).
- `SpendUsage` — `{inputTokens, outputTokens, costUsd?}` + `UsageCacheFields`; `inputTokens` is the total of every input token (uncached + cache reads + cache writes).
- `CompleteBody.usage` — is now `SpendUsage` (same three old fields, plus the cache fields).
- `SpendUsage.cacheReadTokens` — of `inputTokens`, read from the prompt cache over all calls (Claude `cache_read_input_tokens`, Codex `cached_input_tokens`).
- `SpendUsage.cacheWriteTokens` — of `inputTokens`, written to the cache (Claude `cache_creation_input_tokens`; Codex 0).
- `SpendUsage.largestCallInputTokens` — the input of the turn's largest model call (all three kinds): the context reached.
- `CACHE_READ_WEIGHT` — 0.1.
- `billedTokens(usage)` — uncached input + cache writes + output, cache reads × 0.1 (rounded, reads clamped to the input).
- `usageContextTokens(usage)` — `largestCallInputTokens ?? inputTokens`; use it for the checkpoint nudge (`CHECKPOINT_NUDGE_TOKENS`).
- `spendTokens(totals)` — now `billedTokens(totals)`.
- `SpendTotals.cacheReadTokens` / `.cacheWriteTokens` — optional sums, present once a turn in the window reported a split.
- `MemoryContext.usage` — + `UsageCacheFields` (what the nudge reads).
- `MemorySession.lastUsage` / `AgentContextResponse.lastTurn.usage` — + `UsageCacheFields` (cached vs uncached in the usage view).
- `HandoffContext.used.tokens` — counted as billed by the server (doc change only).

## The stable-prompt hash (PE-02, PE-03)

- `PromptHash` — `z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)`.
- `stablePromptHash(prompt)` — sha-256 of the prompt's UTF-8 bytes, lowercase hex (64 chars).
- `ProgressBody.promptHash` — optional; send it with the beat that reports `providerSessionId` (the session's prompt).
- `CompleteBody.promptHash` — optional; the stable prompt the turn's session ran with (with `SESSION_PROMPT_CHANGED`: the one it would have run with).
- `DispatchContext.resumePromptHash` — `PromptHash | null | undefined`, the hash `dispatch.providerSessionId` last ran with.
- `SESSION_PROMPT_CHANGED` — `'session_prompt_changed'`, an `error` for `complete` with `outcome: 'failed'`.

Runner rule: with `dispatch.providerSessionId`, resume only when the stable system prompt rendered for this turn hashes
to exactly `resumePromptHash`. Otherwise, when `memory.session?.resumed` is true (the window holds only what is new),
run nothing and complete `{outcome: 'failed', error: SESSION_PROMPT_CHANGED, promptHash}` — the server retires the
session and queues the turn again at once, uncounted, with a fresh session and the whole window; else start a fresh
session with the context given. `resumePromptHash` null never matches; absent (an older server): resume as before.
