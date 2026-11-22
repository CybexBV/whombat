# Third-party notices of the Whombat appliance

This repository's own code is copyright 2026 Cybex BV and licensed under the GNU Affero General Public License,
version 3 only (`LICENSE`, AGPL-3.0-only). The appliance image built from it is a NixOS system that also contains
software by others under their own licences. Every image carries this file and `LICENSE` in `/etc/whombat/`.

## What the image contains

| Component | Licence | Where its notices are |
|---|---|---|
| NixOS and the nixpkgs packages the image is built from (Linux and its redistributable firmware, systemd, PostgreSQL, Node.js, Python, Chromium, the GitHub CLI and the rest) | each package's own (GPL, LGPL, MIT, BSD, Apache and others; the firmware under its vendors' redistribution terms) | each package in `/nix/store`; per release, the licence inventory of `release/sbom` (`docs/release/sbom.md`) lists every package with its licence |
| The Whombat runtime (the Whombat repository, `nix/packages/runtime`) | AGPL-3.0-only (ours) | `share/whombat/LICENSE`, `THIRD-PARTY-NOTICES.txt` (every npm package in the bundle, with its licence text), the shipped skills' `SOURCES.md` |
| The Whombat app (the Whombat repository's `apps/web`, `packages/`): the box's own web page, and the avatars, brand and tokens the console page uses | AGPL-3.0-only (ours; releases from before HE-63 carry the licence of their time) | the Whombat repository's `THIRD_PARTY_NOTICES.md`; the console page: `share/whombat-console-ui/NOTICES.md` (`console/ui/NOTICES.md`) |
| whombat-hosts, the hosts service (`nix/packages/hosts`; DEV images only for now) | AGPL-3.0-only (ours) | whombat-hosts' `THIRD_PARTY_NOTICES.md` |
| The contracts' Go module (the Whombat repository's `contracts/go`), linked into the manager, the update helper and the other Go programs here (`go.mod`'s `replace … => ../contracts/go`) | AGPL-3.0-only (ours) | the Whombat repository's `THIRD_PARTY_NOTICES.md` |
| The Go modules our programs link (`go.mod`) | each module's own (mostly BSD-3-Clause, MIT and Apache-2.0) | per binary, the licence inventory of `release/sbom` |
| Hermes Agent 0.22.5 (`nix/packages/hermes`), with Whombat's plugin and its patch applied | MIT, below | `share/licenses/hermes-agent/LICENSE` of the package; its Python dependencies (pinned by its `uv.lock`) each under their own licence, in their `dist-info` |
| agent-browser (beside Hermes) | Apache-2.0 | `share/licenses/agent-browser/LICENSE` of its package |
| The voice service's engines and models (whisper.cpp, Kokoro, sherpa-onnx, eSpeak NG and what they carry; speech-to-text models and optional Dutch voice Supertonic 3 are not in the image) | MIT, Apache-2.0, GPL-3.0 and others | `share/whombat-voice/NOTICES.md` (`voice/NOTICES.md`) |
| The presence service's model and libraries (YuNet, ONNX Runtime, libjpeg-turbo) | MIT, IJG/BSD-3-Clause and others | `share/whombat-presence/NOTICES.md` (`presence/NOTICES.md`) |

Not in the image: Claude Code and Codex. On an owner's request the manager installs them unmodified, at the versions
the signed client channel names (`nix/modules/providers.nix`): Claude Code from Anthropic's own download site, Codex
from the client channel. They come under Anthropic's and OpenAI's own terms.

## Hermes Agent

    MIT License

    Copyright (c) 2025 Nous Research

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
