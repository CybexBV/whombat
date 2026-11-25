# About, shorter (AP-9960…AP-9964)

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
