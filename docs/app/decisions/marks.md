# Marks for servers and connections (2026-10-18)

John: the servers in the sidebar showed a generic icon for a Proxmox and a Debian server; he wants the Proxmox and the
Debian logos, the same for every connection (“it should always be an SVG icon”), with the logos of the connections and
of the Linux systems found and stored here. Whombat side: `docs/decisions/marks.md` MK-01…MK-03; contracts 0.90.0
CT-399 (`hostOsMark`).

## AP-2200 Operating systems' marks

`packages/brand/src/osMarks.ts`: every mark contracts 0.90 `HOST_OS_MARKS` can answer that the package didn't have yet
(Debian, Ubuntu and its flavours, Fedora, Rocky, Alma, CentOS, Red Hat, openSUSE/SUSE, Arch and its family, Alpine,
NixOS, Gentoo, Mint, Pop!_OS, Kali, Raspberry Pi OS, TrueNAS, openmediavault, OpenWrt, Talos, the BSDs, Tux and QEMU:
46), path data from Simple Icons 16.35.0 as published. Marks published in black or near-black (relative luminance under
0.03, and CentOS's navy, which vanished on the dark theme) use `currentColor`, like Notion's and Tailscale's. MX Linux
and Garuda are not bundled: Simple Icons records their artwork as GPL-3.0 (contracts leave them out; they show Tux). A
test checks that every `HOST_OS_MARKS` name has a drawing.

## AP-2201 Even-odd shapes

`MarkShape.fillRule: 'evenodd'` for a mark drawn with holes by that rule (Moneybird's); `buildBrandMark` passes it, the
web and react-native-svg draw it.

## AP-2202 Every catalog entry has a mark

So the apps always draw a logo, never a letter: Moneybird's website mark (`moneybird-logo-mark-blue.svg`, centred on a
square box), Mollie's app icon (the white “m” of its 2023 logo from docs.mollie.com on its black tile, drawn as a whole
tile like the tracker's), the Model Context Protocol's mark for an MCP server, and Lucide's `sparkles` (AI gateway) and
`braces` (API) for the two that have no maker. Gmail's mark for the Google mail thing. A test checks every connectable
catalog entry. The connections page's Lucide stand-ins for the Custom entries are gone (web and phone).

## AP-2203 Every mark is stored as a file

`packages/brand/assets/marks/<name>.svg` (82 files) written from the code by `pnpm --filter @whombat/brand export-marks`,
with `SOURCES.md` (where each comes from, its licence). The code stays the source (the apps draw offline under a strict
CSP); `files.test.ts` fails when a file is stale. THIRD_PARTY_NOTICES lists the non-CC0 marks.

## AP-2204 Things draw their mark

`thingMark` (`@whombat/client`, which now depends on `@whombat/brand`): the thing's `icon` when it names a mark (a
server's `debian`/`proxmox` from the Whombat server, a connection's catalog id), else its catalog entry's, else null (a
device, a server whose system isn't known) and the glyph as before. `serverMark` does the same from a `HostServer` (or a
server page's `{ name, version }` os) via `hostOsMark`. Web: the sidebar's rows, a server's and a connection's page head
(the mark on the plain box, which outranks the mock's tinted glyph: John asked for the logos) and the servers table
(Home's Servers card, the Servers page) beside the name.

## AP-2205 The phone

`ThingIcon` takes a `mark`: Things, Home's rows, a server's parts, a connection's page head, and a server's page head
(the mark before its name; it had no icon). Home's single “Servers” row keeps the server glyph: it stands for all of
them.
