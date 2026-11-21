# Server asks: let Whombat act on a server without asking

John, 2026-10-18, on the-titan: “I don't want to give a yes on each command, is there a way to give you full access?”
The assistant answered that running a command always asks a person and nothing turns it off (true: `server_command`
is `sensitive: true` in the Servers catalog and `effectiveTier` makes every sensitive call ask), and suggested a Vault
SSH key to get around the cards. My recommendation, John: “yes”.

Built on top of server-signin.md (contracts 0.85.0); contracts 0.86.0 (CT-380…), app 0.81.0 (AP-1717…), candidate
0.92.0.

| Id | Decision | Why |
|---|---|---|
| SA-01 | **Its default is superseded by SA-10 (Never).** **One setting per server, “Asks you first”**: **Before risky actions** (the default, today's behaviour: the Servers catalog's sensitive tools and `SERVERS_SENSITIVE` rules ask) or **Never** (Whombat acts on its own on that server). Per server, not one switch for the whole Whombat. | A lab server and a production server deserve different trust; a global switch would also stop Home Assistant's locks and alarms from asking. |
| SA-02 | **Only two choices.** No middle level such as “commands run, deleting asks”. | A root command can delete anything; a middle level would look safer than it is. |
| SA-03 | **One exception stays on Never: powering off or rebooting the server this Whombat runs on** (`server_power` on a server with `hosts_this_whombat`). Changing this Whombat's own guest is refused anyway (IU-02). Commands still run without asking there. | A mistake there takes Whombat down with nobody able to bring it back from the app; commands are what John asked for, on exactly that server. |
| SA-04 | **Stored by Whombat, not by the hosts service**: table `server_asks` (burrow, server id, `never`, who, when), changed only through the commit pipeline (`servers.setAsks`), signed `servers.asks_changed` event with an undo for Done recently. A server without a row is Before risky actions. Removing a server removes its row. | The approvals are Whombat's; the hosts service and the agent on the server keep their own switches (remote control) unchanged. |
| SA-05 | **Owners only** (`canManageServers`, the same rule as the server's switches). The setting is on `hosts.serverSettings` / `hosts.updateServer` (`asksFirst`); a body with only `asksFirst` doesn't call the hosts service. | One rule for who may widen what Whombat does on a server. |
| SA-06 | **Where it applies**: `callTier` for the Servers connection resolves the call's `server` argument (id or host name, the fleet read's map) and skips the sensitive rules when that server is Never, except SA-03. Key tiers, tool tiers, Off and Look only apply as before. | The same pipeline decides every call; only the sensitive mark changes. |
| SA-07 | **The card offers “Don’t ask again on {server}”** next to Approve, on a Servers approval that asks only because of the sensitive rules on a server that could be Never (not SA-03), to owners. It is `approvals.decide {scope: 'agent'}` (the existing “always” scope, no new enum value): the decision's commit approves this call and sets the server to Never. Toast: “Approved. Whombat won’t ask again on {server}.”; the executed card ends “From now on Whombat acts on {server} without asking.” | One click instead of a yes per command, the same pattern as “Always allow Dusty to merge” (RA-06). |
| SA-08 | **Superseded in part by settings-groups.md STG-04 (its words: Ask me first · Go ahead).** **The words on the server page**: row “Asks you first”, choices “Before risky actions” · “Never”; hint “Commands, power, deleting and restoring wait for your yes.” or “Whombat acts on its own here. Everything it does shows in Done recently.” (+ “It still asks before restarting or shutting down {server}, which runs this Whombat.” on that server). Switching to Never confirms: “Stop asking on {server}?” — “Whombat will run commands, restart guests and delete things on {server} without asking you first. You can switch it back any time.” — **Stop asking**. Back to Before risky actions needs no confirm. | Plain words; the confirm is for widening only. |
| SA-09 | **The assistant knows and says it plainly**: `server_detail` and `servers_overview` carry `asksFirst`; the sensitive tools' descriptions say “Asks a person first unless the server is set not to ask.”; the Servers guide adds one sentence: someone who wants Whombat to stop asking sets the server's System tab → Asks you first → Never (owners), or uses the card's button. **It never suggests an SSH key or any other way around a question.** | The answer John got pointed around the approvals; the setting is the visible, reversible way. |

## Never by default (2026-10-26)

John, 2026-10-26, on his DEV Whombat (thread “What service failed on The Falcon?”): Dusty asked before a read-only
`systemctl cat` on The Falcon, a server nobody had set; “this should not happen, we allow access by default”.

| Id | Decision | Why |
|---|---|---|
| SA-10 | **A server nobody has set is Never**: Whombat runs commands, restarts guests, installs updates and deletes on it without asking, and every change still shows in Done recently with its Undo. Before risky actions is the person's choice per server (a row with `risky`); “Don’t ask again on {server}” still shows on that choice's cards. SA-03's exceptions hold on Never: powering off, restarting or updating the server this Whombat runs on still asks. A server Whombat doesn't know (not in the fleet) still asks. Supersedes SA-01's default and server-asks-server.md SA-S01's “no row is `risky`”. | One person per Whombat (one-person.md OP-01) whose servers they added themselves; access is allowed by default everywhere else (connections-catalog.md CX-20a), and a card for every command taught nothing but clicking yes. |

