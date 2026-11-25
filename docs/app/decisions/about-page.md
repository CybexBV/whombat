# About, shorter (AP-9960…AP-9967)

John, 2026-11-25, on the phone's This Whombat: the AT A GLANCE row that opens About read “Up to date · Software …”,
which doesn't say where it goes (“we should rename it to ‘About’”), and HARDWARE took most of About. He agreed to:
name the row About, give HARDWARE one row that opens its own screen, put VERSION and UPDATES in one card, move
CONNECTION into REACH and keep the help cards last. The web's About already folds every part (settings-groups.md
STG-09) and keeps its layout; only the row's name is shared.

| Id | Decision | Why |
| --- | --- | --- |
| AP-9960 | **The AT A GLANCE row that opens About is titled “About”**, on the web and the phone (`THIS_WHOMBAT_TEXT.aboutTitle`): its line is how the updates stand (“Up to date · Software whombat-20261125.9”, or what it waits for, or why it failed), with its dot; without an update row the versions (“App 0.74.0 · Whombat 2026.9.2”). Supersedes this-whombat-sections.md AP-1225's titles for these two rows. | A row's title says where the chevron goes; the state is the line under it. |
| AP-9961 | **HARDWARE on the phone's About is one row**: the machine's name over “Every part has a driver.” with a green dot, or with the worst dot and the parts that don't work in a row each under it, opening the **Hardware** screen (`WhombatHardware`). That screen holds what the card held (the machine, CPU, memory and kernel, Share report, every part by group). NETWORK's and BLUETOOTH's See hardware open it directly; its way back is named after where it came from. Supersedes hardware-support-android.md AP-3255 (opening About at HARDWARE) and AP-3259 (the whole card on About) in part. | The list of parts filled About; it is for whoever helps with a problem, and a part that doesn't work stays in sight. |
| AP-9962 | **VERSION & UPDATES is one card on About**: this app (Check), the Whombat, Hermes Agent, then the update rows (Install where one waits), Ask before updating, Updates from, the oldest app builds let in, Keep server agents up to date, Privacy last. Settings keeps its own VERSION card. | Both answer “what runs and how is it kept up to date”; two cards repeated the Whombat's version. |
| AP-9963 | **This phone's connection is REACH's first row** (the Whombat's name, “Connected · end-to-end encrypted · Fingerprint …”), shown even before REACH is read; no CONNECTION card. | Both say how the phone reaches the Whombat. |
| AP-9964 | **About's order**: VERSION & UPDATES, REACH, the own address, TURNED OFF HERE, HARDWARE, then help: REMOTE HELP, the reports to the Whombat Team, DIAGNOSTICS, and this phone's fingerprint. | What people look up most first; the tools for a problem together at the end. |

## The Hardware and Remote help screens (2026-11-25)

John, the same day, on the new Hardware screen: “Make the hardware page look pretty, use icons and more visual things
to improve it. The remote help section can grow very long as well, improve that also.” Remote help kept every step of
up to 20 visits (200 steps each) in one list on About.

| Id | Decision | Why |
| --- | --- | --- |
| AP-9965 | **The Hardware screen leads with the machine**: its icon on a brand wash (a laptop where it has a battery, a box for a virtual machine, else a server), its name, and a badge — green “Every part works”, or “2 parts need attention” in the worst part's colour — over its facts as tiles (Processor with its cores across the width, then Memory, Storage — all disks together, where they say their size — and System two by two; `hardwareSpecs`) and Share report with its icon. The parts that don't work follow under NEEDS ATTENTION; then each group is a card of its own, labelled with its count (“NETWORK · 3”), each part with the icon of its kind on a tile (red or amber when it doesn't work), its vendor and what it does, and its driver in a mono chip (“No driver” on red). About's HARDWARE row and its problem rows carry the same icons. | The machine at a glance first; icons say what a part is before its name is read. |
| AP-9966 | **Remote help on About is a short card**: off, one row (“Off”, “Nobody can get in. Turn it on when Whombat support asks.”, how many visits) that opens the **Remote help** screen (`WhombatRemoteHelp`); on, the state with Stop, the help code and who is connected stay on About, then a “What support did” row to the screen. The screen holds the controls and the history. The demo world's This Whombat keeps the whole section. Supersedes remote-help.md AP-4470 in part (where it is). | What must be seen while it's on stays in sight; the history has a page of its own. |
| AP-9967 | **What support did, visit by visit** (`remoteHelpVisitGroups`): each visit an eye (Look) or a wrench (Look and fix) tile, green with a “Now” pill while it lasts, who came, then “Today 14:02 · Look and fix · 5 steps”; under it its last three steps (each with its clock only), “Show all N steps” for the rest, and “Command line” where one was kept (no Show on a step). The newest three visits show, the rest behind “Show N earlier visits” (`REMOTE_HELP_FOLD`). The web's REMOTE HELP card shows them the same way (John, 2026-11-25: “fix the remote web long list also”). Supersedes remote-help.md AP-4475 and AP-4451 in part. | A long history folds to a few lines per visit, and each visit says at once who, when and how much. |
