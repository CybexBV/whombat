# The appliance's Go binaries, all from the module github.com/CybexBV/whombat/appliance in appliance/
# (the manager, the helper, the release tools, provisioning and the rest), with one set of Go modules.
# `version` is flake.nix's `<appliance semver>-0.dev` (NX-105, UP-X09); release builds override the manager's and the helper's
# with the commit's release version (`applianceRelease`).
#
# The contracts' Go module is this repository's contracts/go, used through go.mod's `replace … => ../contracts/go`:
# every source below holds it beside appliance/, and the module is in `modRoot`.
#
# The Go modules are downloaded as Go's module cache (`proxyVendor`), not as a vendor folder: a vendor folder would
# also hold the replaced contracts module, so its hash would change with every change to the contracts. This one
# follows appliance/go.mod and go.sum alone. It is in nix/fixed-hashes.json with the digest of those two files
# (appliance/scripts/ci/fixed-hashes.sh --refresh applianceGo), and the download's name carries the digest.
{
  lib,
  buildGoModule,
  makeWrapper,
  systemd,
  cryptsetup,
  nftables,
  iproute2,
  util-linux,
  dbus,
  hwdata,
  sources,
  nixpkgsRev,
  version,
}:
let
  fixed = sources.fixedHash "applianceGo" {
    files = [
      "appliance/go.mod"
      "appliance/go.sum"
    ];
    params.nixpkgs = nixpkgsRev;
  };
  vendorHash = fixed.hash;
  modRoot = "appliance";
  proxyVendor = true;
  # Every package builds from the directories its packages import (`go list -deps`), so a commit that changes the
  # manager doesn't change the recovery tool, the console or the backup service, nor the recovery UKI and the system
  # paths that carry them: a host release downloads only what changed (UP-X14, NX-134). The Go modules are downloaded
  # once for the whole module (`vendorHash` covers all of them) and are shared. A missing directory fails the build with
  # Go's “cannot find package”: add it to the package's `dirs`. A package that runs its tests here (`extra.doCheck`) is
  # built from its folders with their tests, and `vectors` are the contracts' test vectors those tests read
  # (contracts/go/testdata/vectors/<name>); a package that doesn't is built without any test file, so a changed test
  # rebuilds only what runs it. The download of the modules reads go.mod and go.sum and no Go file.
  srcOf = sources.applianceGo;
  modules =
    (buildGoModule {
      pname = "whombat-go";
      inherit
        version
        vendorHash
        modRoot
        proxyVendor
        ;
      overrideModAttrs = _: _: { name = "whombat-go-modules-${fixed.tag}"; };
      src = sources.applianceGoModules;
    }).goModules;
  mk =
    {
      pname,
      subPackages,
      dirs,
      description,
      vectors ? [ ],
      extra ? { },
    }:
    (buildGoModule (
      {
        inherit
          pname
          version
          vendorHash
          modRoot
          proxyVendor
          subPackages
          ;
        src = srcOf {
          inherit vectors;
          tests = extra.doCheck or false;
        } dirs;
        env.CGO_ENABLED = "0";
        ldflags = [
          "-s"
          "-w"
        ];
        # Unit tests of the whole module run in W1-MG's/our CI (`go test ./...`); the provisioning
        # tests also run in `whombat-provision` below.
        doCheck = false;
        meta = {
          inherit description;
          platforms = lib.platforms.linux;
        };
      }
      // extra
    )).overrideAttrs
      { goModules = modules; };
in
{
  whombat-dns-fallback = mk {
    pname = "whombat-dns-fallback";
    dirs = [ "network" ];
    subPackages = [ "network/cmd/whombat-dns-fallback" ];
    description = "Last-resort DNS for the appliance's physical uplinks";
    extra = {
      doCheck = true;
      nativeCheckInputs = [ dbus ];
      checkPhase = ''
        runHook preCheck
        go test ./network/...
        runHook postCheck
      '';
    };
  };
  whombat-update-helper = mk {
    pname = "whombat-update-helper";
    dirs = [ "helper" ];
    subPackages = [
      "helper/cmd/whombat-update-helper"
      "helper/cmd/whombat-tpm-policy"
    ];
    description = "Whombat root update helper (typed operations only) and the TPM policy tool";
  };
  whombat-manager = mk {
    pname = "whombat-manager";
    dirs = [ "helper" "manager" "internal/environment" "internal/reach" ];
    subPackages = [
      "manager/cmd/whombat-manager"
      "manager/cmd/whombat-manager-recovery"
    ];
    description = "Whombat device manager and its known-good recovery launcher";
    # The hardware report's names (pci.ids, usb.ids; MG-112): a store path in the binary, not a configuration field
    # (an older known-good manager must still read the configuration). hwdata is in the closure already (libpciaccess).
    extra.ldflags = [
      "-s"
      "-w"
      "-X github.com/CybexBV/whombat/appliance/manager/internal/hardware.HwdataDir=${hwdata}/share/hwdata"
    ];
  };
  whombat-release-tools = mk {
    pname = "whombat-release-tools";
    dirs = [ "helper" "manager" "release-tools" ];
    subPackages = [
      "release-tools/cmd/tufrepo"
      "release-tools/cmd/clientchannel"
    ];
    description = "Development TUF repository tool (refuses prod)";
  };
  whombat-backup = mk {
    pname = "whombat-backup";
    dirs = [ "backup" ];
    subPackages = [
      "backup/cmd/whombat-backup"
      "backup/cmd/whombat-backup-snapd"
    ];
    description = "Whombat backup service and snapshot helper (W3-BK)";
  };
  whombat-recovery = mk {
    pname = "whombat-recovery";
    dirs = [ "backup" "recovery" ];
    subPackages = [ "recovery/cmd/whombat-recovery" ];
    description = "Whombat recovery/export tool (works without the appliance or the cloud)";
  };
  whombat-console = mk {
    pname = "whombat-console";
    dirs = [ "console" ];
    vectors = [ "local.json" ];
    subPackages = [ "console/cmd/whombat-console" ];
    description = "Whombat local console: the claim code on tty1 (CC-08) and the graphical console's server (CG-03)";
    extra = {
      doCheck = true;
      # The installer's tests run with the installer (its Wi-Fi needs the helper's wifi package, which this source
      # leaves out so a change there doesn't change the console).
      checkPhase = ''
        runHook preCheck
        go test $(go list -e ./console/... | grep -v -e /console/internal/installer -e /console/cmd/whombat-installer-ui)
        runHook postCheck
      '';
    };
  };
  # The graphical installer's server on the installer ISO (CG-11…CG-14, NX-79).
  whombat-installer-ui = mk {
    pname = "whombat-installer-ui";
    # The Wi-Fi step joins with iwd through the helper's wifi package (HD-08, CG-123).
    dirs = [ "console" "helper/pkg/wifi" "helper/pkg/atomicfile" "internal/reach" ];
    subPackages = [ "console/cmd/whombat-installer-ui" ];
    description = "Whombat installer: pre-flight checks, disks and whombat-install behind the graphical installer";
    extra = {
      doCheck = true;
      checkPhase = ''
        runHook preCheck
        go test ./console/internal/installer/...
        runHook postCheck
      '';
    };
  };
  whombat-vault-wall = mk {
    pname = "whombat-vault-wall";
    dirs = [ "vaultwall" ];
    subPackages = [ "vaultwall/cmd/whombat-vault-wall" ];
    description = "Whombat Vault home-network wall: the runtime's list into the egress table's sets (IN-58)";
    extra = {
      doCheck = true;
      # The real-nft test runs in a user and network namespace when the build sandbox allows one, else skips.
      nativeCheckInputs = [
        nftables
        util-linux
      ];
      checkPhase = ''
        runHook preCheck
        WHOMBAT_TEST_NFT=${nftables}/bin/nft go test ./vaultwall/...
        runHook postCheck
      '';
    };
  };
  # Speech on the box for the desk display (Whombat DK-06, NX-175…NX-184): the voice socket in front of whisper-cli and
  # kokoro-speak (nix/modules/voice.nix). Its notices (the models' and programs' licences) go with it.
  whombat-voice = mk {
    pname = "whombat-voice";
    dirs = [ "voice" "helper" ];
    subPackages = [
      "voice/cmd/whombat-voice"
      "voice/cmd/whombat-voice-models"
    ];
    description = "Whombat voice: speech to text and text to speech on the box, for the runtime (no network)";
    extra = {
      doCheck = true;
      checkPhase = ''
        runHook preCheck
        go test ./voice/...
        runHook postCheck
      '';
      postInstall = ''
        install -Dm644 voice/NOTICES.md $out/share/whombat-voice/NOTICES.md
      '';
    };
  };
  # Stay unlocked while you're here (Whombat DK-28…DK-33, NX-280…): the presence socket in front of presence-watch, which
  # holds the camera (nix/modules/presence.nix). Its notices (the model's and the libraries' licences) go with it.
  whombat-presence = mk {
    pname = "whombat-presence";
    dirs = [ "presence" "helper" ];
    subPackages = [ "presence/cmd/whombat-presence" ];
    description = "Whombat presence: whether someone is in front of the screen, from the camera, for the runtime (no network)";
    extra = {
      doCheck = true;
      checkPhase = ''
        runHook preCheck
        go test ./presence/...
        runHook postCheck
      '';
      postInstall = ''
        install -Dm644 presence/NOTICES.md $out/share/whombat-presence/NOTICES.md
      '';
    };
  };
  # Bluetooth on the box (Whombat BT-01…BT-10, NX-350…): the Bluetooth socket in front of BlueZ, its pairing agent
  # (nix/modules/bluetooth.nix).
  whombat-bluetooth = mk {
    pname = "whombat-bluetooth";
    dirs = [ "bluetooth" "helper" ];
    subPackages = [ "bluetooth/cmd/whombat-bluetooth" ];
    description = "Whombat Bluetooth: pairing keyboards, mice, speakers and headphones with the box, for the runtime";
    extra = {
      doCheck = true;
      checkPhase = ''
        runHook preCheck
        go test ./bluetooth/...
        runHook postCheck
      '';
    };
  };
  # Remote help (Whombat RH-01…RH-13, NX-411…): the owners' grant, the support socket, and while a grant runs the relay
  # worker and the SSH server Whombat support connects to (nix/modules/support.nix).
  whombat-support = mk {
    pname = "whombat-support";
    dirs = [ "support" "helper" ];
    subPackages = [ "support/cmd/whombat-support" ];
    description = "Whombat support: remote help into this Whombat for Whombat support, while an owner allows it";
    extra = {
      doCheck = true;
      # The packages that run real programs (look, fix, sshd and the end-to-end test: /bin/sh, bash, a terminal) need a
      # host's tools the sandbox doesn't have; they run with `go test ./...` in CI and locally.
      checkPhase = ''
        runHook preCheck
        go test ./support/cmd/... ./support/internal/api/... ./support/internal/cakeys/... \
          ./support/internal/grant/... ./support/internal/records/... ./support/internal/relay/... \
          ./support/internal/managerclient/... ./support/internal/reap/... ./support/internal/wire/...
        runHook postCheck
      '';
    };
  };
  # The kiosk's input devices plugged in later (NX-400…NX-404): udevd's input events passed into the console server's
  # network namespace, where the kiosk's cage runs (nix/modules/kiosk.nix).
  whombat-kiosk-udev = mk {
    pname = "whombat-kiosk-udev";
    dirs = [ "kioskudev" ];
    subPackages = [ "kioskudev/cmd/whombat-kiosk-udev" ];
    description = "Whombat kiosk udev relay: udevd's input events into the kiosk's network namespace";
    extra = {
      doCheck = true;
      # The real-kernel test (two network namespaces) runs in a user namespace when the build sandbox allows one, else
      # skips.
      nativeCheckInputs = [ util-linux ];
      checkPhase = ''
        runHook preCheck
        go test ./kioskudev/...
        runHook postCheck
      '';
    };
  };
  whombat-provision = mk {
    pname = "whombat-provision";
    dirs = [ "provisioning" "internal" "helper/pkg/atomicfile" ];
    vectors = [ "claim.json" ];
    subPackages = [
      "provisioning/cmd/whombat-provision"
      "provisioning/cmd/whombat-fake-control"
    ];
    description = "Whombat appliance factory provisioning";
    extra = {
      nativeBuildInputs = [ makeWrapper ];
      doCheck = true;
      checkPhase = ''
        runHook preCheck
        go test ./provisioning/... ./internal/...
        runHook postCheck
      '';
      postInstall = ''
        wrapProgram $out/bin/whombat-provision --prefix PATH : ${
          lib.makeBinPath [
            systemd
            cryptsetup
          ]
        }
      '';
    };
  };
}
