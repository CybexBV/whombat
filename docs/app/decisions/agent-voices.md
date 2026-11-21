# The face is the character: how the agent looks and talks (AP-5500…AP-5509)

From 2026-10-24 the agent's face (one of the five, `AGENT_FACES`) also decides how it talks: the runtime writes the
picked character's way of talking into Hermes's SOUL.md (Whombat `packages/agent-runtime/src/persona/voices.ts`). The
clients show what each character is like where people pick one, so they choose their agent from a short description.
No contract changes: the descriptions are the clients' words.

| ID | Decision | Why |
|---|---|---|
| AP-5500 | **One pick, the character**: the face is how the agent looks and how it talks, never two choices. Where it is picked the field says CHARACTER (setup) or Character (Settings → Agent, web and phone; hint “How {name} looks and talks.”); setup's step reads “A name and a character”; the toast after a pick is “{Name} has a new face and way of talking.” Settings → Agent's part (tab) is “Name and character” on web and phone; the radios keep their spoken names (“Neo’s face”). | A look and a voice that can't disagree; the brief's copy. |
| AP-5501 | **A line under the faces says how the picked character talks**: the character's name in bold, ` · `, its description (`AGENT_FACE_STYLES`, `agentFaceStyle(face)` in `packages/client/src/agentFace.ts`, shared by web and phone). It follows the pick at once, is the radiogroup's description (`aria-describedby`) and a polite live region (`accessibilityLiveRegion` on the phone). Styled as the hints beside it: `--type-small` in `--mut` in setup, 13.5px `--mut` in Settings, the name in `--ink` at 600. | People choose their agent by what it is like, not only by a drawing. |
| AP-5502 | **In setup the name follows the face** while it is a character's own name (Dusty untouched, or any of the five) or empty: pick Neo and the agent is called Neo (`agentNameForFace`). A name someone typed stays. Saved as before with `onboarding.update` (`agentName`, `agentFace`). | The default agent is Dusty in Dusty's drawing; picking Neo should give Neo, not a Dusty in sunglasses. Empty counts as untouched: there is no name of the person's to keep. |
| AP-5503 | **Settings never renames on a pick**: a face pick sends only `face`. | A rename is a signed event and retitles Chats; it stays a deliberate Save. |
| AP-5504 | **A new character applies on the agent's next reply**, in new chats and threads already going alike: the runtime carries the face's voice in SOUL.md and in each turn's prompt (a one-line voice cue). So the hint promises nothing about which chats use it. | Matches what the runtime does. |
| AP-5505 | **The copy lives in the client and changes together with the runtime's voices**: the comment on `AGENT_FACE_STYLES` points at `voices.ts`; a test checks every face in `AGENT_FACES` has a description. | Two repos describe the same five characters. |
| AP-5506 | **The phone's setup has no face picker** (it names the Whombat only, AP-4963), so only its Settings → Agent → Name and character changed. Checked with logic tests (`characterLine`, the words), not on a device. | Nothing to change there. |
| AP-5507 | **Visual**: the onboarding “Meet your agent” baselines (light, dark) are regenerated; the other three steps still match within the baseline budget. Settings → Agent has no baseline; it was looked at in both themes at 1440×900. | Baselines follow the intended change. |
| AP-5508 | **Hazel's line is “Accurate and direct. Short, friendly and straight to the point.”** (`AGENT_FACE_STYLES.hazel`), with the runtime's new voice for her (agent-voices.md AV-09). The default pick is Dusty, so no baseline shows it. | John's way of talking, as Hazel's. |

