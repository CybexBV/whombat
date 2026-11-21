# The ISO on a dedicated machine (PI-21, PI-22; NX-189), as near as QEMU gets: the same self-installed image as
# install-vm, put on the disk by whombat-install, then booted the way a mini PC or an old desktop runs it, not a
# hypervisor's VM:
#   1. q35 + OVMF with Secure Boot in setup mode, no TPM, the disk on NVMe, an Intel network card (e1000e) getting its
#      address by DHCP, no i6300esb and no guest agent (virtio only for the test driver's own console and shares).
#   2. The chipset's watchdog (q35's ICH9 TCO, iTCO_wdt, as on an Intel board) is the only one, and PID 1 pets it.
#   3. A PID 1 that stops petting it is reset by it: the machine comes back by itself.
# What QEMU can't show about real machines (their firmware, graphics, network cards, power) is in
# docs/runbooks/hardware-qualification.md ("Dedicated machines").
#   4. How the owner reaches it (Whombat LNK-12): installed with the Link choice, reach.json on the disk.
#   5. The recovery menu the way the screen's footer says: Space at power-on opens the boot menu, then “Whombat Recovery”.
{
  applianceModules,
  lib,
  pkgs,
  recoveryProbeUki,
  ...
}:
{
  name = "whombat-install-machine";

  nodes = {
    target =
      { lib, pkgs, ... }:
      {
        imports = applianceModules ++ [
          ../nix/profiles/self-installed.nix
          ./common/manager-dev.nix
        ];
        whombat.environment = "dev";
        whombat.storage.persistReserveMiB = 64;
        whombat.boot = {
          tries = 2;
          assessmentTimeoutSec = 90;
          settleSec = 5;
          recoveryUki = recoveryProbeUki;
        };
        whombat.provisioning = {
          factoryMedium = false;
          selfRegister = true;
          selfFactoryRelease = "rt-fixture-1";
          selfSeedHelper = false;
        };
        whombat.runtime.watchdogSec = 10;
        whombat.slices.critical.memoryMin = "256M";
        whombat.postgres.sharedBuffers = "64MB";
        virtualisation = {
          directBoot.enable = false;
          mountHostNixStore = false;
          useDefaultFilesystems = false;
          fileSystems = lib.mkForce { };
          useEFIBoot = true;
          useSecureBoot = true;
          tpm.enable = false;
          memorySize = 3072;
          diskImage = null;
          # No test network: the one card is an Intel one on QEMU's own network, whose DHCP gives it 10.0.2.15.
          vlans = [ ];
          qemu.networkingOptions = lib.mkForce [
            "-netdev user,id=lan,restrict=on"
            "-device e1000e,netdev=lan"
          ];
          qemu.options = [
            ''-drive if=none,id=disk0,format=qcow2,file="$NIX_DISK_IMAGE"''
            "-device nvme,serial=WHOMBAT0,drive=disk0,bootindex=1"
          ];
        };
      };

    installer =
      { nodes, ... }:
      {
        imports = [ ../nix/profiles/installer-base.nix ];
        whombat.installer.system = nodes.target.system.build.toplevel;
        whombat.installer.recoveryUki = recoveryProbeUki;
        whombat.installer.rootSize = "7G";
        virtualisation.memorySize = 4096;
        virtualisation.useEFIBoot = true;
        virtualisation.emptyDiskImages = [
          {
            size = 131072;
            driveConfig.deviceExtraOpts.serial = "target";
          }
        ];
      };
  };

  testScript = ''
    import json
    import os
    import queue
    import re
    import time

    def sh(m, cmd):
        return m.succeed(cmd).strip()

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
                return mt.group(0)
            time.sleep(0.5)
        raise Exception(f"timed out after {timeout}s waiting for {regex!r} on the console")

    def watchdogs(m):
        return sh(m, "for w in /sys/class/watchdog/*; do echo \"$(cat $w/identity): $(cat $w/state)\"; done")

    with subtest("whombat-install puts the image on a blank disk"):
        installer.start()
        installer.wait_for_unit("multi-user.target")
        disk = sh(installer, "readlink -f /dev/disk/by-id/virtio-target")
        out = installer.succeed(f"whombat-install --disk {disk} --yes-erase-disk --reach link 2>&1", timeout=1800)
        assert "== blessing the factory generation" in out, out[-2000:]
        installer.succeed("sync")
        installer.shutdown()
        os.environ["NIX_DISK_IMAGE"] = os.path.join(str(installer.state_dir), "empty0.qcow2")

    with subtest("first boot on NVMe with an Intel network card: root found, an address by DHCP, no guest agent"):
        target.start(allow_reboot=True)
        target.wait_for_unit("multi-user.target")
        root = sh(target, "readlink -f /dev/disk/by-partlabel/whombat-root")
        assert root.startswith("/dev/nvme"), root
        assert sh(target, "findmnt -n -o SOURCE /") == root, root
        assert sh(target, "cat /etc/whombat/platform") == "self-installed host-encrypted"
        assert sh(target, "basename $(readlink -f /sys/class/net/eth0/device/driver)") == "e1000e"
        target.wait_until_succeeds("ip -4 -o addr show dev eth0 | grep -q ' 10.0.2.15/'", timeout=180)
        target.fail("systemctl is-active qemu-guest-agent.service")

    with subtest("the installer's reach choice is on the disk (LNK-12)"):
        # The manager acts on it at its start (manager/internal/daemon applyReach, and the loopback harness's
        # WB_MGD_REACH): this machine has no update repository, so its self-provisioning stops before the manager runs.
        reach = json.loads(sh(target, "cat /persist/whombat/reach.json"))
        assert reach["v"] == 1 and reach["seq"] == 1 and reach["by"] == "installer", reach
        assert reach["link"] is True and reach["tailscale"] is False, reach
        assert sh(target, "stat -c '%U %a' /persist/whombat/reach.json") == "root 644"

    with subtest("the chipset's watchdog is the only one, and PID 1 pets it"):
        dogs = watchdogs(target)
        print(dogs)
        assert dogs == "iTCO_wdt: active", dogs

    with subtest("a PID 1 that stops petting it is reset by it"):
        boot = sh(target, "cat /proc/sys/kernel/random/boot_id")
        # PID 1 lets go (it closes the device with the magic character), then a process opens it, pets it once and
        # closes it without: the watchdog keeps counting, as when the process holding it hangs, and resets the machine.
        target.succeed(
            "busctl set-property org.freedesktop.systemd1 /org/freedesktop/systemd1"
            " org.freedesktop.systemd1.Manager RuntimeWatchdogUSec t 0"
        )
        print(watchdogs(target))
        target.execute("echo 1 > /dev/watchdog0")
        target.connected = False
        target.connect()
        target.wait_for_unit("multi-user.target")
        assert sh(target, "cat /proc/sys/kernel/random/boot_id") != boot, "the machine wasn't reset"
        assert watchdogs(target) == "iTCO_wdt: active"

    with subtest("Space at power-on opens the boot menu, and Whombat Recovery in it the recovery menu"):
        # systemd-boot (its menu hidden, timeout 0) looks for a key for 100 ms before it boots the default entry; a real
        # keyboard repeats a held key, QEMU's doesn't, so Space is pressed every 50 ms from the restart on, well past
        # the firmware. A key in the open menu that isn't one of its own does nothing. Then the last entry (Whombat
        # Recovery sorts last, SORT_KEY=zz-whombat-recovery) and Enter: only an open menu gets there.
        drain(target)
        target.succeed("systemd-run --on-active=2 systemctl reboot")
        target.connected = False
        end = time.monotonic() + 75
        while time.monotonic() < end:
            target.send_monitor_command("sendkey spc 30")
            time.sleep(0.05)
        target.send_key("end")
        time.sleep(1)
        target.send_key("ret")
        console(target, "whombat-recovery: menu started", 600)
  '';
}
