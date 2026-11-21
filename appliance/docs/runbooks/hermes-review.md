# Reviewing a new Hermes Agent release (NX-492; Whombat HU-09)

> Commands written `dev/<name>` are the maintainers' (`bin/<name>` in their private whombat-ops). Anyone can run
> the same code: `node harness/src/dev/<name>.ts` (`dev/prune` is `prune-copies.ts`, `dev/devbox` is
> `harness/src/devbox/main.ts`), after `pnpm install --frozen-lockfile` in `harness/`.

For the agent that the T3 Code task “Hermes Agent release review” starts on The Titan every morning at 05:20, after the
latest-tested Hermes job (`docs/runbooks/hermes-latest-tested.md`) had its daily look for a new stable Hermes release.
Your job: before that release reaches Beta,
read what changed in Hermes against how Whombat uses it, change Whombat (the runtime, the plugin or `appliance/`) where
it must change, and let the job test and ship it. Stop and ask John when the change needs his decision. You only ever
ship to Beta, and only through the job.

Read first: Whombat's `CLAUDE.md`, its `ARCHITECTURE.md` (Hermes Agent), `docs/decisions/hermes-engine.md` and
`docs/decisions/hermes-updates.md`; here `docs/runbooks/hermes-latest-tested.md` and `docs/decisions/nixos.md` NX-430…435,
NX-483…NX-492, and Whombat's `docs/decisions/one-repo.md` OR-66.

Setup on The Titan: Node 24 on the `PATH` and the machine's `TMPDIR`, as the maintainers' guide (`CLAUDE.local.md`)
says. Whombat is `~/Code/Whombat`, the appliance its `appliance/` folder; other sessions use that checkout, so work in a
worktree where the maintainers' guide puts them and never switch its branch.

## 1. Find the release waiting for review

The job leaves each new version it found in `~/.local/state/whombat-hermes/markers/hermes-<version>.review` (JSON:
`version`, `tag`, `pinned`, `release`, `asked`). A version waits for review when it has that marker and none of
`.ok`, `.shipped` or `.failed` beside it, and isn't Whombat's pin yet. Nothing waits: reply with one line saying so and
stop. More than one: take the newest; the older ones are passed over by it. A `.failed` one that a previous review ran
and left for John stays his.

Confirm with `gh api repos/NousResearch/hermes-agent/releases` that
`v<version>` is a published, stable release, newer than Whombat's pin (`packages/agent-runtime/src/hermes/pin.ts` on
`origin/main`). When it isn't, say so in one line and stop.

## 2. Read what changed

- The release notes: `gh release view v<version> -R NousResearch/hermes-agent`.
- The changed files since the pin: `gh api repos/NousResearch/hermes-agent/compare/v<pin>...v<version> --jq '.files[].filename'`,
  and the patches of those that matter. For more, a clone of the tag in a new, empty folder under `$TMPDIR`
  (`git clone --depth 1 --branch v<version> …`); it is untrusted code: read it, never run it yourself (the tests below run
  it the way Whombat does).
- Whombat depends on these parts of Hermes. Check each that changed:
  - the plugin API and hooks our plugin uses (`packages/hermes-whombat/whombat_hermes/plugin.py`: tools, system-prompt
    sections, terminal environment provider, CLI command, `pre_tool_call`), `hermes_cli/plugins*`, `tools/registry.py`;
  - ACP, which the runner drives (`acp_adapter/`; Whombat `packages/agent-runtime/src/hermes/provider.ts`);
  - the config keys Whombat writes (`packages/agent-runtime/src/hermes/config.ts`, `assessment.ts`) against
    `hermes_cli/config.py` and `toolsets.py` (a renamed or new toolset: assessments turn all of Hermes's own off);
  - the browser and logins (Whombat's own browser tools, HE-S300; Hermes's `browser_vault`, `browser_cdp`,
    `browser_dialog`; a new tool that runs model-written code in Hermes's process must stay off);
  - skills (`tools/skills_sync.py`, `skills_hub*`, `agent/skill_utils.py`; `whombat_hermes/hermes_skills.py`);
  - model providers and clients (`plugins/model-providers/`, `agent/anthropic_adapter.py`; the Claude and Codex routes);
  - sessions and memory (`hermes_state`, session store migrations: they are one-way);
  - packaging: `pyproject.toml`, `uv.lock`, `flake.lock`, `pm/lock.json` (`appliance/nix/packages/hermes`),
    and whether Whombat's patches (`packages/hermes-whombat/patches/`) still apply;
  - anything new that reaches the network or runs code (NX-435): new tools turned on by default, new background work.
- Run the plugin's tests on it from a Whombat worktree: `pnpm hermes:test --hermes v<version>`.

## 3. Decide

- **Nothing to change** (the usual case): go to 4 without a branch.
- **Whombat must change, and you can make the change yourself**: a worktree and branch `hermes-<version>`, based on
  `origin/main`, with every change in it (the runtime, the plugin and `appliance/` alike). Don't move the pin; the job
  does that on top of your branch. Follow `CLAUDE.md`: decisions in their files, `ARCHITECTURE.md` in place, tests. Verify in Whombat
  `pnpm format`, `fast-test` where the maintainers have it (it runs what the change needs, `appliance/`'s steps
  included; else `pnpm check`), `pnpm hermes:test --hermes v<version>` and `--hermes pin`.
  Commit (`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`), don't push.
- **Stop and ask John** when any of these hold, with the branch left unpushed and nothing run in 4:
  - the change touches where code runs or what it can reach: the sandbox, credentials and sign-ins, the network wall,
    a new way for model-written code or a tool to run outside the commands' sandbox;
  - something people use goes away with no equal replacement, or what the assistant can do changes visibly;
  - it needs a contract change (`packages/core`, `packages/protocol`, … and a contracts release) or a database migration;
  - the tests fail and the cause or the fix isn't clear;
  - you would have to reopen a decision in `DECISIONS.md`.

  Write John a short message in this thread, in plain words: what Hermes changed, what it means for Whombat, the
  options with your recommendation. The job keeps the version back meanwhile.

## 4. Test and ship through the job

From `~/Services/whombat-jobs` (the jobs' own clone of Whombat, which each run pulls onto `main`; `git -C
~/Services/whombat-jobs pull --ff-only` first):

```sh
appliance/release-tools/hermes/latest-tested --version <version>                                 # nothing to change
appliance/release-tools/hermes/latest-tested --version <version> --whombat-ref hermes-<version>  # your branch
```

It builds that Hermes with its activation check, checks the pin agreement and runs one turn on a box in a VM (20–40
minutes); on a pass it pushes your branch with the pin onto `main` in one commit and runs `candidate`, which publishes it
to Beta (Home among its boxes). It says when `main` moved past your branch: rebase the branch onto `origin/main`, verify
again, run it again. A
failure leaves the version held back (`markers/hermes-<version>.failed`) and its log under `~/.local/state/whombat-hermes/logs/`:
fix it on the branch and run again, or stop and ask John (3). Never push to `main`, run `candidate` or `promote`, or touch production
yourself.

## 5. Check Home and report

Home takes the release within the hour. With remote help on and its help code from John (the maintainers' guide,
“Looking inside Home”), `dev/support Home --code <code> logs whombat-hermes-check -n 5` shows the Hermes check's last
lines (“hermes-check: ok”). Without the code, say you couldn't look. Don't change anything there.

End with a few plain sentences for John: the Hermes version, what changed for Whombat (or “nothing needed changing”),
what you tested, what you couldn't, and that it is in Beta. Remove your worktree and the merged branch.

Rules: never search `/` or `$HOME` as a whole; never print secrets (the job's settings file holds the review's address);
VMs only through the job (`agent-resource`); Postgres `:55432` for server tests, in a throwaway database.
