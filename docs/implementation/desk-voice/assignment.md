# Choose the desk screen's voice — build brief (2026-10-20)

John (main checkout, 2026-10-20): after the box started speaking with Kokoro (Whombat DK-36, appliance NX-291…NX-296,
candidate 0.117.0), he asked to choose the voice in Settings: “Yes I want it”.

## What the person sees

Settings → This Whombat → Screen, under the switch “Talk to {assistant}”: a **Voice** row (only where the screen lists
two or more voices this client knows: `knownDeskVoices(screen.voices ?? []).length >= 2`, and `voiceAvailable`). Six
voices, one chosen (`screen.settings.speechVoice`, default `heart`): each shows its name and kind
(`DESK_WORDS.settings.voices[v]` + `voiceKinds[v]`, e.g. “Heart · American · woman” or name with the kind under it) and a
**Listen** button that plays a short sample *in that voice, made by the box* (“Hi, I’m {assistant}. This is how I’ll
sound on your desk.”). While playing: “Playing…”; on failure `sampleFailed`. Choosing a voice saves at once
(`desk.update {speechVoice}`), like the other Screen settings. Hint line `voiceHint`. Only the paired person changes
it (as the other settings); owners who aren't the paired person see it read-only like the rest of the Screen settings.
All words come from `DESK_WORDS.settings` / `DESK_WORDS.errors` (copy verbatim, curly quotes).

## Contracts 0.105.0 (released; tag `contracts-v0.105.0`, tarballs `~/Code/whombat-contracts/dist-release/0.105.0/`)

Notes: `~/Code/whombat-contracts/docs/decisions/contracts.md` CT-610…CT-616. In short:
- core `DESK_VOICES = ['heart','bella','michael','fenrir','emma','george']`, `DeskVoice`, `DEFAULT_DESK_VOICE`,
  `DeskVoiceName`, `knownDeskVoices(names)`; `DeskSettings.speechVoice` (default `heart`), `DeskSettingsPatch.speechVoice`;
  `DeskScreen.voices?: string[]` (the box's voices, default first); words in `DESK_WORDS.settings` (`voice`, `voiceHint`,
  `voices`, `voiceKinds`, `listen`, `listening`, `sample`, `sampleFailed`) and `DESK_WORDS.errors.no_voice`.
- protocol: session op **`desk.voiceSample {voice}` → `DeskVoiceSample {audioWav}`** (base64 WAV ≤ 1 MiB), non-mutating
  (`READ`), read through an **export stream** (`open{spec: {kind: 'export', op: 'desk.voiceSample', input}}`, UTF-8 JSON
  of the output) because it is larger than a session message (64 KiB). `DESK_ERROR_CODES` gains `no_voice` (`conflict`).
  `SESSION_API_LEVEL` stays 40; a client offers Listen where `DeskScreen.voices` is present.
- local voice socket: `VoiceHealth.voices?` (default first), `VoiceTtsRequest.voice?` (another voice → 400). The runtime
  sends `voice` only when the health lists it (an older voice service refuses unknown members).

## The box (appliance, done by the lead)

`whombat-voice` health lists `["heart","bella","michael","fenrir","emma","george"]` (its default first) and `tts` takes
`voice` (Kokoro af_heart, af_bella, am_michael, am_fenrir, bf_emma, bm_george; the British ones with the British
lexicon). Kokoro speaks 24 kHz; a sample sentence is ~3 s, ~150 KB WAV.

## Ids

Whombat DK-50…DK-59 (`docs/decisions/desk-display.md`), DK-S50…DK-S59 (`docs/decisions/desk-display-server.md`);
app AP-3400…AP-3449; contracts CT-610…CT-616 (done); appliance NX-300…NX-319 (lead). A peer session (whombat-de,
“desk-fit”) uses DK-37…DK-43, DK-S40…S41, CT-601…604, CG-135…: don't use those. Its Whombat branch touches
`apps/server/src/desk/glance.ts`, `glance.test.ts`, one line in `service.ts`, and vendors contracts 0.104.0; if that
lands on Whombat `main` before you finish, merge `main` into your branch and keep 0.105.0.

## Rules for every stream (John's DEV rules)

- Work only in your own worktree and branch; commit small, imperative messages ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **Don't merge to main, push, release or ship**: the lead does.
- Quick checks only: `pnpm format`, then `TMPDIR=~/.cache/wb-tmp pnpm check` (one repo's check at a time), and for the
  server `pnpm test:server` once at the end (or the desk int tests while iterating). No VM tests, no CI, no waiting for
  future data. Use your own ports and throwaway databases; never stop or reset shared containers.
- Contracts first: don't change contracts; if something is missing, report it to the lead instead.
- Tests check facts (names, ids, codes), not long literal text.
- Record decisions you take in the decision files above, one line of why each.
- Finish with: branch, commits, what you verified (commands and results), what you didn't, open questions.
