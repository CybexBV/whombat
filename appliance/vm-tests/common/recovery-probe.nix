# VM tests only (recovery-tpm): the recovery environment with its kernel log on the serial console (so the
# test reads the menu's audit lines) and a probe that does at boot what an attacker with a shell there
# would try (W4-SEC part 2, C-1): load the device's PCR signature from the ESP and ask the TPM for both
# disk keys. It changes nothing else; the production UKI has neither.
{
  config,
  lib,
  pkgs,
  ...
}:
{
  # After the profile's "quiet" (which would lower the console log level again).
  boot.kernelParams = lib.mkAfter [
    "console=ttyS0,115200"
    "loglevel=7"
    "systemd.journald.forward_to_console=1"
  ];
  # NixOS applies boot.consoleLogLevel as kernel.printk at boot: raise it so the menu's audit lines
  # (level 5) reach the serial console.
  boot.consoleLogLevel = 7;
  systemd.services.whombat-tpm-probe = {
    wantedBy = [ "multi-user.target" ];
    after = [
      "local-fs.target"
      "tpm2.target"
    ];
    path = [
      pkgs.coreutils
      pkgs.util-linux
    ];
    serviceConfig.Type = "oneshot";
    script = ''
      mkdir -p /run/probe-esp /run/systemd
      # The disk can be probed after this unit starts (NX-89): a missing partition would read as "refused" and make
      # the negative checks pass for the wrong reason. Wait for all three, up to a minute.
      for _ in $(seq 120); do
        [ -e /dev/disk/by-partlabel/whombat-esp ] && [ -e /dev/disk/by-partlabel/whombat-root ] \
          && [ -e /dev/disk/by-partlabel/whombat-persist ] && break
        sleep 0.5
      done
      if mount -o ro /dev/disk/by-partlabel/whombat-esp /run/probe-esp; then
        cp /run/probe-esp/EFI/whombat/tpm2-pcr-signature.json /run/systemd/ || true
        umount /run/probe-esp
      fi
      for v in root persist; do
        if ${config.systemd.package}/lib/systemd/systemd-cryptsetup attach probe-$v /dev/disk/by-partlabel/whombat-$v - \
             tpm2-device=auto,headless=true,token-timeout=30,readonly; then
          echo "<3>TPM-PROBE $v: UNSEALED" > /dev/kmsg
          ${config.systemd.package}/lib/systemd/systemd-cryptsetup detach probe-$v || true
        else
          echo "<3>TPM-PROBE $v: refused" > /dev/kmsg
        fi
      done
    '';
  };
}
