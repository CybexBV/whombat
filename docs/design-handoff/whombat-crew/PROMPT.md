# Whombat crew: new art and names for the five agents

Paste everything below the line into your coding agent. Run it from the Whombat runtime repo; it
names the other repositories it has to change and the order to change them in.

Files in this zip (`whombat-crew/`):

- `PROMPT.md`: this file.
- `agents.json`: the five agents with key, new default name, previous name, role label, accent colours, a short
  description of the look, and file paths. This is the source of truth for roster data.
- `svg/`: three finished SVGs per agent, same file names as before. Plain SVG on a 512×512 viewBox with a transparent
  background; gradients and clip paths only, no filters, masks, scripts or embedded images.
  - `<key>-bust.svg`: use at **40 px and up**.
  - `<key>-head.svg`: use at **25–39 px** (typically 32).
  - `<key>-head-small.svg`: use at **24 px and below**. Thicker strokes, larger eyes, no chest details.
- `png/`: raster fallbacks for places that can't show SVG (email, Open Graph images, native notifications), same names
  and sizes as before. Not for the web UI.
- `expressions/svg/`: ten expressions per agent (`<key>-<expression>.svg`), same framing as the bust. **For later. Do
  not wire them in this change.**
- `reference/crew-reference.html`: the visual reference. Open it in a browser straight from the unzipped folder (no
  server, no dependencies). It shows every agent at 160, 64, 40, 32, 24 and 16 px on light and dark, plus the
  expressions.

---

## Context

The five default agents get new characters. The roles stay exactly as they are; only the drawings and three names
change. This replaces the art from `docs/design-handoff/five-agents/` (2026-10-02, decisions in
`docs/decisions/five-agents.md`, FA-01…FA-18) and builds on it. Everything FA settled about how avatars are built and
used still holds unless this brief says otherwise: static SVG files loaded as `<img>`, the file choice by size (FA-07),
`<WhombatAvatar>` and its props (FA-06), react-native-svg on Android from bundled assets (FA-09), no animation (FA-08),
role tokens (FA-05), alt text “{name}, {role label}”.

| key | new name | was | role label | accent / deep | look |
|---|---|---|---|---|---|
| `associate` | **Dusty** | Pippa | Associate | #8f7fc9 / #6a5aa3 | chestnut fur, round glasses, freckles |
| `developer` | Banjo | Banjo | Software Developer | #5aa37a / #3e7b58 | silver fur, taped square nerd glasses, pens in the pocket |
| `operator` | **Neo** | Dusty | Operator | #b99346 / #8d6d2d | dark slate fur, black suit, gold tie, slim oval sunglasses |
| `lead` | **Skipper** | Ace | Lead | #c65d6e / #a33346 | honey fur, cowlick, a wink, gold rosette |
| `assistant` | Hazel | Hazel | Assistant | #a6ad43 / #74792a | cocoa fur, clipboard |

Use these names exactly. Keys, role labels, accent colours, the size rule, the component API, the roster order
(associate, developer, operator, lead, assistant) and “only the Assistant can be renamed” do **not** change. The gold
logo badge the old drawings wore on the shirt is gone on purpose.

### The one trap: “Dusty” changes role

Dusty was the **Operator** and is now the **Associate**. A blind find-and-replace will get this wrong. Everywhere
(code, copy, prompts, skills, fixtures, tests, docs), rename in this order and check each hit:

1. **Dusty → Neo**, only where Dusty means the Operator (today that is every current mention outside migrations and
   decision history).
2. **Pippa → Dusty**.
3. **Ace → Skipper**. Match the whole word and check context; “Ace” is short and also appears in unrelated words and
   identifiers.

Banjo and Hazel stay. Decision records under `docs/decisions/` and old migrations are history: don't rewrite them.

## 1. Before you start

Read `CLAUDE.md`, `docs/decisions/five-agents.md`, `docs/decisions/assistant-name.md` (AN-01…AN-10) and
`docs/decisions/avatars.md`. Then list every place, in every repository below, that holds:

- the character data: `ROLE_DEFAULT_NAMES`, `AGENT_CHARACTERS` / `domain/characters.ts`, `ASSISTANT_NAMES`,
  `assistantLookFor`, the tests that pin them, token tests;
- the SVG and PNG files and how they're imported (Vite asset imports on web, bundled assets on Android, the website's
  `public/avatars/agents/`, the console's vendored copies);
- the names in text an agent or a person reads: agent prompts and persona code (`packages/agent-runtime/src/persona/`),
  skills (for example `skills/lead-craft/hand-work-to-the-team/SKILL.md` has the crew table, and
  `skills/lead-craft/one-three-one-rule/references/example.md` uses the names), notices, emails;
- seed data, the test world (`apps/server/src/seed/test-world.ts`), fixtures, stories, visual baselines, and tests
  that assert names.

Write that list down first and use it as your checklist. `grep -rnw` for Pippa, Ace and Dusty gives you most of it.

## 2. Repositories and order

Contracts first, then the app, then the runtime, then the website and the console. Follow each repository's own
`CLAUDE.md` for branches, checks, versions and releases. Ship to DEV only; **never deploy production**
(app.whombat.com, the website's hosting) unless John says so.

### 2a. whombat-contracts (`@whombat/core`)

- `ROLE_DEFAULT_NAMES`: associate Dusty, operator Neo, lead Skipper (developer Banjo, assistant Hazel unchanged).
- `AGENT_CHARACTERS`: the new `defaultName`s, verbatim from `agents.json`; accents unchanged.
- `ASSISTANT_NAMES` (AN-02): **Neo, Dusty, Banjo, Hazel, Skipper**. Neo goes first: he is now the character of
  servers and the home, the reason AN-02 put the Operator first. Update the comment that explains the order.
- `assistantLookFor` follows from `AGENT_CHARACTERS` (Neo → operator, Dusty → associate). Update its doc comment,
  which uses the old example.
- Make sure no new name is in `HIRE_NAMES`, `PERSONAL_AGENT_NAMES` or `RESERVED_AGENT_NAMES` (none are today), and
  that the tests pinning names, characters and tokens pass with the new values.
- The retired-name grep exceptions (FA-11) gain **Pippa** and **Ace**. Dusty is not retired; it moved.
- Release a new contracts version.

### 2b. whombat-app (web, Android, avatars)

- Replace the 15 SVG files **in place** with the ones in `svg/` (same names, so imports don't change). Don't
  re-export, re-optimise or redraw them. If a pipeline runs SVGO, exclude them or disable `removeViewBox`,
  `cleanupIds` and `mergePaths`, because the ids must survive.
- Load them as `<img>` as today (FA-06). **Never inline the markup**: every file uses the same simple ids (`fur`,
  `eye`, `shirt`, `mc`, `bc`…) for gradients and clip paths, and inlined copies would collide. On Android each
  avatar stays its own `<Svg>` root (FA-09).
- Content hashes in the Vite asset URLs change by themselves. Bump any manual cache key (for example `?v=2` → `?v=3`).
- Update mock crew, fixtures, stories and copy that use the old names, following the rename order above. Refresh the
  avatar visual baselines against `reference/crew-reference.html`.
- Settings → Profile → Your assistant (AN-05): the five faces show the new drawings, and “Suggest a name” follows the
  new `ASSISTANT_NAMES` order.
- Release a new app build.

### 2c. Whombat runtime (this repository)

- Consume the new contracts release and the new app build (the pinned tarballs and the lockfile).
- Copy this zip's contents to `docs/design-handoff/whombat-crew/`. Keep `docs/design-handoff/five-agents/` as it is:
  it's the history the FA decisions point to.
- Rename the names in prompts, persona code, skills, the seed and test world and tests, following the rename order.
  Agents read the skills, so the Lead's crew table must say Dusty is the Associate and Neo the Operator.
- Write a migration with the next free number (0131 at the time of writing) that renames existing agents. It runs in
  every burrow, is data only, idempotent, and follows 0062/0063 (DM titles and their search documents follow; old
  message text is not rewritten). It covers:
  - **Team agents** (crew shell; active, not system, not personal assistants), only when an agent still has its role's
    *old* default name: the Operator **Dusty → Neo** first, then the Associate **Pippa → Dusty**, then the Lead
    **Ace → Skipper**. Running the Operator first frees “Dusty”. When the new name is taken by another active
    principal, use the FA-03 fallback (first free `HIRE_NAMES` name) and log it.
  - **Personal assistants** whose name is one of the old character names. **Stop and ask John before writing this
    part.** His own assistant is very likely “Dusty”, wearing the Operator's face (AN-02, AN-04), which is now Neo's
    suit. Offer him these two choices:
    - **A, keep the face and take the new name** (recommended): Dusty with the operator face → Neo, Pippa with the
      associate face → Dusty, Ace with the lead face → Skipper. The name and the drawing keep matching (AN-04's intent).
    - **B, keep the name and switch the face**: a Dusty gets the associate face (the new Dusty), and so on.

    Either way, an assistant whose name doesn't match one of those name-and-face pairs is left alone, and names stay
    unique in the burrow (AN-03).
- Add an integration test for the migration next to `five-agent-names.int.test.ts` and `active-agent-names.int.test.ts`.
  It covers the order (an Operator Dusty and an Associate Pippa in one burrow), a taken name, an assistant, and a second
  run that changes nothing.
- Record the decisions in a new `docs/decisions/crew.md` (CR-01…): the new art and names, the rename order, the
  migration, John's assistant choice, and what stays from FA.

### 2d. Website (`Whombat_Website`)

- Replace `public/avatars/agents/*.svg` and the OG PNGs, update `src/data/agents.json` (copied, source noted), and
  bump the version query. The roster still shows five cards in the same order: 160 px bust, name, role label.
- Rename names in copy following the rename order; leave `TODO(copy)` where a sentence needs more than a name swap.
- Merge to the website's `main`. Don't publish: whombat.com is production.

### 2e. Appliance console (`appliance/console/ui`)

- Refresh the vendored avatars from the new app release (FA-13). The console guide is Hazel; her drawing changes, her
  name doesn't.

## 3. What not to do

- Don't change keys, role labels, accents, tokens, the size rule, the component, alt text, or which agent can be
  renamed.
- Don't add animation or wire the expressions. They're delivered for a later change and stay in
  `docs/design-handoff/whombat-crew/expressions/`.
- Don't draw, crop or recolour the art. If something looks wrong, stop and report it.
- Don't rewrite decision history or old migrations.

## Acceptance checks

- Every surface (web, Android, website, console, emails, OG images) shows **Dusty** (Associate), **Banjo** (Software
  Developer), **Neo** (Operator), **Skipper** (Lead) and **Hazel** (Assistant) with the new drawings, in that order.
- Avatars match `reference/crew-reference.html` at 160, 64, 40, 32, 24 and 16 px on light and dark; at 24 px and below
  the small variant is used, between 25 and 39 px the head.
- A new burrow's crew is named Dusty, Banjo, Neo, Skipper and Hazel. A second Operator still gets a `HIRE_NAMES` name.
- In an existing burrow after the migration, the Operator once called Dusty is Neo and the Associate once called Pippa
  is Dusty. The personal assistants follow the option John chose. No two active principals share a name.
- The Lead's skills and every agent prompt name the right agent for each role. Ask a Lead in a real thread who runs the
  servers: the answer is Neo.
- `grep -rnw` finds no Pippa or Ace outside the migrations, decision history, the old `five-agents` handoff, vendored
  tarballs and changelogs; every remaining “Dusty” means the Associate.
- Each avatar is still one cached `<img>` request; no inlined SVG, no layout shift.
- Each repository's checks pass; the runtime's per `CLAUDE.md` (`pnpm check`, `pnpm test:server`, visual check).

## Deliverables

1. Contracts, app, runtime, website and console changes, released and on DEV (per each `CLAUDE.md`), production
   untouched.
2. The migration with its test, and John's answer on personal assistants recorded in `docs/decisions/crew.md`.
3. A short summary of what changed where, the `TODO(copy)` spots, and screenshots of the roster on light and dark.
