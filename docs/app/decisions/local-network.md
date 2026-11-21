# The local network open by default (app)

Whombat `docs/decisions/local-network.md` LN-01…LN-08, contracts 0.56.0 (CT-309), 2026-10-08.

| ID | Decision | Why |
| --- | --- | --- |
| AP-829 | **Settings → This Whombat: LOCAL NETWORK → “Agents may reach your local network”** (was AGENTS’ COMPUTERS → “Agents may reach this network”), with core's new `AGENTS_REACH_LAN_COPY` (hint, toasts). Same switch, same endpoint, same place; it now also opens the whole local network to the Vault, Connections, SSH and the browser on an appliance (LN-01). The home network section and the phone's Vault screen take core's new `homeNetworkIntro`/`noNetworks`. Nothing else changes in the app: the refusal and “Add this network” show only when an owner switched it off. | Says what the switch does now; no new screen for a default that is on. |
