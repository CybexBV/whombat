# Repositories: Settings → Repositories and new repositories on the Whombat (AP-540…AP-549)

John, 2026-09-30: rename Burrow settings → “Software Dev” to “Repositories”, add creating a new repository on the device
(a name like `Whombat_Website` that becomes an active repository, with the owner's name and email), and make signing in
to GitHub from the web friendly. Contracts 0.27.0 (CT-192); the runtime side is Whombat `docs/decisions/repositories.md`
(RP-01…RP-06). Settings is not in the mocks; this follows the page's own language (bordered-row cards, section labels).

## Decisions

- **AP-540 The tab is “Repositories”, `?tab=repos`.** `?tab=dev` still opens it (links, bookmarks and the phone's “Sign
  in on the web” from before), mapped in `validateSettingsSearch`. Agent settings link to “Settings → Repositories”.
- **AP-541 Four sections, in the order people need them.** GITHUB (the connection), REPOSITORIES (the burrow's repos,
  whatever their source, with “New repository”), ADD FROM GITHUB (typed `owner/name` and the repos the connection
  reaches; owners, once connected), WORKING DIRECTORY (self-hosted only, AP-546). Adding from GitHub moved out of the
  list so the list is only what the burrow has.
- **AP-542 Each row has a 36px icon tile.** GitHub's mark (an inline Octicon in `currentColor`; Lucide has no brand
  icons) for GitHub repos, a branch on a brand-tinted tile plus the tag “On this Whombat” for local ones, so the two
  read apart at a glance. A local repo shows its folder name (`repoDisplayName`), its description and “created …”;
  self-hosted also where it is kept (mono, for `git clone`); a managed box has no shell, so not there.
- **AP-543 Signing in connects.** On a managed Whombat the GITHUB card says “Connect GitHub — Sign in with your GitHub
  account and {burrow} is connected right after”; GitHub's device code (or a token) runs in the card, and once the
  sign-in reports ready the burrow connects by itself (`github.connect`), toast “GitHub connected…”. No second button
  to find. Connected, the card shows `@login` in mono on a solid tile with a green dot, what runs as that account, and
  “Sync repos” (refresh icon). Self-hosted keeps the host's gh with its command (`gh auth login`) and the admin lock.
- **AP-544 New repository is a dialog.** Name (mono; live reasons: spaces, a leading `.`/`-`, `.git`, other characters,
  taken — including other letter case), optional description, and a card “First commit by {name} · {email} · main ·
  README.md” from `ReposResponse.create.author`, shown before anything happens. Create is disabled until the name is
  usable; a server refusal lands on the field. Done: the dialog closes, toast “Created {name}. Agents can work in it
  now.”, and the new row is highlighted for 2.4 s (`--hi`, none with reduced motion).
- **AP-545 Who sees it.** “New repository” shows only when the runtime has `repos.create` and says the caller may
  (`create.allowed`); an owner who may not sees the reason under the list; members see neither. The empty state says
  what to do next for each case and carries the primary “New repository” when allowed.
- **AP-546 No working directory on a managed Whombat.** It has no directory people reach (Whombat managed-runtime G-09),
  so the WORKING DIRECTORY card is only shown self-hosted.
- **AP-547 Feature name.** `FEATURE_NAMES['repos.create']` = “new repositories on this Whombat”.
- **AP-548 Fixture world.** `essentialsSettingsFixtures` answers `repos.create` (validation, names in use, 201),
  toggles local repos, and `repos.list` carries `create` with Mara as the author.
- **AP-549 Baselines.** `settings-connected-*` and `settings-not-connected-*` were regenerated for the new layout.

- **AP-550 GitHub's sign-in lives only in Repositories (John, 2026-09-30: “Move the github signin from AI Accounts to
  Repositories”).** The GITHUB card has two rows on a Whombat that reaches GitHub through people's own sign-ins: the
  burrow's connection, and “Your GitHub sign-in” (state, Sign out, or Sign in to GitHub / Use a token instead), for
  everyone, since members' personal agents push as them. AI accounts drops its GitHub row and says “Your GitHub sign-in
  is in Settings → Repositories” (a link). `GitHubSignInRow` takes a `title` and an `onSignedIn` (sign-ins only, never
  sign-outs) instead of `titled` / `compact`.
- **AP-551 An owner's sign-in connects, wherever the owner is in the flow.** Signing in on the card connects the
  burrow when it isn't yet (AP-543). An owner who signed in before (in AI accounts, under 0.17.1) sees “Connect GitHub —
  You're signed in as @x. Connect it for {burrow} …” with the primary Connect button; the page doesn't connect on its
  own, because connecting is a signed burrow event another owner may mean to make with their own account.
- **AP-552 GitHub switched off says so.** `github.mode === 'off'`: “GitHub is off — GitHub is switched off on this
  Whombat, so repos come only from here.”, no sign-in row, instead of the self-hosted gh text (which John saw on the
  dev instance, whose runtime ran with GitHub off: appliance IN-137).

## Tests

- `reposTab.test.tsx`: the name reasons; creating a repository (author shown, invalid name blocked, body sent, toast,
  row with tag and meta, switched on); a name in use refused before asking.
- `essentialsSettings.test.tsx`: `?tab=dev` opens Repositories; the device code signs in and connects without a click;
  AI accounts points to Repositories, where a token sign-in connects and shows Sign out (AP-550).
- `SettingsScreen.test.tsx`: tab label and `?tab=repos`, connected card, skeletons.
- `e2e-managed/github.spec.ts`: sign in and connected by itself.
