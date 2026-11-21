# The crew's new drawings and names on the web and Android (AP-4200…AP-4210)

Whombat `docs/decisions/crew.md` (CR-*, John's handoff “Whombat crew”, copied unchanged to
`docs/design-handoff/whombat-crew/`) on whombat-app: the five agents' new drawings and three new names, associate
**Dusty** (was Pippa), developer Banjo, operator **Neo** (was Dusty), lead **Skipper** (was Ace), assistant Hazel.
Contracts 0.114.0 (`ROLE_DEFAULT_NAMES`, `AGENT_CHARACTERS`, `ASSISTANT_NAMES` Neo, Dusty, Banjo, Hazel, Skipper; the
fixtures' crew renamed with their ids and handles). Builds on five-agents.md AP-643…AP-661: keys, role labels, accents,
tokens, the size rule, `<WhombatAvatar>`, alt text, roster order and “only the Assistant can be renamed” stay as they
are; the rows below say what changed.

| ID | Decision | Why |
|---|---|---|
| AP-4200 | **The fifteen files are the crew handoff's `svg/`, byte for byte**, replaced in place under the same names (`packages/avatars/svg/`; `index.test.ts` pins the new SHA-256s; biome still skips the folder; nothing runs SVGO). The web still shows each as one `<img>` from a hashed Vite asset: the hash changes by itself and no manual cache key exists. The files are 7–9 KB (were 19–23 KB, a third of it C2PA metadata), still past Vite's 4 KB inline limit, so each avatar stays one cached request. They share ids (`fur`, `eye`, `shirt`, `mc`, `bc`), so they are never inlined. | CR brief §2b; FA-06. |
| AP-4201 | **Android draws them as before** (AP-647, AP-903): Metro's transformer exports the markup, one `<Svg>` root per avatar, parsed once. The new files carry no `<metadata>`, so `files.test.ts` asks that the shipped markup is never larger instead of a third smaller. New in these files: `<clipPath>` (eyelids, the body's edge), already drawn by react-native-svg; a `<title>` (an unknown tag to react-native-svg's parser, which draws nothing for it); `role="img"` on the root, inside the `View` that carries the label or hides its children. Each file has two `id="nose"` (the gradient and the nose's group): react-native-svg keeps brushes and templates in separate maps and the browser takes the first (the gradient), so both draw it right. | FA-09. Checked in the unit test against the files and react-native-svg's sources, not on a device. |
| AP-4202 | **Names in one pass.** `AVATAR_DEFAULT_NAMES` (pinned to core) and every name in the app's code, copy, fixtures, stories, tests and specs: Dusty → Neo, Pippa → Dusty, Ace → Skipper at once (the crew's `rename.py`, letter and digit boundaries), then the same map for what it can't see: camelCase names (`pippaDm`, `dustySchedules`, `withJustHiredPippa`), `'DustyOperator'` in a label's text, `%2Fpippa` in a redirect and `prn_pippa000000`. Not renamed: `docs/decisions/`, `docs/design-handoff/` (the mocks keep their names), `vendor/`. | CR's rename order: a second pass would have made the new Dusty Neo (it did once, on the avatars package, and was undone). |
| AP-4203 | **Personal assistants follow John's option A** (CR): an assistant keeps its face and takes the new name. The one-Whombat fixture world's assistant, Dusty in the Operator's suit, is Neo in it; tests' assistants follow the same map. Settings → Profile → Your assistant shows the new drawings, its five faces in roster order labelled “Dusty’s face”, “Banjo’s face”, “Neo’s face”, “Skipper’s face”, “Hazel’s face” (`assistantFaceLabel` from core), and Suggest a name walks core's new `ASSISTANT_NAMES` (Neo first). | AN-04's intent: the name and the drawing keep matching. |
| AP-4204 | **0.36's legacy picker** (`LEGACY_ROLE_COPY`, runtimes before 0.37) follows the map too: researcher Dusty, operator Neo, sales Skipper. This replaces AP-651's “keeps its characters” for those three. | The brief's check: no Pippa or Ace outside history; the researcher and operator wear the Associate's and the Operator's drawings. |
| AP-4205 | **Tests that sorted or typed a name** follow the new names: lists by name read Banjo, Dusty, Muffin, Neo, Toffee, Waffle; the @ list and share-target tests type “d”, “du”, “dus” where they typed “p”, “pi”, “pip”. The audit story's event is Neo's, with prn_neo's fingerprint (`b047 f0ce`). | The fixtures' fingerprints follow the ids. |
| AP-4206 | **The avatars' visual spec compares with `crew-reference.html`** (`shootCrewReferenceElements`, `@whombat/visual-tools`: the page served with `svg/` beside it, each `#sizes-light img` / `#sizes-dark img`); the harness draws on its surfaces (`#f3ede3`, `#2b221d`). 60 comparisons: 0.000 % at 64, 40, 32, 24 and 16 px; the 160 px busts 0.008–0.090 % (2–23 anti-aliased pixels at the mouth, the Lead on dark the most), because the reference lays its images out at a fractional y. The budget stays 0.1 %. The `fiveAgents` reference stays registered as history. | FA-16 against the new reference; the brief's sizes, light and dark. |
| AP-4207 | **Specs against the desktop mock** keep the mock's names where they address the mock: `agents.spec.ts` opens the mock's own agent for each fixture agent (`MOCK_AGENT`: Toffee → sketch, Dusty → pippa, Waffle → hazel, Neo → dusty, Muffin → clover), `mockAudit.ts` hashes the mock's handles. | The mock is a reference and isn't renamed. |
| AP-4208 | **Baselines refreshed** where the crew shows: the hire screen (roles, name and keys), onboarding's five roles, every Settings baseline (the sidebar's crew), the Vault, Spend, Feedback, the chat-card and Modal stories and Foundations/Avatars, light and dark. 41 of these 115 screenshots failed on `main` already (unrefreshed since earlier releases), so the refresh takes that drift in too; the six that failed only on this branch were onboarding's five roles and the Avatars and Modal stories. Left alone, failing on `main` the same way: Cards/Assessment (no baselines), Primitives/Icon and the 760 px Feedback list. | The brief: refresh the avatar, story, hire and settings baselines; DEV fast left the rest stale. |
| AP-4209 | **Not wired:** the handoff's `expressions/` (ten per agent) stay in `docs/design-handoff/whombat-crew/`; nothing animates. The PNGs are not used by the app. | CR brief: for later. |

### AP-4210 whombat-app 0.117.0

AP-4200…AP-4209 as 0.117.0 on contracts 0.114.0 (`SESSION_API_LEVEL` 44, unchanged). Checks: `pnpm check` on the
merged tree (DEV fast; `router.test.tsx`'s brand page timed out once under load and passed alone and on the rerun);
the avatars spec (60 comparisons); the baselines, stories, feedback and machine specs (AP-4208); review screenshots of
the roster, an agent's profile, #billing-v2, Dusty's DM, the hire screen, onboarding, Settings → Profile → Your
assistant (faces “Dusty’s face” … “Hazel’s face”; Suggest a name offered Hazel, then Skipper, next to Neo) and Chat at
1440×900, light and dark. `an-shots.spec.ts` no longer reaches Home (“Good morning” is gone with Chat as the start), so
the Your assistant shots came from a throwaway spec. Released like 0.116.0 (merged into `main` with `--no-ff`, version bump, tag `app-v0.117.0`,
`pnpm release:dist` from the tag) and the APK published to DEV (AP-720).

## The art refresh and no more hiring (AP-4220…AP-4222)

John, 2026-10-21 afternoon: a second “Whombat crew” zip (“we have updated the characters, please ensure they are
updated fully in the project, the Chat avatars too”), and “check if there is still a ‘Hire an agent’ section … please
remove it. We abandoned multi-agent support a while ago.” Whombat `docs/decisions/crew.md` CRW-12…CRW-14.

| ID | Decision | Why |
|---|---|---|
| AP-4220 | **The refreshed drawings, byte for byte**, replace the fifteen files in `packages/avatars/svg/` again (`index.test.ts` pins the new SHA-256s), and the handoff copy in `docs/design-handoff/whombat-crew/` follows. Names, keys, roles, accents, the size rule and the component don't change. What changed: Neo (operator) wears slim oval sunglasses (a new `lens` gradient in every file), the Associate's and the Developer's glasses arms are shorter, and the PNGs and expressions follow. Every avatar in the app is `<WhombatAvatar>` from these files (web `<img>`, Android one `<Svg>` root per avatar), so the Chat, its threads, the sidebar, DMs, cards, Settings → Profile → Your assistant and the phone all show the new drawings without a code change; the avatars spec compares them with the new `crew-reference.html` (60 comparisons, 0.000 % at 64 px and below, ≤ 0.02 % at 160 px). | The brief: same files, same rules (AP-4200, AP-4201). |
| AP-4221 | **No more Hire an agent.** Gone: the hire modal (`HireAgentModal`, `?hire=1`, which the assistant shell already ignored), the `+` beside AGENTS and its “Hire an agent” row (the crew shell's AGENTS section now shows only while there is an agent to list), the roster's Hire an agent button, `roleDescriptions.ts`, the hire tests, specs (keyboard, a11y, managed updates, toasts) and baselines, the Modal, Button and Agents hire stories, and Android's `HireAgent` route (a “nobody to hire” placeholder since AN-08). An old `?hire=1` link is dropped. The assistant shell's onboarding tip now reads “Your assistant is ready when you are.” Kept: the client's hire helpers and key options (`hireKeyOptions`, `keyRowOptions(…, 'hire')`, `hirePicker`), which Configure → Access shares and which follow the contracts' `agents.hire`, the Modal's 1080 px `hire` width (the server console uses it), and the crew shell's onboarding (older Whombats only). | John: multi-agent support was abandoned; the crew shell only remains for older Whombats. |
| AP-4222 | **Checks for 0.118.0.** The avatars spec against the new reference (60 comparisons pass). The whole visual suite with `--update-snapshots=changed`: the crew's baselines still pass within their thresholds (the refresh is a pair of sunglasses and shorter glasses arms), so none was rewritten; only Button/Sizes changed (its label is now “Add a server”). Not taken in: the drift that fails on `main` the same way (Primitives/Icon slots, the narrow Feedback list, Cards/Assessment without baselines) and the 75 comparisons with the desktop mock (agents, approval, audit, canvas, cards, messaging, run, search, shell, toasts) that fail identically on `ef47a0af`. | DEV fast: one quick check; the drift isn't this change's. |

### AP-4223 whombat-app 0.118.0

AP-4220…AP-4222 as 0.118.0 on contracts 0.114.0 (`SESSION_API_LEVEL` unchanged; no contract change). Checks: `pnpm
check` on the branch: 4852 of 4854 pass; the two failures aren't this change's (`fixtures-wi.test.ts`'s Incus backups
fail on `main` the same way, a date in the fixture; `router.test.tsx`'s brand page timed out under load and passes
alone, as in AP-4210). Released like 0.117.0: merged into `main` with `--no-ff`, version bump, tag `app-v0.118.0`,
`pnpm release:dist` from the tag, the APK published to DEV (AP-720).

## Neo's suit in the small drawings (2026-10-21)

John asked why Neo's avatar doesn't wear a suit. The zip drew his black suit (white shirt, gold tie, pocket square) only
in `operator-bust.svg`; his head and small head had the plain black shoulder every head drawing has, so in the Chat (a
30 px head beside each message), its thread links (20 px), mentions and every place below 40 px he wore no suit.

| ID | Decision | Why |
|---|---|---|
| AP-4224 | **Neo's heads wear the bust's suit.** `operator-head.svg` and `operator-head-small.svg` carry the bust's `<g id="suit">` unchanged, inserted before `<g id="head">`: the three files share the 512 coordinates and the `bc` clip, so it lands where it does in the bust, and at 30 px the white V and gold tie still read. The handoff copy (`docs/design-handoff/whombat-crew/svg/` and its `png/operator-head-256.png`, `operator-head-small-64.png`, rendered by Chromium the way the zip's were: the old head re-rendered identically) gets the same files, so “byte for byte from the handoff” and the avatars spec's reference still hold; `index.test.ts` pins the two new SHA-256s. The other four keep their plain shoulder: their shirt colour still reads as them, which a black shoulder on a dark disc doesn't. | The brief describes Neo in a black suit with a gold tie (`agents.json` `look`); the zip lost it in the drawings most people see. |
| AP-4225 | **Checks for 0.119.1.** The avatars spec against the handoff's reference with the new heads (60 comparisons pass, 0.000 % at 32 px and below). The whole visual suite with `--update-snapshots=changed`: no baseline changed (the screen specs mask avatars); the same 75 desktop-mock comparisons and the same drift fail as in AP-4222 and weren't taken in. `pnpm check`: 4873 of 4873 pass. | DEV fast: one quick check plus the reference. |

### AP-4226 whombat-app 0.119.1

AP-4224 and AP-4225 as 0.119.1 on contracts 0.116.0 (no contract change), after 0.119.0. Released like 0.118.0 (AP-4223):
merged into `main` with `--no-ff`, version bump, tag `app-v0.119.1`, `pnpm release:dist` from the tag, the APK published to
DEV (AP-720).
