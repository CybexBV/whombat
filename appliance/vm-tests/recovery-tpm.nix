# Recovery environment and TPM2 unlock policy (W4-SEC part 2 C-1 and H-1; MA-21a/b), UEFI Secure Boot + swtpm:
#   1. Install, enrol per-device Secure Boot keys; whombat-tpm-seal binds root to PCR 7 + the device-signed
#      PCR 11 policy and /persist additionally to PCR 15 after the root volume was opened.
#   2. An update to a new generation (helper path: import, profile, switch-to-configuration boot) is signed
#      by the boot-loader install and still unlocks without the recovery key.
#   3. The signed recovery UKI (with a test probe, vm-tests/common/recovery-probe.nix): the TPM releases
#      neither disk key there; tty2–tty6 give no shell; the menu refuses a wrong recovery key and, with the
#      right one, exports the appliance's data to an attached disk.
#   4. Positive control: a legacy PCR-7-only slot does unseal in the same recovery environment (the probe
#      is not vacuous).
#   5. A swapped-in root volume (attacker's LUKS volume the TPM opens) does not get /persist.
{
  applianceModules,
  recoveryProbeUki,
  lib,
  pkgs,
  ...
}:
let
  recoveryKey = "recovery-key-for-vm-tests-only-0123456789";

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
        recoveryUki = recoveryProbeUki;
      };
      whombat.runtime.watchdogSec = 10;
      whombat.slices.critical.memoryMin = "256M";
      whombat.postgres.sharedBuffers = "64MB";
      environment.systemPackages = [
        pkgs.sbctl
        pkgs.jq
      ];
      # Test observability only: the initrd reports on the serial console whether /persist was opened,
      # and never waits at a passphrase prompt (nobody types one here).
      boot.initrd.luks.devices.whombat-persist.crypttabExtraOpts = [ "headless=true" ];
      boot.initrd.luks.devices.whombat-root.crypttabExtraOpts = [ "headless=true" ];
      # Runs right after the /persist unlock attempt and before the root file system is mounted, so it
      # reports even when the swapped-in root carries no system (the initrd then fails and reboots).
      boot.initrd.systemd.services.whombat-test-persist-report = {
        wantedBy = [
          "cryptsetup.target"
          "sysroot.mount"
        ];
        before = [
          "cryptsetup.target"
          "sysroot.mount"
        ];
        after = [ "systemd-cryptsetup@whombat\\x2dpersist.service" ];
        unitConfig.DefaultDependencies = false;
        serviceConfig.Type = "oneshot";
        script = ''
          if [ -e /dev/mapper/whombat-persist ]; then
            echo "<3>PERSIST-PROBE: opened" > /dev/kmsg
          else
            echo "<3>PERSIST-PROBE: not opened" > /dev/kmsg
          fi
        '';
      };
      virtualisation = {
        directBoot.enable = false;
        mountHostNixStore = false;
        useDefaultFilesystems = false;
        fileSystems = lib.mkForce { };
        useEFIBoot = true;
        useSecureBoot = true;
        efi.OVMF = pkgs.OVMFFull.fd;
        tpm.enable = true;
        qemu.options = [ "-smbios type=1,serial=SN-RTPM-0001" ];
        memorySize = 4096;
        qemu.drives = [
          {
            name = "xfer";
            file = ''"$WB_XFER_DISK"'';
            deviceExtraOpts.serial = "xfer";
          }
          {
            name = "export";
            file = ''"$WB_EXPORT_DISK"'';
            deviceExtraOpts.serial = "export";
          }
          {
            name = "scratch";
            file = ''"$WB_SCRATCH_DISK"'';
            deviceExtraOpts.serial = "scratch";
          }
        ];
      };
    };
in
{
  name = "whombat-recovery-tpm";

  nodes = {
    target = targetModule;
    # An update: the same system plus a file (a different generation with a different PCR 11 value).
    candidate =
      { ... }:
      {
        imports = [ targetModule ];
        environment.etc."whombat-candidate".text = "candidate generation\n";
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
            size = 1024;
            driveConfig.deviceExtraOpts.serial = "export";
          }
          {
            size = 16;
            driveConfig.deviceExtraOpts.serial = "scratch";
          }
        ];
        environment.systemPackages = [
          pkgs.e2fsprogs
          pkgs.cryptsetup
        ];
      };
  };

  testScript =
    { nodes, ... }:
    let
      cand = nodes.candidate.system.build.toplevel;
      good = nodes.target.system.build.toplevel;
    in
    ''
      import json, os, queue, re, time

      cand = "${cand}"
      good = "${good}"
      key = "${recoveryKey}"
      shared = os.path.join(os.environ.get("TMPDIR", "/tmp"), "whombat-shared-rtpm")
      os.makedirs(shared, exist_ok=True)
      os.environ["NIX_SWTPM_DIR"] = os.path.join(shared, "swtpm")

      def reconnect(m):
          m.connected = False
          m.connect()

      def current(m):
          return m.succeed("readlink -f /run/current-system").strip()

      def tpm_tokens(m, part):
          dev = f"/dev/disk/by-partlabel/{part}"
          dump = m.succeed(f"cryptsetup luksDump {dev}")
          ids = re.findall(r"^\s+(\d+): systemd-tpm2$", dump, re.M)
          return [json.loads(m.succeed(f"cryptsetup token export --token-id {i} {dev}")) for i in ids]

      def signatures(m):
          doc = json.loads(m.succeed("cat /boot/EFI/whombat/tpm2-pcr-signature.json"))
          return len(doc.get("sha256", []))

      # The driver's wait_for_console_text consumes one queued line per second; boots queue thousands.
      def drain(m):
          try:
              while True:
                  m.last_lines.get_nowait()
          except queue.Empty:
              pass

      def console(m, regex, timeout=600):
          buf, end = "", time.monotonic() + timeout
          while time.monotonic() < end:
              try:
                  while True:
                      buf += m.last_lines.get_nowait() + "\n"
              except queue.Empty:
                  pass
              mt = re.search(regex, buf)
              if mt:
                  print(f"console matched {regex!r}: {mt.group(0)!r}")
                  return mt.group(0)
              time.sleep(0.5)
          raise Exception(f"timed out after {timeout}s waiting for {regex!r} on the console")

      def reboot_to(m, regex, timeout=600):
          drain(m)
          # Reboot after the backdoor answered (a reboot during the reply corrupts it).
          m.succeed("systemd-run --on-active=2 systemctl reboot")
          m.connected = False
          console(m, regex, timeout)

      def boot_recovery(m):
          m.succeed("bootctl set-oneshot whombat-recovery.efi")
          reboot_to(m, "whombat-recovery: menu started", 900)

      def menu(m, chars, pause=3):
          m.send_chars(chars, delay=0.02)
          time.sleep(pause)

      with subtest("install onto a blank disk"):
          installer.start()
          installer.wait_for_unit("multi-user.target")
          print(installer.succeed(
              "whombat-install --disk /dev/disk/by-id/virtio-target --yes-erase-disk --root-size 7G 2>&1 | tail -5",
              timeout=1800,
          ))
          installer.succeed(f"nix-store --export $(nix-store -qR {cand}) > /dev/disk/by-id/virtio-xfer")
          installer.succeed("mkfs.ext4 -q -L EXPORT /dev/disk/by-id/virtio-export")
          installer.succeed("dd if=/dev/zero of=/dev/disk/by-id/virtio-scratch bs=1M count=16 && sync")
          installer.shutdown()
          state = str(installer.state_dir)
          os.environ["NIX_DISK_IMAGE"] = os.path.join(state, "empty0.qcow2")
          os.environ["WB_XFER_DISK"] = os.path.join(state, "empty1.qcow2")
          os.environ["WB_EXPORT_DISK"] = os.path.join(state, "empty2.qcow2")
          os.environ["WB_SCRATCH_DISK"] = os.path.join(state, "empty3.qcow2")

      with subtest("normal boot: root = PCR 7 + signed PCR 11, /persist also PCR 15 of the root volume"):
          target.start(allow_reboot=True)
          # Boot 1 (setup mode) generates and prepares the Secure Boot keys and reboots by itself.
          target.connect()
          reconnect(target)
          status = target.succeed("bootctl status 2>&1 || true")
          assert "Secure Boot: enabled (user)" in status, status
          target.wait_for_unit("whombat-tpm-seal.service")
          print(target.succeed("journalctl -b -u whombat-tpm-seal --no-pager | tail -20"))
          marker = target.succeed("cat /var/lib/whombat-storage/tpm-seal").strip()
          assert marker.startswith("v3 pcrs=7 signed-pcr11=") and "phase=enter-initrd" in marker and "persist-pcr15=" in marker, marker
          (root,) = tpm_tokens(target, "whombat-root")
          (pers,) = tpm_tokens(target, "whombat-persist")
          print("root token:", {k: v for k, v in root.items() if k != "tpm2-blob"})
          print("persist token:", {k: v for k, v in pers.items() if k != "tpm2-blob"})
          assert root["tpm2-pcrs"] == [7] and root.get("tpm2_pubkey_pcrs") == [11] and root.get("tpm2_pubkey"), root
          assert pers["tpm2-pcrs"] == [7, 15] and pers.get("tpm2_pubkey_pcrs") == [11], pers
          assert signatures(target) >= 1
          target.succeed("whombat-tpm-policy check /boot/EFI/whombat/tpm2-pcr-signature.json")
          target.succeed("whombat-tpm-policy check /boot/EFI/whombat/tpm2-pcr-signature.copy.json")
          assert signatures(target) == 1, "one generation, one key, one phase"
          # The recovery UKI is never part of the signed policy.
          target.succeed("test -e /boot/EFI/Linux/whombat-recovery.efi")
          # Only enter-initrd is signed (N-2): the running system cannot unseal either volume with the TPM.
          sc = "$(dirname $(readlink -f $(command -v systemd-cryptenroll)))/../lib/systemd/systemd-cryptsetup"
          for v in ["root", "persist"]:
              target.fail(f"{sc} attach probe-{v} /dev/disk/by-partlabel/whombat-{v} - tpm2-device=auto,headless=true,readonly,token-timeout=20")
          # Maintenance keys (root-only) open the volumes for re-enrolment.
          for v in ["root", "persist"]:
              target.succeed(f"test $(stat -c %a /var/lib/whombat-storage/maint-whombat-{v}.key) = 600")
          # The disk recovery key (what provisioning enrols; enrolled directly here: no control in this test).
          target.succeed(f"NEWPASSWORD='{key}' systemd-cryptenroll --unlock-key-file=/var/lib/whombat-storage/maint-whombat-root.key --password /dev/disk/by-partlabel/whombat-root")
          target.succeed(f"NEWPASSWORD='{key}' systemd-cryptenroll --unlock-key-file=/var/lib/whombat-storage/maint-whombat-persist.key --password /dev/disk/by-partlabel/whombat-persist")
          target.wait_for_unit("postgresql.service")
          target.succeed("mkdir -p /persist/whombat/home && echo RTPM-HOME-MARKER > /persist/whombat/home/rtpm-marker && sync")

      with subtest("update to a new generation: signed at install, unlocks without the recovery key"):
          before = signatures(target)
          target.succeed("nix-store --import < /dev/disk/by-id/virtio-xfer > /dev/null", timeout=900)
          target.succeed(f"nix-env --profile /nix/var/nix/profiles/system --set {cand}")
          target.succeed(f"{cand}/bin/switch-to-configuration boot")
          after = signatures(target)
          print(f"signed policy entries: {before} -> {after}")
          assert after > before, (before, after)
          reboot_to(target, "PERSIST-PROBE: opened")
          target.connect()
          assert current(target) == cand, current(target)
          target.succeed("findmnt -n -o SOURCE /persist | grep -q /dev/mapper/whombat-persist")
          target.succeed("grep -q RTPM-HOME-MARKER /persist/whombat/home/rtpm-marker")

      with subtest("a damaged signature document on the ESP: the second copy is used (N-6)"):
          target.succeed("truncate -s 40 /boot/EFI/whombat/tpm2-pcr-signature.json && sync")
          target.fail("whombat-tpm-policy check /boot/EFI/whombat/tpm2-pcr-signature.json")
          reboot_to(target, "PERSIST-PROBE: (not opened|opened)")
          console_log = "\n".join(target.full_console_log[-3000:])
          assert "PERSIST-PROBE: not opened" not in console_log, console_log[-4000:]
          target.connect()
          target.wait_for_unit("whombat-tpm-seal.service")
          target.succeed("whombat-tpm-policy check /boot/EFI/whombat/tpm2-pcr-signature.json")

      with subtest("recovery environment: the TPM releases neither disk key"):
          boot_recovery(target)
          console(target, "TPM-PROBE root: refused", 300)
          console(target, "TPM-PROBE persist: refused", 300)

      with subtest("recovery environment: no shell on tty2-tty6"):
          for n in range(2, 7):
              target.send_key(f"alt-f{n}")
              time.sleep(1)
              menu(target, "root\n", 1)
              menu(target, f"echo SHELL-ON-TTY{n} > /dev/disk/by-id/virtio-scratch; sync\n", 2)
          target.screenshot("recovery-tty6")
          target.send_key("alt-f1")
          time.sleep(2)
          target.screenshot("recovery-menu")

      with subtest("recovery menu: a wrong recovery key touches nothing"):
          menu(target, "1\n")
          menu(target, "not-the-recovery-key\n")
          console(target, "recovery key refused", 60)
          menu(target, "\n")

      with subtest("recovery menu: with the recovery key the export works"):
          menu(target, "1\n")
          menu(target, key + "\n")
          console(target, "recovery key accepted", 60)
          menu(target, "1\n")
          console(target, "attached disk .* mounted for the export", 60)
          menu(target, "n\n")
          console(target, "export (finished|failed)", 900)
          target.screenshot("recovery-export")
          console_log = "\n".join(target.full_console_log[-400:])
          assert "export finished" in console_log, console_log[-4000:]
          menu(target, "\n")
          drain(target)
          menu(target, "8\n", 1)
          console(target, "PERSIST-PROBE: opened")
          target.connect()
          target.succeed("mkdir -p /mnt/export && mount -o ro /dev/disk/by-id/virtio-export /mnt/export")
          print(target.succeed("ls -la /mnt/export /mnt/export/whombat-export-*"))
          target.succeed("grep -q RTPM-HOME-MARKER /mnt/export/whombat-export-*/files/home/rtpm-marker")
          target.succeed("test -s /mnt/export/whombat-export-*/database/whombat.pgdump")
          target.succeed("umount /mnt/export")
          scratch = target.succeed("head -c 4096 /dev/disk/by-id/virtio-scratch | tr -d '\\000'")
          assert "SHELL-ON-TTY" not in scratch, scratch

      with subtest("positive control: a PCR-7-only slot does unseal in the recovery environment"):
          target.succeed("systemd-cryptenroll --unlock-key-file=/var/lib/whombat-storage/maint-whombat-persist.key --tpm2-device=auto --tpm2-pcrs=7 /dev/disk/by-partlabel/whombat-persist")
          boot_recovery(target)
          console(target, "TPM-PROBE persist: UNSEALED", 300)
          drain(target)
          menu(target, "8\n", 1)
          console(target, "PERSIST-PROBE: opened")
          target.connect()
          legacy = [t for t in tpm_tokens(target, "whombat-persist") if not t.get("tpm2_pubkey")]
          assert len(legacy) == 1, legacy
          slot = legacy[0]["keyslots"][0]
          target.succeed(f"printf '%s' '{key}' | systemd-cryptenroll --unlock-key-file=/dev/stdin --wipe-slot={slot} /dev/disk/by-partlabel/whombat-persist")

      with subtest("a generation removed from the profile no longer unlocks (policy key rotated; N-1)"):
          stubs = target.succeed("ls /boot/EFI/Linux").split()
          old = [x for x in stubs if x.startswith("nixos-generation-1-") or x.startswith("nixos-generation-1.")]
          assert len(old) == 1, stubs
          fp_before = target.succeed("sha256sum /var/lib/whombat-storage/pcr-policy.pub.pem").split()[0]
          assert signatures(target) == 2, signatures(target)
          target.succeed("nix-env --profile /nix/var/nix/profiles/system --delete-generations 1")
          target.succeed("systemctl start whombat-tpm-reseal.service")
          print(target.succeed("journalctl -u whombat-tpm-reseal --no-pager | tail -20"))
          fp_after = target.succeed("sha256sum /var/lib/whombat-storage/pcr-policy.pub.pem").split()[0]
          assert fp_before != fp_after, "policy key not rotated"
          assert signatures(target) == 1, signatures(target)
          # The old stub is still on the ESP and still Secure-Boot-signed: booting it must not unlock.
          target.succeed(f"bootctl set-oneshot {old[0]}")
          reboot_to(target, "Kernel command line: init=" + re.escape(good) + "/init")  # the old generation boots
          # It must not open /persist (nor root): the next thing is the initrd giving up and the reboot into
          # the default (current) generation.
          got = console(target, "PERSIST-PROBE: opened|Kernel command line: init=" + re.escape(cand) + "/init", 900)
          assert got.startswith("Kernel command line"), "the removed generation unlocked the disks"
          boot_log = "\n".join(target.full_console_log[-6000:])
          assert re.search("No signature for current PCR policy|token does not apply to current boot state", boot_log), boot_log[-4000:]
          console(target, "PERSIST-PROBE: opened", 600)
          target.connect()
          assert current(target) == cand, current(target)

      with subtest("a swapped-in root volume does not get /persist"):
          target.shutdown()
          # The installer boots from its own image again (NIX_DISK_IMAGE pointed the target at the disk).
          target_disk = os.environ.pop("NIX_DISK_IMAGE")
          installer.start()
          installer.wait_for_unit("multi-user.target")
          # The attacker's root volume: their own LUKS volume, which the TPM opens (no PCRs), and any file system.
          installer.succeed(
              "printf attacker > /tmp/k",
              "cryptsetup luksFormat --type luks2 --batch-mode --key-file=/tmp/k /dev/disk/by-partlabel/whombat-root",
              "cryptsetup open --key-file=/tmp/k /dev/disk/by-partlabel/whombat-root attacker",
              "mkfs.ext4 -q /dev/mapper/attacker && cryptsetup close attacker",
              "systemd-cryptenroll --unlock-key-file=/tmp/k --tpm2-device=auto --tpm2-pcrs= /dev/disk/by-partlabel/whombat-root",
          )
          installer.shutdown()
          os.environ["NIX_DISK_IMAGE"] = target_disk
          target.start(allow_reboot=True)
          console(target, "PERSIST-PROBE: (not opened|opened)")
          console_log = "\n".join(target.full_console_log)
          assert "PERSIST-PROBE: not opened" in console_log, console_log[-4000:]
          target.crash()
    '';
}
