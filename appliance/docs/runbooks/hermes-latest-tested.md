# The latest-tested Hermes job (Whombat HU-03, HU-06, HU-07, HU-09; NX-485, NX-490, NX-492)

> Commands written `dev/<name>` are the maintainers' (`bin/<name>` in their private whombat-ops). Anyone can run
> the same code: `node harness/src/dev/<name>.ts` (`dev/prune` is `prune-copies.ts`, `dev/devbox` is
> `harness/src/devbox/main.ts`), after `pnpm install --frozen-lockfile` in `harness/`.

Whombat's assistant runs on Hermes Agent, pinned to a release Whombat tested (Whombat HE-10, HU-01). This job follows
Hermes's stable releases, tests each new one with Whombat's plugin, runtime and this appliance, and when everything
passes pins it on Whombat's `main` and sends it to Beta with the maintainers' `candidate` (IN-835). Hermes is pinned in
two places that must agree, the runtime's `packages/agent-runtime/src/hermes/pin.ts` and this folder's `flake.nix` and
`nix/packages/hermes`; the job moves both in one commit (Whombat OR-66). Home and every Beta box
then take it by itself within the hour, as a runtime update: a runner restart, no reboot, and the manager goes back by
itself when the new Hermes fails its activation check (NX-483, NX-484). Production only ever gets it through
`promote`, on John's word.

Script: `appliance/release-tools/hermes/latest-tested` (implementation `appliance/harness/src/dev/hermes-latest.ts`).

## What one run does

1. **Detect.** GitHub's releases of `NousResearch/hermes-agent`: the newest that is published, not a pre-release and
   tagged `vX.Y.Z` (never `+canary`). When `pin.ts` and `nix/packages/hermes` on `origin/main` both have it already,
   or it is older, the run ends. A version that
   failed before is skipped until `--retry-failed`.
   **Review first** (NX-492): with `WB_HERMES_REVIEW` set, the daily run doesn't test a new version itself. It leaves
   it for review (`markers/hermes-<version>.review`) and ends; the T3 Code task “Hermes Agent release review” (05:20
   every day, Opus 5.5) finds it there, reads the release against Whombat's use of Hermes, makes what must change on
   a branch, or stops and asks John, and runs this job with `--version` and its branch
   (`docs/runbooks/hermes-review.md`). When nobody reviewed it within two days, the daily run tests it as it is.
2. **Move the pin** in a scratch worktree of `origin/main`, or of `--whombat-ref` (a review's branch), under
   `work/<version>/`: `pin.ts` (version, tag, commit); `flake.nix`'s `hermes` input and the three uv2nix inputs at the
   revisions Hermes's own `flake.lock` names for that release; `version` and `pinnedRev`; `nix flake update` of those
   four inputs. One commit.
3. **Test: install it and use it** (NX-490). The appliance's flake of that commit: `.#whombat-hermes` (the build, and its
   install check: the activation's check, which starts that Hermes with Whombat's plugin and providers and opens an
   ACP session), `checks.hermes` (the pin agreement) and the `runtime-live-turn` VM test (the runtime on a box, one
   turn through Hermes), whose driver runs inside `agent-resource run`. The plugin's own tests are not part of it: they
   run in Whombat's CI on Hermes's newest release. Any failure stops the run: nothing is committed to `main`,
   nothing is shipped, `markers/hermes-<version>.failed` stops retries, and the log says which step failed and why.
4. **Pin on `main`.** The commit, pushed fast-forward only through the checkout's hooks while `candidate`'s lock is
   held. When `main` moved during the test, the pin commit goes onto the new `main` only if nothing the test covered
   changed there (the plugin, `packages/agent-runtime/src/hermes`, `appliance/nix/packages/hermes`,
   `appliance/nix/modules/hermes.nix`, `runtime-live-turn`); otherwise nothing is pushed and the next run tests again.
   The local checkout is fast-forwarded when it is on a clean `main`.
5. **Ship to Beta.** `candidate --what "hermes agent <version>" --why "Hermes Agent <version> came out and passed
   Whombat's tests."`. Home's “Updated to …” then names the Hermes version (HU-06).

A run that finds nothing new takes a few seconds. A version that is tested takes about 20–40 minutes, most of it the Nix builds and the VM
test.

## Install it on The Titan (an operator's step, as for the client job)

The unit runs the script from its own clone of Whombat, `~/Services/whombat-jobs`, which it pulls (fast-forward,
`main`) before each run, with the same `TMPDIR` as a candidate started by hand (their lock is a file there). The
maintainers' `instance/install-jobs --yes` makes the clone and installs the units (their `retire-dev.md` “The jobs”).

```sh
cp "$(git -C ~/Code/Whombat config whombat.ops)"/instance/hermes-latest-tested.env ~/.config/whombat/hermes-latest-tested.env   # defaults are fine
"$(git -C ~/Code/Whombat config whombat.ops)"/instance/install-jobs --yes   # the clone, both units, both timers
systemctl --user start whombat-hermes-latest-tested.service        # a first run now (journal below)
```

It needs Node 24, `pnpm`, `git`, `nix`, `flock`,
`agent-resource`, push access to Whombat's `main` (the checkout's own `origin` credentials), and `gh` logged
in or `GITHUB_TOKEN` (GitHub's API rate limit). State: `~/.local/state/whombat-hermes/` (`logs/hermes-<version>-*.log`
and the VM test's log beside it, `markers/hermes-<version>.{review,failed,ok,shipped,candidate-failed}`, `work/` the
scratch worktree while a run lasts, `job.lock`).

## Operating it

```sh
journalctl --user -u whombat-hermes-latest-tested -n 100
appliance/release-tools/hermes/latest-tested --dry-run          # test what's new; show the commit and its push, change nothing
appliance/release-tools/hermes/latest-tested --retry-failed     # test a version that failed before again
appliance/release-tools/hermes/latest-tested --version 0.23.1   # test, pin and ship this release
appliance/release-tools/hermes/latest-tested --version 0.23.1 --whombat-ref hermes-0.23.1
                                                                # a review's branch: tested with the pin, pushed with it
appliance/release-tools/hermes/latest-tested --dry-run --version 0.23.2 --whombat-ref HEAD   # rehearse a change to the job
```

- **The review** (NX-492): the T3 Code task “Hermes Agent release review” (05:20 every day, a new thread per run; a
  morning with nothing to review is one line), `WB_HERMES_REVIEW=1` in the settings. Its runs show in T3 Code; a run that stopped to ask John
  waits there, and the version waits with it (the job tests it as it is after two days unless it failed). The branch is
  pushed only as it was tested, on top of its `main`: when `main` moved past it, the job says so and the branch is
  rebased and tested again. No review: leave the setting empty.

- **A failed version**: read its log. When the new Hermes changed something Whombat uses (a plugin test, the config
  keys or ACP the runner relies on, a new way Hermes reaches the internet, NX-435), the fix is a change in Whombat
  (the runtime, the plugin or `appliance/`); once it is on `main`, `--retry-failed`. Boxes keep the Hermes they have.
- **`candidate-failed`**: the pin is on `main`, but `dev/candidate` stopped (its log is under `$TMPDIR/rel-<version>/`);
  run `dev/candidate` again after fixing its cause, as for any candidate.
- **Pause it**: `systemctl --user stop whombat-hermes-latest-tested.timer`.
