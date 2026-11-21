# Working on Whombat

## How to answer

- Always answer concisely and in plain English: short sentences, everyday words, the answer first. Leave out filler,
  jargon and long lists unless someone asks for more detail.

## Before changing anything

Read before changing anything:
- `ARCHITECTURE.md` — how the system works today (processes, the box, layout, the commit pipeline, turns, the sandbox).
- `DECISIONS.md` — the decisions in force. Do not reopen them; if something new is undecided, decide it,
  write it in `docs/decisions/<your-workstream>.md` (one file per workstream, create it if missing), move on.
- `docs/decisions/README.md` — which decision file covers what; read the one behind the code you change.
  `docs/decisions/archive/` is history: never follow it.
- `docs/design-handoff/README.md` — the product spec (tokens, components, screens, behavior).
- `docs/design-handoff/design/*.dc.html` — the visual and interaction reference. The seed data and all
  interactive logic are in the `<script data-dc-script>` block at the bottom of `Whombat Desktop.dc.html`.
- `docs/design-handoff/TODO.md` — the task list. Do not edit it; the orchestrator ticks boxes.

## Rules

- **The mocks win on visuals, copy and layout.** Copy is verbatim, including curly quotes (’ “ ”), the
  middle dot `·`, the minus sign `−` in diff stats and `€` formatting. Sizes, weights, spacing and radii
  match the reference exactly.
- Colors, fonts, radii, shadows only through `@whombat/tokens` (CSS variables on web). No hex literals in
  components except where the README defines fixed colors (code block text, status dots, avatar tones).
- Contracts first: any data crossing a process boundary has a Zod schema in `@whombat/core`. Change the
  contract (`packages/core`, `packages/protocol`, …) in the same commit as the server, web and mobile code that uses
  it, and keep them consistent. Control and the relay, which are not in this repository, see a change only through a
  contracts release (`pnpm contracts:release`, `docs/contracts/publishing.md`), and so do the appliance's harness and
  console page, which keep vendored copies; a breaking change is a new major (`SESSION_PROTOCOL.major`).
- All writes go through the server's commit pipeline. Never write to the DB from a route handler directly.
- Keep `@whombat/core` pure (no I/O, no Node-only APIs) so web and mobile can use it.
- Tests: unit-test logic (keys engine, approvals, signing, reducers, formatters). Server tests run against
  a real Postgres in a throwaway database. UI work is verified visually against the reference (see below).
  Check the facts a prompt or message must carry (names, ids, paths, tool names, a short key phrase), not its
  sentences: no assertions on long literal text, so rewording doesn't mean editing tests. Wait on events or
  inject short timeouts instead of sleeping, and give a new integration test file a reason to need Postgres
  (`docs/decisions/test-speed.md`).
- Accessibility: real buttons/links, visible focus rings, labels for avatars and status dots, 44px touch
  targets on mobile.
- **Agents and automations talk like people.** Everything Whombat, its agents and its automations post in a
  conversation is short, plain English a non-developer understands, like a colleague's chat message (one to three
  sentences unless someone asked for more). Instructions meant for an agent go to the agent, never into the chat;
  commit hashes, test counts, file paths, ids and logs stay out of messages unless the reader needs them to act (they
  belong in the pull request, the run page, folded details or “More detail”). When you add or change an agent prompt,
  an automation step, a notice or a card, write its visible words this way and read the result in a real thread
  (`docs/decisions/concise-replies.md`).
- **Automations follow the update by themselves.** When a change alters what an automation does or says (a step, a
  prompt, a message, a condition, a limit, its wording), the automations people already have take it with the update.
  Never leave the person a button to press, a chore, or an automation to make again. In the same change:
  keep the previous version's own form writable and name it in `EARLIER_RECIPE_WORDS`
  (`packages/core/src/automations/recipes.ts`, `recipeDefinition(recipe, words)`), so the server gives every automation
  that still has it today's when it starts (`apps/server/src/automations/words.ts`), and test that an automation made
  before the change comes out equal to one made today. Words a person changed themselves are theirs and stay
  (`docs/decisions/automation-recipes.md` AR-59).
- **What Whombat watches starts calm.** When you add a service, a server check or any new check, each check says
  whether Whombat watches it from the start (`startsOn` on `KindCheck` and `HostWatchCheck`). Turn it on only when it
  is very important (the thing or a part of it is down or broken now, data is at risk, a backup isn't happening, a
  security opening, money being lost, Whombat can't reach it any more) **and** Whombat can act on it or tell the person
  something useful. Everything else starts off and the person turns it on in What Whombat watches: updates and
  versions, forecasts and near limits, usage, quotas and limits, the service's own catch-all warnings, what is normal
  in that service (a failed request it retries, a failed download, a busy moment), what someone did on purpose
  (paused, switched off), advice about settings, warm or slow parts. When in doubt, off. Fewer than half of all checks
  start on (`docs/decisions/watch-defaults.md`).

## Documentation

- `ARCHITECTURE.md` describes the present. When you change how something works, change its section in place; never
  append history (“used to”, “no longer”, “since x.y”): git keeps that.
- `DECISIONS.md` lists what is in force, one short row each. When a decision replaces another, replace its row (keep
  the id) and mark the old row in its decision file “Superseded by …”; don't annotate rows in `DECISIONS.md`. A
  decision file whose subject is gone moves to `docs/decisions/archive/` (`docs/decisions/docs.md`).
- Code comments say why in plain words. Don't cite decision codes (`OP-17`, `HE-S200`) in new or changed code; link a
  decision file only when the reader needs its reasoning.

## Commands

Node 24 and pnpm (corepack). From a fresh clone:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm lint                       # Biome, and the repository's own text checks
pnpm typecheck
pnpm exec vitest run <file>     # one test file while you work
pnpm check                      # lint, notices, types and unit tests: run it before a pull request
pnpm dev                        # one development box: server :4400 (PORT), runner, agent-net
pnpm build:web                  # the page the box serves directly (apps/web/dist)
pnpm dev:web                    # the web app :5180 (WEB_PORT) and the widget, against a running `pnpm dev`
```

- `pnpm dev` and the server integration tests use the Postgres at `DATABASE_URL` (default
  `postgres://whombat:whombat@localhost:55432/whombat`): run one of your own there or point `DATABASE_URL` at yours.
  Use a free `PORT` and your own `WHOMBAT_HOME` when other instances run. `pnpm dev` migrates its database at start,
  `pnpm db:migrate` does it by hand; `pnpm db:reset` and `pnpm db:seed` are only for your own disposable database.
- The runner reaches the server at `http://localhost:$PORT`. Set `WHOMBAT_SERVER_URL` only when it must look
  elsewhere, and then change it together with `PORT`.
- Each test run works in a temporary folder of its own that is removed when the run ends
  (`scripts/vitest-temp-root.ts`), so leftovers of `mkdtemp(tmpdir())` can't fill the disk. A new Vitest config lists
  it in `globalSetup` and wraps itself in `withModuleCache` (`scripts/vitest-project.ts`): local runs keep transformed
  modules in `node_modules/.vitest-cache` (`vitest --clearCache` empties it), CI (`CI=true`) never does.
- The repository holds the runtime (`apps/server`, `runner`, `agent-net`, `cli`, `packages/agent-runtime`, …), the
  apps (`apps/web`, `mobile`, `widget`, `admin`, `packages/client`, `tokens`, `avatars`, `brand`, `tools/visual`) and
  the contracts (`packages/core`, `protocol`, `fixtures`, `canvas-schema`, `secure-channel`, `control-contracts`,
  `release`; `contracts/` holds their Go module, schema, vectors and release scripts). Developing the apps:
  `docs/app/README.md`; Android and iOS: `apps/mobile/README.md`.
- `appliance/` (the NixOS image, the manager, the release tools, the harness) and `hosts/` (the hub and its agents)
  are part of this repository, and a release is built from one commit of `main`: change them here, in the same
  commit as the runtime or web code that goes with the change (`docs/decisions/one-repo.md`). A build reads only the
  files it needs (`appliance/nix/lib/sources.nix`), so a commit changes only what is built from what it touched.
  Neither folder is in the pnpm workspace; each has its own tools and guide (`appliance/CLAUDE.md`,
  `hosts/CLAUDE.md`). A change to a lockfile, a `go.mod` or a `go.sum` needs its fixed hash refreshed
  (`appliance/scripts/ci/fixed-hashes.sh --check` says which). The agents of the hosts service are signed: a change
  to their code (`hosts/cmd/whombat-agent`, `hosts/internal/agent` and what they import) reaches every monitored
  server as a new agent, so make one only when it is meant.
- Versions: the app's is `apps/web/package.json`'s (`app-vX.Y.Z`), bumped when an APK or the hosted app is published
  (a phone installs only a higher `versionCode`); the contracts' is their packages' own (`contracts-vX.Y.Z`), bumped
  with a release other repositories need (`pnpm contracts:release`); the root `package.json` is the runtime's, which
  the appliance numbers its releases from: leave it.
- `pnpm contracts:gen:check` and `pnpm contracts:test:go` check the contracts' generated schema, vectors and Go code
  (CI runs them); run `pnpm contracts:gen` after changing a contract that has a cross-language form.

### Development

There is one way Whombat runs, the appliance's (`docs/decisions/hermes-engine.md` HE-48). `pnpm dev` runs it as a
development box with stand-ins (HE-49): no licence, the box's identity made at the first start, a stand-in manager
on `$WHOMBAT_HOME/manager.sock` (no relay, no AI client bundles), FakeGitHub, the commands' network daemon
(`whombat-agent-net`) and the scripted Hermes (`pnpm hermes:install` and `WHOMBAT_HERMES_BIN` for the real one). The
person's devices reach a box only through the encrypted session; on a development box a browser on the same machine
gets in at `http://localhost:<PORT+80>/` (the server logs the address; development enrolment). `pnpm db:seed` loads the
mock world and `pnpm dev:ask "<question>"` asks the agent in the person's Chat and prints the answer. The full
environment (relay, control, manager) is the maintainers': control and the relay are not in this repository, and the
appliance's harness (`appliance/harness`) runs it with them.

## Visual verification

The web app compares itself with the HTML references through `pnpm visual` (Playwright, fixture mode),
`pnpm ref:shot` and `pnpm visual:diff`; the harness is `tools/visual/README.md`. Use a free `WEB_PORT` (and
`WEB_VISUAL_PORT`) when other instances run. The browser journeys are `pnpm e2e:managed` and `pnpm e2e:box`; none of
these run in `pnpm check`. The product spec and HTML references are in `docs/design-handoff/`; do not delete them.
The HTML references need `support.js` next to them and load React from unpkg. The `start` prop default in
the `data-props` attribute selects the screen and `theme` selects light/dark. Compare UI work at the same
viewport (1440×900 unless stated) in both themes and fix differences before finishing.

## Git

- Work on a branch; small, focused commits with imperative messages (`web: add plan card`). Commit
  `pnpm-lock.yaml` changes with the package change that caused them. Never rebase shared branches.
- Contributions arrive as pull requests on GitHub, under the contributor agreement (`CONTRIBUTING.md`,
  `docs/legal/contributor-agreement.md`); `public-ci` must pass. Use the example ranges and names in fixtures and docs
  (`10.100.0.0/16`, `203.0.113.0/24`, `example.com`), never a real network, address or account.
