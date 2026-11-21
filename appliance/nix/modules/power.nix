# A laptop that behaves like an appliance, and its battery as a UPS (Whombat DK-10, DK-11; NX-165…NX-167).
#
# - Never suspends: a closed lid or a folded keyboard cover, the suspend and hibernate keys and an idle box do nothing,
#   and systemd won't suspend or hibernate at all. Holding the power button shuts down cleanly.
# - A short press of the power button: on a machine with a battery or a lid (a laptop, a tablet) it does nothing in
#   logind, so it reaches the kiosk as a key and only wakes the screen. Everywhere else (VMs, whose hypervisor's
#   “Shutdown” is often an ACPI power button press; desktops and mini PCs in a cupboard) it shuts down as before.
#   Decided at boot from the firmware's ACPI devices (`whombat-power-key`), before logind starts.
# - UPower shuts the box down cleanly when the batteries reach `shutdownAt` percent on battery (percentage policy, not
#   the time estimate). The manager reads the battery itself for HostNow.power (MG-69); the runtime tells people
#   (Whombat DK-S…).
# - Plugged in, the battery is held at `chargeLimit` percent where the firmware takes a limit
#   (`charge_control_end_threshold`: asus-wmi, thinkpad_acpi, dell, huawei, lg, msi, system76, …).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.power;
  inherit (lib) mkOption types;

  # The charge limit on every system battery that takes one.
  chargeLimit = pkgs.writeShellScript "whombat-charge-limit" ''
    for b in /sys/class/power_supply/*; do
      [ "$(cat "$b/type" 2>/dev/null)" = Battery ] || continue
      [ "$(cat "$b/scope" 2>/dev/null)" = Device ] && continue
      t="$b/charge_control_end_threshold"
      [ -w "$t" ] || continue
      if echo ${toString cfg.chargeLimit} > "$t"; then
        echo "''${b##*/}: charging stops at ${toString cfg.chargeLimit} % ($(cat "$t"))"
      else
        echo "''${b##*/}: the firmware refused a charge limit of ${toString cfg.chargeLimit} %"
      fi
    done
  '';

  # A laptop or a tablet: the firmware describes a battery (PNP0C0A) or a lid (PNP0C0D) that is present (_STA bit 0).
  # The ACPI namespace is there before any driver loads, so this can't race udev.
  powerKey = pkgs.writeShellScript "whombat-power-key" ''
    mobile=""
    for d in /sys/bus/acpi/devices/PNP0C0A:* /sys/bus/acpi/devices/PNP0C0D:*; do
      [ -e "$d" ] || continue
      st=$(cat "$d/status" 2>/dev/null || echo 15)
      [ $((st & 1)) = 1 ] && mobile="''${d##*/}"
    done
    conf=/run/systemd/logind.conf.d/50-whombat-power-key.conf
    if [ -n "$mobile" ]; then
      mkdir -p /run/systemd/logind.conf.d
      printf '[Login]\nHandlePowerKey=ignore\n' > "$conf"
      echo "a battery or a lid ($mobile): a short press of the power button only wakes the screen"
    else
      rm -f "$conf"
    fi
  '';
in
{
  options.whombat.power = {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = "The appliance's power behaviour (DK-10, DK-11): never suspend, the power button, the battery as a UPS.";
    };
    chargeLimit = mkOption {
      type = types.nullOr (types.ints.between 50 100);
      default = 80;
      description = ''
        Plugged in, batteries stop charging at this percentage where the firmware takes a limit
        (`charge_control_end_threshold`): a battery held at 100 % around the clock wears out. null leaves the
        firmware's own setting.
      '';
    };
    shutdownAt = mkOption {
      type = types.ints.between 3 50;
      default = 10;
      description = "On battery, UPower shuts the box down cleanly at this percentage (DK-10).";
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        services.logind.settings.Login = {
          HandleLidSwitch = "ignore";
          HandleLidSwitchExternalPower = "ignore";
          HandleLidSwitchDocked = "ignore";
          HandleSuspendKey = "ignore";
          HandleSuspendKeyLongPress = "ignore";
          HandleHibernateKey = "ignore";
          HandleHibernateKeyLongPress = "ignore";
          # Held (logind: 5 s): a clean shutdown, on every machine. A short press: see whombat-power-key.
          HandlePowerKeyLongPress = "poweroff";
          IdleAction = "ignore";
        };
        systemd.sleep.settings.Sleep = {
          AllowSuspend = "no";
          AllowHibernation = "no";
          AllowHybridSleep = "no";
          AllowSuspendThenHibernate = "no";
        };

        systemd.services.whombat-power-key = {
          description = "Let the power button wake the screen on a laptop or tablet";
          wantedBy = [ "multi-user.target" ];
          before = [ "systemd-logind.service" ];
          after = [ "systemd-tmpfiles-setup.service" ];
          unitConfig.DefaultDependencies = false;
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            ExecStart = powerKey;
          };
        };

        services.upower = {
          enable = true;
          usePercentageForPolicy = true;
          # Descending, or UPower falls back to its own defaults.
          percentageLow = cfg.shutdownAt + 10;
          percentageCritical = cfg.shutdownAt + 5;
          percentageAction = cfg.shutdownAt;
          criticalPowerAction = "PowerOff";
          # logind ignores the lid (above); UPower only reports it.
          ignoreLid = true;
        };
      }
      (lib.mkIf (cfg.chargeLimit != null) {
        # At boot (asus-wmi adds the threshold to the battery after the battery's own `add` event, so a udev rule alone
        # would miss it) and for a battery added later.
        systemd.services.whombat-charge-limit = {
          description = "Hold the battery at ${toString cfg.chargeLimit} % while plugged in";
          wantedBy = [ "multi-user.target" ];
          after = [ "systemd-udev-trigger.service" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            ExecStart = chargeLimit;
          };
        };
        services.udev.extraRules = ''
          ACTION=="add", SUBSYSTEM=="power_supply", ATTR{type}=="Battery", TEST=="charge_control_end_threshold", ATTR{charge_control_end_threshold}="${toString cfg.chargeLimit}"
        '';
      })
    ]
  );
}
