# The hosts service (Whombat ONE-11…ONE-15, NX-152): the headless hub `whombat-hosts` that the Whombat server talks to
# over a Unix socket, and the agent `whombat-agent` it hands to every monitored server, built from hosts/ of this
# repository (formerly Rackoon; narrow copies of it: nix/lib/sources.nix):
#
#   bin/whombat-hosts                                the hub (`serve --headless …`, nix/modules/hosts.nix)
#   share/whombat-hosts/agent/whombat-agent-{linux,darwin}-{amd64,arm64}, whombat-agent-windows-{amd64,arm64}.exe
#                                                    the agents install.sh and install.ps1 download (`--agent-dist`)
#   share/whombat-hosts/agent/manifest.json          their signatures: the hub offers agent self-update (NX-157).
#                                                    Only in a signed build (below).
#   share/whombat-hosts/agent/whombat-helper-macos.{zip,json}
#                                                    Whombat Helper for Macs (NX-515)
#
# Static (CGO_ENABLED=0), so the agents run on any Linux server whatever its libc, on any Mac from macOS 13 (Go
# signs the macOS builds ad hoc itself; Whombat macos-servers.md MAC-01) and on Windows 10 and 11 (without a
# Windows code signature, signed for self-update like the others; Whombat windows-servers.md). The hub has no web UI
# (no `embedweb` tag): Whombat owns every screen (ONE-12). Whombat Helper is a Swift app built, signed and notarized on a Mac
# (hosts/macos/helper/build.sh) and committed as a zip: Nix can't build it, so it is copied after its checksum is
# checked against the json beside it.
#
# The agents' version is a committed value, agent-version.json, and only signing changes it. An agent takes an update
# only when its version is strictly later, so the version must change exactly when the agents' bytes do: a version
# taken from the commit would be new with every release, and every server would install the same agent again.
#
# Signed agents (Whombat AU-01, AU-02; NX-157…NX-160). The agents build in a derivation of their own
# (`passthru.agents`, `.#whombat-hosts-agents`) with the public half of the Whombat agent-signing key built in
# (`-X rackoon/internal/agent.UpdatePublicKey`, `agent-update-key.pub`), so they take only updates that key signed. The
# key itself never enters a build: the maintainers' `sign-agents` builds the agents of one commit, signs them with
# hosts' rackoon-sign (`passthru.sign`, `.#whombat-hosts-sign`) and writes agent-manifest.json and agent-version.json.
#
# One derivation for every kind of build. `manifest-check` compares the committed manifest with the agents built here:
#   they match         the manifest goes in beside the agents: a signed build
#   other bytes        (the manifest is sound, only a built file's size or sha256 differs: changed agent code, another
#                      Go) the agents go in without a manifest, and the hub says “The hub has no signed agent build”
#                      and offers no update. This is what someone without the key builds.
#   anything else      (an unreadable manifest, another key or version, a bad signature) the build fails
# A release never ships unsigned agents: release/build refuses a hub without manifest.json, and
# `checks.hosts-agent-manifest` (`passthru.manifestCheck`) passes only for a match.
{
  lib,
  buildGo127Module,
  runCommand,
  sources,
  nixpkgsRev,
  # The committed signatures. Another file only in checks.
  manifestFile ? ./agent-manifest.json,
  # Tests only: a build id for the agents, which makes them other bytes than any manifest signs
  # (checks.hosts-unsigned-build).
  agentBuildId ? "",
}:
let
  # The vendored modules of hosts/go.mod and go.sum (appliance/scripts/ci/fixed-hashes.sh --refresh hostsGo).
  fixed = sources.fixedHash "hostsGo" {
    files = [
      "hosts/go.mod"
      "hosts/go.sum"
    ];
    params.nixpkgs = nixpkgsRev;
  };
  vendorHash = fixed.hash;
  # `0.0.0-<UTC time of the signed commit, YYYYMMDDHHMMSS>.<its short rev>`: the hub's and the agents' `version`,
  # which the agents order by that time.
  signed = lib.importJSON ./agent-version.json;
  inherit (signed) version;
  archs = [
    "amd64"
    "arm64"
  ];
  # Every agent build: Linux servers, Macs (NX-515) and Windows PCs.
  oses = [
    "linux"
    "darwin"
    "windows"
  ];
  # A Windows build's file ends in .exe (the hub serves it so, and Windows runs nothing else).
  agentFile = os: a: "whombat-agent-${os}-${a}" + lib.optionalString (os == "windows") ".exe";
  agentNames = lib.concatMap (os: map (agentFile os) archs) oses;
  # The flags and their order as every signed agent was linked: other flags would be other bytes.
  ldflagsWith = buildId: "-s -w -buildid=${buildId} -X main.version=${version}";

  # The public half of the agent-signing key (base64 Ed25519; never the seed).
  keyFile = ./agent-update-key.pub;
  updateKey = lib.fileContents keyFile;

  # Whombat Helper (NX-515): the signed zip hosts/ commits.
  helperDir = "${sources.hostsAgents}/hosts/macos/helper/dist";
  hasHelper = builtins.pathExists (sources.root + "/hosts/macos/helper/dist/whombat-helper-macos.zip");

  # The three Go derivations share one vendored-modules path, fetched once for the whole module: `go mod vendor`
  # chooses the vendored packages by what every Go file imports, tests too. Its name carries the digest of what the
  # hash was taken for.
  modules =
    (buildGo127Module {
      pname = "whombat-hosts";
      inherit version vendorHash;
      src = sources.hostsModules;
      modRoot = "hosts";
      overrideModAttrs = _: _: { name = "whombat-hosts-go-modules-${fixed.tag}"; };
    }).goModules;
  common = {
    inherit version vendorHash;
    modRoot = "hosts";
    env.CGO_ENABLED = "0";
    # The repository's own `go test ./...` runs in its CI; here the binaries must start.
    doCheck = false;
  };
  mk = attrs: (buildGo127Module (common // attrs)).overrideAttrs { goModules = modules; };

  # One agent per architecture a server may have, with the update key. buildGoModule's own phases build for the host
  # platform only (its GOARCH wins over env), so the builds are spelled out; GOFLAGS (-mod=vendor -trimpath) and
  # GOTOOLCHAIN=local are buildGoModule's. Reproducible (-trimpath, -buildid=, no cgo): the bytes that were signed are
  # the bytes any machine builds from the same files.
  agents = mk {
    pname = "whombat-hosts-agents";
    src = sources.hostsAgents;
    buildPhase = ''
      runHook preBuild
      mkdir -p "$NIX_BUILD_TOP/out"
      ${lib.concatMapStrings (
        os:
        lib.concatMapStrings (a: ''
          GOOS=${os} GOARCH=${a} go build \
            -ldflags "${ldflagsWith agentBuildId} -X rackoon/internal/agent.UpdatePublicKey=${updateKey}" \
            -o "$NIX_BUILD_TOP/out/${agentFile os a}" ./cmd/whombat-agent
        '') archs
      ) oses}
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      install -d $out
      install -m 0444 "$NIX_BUILD_TOP"/out/whombat-agent-* $out/
      ${lib.optionalString hasHelper ''
        # Whombat Helper as committed, only when its zip is the one the json names; signed with the agents, so the
        # agents take it as an update only from this key.
        test "$(sha256sum ${helperDir}/whombat-helper-macos.zip | cut -d' ' -f1)" = \
          "$(sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{64\}\)".*/\1/p' ${helperDir}/whombat-helper-macos.json)"
        install -m 0444 ${helperDir}/whombat-helper-macos.zip ${helperDir}/whombat-helper-macos.json $out/
      ''}
      runHook postInstall
    '';
    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      # The agents run on other machines: the only store paths in them are the ones nixpkgs' Go puts first in its
      # lookup lists (tzdata and mime.types, before /usr/share/zoneinfo and /etc/mime.types) or instead of
      # /etc/services and /etc/protocols (iana-etc; Go's built-in table answers https, icmp and the like without the
      # file). Nothing else.
      for f in $out/whombat-agent-*; do
        if grep -aoE '/nix/store/[a-z0-9]{32}-[^/"[:space:]]*' "$f" | grep -vE -- '-(iana-etc|mailcap|tzdata)-[^/]*$'; then
          echo "$f refers to the store"; exit 1
        fi
        # The key is in it.
        grep -qaF '${updateKey}' "$f"
      done
      # Each for its own architecture (ELF e_machine: 0x3e x86-64, 0xb7 AArch64; Mach-O 64-bit magic cffaedfe and
      # cputype 0x01000007 x86-64, 0x0100000c arm64, little-endian; PE: "MZ", then at the offset in 0x3c the
      # signature "PE" and two zero bytes, and the machine 0x8664 x86-64, 0xaa64 arm64, little-endian).
      m() { od -An -tx1 -j18 -N1 "$1" | tr -d ' '; }
      test "$(m $out/whombat-agent-linux-amd64)" = 3e
      test "$(m $out/whombat-agent-linux-arm64)" = b7
      macho() { od -An -tx1 -N8 "$1" | tr -d ' \n'; }
      test "$(macho $out/whombat-agent-darwin-amd64)" = cffaedfe07000001
      test "$(macho $out/whombat-agent-darwin-arm64)" = cffaedfe0c000001
      pe() {
        test "$(od -An -c -N2 "$1" | tr -d ' ')" = MZ
        od -An -tx1 -j"$(od -An -tu4 -j60 -N4 "$1" | tr -d ' ')" -N6 "$1" | tr -d ' \n'
      }
      test "$(pe $out/whombat-agent-windows-amd64.exe)" = 504500006486
      test "$(pe $out/whombat-agent-windows-arm64.exe)" = 5045000064aa
      runHook postInstallCheck
    '';
    passthru = { inherit archs oses agentNames; };
    meta = {
      description = "Whombat hosts service's agents, with the agent-signing key built in (unsigned files)";
      platforms = lib.platforms.linux;
    };
  };

  # hosts' signing tool, for the maintainers' sign-agents (never on an image).
  sign = mk {
    pname = "whombat-hosts-sign";
    src = sources.hosts;
    subPackages = [ "cmd/rackoon-sign" ];
    ldflags = [
      "-s"
      "-w"
    ];
    meta = {
      description = "rackoon-sign from hosts/: signs agent builds (the maintainers' sign-agents)";
      mainProgram = "rackoon-sign";
    };
  };

  # The build's check of the committed manifest (stdlib Go, its own unit tests).
  checker = buildGo127Module {
    pname = "whombat-hosts-manifest-check";
    version = "2";
    src = ./manifest-check;
    vendorHash = null;
    env.CGO_ENABLED = "0";
    meta.mainProgram = "whombat-hosts-manifest-check";
  };
  checkManifest = dir: ''
    ${checker}/bin/whombat-hosts-manifest-check --manifest ${manifestFile} --key ${keyFile} \
      --version '${version}' --dir ${dir}'';
  # checks.hosts-agent-manifest: the same check on its own, without building the hub. Strict: only a match passes.
  manifestCheck = runCommand "hosts-agent-manifest-check" { } ''
    ${checkManifest agents}
    touch $out
  '';
in
assert lib.assertMsg (builtins.match "0\\.0\\.0-[0-9]{14}\\.[0-9a-f]{7,40}" version != null)
  "nix/packages/hosts/agent-version.json: version ${version} is not 0.0.0-<UTC YYYYMMDDHHMMSS>.<short rev>, the form agents can order";
mk {
  pname = "whombat-hosts";
  src = sources.hosts;

  buildPhase = ''
    runHook preBuild
    go build -ldflags "${ldflagsWith ""}" -o "$NIX_BUILD_TOP/whombat-hosts" ./cmd/whombat-hosts
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -D -m 0555 "$NIX_BUILD_TOP/whombat-hosts" $out/bin/whombat-hosts
    install -d $out/share/whombat-hosts/agent
    # Copied, not linked: the image carries the hub's path only.
    install -m 0444 ${agents}/whombat-agent-* $out/share/whombat-hosts/agent/
    ${lib.optionalString hasHelper ''
      install -m 0444 ${agents}/whombat-helper-macos.zip ${agents}/whombat-helper-macos.json $out/share/whombat-hosts/agent/
    ''}
    # The manifest goes in only when every agent and the helper are what it signs. Other bytes: an unsigned build,
    # whose hub offers no agent update. Anything else is a broken manifest and fails the build.
    status=0
    ${checkManifest "$out/share/whombat-hosts/agent"} || status=$?
    case $status in
      0) install -m 0444 ${manifestFile} $out/share/whombat-hosts/agent/manifest.json ;;
      3) echo "unsigned build: the agents are other bytes than agent-manifest.json signs, so this hub offers no agent update" ;;
      *) exit 1 ;;
    esac
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    $out/bin/whombat-hosts version | grep -qF '${version}'
    ${lib.concatMapStrings (n: ''
      test -s $out/share/whombat-hosts/agent/${n}
    '') agentNames}
    ${lib.optionalString hasHelper ''
      test -s $out/share/whombat-hosts/agent/whombat-helper-macos.zip
    ''}
    if grep -aoE '/nix/store/[a-z0-9]{32}-[^/"[:space:]]*' $out/bin/whombat-hosts | grep -vE -- '-(iana-etc|mailcap|tzdata)-[^/]*$'; then
      echo "the hub refers to the store"; exit 1
    fi
    # A signed build's agents and manifest as installed, after the fixup phase: still a match.
    if [ -e $out/share/whombat-hosts/agent/manifest.json ]; then
      ${checkManifest "$out/share/whombat-hosts/agent"}
    fi
    # Nothing of the build's tools or the agents' own path stays referenced.
    if grep -rqaF -e '${agents}' -e '${checker}' $out; then echo "the package refers to the build"; exit 1; fi
    runHook postInstallCheck
  '';

  passthru = {
    agentDist = "share/whombat-hosts/agent";
    # The commit the agents were signed at (agent-version.json).
    signedRev = signed.rev;
    inherit
      agents
      sign
      manifestCheck
      checker
      updateKey
      ;
  };

  meta = {
    description = "Whombat hosts service: the headless hub for monitored servers and its signed agents (formerly Rackoon)";
    platforms = lib.platforms.linux;
    mainProgram = "whombat-hosts";
  };
}
