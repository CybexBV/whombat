# Whombat’s Hermes integration

Whombat runs the pinned Hermes Agent version (`packages/agent-runtime/src/hermes/pin.ts`), unmodified, and every turn
runs on Hermes’s own loop. Its `whombat` plugin supplies the `whombat_commands` terminal backend (each command in a sandbox of its own), fail-closed tool policy, Hermes's skills steps, prompt sections, Vault logins, a marker
while Hermes’s memory and skill review runs, and ChatGPT’s sign-in steps. ChatGPT subscriptions use Hermes’s built-in
`openai-codex` provider (`docs/decisions/hermes-native.md` HN-02); no Codex CLI is involved. API keys, the AI gateway
and local models use Hermes’s API clients.

Claude subscriptions use Nous’s **Claude Subscription DirectSDK (Experimental)** provider 0.3.3. Hermes owns the
conversation, tool execution, approvals, context compression, memory and skill reviews. The unmodified Claude Code
executable handles one model response at a time, with native tool execution disabled. Whombat’s former whole-turn
Claude runtime and Hermes source patch are removed.

## Source and installation

`vendor/claude-subscription-directsdk/UPSTREAM.json` pins the official plugin repository, revision and file hashes.
The included runtime files are unmodified and retain their MIT licence. Setuptools packages them as
`whombat_claude_directsdk`; the same Python distribution installs the `whombat` and
`claude-subscription-directsdk-experimental` Hermes entry points. No runtime plugin download or additional Python
dependency is required. The appliance builds this distribution from its runtime pin.

`pnpm hermes:install` installs the pinned Hermes source and this package for development. It uses a separate
unpatched source cache and refuses tracked source changes. `pnpm hermes:test` runs the integration’s Python tests
using that environment (`WHOMBAT_HERMES_PYTHON` can select another one). `pnpm hermes:test --hermes latest` (or `pin`,
or a release tag) runs them on another Hermes release instead: a fresh environment under `$TMPDIR`, installed the same
way without touching the pin, removed afterwards. CI's `hermes-latest` job runs it daily against Hermes's newest
release and only reports (`docs/decisions/hermes-native.md` HN-10).

## Authentication and isolation

### Claude

Onboarding stays `claude auth login --claudeai` in the person’s staged private home; a successful status check
activates it. Both existing and new sign-ins are consumed through the same `CLAUDE_CONFIG_DIR`. Whombat never reads,
copies or exchanges the OAuth credentials. No sign-out or reauthentication migration is required.

The runner sets `CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND` to its installed Claude executable. The small provider adapter
in `whombat_hermes/directsdk.py` gives Nous’s client only the native CLI environment allowlist for model, discovery and usage calls, excluding Whombat’s
MCP and Vault credentials. It also preserves TO-05’s omission of `browser_cdp` from Claude’s tool definitions. The agent’s commands receive no provider credentials or DirectSDK configuration paths.
Nous’s provider disables native tools, isolates request working directories, and provides cancellation of its own
process groups.

### After the answer

Hermes starts its memory and skill review from `finalize_turn`, before the answer goes back over ACP.
`whombat_hermes/review.py` wraps Hermes’s `spawn_background_review_thread` so a marker sits in
`$HERMES_HOME/whombat-review/` from then until the review’s thread ends (HN-08). The runner posts the answer at once and
keeps Hermes only while a marker is there (at most two minutes); without one the turn ends straight away.

### ChatGPT

`whombat_hermes/codex_auth.py` runs Hermes’s own `openai-codex` code, one step per process (`python -m
whombat_hermes.codex_auth <op>` with the Python beside `hermes`, JSON lines on stdout, anything Hermes prints sent to
stderr; HN-03). `login` is Hermes’s device-code login in a private staging home under the Hermes root — the person
sees OpenAI’s link and a one-time code, as with the Codex CLI before — checked with Hermes’s read-only resolution;
`install` then moves the staged `auth.json` into the person’s profile (the Hermes root, Hermes's default profile:
`docs/decisions/one-person.md` OP-08) under Hermes’s auth-store lock (never following a link there), and `remove` signs
out the same way. `token` keeps a Codex access token as Hermes’s own
credential. `usage` reads the plan’s windows on the person’s own login and `models` Hermes’s catalog without one. Only
Hermes reads, writes and refreshes `auth.json`; the runner looks at whether it is there, never inside it, and backups
never carry it. A turn outsiders start (`profiles/_feedback`) borrows the access token alone: `lend` refreshes it
first in the person's own profile, the Hermes way under Hermes's auth-store lock, when it runs out soon, and writes it
into the outsiders' profile as one API-key pool entry, without a refresh token; the runner removes it after the turn
(`docs/decisions/one-person.md` OP-S89).

### Generated profiles

`config/claude.yaml` and `config/codex.yaml` illustrate the generated profile. The runner rewrites it each turn, disables telemetry,
external-login adoption, catalogs, updates and lazy installs, and applies Whombat’s policy to Hermes tools. Feedback
assessments keep only feedback MCP tools and, when granted, the restricted browser; memory and learning are disabled.

## Vault logins and asks

`whombat_hermes/logins.py` (`docs/decisions/hermes-engine.md` HE-S302…HE-S306, `vault-simplify.md` VLT-20, VLT-45):

- The turn's Whombat logins are a Hermes login backend named `wb` (handles `wb:<entry>`), registered with
  `ctx.register_login_backend`, or straight into Hermes's login-backend registry when that door refuses a pip entry
  point. The profile turns it on with `vault.wb.enabled` (never in an outsiders' profile); 1Password and Bitwarden stay
  off. A fill asks the runner's logins socket for that one password (and a login's current two-step code).
- `browser_vault` is re-registered with `override=True` (the profile grants `tools.override`, and the older
  `allow_tool_override` beside it; where neither is granted Hermes's own stays) so Hermes's own handler
  runs with Whombat's save-login and code prompts on its thread, and a deadline that covers a login's wait. Each prompt
  asks the runner over the same socket; the runner posts the card in the turn's thread and waits for the person. A saved
  login comes back for Hermes to keep in its local store for that turn (the runner wipes it after) and fill; a code
  comes back once; anything else is a decline. Without the socket (an outsiders' turn) nothing is asked.

## Skills steps

`whombat_hermes/hermes_skills.py` runs Hermes’s own skills code on the person's skills folder for the runner
(`docs/decisions/hermes-skills.md`, HSK-03 and HSK-S01…): the bundled sync, restore and compare of a built-in, what
Hermes offers on a Whombat, the hub limited to Hermes’s official skills, its trusted GitHub repositories and skills.sh,
and Hermes’s scan and install policy. One step per process: `python -m whombat_hermes.hermes_skills <step>` with the
Python beside `hermes` (or `hermes whombat-skills <step>`), JSON on stdin and stdout, `HERMES_HOME` the runner’s skills
home, whose `skills` is a link to the skills folder (`$WHOMBAT_HERMES_ROOT/skills`, the person's profile's own: Hermes's
built-ins, hub installs and what the agent learned, in Hermes's layout).

## Verification

The Python suite checks provider discovery on unpatched Hermes, upstream source integrity, private sign-in reuse,
the commands’ credential isolation, policy hooks, the skills steps (offline, with Hermes’s hub sources
standing in), prompt sections, Vault integration (the registered backend, the prompts through the socket, a wait that runs out),
ChatGPT’s steps (OpenAI’s endpoints standing in) and the review
marker through Hermes’s own spawn path. TypeScript tests cover generated profiles and the ACP lifecycle, including
approvals, Stop, steering, resume and the wait for a review. `pnpm hermes:e2e` exercises the real Hermes on ChatGPT
(`WHOMBAT_HERMES_E2E_LOGIN` or a device-code sign-in) and `WHOMBAT_HERMES_E2E_CLI=claude` on DirectSDK. The browser and managed sandbox
scenarios are opt-in and must follow the host’s managed-resource rules.
