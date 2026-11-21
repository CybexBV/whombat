# Settings as a tab on the phone (AP-2620…AP-2629)

John, 2026-10-19: “In the Android app I want a dedicated settings button in the menu at the bottom of the screen. The
current settings page is very long and should be redesigned … perhaps we should use tabs on mobile also?” I proposed a
Settings tab that opens a short list with the web's tab names, a page per part, and tabs with an underline on
Connections (mockup `docs/design-handoff/settings-mobile/index.html`); he answered “I agree with everything, please
implement fully”. The tabs are their own stream: `underline-tabs-android.md` (AP-2630…AP-2639). Phone only: the web's
Settings stays as it is.

## AP-2620 Settings is the bar's last tab

The one-Whombat shell's bars are Chat · Connections · Watch · Settings and Connections · Chats · Watch · Settings
(`ASSISTANT_TABS`, `TASK_CHAT_TABS`; a gear, “Settings”). The crew bar (Inbox · Channels · Agents · Search) keeps four:
its avatar on the Inbox opens the Settings tab, registered in every set like the others. `whombat://settings` opens it.
A saved Settings tab is restored as any other (Chat's set never restores a tab, CHT-22); the crew set maps it to the
Inbox.

## AP-2621 Pills pick a value

The segmented control moves from the settings sheet to `ui/Segmented.tsx`. It stays for choosing a value (the theme, a
range, Off · Ask · On); where the phone shows parts of a page it uses tabs with an underline (AP-2630).

## AP-2622 A short list instead of tabs

Seven tab names don't fit across a phone, parts like This Whombat have parts of their own, and a list can say how each
part is doing. So the tab is: the title (32/700, as Connections), “Update available” when a newer app is out, a card
with you (your face, name, “Profile · your photo and Dusty”) that opens Profile, then one card: Theme (System · Light ·
Dark, up to 216dp wide beside the whole word, saved to the account) and a row per part — Notifications, Vault, Members,
AI, Skills, Connections, This Whombat — with the web's names in the web's order. The Vault sits after Notifications: the phone has no sidebar,
and the sheet kept it under Profile. A part the phone has nothing for is left out as before (`settingsGroups`). Rows are
60dp: an icon (bell, key, people, sparkles, book, link, server), the name over one line, a dot and the line in `warn` or
`bad` when the part isn't fine, a chevron.

## AP-2623 Each row's line

Read by `useSettingsRows` from what each page reads anyway, so a page opens from the cache; nothing shows while a part
loads.

- Notifications: “Do not disturb until 14:30”, else “Quiet hours 22:00–07:00” (“all day”), else nothing.
- Vault: “9 entries”, “Empty”; a failing check first, in `bad` (“1 doesn’t work”).
- Members: “Just you”, “3 people · 1 invitation”.
- AI: a sign-in in trouble by name and state (“Codex: Sign-in expired”, its tone); “Not signed in” in `warn` when no
  provider is; else who is signed in (“Claude Code signed in”). A second provider nobody signed in to isn't a problem.
  The sign-ins are read once here; the AI page reads them every 30 s.
- Skills: “187 skills · 2 need setting up”.
- Connections: the first that needs you (“Google: Needs signing in again”, `warn`), else “GitHub, Google and 2 more”,
  “Nothing connected yet”.
- This Whombat: AP-2626.

## AP-2624 The tab's dot

`warn` or `bad` when AI or This Whombat needs the viewer; otherwise `ok` (green) while a newer app is ready, the
avatar's dot before. Connections and Watch have tabs of their own for what they look after, so their troubles don't
light Settings. TalkBack hears “Settings, something needs you” or “Settings, a newer app is ready”. A managed
Whombat's status for the dot is read at start and every five minutes (`['settings', 'appliance-status', scope]`, not
persisted), and again when the tab shows.

## AP-2625 One part, one page

A row opens a page with “‹ Settings” and the web's tab name (25/700): Profile (your photo; your
assistant's name, face, AI and keys), Notifications (Do not disturb, quiet hours, previews, push on this phone), AI (the
provider cards, a managed Whombat's own AI folded, Spend). Vault, Members, Skills and Connections open the screens the
phone had. Addresses: `settings/profile`, `settings/notifications`, `settings/ai`, `settings/whombat`,
`settings/connections`. The web's `/settings?tab=…` now opens them instead of the browser, the old tabs where the web
sends them (SS-02: `usage` → AI, `spend` → Spend, `repos`/`dev`/`feedback` → Connections, `devices` → This Whombat,
`general`/`about` → Profile, `packs` → Skills); `/settings` alone opens the tab. The pages are restored after a restart.
Unlike the mockup, a page covers the bar as every pushed screen in the app does (Vault, Members, a server): the rows
that open those screens would otherwise lose the bar and the others keep it. Back (or the gesture) is one step to the
list.

## AP-2626 This Whombat

A managed Whombat's row opens its Overview (`Whombat`), which gains the audit log at its end; its line is the shared
Overview's from the status alone: the first thing that needs the viewer, else one that isn't fine, else “Up to date ·
Backed up”. A self-hosted server's and the demo world's row opens `SettingsWhombat` (burrow, server, version, audit log);
its line is the server's address or “Demo world on this phone”. A link to `settings/whombat` on a managed Whombat
replaces itself with the Overview.

## AP-2627 Signing out and switching

Sign out (“Leave the demo”) is under the list, then Switch Whombat (managed) or Switch server (a self-hosted server,
signs out first, S-16). The burrow line and the version leave the tab: the version is on This Whombat (About on a managed
Whombat).

## AP-2628 No avatar on Connections

Connections' title has no avatar any more; the settings sheet is gone. The account theme (adopt the account's, save a
pick to it) moves to `AccountThemeProvider`, mounted where the sheet's provider was, so it works on every tab.
