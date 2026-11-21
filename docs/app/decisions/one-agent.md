# One agent on the web and in the shared client (AP-4900…AP-4959)

John, 2026-10-23 (main checkout): “Whombat is NOT using multi-agent anymore, if this is still in the codebase we should
remove it. We shouldn't be able to ‘hire an agent’ anymore.” A Whombat has exactly one agent (Whombat
`docs/decisions/one-agent.md` OA-01…OA-24; contracts 0.123.0 CT-1100…CT-1139). Nothing is kept for compatibility: the
product is unreleased. The client part (AP-4900…AP-4919) is shared with the phone (AP-4960…, its own file); the web's is
AP-4920…AP-4959. Supersedes, as history: crew.md, five-agents.md, five-roles.md, ask-agent.md, reply-to.md,
mention-scope.md, thread-mentions.md, agent-responsibilities.md, retired-agents.md, assistant-name-web.md,
one-whombat-shell.md (the crew shell), resourceful-agents.md (the agents' list parts), skills-settings.md (the Skills tab)
and the multi-agent parts of the files they touch.

## Shared client (`packages/client`)

| ID | Decision | Why |
|---|---|---|
| AP-4900 | **The agent, by its name.** `useTheAgent(burrow)` → `{ agent, words }` and `theAgentOf(principals)` (the one agent that isn't a system actor) replace `useMyAssistant` and `myAssistantOf`; `agentWords(name)` replaces `assistantWords` (“Ask Dusty”, “Reply to Dusty…”), and “your agent” stands in only until the bootstrap is read (`AGENT_FALLBACK_NAME`), never “Whombat”. `renamed` says “Dusty is now called Rex.” | OA-01, OA-08, OA-23. |
| AP-4901 | **Its face** is one of the five drawings: `agentFaceOf`, `agentFaceBackground` (the face's colour at 14%) and `agentFaceLabel` (“Neo’s face”) replace the role helpers; an avatar's label is the agent's name, never “Skipper, Lead”. | OA-05, OA-08. |
| AP-4902 | **Owners change the agent**; members see it (`canManageAgent`: an owner, never a system actor). The hirer, the personal agent's owner and retired agents go. | OA-09. |
| AP-4903 | **Keys** are Settings → Agent's: the six rows and All keys (`keyRowOptions(options, here)`); the hire helpers (`hireKeys`, `hireKeyTiers`, `keysAfterHire`) and the hire screen's arguments go. | OA-02, OA-05. |
| AP-4904 | **Connections' words always name the agent** (`connectionWords(name)`, its field `agent`): “Dusty calls it homeassistant”, “WHAT DUSTY MAY DO”; the scope choices say “Dusty uses it only for you.” and “Dusty uses it for everyone here.” | OA-10, OA-23. |
| AP-4905 | **This Whombat names the agent**: the part “Dusty’s access” and AT A GLANCE's “Dusty may reach your local network” (`whombatPartLabel(part, name)`, `WhombatOverviewInput.agent`). | OA-23. |
| AP-4906 | **No agent count**: plan cards and the licence's usage leave the agent limit out (“Unlimited connectors”). | OA-02. |
| AP-4907 | **Static words say “your agent”** where no name is known: sign-ins, Files, pull requests, GitHub, mail, Google, the licence banners, the update list's feature names and the AI gateway (“Claude Code turns go through it, whoever asks.”). | OA-23. |
| AP-4908 | **The paths** lose `/c/…`, `/dm/…`, `/direct/…`, `/agents…` and `/files/c/…`, and gain `/settings/agent` (the agent's link). | OA-04, OA-09. |
| AP-4909 | **Gone from the client**: Ask an agent, the reply-to chip's `to` and `suggested`, mention scopes, caretakers, the #general welcome, roles, agents' right-now lines, retire words, `useSetAgentChannels`, the handoff plan writes and the work fixtures' handoff world. | OA-04, OA-06, OA-07. |
| AP-4910 | **On contracts 0.123.0** the agent's hooks take the burrow only: `useAgent` (`agent.get`), `useSetAgentKeys`, `useSetAgentRuntime`, `useSetAgentModel`, the computer's, notes' and allowances' writes, and `useAgentSpend` reads `spend.week`. Strict decoding follows `agent.setKeys`; `vault.agentKeys` is gone (a Vault entry is on or off for the agent). | CT-1100…CT-1139. |
| AP-4911 | **The client's fixture worlds hold one agent**: the work fixtures' plan, runs, approval and queued turn are Dusty's in Mara's Chat (no channel, no step owner, Reassign gone from the Work items it makes); the skill library world has no one else's imports and no Add (the `others` fold goes), its `operator-craft` category is `servers` (OA-18); the test fixtures' conversation is Mara's Chat. | OA-01, OA-04, OA-18. |
| AP-4912 | **The Tokens card has no list of agents** (`HostTokens.agents`, `HOST_TODAY_AGENTS` go; the web stopped drawing it, AP-4951). | OA-01. |
| AP-4913 | **`canManageAgent` reads the agent's kind**: an owner may change the principal of kind `agent`, nobody a system actor (OA-17); the web and the phone pass the agent as it is. | OA-09, OA-17. |

## Web (`apps/web`)

| ID | Decision | Why |
|---|---|---|
| AP-4920 | **One shell**: the crew sidebar, `useShellMode`, `useListsAgent`, `useShellAssistant` and the services' and fixtures' `shell` option go; the assistant sidebar is the sidebar. Chat (`chat.channel`) stays a runtime question (`chatChannel.ts`). The menus' styles moved to `ContextMenu.module.css`. | OA-03. |
| AP-4921 | **The fixture world has one agent**: the bootstrap keeps the agent and the system actors only, one skill library is served, and the second assistant layer (`assistantFixtures.ts`) and the crew's skill libraries go. | OA-01. |
| AP-4922 | **Addresses**: `/settings/agent` (the agent's link) opens Settings → Agent with its `part` and `key`; `/skills` and `?tab=skills` open the agent's Skills. `/agents…`, `/c/…`, `/dm/…`, `/direct/…` and `/files/c/…` are Not found: the links that made them are gone with the contracts. | OA-04, OA-09. |
| AP-4923 | **Superseded by settings-groups.md STG-02, STG-03 (the assistant’s four parts; model, keys, running, schedules and spend in Advanced).** **Settings → Agent** (`?tab=agent`, between Members and AI) replaces the agents list, the profiles and each agent's settings page: its parts under the tabs as This Whombat's control — Name and face, Model and AI, Keys, Skills, Notes, Computer, Schedules, Spend (each where the Whombat has it, `&part=`). Leaving a part with unsaved changes asks first. Owners change it; members see it with “Only owners change Dusty’s settings.” | OA-09. |
| AP-4924 | **Name and face**: the bust, NAME with Save (the form and the reserved “Whombat” checked first; no other agent holds a name, so no “taken”), the five faces (a pick saves), Instructions and knowledge (the memory modal) and your own Suggestions from the agent. No “Suggest a name”: the pools went. | OA-08. |
| AP-4925 | **Search** answers by the agent; From lists people, then the agent, never a system actor; Browse channels and the channel shortcuts go. | OA-04, OA-07. |
| AP-4926 | **Keys**: the six rows and All keys, the commands people always allowed, the Vault entries it may use and the repos. No CHANNELS, no YOUR ACCOUNTS beside the rows, no Google callout: a person's own accounts serve only the turns for them. | OA-05, OA-10. |
| AP-4927 | **Model and AI**: the provider (ACP for owners who are admins), model and effort, and RUNS ON — whoever asks, an organization key, or a member's own sign-in shared. | OA-11. |
| AP-4928 | **Settings → AI is one page**: your sign-ins with their usage, the clients and organization keys, the gateway's pool, everyone's usage and the spend (was the assistant shell's; the crew's three groups go). | OA-03. |
| AP-4929 | **Settings → Profile** loses YOUR ASSISTANT (the name and face are Settings → Agent's); removing someone or leaving says their chats, Vault entries and own connections go. | OA-08, OA-10. |
| AP-4930 | **An automation runs as the agent**: no WHO, AGENT or template agent field; where the contract still asks for an agent id the form sends the agent's. Editing keeps it; the glance row's chip and the older-wording note name it. | OA-15. |
| AP-4931 | **Automations answer in the person's Chat or Feedback room** (`useAutomationRooms`); the run page links to `/chat?thread=` or `/feedback?thread=`. Chat by default; The tracker reports go to Feedback once that room exists. | OA-04: no channels. |
| AP-4932 | **The agent reviews its own fix with fresh eyes**: the fix recipe's reviewer is a second turn of the agent (`reviewerId` its id, for the contract's check); FIXED BY and REVIEWED BY go. | OA-15. |
| AP-4933 | **No “Start a new burrow”**: the sidebar's burrow menu offers no second burrow (an appliance holds one). | OA-01. |
| AP-4934 | **The web's fixture world**: its agent is Neo (the mock's name and face) under the shared world's agent id (`prn_dusty`); Mara's Chat (`cnv_dm-dusty`), her Feedback room and PR #482's room are the conversations; what the crew's channels held (essentials, unread seeds, settled cards, approvals) moved to PR #482's room or the Chat. | OA-01, OA-04. |
| AP-4935 | **Website feedback**: ASSESSED BY and BUILT BY name the agent, no picker; the fix is on or off (`handoff: 'on' \| 'off'`, contracts 0.123.0) and reports go to a conversation (`conversationId`), never a channel; `feedbackWords(name)` has no crew branch. | OA-07, OA-16. |
| AP-4936 | **Reports never go to a channel**: no channel on the form; “Reports go to” always names Feedback or the person's chat. | OA-04. |
| AP-4937 | **Feedback's other words** say “your agent” or the agent's name. | OA-23. |
| AP-4940 | **A Vault entry is on or off for the agent**: one row (`AgentAccess`, was AssistantAccess) — Allowed · Ask me first · Off; the give/take-back key list, `eligibleAgents` and the servers chooser go. `AgentVault` stays for Settings → Agent → Keys; the fixtures hold the agent's key and its recent uses. | OA-09. |
| AP-4941 | **`vaultWords(name)`** always names the agent; the crew-only copy goes. | OA-23. |
| AP-4942 | **Settings → AI has no Usage tab**: the old `UsageTab` had no screen any more and goes; EVERYONE keeps its table (`EveryoneTable.tsx`), your own use stays in the sign-in rows. | OA-03. |
| AP-4943 | **The operator panel (`apps/admin`) has no agent limit**: plans and an organization's entitlement show People and Connectors only. | OA-02. |
| AP-4944 | **No caretaker**: LookedAfter and its lines and sheets go; the fixtures send `lookedAfterBy: null`. | OA-07. |
| AP-4945 | **Connections name the agent**: GitHub's line, Website feedback's (“reports come to Feedback”) and Remove's question. | OA-23. |
| AP-4946 | **Learn this has no agent picker**: it posts in the person's Chat as a new thread (or in “This thread” when the agent is in it), without a mention, then opens the thread. | OA-07, OA-18. |
| AP-4947 | **One skill library, the agent's**, at Settings → Agent → Skills: the old Settings → Skills tab and `useSkillAgents` go. | OA-09, OA-18. |
| AP-4948 | **Spend is Settings → AI's one section**: the per-agent rows, an agent's weekly line, handoff budgets and plans go; Settings → Agent → Spend is the agent's week. | OA-06, OA-09. |
| AP-4949 | **Conversations without the crew**: no `@` list and no `@ agent` button (the case of `@Neo` is still corrected), no reply-to chip, no Ask an agent, no role badge (an automation keeps its badge), the branch room's header only, and `/` offers the agent's skills as `/name `. | OA-04, OA-07. |
| AP-4950 | **Settings' other words name the agent**: Notifications (one set, the assistant shell's), the local network switch, the working directory and About you (“What Neo knows about you”). | OA-23. |
| AP-4951 | **How it's doing** has no per-agent list under the tokens chart. | OA-01. |
| AP-4952 | **A plan is the agent's own work**: no owner on a step or in Make a plan, no Reassign, no handoff brief, lane, budget or report back; the plan card shows each step's state without an owner; NEEDS YOU offers no Reassign or Ask for a report. | OA-14. |
| AP-4954 | **Onboarding**: Name your Whombat → Set up your AI → Meet your agent → Invite people. Meet your agent shows the bust, NAME and the five faces, and saves the name and face with the onboarding (`onboarding.update` `agentName`, `agentFace`) when the step is left, the reason under the name when it can't; the tip bubble is the agent's, with the name and face picked so far (Dusty in Dusty's drawing until the Whombat exists). | OA-13. |
| AP-4955 | **`@whombat/avatars` draws faces**: `WhombatAvatar face="neo"` (`AVATAR_FACES`, the contracts' `AGENT_FACES`, default Dusty); the roles, legacy roles, role labels, default names and `avatarLabel` go — the label is the agent's name. The files keep the names they were drawn under (`AVATAR_FILE_STEMS`: Dusty's are `associate-*.svg`), so the console and the phone need no file change; `data-avatar` is the face. | OA-08. |
| AP-4956 | **`@whombat/tokens` has the faces' colours**: `facePalettes` (`FACES`, the contracts' `AGENT_CHARACTERS`), `--face-<face>` and `--face-<face>-deep`, and the phone's `NativeTheme.faces`; the roles, the fourteen legacy roles and their labels go. Where the web borrowed a role's colour as an accent (a green tick, a purple marker) it takes the face of that colour (`--role-developer` → `--face-banjo`). | OA-05, OA-08. |
| AP-4957 | **The visual suite** loses the roster's and the crew sidebar's specs and the channel and DM states; the branch room stays. The full-frame mock comparisons draw the one-shell sidebar now, where the mock has the crew's: they need new masks or baselines (not done in this step). | OA-03. |
| AP-4958 | **Tests of what went are deleted**: the roster, profiles, hiring, retiring, focus, roles, channels, people and group DMs, the #general welcome, Ask an agent, reply-to, handoffs, caretakers, others' skill imports and Add, per-agent spend and Usage tab tests. What changed is tested by facts (ids, names, counts), names through `ASSISTANT_NAME`. | test-speed.md. |
| AP-4959 | **For the contracts (not changed here)**: 0.123.0 still has `WorkItem.handoff`, the `reassign_step` Work action, `LicenceUsage.agents` and the `agents` licence limit; the web never shows them and leaves them out where it builds them. | OA-02, OA-06. |

## Phone (`apps/mobile`)

The Android app follows the web's choices above (stream M, branch `oa-m`); what is the phone's own is here.

| ID | Decision | Why |
|---|---|---|
| AP-4960 | **One shell on the phone**: the tabs stay Chat, Connections, Watch and Settings; `data/crew.ts` and `People.agents` go — `People.agent` is the one agent (`theAgentOf`), and `useTheAgentHere()` / `useAgentWords()` read it from the burrow's base, which changes only with the principals, so a composer doesn't re-render for every message. | OA-01, OA-03. |
| AP-4961 | **Settings → Agent's address**: the `SettingsAgent` route, `whombat://settings/agent?part=…&key=…`, opened by the agent's link (`AgentLink`), the web's `/settings/agent` and `?tab=agent&part=&key=` (strings checked); the Agent, AgentSettings, AgentSchedules, AgentNotes and CommandAllowances routes go, and a place saved on them isn't restored. `whombat://skills` stays the agent's library. | OA-09. |
| AP-4962 | **Links to a person's own rooms**: a `dm` link opens the Chat tab or the Feedback room, a top-level message in it its thread (every question is its own); Android's app links claim `/chat` and `/feedback` instead of `/c/`, `/dm/`, `/direct/` and `/agents`, and those addresses have no screen (the inbox). Files' addresses are `files/dm/chat`, `files/dm/feedback`, a task chat's id and a branch room. | OA-04. |
| AP-4963 | **First run on the phone** is the web's step 1, “Name your Whombat”, step 1 of 4 in its words; the tip is the agent's, Dusty until the Whombat exists. Set up your AI, Meet your agent and Invite people stay on the web. | OA-13. |
| AP-4964 | **The demo world has one agent**: the contracts' agent (`prn_dusty`) renamed Neo with Neo's face, so everything it did there is Neo's; Mara's Chat and Feedback room are the sidebar's rooms; `agent.*` answer without a handle (the reserved name and the form checked, nothing taken), with the agent's default keys. The skill proposal waits in Mara's Chat, the rich and settled-card extras are in PR #482's room; the crew's libraries, Waffle's DM, the handoff plan and Pretzel go. | OA-01. |
| AP-4965 | **One Settings → Agent screen** with the web's parts as tabs that scroll sideways (Name and face, Model and AI, Keys, Skills, Notes, Workspace, Computer, Schedules, Spend, each where the Whombat has it); the agent screen, its keys, workspace, notes, schedules and commands screens and Profile's YOUR ASSISTANT go. Owners change it; members see it with “Only owners change Dusty’s settings.” Leaving a part or the page with unsaved changes asks first. | OA-09; it matches the web. |
| AP-4966 | **Name and face**: Save checks only the reserved name and the form (no other agent holds a name); the five faces, a pick saves; Instructions and knowledge opens Memory. No Suggest a name. | OA-08. |
| AP-4967 | **Skills are the agent's**: no `agentId`, no Add or someone else's import (`from`); the Skills part counts them and opens the library, `/skill` always means the agent's. | OA-18. |
| AP-4968 | **Model and AI**: provider, model and effort, and a read-only line on whose sign-in it runs (set on the web). | OA-11. |
| AP-4969 | **Keys**: the six rows and All keys, changed by owners, read-only marks for members; the always-allowed commands; `?key=` scrolls to and highlights its row. | OA-05. |
| AP-4970 | **Notes** are a part of the page: owners edit and remove them; the agent writes them, so there is no Add. | OA-19. |
| AP-4971 | **Computer** is a part of the page: only owners start, stop or reset it. | OA-19. |
| AP-4972 | **Schedules** are a part of the page: Pause, Resume and Remove for the person it was made for and owners. | OA-19. |
| AP-4973 | **Avatars draw the agent's face** (`WhombatAvatar face`, `AVATAR_XML` by face; the files keep their stems), labelled with its name; Whombat's own signers (`kind: 'system'`: automations, GitHub, Feedback) get a mark on the automation's quiet disc, never a wombat; `RoleDot` goes. | OA-08, OA-17. |
| AP-4974 | **What the phone keeps offline follows**: the outbox holds no reply-to `to` or `suggested`; the persisted cache keeps `agent.get` (no `agents.*`, `conversations.getChannel`); Notifications' mentions line has no `@channel`, and the notifications card says “your agent’s answers”. | OA-04, OA-07, OA-23. |
| AP-4975 | **Spend**: the agent's week is Settings → Agent's Spend part; the Spend screen (Settings → AI's) has no agent column or per-agent week. | OA-09. |
| AP-4980 | **Each person's rooms with the agent** are their Chat and Feedback room; Chat's empty state shows the agent's face, labelled with its name. | OA-04. |
| AP-4981 | **The Conversation screen is a branch room's** only: no members, settings, archive or leave; opened with a Chat or Feedback room's id it hands off to Chat. | OA-04. |
| AP-4982 | **No `@` list, reply-to chip or Ask an agent**; the `@Name` case correction stays. A thing page's “Ask about pve-02” stays: it asks the agent. | OA-07. |
| AP-4983 | **Files** lists the person's rooms (with the agent's face) and branch rooms. | OA-04. |
| AP-4984 | **Share to Whombat** offers Chat, Feedback and branch rooms; after sending, that room opens. | OA-04. |
| AP-4985 | **Try again and Stop** are offered to any person, the server decides; quick replies go without `@Name` in a person's own rooms. | OA-12. |
| AP-4990 | **Plans are the agent's own work**: no step owner, Reassign, handoff, lane or report back; Add a step is a title. | OA-14. |
| AP-4991 | **Nobody looks after a connection**: Remove names the agent, a gateway's says each person's own sign-in. | OA-07, OA-11. |
| AP-4992 | **A Vault entry is on or off for the agent** (`entry.key`, give and take without `:agent`); the list says only “off for Dusty”; Settings → Agent → Keys lists the entries on for it (`vaultAgentRows`). | OA-09. |
| AP-4993 | **An automation's chip** is the agent where it has an agent step; “An owner publishes it.” | OA-15. |
| AP-4994 | **The audit log** tags the agent AGENT and Whombat's own signers AUTOMATION, GITHUB or FEEDBACK. | OA-17. |
| AP-4995 | **Approvals and runs** show the agent's face, labelled with its name. | OA-08. |
| AP-4996 | **Sign-in tips** wear Dusty's face until a Whombat exists. | OA-13. |
| AP-4997 | **How it's doing** has no per-agent tokens list. | OA-01. |
| AP-4998 | **This Whombat's lines** name the agent. | OA-23. |
| AP-4999 | **The merge note** names the agent (`mergeNote(name)`). | OA-23. |
