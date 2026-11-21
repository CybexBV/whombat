# Stay unlocked while you're here (Whombat DK-28…DK-33; NX-280…): the camera on the box, for the desk display.
#
# - `whombat-presence` answers the runtime server on /run/whombat-presence/presence.sock (contracts' presence socket,
#   CT-597): while the runtime keeps watching (every 2 s while the screen is unlocked and the switch is on), it reads the
#   camera through `presence-watch` and says whether, and when, it last saw a face (YuNet, nix/packages/presence-model).
#   The camera is the child's: it runs only while watched and 6 s after, so when it exits the camera and its light go
#   off. It detects; it doesn't recognize, and no picture is kept or sent (DK-31).
# - The socket is systemd's (socket activation): 0660 whombat-presence:whombat, so the server (user `whombat`, its
#   primary group) connects and nothing else does; the service also checks the peer's uid (the server's and root's).
#   It starts at the first request and stays: a box whose screen nobody unlocks with the switch on runs only the socket.
# - Sandboxed as the voice service (no network at all, no capabilities, nothing of /persist, nothing writable), but with
#   the camera: video4linux devices only (DevicePolicy=closed), the `video` group, /sys/class/video4linux readable. The
#   camera is this service's alone: the kiosk's seat session gets no ACL on it (udev's `uaccess` tag is dropped).
# - The runtime server learns of it through WHOMBAT_PRESENCE_SOCKET (runtime.nix, `whombat.presence.socket`).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.presence;
  inherit (lib) mkOption types;
  ids = config.whombat.ids;
  socket = "/run/whombat-presence/presence.sock";
in
{
  options.whombat.presence = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        The camera for the desk display's “Stay unlocked while you're here” (Whombat DK-28, NX-280). On in the
        appliance profile; the runtime offers the switch only where the service has a camera and a working detector
        (its health says so), and turns the camera on only while the screen is unlocked with the switch on.
      '';
    };
    package = mkOption {
      type = types.package;
      default = pkgs.whombat-presence;
      defaultText = lib.literalExpression "pkgs.whombat-presence";
    };
    watch = mkOption {
      type = types.package;
      default = pkgs.presence-watch;
      defaultText = lib.literalExpression "pkgs.presence-watch";
      description = "bin/presence-watch, the camera and the detector (nix/packages/presence-engine, NX-281).";
    };
    model = mkOption {
      type = types.path;
      default = "${pkgs.presence-model}/${pkgs.presence-model.onnx}";
      defaultText = lib.literalExpression ''"''${pkgs.presence-model}/face_detection_yunet_2023mar.onnx"'';
      description = "The YuNet face detection model (face_detection_yunet_2023mar.onnx, NX-281).";
    };
    socket = mkOption {
      type = types.str;
      default = socket;
      readOnly = true;
      description = "The presence socket (WHOMBAT_PRESENCE_SOCKET of the runtime server), 0660 whombat-presence:whombat.";
    };
    memoryMax = mkOption {
      type = types.str;
      default = "256M";
      description = ''
        The service's memory cap with the camera program: the service peaks near 43 MiB and presence-watch near 60 MiB
        (NX-286).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # ---- The account (NX-08: fixed ids; it owns nothing anywhere, but a fixed uid keeps the peer check and the socket's
    # owner the same in every generation). The camera's group is the unit's (SupplementaryGroups), not the account's. ---
    users.users.whombat-presence = {
      isSystemUser = true;
      uid = ids.whombat-presence;
      group = "whombat-presence";
      home = "/var/empty";
      createHome = false;
      shell = "/run/current-system/sw/bin/nologin";
    };
    users.groups.whombat-presence.gid = ids.whombat-presence;

    # ---- The camera is this service's only (DK-31) --------------------------------------------------------------------
    # systemd tags video4linux nodes `uaccess`, which gives the active seat session an ACL on them: the kiosk's logind
    # session (kiosk.nix) could open the camera below its browser, whose policy alone blocks it. Dropped before
    # 73-seat-late.rules applies the tag; /dev/video* stay root:video 0660, and only this unit has the group.
    services.udev.packages = [
      (pkgs.writeTextFile {
        name = "whombat-camera-udev-rules";
        destination = "/lib/udev/rules.d/72-whombat-camera.rules";
        text = ''
          SUBSYSTEM=="video4linux", TAG-="uaccess"
        '';
      })
    ];

    # ---- The socket: the server's (its primary group), made by systemd so the service needs no group of its own ----
    systemd.sockets.whombat-presence = {
      description = "Whombat presence socket";
      wantedBy = [ "sockets.target" ];
      socketConfig = {
        ListenStream = socket;
        SocketUser = "whombat-presence";
        SocketGroup = "whombat";
        SocketMode = "0660";
        DirectoryMode = "0755";
        RemoveOnStop = true;
      };
    };

    systemd.services.whombat-presence = {
      description = "Whombat presence: whether someone is in front of the screen, from the camera";
      requires = [ "whombat-presence.socket" ];
      after = [ "whombat-presence.socket" ];
      serviceConfig = {
        Type = "notify";
        ExecStart = lib.escapeShellArgs [
          "${cfg.package}/bin/whombat-presence"
          "--socket"
          socket
          "--watch"
          "${cfg.watch}/bin/presence-watch"
          "--model"
          "${cfg.model}"
          "--allow-uid"
          "0,${toString ids.whombat}"
        ];
        Restart = "on-failure";
        RestartSec = "2s";
        # Stopping turns the camera off first (the service waits up to 2 s for its program to be gone).
        TimeoutStopSec = "10s";
        User = "whombat-presence";
        Group = "whombat-presence";

        # The camera, and only that: /dev/video* are root:video 0660 (udev), and the device policy lets in nothing but
        # video4linux nodes and the standard pseudo devices. /sys/class/video4linux stays readable (the probe's listing).
        PrivateDevices = false;
        DevicePolicy = "closed";
        DeviceAllow = [ "char-video4linux rw" ];
        SupplementaryGroups = [ "video" ];

        # No network: what the camera sees stays in the program's memory (DK-31).
        PrivateNetwork = true;
        IPAddressDeny = "any";
        RestrictAddressFamilies = [ "AF_UNIX" ];

        CapabilityBoundingSet = "";
        NoNewPrivileges = true;
        # Nothing writable at all, not even a /tmp: it writes nothing (DK-31).
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        # ONNX Runtime reads the processor's description in /proc, as in the voice service: no ProcSubset=pid.
        ProtectProc = "invisible";
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
        # ONNX Runtime may try to pin its thread (@resources): refused, not killed.
        SystemCallErrorNumber = "EPERM";
        UMask = "0077";

        # A cap and low weights, as voice's (NX-180): a check may wait a moment, the server and the database don't.
        MemoryMax = cfg.memoryMax;
        MemorySwapMax = "0";
        TasksMax = 64;
        CPUWeight = 20;
        IOWeight = 20;
      };
    };
  };
}
