# Whombat avatars: five default agents (website + management interface)

Paste everything below the line into your coding agent. Run it from the root of the repo that holds the website and the management interface. If they're in separate repos, run it once in each and skip the section that doesn't apply.

Files in this zip:

- `PROMPT.md`: this file.
- `agents.json`: the five agents, with key, default name, role label, accent colours and file paths. This is the source of truth for roster data.
- `svg/`: three finished SVGs per agent. They're plain SVG with no filters, masks or scripts, on a 512×512 viewBox with a transparent background.
  - `<key>-bust.svg`: use at **40 px and up**.
  - `<key>-head.svg`: use at **25–39 px** (typically 32).
  - `<key>-head-small.svg`: use at **24 px and below**. It has thicker strokes, larger eyes and no chest details.
- `png/`: raster fallbacks for places that can't show SVG, such as email, Open Graph images and some native notifications. Don't use them in the web UI.
- `reference/Whombat v2 Five Agents.dc.html`: the visual reference. Open it in a browser with `support.js` next to it. It shows every agent at 160, 64, 40, 32, 24 and 16 px on light and dark surfaces.

---

## Context

We've changed our approach. Instead of twelve narrow roles, Whombat now ships **five more capable default agents**. All earlier avatar work (the 12-role roster, CSS-layer avatars and the Rive rebuild) is superseded. Avatars are now **static SVG files**. There's no animation, no Rive runtime and no per-instance JS.

| key | default name | role label | accent / deep | accessory |
|---|---|---|---|---|
| `associate` | Pippa | Associate | #8f7fc9 / #6a5aa3 | round glasses |
| `developer` | Banjo | Software Developer | #5aa37a / #3e7b58 | over-ear headphones |
| `operator` | Dusty | Operator | #b99346 / #8d6d2d | antenna beacon |
| `lead` | Ace | Lead | #c65d6e / #a33346 | gold rosette |
| `assistant` | Hazel | Assistant | #a6ad43 / #74792a | clipboard |

Use these names exactly. The role label is **"Software Developer"**, not "Developer". **Hazel** is only the Assistant's *default* name: users can rename their Assistant, but the avatar never changes. The other four names are fixed.

Stop and ask me before changing anything in this contract.

## 1. Before you start

Find where the website and the management interface define:

- the agent roster, role enum or type, and any seed or fixture data
- the existing avatar component(s) and avatar image assets
- every place an agent appears: lists, pickers, filters, chat threads, activity feeds, onboarding and hire flows, settings, pricing and feature pages, emails, and OG images

Write that list down first and use it as your checklist.

## 2. Assets

1. Copy `svg/` into the app's static assets, for example `public/avatars/agents/`. Keep the file names. Don't re-export, re-optimise or redraw them. If your pipeline runs SVGO, exclude these files or disable the `removeViewBox`, `cleanupIds` and `mergePaths` plugins for them, because the gradient ids must survive.
2. Copy `png/` only where a raster is genuinely needed (email templates, OG images).
3. Serve the SVGs with long-lived cache headers and a content hash or version query (`?v=2`), so the old images don't linger.
4. Load each SVG as an `<img>` (or CSS `background-image`). **Don't inline the SVG markup into the DOM.** Each file uses simple gradient ids (`g1`, `g2`, …, `pf`, `pl`) that would collide if two avatars were inlined on one page.

## 3. One shared data module

Move `agents.json` into a single typed module, for example `agents.ts`, used by **both** the website and the management interface. If they're separate repos, publish it as a small shared package or copy it once and note the source.

```ts
type AgentKey = 'associate' | 'developer' | 'operator' | 'lead' | 'assistant';
interface Agent {
  key: AgentKey;
  defaultName: string;   // Pippa, Banjo, Dusty, Ace, Hazel
  roleLabel: string;     // Associate, Software Developer, Operator, Lead, Assistant
  renamable: boolean;    // true only for assistant
  accent: string;
  accentDeep: string;
}
```

Display name resolution: `agent.renamable && customName ? customName : agent.defaultName`. Trim the custom name, cap it at 24 characters, and fall back to the default if it's empty.

## 4. Avatar component

Reuse the existing avatar component if there is one, and replace its internals. Don't create a parallel component.

```
<AgentAvatar agent="lead" size={40} />
```

| prop | type | default | meaning |
|---|---|---|---|
| `agent` | `AgentKey` | required | which agent |
| `size` | number (px) | `40` | rendered width and height |
| `crop` | `auto` \| `bust` \| `head` | `auto` | `auto` picks the file from size |
| `decorative` | boolean | `false` | when true, `alt=""` |

- **File choice (`crop="auto"`):** size ≥ 40 → `-bust.svg`; 25–39 → `-head.svg`; ≤ 24 → `-head-small.svg`. Forcing `bust` or `head` still uses `-head-small.svg` at 24 px and below.
- Render a square `<img>` with explicit `width` and `height` (no layout shift), `loading="lazy"` below the fold, `decoding="async"` and `draggable="false"`.
- **No background, border or circular crop by default.** The art is drawn to sit on any surface, light or dark. If a design needs a chip or circle behind the avatar, add it in the parent with the agent's `accent` at about 14% alpha, never by clipping the image.
- **Alt text:** `"{displayName}, {roleLabel}"`, for example "Ace, Lead". Use `decorative` when the name is printed right next to the avatar.
- Delete the old avatar renderer, its CSS layers, the animation loop, and any Rive runtime or `.riv` loading, together with their dependencies. Static usages must make no extra network requests.

## 5. Website

- Replace every agent roster, card or illustration with the five agents in the order of the table above (Pippa, Banjo, Dusty, Ace, Hazel).
- Agent cards: 160 px bust avatar, then the name, then the role label. Use the bust at 96–160 px on feature and pricing pages.
- Remove or rewrite any copy that mentions the old roles or the old count ("12 agents", "Architect", "Reviewer", "Support", "Designer", "Finance", "Legal", "Sales", "Marketing", and the names Sketch, Clover, Swatch, Penny, Tilly, Harper and Echo). Don't invent new marketing copy. Leave a `TODO(copy)` and list the spots in the PR.
- The marketing site always shows **Hazel** for the Assistant. Rename is a product feature, not a website one.
- OG and social images that feature agents use `png/<key>-bust-512.png`.

## 6. Management interface

- **Roster and types:** the role enum, pickers, filters, and seed or fixture data contain exactly the five keys. Remove the other roles from the UI.
- **Where avatars appear:** agent list rail and tables at 32 px (head); chat threads and activity rows at 24 px (head-small); mentions, chips and notifications at 16–20 px (head-small); agent detail header and the hire or create flow at 96–160 px (bust). All of them are static.
- **Assistant rename:** on the Assistant's settings page, add a "Name" field prefilled with "Hazel", plus a "Reset to Hazel" action. Persist it per workspace. Every place that shows the Assistant's name uses the display-name resolver from §3, including chat, notifications and emails. The role label stays "Assistant".
- **Accent colour:** use `accent` for the selected-card border, the radio or checkbox fill, and small role markers; use `accentDeep` for text or icons on light accent backgrounds. Check 4.5:1 contrast for any text you place on an accent.

## 7. Migrating existing workspaces

Existing customers may have agents with the old role keys. Don't delete their data. Write a migration that maps old keys to the new ones, and **stop and confirm this mapping with me before running it**:

| old key | new key |
|---|---|
| researcher | associate |
| developer, architect | developer |
| operator, support | operator |
| sales, reviewer | lead |
| assistant | assistant |
| designer, finance, legal, marketing | ⚠ no obvious match — ask me |

Agents migrated to a new key take the new default name (an old custom Assistant name is kept). Keep the old key in a `legacyRole` field for one release.

## Acceptance checks

- The website and the management interface show exactly five agents: Pippa (Associate), Banjo (Software Developer), Dusty (Operator), Ace (Lead) and Hazel (Assistant).
- "Developer" appears nowhere as a role label; it's always "Software Developer".
- Renaming the Assistant updates every surface in the management interface, and "Reset to Hazel" restores the default. The avatar doesn't change.
- Avatars match `reference/Whombat v2 Five Agents.dc.html` at 160, 64, 40, 32, 24 and 16 px, on both light and dark surfaces. At 24 px and below, the small variant is used.
- No avatar uses animation, a canvas, the Rive runtime, or inlined SVG markup. Each avatar is one cached image request.
- There are no layout shifts when avatars load, and every non-decorative avatar has alt text.
- `grep` finds no remaining references to the seven removed role keys or names, except in the migration and `legacyRole`.

## Deliverables

1. The updated website and management interface, with the shared agent module and the avatar component.
2. The Assistant rename setting.
3. The migration script (not yet run) and the mapping questions.
4. A PR description listing every changed surface, the `TODO(copy)` spots, and screenshots of the roster on light and dark surfaces.
