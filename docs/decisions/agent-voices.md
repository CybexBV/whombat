# Agent voices: the face is the character, and it decides how the agent talks

John, 2026-10-24 (main checkout): changing the agent's face in Settings → Agent should change its style too, its
“SOUL” and the way it communicates: Banjo technical, Dusty always very plain, Neo mysterious like The Matrix, with
references. He asked whether Hermes Agent makes that possible, and if so, to let people choose their agent with a small
description during setup.

Research (Hermes v0.22.5 bf0203a7, Whombat 8c148537):

- Hermes's personality slot is `SOUL.md` in the profile's home: the first block of its system prompt (“identity slot
  #1”, `agent/prompt_builder.py` `load_soul_md`, `agent/system_prompt.py` `_identity_parts`), the file its own docs call
  “the agent's personality and tone”. Both of Whombat's model paths carry it: Claude's DirectSDK provider (CDS-01, Hermes
  owns the prompt) and Codex mode (`developerInstructions`, with Codex's own personality set to `none` so it can't
  compete).
- Whombat already writes `SOUL.md` for every turn from the turn's context (`soulMd`, HE-S30, HE-S31), and the context
  already carries the agent's face (`AgentPersona.face`, OA-S07). A voice per face needs no contract, migration or
  Hermes change.
- Hermes's `/personality` overlays (`display.personality`, `agent.personalities`; built-ins like pirate and noir) are
  per-session switches for Hermes's own CLI and TUI. Its ACP server never applies them, so they can't reach Whombat's
  turns.
- Hermes scans `SOUL.md` for prompt injection (`tools/threat_patterns.py`, context scope). All five texts pass its strict
  scan.
- Hermes freezes the system prompt per session (HE-S13, HE-S33): `SOUL.md` alone would reach only new threads.
- Trial on real Hermes + Codex (`pnpm hermes:e2e voices`, gpt-6-astra, 2026-10-24): with the voice in `SOUL.md` only, the
  five answers to the same question were near-identical; Codex ranks its own base instructions above Hermes's
  (developer) prompt and keeps a neutral house style. With one short cue in the turn's preface, each came through
  (Banjo's arithmetic and terms, Neo's red pill, Skipper's “Aye”), still short and useful. Claude couldn't be tried on
  this host (its sign-in has expired).

| # | Decision | Why |
|---|---|---|
| AV-01 | **The face is the character: one pick sets how the agent looks and how it talks.** No separate style picker; the name stays the owner's to choose. | John's ask (“change the style directly too when we change the face”); one choice is easier than two that can disagree. |
| AV-02 | **Superseded in part by AV-09** (Hazel's voice). **Five voices, in `SOUL.md` after who the agent is** (`persona/voices.ts`, `AGENT_VOICES`): Dusty plain and friendly, everyday words, no jargon or jokes; Banjo a friendly engineer, the right technical term and exact numbers; Neo calm, cool and a little mysterious, with a light Matrix touch now and then (the white rabbit, red pill or blue pill, there is no spoon, déjà vu as a glitch, kung fu), answer first; Skipper an upbeat, decisive captain with a touch of sailing talk; Hazel warm, kind and organised, names a loose end once. | John set Dusty, Banjo and Neo; Skipper and Hazel follow their drawings and old roles (the Lead with the rosette and the wink, the Assistant with the clipboard). Short allusions, never quotes at length. |
| AV-03 | **A voice changes tone and words, not the reply rules**: `whombat.md`'s “How you talk” (concise-replies.md CNR-01…CNR-04, CNR-09, CNR-10) still decides how long a reply is and what stays out of chat (hashes, logs, paths), for every face. **Banjo may use technical terms** where CNR-09 asks for plain English; `SOUL.md` says so in as many words, so the two don't pull against each other. | John asked for a technical Banjo; picking Banjo is the owner's informed choice (the picker says “Technical”). The rest of CNR-09 holds. |
| AV-04 | **Outsiders and documents get a plain, neutral voice**: replies to people outside the Whombat (someone who reported feedback, a customer) and anything written for someone to send or keep (an email, a document, a pull request). | A customer shouldn't get Matrix lines from someone else's agent; a person's email is theirs, not the character's. |
| AV-05 | **No face, or one this runtime doesn't know, is Dusty's voice** (`DEFAULT_AGENT_FACE`), as it is Dusty's drawing (OA-S07). | One default for look and voice. |
| AV-06 | **Facts tests, plus a voices scenario to read**: `persona/prompt.test.ts` checks each face's `SOUL.md` carries its voice, all five differ, every one keeps the limits, and the preface's cue; `pnpm hermes:e2e voices` asks all five the same question on real Hermes with the real turn prompt and prints the answers (not part of `pnpm check`). | test-speed.md: facts, not sentences. |
| AV-07 | **whombat-app describes the five where people pick one** (setup's “Meet your agent” and Settings → Agent → Character, web and phone; app `docs/decisions/agent-voices.md`): a one-line description per face in `packages/client/src/agentFace.ts`, changed together with `AGENT_VOICES`. UI copy only, so not in contracts. | John: “let the user choose their agent (with a small description)”. |
| AV-08 | **The turn's preface reminds the agent of its voice in a few words** (`AGENT_VOICE_CUES`, `voiceCueLines`: “Your way of talking: calm and a little mysterious, with one brief Matrix touch.”), except on a turn about a tracker customer's report (AV-04). About 20 tokens a turn. A new face therefore reaches threads already going on the agent's next reply, though their frozen `SOUL.md` keeps the old wording. | The Codex trial above; and a face change should show at once, as people expect when they pick one. |

## Hazel talks like John, and every voice stays short (2026-11-05)

John, 2026-11-05 (main checkout): rename Hazel to John and give the character his own way of talking: accurate, short
and concise, friendly but direct. Agreed instead: keep the name Hazel (the faces are every Whombat's, an agent called
John beside John reads ambiguously in his own Chat, and anyone can already name their agent John) and give Hazel's face
that voice. He also reported very long replies whatever the face.

What Home's replies showed (7 days to 2026-11-05, Claude Opus 5.5, Banjo's face): Chat replies had a median of 750
characters, 192 of 245 over 500, most with bold headings and lists, also where nobody asked for detail (a
heat-pump alarm, an automation change). Home's real system prompt (a Hermes request dump) carried the reply rules
whole, but about 130 lines in, after Hermes's skills index. Before them came `SOUL.md`'s voice, “in every reply”, with
Banjo's “give exact numbers… name the actual cause and the fix”, and every turn ended with a voice cue and nothing about
length, while the thread above showed the agent's own long replies to copy.

| # | Decision | Why |
|---|---|---|
| AV-09 | **Hazel's voice is John's way of talking**: accurate, short and to the point, friendly but direct; the answer first and plainly (yes, no, “that won’t work, because …”), no hedging, padding or pleasantries; sure only when checked; a mistake said at once, kindly. Cue “accurate, short and direct, friendly without padding”; picker line “Accurate and direct. Short, friendly and straight to the point.” The name and drawing stay Hazel's. | John's style as a character anyone can pick. The warm, organised voice goes: John chose replacing it over a sixth face (a new drawing and a contracts release). |
| AV-10 | **`SOUL.md` says a reply is short, whatever the voice** (`voiceLimits`: one to three short sentences, under 60 words, longer only when asked), before any voice text can outweigh the rules further down. **Banjo gives the number that matters, in as few words as an engineer would**, not every number. | The voice sits first in the prompt and said “in every reply”; the length rule must sit there too. Banjo's wording invited reports. |

