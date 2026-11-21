# Boot: Secure Boot (lanzaboote), boot counting with a meaningful local blessing, watchdogs and
# known-good fallback (NX-04, NX-05, NX-11).
#
# Every new generation is written by lanzaboote as a UKI named ...+<tries>.efi. systemd-boot
# decrements the counter on each attempt and skips entries that reached +0-N, so the newest generation
# that was blessed (the known-good) boots next. A generation is blessed only when
# boot-complete.target is reached, and that requires whombat-boot-assessment.service: PostgreSQL
# accepting connections, the manager running without restarts, and the runtime's local /health "ok"
# for a settle period. Relay, control and providers are never part of it (MA-11).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.boot;
  systemd = config.systemd.package;
  loaderGuid = "4a67b082-0a4c-41cf-b6c7-440b29bb8c4f";
  countVar = "/sys/firmware/efi/efivars/LoaderBootCountPath-${loaderGuid}";
  inherit (lib) mkOption types;
  isx86 = pkgs.stdenv.hostPlatform.isx86_64;
  # modprobe's `install` hook for iTCO_wdt (NX-189): nothing where an i6300esb (8086:25ab) is on the PCI bus, else the
  # module as usual. Shell builtins only (udev's modprobe has no PATH to speak of).
  itcoUnlessEsb = pkgs.writeShellScript "whombat-itco-unless-i6300esb" ''
    for d in /sys/bus/pci/devices/*; do
      read -r vendor < "$d/vendor" || continue
      read -r device < "$d/device" || continue
      if [ "$vendor" = 0x8086 ] && [ "$device" = 0x25ab ]; then exit 0; fi
    done
    exec ${pkgs.kmod}/bin/modprobe --ignore-install iTCO_wdt "$@"
  '';

  assess = pkgs.writeShellApplication {
    name = "whombat-boot-assess";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.curl
      pkgs.jq
      systemd
    ];
    text = ''
      # Local blessing: every check must hold continuously for SETTLE seconds.
      settle=${toString cfg.settleSec}
      ok_since=""
      while :; do
        why=""
        [ "$(systemctl show -P ActiveState postgresql.service)" = active ] && [ -S /run/postgresql/.s.PGSQL.5432 ] \
          || why="postgres not running"
        if [ -z "$why" ]; then
          state=$(systemctl show -P ActiveState whombat-manager.service)
          restarts=$(systemctl show -P NRestarts whombat-manager.service)
          [ "$state" = active ] || why="manager $state"
          [ "$restarts" = 0 ] || why="manager restarted $restarts times"
        fi
        if [ -z "$why" ]; then
          # The runtime's own health includes a real query against PostgreSQL (checks.db).
          health=$(curl -sf --max-time 5 --unix-socket /run/whombat/admin.sock http://runtime/health || true)
          status=$(printf '%s' "$health" | jq -r '.status // empty' 2>/dev/null || true)
          db=$(printf '%s' "$health" | jq -r '.checks.db.ok // false' 2>/dev/null || true)
          [ "$status" = ok ] || why="runtime health '$status'"
          [ -n "$why" ] || [ "$db" = true ] || why="runtime cannot use the database"
        fi
        if [ -z "$why" ]; then
          for u in whombat-server.service whombat-runner.service postgresql.service; do
            [ "$(systemctl show -P NRestarts "$u")" = 0 ] || why="$u restarted"
          done
        fi
        now=$(date +%s)
        if [ -n "$why" ]; then
          [ -z "$ok_since" ] || echo "boot assessment: healthy period interrupted: $why"
          ok_since=""
        else
          [ -n "$ok_since" ] || { ok_since=$now; echo "boot assessment: healthy, settling ''${settle}s"; }
          if [ $((now - ok_since)) -ge "$settle" ]; then
            echo "boot assessment: passed"
            exit 0
          fi
        fi
        sleep 2
      done
    '';
  };
in
{
  options.whombat.boot = {
    tries = mkOption {
      type = types.ints.between 1 10;
      default = 3;
      description = "Boot attempts a new generation gets before systemd-boot skips it (NX-05).";
    };
    assessmentTimeoutSec = mkOption {
      type = types.int;
      default = 900;
      description = "A boot that isn't healthy this long after reaching multi-user is failed.";
    };
    settleSec = mkOption {
      type = types.int;
      default = 60;
      description = "Health must hold without interruption this long before blessing.";
    };
    rebootOnFailedAssessment = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Reboot when the assessment fails on a counted (not yet blessed) entry, so the next attempt or
        the known-good generation follows without waiting for a human. Never on a blessed entry.
      '';
    };
    runtimeWatchdogSec = mkOption {
      type = types.str;
      default = "30s";
      description = "Hardware watchdog petted by PID 1; a hung kernel/PID 1 resets the device.";
    };
    configurationLimit = mkOption {
      type = types.int;
      default = 8;
      description = ''
        Generations kept on the ESP. The manager must delete failed candidates' generations so a run
        of bad candidates can never push the known-good generation out (NX-05).
      '';
    };
    pkiBundle = mkOption {
      type = types.str;
      default = "/var/lib/sbctl";
      description = ''
        Per-device Secure Boot keys (PK/KEK/db), generated on the device by the installer and kept
        on the encrypted root, root-only (NX-11). No fleet-wide signing key exists on any device.
      '';
    };
    recoveryUki = mkOption {
      type = types.nullOr types.package;
      default = null;
      description = ''
        The recovery environment UKI (NX-13). Installed as EFI/Linux/whombat-recovery.efi and signed
        with the device's db key on every boot where it changed (lanzaboote leaves non-nixos-* files
        in EFI/Linux alone).
      '';
    };
    lzbtPackage = mkOption {
      type = types.nullOr types.package;
      default = null;
      description = ''
        lanzaboote's lzbt (the flake passes lanzaboote.packages.<system>.lzbt). With LUKS storage it is
        wrapped so every boot-loader install also signs the PCR 11 policy of the installed generations
        (storage.nix, MA-21b).
      '';
    };
    secureBoot.autoEnroll = mkOption {
      type = types.bool;
      default = config.whombat.platform == "factory";
      defaultText = lib.literalExpression ''config.whombat.platform == "factory"'';
      description = ''
        Let systemd-boot enrol the device keys while the firmware is in setup mode (factory). Off on
        self-installed (PI-02, NX-52): the keys are generated and sign every generation, but the firmware keeps
        Secure Boot off, so a firmware reset, a new mainboard or a moved VM never locks the appliance out; boot
        counting doesn't need it.
      '';
    };
  };

  config = {
    # Host updates are `switch-to-configuration boot` by the update helper (MA-11 class 2).
    system.switch.enable = true;
    boot.loader.systemd-boot.enable = lib.mkForce false;
    boot.loader.grub.enable = false;
    boot.loader.efi.canTouchEfiVariables = false; # boots via the removable path; no NVRAM writes
    boot.loader.timeout = 0; # hold Space at power-on for the menu (recovery, NX-13)

    boot.lanzaboote = {
      enable = true;
      pkiBundle = cfg.pkiBundle;
      bootCounting.initialTries = cfg.tries;
      configurationLimit = cfg.configurationLimit;
      autoGenerateKeys.enable = true; # only if the installer did not (dev images)
      autoEnrollKeys = lib.mkIf cfg.secureBoot.autoEnroll {
        enable = true;
        autoReboot = true;
        includeMicrosoftKeys = true; # option ROMs; PCR 7 still distinguishes our db cert (NX-12)
      };
      settings = {
        editor = false; # no kernel command line editing at the console
        timeout = 0;
        auto-entries = false;
        auto-firmware = false;
        console-mode = "keep";
      };
    };

    # The hardware watchdogs (NX-189), on every x86_64 platform: the chipset's own on a machine of its own (Intel TCO;
    # AMD's SP5100/FCH TCO loads by its PCI id), the i6300esb a VM is given (PI-09). Where an i6300esb is on the PCI bus
    # the Intel TCO stays unloaded: q35's ICH9 has one too, and the i6300esb, whose action the hypervisor sets, must be
    # the only watchdog. A q35 VM without an i6300esb uses its TCO. Both modules load without their device.
    boot.kernelModules = lib.optionals isx86 [
      "i6300esb"
      "iTCO_wdt"
    ];
    boot.extraModprobeConfig = lib.optionalString isx86 ''
      install iTCO_wdt ${itcoUnlessEsb} $CMDLINE_OPTS
    '';

    # Panics reboot; a hung kernel or PID 1 is reset by the hardware watchdog.
    boot.kernelParams = [
      "panic=10"
      "oops=panic"
    ];
    systemd.settings.Manager = {
      RuntimeWatchdogSec = cfg.runtimeWatchdogSec;
      RebootWatchdogSec = "10min";
    };
    boot.initrd.systemd.settings.Manager.RuntimeWatchdogSec = cfg.runtimeWatchdogSec;
    # In the initrd, a failure (e.g. no key for /persist after the password timeout) reboots instead
    # of waiting at an emergency shell nobody can use; boot counting then moves on.
    boot.initrd.systemd.services.emergency.serviceConfig.ExecStart = lib.mkForce [
      ""
      "${systemd}/bin/systemctl --no-block reboot"
    ];
    boot.initrd.luks.devices = lib.mkIf (config.whombat.storage.mode == "luks-tpm2") {
      whombat-root.crypttabExtraOpts = [ "timeout=300" ];
      whombat-persist.crypttabExtraOpts = [ "timeout=300" ];
    };

    systemd.services.whombat-recovery-install = lib.mkIf (cfg.recoveryUki != null) {
      description = "Install and sign the Whombat recovery environment on the ESP";
      wantedBy = [ "multi-user.target" ];
      after = [
        "generate-sb-keys.service"
        "boot.mount"
      ];
      unitConfig.RequiresMountsFor = [ "/boot" ];
      path = [
        pkgs.coreutils
        pkgs.diffutils
        pkgs.sbsigntool
      ];
      serviceConfig.Type = "oneshot";
      script = ''
        set -eu
        src=${cfg.recoveryUki}
        dst=/boot/EFI/Linux/whombat-recovery.efi
        marker=/boot/EFI/Linux/.whombat-recovery.source
        key=${cfg.pkiBundle}/keys/db/db.key
        cert=${cfg.pkiBundle}/keys/db/db.pem
        state="$src"
        [ -e "$key" ] && state="$src signed"
        if [ "$(cat $marker 2>/dev/null || true)" = "$state" ] && [ -e "$dst" ]; then exit 0; fi
        mkdir -p /boot/EFI/Linux
        rm -f "$dst.tmp"
        # The UKI is over half the ESP: a second copy next to the installed one doesn't fit, and sbsign then
        # left a truncated file that was renamed into place (NX-64). Make room first when needed: the old copy
        # is rebuilt from the store right here, and the marker only says "done" after a verified rename.
        need=$(( $(stat -c %s "$src") / 1024 + 1024 ))
        free=$(df -k --output=avail /boot | tail -n1 | tr -d ' ')
        if [ -e "$dst" ] && [ "$free" -lt "$need" ]; then
          rm -f "$marker" "$dst"
          sync
        fi
        if [ -e "$key" ]; then
          sbsign --key "$key" --cert "$cert" --output "$dst.tmp" "$src"
          sbverify --cert "$cert" "$dst.tmp" >/dev/null
        else
          cp "$src" "$dst.tmp"
          cmp -s "$src" "$dst.tmp"
        fi
        sync "$dst.tmp" && mv "$dst.tmp" "$dst"
        sync /boot/EFI/Linux
        echo "$state" > $marker
      '';
    };

    # ---- Local blessing ------------------------------------------------------------------------
    systemd.services.whombat-boot-assessment = {
      description = "Whombat boot assessment (local health before blessing)";
      # Runs on every boot. DefaultDependencies=no avoids the implicit multi-user.target ordering
      # (it runs after multi-user.target); it pulls in boot-complete.target, which requires it.
      wantedBy = [ "multi-user.target" ];
      wants = [ "boot-complete.target" ];
      requiredBy = [ "boot-complete.target" ];
      before = [
        "boot-complete.target"
        "shutdown.target"
      ];
      conflicts = [ "shutdown.target" ];
      after = [
        "basic.target"
        "multi-user.target"
        "whombat-runtime.target"
        "whombat-manager.service"
        "postgresql.service"
      ];
      unitConfig = {
        DefaultDependencies = false;
        OnFailure = [ "whombat-boot-failed.service" ];
        # Unprovisioned devices run nothing to assess (the factory generation is pre-blessed).
        ConditionPathExists = "${config.whombat.persistDir}/identity/device.json";
      };
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = "whombat-manager";
        Group = "whombat-manager";
        SupplementaryGroups = [ "whombat-admin" ];
        ExecStart = lib.getExe assess;
        TimeoutStartSec = cfg.assessmentTimeoutSec;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        PrivateTmp = true;
      };
    };

    systemd.services.whombat-boot-failed = {
      description = "Handle a failed Whombat boot assessment";
      serviceConfig.Type = "oneshot";
      path = [
        systemd
        pkgs.coreutils
      ];
      script = ''
        if [ -e ${countVar} ]; then
          echo "boot assessment failed on counted entry $(tail -c +5 ${countVar} | tr -d '\0')" >&2
          ${
            if cfg.rebootOnFailedAssessment then
              ''
                echo "rebooting so boot counting can proceed" >&2
                systemctl --no-block reboot
              ''
            else
              "true"
          }
        else
          echo "boot assessment failed on a blessed entry; not rebooting (the manager decides)" >&2
        fi
      '';
    };
  };
}
