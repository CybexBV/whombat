# Marks for servers and connections (2026-10-18)

John (main checkout): the servers in the sidebar showed a generic icon for a Proxmox and a Debian server; he wants the
Proxmox and the Debian logos, the same for the connections (“it should always be an SVG icon”), and the logos of every
connection and of the Linux systems researched and stored locally. App side: whombat-app `docs/decisions/marks.md`
AP-2200…AP-2205; contracts 0.90.0 CT-399.

## MK-01 A server shows what it runs

A server's `ThingSummary.icon` is its mark, `hostOsMark(server) ?? 'server'` (contracts 0.90): `proxmox` and `unraid` by
the platform (a Proxmox host's os-release says Debian), otherwise its Linux by the os-release name (`debian`, `ubuntu`,
`nixos`…), Tux for another Linux, Linux Containers or QEMU for an Incus or libvirt server without a known system. The
rule lives in contracts because the server picks it for the sidebar and Home while the apps pick it for a server's own
page from the same `HostServer`. `icon` stays a free name, so an older app draws its generic server.

## MK-02 Every connection has a mark

A connection's icon was already its catalog id; the app now has a mark for every catalog entry (Moneybird and Mollie
from their own sites, the MCP mark, Lucide drawings for an AI gateway and an API), so nothing is drawn as a letter any
more. Google mail sends `gmail` (Gmail's mark) instead of `mail`; older apps map `gmail` to their envelope. Devices keep
their kind's glyph (a heat pump is no brand).

## MK-03 Marks are stored as files

Every mark is a file in whombat-app `packages/brand/assets/marks/` with `SOURCES.md` (where it comes from, its
licence): Simple Icons 16.35.0 for the operating systems, the providers' own files for Moneybird and Mollie. GPL-licensed
artwork (MX Linux, Garuda) is not bundled; those systems show Tux. The apps draw from the code, never fetching a logo (the
strict CSP, offline boxes).
