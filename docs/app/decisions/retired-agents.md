# Retired agents leave lists, pickers and mentions (AP-656…AP-660)

John retired several agents and still found them in a Vault entry's “Give a key to…” list. Whombat's rule
(essentials-people.md EP-01…EP-09, contracts CT-177): a retired agent's principal stays, so history keeps its name, but
lists, pickers, mentions and options leave it out (`isActivePrincipal`). Contracts 0.39.1 (CT-240) teaches
`vaultKeyHolderProblem` the agent's `retiredAt` (code `retired`). An audit of the app found the places below.

| ID | Decision | Why |
|---|---|---|
| AP-656 | **Every picker checks `isActivePrincipal` itself**, even where the server's list already leaves retired agents out: the web's “Give a key to…” (`eligibleAgents`, besides core's `retired` code) and Android's (which now also applies `vaultKeyHolderProblem` to the server's ids, as the web does), `useSkillAgents` (Propose skills, shipped packs, Learn a skill), a pack's “Add to” (now `useSkillAgents`), the automation editor's agents (`automationAgents`), Settings → Working directory's “own directory” note, Android's Agents tab (`agentRows`) and a plan step's owner choices on Android (`planOwnerChoices`, as the web's `ownerCandidates`). “Learn from this message” is gone from a retired agent's DM. | Cached lists live until reload (`staleTime: Infinity`); a second check costs nothing. |
| AP-657 | **`agent.updated` with `retiredAt` updates the caches** like a reload would: the principal stays in the bootstrap (history keeps the name), the roster (`agents.list`) drops it, and `sidebar.counts.agents` goes down by one only when the cached principal was still active and is a team agent (no personal or system agents, as the server counts), so duplicates and reordering change nothing. Sidebar DM rows stay in the cache: the web's sidebar and Android's lists derive them from the principal. | Other open sessions kept showing the retired agent until they reloaded. |
| AP-658 | **The composer's mention targets are active principals only** (`composerMentionTargets`, Android's `mentionTargets` and `skillCommandAgents`): `@oldie` isn't corrected to `@Oldie`, no “Agents aren’t in this conversation” hint, no `/skill` for it, and the web's send resolves `mentions` with the same targets, so a new message no longer mentions a retired agent or a former member. Rendering history keeps core's `mentionTargetsFor` over every principal. | EP: mentions leave retired agents out; the server wakes none of them anyway. |
| AP-659 | **Android's DIRECT section and channel lists show an agent DM only with an active, known agent** (`listedDms`), exactly as the web's sidebar (`sidebarModel`: unknown or retired agent → no row). Direct conversations with people are untouched on both. The DM stays readable from history. | Match the web; the server also leaves a retired agent's DM out (EP-05). |

### AP-660 whombat-app 0.28.2

AP-656…AP-659 on contracts 0.39.1 (no session API change: `SESSION_API_LEVEL` stays 29). Checks: `pnpm check` once
(DEV fast: no visual suite, no emulator). Released like 0.28.1 (version bump on the branch, merged into `main` with
`--no-ff`, tag `app-v0.28.2` on the merge, `pnpm release:dist` from the tag).
