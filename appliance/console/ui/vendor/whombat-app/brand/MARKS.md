# Brand marks

One file per mark the apps draw (Whombat marks.md MK-03), written from `src/` by `pnpm --filter @whombat/brand
export-marks`; `src/files.test.ts` fails when a file is stale. Edit the geometry in `src/*Marks.ts`, never these files.
`currentColor` (marks published in black) draws black here and follows the text colour in the apps.

Simple Icons marks are from simple-icons 16.34.0 (the connections' and guest platforms' first ones, Synology and QNAP)
and 16.35.0 (the operating systems', Gmail, MCP, and the connections of Whombat connections-more.md CM-28); the licence
column is Simple Icons' record for the mark. The TrueNAS connection draws `truenas.svg`, the operating system's. A Lucide
icon stands in where a project's own logo is GPL artwork (SABnzbd, NZBHydra2), as for MX Linux and Garuda. Pterodactyl's
and QNAP's navy vanished on the dark theme, so they are drawn in `currentColor` like CentOS's; Synology publishes its
wordmark black, so it is too; T3 Code's logo, white letters on a black tile, is drawn as its letters alone, in
`currentColor`. The marks and names are trademarks of their owners; showing them names the service or system and
implies no endorsement.

| File | Mark | From | Licence |
|---|---|---|---|
| `adguard.svg` | AdGuard | Simple Icons `adguard` (<https://adguard.com/en/media-materials.html>) | CC0-1.0 |
| `ai_gateway.svg` | AI gateway | Lucide `sparkles` | ISC |
| `airtable.svg` | Airtable | Simple Icons `airtable` (<https://airtable.com/newsroom>) | CC0-1.0 |
| `almalinux.svg` | AlmaLinux | Simple Icons `almalinux` (<https://almalinux.org>) | CC0-1.0 |
| `alpinelinux.svg` | Alpine Linux | Simple Icons `alpinelinux` (<https://alpinelinux.org>) | CC0-1.0 |
| `archlinux.svg` | Arch Linux | Simple Icons `archlinux` (<https://www.archlinux.org/art>) | CC0-1.0 |
| `artixlinux.svg` | Artix Linux | Simple Icons `artixlinux` (<https://gitea.artixlinux.org/artix/artwork/src/commit/256432e3d06b3e9024bfd6912768e80281ea3746/icons/logo-gray.svg>) | CC0-1.0 |
| `asahilinux.svg` | Asahi Linux | Simple Icons `asahilinux` (<https://github.com/AsahiLinux/artwork/blob/292637c9658c1491ddc1128fb6134aec01d904dd/logos/svg/AsahiLinux_logomark_mono.svg>) | CC0-1.0 |
| `cachyos.svg` | CachyOS | Simple Icons `cachyos` (<https://commons.wikimedia.org/wiki/File:CachyOS_Logo.svg>) | CC0-1.0 |
| `centos.svg` | CentOS | Simple Icons `centos` (<https://wiki.centos.org/ArtWork/Brand/Logo>) | CC0-1.0 |
| `claude.svg` | Claude | Simple Icons `claude` (<https://claude.ai>) | CC0-1.0 |
| `cloudflare.svg` | Cloudflare | Simple Icons `cloudflare` (<https://www.cloudflare.com/logo/>) | CC0-1.0 |
| `custom_api.svg` | API | Lucide `braces` | ISC |
| `custom_mcp.svg` | Model Context Protocol | Simple Icons `modelcontextprotocol` (<https://github.com/modelcontextprotocol/docs/blob/573dc60c2e7aab2605b29d0bf27194aa7b02e4fb/logo/light.svg>) | CC0-1.0 |
| `debian.svg` | Debian | Simple Icons `debian` (<https://www.debian.org/logos>) | CC-BY-SA-3.0 |
| `deepin.svg` | deepin | Simple Icons `deepin` (<https://commons.wikimedia.org/wiki/File:Deepin_logo.svg>) | CC0-1.0 |
| `devin.svg` | Devin | LobeHub Icons `devin` as Fusebox's dashboard draws it (<https://github.com/lobehub/lobe-icons>) | MIT (LobeHub) |
| `docker.svg` | Docker | Simple Icons `docker` (<https://www.docker.com/company/newsroom/media-resources>) | CC0-1.0 |
| `dropbox.svg` | Dropbox | Simple Icons `dropbox` (<https://www.dropbox.com/branding>) | CC0-1.0 |
| `elementary.svg` | elementary | Simple Icons `elementary` (<https://elementary.io/brand>) | CC0-1.0 |
| `endeavouros.svg` | EndeavourOS | Simple Icons `endeavouros` (<https://github.com/endeavouros-team/endeavouros-theming/blob/135f642c980ed8d8fc212783eb478f96226f6c72/endeavouros-logo-text.svg>) | CC0-1.0 |
| `esphome.svg` | ESPHome | Simple Icons `esphome` (<https://github.com/esphome/developers.esphome.io/blob/7c0304aa36536c63c93b1f19ba18969f96df0e08/docs/images/logo.svg>) | CC0-1.0 |
| `feedback.svg` | Website feedback | Lucide `message-square-text` | ISC |
| `fedora.svg` | Fedora | Simple Icons `fedora` (<https://docs.fedoraproject.org/en-US/project/brand/>) | custom |
| `findmy.svg` | Find My | drawn for Whombat in Lucide's stroke: a location pin over two people (never Apple's Find My icon) | own |
| `forgejo.svg` | Forgejo | Simple Icons `forgejo` (<https://codeberg.org/forgejo/meta/raw/branch/readme/branding/logo/forgejo-monochrome.svg>) | CC-BY-SA-4.0 (Caesar Schinas) |
| `freebsd.svg` | FreeBSD | Simple Icons `freebsd` (<https://www.freebsdfoundation.org/about/project/>) | CC0-1.0 |
| `frigate.svg` | Frigate | Simple Icons `frigate` (<https://frigate.video>) | CC0-1.0 |
| `fusebox.svg` | Fusebox | Fusebox's `assets/icon.svg` (John's own product) | Unlicense |
| `gemini.svg` | Gemini | LobeHub Icons `gemini` as Fusebox's dashboard draws it (<https://github.com/lobehub/lobe-icons>), its colour gradients left out | MIT (LobeHub) |
| `gentoo.svg` | Gentoo | Simple Icons `gentoo` (<https://wiki.gentoo.org/wiki/Project:Artwork/Artwork#Variations_of_the_.22g.22_logo>) | CC-BY-SA-2.5 |
| `github.svg` | GitHub | Simple Icons `github` (<https://github.com/logos>) | CC0-1.0 |
| `github_actions.svg` | GitHub Actions | Simple Icons `githubactions` (<https://github.com/features/actions>) | CC0-1.0 |
| `gitlab.svg` | GitLab | Simple Icons `gitlab` (<https://about.gitlab.com/press/press-kit/>) | CC0-1.0 |
| `gmail.svg` | Gmail | Simple Icons `gmail` (<https://fonts.gstatic.com/s/i/productlogos/gmail_2020q4/v8/192px.svg>) | CC0-1.0 |
| `google.svg` | Google | Google's Sign-In branding “G” | Google brand terms |
| `grafana.svg` | Grafana | Simple Icons `grafana` (<https://grafana.com>) | CC0-1.0 |
| `hetzner.svg` | Hetzner | Simple Icons `hetzner` (<https://www.hetzner.com>) | CC0-1.0 |
| `homeassistant.svg` | Home Assistant | Simple Icons `homeassistant` (<https://github.com/home-assistant/assets/blob/0f69676da79c3881e7dfca6d6c0a5739f88273d8/logo/home-assistant-logo.zip>) | CC0-1.0 |
| `hubspot.svg` | HubSpot | Simple Icons `hubspot` (<https://www.hubspot.com/style-guide>) | CC0-1.0 |
| `imap.svg` | Email | Lucide `mail` | ISC |
| `immich.svg` | Immich | Simple Icons `immich` (<https://github.com/immich-app/immich/blob/25c9b779e4d19bc34551f8b137266a459e0d70e1/design/immich-logo.svg>) | CC0-1.0 |
| `jellyfin.svg` | Jellyfin | Simple Icons `jellyfin` (<https://jellyfin.org/docs/general/contributing/branding.html>) | CC0-1.0 |
| `kalilinux.svg` | Kali Linux | Simple Icons `kalilinux` (<https://www.kali.org/docs/policy/trademark/>) | CC0-1.0 |
| `kdeneon.svg` | KDE neon | Simple Icons `kdeneon` (<https://community.kde.org/Neon>) | CC0-1.0 |
| `kimi.svg` | Kimi | LobeHub Icons `kimi` as Fusebox's dashboard draws it (<https://github.com/lobehub/lobe-icons>), its white letter in `currentColor` | MIT (LobeHub) |
| `kubuntu.svg` | Kubuntu | Simple Icons `kubuntu` (<https://kubuntu.org>) | CC0-1.0 |
| `linux.svg` | Linux | Simple Icons `linux` (<https://www.linuxfoundation.org/the-linux-mark/>) | CC0-1.0 |
| `linuxcontainers.svg` | Linux Containers | Simple Icons `linuxcontainers` (<https://github.com/lxc/linuxcontainers.org/blob/29d3299ddf8718099b6de1464570fbbadbaabecb/static/img/containers.svg>) | CC0-1.0 |
| `linuxmint.svg` | Linux Mint | Simple Icons `linuxmint` (<https://github.com/linuxmint/brand-logo/blob/540ac3b08e987866d77a340f557f994c988ac2ae/ring-mono-green.svg>) | CC0-1.0 |
| `lubuntu.svg` | Lubuntu | Simple Icons `lubuntu` (<https://lubuntu.net>) | CC0-1.0 |
| `mac.svg` | Mac | Lucide `monitor` (Apple’s logo is a trademark and isn’t drawn) | ISC |
| `mail.svg` | Email | Lucide `mail` | ISC |
| `manjaro.svg` | Manjaro | Simple Icons `manjaro` (<https://manjaro.org>) | CC0-1.0 |
| `meta.svg` | Meta | LobeHub Icons `meta` as Fusebox's dashboard draws it (<https://github.com/lobehub/lobe-icons>), its blue gradients drawn as flat blues | MIT (LobeHub) |
| `microsoft.svg` | Microsoft | Microsoft's logo (four squares) | Microsoft brand terms |
| `mollie.svg` | Mollie | the “m” of docs.mollie.com `Mollie-Logo-Black-2023-Clearspace.svg`, on its app icon’s tile | Mollie brand |
| `moneybird.svg` | Moneybird | moneybird.nl `/assets/images/moneybird-logo-mark-blue.svg` | Moneybird brand |
| `netbsd.svg` | NetBSD | Simple Icons `netbsd` (<https://www.netbsd.org>) | CC0-1.0 |
| `nextcloud.svg` | Nextcloud | Simple Icons `nextcloud` (<https://nextcloud.com/press/>) | CC0-1.0 |
| `nginx_proxy_manager.svg` | Nginx Proxy Manager | Simple Icons `nginxproxymanager` (<https://github.com/NginxProxyManager/nginx-proxy-manager/blob/2a06384a4aa597777931d38cef49cf89540392e6/docs/.vuepress/public/logo.svg>) | CC0-1.0 |
| `nixos.svg` | NixOS | Simple Icons `nixos` (<https://brand.nixos.org/logos/nixos-logomark-black-flat-minimal.svg>) | CC-BY-4.0 |
| `nobaralinux.svg` | Nobara Linux | Simple Icons `nobaralinux` (<https://wiki.nobaraproject.org>) | CC0-1.0 |
| `notion.svg` | Notion | Simple Icons `notion` (<https://www.notion.so>) | CC0-1.0 |
| `nzbhydra.svg` | NZBHydra2 | Lucide `search` (NZBHydra2's own logo is GPL-3.0 artwork) | ISC |
| `onepassword.svg` | 1Password | Simple Icons `1password` (<https://1password.com/press>) | CC0-1.0 |
| `openai.svg` | OpenAI | Simple Icons `openai` (an earlier release; since removed there) | CC0-1.0 |
| `openbsd.svg` | OpenBSD | Simple Icons `openbsd` (<https://en.wikipedia.org/wiki/OpenBSD>) | CC0-1.0 |
| `openmediavault.svg` | openmediavault | Simple Icons `openmediavault` (<https://github.com/openmediavault/openmediavault/blob/12f8ef70f19f967733b744d6fb6156a4181f1ddc/deb/openmediavault/workbench/src/favicon.svg>) | CC0-1.0 |
| `opensuse.svg` | openSUSE | Simple Icons `opensuse` (<https://github.com/openSUSE/artwork/blob/33e94aa76837c09f03d1712705949b71a246a53b/logos/buttons/button-colour.svg>) | CC0-1.0 |
| `openwrt.svg` | OpenWrt | Simple Icons `openwrt` (<https://openwrt.org/docs/guide-graphic-designer/openwrt-logo>) | CC0-1.0 |
| `opnsense.svg` | OPNsense | Simple Icons `opnsense` (<https://github.com/opnsense/core/blob/f4b69b9b565d2747eb40d7d23e060f4a3c81a071/src/opnsense/www/themes/opnsense/build/images/icon-logo.svg>) | CC0-1.0 |
| `overseerr.svg` | Overseerr | Overseerr's `public/os_icon.svg` (<https://github.com/sct/overseerr>), its gradient drawn as one colour | MIT (sct) |
| `paperless.svg` | Paperless-ngx | Simple Icons `paperlessngx` (<https://github.com/paperless-ngx/paperless-ngx/blob/e16645b146da24f07004eb772a455450354a37a7/resources/logo/web/svg/square.svg>) | CC0-1.0 |
| `parrotsecurity.svg` | Parrot Security | Simple Icons `parrotsecurity` (<https://gitlab.com/parrotsec/project/documentation/-/blob/d1d426b9cb3ea0efd16a2b34056c1ebb21bb9af9/static/img/parrot-logo.svg>) | CC0-1.0 |
| `pihole.svg` | Pi-hole | Simple Icons `pihole` (<https://docs.pi-hole.net>) | CC0-1.0 |
| `pipedrive.svg` | Pipedrive | pipedrive.com's site mark (the “p” on its green circle) | Pipedrive brand |
| `plausible.svg` | Plausible Analytics | Simple Icons `plausibleanalytics` (<https://github.com/plausible/docs/blob/be5c935484e075f1e0caf3c9b3351ddd62348139/static/img/logo.svg>) | CC0-1.0 |
| `plex.svg` | Plex | Simple Icons `plex` (<https://brand.plex.tv>) | CC0-1.0 |
| `popos.svg` | Pop!_OS | Simple Icons `popos` (<https://github.com/system76/brand/blob/7a31740b54f929b62a165baa61dfb0b5164261e8/Pop_OS%20branding/Pop_icon.svg>) | CC0-1.0 |
| `portainer.svg` | Portainer | Simple Icons `portainer` (<https://www.portainer.io>) | CC0-1.0 |
| `ps5.svg` | PlayStation | Simple Icons `playstation` (<https://www.playstation.com/>) | CC0-1.0 |
| `proxmox.svg` | Proxmox | Simple Icons `proxmox` (<https://www.proxmox.com/en/news/media-kit>) | CC0-1.0 |
| `proxmox_backup.svg` | Proxmox | Simple Icons `proxmox` (<https://www.proxmox.com/en/news/media-kit>) | CC0-1.0 |
| `pterodactyl.svg` | Pterodactyl | Simple Icons `pterodactyl` (<https://github.com/pterodactyl/panel/blob/eaf46429f2a001469fb5f18f7891ce8e5be7f049/public/favicons/favicon-96x96.png>) | CC0-1.0 |
| `qbittorrent.svg` | qBittorrent | Simple Icons `qbittorrent` (<https://github.com/qbittorrent/qBittorrent/blob/73028f9930d9ab9d89edb60ed4aedb66d75669d9/src/icons/qbittorrent-tray-light.svg>) | CC0-1.0 |
| `qemu.svg` | QEMU | Simple Icons `qemu` (<https://wiki.qemu.org/Logo>) | CC0-1.0 |
| `qnap.svg` | QNAP | Simple Icons `qnap` (<https://marketing.qnap.com/resource/qnap-logo-k100>) | CC0-1.0 |
| `qubesos.svg` | Qubes OS | Simple Icons `qubesos` (<https://github.com/QubesOS/qubes-attachment/blob/ed7e552eb8a5fca4e099361d137793d3551b3968/icons/qubes-logo-home.svg>) | CC0-1.0 |
| `radarr.svg` | Radarr | Radarr's logo (<https://github.com/Radarr/Radarr>, a GPL-3.0 project) as 24-unit path data; not from Simple Icons, which has no Radarr, and where the path data came from isn't recorded | unverified |
| `raspberrypi.svg` | Raspberry Pi | Simple Icons `raspberrypi` (<https://www.raspberrypi.org/trademark-rules>) | CC0-1.0 |
| `redhat.svg` | Red Hat | Simple Icons `redhat` (<https://www.redhat.com/en/about/brand/new-brand/details>) | CC0-1.0 |
| `rockylinux.svg` | Rocky Linux | Simple Icons `rockylinux` (<https://github.com/rocky-linux/branding/blob/94e97dd30b87d909cc4f6a6838a2926f77f9ac47/logo/src/icon-black.svg>) | CC-BY-SA-4.0 |
| `sabnzbd.svg` | SABnzbd | Lucide `download` (SABnzbd's own logo is GPL-2.0+ artwork) | ISC |
| `slackware.svg` | Slackware | Simple Icons `slackware` (<https://en.wikipedia.org/wiki/Slackware>) | CC0-1.0 |
| `solus.svg` | Solus | Simple Icons `solus` (<https://getsol.us/branding/>) | CC0-1.0 |
| `sonarr.svg` | Sonarr | Sonarr's logo (<https://github.com/Sonarr/Sonarr>, a GPL-3.0 project) as 24-unit path data; not from Simple Icons, which has no Sonarr, and where the path data came from isn't recorded | unverified |
| `suse.svg` | SUSE | Simple Icons `suse` (<https://brand.suse.com>) | CC0-1.0 |
| `synology.svg` | Synology | Simple Icons `synology` (<https://www.synology.com/en-global/company/branding>) | CC0-1.0 |
| `t3code.svg` | T3 Code | the “T3” of T3 Code's `assets/prod/logo.svg` (<https://github.com/pingdotgg/t3code>), without its black tile | MIT (T3 Tools Inc.) |
| `tails.svg` | Tails | Simple Icons `tails` (<https://tails.boum.org/contribute/how/promote/material/logo/>) | CC0-1.0 |
| `tailscale.svg` | Tailscale | Simple Icons `tailscale` (<https://tailscale.com/press>) | CC0-1.0 |
| `talos.svg` | Talos | Simple Icons `talos` (<https://github.com/siderolabs/talos/blob/e3fda049fee62f3c5cef4ae08eaf848826a6dbed/website/assets/icons/logo.svg>) | CC0-1.0 |
| `todoist.svg` | Todoist | Simple Icons `todoist` (<https://doist.com/press>) | CC0-1.0 |
| `tracker.svg` | Report tracker | Lucide `inbox` (a tracker connection shows its driver's own logo instead) | ISC |
| `truenas.svg` | TrueNAS | Simple Icons `truenas` (<https://www.truenas.com>) | CC0-1.0 |
| `ubuntu.svg` | Ubuntu | Simple Icons `ubuntu` (<https://design.ubuntu.com/resources>) | CC0-1.0 |
| `ubuntumate.svg` | Ubuntu MATE | Simple Icons `ubuntumate` (<https://ubuntu-mate.org>) | CC0-1.0 |
| `unifi_access.svg` | Ubiquiti | Simple Icons `ubiquiti` (<https://www.ui.com>) | CC0-1.0 |
| `unifi_network.svg` | Ubiquiti | Simple Icons `ubiquiti` (<https://www.ui.com>) | CC0-1.0 |
| `unifi_protect.svg` | Ubiquiti | Simple Icons `ubiquiti` (<https://www.ui.com>) | CC0-1.0 |
| `unraid.svg` | Unraid | Simple Icons `unraid` (<https://unraid.net>) | CC0-1.0 |
| `uptime.svg` | Website or address | Lucide `activity` | ISC |
| `vertex.svg` | Vertex AI | LobeHub Icons `vertexai` as Fusebox's dashboard draws it (<https://github.com/lobehub/lobe-icons>) | MIT (LobeHub) |
| `voidlinux.svg` | Void Linux | Simple Icons `voidlinux` (<https://alpha.de.repo.voidlinux.org/logos/void-dark2.svg>) | CC0-1.0 |
| `xai.svg` | Grok | LobeHub Icons `grok` as Fusebox's dashboard draws it (<https://github.com/lobehub/lobe-icons>) | MIT (LobeHub) |
| `xubuntu.svg` | Xubuntu | Simple Icons `xubuntu` (<https://commons.wikimedia.org/wiki/File:Xubuntu_Icon.svg>) | CC0-1.0 |
| `zorin.svg` | Zorin | Simple Icons `zorin` (<https://zorin.com/press>) | CC0-1.0 |
