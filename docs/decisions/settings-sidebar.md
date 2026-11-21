# The Vault in the sidebar: the runtime's copy (SB-01)

John, 2026-10-03: the Vault goes in the sidebar under Automations; the account menu keeps one Settings link; a
channel's thread opens full width; Connections becomes an overview with each provider's logo. The web side is
whombat-app 0.31.0 (`docs/decisions/settings-sidebar.md`, AP-670…AP-673), the shared copy contracts 0.40.1 (CT-242).

## SB-01 Agents and notices name the Vault, not Settings → Vault

The Vault is a page of its own (`/vault`; `/settings?tab=vault` redirects there), so nothing tells people to look in
Settings for it any more:

- The agents' instructions (persona `vault.ts`, `browser.ts`): “ask the person to add it to their Vault (in the
  sidebar) and give you a key to it”. The SSH setup steps and an unheld entry's line come from contracts 0.40.1
  (“Vault → Add → SSH key …”, “… give you a key: Vault → “Server Access Key” → …”).
- The owner's notices: a withheld key (“RECENT USE in the Vault shows which entry”), a key to rotate (“In the Vault,
  open “Deploy key” …”), a changed host key (“In the Vault the server shows …”). The home-network refusals come from
  contracts (“… to the home network list in the Vault.”).
- Settings → Connections stays as it is named: it is still a Settings tab (now an overview, AP-673).
