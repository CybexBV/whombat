# Switching Whombats from the burrow name (AP-3080…AP-3089)

John, 2026-10-20: “When an account has several Whombat appliances we should be able to click on the name of the Burrow
and select the other appliance.” Before this, the web had no way to another Whombat but typing `/appliances` (the
`switchAppliance` service had no caller), and the phone's Settings → “Switch Whombat” went to the full list. I proposed
the menu below with a mockup, John: “Yes”. Client only: control's directory (`devices.list`) and the list's Open already
had everything.

| ID | Decision | Why |
|---|---|---|
| AP-3080 | **One model for the menu, web and phone** (`switcherRows` in `@whombat/client/managed`): the organization's Whombats from the directory, retired ones left out, the open one first, the others by name. Each says “This Whombat”, “Set up this device” (no pin here, or not let in), “Online” (seen in the last 2 minutes, the list's rule) or “Offline · last seen …”, the list's words. The name is the directory's (`name ?? device`, as the list), not the burrow's. | The list and the menu must agree. Burrows are often named after the organization (AP-75), so two Whombats of one organization usually carry the same burrow name; the directory name tells them apart, and control never learns burrow names (CL-02). |
| AP-3081 | **The burrow at the top of the sidebar becomes a button only when there is another Whombat** (`showsSwitcher`): the same logo, name and place, a chevron at its end, the `sel` background on hover and while open, focus ring, `aria-expanded`, label “Cybex. Your Whombats”. Alone, or on a self-hosted server or the demo world, it stays the name as before. | A menu with one entry is noise; most people have one Whombat. |
| AP-3082 | **The menu** under the button (≥ 280 px, `sf`, `line2` border, the modal shadow): YOUR WHOMBATS, the rows (dot, name 15/600, line 13 `mut`, the open one ticked with `aria-current`), a hairline, **All Whombats** (the list) and, for the organization's owners and admins, **Claim a Whombat** (control's `claim` right, `canClaimIn`). Esc and focus leaving close it. Choosing a Whombat runs the list's Open (AP-64): straight in where this browser is let in, else Set up this device or pairing; already at `/`, the root renders again so the new one opens (the address doesn't change). The directory is read when the shell mounts (fresh a minute) and again each time the menu opens. | The same rules as the list, with no second way to open a Whombat. Switching closes the old session and clears its cache as “Switch Whombat” always did (AP-17). |
| AP-3083 | **One organization, as the list**: the menu lists the Whombats of the organization the app is in (`cloud.orgs[0]`), like Pick a Whombat. | The whole managed root (tickets, pairing, recovery, billing) works in one organization; Whombats across organizations is its own change. |
| AP-3084 | **The phone: Settings → “Switch Whombat” opens a sheet** (`WhombatsSheet`) with the same rows (44 dp, hairlines, the open one checked in `brand`), then All Whombats and Claim a Whombat; a tap opens one as the list's Open does. The phone has no sidebar (sidebar.md), so the sheet is where it goes. | One tap fewer than the full list, the same words as the web. |
| AP-3085 | **whombat-app 0.104.0.** No contract change (contracts stay 0.100.1). | A feature: a minor. |

AP-3080…AP-3085 used; AP-3086…AP-3089 kept for this work's follow-ups.

## Naming a Whombat (AP-3086…AP-3088)

John, 2026-10-21, with a screenshot of the menu showing `wb-k2rt-8pwn-5521` and `wb-h7mq-2xvd-4410`: “The name of the
Whombat appliance selector should be the friendly name that was given to it by the user.” The menu already shows the
directory's name (AP-3080), but nothing in the apps could set it: control has had `devices.rename` (owners and admins,
its `devices` right) since the directory, without a caller, so every Whombat's name was empty (John's DEV control: all
null) and the menu and the list fell back to the id.

| ID | Decision | Why |
|---|---|---|
| AP-3086 | **Owners and admins name a Whombat on the list** (Pick a Whombat, which the menu's All Whombats opens). Each Whombat in use gets **Rename** under its line (web) or a quiet **Rename · name** button under the list (phone); the field takes its place with the current name (empty when it has none), the id under it, Save and Cancel (Esc on the web). The name goes to control's `devices.rename`; the list, the registry and the menu (it reads the directory each time it opens) show it from then on. No change to the menu itself, and no burrow names to control (CL-02). | The directory name is the one that tells an organization's Whombats apart (AP-3080); the list is where they all are, one click from the menu. |
| AP-3087 | **One check for web and phone** (`@whombat/client/managed` `naming.ts`): `canNameIn` (owner, admin), `whombatNameError` (1–80 characters once trimmed, control's `DisplayName`), `renameErrorText` (forbidden → only owners and admins, not found → not in your organization, anything else → try again). | The two apps refuse and word a refusal the same way. |
| AP-3088 | **whombat-app 0.116.0.** No contract change (contracts stay 0.113.0; `devices.rename` is old). | A feature: a minor. |

AP-3089 kept.

## whombat-app 0.104.0

Checks: `pnpm check`; `e2e-managed/switcher.spec.ts` against the fake world (one Whombat: no button; two: the menu,
Esc, the other one opens in place, All Whombats goes to the list), its screenshot in light. The rest of the managed e2e
suite has 16 failures that fail the same on main without this change (they expect the crew shell's `#billing-v2` and
older Vault words). Not seen on a device: the phone's sheet (typechecked, its rows are the tested model), John's real
Whombats.
