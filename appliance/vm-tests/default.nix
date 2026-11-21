# VM tests (NX-26). Each attribute is a NixOS test derivation:
#   nix build .#checks.x86_64-linux.<name>                     (in the Nix sandbox)
#   nix build .#checks.x86_64-linux.<name>.driver && ./result/bin/nixos-test-driver   (interactive, KVM as the user)
{
  pkgs,
  lib,
  applianceModules,
  recoveryUki ? null,
  recoveryProbeUki ? null,
  # flake.nix's releaseRuntime: a runtime bundle that reports a release's version (NX-71).
  releaseRuntime ? null,
}:
let
  runWith =
    modules: file:
    pkgs.testers.runNixOSTest {
      imports = [ file ];
      _module.args = {
        inherit recoveryUki recoveryProbeUki releaseRuntime;
        applianceModules = applianceModules ++ modules;
        # update-migration and restore-drill: this tree's runtime and manager (the upgrade gates pass a candidate's).
        migrationRuntime = pkgs.whombat-runtime;
        managerSource = ../.;
      };
      defaults.imports = [ ./common/defaults.nix ];
    };
  run = runWith [ ];
  # The same suite with the real runtime bundle on its appliance nodes (NX-49).
  runReal = runWith [ ./common/real-bundle.nix ];
in
{
  appliance-basic = run ./appliance-basic.nix;
  install-boot-luks = run ./install-boot-luks.nix;
  # The ISO in a VM with install.md's settings (virtio-scsi, i6300esb, guest agent), and on a machine-like VM (NVMe,
  # an Intel NIC on DHCP, the chipset's watchdog, no guest agent; NX-189).
  install-vm = run ./install-vm.nix;
  install-machine = run ./install-machine.nix;
  manager-units = run ./manager-units.nix;
  sandbox-backup = run ./sandbox-backup.nix;
  # Backup destinations through the real units, and a restore onto a fresh box with the documented commands, the agent's
  # Hermes homes with it (BK-18…BK-24, BK-36).
  backup-destinations = run ./backup-destinations.nix;
  # The app's restore on btrfs subvolumes: one that fails after the fresh install was set aside is undone, one that
  # works leaves nothing set aside after the release, a power cut is put back at the next boot (BK-39, BK-40…).
  backup-app-restore = run ./backup-app-restore.nix;
  recovery-tpm = run ./recovery-tpm.nix;
  console-self = run ./console-self.nix;
  vault-wall = run ./vault-wall.nix;
  # Tailscale signed out in the image, its local API for root and the manager only, and the direct port from the local
  # network and tailscale0 only (Whombat HE-50, HE-51; NX-440…NX-443).
  tailscale-direct = run ./tailscale-direct.nix;
  # Tailscale chosen in the installer and the box restarted before the first sign-in: on again with a fresh link from a
  # real Headscale, kept by tailscaled once signed in, off stays off (MG-180).
  tailscale-first-sign-in = run ./tailscale-first-sign-in.nix;
  # The agent's containers and its commands' network (Whombat OP-07, OP-16, OP-19; NX-455…NX-466): rootless Podman as
  # its own user, the socket for the runner's and the server's groups, published ports from private networks only, the
  # agent's wall for the containers and the commands' proxy's uid, nothing of Incus.
  containers = run ./containers.nix;
  # The voice service's unit, socket and sandbox with its real programs and models (NX-175…NX-184); a small VM of its own.
  voice = run ./voice.nix;
  # Wi-Fi end to end: hwsim radios, access points in a namespace, the manager's join, failure, revert and forget
  # (NX-240…NX-247, MG-100…MG-104).
  wifi = run ./wifi.nix;
  # Bluetooth: BlueZ with two virtual controllers, the D-Bus policy, whombat-bluetooth's socket, a Just Works pairing
  # (NX-350…NX-363).
  bluetooth = run ./bluetooth.nix;
  # Remote help's support service: its socket's callers, a grant over it, a restart, an expiry, leftovers ended, Look's
  # user (NX-411…NX-424).
  support = run ./support.nix;
  # The real runtime bundle (PI-07/PI-08, NX-48).
  runtime-real = run ./runtime-real.nix;
  # A live agent turn through the real bundle: runner, managed sandbox, an agent CLI inside it (NX-75).
  runtime-live-turn = run ./runtime-live-turn.nix;
  # The suites that run the runtime units, again with the real bundle (NX-49). console-self stays on the stand-in: it
  # writes the console file by hand and uses the stand-in's `claimed` fault; runtime-real covers the real server's file.
  appliance-basic-real-runtime = runReal ./appliance-basic.nix;
  manager-units-real-runtime = runReal ./manager-units.nix;
  sandbox-backup-real-runtime = runReal ./sandbox-backup.nix;
  vault-wall-real-runtime = runReal ./vault-wall.nix;
}
# Releases that migrate the database, from the baseline's release to this tree's and on (NX-103, NX-115), and the
# restore drill (NX-116): only when this tree's schema check reports its target's floors (MD-12); before, the manager
# keeps the tuple-only check and the tests' migrating releases are refused by design (MG-43).
//
  lib.optionalAttrs
    (
      releaseRuntime != null
      && lib.hasInfix "export interface SchemaTarget" (
        builtins.readFile "${pkgs.whombat-runtime.src}/apps/server/src/db/compat.ts"
      )
    )
    (
      {
        # Gate 7 of the upgrade gates (UP-F2, NX-116): a failed contract migration's checkpoint restored onto a fresh box.
        restore-drill = run ./upgrade-gates/restore-drill.nix;
      }
      # The update from an earlier release needs one to start from (./common/migration-baseline.nix): this tree names
      # none, the maintainers' CI gives it one.
      // lib.optionalAttrs (import ./common/migration-baseline.nix != null) {
        update-migration = run ./update-migration.nix;
      }
    )
