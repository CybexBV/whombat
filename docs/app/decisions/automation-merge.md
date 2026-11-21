# An automation merges its fix once its checks pass (AP-1042…)

John, 2026-10-10, on the Fusebox automation (“Assess new issues on DigitalPals/Fusebox”): “it succeeded successfully
but I would like the option to auto merge the PR to main as well. Can you add this to the automation as a setting?”
“Merging stays with a person” (AP-989) becomes the default of an opt-in: off until a person ticks it for that
automation. Contracts 0.70.0 (CT-326: `RecipeFix.merge`, `RECIPE_FIX_MERGE`, the `merge_pull_request` step, the automation
keys `merge` and `merge.main`, feature `automations.merge`); Whombat `docs/decisions/automation-recipes.md` (AR-44…AR-47)
for the server, which waits for the checks and merges. This is the app side. Without `automations.merge` every screen
stays as it was. No HTML mock exists for these additions: they follow the simple form, the step editor and the run page
(automation-recipes.md AP-966…AP-1015).

## Web

| ID | Decision | Why |
|---|---|---|
| AP-1042 | **“Merge the fix into main once its checks pass”** (`RECIPE_FIX_MERGE`'s label, its hint “After the review approves it. If checks fail or someone changes the pull request, it waits for you.” under it, `aria-describedby`), a real checkbox in WHEN IT’S A BUG after FIXED BY / REVIEWED BY, once the person picked Ask me before fixing or Fix it when sure, for a GitHub recipe, on a Whombat with `automations.merge` (`canMerge`). **Off by default**; Only assess, or unticking New issues, unticks it, and it stays unticked when fixing comes back. Ticked, the recipe's `fix` has `merge: 'checks'` (absent otherwise, so a recipe made before 0.70 saves the same JSON and stays current); Edit opens on the saved value; the live sentence ends “…, and merges the fix once its checks pass.” (`recipeSentence`). A tracker recipe never shows it, and its recipe never carries it even when the form state says so. | John asked for a setting per automation; never on by itself, as fixing (AP-986). A customer's report always waits for a person (CT-326). |
| AP-1043 | **What a fix goes through says so**: with merging ticked the line under the choices ends “…, then a pull request that closes the issue is opened and merged into main once its checks pass.” instead of “Merging stays with a person.” (`fixHow`'s `merge`). | The line says what will happen; it would be wrong otherwise. |
| AP-1044 | **Edit gives “Merge into main”** (`merge.main`, Can, limited to the repository) when merging is new — just ticked, or for another repository — keeping the other keys, as “Open pull requests” is for fixing (AP-990, `editPlan`); a key that asked becomes Can for the repository, one that covers it stays, and unticking leaves the keys as they are. A new automation gets the key from the server (AR-44). | One Save leaves the automation able to do what the box says. |
| AP-1045 | **The step editor knows 0.70** where the Whombat has `automations.merge`: “Merge a pull request” with REPOSITORY, PULL REQUEST (hint “{{steps.pr.prNumber}} is the one an earlier “Open a pull request” step opened.”), HOW IT MERGES (Squash and merge, Create a merge commit, Rebase and merge — GitHub's words for `MergeMethod`), WAITS FOR CHECKS (MINUTES) (“5 to 10080. If they haven’t passed by then, it waits for you.”) and IF IT MAY NOT MERGE (Skip this step / Stop the run; “Its key “Merge into main” says No, or the repository isn’t switched on.”). A new one is `merge` from the last “Open a pull request” step (`{{steps.<id>.prNumber}}`, its repository), else `{{trigger.number}}` in the GitHub trigger's repository, squash, a day, stop the run — the recipe's own defaults. A merge step already in a draft shows and saves unchanged either way. | Everything the simple form makes can be read and changed by hand. |
| AP-1046 | **Keys: “Merge into main” and “Merge”**, the catalog's labels (`KEY_CATALOG`), after “Comment on pull requests”: “For “Merge a pull request” steps into the repository’s main branch, once its checks pass.” and “For “Merge a pull request” steps into any branch, main too when “Merge into main” isn’t set.”, with the repository limit said (“Only on whombat/web.”); shown with `automations.merge`, or when held already. “Open pull requests” now says “Opening one never merges it.” instead of “Never merges: that stays with people.” | The keys a merge step needs, in the words the rest of Whombat uses for them. |
| AP-1047 | **The run page needs nothing new**: a merge step shows as any step — its name (“Merge the fix”), its state and time, the server's input summary (“Waiting for checks on PR #216”), its output text (“Merged PR #215 into main.”) or its error (“Checks failed on PR #10, so I left it for you.”), the PR link from `prNumber`, and “Review request #n” when its key asks. `FEATURE_NAMES`: “automations that merge their fixes”. **Fixture mode merges** (`automationFixtures.ts`): “Assess and fix new issues on whombat/web” merges its fixes (with “Merge into main” for whombat/web), run #43 merged PR #215 after its checks passed, a new run #47 (issue #213) waits for the checks on PR #216, run #42's folded steps are nine, and a created recipe that merges gets “Merge into main”. | Every new screen can be seen and tested without a Whombat; the server's words are plain already. |

## Android

The phone has no recipe form and no Keys tab (building automations stays on the desktop, AP-980…), so it only reads runs.

| ID | Decision | Why |
|---|---|---|
| AP-1048 | **A merge step reads as any step** on the phone's run page: “Merge the fix”, waiting with “Waiting for checks on PR #10”, done with “Merged PR #10 into main.”, failed with the server's reason as its error (`runSteps`; no kind of its own in `stepOutcome`). | The same words as on the web, without code that has to know the kind. |

## Checks

| ID | Decision | Why |
|---|---|---|
| AP-1049 | `recipeForm.test.ts` (off by default and offered only once a GitHub recipe fixes; ticked, the definition's last step, the sentence, `recipeIsCurrent` and the form read back; a recipe from before 0.70 opens unticked; unticked by Only assess and without New issues; never for the tracker; the line; Edit's keys), `automationModel.test.ts` (every step kind validates, a merge's defaults), `automations.test.tsx` (the checkbox, its hint and the sent recipe; none without the feature or for the tracker; Edit ticked and Edit's keys; runs #47 and #43; Keys rows; the editor's fields and a lossless save), the phone's `data/automations.test.ts`. Screenshots in fixture mode at 1440×900, light and dark: the form ticked and unticked (focus ring), Edit, runs #47 and #43, Keys, the step editor's card. `pnpm check` once. Noted for the server: the run page shows `UNTIL <wakeAt>` beside a waiting step, so `wakeAt` should be when it gives up (or null), not the next check; and a finished merge step keeps its input summary, so “Waiting for checks on PR #10” should change once it stops waiting. | DEV is fast: one `pnpm check`. |

### whombat-app 0.63.0

AP-1042…AP-1049; contracts 0.70.0. The dev APK is published as every release's is (AP-720).

# Fix it when sure may also fix what the repo's GitHub Actions opens (AP-1098…)

John, 2026-10-10, on two approval cards in Needs you (Fusebox #12 and #13, opened by the repo's version-check workflow
as `github-actions[bot]`): “Can you explain why these were not automatically approved?” Banjo was sure and the fix
small; the only gate that failed was “someone with access to the repo opened the issue”, and GitHub Actions has none
(`author_association` `NONE`). He said yes to an opt-in. Contracts 0.73.0 (CT-329: `RecipeFix.trustActions`,
`RECIPE_FIX_ACTIONS`, `GITHUB_ACTIONS_LOGIN`, feature `automations.trust_actions`); Whombat
`docs/decisions/automation-recipes.md` AR-55 for the server. This is the app side. Without `automations.trust_actions`
every screen stays as it was. No HTML mock: the checkbox is the merge checkbox's twin (AP-1042).

| ID | Decision | Why |
|---|---|---|
| AP-1098 | **“Also fix issues opened by this repo’s GitHub Actions”** (`RECIPE_FIX_ACTIONS`' label, its hint “Such as a workflow that opens an issue when a new version is out. Leave it off if a workflow copies what other people write into issues.” under it, `aria-describedby`, `data-recipe-fix-actions`), a real checkbox in WHEN IT’S A BUG / BUGS AND SUGGESTIONS right after FIX BUGS THAT ARE and AT MOST, once the person picked Fix it when sure, for a GitHub recipe, on a Whombat with `automations.trust_actions` (`canTrustActions`). **Off by default**; Ask me before fixing, Only assess, or unticking New issues unticks it, and it stays unticked when Fix it when sure comes back. **Ticking it unticks SKIP Bots** (GitHub Actions is a bot: its issues would start nothing); ticking Bots again leaves both ticked and the contract's “Issues GitHub Actions opens start nothing while bots are skipped: untick Bots.” stops the save, rather than unticking a box further down without saying so. Ticked, the recipe's `fix` has `trustActions: true` (absent otherwise, so every existing recipe saves the same JSON and stays current); Edit opens on the saved value; the live sentence says “…on its own when it’s sure (also in issues GitHub Actions opens); …” (`recipeSentence`). A tracker recipe never carries it, even when the form state says so. | John's yes, opt-in and narrow as the contract (CT-329). It sits with the rows that say what Fix it when sure takes up on its own, and its words are the contract's. |
| AP-1099 | **Nothing else needs to know.** No key: the gate reads the trigger's author, so Edit's keys (`editPlan`), Keys and the step editor are unchanged; the run page shows the server's story for its check (`recipeConditionStory`: “GitHub Actions opened the issue, and fixing those on its own is off”). `FEATURE_NAMES`: “automations that fix issues GitHub Actions opens”. The phone has no recipe form, and its list chips (the glance's `does`) and run steps are the server's, unchanged by 0.73, so Android needs nothing. Fixtures unchanged. | The contract put the change in the recipe's definition; the screens that read it already say what the server says. |
| AP-1100 | `recipeForm.test.ts` (off by default and offered only with Fix it when sure on GitHub; ticked, bots are no longer skipped, the definition's gate names `github-actions[bot]`, the sentence, `recipeIsCurrent` and the form read back; off makes the 0.72 definition; unticked by Ask me before fixing and without New issues, and never ticked where it isn't offered; Bots ticked again is the contract's problem; never for the tracker), `automations.test.tsx` (the checkbox, its hint, Bots unticked, the sentence and the sent recipe; none with Ask me before fixing or without the feature). Screenshot in fixture mode at 1440×900, light and dark: the checkbox ticked with its focus ring. `pnpm check` once. | DEV is fast: one `pnpm check`. |

### whombat-app 0.66.0

AP-1098…AP-1100; contracts 0.73.0. The dev APK is published as every release's is (AP-720).
