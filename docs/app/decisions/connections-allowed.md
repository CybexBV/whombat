# Settings tabs that hold their spacing; connections Allowed by default (AP-831…AP-833)

John, 2026-10-08, with a screenshot of Settings → Connections → Home Assistant on his box: “The tabs (menu) look very
bad”, the tool asked by default where “we need the agents to freely use it fully”, and the MCP server should be set up
automatically (Whombat connections-catalog.md CX-20a, CX-54a; contracts CT-310).

| # | Decision | Why |
|---|---|---|
| AP-831 | **Settings and Work tabs keep their own spacing in the production build.** `SettingsScreen.module.css` and `WorkScreen.module.css` override the shared `Tabs` with a doubled class (`.tabs.tabs`, `.tabs.tabs .tab`), as Memory and Automations already did: labels 24px apart, the first flush with the page title. | In the bundle the shared `Tabs.module.css` loaded after the screens' sheets; at equal specificity its 28px inset and 4px gap won, so the labels ran together (“Profile Notifications Members AI…”). |
| AP-832 | **Contracts 0.57.0.** Configure's “Change things in connected services” row opens at On (`ALL_KEY_OPTIONS`), new connection tools show Allowed, and the key's description says some actions (unlocking a door, deleting) always ask. The MCP line of a Home Assistant connection shows the server's words (“Whombat turned on Home Assistant’s MCP server. Agents see the devices exposed to Assist …”) through the existing check rows. No screen change beyond the data. | The defaults live in contracts and the server; the app renders them. |
| AP-833 | **A long tools list stays usable; contracts 0.58.0.** From 13 tools the TOOLS section has a filter (“Find one of 127 tools”, name and description, “No tool matches …”), and each description shows two lines with the whole text as its title. With contracts 0.58.0 (CT-311) a server's destructive hint no longer marks a tool “Always asks”: only deleting and Home Assistant's locks, alarms, gates and doors do; the MCP line reads “Working” (Whombat CX-54b). | Home Assistant's server lists 127 tools on John's box, 102 were marked Always asks and every one New, and GetLiveContext's description ran five lines. |
