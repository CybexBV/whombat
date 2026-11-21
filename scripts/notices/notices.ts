/**
 * What THIRD_PARTY_NOTICES.md says, worked out from a repository tree (its tracked files) and the licences of its
 * production dependencies (`pnpm licenses list --prod --json`). Pure: `scripts/third-party-notices.ts` reads the tree
 * and writes the file.
 *
 * The notices describe what is in the tree. Something third-party that is present must be described here, or
 * `problems` names it: a patch, a `vendor/` folder, a font file (and its licence files), a mark, a mark's licence, an
 * optional dependency, a Go module of one of the `go.mod` files, or a dependency whose licence isn't one that sits
 * with the AGPL. Something described here but
 * absent from the tree (the public copy leaves some folders out) is neither required nor listed.
 */
import { dirname } from 'node:path';
import { HERMES_PIN } from '../../packages/agent-runtime/src/hermes/pin';

/** A repository tree: its tracked files, relative to the root, and a way to read one. */
export interface Tree {
  files: readonly string[];
  read(path: string): string;
}

/** One package of a licence group, as `pnpm licenses list --json` reports it. */
export interface LicensedPackage {
  name: string;
  versions: string[];
  license: string;
  homepage?: string;
}

export interface Notices {
  text: string;
  /** Third-party things in the tree that aren't described: the file must not be written while any remain. */
  problems: string[];
  dependencies: number;
}

const MIT_PERMISSION = `Permission is hereby granted, free of charge, to any person obtaining a copy
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
SOFTWARE.`;

const mitLicence = (copyright: string) => `MIT License\n\n${copyright}\n\n${MIT_PERMISSION}`;

const XTERM_LICENCE = `Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

${MIT_PERMISSION}`;

const T3_COPYRIGHT = 'Copyright (c) 2026 T3 Tools Inc.';

/** Code in `vendor/` folders: every one in the tree must be listed. */
const VENDORED: { dir: string; what: string; licence: string }[] = [
  {
    dir: 'packages/hermes-whombat/vendor/claude-subscription-directsdk',
    what: 'Nous Research’s Claude Subscription DirectSDK 0.3.3, the Hermes model provider of NousResearch/hermes-official-plugins (<https://github.com/NousResearch/hermes-official-plugins>), installed with Whombat’s Hermes plugin',
    licence:
      'MIT; the included `LICENSE` and `UPSTREAM.json` record the licence, exact upstream revision and file checksums.',
  },
  {
    dir: 'appliance/harness/vendor/whombat-contracts',
    what: 'One release of this repository’s own contracts, as the archives `pnpm contracts:release` writes (its `RELEASE.json` names the release and its commit): the appliance’s test harness installs them',
    licence: 'AGPL-3.0-only (ours)',
  },
  {
    dir: 'appliance/console/ui/vendor/whombat-app',
    what: 'A copy of this repository’s `packages/avatars`, `packages/brand` and `packages/tokens` and of the web app’s fonts; its `PIN` names the app’s version and each copied folder’s git object id: the appliance’s console page is built from them',
    licence:
      'AGPL-3.0-only (ours); the fonts and the marks as described under Fonts and Service and system marks below, and in the copy’s own `THIRD_PARTY_NOTICES.md`',
  },
  {
    dir: 'appliance/console/ui/vendor/whombat-contracts',
    what: 'A copy of some files of this repository’s contracts (`packages/core`, `packages/protocol`); its `PIN` names the contracts’ version and each copied file’s git object id: the console page reads the desk’s wire types from them',
    licence: 'AGPL-3.0-only (ours)',
  },
  {
    dir: 'hosts/web/src/vendor/spice-html5',
    what: 'spice-html5 (<https://gitlab.freedesktop.org/spice/spice-html5>), the SPICE console of the hosts service’s own web UI, at the upstream commit and with the changes its `README.rackoon` lists',
    licence:
      'LGPL-3.0-or-later (`COPYING.LESSER`, with the GPL’s text in `COPYING`); its `thirdparty/` files keep their own BSD- and MIT-style notices',
  },
];

/** Code ported or copied from other projects into Whombat's own files, listed when `file` is in the tree. */
const PORTED: { file: string; title: string; body: string; licence: string }[] = [
  {
    file: 'packages/client/src/voice/controller.ts',
    title:
      'T3 Code’s voice input (`packages/client/src/voice/controller.ts`) and logo (`packages/brand`, `t3code.svg`)',
    body: `The composers’ voice typing controller is a port of T3 Code’s voice input controller
(<https://github.com/pingdotgg/t3code>, \`packages/client-runtime/src/voice-input/controller.ts\`), and the T3 Code mark
is the “T3” of T3 Code’s \`assets/prod/logo.svg\`, without its black tile. Both are licensed as follows:`,
    licence: mitLicence(T3_COPYRIGHT),
  },
  {
    file: 'packages/core/src/own-address/words.ts',
    title: 'The EFF short word list 2.0 (`packages/core/src/own-address/words.ts`)',
    body: `The words of a Whombat's own address come from the EFF short word list 2.0 by the Electronic Frontier Foundation
(<https://www.eff.org/files/2016/09/08/eff_short_wordlist_2_0.txt>), which EFF publishes under the Creative Commons
Attribution 4.0 International licence (<https://www.eff.org/copyright>). Changed: 300 words removed. The conformance
test keeps an unchanged copy (\`contracts/conformance/src/eff_short_wordlist_2_0.txt\`).`,
    licence:
      'Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/',
  },
];

/** Every file in `patches/` (pnpm-workspace.yaml `patchedDependencies`) must be listed. */
const PATCHES: { file: string; what: string; licence: string; text?: string }[] = [
  {
    file: '@bsky.app__react-native-uitextview@2.7.1.patch',
    what: 'react-native-uitextview 2.7.1 (the iPhone app’s message text)',
    licence: 'MIT, Copyright (c) 2024-25 Bluesky PBC (the MIT License text under T3 Code above)',
  },
  {
    file: 'expo-share-intent@8.0.1.patch',
    what: 'expo-share-intent 8.0.1 (the mobile app’s Share to Whombat)',
    licence: 'MIT, Copyright (c) 2023 Evan Bacon (the MIT License text under T3 Code above)',
  },
  {
    file: 'react-native-screens@4.26.2.patch',
    what: 'react-native-screens 4.26.2 (the iPhone app’s tab bar badges)',
    licence:
      'MIT, Copyright (c) 2018 Software Mansion <swmansion.com> (the MIT License text under T3 Code above)',
  },
  {
    file: 'postgres@3.4.9.patch',
    what: 'postgres.js 3.4.9 (<https://github.com/porsager/postgres>)',
    licence: 'Unlicense',
  },
  {
    file: '@xterm__xterm@6.0.0.patch',
    what: 'xterm.js 6.0.0 (<https://github.com/xtermjs/xterm.js>)',
    licence: 'MIT, below',
    text: XTERM_LICENCE,
  },
];

/**
 * The fonts. Every font file in the tree must be one of these (by its file name), with `OFL.txt` and the font's own
 * licence file in its folder, wherever that folder is. A font whose own file holds the whole licence (`wholeLicence`)
 * needs no `OFL.txt` beside it. The design references carry copies and the public copy leaves them out, so the notices
 * name only the folders the apps serve and hold every other copy to the same rule.
 */
const FONTS: {
  prefix: string;
  name: string;
  copyright: string;
  licenceFile: string;
  wholeLicence?: true;
}[] = [
  {
    prefix: 'bricolagegrotesque-',
    name: 'Bricolage Grotesque',
    copyright:
      'Copyright 2022 The Bricolage Grotesque Project Authors (<https://github.com/ateliertriay/bricolage>)',
    licenceFile: 'OFL-BricolageGrotesque.txt',
  },
  {
    prefix: 'dmmono-',
    name: 'DM Mono',
    copyright: 'Copyright 2020 The DM Mono Project Authors (<https://www.github.com/googlefonts/dm-mono>)',
    licenceFile: 'OFL-DMMono.txt',
  },
  // Longer prefixes first: a file is the first font whose prefix it starts with.
  {
    prefix: 'geist-mono-',
    name: 'Geist Mono',
    copyright: 'Copyright 2024 The Geist Project Authors (<https://github.com/vercel/geist-font>)',
    licenceFile: 'LICENSE-Geist-Mono.txt',
    wholeLicence: true,
  },
  {
    prefix: 'geist-',
    name: 'Geist',
    copyright: 'Copyright 2024 The Geist Project Authors (<https://github.com/vercel/geist-font>)',
    licenceFile: 'LICENSE-Geist.txt',
    wholeLicence: true,
  },
];
const FONT_FILE = /\.(woff2?|ttf|otf)$/i;
/** The folders the apps serve the fonts from, named in the notices when they hold fonts. */
const SERVED_FONT_DIRS: { dir: string; by: string }[] = [
  { dir: 'apps/web/src/app/fonts', by: 'the web app' },
  { dir: 'appliance/console/ui/vendor/whombat-app/fonts', by: 'the appliance’s console page' },
  { dir: 'hosts/web/public/fonts', by: 'the hosts service’s own web UI' },
];

const MARKS_DIR = 'packages/brand/assets/marks/';
const MARKS_SOURCES = `${MARKS_DIR}SOURCES.md`;
/**
 * The licences the marks' SOURCES.md names, as the notices word them. A licence not here is a problem: say what it is
 * first.
 */
const MARK_LICENCES: Record<string, string> = {
  'CC0-1.0': 'CC0 1.0',
  ISC: 'ISC (Lucide Icons and Contributors; the text comes with lucide-react, under Dependencies)',
  'MIT (sct)': 'MIT, Copyright (c) 2020 sct (the MIT License text under T3 Code above)',
  'MIT (T3 Tools Inc.)': `MIT, ${T3_COPYRIGHT} (the licence text under T3 Code above)`,
  'CC-BY-4.0': 'CC BY 4.0',
  'CC-BY-SA-4.0': 'CC BY-SA 4.0',
  'CC-BY-SA-4.0 (Caesar Schinas)': 'CC BY-SA 4.0, by Caesar Schinas',
  'CC-BY-SA-3.0': 'CC BY-SA 3.0',
  'CC-BY-SA-2.5': 'CC BY-SA 2.5',
  custom: 'its owner’s brand terms',
  'Google brand terms': 'Google’s brand terms',
  'Microsoft brand terms': 'Microsoft’s brand terms',
  'Mollie brand': 'Mollie’s brand, drawn as published',
  'Moneybird brand': 'Moneybird’s brand, drawn as published',
  'Pipedrive brand': 'Pipedrive’s brand, drawn as published',
  Unlicense: 'Unlicense',
  own: 'John Pals’s own',
  unverified: 'not verified yet',
};
/** What a mark's upstream offers beyond the licence SOURCES.md records (Simple Icons records one). */
const MARK_NOTES: Record<string, string> = {
  'debian.svg':
    'the Debian Open Use Logo, Copyright (c) 1999 Software in the Public Interest, Inc., and others: LGPL-3.0-or-later or, at your option, CC BY-SA 3.0 (<https://www.debian.org/logos/>)',
};

/**
 * Not open source. Every optional dependency of a workspace package, and every dependency whose licence isn't open,
 * must match an entry here (or, open, sit in the dependency table).
 */
const NOT_OPEN: { match: (name: string) => boolean; title: string; body: string }[] = [
  {
    match: (name) => name.startsWith('@anthropic-ai/claude-code'),
    title: 'Claude Code (Anthropic)',
    body: `Claude Code is proprietary software: “© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements
outlined here: <https://code.claude.com/docs/en/legal-and-compliance>.” It is not open source, Whombat’s licence does not
cover it and grants nothing in it, and it is used under Anthropic’s own terms.

- **This repository** pins it as optional dependencies of \`packages/agent-runtime\` ({{packages}}) and contains none of it:
  \`pnpm install\` downloads the binary for the machine’s architecture from the npm registry.
- **Whombat’s builds** leave it out: the runtime bundle (\`pnpm bundle:runtime\`) keeps it external and its manifest says
  \`claude.bundled: false\`; the web, widget and admin pages and the Android and iPhone apps don’t contain it.
- **On an appliance** it is not in the image. On an owner’s request the manager installs it from Whombat’s signed
  client channel (\`appliance/release-tools/clientchannel\`): Anthropic’s published binary, checked against
  Anthropic’s digest and served unmodified, packed in a \`tar.gz\`, from Whombat’s update host.`,
  },
];

/**
 * The licences a dependency may have, each compatible with distributing Whombat under AGPL-3.0-only, with what to know
 * about it. An expression passes when one `OR` alternative has only these (`AND`); of several, the first in this order
 * is taken. A dependency with any other licence is a problem: check it, then add it here, correct it in
 * `LICENCE_FIXES`, or describe it in `NOT_OPEN`.
 */
const OPEN_LICENCES: Record<string, string> = {
  MIT: '',
  'MIT-0': '',
  ISC: '',
  '0BSD': '',
  'BSD-2-Clause': '',
  'BSD-3-Clause': '',
  'Apache-2.0': 'compatible with GPL-3.0 and the AGPL; attribution and NOTICE files required',
  'BlueOak-1.0.0': 'permissive',
  Unlicense: '',
  'CC0-1.0': '',
  'Python-2.0': 'the PSF licence, GPL-compatible',
  'MPL-2.0':
    'file-level copyleft: changes to those files stay MPL-2.0; combining them with the AGPL is allowed (MPL-2.0 section 3.3; none is marked “Incompatible With Secondary Licenses”)',
  'CC-BY-4.0': 'attribution required (browser data)',
  'OFL-1.1': 'fonts, used as fonts and never relicensed',
};
/** Dependencies whose package.json gets its licence wrong or leaves it out, as their licence files say. */
const LICENCE_FIXES: Record<string, { licence: string; why: string }> = {
  khroma: { licence: 'MIT', why: 'its package.json names none; its `license` file is the MIT License' },
};

/**
 * The Go modules of this repository: the Go toolchain fetches what each `go.mod` requires. Every one in the tree gets
 * its table, read from the file itself, so a changed version needs no edit here.
 */
const GO_MODULES: { file: string; of: string }[] = [
  { file: 'contracts/go/go.mod', of: 'the contracts’ Go module' },
  {
    file: 'appliance/go.mod',
    of: 'the appliance’s programs: the manager, the update helper, the release tools',
  },
  { file: 'hosts/go.mod', of: 'the hosts service: the hub and its agents' },
];
/**
 * The licence of every module a `go.mod` here requires, as the module's own licence files say (checked in the Go
 * module cache). A required module that isn't here is a problem: read its licence, then add it. Each must be one
 * that sits with the AGPL, like a dependency's.
 */
const GO_LICENCES: Record<string, string> = {
  'filippo.io/edwards25519': 'BSD-3-Clause',
  'github.com/AdaLogics/go-fuzz-headers': 'Apache-2.0',
  'github.com/apex/log': 'MIT',
  'github.com/blang/semver/v4': 'MIT',
  'github.com/cenkalti/backoff/v5': 'MIT',
  'github.com/cespare/xxhash/v2': 'MIT',
  'github.com/coder/websocket': 'ISC',
  'github.com/containerd/log': 'Apache-2.0',
  'github.com/containerd/platforms': 'Apache-2.0',
  'github.com/coreos/go-oidc/v3': 'Apache-2.0',
  'github.com/cpuguy83/go-md2man/v2': 'MIT',
  'github.com/creack/pty': 'MIT',
  'github.com/cyphar/filepath-securejoin': 'BSD-3-Clause AND MPL-2.0',
  'github.com/digitalocean/go-libvirt': 'Apache-2.0',
  'github.com/docker/go-units': 'Apache-2.0',
  'github.com/dustin/go-humanize': 'MIT',
  'github.com/ebitengine/purego': 'Apache-2.0',
  // Dual: the Eclipse Public License 2.0 or the Eclipse Distribution License 1.0, which is the BSD-3-Clause text.
  'github.com/eclipse/paho.golang': 'EPL-2.0 OR BSD-3-Clause',
  'github.com/fxamacker/cbor/v2': 'MIT',
  'github.com/go-jose/go-jose/v4': 'Apache-2.0',
  'github.com/go-logr/logr': 'Apache-2.0',
  'github.com/go-logr/stdr': 'Apache-2.0',
  'github.com/go-ole/go-ole': 'MIT',
  'github.com/go-viper/mapstructure/v2': 'MIT',
  'github.com/go-webauthn/webauthn': 'BSD-3-Clause',
  'github.com/go-webauthn/x': 'BSD-3-Clause',
  'github.com/godbus/dbus/v5': 'BSD-2-Clause',
  'github.com/golang-jwt/jwt/v5': 'MIT',
  'github.com/google/go-containerregistry': 'Apache-2.0',
  'github.com/google/go-tpm': 'Apache-2.0',
  'github.com/google/uuid': 'BSD-3-Clause',
  'github.com/gorilla/securecookie': 'BSD-3-Clause',
  'github.com/gorilla/websocket': 'BSD-2-Clause',
  'github.com/gowebpki/jcs': 'Apache-2.0',
  'github.com/gtank/ristretto255': 'BSD-3-Clause',
  'github.com/hashicorp/yamux': 'MPL-2.0',
  'github.com/jackc/pgpassfile': 'MIT',
  'github.com/jackc/pgservicefile': 'MIT',
  'github.com/jackc/pgx/v5': 'MIT',
  'github.com/klauspost/compress': 'Apache-2.0 AND BSD-3-Clause AND MIT',
  'github.com/klauspost/pgzip': 'MIT',
  'github.com/kr/fs': 'BSD-3-Clause',
  'github.com/lufia/plan9stats': 'BSD-3-Clause',
  'github.com/lxc/incus/v6': 'Apache-2.0',
  'github.com/mattn/go-colorable': 'MIT',
  'github.com/mattn/go-isatty': 'MIT',
  'github.com/moby/sys/user': 'Apache-2.0',
  'github.com/moby/sys/userns': 'Apache-2.0',
  'github.com/mr-tron/base58': 'MIT',
  'github.com/muhlemmer/gu': 'Unlicense',
  'github.com/ncruces/go-strftime': 'MIT',
  'github.com/nicholas-fedor/shoutrrr': 'MIT',
  'github.com/opencontainers/go-digest': 'Apache-2.0',
  'github.com/opencontainers/image-spec': 'Apache-2.0',
  'github.com/opencontainers/runtime-spec': 'Apache-2.0',
  'github.com/opencontainers/umoci': 'Apache-2.0',
  'github.com/pelletier/go-toml/v2': 'MIT',
  'github.com/philhofer/fwd': 'MIT',
  'github.com/pkg/errors': 'BSD-2-Clause',
  'github.com/pkg/sftp': 'BSD-2-Clause',
  'github.com/power-devops/perfstat': 'MIT',
  'github.com/remyoudompheng/bigfft': 'BSD-3-Clause',
  'github.com/rootless-containers/proto/go-proto': 'Apache-2.0',
  'github.com/russross/blackfriday/v2': 'BSD-2-Clause',
  'github.com/santhosh-tekuri/jsonschema/v6': 'Apache-2.0',
  'github.com/secure-systems-lab/go-securesystemslib': 'MIT',
  'github.com/shirou/gopsutil/v4': 'BSD-3-Clause',
  'github.com/sigstore/protobuf-specs': 'Apache-2.0',
  'github.com/sigstore/sigstore': 'Apache-2.0',
  'github.com/sirupsen/logrus': 'MIT',
  'github.com/theupdateframework/go-tuf/v2': 'Apache-2.0',
  'github.com/tinylib/msgp': 'MIT',
  'github.com/tklauser/go-sysconf': 'BSD-3-Clause',
  'github.com/tklauser/numcpus': 'Apache-2.0',
  'github.com/urfave/cli': 'MIT',
  'github.com/vbatts/go-mtree': 'BSD-3-Clause',
  'github.com/x448/float16': 'MIT',
  'github.com/yusufpapurcu/wmi': 'MIT',
  'github.com/zitadel/logging': 'Apache-2.0',
  'github.com/zitadel/oidc/v3': 'Apache-2.0',
  'github.com/zitadel/schema': 'BSD-3-Clause',
  'go.opentelemetry.io/auto/sdk': 'Apache-2.0',
  'go.opentelemetry.io/otel': 'Apache-2.0 AND BSD-3-Clause',
  'go.opentelemetry.io/otel/metric': 'Apache-2.0 AND BSD-3-Clause',
  'go.opentelemetry.io/otel/trace': 'Apache-2.0 AND BSD-3-Clause',
  'golang.org/x/crypto': 'BSD-3-Clause',
  'golang.org/x/image': 'BSD-3-Clause',
  'golang.org/x/mod': 'BSD-3-Clause',
  'golang.org/x/net': 'BSD-3-Clause',
  'golang.org/x/oauth2': 'BSD-3-Clause',
  'golang.org/x/sync': 'BSD-3-Clause',
  'golang.org/x/sys': 'BSD-3-Clause',
  'golang.org/x/term': 'BSD-3-Clause',
  'golang.org/x/text': 'BSD-3-Clause',
  'golang.org/x/tools': 'BSD-3-Clause',
  'google.golang.org/genproto/googleapis/api': 'Apache-2.0',
  'google.golang.org/protobuf': 'BSD-3-Clause',
  'gopkg.in/yaml.v2': 'Apache-2.0 AND MIT',
  'mellium.im/reader': 'BSD-2-Clause',
  'mellium.im/sasl': 'BSD-2-Clause',
  'mellium.im/xmlstream': 'BSD-2-Clause AND BSD-3-Clause',
  'mellium.im/xmpp': 'BSD-2-Clause AND BSD-3-Clause',
  'modernc.org/libc': 'BSD-3-Clause AND MIT',
  'modernc.org/mathutil': 'BSD-3-Clause',
  'modernc.org/memory': 'BSD-3-Clause',
  'modernc.org/sqlite': 'Apache-2.0 AND BSD-3-Clause AND MIT',
  'rsc.io/qr': 'BSD-3-Clause',
};

/**
 * What a `go.mod` requires, direct and indirect, without the modules it replaces with a folder of this repository
 * (those are ours).
 */
export function goRequires(text: string): { module: string; version: string }[] {
  const local = new Set(
    [...text.matchAll(/^(?:replace\s+)?\s*(\S+)(?:\s+v\S+)?\s+=>\s+\.{1,2}\//gm)].map((m) => m[1] as string),
  );
  const found = new Map<string, string>();
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line === 'require (') inBlock = true;
    else if (line === ')') inBlock = false;
    else {
      const m = inBlock ? /^(\S+)\s+(v\S+)$/.exec(line) : /^require\s+(\S+)\s+(v\S+)$/.exec(line);
      if (m?.[1] && m[2] && !local.has(m[1])) found.set(m[1], m[2]);
    }
  }
  return [...found.entries()]
    .map(([module, version]) => ({ module, version }))
    .sort((a, b) => a.module.localeCompare(b.module));
}

// ---------------------------------------------------------------------------------------------------------------------

const cell = (s: string) => s.replaceAll('|', '\\|');
const block = (text: string) => `\`\`\`text\n${text}\n\`\`\``;

const alternatives = (expr: string) =>
  expr
    .replaceAll(/[()]/g, '')
    .split(/\s+OR\s+/)
    .map((alt) => alt.split(/\s+AND\s+/).map((s) => s.trim()));
const RANK = Object.keys(OPEN_LICENCES);
const rank = (ids: string[]) => Math.max(...ids.map((id) => RANK.indexOf(id)));
/** The licence ids an open expression is distributed under (its most permissive all-open alternative), or null. */
function openTerms(expr: string): string[] | null {
  const open = alternatives(expr)
    .filter((ids) => ids.every((id) => id in OPEN_LICENCES))
    .sort((a, b) => rank(a) - rank(b));
  return open[0] ?? null;
}
const notOpenOf = (name: string) => NOT_OPEN.find((n) => n.match(name));

export function buildNotices(tree: Tree, byLicense: Record<string, LicensedPackage[]>): Notices {
  const problems: string[] = [];
  const tracked = tree.files;
  const present = new Set(tracked);

  // Vendored folders and patches: each one in the tree is described; one described but absent is left out.
  const vendorDirs = new Set(
    tracked.flatMap((f) => {
      const m = /^(.*\/vendor\/[^/]+)\//.exec(f);
      return m?.[1] ? [m[1]] : [];
    }),
  );
  for (const d of vendorDirs)
    if (!VENDORED.some((v) => v.dir === d)) problems.push(`${d}: vendored, not described in VENDORED`);
  const vendored = VENDORED.filter((v) => vendorDirs.has(v.dir));

  const ported = PORTED.filter((p) => present.has(p.file));

  const patchFiles = new Set(
    tracked.filter((f) => f.startsWith('patches/')).map((f) => f.slice('patches/'.length)),
  );
  for (const p of patchFiles)
    if (!PATCHES.some((e) => e.file === p)) problems.push(`patches/${p}: not described in PATCHES`);
  const patches = PATCHES.filter((p) => patchFiles.has(p.file));

  // Fonts: every font file is a known font with its licence files beside it, wherever it is.
  const fontsSeen = new Set<string>();
  for (const f of tracked.filter((f) => FONT_FILE.test(f))) {
    const dir = dirname(f);
    const font = FONTS.find((x) => f.slice(dir.length + 1).startsWith(x.prefix));
    if (!font) {
      problems.push(`${f}: a font not described in FONTS`);
      continue;
    }
    fontsSeen.add(font.name);
    for (const licence of font.wholeLicence ? [font.licenceFile] : ['OFL.txt', font.licenceFile])
      if (!present.has(`${dir}/${licence}`)) problems.push(`${dir}/${licence}: missing beside ${font.name}`);
  }
  const fonts = FONTS.filter((f) => fontsSeen.has(f.name));
  const served = SERVED_FONT_DIRS.filter((s) =>
    tracked.some((f) => f.startsWith(`${s.dir}/`) && FONT_FILE.test(f)),
  );

  // The marks, from their SOURCES.md table: every mark file has a row; rows of absent files are left out.
  const markFiles = tracked.filter((f) => f.startsWith(MARKS_DIR) && f.endsWith('.svg'));
  const sourceRows = present.has(MARKS_SOURCES)
    ? tree
        .read(MARKS_SOURCES)
        .split('\n')
        .flatMap((line) => {
          const m = /^\| `([^`]+)` \| (.+?) \| (.+?) \| (.+?) \|$/.exec(line);
          return m
            ? [{ file: m[1] as string, mark: m[2] as string, from: m[3] as string, licence: m[4] as string }]
            : [];
        })
    : [];
  for (const f of markFiles)
    if (!sourceRows.some((m) => `${MARKS_DIR}${m.file}` === f))
      problems.push(`${f}: no row in ${MARKS_SOURCES}`);
  const marks = sourceRows.filter((m) => present.has(`${MARKS_DIR}${m.file}`));
  for (const m of marks)
    if (!(m.licence in MARK_LICENCES))
      problems.push(`${MARKS_SOURCES}: ${m.file}'s licence “${m.licence}” not in MARK_LICENCES`);
  const cc0Marks = marks.filter((m) => m.licence === 'CC0-1.0');
  const otherMarks = marks
    .filter((m) => m.licence !== 'CC0-1.0')
    .filter((m, i, all) => all.findIndex((o) => o.mark === m.mark && o.from === m.from) === i);

  // Dependencies.
  const all = Object.values(byLicense)
    .flat()
    .filter((e) => !e.name.startsWith('@whombat/'))
    .map((e) => {
      const fix = LICENCE_FIXES[e.name];
      return fix ? { ...e, license: fix.licence, fixed: fix.why } : { ...e, fixed: undefined };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const entries = all.filter((e) => {
    if (openTerms(e.license)) return true;
    if (!notOpenOf(e.name))
      problems.push(
        `${e.name}: licence “${e.license}” isn't in OPEN_LICENCES (check it; then OPEN_LICENCES, LICENCE_FIXES or NOT_OPEN)`,
      );
    return false;
  });

  // Optional dependencies: `--prod` leaves them out (and only this machine's platform is installed), so they are read
  // from every workspace package.json.
  const optional = new Map<string, Set<string>>();
  for (const f of tracked.filter((f) => f.endsWith('package.json') && !f.includes('node_modules/'))) {
    const pkg = JSON.parse(tree.read(f)) as { optionalDependencies?: Record<string, string> };
    for (const [name, version] of Object.entries(pkg.optionalDependencies ?? {})) {
      if (!notOpenOf(name)) problems.push(`${f}: optional dependency ${name} not described in NOT_OPEN`);
      optional.set(name, (optional.get(name) ?? new Set()).add(version));
    }
  }

  const sections: string[] = [];
  if (vendored.length > 0)
    sections.push(`### Vendored code

| What | Where | Licence |
|---|---|---|
${vendored.map((v) => `| ${cell(v.what)} | \`${v.dir}/\` | ${cell(v.licence)} |`).join('\n')}`);

  for (const p of ported) sections.push(`### ${p.title}\n\n${p.body}\n\n${block(p.licence)}`);

  if (patches.length > 0)
    sections.push(`### Patches to dependencies (\`patches/\`)

Changes to these packages, applied by pnpm at install (\`pnpm-workspace.yaml\`, \`patchedDependencies\`); the packages
themselves are listed under Dependencies.

| Patch | Changes | Licence |
|---|---|---|
${patches.map((p) => `| \`patches/${p.file}\` | ${cell(p.what)} | ${cell(p.licence)} |`).join('\n')}
${patches
  .filter((p) => p.text)
  .map((p) => `\n${p.what.replace(/ \(.*$/, '')}:\n\n${block(p.text as string)}`)
  .join('\n')}`);

  if (fonts.length > 0) {
    const servedBy = served.map((s) => `${s.by} from \`${s.dir}/\``);
    const whole = fonts.some((f) => f.wholeLicence);
    sections.push(`### Fonts

Every folder of font files in this repository holds only these fonts, each next to \`OFL.txt\` and its own licence
file${whole ? ' (a file that holds the whole licence stands alone)' : ''}${servedBy.length > 0 ? `. Served: ${servedBy.join('; ')}` : ''}.

| Font | Copyright | Licence |
|---|---|---|
${fonts.map((f) => `| ${f.name} | ${f.copyright} | SIL Open Font License 1.1, \`${f.licenceFile}\`${f.wholeLicence ? ' (the whole licence)' : ''} |`).join('\n')}

The mobile app loads its fonts from the \`@expo-google-fonts\` packages listed under Dependencies.`);
  }

  if (marks.length > 0)
    sections.push(`### Service and system marks (\`packages/brand\`)

The marks of the services people connect and the systems their servers run, listed one by one with their sources in
\`${MARKS_SOURCES}\`. ${cc0Marks.length} of them are path data from Simple Icons (<https://simpleicons.org>), released under
CC0 1.0 Universal. The others:

| Mark | From | Licence |
|---|---|---|
${otherMarks
  .map(
    (m) =>
      `| ${cell(m.mark)} | ${cell(m.from)} | ${cell(MARK_NOTES[m.file] ?? MARK_LICENCES[m.licence] ?? m.licence)} |`,
  )
  .join('\n')}

The marks and the names are trademarks of their owners; showing them names the service or system and implies no
endorsement.`);

  const optionalList = (match: (name: string) => boolean) =>
    [...optional.entries()]
      .filter(([name]) => match(name))
      .map(([name, versions]) => `\`${name}@${[...versions].join(', ')}\``)
      .join(', ');
  const notOpenSection = `## Not open source

These are fetched under their own terms. They are not part of this repository, not covered by its licence, and
nothing in it grants rights in them.

${NOT_OPEN.map((n) => `### ${n.title}\n\n${n.body.replace('{{packages}}', optionalList(n.match))}`).join('\n\n')}`;

  const agentBrowserPin = 'packages/hermes-whombat/agent-browser.json';
  const agentBrowser = present.has(agentBrowserPin)
    ? (JSON.parse(tree.read(agentBrowserPin)) as { version: string }).version
    : null;
  const toolsSection = `### Hermes Agent${agentBrowser ? ' and agent-browser' : ''}

\`pnpm hermes:install\` installs, for development, Hermes Agent ${HERMES_PIN.version} (Nous Research,
<https://github.com/NousResearch/hermes-agent>, MIT, below) from its git tag with the Python packages its \`uv.lock\`
pins, each under its own licence${
    agentBrowser
      ? `, and agent-browser ${agentBrowser} (Vercel, <https://github.com/vercel-labs/agent-browser>,
Apache-2.0) from the npm registry (\`${agentBrowserPin}\`). The appliance image builds both in`
      : `. The appliance image builds it in`
  }
(\`appliance/nix/packages/hermes\`), and its notices list them too. The agent’s skills are Hermes’s own: its
built-in and optional skills come with Hermes under its MIT licence, and each skill an owner installs from Hermes’s
hub keeps its own licence.

${block(mitLicence('Copyright (c) 2025 Nous Research'))}`;

  // What each licence of the dependencies means next to the AGPL, for the ones that need a word.
  const counts = new Map<string, number>();
  for (const e of entries)
    for (const id of openTerms(e.license) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  const licenceRows = [...counts.entries()]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([id, n]) => `| ${id} | ${n} | ${OPEN_LICENCES[id] || 'permissive'} |`);
  const fixedRows = entries.filter((e) => e.fixed).map((e) => `- ${e.name}: ${e.license}, ${e.fixed}.`);
  // Packages that also offer a licence Whombat couldn't combine with the AGPL.
  const choiceRows = entries
    .filter((e) => alternatives(e.license).some((ids) => !ids.every((id) => id in OPEN_LICENCES)))
    .map(
      (e) =>
        `${e.name} (${e.license.replace(/^\((.*)\)$/, '$1')}: ${(openTerms(e.license) ?? []).join(' AND ')})`,
    );
  const rows = entries.map(
    (e) =>
      `| ${cell(e.name)} | ${e.versions.join(', ')} | ${cell(e.license)} | ${e.homepage ? `<${e.homepage}>` : ''} |`,
  );

  // The Go modules: every `go.mod` named above that is in the tree, each required module with its licence.
  const goSections = GO_MODULES.filter((g) => present.has(g.file)).map((g) => {
    const rows = goRequires(tree.read(g.file)).map(({ module, version }) => {
      const licence = GO_LICENCES[module];
      if (!licence) problems.push(`${g.file}: the Go module ${module} has no licence in GO_LICENCES`);
      else if (!openTerms(licence))
        problems.push(`${g.file}: ${module}'s licence “${licence}” isn't in OPEN_LICENCES`);
      return `| ${module} | ${version} | ${licence ?? '?'} |`;
    });
    return `### Go module dependencies of ${g.of} (\`${g.file}\`)

Fetched by the Go toolchain; each module's own licence applies.

| Module | Version | Licence |
|---|---|---|
${rows.join('\n')}`;
  });

  const text = `# Third-party notices

<!-- Generated by \`pnpm notices\` (scripts/third-party-notices.ts). Do not edit by hand. -->

This repository's own code is copyright 2026 Cybex BV and licensed under the GNU Affero General Public License,
version 3 only (\`LICENSE\`, AGPL-3.0-only). It also contains, patches or depends on third-party software under the
licences below, and uses some that is not open source (“Not open source”).

## Included in this repository

${sections.join('\n\n')}

${notOpenSection}

## Fetched by the tools, not part of this repository

${[...goSections, toolsSection].join('\n\n')}

## Dependencies

Installed by the package manager from \`pnpm-lock.yaml\` (production dependencies of every workspace
package); they are not part of this repository. Each package's own licence file applies. The runtime bundle
(\`pnpm bundle:runtime\`) lists every package it contains, with its licence text, in its \`THIRD-PARTY-NOTICES.txt\`.

Every licence below allows distributing Whombat under AGPL-3.0-only (\`pnpm notices\` fails on any other):

| Licence | Packages | Next to the AGPL |
|---|---|---|
${licenceRows.join('\n')}

Where a package offers a choice, Whombat uses it under the most permissive licence it offers${choiceRows.length > 0 ? `; these also offer one that couldn't be combined with the AGPL: ${choiceRows.join(', ')}` : ''}.
${fixedRows.length > 0 ? `\nCorrected from the package's own files:\n\n${fixedRows.join('\n')}\n` : ''}
| Package | Versions | Licence | Homepage |
|---|---|---|---|
${rows.join('\n')}
`;

  return { text, problems, dependencies: entries.length };
}
