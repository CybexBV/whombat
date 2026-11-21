# One person per Whombat, no computer (AP-5650…AP-5729)

Whombat `docs/decisions/one-person.md` OP-01…OP-19 (John, 2026-10-25): a Whombat is one person's device and the agent's
computer goes; what stays up on the box is a container (OP-19). Contracts 3.0.0 (session major 4, CT-1500…CT-1599) carry
it; whombat-app 3.0.0 follows. Nothing is released, so nothing is kept for older boxes or apps (HE-27): deleted, not
deprecated. Client AP-5650…AP-5669 (`packages/client`, shared with the phone), web AP-5670…AP-5729 (`apps/web`,
`apps/admin`). The phone is stream M's (AP-5730…AP-5799).

## The client (`@whombat/client`)

| ID | Decision | Why |
|---|---|---|
| AP-5650 | **No invites, re-enrolment, owners or organisation invitations.** Gone: `managed/invites.ts`, `managed/reenroll.ts`, the session ops `admins*`, `invite*`, `reenroll*` and their types, control's `inviteToOrg`, `orgInvitations`, `revokeOrgInvitation`, `acceptOrgInvitation` and `OrgInvitation`, `COPY.invite`, `COPY.reenroll`, `COPY.owners`, `LINK_TEXT.invite` and `.reenroll`. `parseSetupLink` reads an add-a-device link only (`{kind: 'add', device, peerId}`); `PinSource` loses `invite` and `reenroll`; `/join` and `/get-back-in` are no journeys any more. `joinWithLink(session, {secret}, endpoint)` is a device link (`enroll.link.accept`) and answers the enrolled output. `COMMUNITY_TEXT.owner` is `.account` (“It’s yours alone”). | CT-1505, OP-11. |
| AP-5651 | **Nobody is checked for a role: the person may do everything.** `ControlOrg` is `{orgId, name}`; `canNameIn`, `canClaimIn`, `backupFileAvailable` go; `looksNearbyFirst(appliances)`, `needsPlan(view)`, `afterCreateOrgPath` without `canManage`, `billingPageOf` without `readonly`; `licenceBanner(v, timeZone)` shows grace to the person; `whombatOverview` without owners, waiting people and “Add an owner” (the part is “Devices”); `updateView(status, {now, timeZone})`; `canManageAgent(agent)` and `canAlwaysAllow(action, agent)` (a system actor still isn't anyone's to change); the hosts' agent and package update views and `agentSettingsView(settings)` without `owner`; the desk without a viewer (`deskSectionView(screen, ctx)`, `deskSwitchView(screen)`, `deskUnlockRequest(screen, now)`, `useDeskUnlockRequest(api, enabled)`, no `paired.you`, no “Pair to me instead”, no `canSwitch`/`canChange`/`canPair`); the remote help fake and the desk fake without `owner`. | CT-1507, CT-1510, CT-1517, CT-1560. |
| AP-5652 | **The box's screen signs this device in without an email**: the first step is `{kind: 'start'}` (“Show a code”), `screenSignInStart()`, `screenSignInRequest(deps, from)`; `screen_no_account` and the email field's words go. The pairing page has no email either. | CT-1509. |
| AP-5653 | **No presence or typing between people.** Gone: `Realtime.sendTyping` and `.setPresence`, `ApplianceSession.signal`, `usePresence`, `useSeedPresence`, `useReportPresence`, `queryKeys.presence`, the `presence` handler and `seedPresence`, `mergePresenceSnapshot`, `ownPresence`, `pickablePeople`, `matchesPrincipal`; `useTyping` answers `{typing}` (the agent's thinking line) and `TypingEntry` has no `mode`. `conversation.updated` never takes a room off the sidebar (every room is the person's); the `members.list` cache patches go. | CT-1514, CT-1515. |
| AP-5654 | **One sign-in per provider, the person's own.** Gone: `useOrgCredentials`, `readyOrgKey`, the organisation keys' words, `PROVIDER_TERMS`, `askAdmin`; `clientUsable(provider, clients, signIns)`; `SOURCE_TEXT` is `{title, note, meSignedOut, signIn}` (“Your own Claude sign-in”); `provider.no_requester` reads as a sign-in to add. | CT-1503, OP-09. |
| AP-5655 | **The agent's services replace its computer** (`react/agentServices.ts`): `useAgentServices` (`services.list`), `useStopService(burrow)` (`services.stop`, its answer replaces the row at once), `useCommandAllowances` and `useRemoveCommandAllowance` as before; `useAgentComputer`, `useComputerAction`, `useComputerWrite` go. `services.changed` refetches `services.list`. | CT-1533, CT-1536, OP-19. |
| AP-5656 | **How it’s doing counts containers**: the memory line is `HOST_STATUS_COPY.memoryContainers` from `containersMemoryBytes`, the disk part `containers`; a day's tooltip is received and sent only. | CT-1535. |
| AP-5657 | **One kind of connection.** Gone: `scopeChoices`, `initialScope`, `canConnect`, `ScopeChoice`, `ConnectDraft.scope`, the scope in every body, `ConnectProblem.network.canAdd`, the words `justMe`/`everyone`; `appSummary(entry, app)`; `APP_SETUP_TEXT.forThisWhombat`; `ACCOUNT_TEXT.setUpFirst`; no “Ask an admin” anywhere. | CT-1550…CT-1553. |
| AP-5658 | **One skills list.** `SkillLibraryView` is `{count, title, groups, folds, empty, filtering, nothingMatches}`: Hermes's categories, then “Added by you” and “Learned by {agent}”; a row's key is its name; `skillPanel(detail, {now, timeZone, agent, …})`, `removeKind` `builtin`/`hub`/`learned`; sharing (`useSkillShare`, `useSkillShareRequest`, the share words), `skillKey`/`skillRowKey`, the scopes and `canAdd` go. The skill world has no role; its learned skills are `menerga-heat-pump`, `how-whombat-website-deploys`, `unifi-network-backup`. | CT-1570…CT-1573. |
| AP-5659 | **Backups of one person**: the `settings` category, `people_only` for a refused file, no invited people in a restore's summary. | CT-1512. |
| AP-5660 | **Words say “you”**: claim (“Someone already claimed this Whombat.”), recovery, account deletion (`org_has_devices`, `subscription_live`), the organisation step (“Your Whombats and your plan belong to it.”), billing (no people per plan, no “Ask an owner”), the plan card `{name, price, extras}`, licence usage connectors only, the gateway, the feedback hand-off (“Asks you to approve…”), Bluetooth, files, the agent's name hint. | CT-1518. |
| AP-5661 | **Checked on 2026-10-25**: `packages/client` typecheck clean, 150 test files and 1,664 tests pass, biome clean (one older warning). | The client's commits stand on their own for stream M. |
| AP-5662 | **The contracts follow-up (op-c c9811b7, CT-1584…CT-1587)**: the session's account has no `owner`; `chatMakeDefaultShown` without `canSetDefault`; `approveToastFor` without `canChangeAgentKeys` (`canAlwaysAllow(action, agent)` stays for the phone); the quiet notices' fixture always lets the person change them. Tailscale, mail, network and Bluetooth (`tailscaleView(answer)`, `mailView(answer)`, the fakes' `call(op, input)`) lost their owner flag in a client-only commit, 48c0417f (AP-5699). | The flags only said what a role allowed. |

AP-5650…AP-5662 used; AP-5663…AP-5669 kept for the client's follow-ups.

## The web (`apps/web`, `apps/admin`)

| ID | Decision | Why |
|---|---|---|
| AP-5670 | **Settings has no Members tab** (seven tabs); `?tab=members` is no tab. | OP-11. |
| AP-5671 | **This Whombat's devices without owners or “getting back in”**; the account is read with `useMyAccountId`. | OP-01. |
| AP-5672 | **The sidebar's footer shows the person's title**, not a role. | No roles. |
| AP-5673 | **Onboarding ends at “Meet your agent”** (three steps). | OP-11, CT-1506. |
| AP-5674 | **What a page holds over the sign-in** (`held`): a device link, a claim card or a signup code; no invites. | CT-1505. |
| AP-5675 | **Device links only; no email on the pairing page or the box's screen sign-in**; `/join`, `/get-back-in` and `/invitations/accept` are gone. | CT-1505, CT-1509. |
| AP-5676 | **The managed fake world is Mara's alone**, one account per org, contracts 3.0's control shapes. | OP-12. |
| AP-5677 | **Billing: one plan**, no people line, no read-only page. | OP-18, CT-1561. |
| AP-5678 | **This Whombat: Devices without owners; the backup file always there.** | CT-1512. |
| AP-5679 | **The legal texts are version `2026-10-25-draft`** (appliance terms, subscription terms, privacy policy, terms of service), in “you” words: one person's device, no member limit, one plan at €49 a month, one account per org; only Claude Code is a client. The appliance repository's copy of the appliance terms must match word for word (LC-20). | CT-1563. |
| AP-5680 | **The operator panel**: an org's row has `email`, its detail `account`; limits `{connectors}`; the one plan `whombat` at €49; deleting an account deletes its orgs. | CT-1560, CT-1562. |
| AP-5681 | **e2e**: `members.spec.ts` and the tests of re-enrolment and organisation keys are deleted; the review shots have no invites. | Delete, don't deprecate. |
| AP-5690 | **Settings → Agent → Running** (`/settings?tab=agent&part=services`) replaces the Computer tab: “RUNNING ON YOUR WHOMBAT”, each service with its state, since when, its link while it runs and Stop (asked first: it stays stopped); one line with the services' reason when there is no container engine. | OP-19, CT-1533. |
| AP-5691 | **Always-allowed commands stay**, in Keys, without the computer's words. | The guard stays (OP-04). |
| AP-5692 | **RUNS ON is your own sign-in**, its model line and the gateway's branch; no sources to pick, no override. | OP-09. |
| AP-5693 | **No organisation keys, no everyone's usage, no spend by person or scope**: Spend is the three tiles and one sentence. | CT-1503, CT-1513. |
| AP-5694 | **How it’s doing counts containers.** | CT-1535. |
| AP-5695 | **The desk is the person's**: no viewer, no other people's switches. | AP-5651. |
| AP-5696 | **The local network and the agents' update switches show without an owner check.** | No roles. |
| AP-5697 | **The agent's notes are always editable.** | CT-1581. |
| AP-5698 | **Servers and things without owner gates**; Add a server shows with the hosts service. | No roles. |
| AP-5699 | **Tailscale, mail, network and Bluetooth without an owner check** (client views and fakes, 48c0417f). | No roles. |
| AP-5700 | **The fixtures**: commands and services (`commandFixtures.ts`; `commands: 'no-containers'` for a box without a container engine), the desk, Mara alone. | One person. |
| AP-5710 | **Settings → Skills is one list** (Hermes's categories, “Added by you”, “Learned by {agent}”), no Share. | CT-1570…CT-1572. |
| AP-5711 | **One kind of connection**, up to `CONNECTIONS_MAX`; “Add this network” always offered. | CT-1550…CT-1553. |
| AP-5712 | **Approvals are the person's**: no approvers, no private approvals, no skill sharing (`ShareRequestSkill` is gone). | CT-1517, CT-1573. |
| AP-5713 | **A device skill's card is for you.** | One person. |
| AP-5714 | **Rooms have no member stack, presence or typing between people.** | CT-1514, CT-1515. |
| AP-5715 | **The Vault without privacy notes**; keys go “in {agent}'s commands”. | CT-1511, CT-1532. |
| AP-5716 | **Automations aren't gated**: you edit, publish and delete every one. | CT-1517. |
| AP-5717 | **Website feedback goes to your Feedback room.** | OP-03. |
| AP-5718 | **Deleting a message says what happens, without other people.** | One person. |
| AP-5719 | **Search's From is you, then the agent.** | One person. |
| AP-5720 | **The fixtures have one person**: what Joris said is Mara's (`msg_pr482-mara-*`). | CT-1516. |
| AP-5725 | **Visual baselines**: `settings-members-*`, `onboarding-invite-*` and `cards-device-skill--proposed-member-*` are deleted; `settings-agent-running-*` is new; the mock comparisons name Hazel's review Mara's; what changed was shot again (below). | The baselines show the screens as they are. |
| AP-5726 | **The contracts follow-up on the web**: every file moves and can be removed, only a saved one is renamed; a schedule has no FOR and no private prompt (a card without one says it isn't there any more); a run has no hidden steps and is always controlled; Check again and Make it the default always show; a thing page's actions and quiet notices have no manage flag. | CT-1584…CT-1587. |

AP-5670…AP-5681, AP-5690…AP-5700, AP-5710…AP-5720, AP-5725, AP-5726 used; the rest of AP-5670…AP-5729 kept.

The version is whombat-app 3.0.0 (OP-14), set with the release.
