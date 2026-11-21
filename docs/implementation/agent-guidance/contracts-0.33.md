# Contracts 0.33.0 — what the agent-guidance streams build on

Released 2026-10-01: whombat-contracts main `2898ec8` (merge of `agent-guidance`), tag `contracts-v0.33.0`, decisions
CT-207…CT-210 in `~/Code/whombat-contracts/docs/decisions/contracts.md`. Not pushed: the lead pushes. Vendored into
Whombat `agent-guidance` (`ffcbf503`) and whombat-app `agent-guidance` (`a972ec0`); the stubs each left are listed at
the end. Source of truth: `~/Code/whombat-contracts/packages/core/src/text/mentions.ts`,
`packages/core/src/vault/{copy,request,schemas}.ts`, `packages/core/src/contracts/vault.ts`.

`SESSION_API_LEVEL` stays **25** and there is no new runtime feature (CT-209): `DispatchContext` is the runner
contract, whose optional fields never bumped the level, and clients canonicalise mentions themselves before sending.
No Go, JSON Schema or vector change.

## A. Mentions in any letter case (`@whombat/core/text`, MS-C01…MS-C03, CT-207)

- `mentionNameOf(target: MentionTarget): string` — the word a target is mentioned by: an agent's name, a person's
  `shortName` or else first name. Used by `resolveMentions` and canonicalisation alike.
- `interface MentionCorrection { start: number; end: number; from: string; to: string }` — one `@word` in another
  letter case: `text.slice(start, end) === from` (`@banjo`), `to` is canonical (`@Banjo`), always the same length.
- `mentionCorrections(text: string, targets: readonly MentionTarget[]): MentionCorrection[]` — every correctable
  `@word`, in order.
- `canonicalizeMentions(text: string, targets: readonly MentionTarget[]): string` (MS-C02) — rewrites each to its
  canonical form; everything else byte-identical; idempotent.
- `autocorrectMentionAt(text: string, caret: number, targets: readonly MentionTarget[]): { text: string; caret: number }
  | null` (MS-C03) — the composer's in-place auto-correct, one rule for web and Android: the character just before
  `caret` ended a correctable `@word` → that word replaced, caret unchanged; null when there is nothing to do. After
  `.` or `-` it waits one character (`@banjo.example`, `@banjo-ci` may follow), so `@banjo.` corrects when the next
  character is typed (`@banjo. ` → `@Banjo. `). Nothing is corrected inside a code span still open on the line.
- `resolveMentions(text, principals)` (changed) — resolves on `canonicalizeMentions(text, principals)`: `@banjo`,
  `@BANJO` mention Banjo; order unchanged (agents, people, personal agents, PA-04).
- Unchanged: `MENTION_PATTERN`, `segmentMentions`, `mentionNames`, `mentionQueryAt` (already accepts lowercase),
  `parseBroadcast`. The canonical `@Banjo` behaves exactly as before, also where the new boundaries wouldn't allow a
  non-canonical form (`x/@Banjo`, `` `@Banjo` ``).

Rules (CT-207): a non-canonical `@word` counts only when the `@` is at the start or after a character that isn't a
letter, mark, digit, `_`, `.`, `@`, `/`, `-`; the word is all letters/marks; after it no letter, mark, digit, `_`, `@`,
`/`, and no `.`/`-` + letter or digit (so `john@banjo.example`, `x/@banjo`, `@banjo.example`, `@banjo2`, `@banjo_bot`,
`@whombat/core` stay text). Not in fenced code or inline code spans. Only targets whose mention name is
`[A-Z][a-z]+` are candidates; the comparison is ASCII-only (no Unicode case folding). Lowercase `@channel` / `@here`
are never corrected. Unknown words stay as typed.

## B. Agents guided to the Vault (`@whombat/core/vault`, `@whombat/core/contracts`, VT-G01…VT-G05, CT-208)

- `VaultUnheldEntry` (schema + type) — `{id: VaultEntryId, name: string, description: string, kind: 'http' | 'mcp' |
  'login' | 'ssh', ownerFirstName: string, site?: string | null (≤ 253), servers?: VaultContextSshServer[]}`: one of
  the requester's own entries the agent holds no key to. `servers` = all of the entry's servers `{name, target,
  ready}` (targets allowed: it is the owner's turn), `[]` when none; absent for other kinds. `ownerFirstName` is an
  addition to VT-G02's shape, for “ask John”.
- `VaultDispatchContext.unheld: VaultUnheldEntry[]` — `.default([])`: older payloads parse to `[]`; the parsed type
  always has it, so code that builds a `VaultDispatchContext` must set it. Not capped by the schema.
- `VAULT_UNHELD_MAX = 20` — the server's cap on `unheld`.
- `VAULT_ACCESS_RULES: readonly string[]` — VT-G01's two new rule lines, verbatim (“You can’t reach SSH servers …”,
  “When you need access you don’t have …”), for every turn that may use the Vault, after the existing rules.
- `VAULT_SSH_SETUP_INTRO: string` — “How someone sets up SSH access for you (tell them only the steps still missing):”.
- `VAULT_SSH_SETUP_STEPS: readonly string[]` — the five setup steps, unnumbered, step 5 with an `{agent}` placeholder.
- `vaultSshSetupSteps(agentName: string): string[]` — the steps numbered `1. …` … `5. Give a key to… → you (Banjo),
  with All servers or that server.`
- `VAULT_UNHELD_NOTE = 'you hold no key to it'` — the block tag: `[[vault entry · SSH key · the requester’s own · you
  hold no key to it]]`.
- `vaultUnheldAskLine({ownerFirstName, entryName, agentName}): string` — “To use it, ask John to give you a key:
  Settings → Vault → “Server Access Key” → Give a key to… → Banjo.” Pass `entryName` already defused (BP-07).
- `VAULT_SSH_AGENT_RULES` (changed) — a fifth, last rule (VT-G04): “When someone names a host that isn’t one of the
  key’s servers, don’t guess: tell them to add it as a server (step 2 of the SSH setup), or which listed server it is.”
- `vaultNoServerText(serverNames: readonly string[]): string` — the `no_server` tool answer naming the servers the
  key covers: “That Vault entry has no server by that name. Its servers: web-1, nas.”; with none “… It has no
  servers your key covers yet.” Names only, in every turn. `VAULT_FAILURE_TEXT.no_server` is unchanged.

## What each stream still has to do

**Runtime** (Whombat): store `canonicalizeMentions(text, targets)` in `postMessage` and message edits, with the same
target list `resolveMentions` gets (MS-C02). `vaultContextFor` (`apps/server/src/vault/context.ts`) now returns
`unheld: []` — a stub from the vendoring commit; fill it in the owner's own turn and return a context (`entries: []`)
instead of null for every non-vaultless turn (VT-G01, VT-G02). `vaultLines` must print the section when `entries` is
empty, add `VAULT_ACCESS_RULES`, `VAULT_SSH_SETUP_INTRO` + `vaultSshSetupSteps(agent name)` and the unheld blocks
(`VAULT_UNHELD_NOTE`, `VAULT_SSH_NO_SERVERS` / the `Servers:` list, `vaultUnheldAskLine`). The `no_server` answers in
`apps/server/src/vault/ssh-use.ts` and `use.ts` should use `vaultNoServerText(covered server names)`. The fingerprint
part for unheld entries (VT-G05). The new VT-G04 SSH rule already prints wherever `VAULT_SSH_AGENT_RULES` is spread.

**App** (whombat-app): call `autocorrectMentionAt(text, caret, targets)` after an insertion (not after deletions)
and, on a result, set the text and restore the caret; run `canonicalizeMentions` on send and show the canonical text
in the optimistic message. `targets` are the composer's members as `MentionTarget` (with `shortName` and `personal`)
— the same list the `@` picker uses. Nothing else was stubbed.
