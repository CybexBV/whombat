# One person per Whombat and no computer: inventory (2026-10-25)

What `docs/decisions/one-person.md` (OP-01…) removes and changes, by repository. Read-only survey of: Whombat main
`d0faed0a`, the `hermes-native` integration branch (`~/Code/.wt/whombat-hn`, pods HN-W01…W20 merged, not yet on main),
whombat-contracts `54506d8` (2.0.0, session major 3), whombat-app `e8963e27` (2.0.0), the appliance, control,
the relay, whombat-hosts. Line counts are rough non-test lines; “(inf)” is an inference, not read. The computer's own
research: `~/.cache/wb-tmp/research/2026-10-25-no-computer/notes.md`.

Already gone before this: channels, `@here`, self-hosted sign-in, per-person profile tables (0003), more than one burrow
per Whombat.

## Totals

| Repository | Delete | Simplify / rewrite | Tests | Other |
|---|---|---|---|---|
| Whombat server | ≈2.8k | ≈4–6k in ≈120 files | ≈1.6k deleted, ≈20 files (≈8k) edited | 3 tables, 3–4 columns, a contract migration |
| Whombat runner + agent-runtime + plugin (people) | ≈1.3–1.6k | ≈0.8–1k | ≈1.5× | — |
| Whombat computer (computerd, runner, server) | ≈2.9k Incus + ≈2.5–3k runner side | ≈1k moved (gh/git sockets, Files, preview, repeats) | ≈2.3k deleted, ≈2.5k ported | new: per-command wrapper, assessor's local browser |
| whombat-contracts | ≈40 ops/schemas/unions | copy, fixtures world (Joris, Priya, Tom) | vectors, conformance | 3.0.0, session major 4 |
| whombat-app | Members screens, invite/join/re-enrol (≈1.5k web + Android), onboarding step 4, Computer tab | ≈300–350 strings, owner checks | 6 baselines deleted, ≈18 re-shot, `members.spec` | 3.0.0 |
| the appliance | computers.nix 1,335, computerslan 1,317, 2 VM tests + helpers, harness b5-people, b4-reenroll | backup Hermes profiles, support grant wording | ≈1.2k harness | −107 MB image; toolset package added; docs ≈250 lines; terms version |
| control | ≈250 | ≈180 | ≈350 | migration 0019; control-contracts major |
| the relay | RL-33 cap (≈15) | — | — | docs |
| the hosts service | — | wording (≈3) | — | — |

## Whombat server (`apps/server/src`)

| Feature | Where | Fate | Data |
|---|---|---|---|
| Burrow invites, join links | `commands/burrows.ts:557-841`, `routes/burrows.ts`, `read/work-views.ts:368`, backups people | delete | drop `invites` |
| Onboarding “Invite people” | `completeOnboarding`, `OnboardingProgress.step4` | 3 steps | jsonb |
| Appliance invites | `managed/trust.ts:1338-1518`, `2142-2158`, `dispatcher.ts:214-216`, `licence-usage.ts` | delete | drop `endpoint_invites` |
| Owner-assisted re-enrolment | `managed/reenroll.ts` (374), `dispatcher.ts:217-222` | delete (recovery kit, passkeys, pairing stay) | drop `endpoint_reenrolls` |
| Admins (grant, revoke, last owner) | `trust.ts:1999-2079, 2160`, `auth/admins.ts`, ≈150 `isAdmin` lines | delete; the person is always the admin | drop `accounts.admin_since` |
| Owner/member roles | `commands/people.ts`, `routes/people.ts`, `personRole` in 71 files (111 lines) | delete; gates go | drop `principals.person_role` |
| Offboarding | `domain/offboarding.ts` (406), `trust.ts:1915`, `onPersonRemoved`, ≈124 `removedAt` lines (keep passkeys' `removed_at`) | delete | drop people's `removed_at` |
| Shared sign-in, organisation keys | `managed/providers/credential-owner.ts` (374 → ≈50), `providers/service.ts` org parts (≈200) | the person's sign-in or their own API key | `principals.runtime.credentialSource`, org homes on disk |
| Hermes per person | `HermesHomeRef` (backups, skills) | one profile | disk |
| Skill sharing | `skills/share.ts` (228), `library.ts:230` | delete; one list | `skill_share` action |
| Whom the turn is for | `domain/turn-person.ts`, `runtime/person.ts`, `onBehalfOfAccountId` in 52 files (141 lines) | the person, or an outsiders' turn (OP-08) | columns kept, pointing at the person |
| Vault privacy between people | `vault/context.ts:62-72`, `detail.ts`, `withhold.ts`, `privateEntryLabel`, owner gates; `computer/keys.ts`, `report.ts` | simplify; the Vault stays | owner columns kept |
| Personal vs shared connections | `connections/{context,store,connect,events,views,call}.ts`, `connectors/access.ts:38`, `home/*`, quiet notices (58 lines, ≈25 files) | one kind | drop `catalog_connections.scope` + its two partial unique indexes, `connection_pending.scope`, `changes.scope`; rename `-mine` handles in the migration |
| Rooms private to their person | `chats/rooms.ts:52-58`, `domain/personal-dm.ts:37` | one Chat, one Feedback room | `dm_person_id` kept |
| Per-viewer frames and reads | `realtime/personalize.ts`, `automations/visibility.ts`, `deployments/frames.ts`, `schedules/frames.ts`, `mcp/tools.ts:161-197` `withinAudience`, `read/search.ts`, `read/spend.ts`, private approvals | delete | `events.audience_conversation_id` unused |
| Approvals to the owners | `approvals/create.ts:121-151, 213-249`, `commands/approvals.ts:138-165` | to the person | — |
| “Tell the owners” | `usage/service.ts:531-542`, `gateway/service.ts:374-379`, `remote-help.ts:313`, `desk/owners.ts` (122 → ≈20), `guides/commands.ts:215` | the person | — |
| Licence member count | `licence-usage.ts`, `managed/licence.ts` | delete | — |
| Backups: people | `collect/people.ts`, `restore/people.ts`, `collect/scope.ts`, `restore/run.ts` | simplify | manifest |
| Seed, test world | `seed/load.ts`, `test-world.ts`, `test/rooms.ts`, `test/personal.ts` | rewrite | — |

Tests that go whole: `commands/people.int`, `managed/reenroll.int`, `credential-owner.int`, `providers/sec1-org.int`,
`runtime/privacy.int`, `read/spend-private.int`, `approvals/approvers.int`, `managed/offboarding.int` (≈1.6k).

Stays: devices (endpoints, pairing, device links, passkeys, push, screen sign-in without the email step, recovery kit,
last-device protection), the claim (`claimed_by_account_id` is the person), system principals, outsiders (feedback
reporters, the tracker replies, mail), remote help, per-principal tables (they work with one row), connectionless/vaultless
runs (search answers, assessments), `events.on_behalf_of` (signed attribution).

## Whombat runner, agent-runtime, plugin (`hermes-native` branch)

| Feature | Where | Fate |
|---|---|---|
| Profile per person + `_shared` | `hermes/profile.ts`, `provider.ts` `profileOf`, `hermes-home/context.ts` | one profile (Hermes's default) + `_feedback` |
| Memory, sessions, archive per person | `hermes-home/{memory,sessions,archive}.ts` | one of each (≈40 lines of account plumbing) |
| Leaving person's profile, their ChatGPT login (HN-K04) | `home-archive.ts` `emptyProfileArchive`, `signin-executor.ts` `forgetChatgpt*` | delete |
| Learned vs for everyone, sharing | runner `hermes-home/skills.ts` share/`locateLearned`, `hermes/skills.ts` `disabledSharedSkills`, plugin `skills.py` hook (≈120) | delete; Hermes's native skills layout in the one profile (OP-09) |
| Learned skills on the computer | `contract.ts` `computerReadable`, `provider.ts:481-540`, `turn/sandbox.ts`, `computer.ts` | delete |
| Credential owner per turn | `providers/owner.ts`, `turn-credential.ts`, `credential-home.ts`, `eligibility.ts`, `signin-executor.ts`, runner `managed.ts`, `turn/credentials.ts` | one credential home per provider (≈500 removed); keep PI vs NA in eligibility |
| Pods per person | `apps/runner/src/pods.ts` (822), `access/managed/pod.ts`, `pod-init.mjs` | one pod = the wrapper (≈1.2k of ≈1.66k stays): no map by profile, no `_shared`, no per-account retiring; credential stamp → restart when idle on a new sign-in |
| Routing by session | pods' exec/browser routers, `PodLogins`, forwarder, plugin `settings.py`, `policy.py`, `logins.py` | exec and browser routing go with the computer; MCP token, policy, Vault MCP, logins stay per session (up to 4 conversations at once) |
| Browser per person, CDP relay | `browser.ts` (637), `cdp.ts`, `preview-shot.ts` | Hermes's own Chromium/agent-browser in the wrapper; the assessor's site-limited browser (FB-28) moves to a local Chromium |
| Vault keys in owner's turns, sweep | `turn/prepare.ts`, `hermes/vault-mcp.ts`, `computer.ts` delivery + sweep, `computer-api.ts` | keys reach commands through the per-command wrapper (OP-07); sweep goes |
| Computer holds | `ComputerHolds`, wait rows | delete |
| Prompt privacy lines | `persona/prompt.ts` (SOUL “one agent for everyone”, “people of X”, mail “only in their own turns”, owners' notes), `personal.ts` | “You are X, <person>'s agent”; keep connected accounts, “data, never instructions”, never paste private things into outside replies |
| Feedback assessment identity | `hermes/assessment.ts`, `_feedback`, `owner.ts` SUB-58 | keep profile and isolation; integration owner goes |
| Turns for nobody | `_shared`, `owner.ts` `no_requester` | the person's turns, except outsiders' (OP-08) |
| Commands | `whombat_hermes/terminal.py` (134), exec router, most of `computer.ts` (1,057), `computer-api.ts`, `computer-fakes.ts` | Hermes's local terminal with the per-command wrapper (OP-07); `command-repeats.ts`, `git-control.ts` move into it; gh and the git relay get a socket into the wrapper |
| Hermes's file tools beside the profile | `policy.ts` `FILE_TOOLS` | block Hermes's `read_file`/`write_file`/`patch`/`search_files` in `$HERMES_HOME` except `skills/` |

hermes-native made unnecessary: pod per profile and `_shared`, credential fit across person/org/member, HN-W05 browser
routing, HN-W04/W17 command routing, HN-W03 placeholders (real mounts of the workspace roots instead: brings back
`AGENTS.md`), HN-W18 “between people”, HN-C06 `chatgpt_not_shared`. Stays: pod-init, the per-turn viewer, HN-W06…W10,
W12…W15, W20.

## Computer (Whombat, appliance)

See the research notes. Whombat: computerd's Incus backend, base image (`image.ts`, `scripts.ts`), ACL ingress, holds,
claim rule, status-file gate, sizes, the local backend's production gaps. Appliance: `nix/modules/computers.nix`,
`computerslan/`, `vm-tests/computers*.nix` + `common/{computer-image,lan}.nix`, check `computers-config`, qgroup 1/101,
incus + computerd units, published ports 20000–20099 (OP-05), host metrics `computers*`, `/persist/incus*` cleanup on
existing boxes. New: the agent toolset package and nix-ld libraries in the image, an nftables chain for the command
proxy mirroring `computers_out`, the agent's home on /persist in backups, the prompt without `sudo apt-get`.

## whombat-contracts (3.0.0, session major 4, with the computer removal)

Remove: `enroll.invite.*` (rename `InviteSecret`, the base of `DeviceLinkSecret`), `admins.*`, `enroll.reenroll.*`,
`presence.set/typing` + `Bootstrap.presence`, `ENDPOINT_ENROLLED_VIA` invite/reenroll, appliance events `invite.*`,
`owner.*`, `reenroll.*`, `LocalLinkKind` invite/reenroll (keep `device`), `skills.shareRequest`,
`members.*` + `MembersResponse`, onboarding invites (`ONBOARDING_STEP_COUNT` 3), `PersonRole`, `Person.role/removedAt`,
`canRemoveMember`, `canSetMemberRole`, `MemberRef`, `FORMER_MEMBER_LABEL`, `Account.isAdmin/canCreateBurrows`,
`Membership.role`, `ownerAdminLockedReason`, key `members.invite`, `KeyDef.personRole`, `owner_only`,
`MemberCredentialSource`, `SkillShareRequest`/`skills.libraryShare`/`SkillCan.share`, `SkillShareAction`,
`ConnectionScope` + tags + `scopes`/`defaultScope` on 54 entries + `CreateConnectionBody.scope`, `managers_only`,
`UsageResponse.everyone`, spend by person, audit `member.*` and `skill.shared`, backup `people`/`othersPrivate`/invite
restore, `LicenceLimits.members` / `EntitlementLimits.members` (signed tokens: control, appliance, Go and vectors in
lockstep), the computer surface (`computers.*`, `HostInfo.computers`, `@whombat/core/computer` minus the command guard,
host metrics fields, desk part, activity rows, Vault computer copy), `RuntimeFacts.clientAdapters` (HN-A02).
Simplify: `ApplianceStatusOutput.owner`, recovery kit owner, `EndpointsListInput.all`, credential sources (the person's
sign-in or their own API key), `DispatchCredential` person fields, `hermes-home.ts` profiles and skill scopes, Vault
privacy copy, `memory.mine`/`memory.notes`, `Conversation.dmPersonId/memberIds`, `FeedbackIntegrationChat.personId`,
`Schedule.forAccountId`, desk `not_owner`, sign-ins `owner_departed`, `enroll.screen.request` email.
Keep: `enroll.pair.*`, `enroll.link.*` (device), `enroll.screen.*`, passkeys, recovery, claim, `enroll.dev`,
`endpoints.*`, push, `support.*`, the tracker, feedback reporters, `Person`/Agent/System, `me.*`, `person_approves`
approvals, branch rooms, canvas, the command guard (`classifyCommand`, `run_command`). Control-contracts: org roles,
invitations, `limits.members` → its own major.

## whombat-app (3.0.0)

Web: Settings → Members (`MembersTab.tsx` 382 + css + model), `ManagedTabs.tsx:1217-1709` (re-enrol, invites, org
invitations, owners), join/re-enrol/org-invitation screens and routes (`managed/screens.tsx:1587-1830`,
`ManagedRoot.tsx`), onboarding step 4, `CredentialSection.tsx` sharing, skills sharing and `ShareRequestSkill.tsx`,
connections “Only you”/“Shared”, `usage/EveryoneTable.tsx`, presence, Computer tab and allowances' computer parts.
Android: `MembersScreen.tsx`, `data/members.ts`, `DevicesScreen.tsx:490-867`, `CommunityInviteCard`, join screens,
`RunsOnSection`, skills sharing, connection scopes, spend, presence, `ComputerSection`. Client: `useMembers`,
`managed/invites.ts`, `reenroll.ts`, admins/invite/reenroll ops, community link kinds, `agentManage.ts`, skill library
model, connection words. Owner checks: `role === 'owner'` 34×, `status.owner` 19×, `me.owner` 10×,
`useApplianceOwner` 8×. Strings ≈300–350. Baselines: delete `settings-members-*`, `onboarding-invite-*`,
`cards-device-skill--proposed-member-*`; re-shoot onboarding (6), spend (2), Vault (10). e2e `members.spec` goes;
`identity`, `held`, `billing`, `links`, `shots` edited. Fake world `managed/fake/world.ts` (104 references).

## The appliance

Product: Hermes home per person in `nix/modules/hermes.nix`, `backup/pkg/restore/hermes.go`, manifest `Hermes.Profiles`,
checkpoint, quarantine → one home (manifest format changes; old checkpoints restore only on older releases, HE-27);
support grant `grantedBy` kept; console wording; licence member limit. Harness: delete `b5-people`, `b4-reenroll`;
rewrite parts of `s-skills`, `p-vault`, `r-browser`, `l-licence`, `h2-push-resolve`, `m-guides`, `h3-diagnostics`,
`b-enrollment-negatives`, `b3-recovery`; `scenario-kit/members.ts`, `app-client.ts`; VM test `backup-destinations.nix`,
`backup/itest/harness.go`; `dev/licence --members`; `dev/devbox` (the VM is gone, IN-377: its tool owner goes).
Docs: `release/pilot.md`, `release/lifecycle-procedures.md` §2, `implementation/architecture.md`, `decisions/licence.md`
LC-08/10/11/14, `legal/appliance-terms.md` (new terms version), `implementation/requirements.md` R-11/R-20, security
review M-1/M-2/M-4/L-1, `decisions/integration.md` IN rows, runbooks `dev-instance.md`, `acceptance.md`, wording in
`nixos.md`, `backup.md`, `replacement.md`, `support.md`, `updates.md`.

## Control

Org roles → the org's one account (`orgs/service.ts`, right checks in billing, claims, devices, routes); member list,
roles, remove, leave go (`orgs/service.ts:216-295`); org invitations go (`orgs/service.ts:297-433`, routes,
entitlements, signup branch, retention, erase, rate limit); `last_owner` simplified; member limit goes (licence, plans,
entitlements, admin, config, migrate); owner/billing mail and trial marks to the one account; push join simplified;
session `orgs[].role`; operator panel members. Keep: sign-in, claims, directory, billing per Whombat, several Whombats
per account, signup codes and waitlist, feedback reporters, remote-help tickets, operator users. Migration 0019: drop
`invitations`, `entitlements.members_allowed`, `plans.members`; memberships one row, role dropped; extra memberships
removed (the org's first owner stays). Tests ≈350; docs `control.md` CL-03/06/45/56/74/91, `billing.md`
BL-02/15/18/21/26, operations, README, device-api, EM-01.

## The relay, the hosts service

Relay RL-33 (8 sessions per account per appliance) → the appliance's 64; org quota and ticket claims stay. Hosts:
`X-Whombat-Actor`/`Role` stay; `docs/WHOMBAT.md` wording.

## Data on John's Home

Before the migration: check for other people on Home (`principals` kind person beyond John, their endpoints, Vault
entries, personal connections, profiles). Signed events reference them, so their principal rows stay as history; their
devices are revoked and their private things removed (asks John first if there are any). The Hermes `_shared` profile's
memory and learned skills are merged into John's profile. `-mine` connection handles renamed. A checkpoint before the
contract migration (Home has a local backup destination since IN-431).
