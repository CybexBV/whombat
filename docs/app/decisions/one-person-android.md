# One person per Whombat, no computer, on Android (AP-5730…AP-5799)

Whombat `docs/decisions/one-person.md` OP-01…OP-19 (John, 2026-10-25): a Whombat is one person's device and the agent's
computer goes; what stays up on the box is a container (OP-19). The phone follows the shared client's changes
(`one-person.md` AP-5650…AP-5661) and the web (AP-5670…AP-5729): nothing is kept for older boxes (HE-27), deleted, not
deprecated. Words say “you”; no members, owners, team or computer.

## Chat, settings, approvals (AP-5730…AP-5739)

| ID | Decision | Why |
|---|---|---|
| AP-5730 | **No Members.** `MembersScreen`, `data/members`, the `Members` route (`whombat://members`), its saved place, the Settings row, its line and the members read go; the web's `/settings?tab=members` opens the Settings tab. The Settings list is Notifications, Vault, Agent, Skills, AI, Connections, This Whombat. | OP-11. |
| AP-5731 | **No typing or presence between people.** `useSeedPresence` goes, the composer sends no typing (`onTyping`), `WorkingBubble`, `ThinkingBubble` and `thinkingLabels` have no `mode` (no “Mara is typing”), and `offersStop` reads the turn's id alone. The fixtures' thinking events carry no mode. | AP-5653, CT-1514. |
| AP-5732 | **The message menu has no roles**: `messageViewer(me)` is `{id, kind: 'person'}`; you delete any message and edit only your own. Delete asks “It’s removed from this conversation.” (“…, with its replies.”), Pin's hint is “Pins it in this conversation”. | CT-1517; there is nobody else to remove it for. |
| AP-5733 | **A reaction counts reactions, not people**: “thumbs up, you”, “thumbs up, you and 1 more”, “finally, 1 reaction”. | OP-01. |
| AP-5734 | **You decide every approval**: `viewerOf` is `{id, kind: 'person'}`; “Always allow” shows on the agent's risk rows (`canAlwaysAllow(action, agent)`), never an automation's; the skill share request (WHAT HAPPENS, THE SKILL, `useSkillShareRequest`) goes. | AP-5651, AP-5658. |
| AP-5735 | **Nobody leaves**: no “removed” or “former member” beside a name; `authorStatus` is “Automation” or nothing, and an audit row has no status. | CT-1517 (`principalStatusLabel` gone). |
| AP-5736 | **Automations are yours**: you switch, publish and delete any of them (`canDeleteAutomation(viewer)`: a person, never the agent); the On/Off words for someone who may not switch and “An owner publishes it.” go; “Run #1 needs you to look at it.” | The list and detail have no `canManage` (contracts 3.0). |
| AP-5737 | **The fixtures are one person's**: Mara and Dusty only; the settle world's question thread is Mara's, the chat fixtures have no `memberIds`, `dmPersonId` or `memberCount`, schedules no `forAccountId`, connections no scope, live activities show your runs and the agent's in your conversations. | `@whombat/fixtures` 3.0 has no Joris, Priya or Tom. |
| AP-5738 | **Settings → Agent's read-only keys model goes** (`agentKeysModel`, `agentTierRows` and `keyTiers.test`): the Keys part is always yours to change (AP-5761). | Nothing reads it any more. |
| AP-5739 | **What isn't there says so, no rooms you're not in**: “This plan isn’t here any more.”, “This request isn’t here any more.”, “This run isn’t here any more.”, “This run didn’t load.”, “There’s no pull request with this number here.”. An automation step's `redacted` text stays while contracts 3.0 carry the field. | Every room is yours (AP-5653). |

## Devices, links, This Whombat, servers (AP-5740…AP-5759)

| ID | Decision | Why |
|---|---|---|
| AP-5740 | **Devices lists your devices and passkeys**, adding a device (code or link) and removed devices. The invite card, the getting-back-in cards and OWNERS go; the device-bound passkey policy switch is yours; Devices' `at` is `passkeys` only. | OP-01, OP-11 (the recovery kit, passkeys and pairing stay). |
| AP-5741 | **Links that open the app** are add-a-device, claim and appliance or burrow paths only: no `/join`, `/get-back-in` or organisation invitation, no `org` link kind. The pairing screen has no email and no pasted owner link. | AP-5650, CT-1505. |
| AP-5742 | **A community Whombat**: “Add this phone with a link or QR code” replaces Join; a device link pins as `add-link`; `CommunityInviteCard`, the join and re-enrol screens and flows (`JoinScreen`, `ReenrollScreen`, `OrgInvitationScreen`, `PastedLink`) go; the demo starts at `join` or `device`. | AP-5650 (`joinWithLink` takes device links only). |
| AP-5743 | **Screen sign-in starts at “Show a code”**, with no email field; Back from the letters returns there. | AP-5652, OP-11. |
| AP-5744 | **No owner checks**: `useDeskApi()`, `useMachineHere()`, `useTailscaleHere()`, `useRemoteHelpHere()` and `useMailHere()` take no owner, nor do `tailscaleView(answer)`, `mailView(answer)` and the demo's fakes (client 48c0417f); How it’s doing, Network, Bluetooth, Hardware, Remote help, Diagnostics, the backup actions, the recovery kit, the backup file, the plan's Check again, Claim in the switcher and Rename always show; the kept cloud session stores organisations without a role. | AP-5651, OP-12. |
| AP-5745 | **The desk has no viewer**: Pair the screen whenever it is unpaired, no “Pair to me instead”, nothing read-only; the demo's “theirs” and “other” states go. | AP-5651 (`deskSectionView(screen, ctx)`). |
| AP-5746 | **Servers are yours**: `canPower(rc, online)`; Add a server always (the “No servers yet” row reads “Add a server”); Asks you first, agent updates and OS updates without an owner gate; the view-only and owners-only words go. | AP-5651 (the hosts' views without owner), OP-01. |
| AP-5747 | **How it’s doing counts containers**: the memory line (`memoryContainers`), the disk's containers part, and a day's readout of received and sent only. | AP-5656, OP-04. |
| AP-5748 | **The first burrow** is “STEP 1 OF 3” in the web's words (“This is where you and your agent work…”); a refusal is the plain retry message, never “ask its owner for an invite”. | `ONBOARDING_STEP_COUNT` 3, OP-11. |
| AP-5749 | **The QR sign-in asks to pair without an email too** (`runPhoneHandoff`): the request is `{endpoint}`, and `HandoffDeps.pairRequest` takes the contract's input type, so a field the contract drops fails the typecheck. The phone test's fake parses the request with `EnrollPairRequestInput` as the session call does. | Since CT-1509 the strict schema refused the email the QR flow still sent, before anything left the phone: every QR sign-in stopped at “Asking your Whombat to let this phone in” (John's iPhone, 2026-10-26). A structural type let the extra field through, and the fake didn't check it. |

## The agent, sign-ins, skills, connections, spend, Vault (AP-5760…AP-5779)

| ID | Decision | Why |
|---|---|---|
| AP-5760 | **Settings → Agent → Running replaces Computer** (`ServicesSection`, `data/services.ts`): RUNNING ON YOUR WHOMBAT, each service with its dot, “Running · started 52 min ago”, its link while it runs or starts, Open, and Stop on anything not stopped, asked first (“Stop {name}?”; it stays stopped, also after a restart). The web's words (AP-5690). Shown once the host answers, as on the web; a Whombat without a container engine says why there (`services.list`'s `reason`, else `SERVICES_NOT_HERE`); read again every 2 s while one starts. `ComputerSection`, `data/computer` and their tests go. | OP-19, AP-5655; no computer (OP-04). |
| AP-5761 | **No owner checks on Settings → Agent**: `PartProps.owner`, `canChangeAgent`, the read-only line and Keys' member view go; name, face, model, effort and Fast replies are always yours to change; the always-allowed commands always show. | OP-01; commands run on the Whombat (OP-04). |
| AP-5762 | **Notes are one text you write**: “Changed {date}”, Edit always, no “everyone reads it” (`canEdit`, `updatedBy`, `readOnly` gone). | Contracts 3.0 `AgentNotes`. |
| AP-5763 | **The sign-in is yours**: SIGN-IN under Model and AI reads “Your own {Claude, ChatGPT} sign-in” and `SOURCE_TEXT.note`; member, organisation and requester sources and “Owners change this on the web” go; a local model not set up says “Set it up in Settings → AI”; `LocalModelCard` is always editable; AiProviders has one row per provider; the AI cards drop `owner_departed` and the `credentialId` filter. | OP-09, AP-5654. |
| AP-5764 | **You switch a device on** from its skill card (`DEVICE_CARD_COPY.ownersOnly` gone). | OP-01. |
| AP-5765 | **One skills list**: groups, then the Off and Removed folds; a row's key is its name; the `Skill` route is `{name}`; no sharing (`shareConfirm`, `shareReplaceConfirm` gone); the switch hint has no “for everyone”; remove by name. | AP-5658, OP-08. |
| AP-5766 | **One kind of connection**: no “Only you” or “Shared”; `canManage`, `canManageShared`, `canConfigure`, `isAdmin` and `askAdmin` go (`ACCOUNT_TEXT.setUpFirst` instead); Found on your network always shows; every row that needs signing in again says Connect again; `connectGate(entry, status)`; an app's setup steps show under “For this Whombat” unless the app is set in config; Remove says “until you connect it again”. | AP-5657, OP-03. |
| AP-5767 | **Spend is yours**: the tiles and “What {agent} used for you, as the AI providers reported it.”; BY PERSON, the window switch, YOUR SPEND and `spendCells` go; the agent's week is “THIS WEEK” with a note naming the agent. | OP-11. |
| AP-5768 | **The Vault speaks of commands**: `VAULT_KEYS_COPY`, `vaultKeyDeliverable`, `vaultKeyEnvNames`; PRODUCTION is always marked (the `computers` flag and the hard-coded `computers: true` go); RECENT USE has no “for whom”; `showHostNote` goes. | CT-1511, CT-1532, OP-07. |
| AP-5769 | **Every schedule is yours**: the Schedules part has no FOR fact, no private schedule and Pause, Resume and Remove on every schedule (`forName`, `canChange` gone); a schedule card whose schedule is gone says “This schedule isn’t there any more.” (the web's); “Paused. It won’t run until you resume it.” | Contracts 3.0 follow-up (CT-1587). |
| AP-5770 | **Every file and run is yours**: a file's sheet offers Move and Remove always and Rename on a file saved straight into Files (`messageId` null); an automation run's Pause, Resume and Stop show while it runs (`canControl` gone); no step is hidden (`redacted` gone); a thing page's actions and Change always show (`ThingPage.canManage` gone); “Always allow” reads core's choices, still never for an automation's own request (`canManageAgent`); the chat runtime and agent setup have no `canSetDefault`/`canRecheck`. | Contracts 3.0 follow-up (5a3ca3e5): the last owner and always-true flags went. |

## Checks

2026-10-25, on op-m at one-person (b15ce0b6) with the contracts follow-up: the whole repository's `pnpm check` is green
(biome, every package's typecheck, 496 test files and 4,386 tests; the phone's 128 files and 1,131 tests among them).
The touch-target, TalkBack-order and dynamic-type lists follow (`MembersScreen` out, `ComputerSection` →
`ServicesSection`, `DevicesScreen` 0 touchables of its own). Not seen on an emulator: the only new screen part is
Running, built from the audited `Button` and `Section`.

AP-5750…AP-5759 and AP-5771…AP-5799 are kept for the phone's follow-ups.
