# Disk-boot test through UEFI firmware with a software TPM (swtpm):
#   1. whombat-install lays out a blank disk (ESP + LUKS2 root + LUKS2 persist, TPM2 slots only) and
#      installs the appliance; the factory generation is pre-blessed.
#   2. First boot from the disk (OVMF in Secure Boot setup mode): per-device Secure Boot keys are
#      generated and enrolled by systemd-boot; after the reboot Secure Boot is enforced and
#      whombat-tpm-seal binds both TPM2 slots to PCR 7 + the device-signed PCR 11 policy (/persist also to
#      PCR 15 after the root volume was opened; MA-21b, recovery-tpm covers the attacks).
#   3. Factory provisioning from the medium enrols the disk recovery key; the key on the printed card
#      opens both volumes.
#   4. A candidate generation is imported as a `nix-store --export` stream (the helper's import path)
#      and made the boot default like the helper does (profile + switch-to-configuration boot). It
#      unlocks /persist (TPM, signed at install) and runs, but never passes the local boot assessment; after the
#      attempts run out systemd-boot returns to the known-good generation, which unlocks too.
#   5. Factory reset with the recovery key: old keys no longer open /persist, the new volume unlocks
#      through the TPM under the same policy, the appliance is unprovisioned and the update helper's
#      records of the old identity are gone (L-5).
# What a VM cannot show (real firmware, real TPM, PCR changes by firmware updates, power loss) is in
# docs/runbooks/hardware-qualification.md and is never marked passed from here.
{
  applianceModules,
  lib,
  pkgs,
  ...
}:
let
  token = "dev-station-token-for-vm-tests-only";

  targetModule =
    { lib, pkgs, ... }:
    {
      imports = applianceModules ++ [ ./common/manager-dev.nix ];
      whombat.environment = "dev";
      whombat.storage.mode = "luks-tpm2";
      whombat.storage.persistReserveMiB = 64;
      whombat.boot = {
        tries = 2;
        assessmentTimeoutSec = 90;
        settleSec = 5;
      };
      whombat.runtime.watchdogSec = 10;
      whombat.slices.critical.memoryMin = "256M";
      whombat.postgres.sharedBuffers = "64MB";
      environment.systemPackages = [
        pkgs.dosfstools
        pkgs.sbctl
        pkgs.jq
      ];
      virtualisation = {
        directBoot.enable = false;
        mountHostNixStore = false;
        useDefaultFilesystems = false;
        fileSystems = lib.mkForce { };
        useEFIBoot = true;
        useSecureBoot = true;
        # OVMF with TPM measurement: the default build does not extend PCRs, so PCR 7 would be all zeros.
        efi.OVMF = pkgs.OVMFFull.fd;
        tpm.enable = true;
        qemu.options = [ "-smbios type=1,serial=SN-LUKS-0001" ];
        # The graphical console's Chromium (NX-84) and `nix-store --import` of the candidate don't fit in 2 GiB together
        # (the import was OOM-killed); the qualified hardware has 8 GiB.
        memorySize = 3072;
        # The disk comes from the installer (NIX_DISK_IMAGE); the factory medium is a second drive.
        qemu.drives = [
          {
            name = "factory";
            file = ''"$WHOMBAT_FACTORY_DISK"'';
            deviceExtraOpts.serial = "factory";
          }
        ];
      };
    };
in
{
  name = "whombat-install-boot-luks";

  nodes = {
    control = {
      imports = [ ./common/control.nix ];
    };

    target = targetModule;

    # The same system plus a fault: the runtime reports "degraded", so the boot assessment never passes.
    candidate =
      { ... }:
      {
        imports = [ targetModule ];
        systemd.tmpfiles.rules = [
          "d /run/whombat-standin 0755 root root -"
          "f /run/whombat-standin/unhealthy 0644 root root -"
        ];
      };

    installer =
      { nodes, pkgs, ... }:
      {
        imports = [ ../nix/profiles/installer-base.nix ];
        whombat.installer.system = nodes.target.system.build.toplevel;
        whombat.installer.rootSize = "7G";
        virtualisation.additionalPaths = [ nodes.candidate.system.build.toplevel ];
        virtualisation.tpm.enable = true;
        virtualisation.memorySize = 4096;
        virtualisation.emptyDiskImages = [
          {
            size = 12288;
            driveConfig.deviceExtraOpts.serial = "target";
          }
          {
            size = 4096;
            driveConfig.deviceExtraOpts.serial = "xfer";
          }
          {
            size = 64;
            driveConfig.deviceExtraOpts.serial = "factory";
          }
        ];
        environment.systemPackages = [
          pkgs.dosfstools
          pkgs.mtools
        ];
      };
  };

  testScript =
    { nodes, ... }:
    let
      good = nodes.target.system.build.toplevel;
      bad = nodes.candidate.system.build.toplevel;
    in
    ''
      import json, os, re

      good = "${good}"
      bad = "${bad}"
      shared = os.path.join(os.environ.get("TMPDIR", "/tmp"), "whombat-shared")
      os.makedirs(shared, exist_ok=True)
      # One TPM for installer and target: the TPM2 keyslots are created during installation.
      os.environ["NIX_SWTPM_DIR"] = os.path.join(shared, "swtpm")

      def reconnect(m):
          m.connected = False
          m.connect()

      def reboot(m):
          # Not Ctrl+Alt+Del (the driver's reboot()): the graphical console's cage holds the keyboard in raw mode (NX-82).
          m.succeed("systemd-run --on-active=1 systemctl reboot")
          m.connected = False

      def current(m):
          return m.succeed("readlink -f /run/current-system").strip()

      def entries(m):
          return m.succeed("ls /boot/EFI/Linux").split()

      control.start()

      with subtest("install onto a blank disk"):
          installer.start()
          installer.wait_for_unit("multi-user.target")
          out = installer.succeed(
              "whombat-install --disk /dev/disk/by-id/virtio-target --yes-erase-disk --root-size 7G 2>&1",
              timeout=1800,
          )
          print(out)
          # The candidate travels as a nix-store export stream, like a staged update artifact.
          installer.succeed(f"nix-store --export $(nix-store -qR {bad}) > /dev/disk/by-id/virtio-xfer")
          # Factory medium for step 3.
          station = json.dumps({"v": 1, "environment": "dev", "controlUrl": "http://control:4600",
                                "tokenFile": "token", "model": "whombat-one",
                                "factoryRelease": "rt-fixture-1", "seedHelper": False, "luksDevices": [
                                    "/dev/disk/by-partlabel/whombat-root", "/dev/disk/by-partlabel/whombat-persist"]})
          installer.succeed(
              "mkfs.vfat /dev/disk/by-id/virtio-factory",
              f"echo '{station}' > /tmp/station.json && mcopy -i /dev/disk/by-id/virtio-factory /tmp/station.json ::/station.json",
              "echo '${token}' > /tmp/token && mcopy -i /dev/disk/by-id/virtio-factory /tmp/token ::/token",
          )
          installer.succeed("sync")
          installer.shutdown()
          state = str(installer.state_dir)
          os.environ["NIX_DISK_IMAGE"] = os.path.join(state, "empty0.qcow2")
          os.environ["WHOMBAT_FACTORY_DISK"] = os.path.join(state, "empty2.qcow2")
          xfer = os.path.join(state, "empty1.qcow2")

      with subtest("first boots: Secure Boot keys generated and enrolled, TPM sealed to PCR 7"):
          target.start(allow_reboot=True)
          # Boot 1 (firmware in setup mode) generates the keys and reboots by itself
          # (prepare-sb-auto-enroll); systemd-boot enrols them on the way into boot 2.
          target.connect()
          reconnect(target)
          assert current(target) == good
          target.succeed("findmnt -n -o SOURCE / | grep -q /dev/mapper/whombat-root")
          target.succeed("findmnt -n -o SOURCE /persist | grep -q /dev/mapper/whombat-persist")
          status = target.succeed("bootctl status 2>&1 || true")
          print(status)
          assert "Secure Boot: enabled (user)" in status, status
          # PCR 7 is really measured (non-zero) by the firmware, so the seal binds to something.
          pcr7 = target.succeed("systemd-analyze pcrs 7 --json=short")
          print(pcr7)
          assert "0000000000000000000000000000000000000000000000000000000000000000" not in pcr7, pcr7
          target.wait_for_unit("whombat-tpm-seal.service")
          target.fail("journalctl -b -u whombat-tpm-seal | grep -q 'none of the selected PCRs are valid'")
          assert target.succeed("cat /var/lib/whombat-storage/tpm-seal").startswith("v3 pcrs=7 signed-pcr11=")
          for part, pcrs in [("whombat-root", [7]), ("whombat-persist", [7, 15])]:
              dev = f"/dev/disk/by-partlabel/{part}"
              dump = target.succeed(f"cryptsetup luksDump {dev}")
              ids = re.findall(r"^\s+(\d+): systemd-tpm2$", dump, re.M)
              assert len(ids) == 1, dump
              token = json.loads(target.succeed(f"cryptsetup token export --token-id {ids[0]} {dev}"))
              print(part, token.get("tpm2-pcrs"), token.get("tpm2_pubkey_pcrs"), token.get("tpm2-pcr-bank"))
              assert token.get("tpm2-pcrs") == pcrs and token.get("tpm2_pubkey_pcrs") == [11], token
              # Before provisioning: the TPM2 slot and the maintenance slot (its key is root-only on the
              # encrypted root; the running system re-enrols with it). The bootstrap key was wiped.
              assert len(re.findall(r"^\s+\d+: luks2$", dump, re.M)) == 2, dump
              target.succeed(f"cryptsetup open --test-passphrase --key-file /var/lib/whombat-storage/maint-{part}.key {dev}")
          print(target.succeed("sbctl verify 2>&1 || true"))
          # No per-device secret came with the image: keys were generated on this device.
          target.succeed("test -e /var/lib/sbctl/keys/db/db.key")
          target.succeed("test -z \"$(ls -A /persist/identity)\"")

      with subtest("factory provisioning enrols the disk recovery key"):
          target.succeed("fatlabel /dev/disk/by-id/virtio-factory WBFACTORY")
          target.wait_until_succeeds("test -e /persist/identity/device.json", timeout=180)
          print(target.succeed("journalctl -u whombat-factory-provision --no-pager | tail -20"))
          rec = json.loads(target.succeed("whombat-provision verify"))
          assert rec["recoveryKeyEnrolled"], rec
          target.succeed("mkdir -p /mnt/m && mount /dev/disk/by-label/WBFACTORY /mnt/m")
          svg = target.succeed(f"cat /mnt/m/cards/disk-recovery-{rec['deviceId']}.svg")
          groups = re.findall(r">([cbdefghijklnrtuv]{8}(?:-[cbdefghijklnrtuv]{8}){3})<", svg)
          assert len(groups) == 2, groups
          key = "-".join(groups)
          target.succeed("umount /mnt/m")
          for part in ["whombat-root", "whombat-persist"]:
              target.succeed(f"printf '%s' '{key}' | cryptsetup open --test-passphrase --key-file=- /dev/disk/by-partlabel/{part}")
              target.fail(f"printf 'wrong-key' | cryptsetup open --test-passphrase --key-file=- /dev/disk/by-partlabel/{part}")
          for u in ["whombat-server", "whombat-runner", "whombat-manager"]:
              target.wait_for_unit(f"{u}.service")
          target.systemctl("start whombat-boot-assessment.service")
          target.succeed("systemctl is-active whombat-boot-assessment.service")

      with subtest("known-good entry is blessed, no counter"):
          print(entries(target))
          assert any(e.startswith("nixos-generation-1-") and "+" not in e for e in entries(target)), entries(target)

      target.shutdown()
      # Re-use the factory drive slot for the transfer image in the next boots.
      os.environ["WHOMBAT_FACTORY_DISK"] = xfer
      target.start(allow_reboot=True)
      target.connect()

      with subtest("import the candidate like the helper and make it the boot default"):
          out = target.succeed("nix-store --import < /dev/disk/by-id/virtio-factory 2>&1 | tail -3", timeout=900)
          print(out)
          target.succeed(f"nix-store --check-validity {bad}")
          target.succeed(f"nix-env --profile /nix/var/nix/profiles/system --set {bad}")
          target.succeed(f"{bad}/bin/switch-to-configuration boot")
          e = entries(target)
          print(e)
          assert any(x.startswith("nixos-generation-2-") and x.endswith("+2.efi") for x in e), e
          print(target.succeed("sbctl verify 2>&1 || true"))

      with subtest("candidate boots, unlocks /persist, fails assessment, falls back"):
          reboot(target)
          target.connect()
          assert current(target) == bad, current(target)
          target.succeed("findmnt -n -o SOURCE /persist | grep -q /dev/mapper/whombat-persist")
          target.succeed("test -e /persist/identity/device.json")
          print(target.succeed("bootctl list --no-pager 2>&1 | head -40 || true"))
          # Attempt 1 fails the assessment and reboots; attempt 2 the same; then the known-good boots.
          reconnect(target)
          assert current(target) == bad, current(target)
          reconnect(target)
          assert current(target) == good, current(target)
          target.succeed("findmnt -n -o SOURCE /persist | grep -q /dev/mapper/whombat-persist")
          e = entries(target)
          print(e)
          assert any(x.startswith("nixos-generation-2-") and x.endswith("+0-2.efi") for x in e), e
          target.wait_for_unit("whombat-boot-assessment.service", timeout=300)
          print(target.succeed("journalctl --list-boots --no-pager"))

      with subtest("factory reset with the recovery key"):
          # Helper records of the old identity (assignment sequence floor, activations) must not survive.
          target.succeed("mkdir -p /var/lib/whombat-update-helper && echo '{\"v\":1,\"maxAssignmentSeq\":99}' > /var/lib/whombat-update-helper/state.json")
          target.succeed(f"printf '%s\\n' '{key}' | whombat-factory-reset 2>&1")
          target.fail("test -e /var/lib/whombat-update-helper/state.json")
          (tok,) = [json.loads(target.succeed(f"cryptsetup token export --token-id {i} /dev/disk/by-partlabel/whombat-persist"))
                    for i in re.findall(r"^\s+(\d+): systemd-tpm2$", target.succeed("cryptsetup luksDump /dev/disk/by-partlabel/whombat-persist"), re.M)]
          assert tok.get("tpm2-pcrs") == [7, 15] and tok.get("tpm2_pubkey_pcrs") == [11], tok
          target.fail(f"printf '%s' '{key}' | cryptsetup open --test-passphrase --key-file=- /dev/disk/by-partlabel/whombat-persist")
          # The previous owner's recovery key no longer opens the system volume either (N-7).
          target.fail(f"printf '%s' '{key}' | cryptsetup open --test-passphrase --key-file=- /dev/disk/by-partlabel/whombat-root")
          target.succeed("cryptsetup open --test-passphrase --key-file /var/lib/whombat-storage/maint-whombat-root.key /dev/disk/by-partlabel/whombat-root")
          reboot(target)
          target.connect()
          target.succeed("findmnt -n -o SOURCE /persist | grep -q /dev/mapper/whombat-persist")
          target.succeed("test ! -e /persist/identity/device.json")
          target.fail("systemctl is-active whombat-server.service")

      with subtest("re-provisioning for a new owner: only the new recovery key opens root and /persist (N-7)"):
          target.succeed(
              "mkfs.vfat /dev/disk/by-id/virtio-factory",
              "mkdir -p /mnt/m && mount /dev/disk/by-id/virtio-factory /mnt/m",
          )
          station2 = json.loads(station)
          station2["serial"] = "SN-LUKS-0002"
          target.succeed(f"echo '{json.dumps(station2)}' > /mnt/m/station.json && echo '${token}' > /mnt/m/token && umount /mnt/m")
          target.succeed("fatlabel /dev/disk/by-id/virtio-factory WBFACTORY")
          target.wait_until_succeeds("test -e /persist/identity/device.json", timeout=180)
          print(target.succeed("journalctl -u whombat-factory-provision --no-pager | tail -20"))
          rec2 = json.loads(target.succeed("whombat-provision verify"))
          target.succeed("mount /dev/disk/by-label/WBFACTORY /mnt/m")
          svg2 = target.succeed(f"cat /mnt/m/cards/disk-recovery-{rec2['deviceId']}.svg")
          target.succeed("umount /mnt/m")
          key2 = "-".join(re.findall(r">([cbdefghijklnrtuv]{8}(?:-[cbdefghijklnrtuv]{8}){3})<", svg2))
          assert key2 and key2 != key
          for part in ["whombat-root", "whombat-persist"]:
              dev = f"/dev/disk/by-partlabel/{part}"
              target.succeed(f"printf '%s' '{key2}' | cryptsetup open --test-passphrase --key-file=- {dev}")
              target.fail(f"printf '%s' '{key}' | cryptsetup open --test-passphrase --key-file=- {dev}")
              dump = target.succeed(f"cryptsetup luksDump {dev}")
              # TPM2 + maintenance + the new recovery key, nothing else.
              assert len(re.findall(r"^\s+\d+: luks2$", dump, re.M)) == 3, dump
    '';
}
