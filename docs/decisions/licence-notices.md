# Third-party notices for the open-source release — 2026-11-05

Whombat is released as open source under AGPL-3.0-only. A review found `pnpm notices --check` failing, the T3 Code
logo's attribution in the checked-in file but not in the generator (regenerating dropped it), a patch
(`@bsky.app/react-native-uitextview`) and three font folders not named, and nothing saying the pinned Claude Code
binaries aren't open source. `pnpm licenses list --prod` leaves optional dependencies out, which is why Claude Code
never showed.

| # | Decision | Reason |
|---|---|---|
| LNC-01 | **The generator owns every attribution** (`scripts/notices/notices.ts`, run by `scripts/third-party-notices.ts`): vendored code, ported code, patches, fonts and marks are data in the script, and `THIRD_PARTY_NOTICES.md` is only ever its output. The service marks come from `packages/brand/assets/marks/SOURCES.md`'s table, so a new mark there shows without touching the script. | A hand edit to the file is lost on the next run; that is how the T3 Code logo went missing. |
| LNC-02 | **The notices describe the tree they are made in, and the run fails on anything third-party in it that they don't describe**: a file in `patches/`, a `vendor/*` folder, a font file that isn't Bricolage Grotesque or DM Mono or lacks `OFL.txt` and its own licence file beside it, a mark file without a row in SOURCES.md, a mark licence the script has no words for, an optional dependency of a workspace package. What the script describes but a tree lacks is neither required nor listed. Fonts are held to that rule rather than listed by folder: the notices name only the folders the apps serve. | New third-party material can't slip in unattributed. The public copy leaves out `docs/` folders (the design references carry font copies), and the same file has to be right, and pass `--check`, in both. |
| LNC-03 | **Dependency licences are checked against a list of those that sit with AGPL-3.0-only** (permissive licences, Apache-2.0, MPL-2.0, CC-BY-4.0 data, OFL-1.1 fonts, Python-2.0). An `OR` expression is used under its most permissive open alternative; packages that also offer a licence the AGPL can't take (node-forge's GPL-2.0, mailsplit's EUPL) are named. A package whose own metadata is wrong is corrected by hand with the reason (khroma: no `license` field, MIT licence file). Anything else stops the run. | Flags an incompatible or unknown licence the day it arrives, not at release. |
| LNC-04 | **“Not open source” names Claude Code**, its terms, and how it arrives: optional npm dependencies of `packages/agent-runtime` here (downloaded by `pnpm install`, not in the repository), left out of the runtime bundle (`claude.bundled: false`), the pages and the phone apps, not in the appliance image; the appliance's manager installs it on an owner's request from Whombat's signed client channel, which serves Anthropic's binary unmodified from Whombat's update host. | Says plainly that Whombat's licence doesn't cover it and where it is redistributed, so the redistribution question below is visible. |
| LNC-05 | **`pnpm check` and CI run `pnpm notices --check`** (CI phase `notices`, after lint). It takes under a second. | The file went stale because nothing checked it. A dependency change now needs `pnpm notices` in the same commit. |

## Open for John

- **Sonarr and Radarr marks.** Their source was recorded as Simple Icons, which has never had either; where the path
  data came from isn't known. Both projects are GPL-3.0 (compatible with the AGPL if their logo art is under it). The
  notices say “not verified yet” until someone finds the source or redraws them from the projects' own logos.

- **Claude Code on Whombat's update host.** The client channel republishes Anthropic's binary (unmodified, packed in a
  `tar.gz`) from Whombat's own update host. Claude Code's licence is “All rights reserved; use subject to Anthropic's
  legal agreements”, which grants no redistribution right that we have found. Either get Anthropic's permission, or let
  the manager download from `downloads.claude.ai` itself and keep only the signed pin (version and sha256) in the
  channel. That is the appliance's code.
- **Marks under share-alike or brand terms.** Gentoo's logo is CC BY-SA 2.5 (it allows a later version, so the adapted
  path data can go under CC BY-SA 4.0, which is one-way compatible with GPL-3.0). Fedora, Google, Microsoft, Mollie,
  Moneybird and Pipedrive marks are used under their brand terms or as published, not under a free licence: fine for
  naming the service, but a fork redistributes them under those terms, not the AGPL.
