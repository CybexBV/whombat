# The local console on tty1 (CC-08, NX-32). whombat-console draws the claim code and the claim state from
# the file the runtime writes (WHOMBAT_CONSOLE_FILE); it has no credential and no network. tty1 has no getty;
# the other VTs keep the banner (NX-10). Hardware-qualification builds keep their root shell on tty1 instead
# (whombat.qualification.consoleShell). The console writes nothing; it reads tty1's keyboard only to drop the key
# presses (no recovery key screen since CG-31, NX-90).
#
# File permissions: /run/whombat is 2751 whombat:whombat-admin (runtime.nix) and stays so. The state file
# lives in its own directory /run/whombat/console, 2750 whombat:whombat-console: only the runtime writes
# there, the setgid bit gives every file it creates the group whombat-console, and the runtime writes the
# file 0640 (explicit chmod: its UMask is 0077). The console user is in no other group, so it can read
# this one file and nothing else of the runtime's (/run/whombat is not listable for it).
#
# Graphical console (CG-01…CG-05, NX-78, NX-82; `whombat.console.gui`, default on): the same program serves the web
# app and the Console API (`whombat-console --serve`, unit whombat-console-server) as the same user with the same
# files, in a network namespace of its own (PrivateNetwork=); the kiosk (kiosk.nix: cage + Chromium as whombat-kiosk)
# joins that namespace and shows the page on tty1. Its token goes to /run/whombat-console-ui/token (2750
# whombat-console:whombat-kiosk, file 0640). The text console stays as it is and takes tty1 when the kiosk can't
# (no DRM device within 15 s, or three failed starts: OnFailure=); `gui = false` keeps the text console only. On a
# claimed box the kiosk sleeps after `sleepAfterSec` without input (Chromium stops, the screen is black; NX-147).
#
# The desk display (Whombat DK-01…DK-12, NX-160…NX-164): the runtime opens `deskSocket` in the console's directory
# (0660, group whombat-console by the directory's setgid bit) and the graphical console's server dials it
# (`--desk-socket`, the peer must be the runtime's uid): `desk` in the Console API and the page's few desk requests. The
# text console dials it for one thing only: new claim letters when someone presses N at the box (Whombat
# whombat-link.md), so its one address family is AF_UNIX. The kiosk may use the microphone and the speakers for the
# page, through the sound server (sound.nix, PipeWire, NX-255), and follows the desk's quiet hours (kiosk.nix `desk`);
# it draws in software (`whombat.kiosk.gpu` off, NX-169).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.console;
  inherit (lib) mkOption types;
  dir = "/run/whombat/console";
  deskSocket = "${dir}/desk.sock";
  tokenDir = "/run/whombat-console-ui";
  gui = cfg.enable && cfg.gui;
  # The starting screen says why the first start can't finish when the provisioning unit wrote that (CG-409, NX-526).
  serverArgs = "--file ${cfg.file} --footer-file ${bannerFile} --start-file ${config.whombat.provisioning.startProblemFile}";
  bannerFile = pkgs.writeText "whombat-console-banner" cfg.banner;
in
{
  options.whombat.console = {
    enable = mkOption {
      type = types.bool;
      default = !config.whombat.qualification.consoleShell;
      defaultText = lib.literalExpression "!config.whombat.qualification.consoleShell";
      description = "Show the claim code and claim state on tty1 (whombat-console) instead of a getty.";
    };
    package = mkOption {
      type = types.package;
      default = pkgs.whombat-console;
      defaultText = lib.literalExpression "pkgs.whombat-console";
    };
    file = mkOption {
      type = types.str;
      default = "${dir}/console.json";
      readOnly = true;
      description = "The console state file (WHOMBAT_CONSOLE_FILE of the server, CC-08).";
    };
    deskSocket = mkOption {
      type = types.str;
      default = deskSocket;
      readOnly = true;
      description = ''
        The runtime's desk socket (WHOMBAT_DESK_SOCKET, contracts DESK_SOCKET_DEFAULT; Whombat DK-12): the graphical
        console's server is its only client.
      '';
    };
    banner = mkOption {
      type = types.str;
      # Only an encrypted disk has a recovery key (the factory's card); a self-installed box has none (PI-19).
      default = ''
        Whombat appliance. There is no login on this console.
        For local recovery, restart and hold Space to open the boot menu, then choose
        "Whombat Recovery"${
          lib.optionalString (config.whombat.storage.mode == "luks-tpm2") " (you will need your disk recovery key)"
        }.
      '';
      defaultText = lib.literalMD "the banner; on `luks-tpm2` storage it names the disk recovery key";
      description = ''
        The getty banner of the VTs (services.getty.helpLine) and the footer of the tty1 console. The
        console's built-in default is the `luks-tpm2` text (console/internal/screen Banner; checks.console).
      '';
    };
    gui = mkOption {
      type = types.bool;
      default = true;
      description = ''
        The graphical console (CG-01…CG-05): a kiosk (cage + Chromium) on tty1 showing the web app of `uiPackage`,
        served by `whombat-console --serve` in a network namespace only the kiosk joins. The text console takes tty1
        when there is no display or the kiosk keeps failing. false: the text console only (qualification builds,
        tests that read tty1 as text).
      '';
    };
    uiPackage = mkOption {
      type = types.package;
      default = pkgs.whombat-console-ui;
      defaultText = lib.literalExpression "pkgs.whombat-console-ui";
      description = "The web app (console/ui, CG-02): `share/whombat-console-ui/index.html`.";
    };
    sleepAfterSec = mkOption {
      type = types.nullOr types.ints.positive;
      default = 600;
      description = ''
        The graphical console sleeps on a claimed box (NX-147, CG-36): after this long without a key press, pointer
        movement or touch, Chromium stops and the screen is black until the next input. Never while the box isn't
        claimed. null: never.
      '';
    };
    guiPort = mkOption {
      type = types.port;
      default = 8411;
      description = "The graphical console's port on its private loopback.";
    };
    font = mkOption {
      type = types.nullOr types.str;
      default = "ter-v32b";
      description = ''
        Console font (Terminus, 16×32 bold): the claim code is read from a distance. Any `ter-*` name works; null
        keeps the kernel's font.
      '';
    };
  };

  config = lib.mkMerge [
    {
      # The directory exists whether or not the console is shown: the runtime always writes its state.
      systemd.tmpfiles.settings."21-whombat-console" = {
        ${dir}.d = {
          mode = "2750";
          user = "whombat";
          group = "whombat-console";
        };
      };
    }
    (lib.mkIf cfg.enable {
      console = lib.mkIf (cfg.font != null) {
        font = cfg.font;
        packages = [ pkgs.terminus_font ];
      };

      # Nothing but the console draws on tty1 once it runs (NX-74, NX-72): the console redraws only once a minute,
      # so a status line from PID 1 or a kernel message would cover the claim code at first boot until then. PID 1 shows only failures (in the initrd too; its prompts are not status lines), and the kernel
      # prints only critical messages to the console (loglevel 3: emerg, alert, crit). Everything stays in the
      # journal. (mkDefault: the VM tests' instrumentation keeps its verbose serial console.)
      boot.kernelParams = [ "systemd.show_status=error" ];
      boot.consoleLogLevel = lib.mkDefault 3;

      # No getty on tty1: getty.target would pull autovt@tty1 in (NixOS getty module), and a masked
      # unit keeps switch-to-configuration and logind from starting one over the console.
      systemd.targets.getty.wants = lib.mkForce [ ];
      systemd.services."getty@tty1".enable = false;
      systemd.services."autovt@tty1".enable = false;

      systemd.services.whombat-console = {
        description = "Whombat console (claim code on tty1)";
        # With the graphical console this is its fallback, started by the kiosk's OnFailure= only.
        wantedBy = lib.optional (!gui) "multi-user.target";
        after = [
          "systemd-vconsole-setup.service"
          "systemd-tmpfiles-setup.service"
          "systemd-user-sessions.service"
          "plymouth-quit-wait.service"
        ];
        conflicts = [
          "getty@tty1.service"
          "autovt@tty1.service"
        ]
        ++ lib.optional gui "whombat-kiosk.service";
        serviceConfig = {
          # The desk socket: N on the claim screen asks the runtime for new letters; nothing else is sent there.
          ExecStart = "${cfg.package}/bin/whombat-console ${serverArgs} --desk-socket ${deskSocket} --desk-peer-uid ${toString config.whombat.ids.whombat}";
          User = "whombat-console";
          Group = "whombat-console";
          # tty1's keyboard: read and dropped, so key presses never show up on the console (NX-90).
          StandardInput = "tty-force";
          StandardOutput = "tty";
          StandardError = "journal";
          TTYPath = "/dev/tty1";
          TTYReset = true;
          TTYVHangup = true;
          TTYVTDisallocate = true;
          Restart = "always";
          RestartSec = 1;
          # Nothing but reading two files and the already opened tty.
          NoNewPrivileges = true;
          ProtectSystem = "strict";
          ProtectHome = true;
          PrivateTmp = true;
          # systemd opens the tty before the private /dev exists, under the device policy PrivateDevices
          # implies (closed): tty1 is the one device let through.
          PrivateDevices = true;
          DeviceAllow = [ "/dev/tty1 rw" ];
          PrivateNetwork = true;
          IPAddressDeny = "any";
          # The runtime's desk socket, a path on /run: no IP, no netlink.
          RestrictAddressFamilies = [ "AF_UNIX" ];
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectKernelLogs = true;
          ProtectControlGroups = true;
          ProtectClock = true;
          ProtectHostname = true;
          ProtectProc = "invisible";
          ProcSubset = "pid";
          LockPersonality = true;
          MemoryDenyWriteExecute = true;
          RestrictRealtime = true;
          RestrictSUIDSGID = true;
          RestrictNamespaces = true;
          RemoveIPC = true;
          UMask = "0077";
          CapabilityBoundingSet = "";
          AmbientCapabilities = "";
          SystemCallArchitectures = "native";
          SystemCallFilter = [
            "@system-service"
            "~@privileged @resources"
          ];
          LimitCORE = 0;
        };
      };
    })

    (lib.mkIf gui {
      # The graphical console's server: the text console's program, user, files and hardening, without a tty, with a
      # loopback of its own (PrivateNetwork=) that only the kiosk joins.
      systemd.services.whombat-console-server = {
        description = "Whombat console server (the graphical console's page and API)";
        wantedBy = [ "multi-user.target" ];
        after = [ "systemd-tmpfiles-setup.service" ];
        serviceConfig = {
          Type = "notify";
          NotifyAccess = "main";
          ExecStart = lib.concatStringsSep " " [
            "${cfg.package}/bin/whombat-console --serve 127.0.0.1:${toString cfg.guiPort}"
            "--ui ${cfg.uiPackage}/share/whombat-console-ui --token-file ${tokenDir}/token"
            serverArgs
            # The desk (NX-160): a path socket works from this namespace (PrivateNetwork= keeps only abstract sockets
            # and IP apart) and on the read-only /run (connect needs write permission on the socket, not the mount).
            "--desk-socket ${deskSocket} --desk-peer-uid ${toString config.whombat.ids.whombat}"
          ];
          User = "whombat-console";
          Group = "whombat-console";
          StandardInput = "null";
          StandardOutput = "journal";
          StandardError = "journal";
          Restart = "always";
          RestartSec = 1;
          NoNewPrivileges = true;
          ProtectSystem = "strict";
          # The token (NX-78): the only place it writes.
          ReadWritePaths = [ tokenDir ];
          ProtectHome = true;
          PrivateTmp = true;
          PrivateDevices = true;
          PrivateNetwork = true;
          IPAddressDeny = "any";
          IPAddressAllow = "localhost";
          # The loopback, and the notify socket.
          RestrictAddressFamilies = [
            "AF_INET"
            "AF_UNIX"
          ];
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectKernelLogs = true;
          ProtectControlGroups = true;
          ProtectClock = true;
          ProtectHostname = true;
          ProtectProc = "invisible";
          ProcSubset = "pid";
          LockPersonality = true;
          MemoryDenyWriteExecute = true;
          RestrictRealtime = true;
          RestrictSUIDSGID = true;
          RestrictNamespaces = true;
          RemoveIPC = true;
          UMask = "0077";
          CapabilityBoundingSet = "";
          AmbientCapabilities = "";
          SystemCallArchitectures = "native";
          SystemCallFilter = [
            "@system-service"
            "~@privileged @resources"
          ];
          LimitCORE = 0;
        };
      };

      whombat.kiosk = {
        enable = true;
        port = cfg.guiPort;
        inherit tokenDir;
        tokenOwner = "whombat-console";
        serverUnit = "whombat-console-server.service";
        joinServerNetwork = true;
        fallbackUnit = "whombat-console.service";
        uid = config.whombat.ids.whombat-kiosk;
        inherit (cfg) sleepAfterSec;
        # The desk display (DK-08, DK-09, DK-11; NX-162…NX-164). The graphics chip (`gpu`, NX-161) stays off until it is
        # tried on a real desk machine (NX-169): software rendering is what every box draws with.
        desk = true;
      };

      # A display early: the virtual GPUs of a VM (std VGA = bochs, virtio-gpu, QXL) in the initrd, so the
      # firmware framebuffer is handed over before the kiosk starts; real GPUs (i915, amdgpu, nouveau) load from the
      # system's modules as udev finds them (their firmware is in hardware.enableRedistributableFirmware), and until
      # then, or without a driver, the firmware framebuffer (simpledrm) serves the kiosk (NX-83).
      boot.initrd.availableKernelModules = [
        "bochs"
        "virtio_gpu"
        "qxl"
      ];
    })
  ];
}
