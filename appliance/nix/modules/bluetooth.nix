# Bluetooth on the box (Whombat BT-01…BT-10; NX-350…): BlueZ for keyboards, mice, speakers, headphones, headsets and
# game controllers, paired from the app or the box's screen through `whombat-bluetooth`.
#
# - BlueZ (`hardware.bluetooth`): every adapter powered at start and never discoverable (nothing here makes it so),
#   pairable only while an agent is registered (`AlwaysPairable=false`, BlueZ's default made explicit), and the only
#   agent is whombat-bluetooth's, registered while a pairing an owner started runs (BT-03); a paired device can't be
#   paired again without a code (`JustWorksRepairing=never`); classic keyboards and mice only once bonded
#   (`ClassicBondedOnly`). Paired devices are trusted and come back by themselves (BT-05); `FastConnectable` lets them
#   in quickly. Its state is BlueZ's own (/var/lib/bluetooth, root only, on the system volume, not in backups); a
#   factory reset empties it (NX-247's place).
# - Only whombat-bluetooth, root and the sound server reach BlueZ (BT-09): BlueZ's own D-Bus policy lets every local
#   user call it; ours, read after it, denies that by default and lets in those three users (`whombat-bluetooth.conf`).
# - `whombat-bluetooth` answers the runtime server on /run/whombat-bluetooth/bluetooth.sock (contracts' Bluetooth
#   socket, CT-670…): socket-activated, its own user, no network, nothing writable. It doesn't ask BlueZ when the kernel
#   has no controller, so bluetoothd starts only with an adapter (udev's bluetooth.target) or the sound server's ask.
# - Wi-Fi's twin at every start (`whombat-bluetooth-on`, NX-342): a radio switched off by a laptop's key comes back.
# - Sound (sound.nix): with the sound server, WirePlumber's Bluetooth monitor plays to speakers and headphones and
#   listens with headsets (BT-06).
# - The runtime server learns of it through WHOMBAT_BLUETOOTH_SOCKET (runtime.nix, `whombat.bluetooth.socket`).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.bluetooth;
  inherit (lib) mkOption types;
  ids = config.whombat.ids;
  socket = "/run/whombat-bluetooth/bluetooth.sock";
  # Users that may call BlueZ, and get its signals (BT-09). The kiosk's browser, the agent and its containers are none.
  users = [
    "root"
    "whombat-bluetooth"
  ]
  ++ lib.optional config.whombat.sound.enable "pipewire";
  policy = pkgs.writeTextDir "share/dbus-1/system.d/whombat-bluetooth.conf" ''
    <!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
     "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
    <!-- Whombat (BT-09, NX-351): only these users reach BlueZ. Read after BlueZ's bluetooth.conf, whose default
         policy lets everyone call it; user policies come after every default one. -->
    <busconfig>
      <policy context="default">
        <deny send_destination="org.bluez"/>
        <deny receive_sender="org.bluez"/>
      </policy>
    ${lib.concatMapStrings (u: ''
      <policy user="${u}">
        <allow send_destination="org.bluez"/>
        <allow receive_sender="org.bluez"/>
      </policy>
    '') users}</busconfig>
  '';
in
{
  options.whombat.bluetooth = {
    enable = mkOption {
      type = types.bool;
      default = config.whombat.kiosk.desk or false;
      defaultText = lib.literalExpression "config.whombat.kiosk.desk";
      description = ''
        Bluetooth keyboards, mice, speakers, headphones, headsets and game controllers (Whombat BT-01, NX-350): BlueZ and
        the Bluetooth service the runtime pairs them through. On with the desk display, like the sound server.
      '';
    };
    package = mkOption {
      type = types.package;
      default = pkgs.whombat-bluetooth;
      defaultText = lib.literalExpression "pkgs.whombat-bluetooth";
    };
    socket = mkOption {
      type = types.str;
      default = socket;
      readOnly = true;
      description = "The Bluetooth socket (WHOMBAT_BLUETOOTH_SOCKET of the runtime server), 0660 whombat-bluetooth:whombat.";
    };
    dbusUsers = mkOption {
      type = types.listOf types.str;
      default = users;
      readOnly = true;
      description = "The users the D-Bus policy lets reach BlueZ (BT-09).";
    };
  };

  config = lib.mkIf cfg.enable {
    hardware.bluetooth = {
      enable = true;
      powerOnBoot = true;
      settings = {
        General = {
          AlwaysPairable = false;
          JustWorksRepairing = "never";
          FastConnectable = true;
        };
        # Trusted devices that drop (out of range, a speaker switched off and on) are called back: BlueZ's 7 tries.
        Policy.ReconnectAttempts = 7;
      };
      input.General.ClassicBondedOnly = true;
    };
    # After BlueZ's own policy (services.dbus.packages' order is the include order).
    services.dbus.packages = lib.mkAfter [ policy ];

    # A Whombat has no airplane mode (as Wi-Fi, NX-342): Bluetooth switched off by a laptop's wireless key, and the
    # state systemd-rfkill kept of it, is switched on again at every start. A hardware switch stays as it is (the state
    # then says `disabled`).
    systemd.services.whombat-bluetooth-on = {
      description = "Switch Bluetooth on";
      wantedBy = [ "multi-user.target" ];
      after = [ "systemd-rfkill.service" ];
      before = [ "bluetooth.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${pkgs.util-linux}/bin/rfkill unblock bluetooth";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        DevicePolicy = "closed";
        DeviceAllow = [ "/dev/rfkill rw" ];
      };
    };

    # ---- The account (NX-08: fixed ids; the socket's owner and the D-Bus policy's user the same in every generation).
    users.users.whombat-bluetooth = {
      isSystemUser = true;
      uid = ids.whombat-bluetooth;
      group = "whombat-bluetooth";
      home = "/var/empty";
      createHome = false;
      shell = "/run/current-system/sw/bin/nologin";
    };
    users.groups.whombat-bluetooth.gid = ids.whombat-bluetooth;

    # ---- The socket: the server's (its primary group), made by systemd -----------------------------------------------
    systemd.sockets.whombat-bluetooth = {
      description = "Whombat Bluetooth socket";
      wantedBy = [ "sockets.target" ];
      socketConfig = {
        ListenStream = socket;
        SocketUser = "whombat-bluetooth";
        SocketGroup = "whombat";
        SocketMode = "0660";
        DirectoryMode = "0755";
        RemoveOnStop = true;
      };
    };

    systemd.services.whombat-bluetooth = {
      description = "Whombat Bluetooth: pairing keyboards, mice, speakers and headphones, for the runtime";
      requires = [ "whombat-bluetooth.socket" ];
      after = [ "whombat-bluetooth.socket" ];
      serviceConfig = {
        Type = "notify";
        ExecStart = lib.escapeShellArgs [
          "${cfg.package}/bin/whombat-bluetooth"
          "--socket"
          socket
          "--allow-uid"
          "0,${toString ids.whombat}"
        ];
        Restart = "on-failure";
        RestartSec = "2s";
        TimeoutStopSec = "10s";
        User = "whombat-bluetooth";
        Group = "whombat-bluetooth";

        # BlueZ is on the system bus (a path socket: it works without a network); /sys is read for the controllers.
        PrivateNetwork = true;
        IPAddressDeny = "any";
        RestrictAddressFamilies = [ "AF_UNIX" ];
        PrivateDevices = true;

        CapabilityBoundingSet = "";
        NoNewPrivileges = true;
        # Nothing writable: pairings are BlueZ's (BT-08).
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        ProcSubset = "pid";
        InaccessiblePaths = [ "-${config.whombat.persistDir}" ];
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        RestrictNamespaces = true;
        RemoveIPC = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged @resources"
        ];
        UMask = "0077";

        MemoryMax = "64M";
        MemorySwapMax = "0";
        TasksMax = 32;
        CPUWeight = 20;
        IOWeight = 20;
      };
    };

    # Speakers, headphones and headsets through the sound server (sound.nix, BT-06).
    whombat.sound.bluetooth = config.whombat.sound.enable;
  };
}
