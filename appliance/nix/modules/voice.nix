# Speech on the box for the desk display and voice typing (Whombat DK-06, DK-07, DK-12, DT-01…DT-12; NX-175…NX-188,
# NX-291…NX-296, NX-470…NX-475, NX-476…NX-479).
#
# - `whombat-voice` answers the runtime server on /run/whombat-voice/voice.sock (contracts' voice socket, CT-532, 3.1):
#   speech to text with whisper.cpp 1.9.5 (Parakeet TDT 0.6B v3 through parakeet-cli, Whisper large-v3-turbo through
#   whisper-cli, NX-470) on the graphics chip when the box has one it can use (Vulkan, NX-472) and else on the
#   processor, and text to speech through sherpa-onnx: English with Kokoro v1.0 (`kokoro-speak`, six voices, `heart` by
#   default, NX-291, NX-301) and Dutch with Supertonic 3 (`supertonic-speak`, in its voice of the kind of the person's
#   English voice, NX-476…NX-478), one job at a time with two waiting. The programs and Kokoro are in the image; the speech-to-text
#   models are not (DT-05): `whombat-voice-models` downloads them after the box is installed into /persist/voice-models,
#   which the voice service only reads. Nothing it hears leaves the box.
# - The sockets are systemd's (socket activation): 0660 <service>:whombat, so the server (user `whombat`, its primary
#   group) connects and nothing else does; both services also check the peer's uid (the server's and root's). The
#   voice service starts at the first request and stays; the fetcher also starts at boot, to carry on with a download.
# - The voice service: no network at all (PrivateNetwork, IPAddressDeny=any, AF_UNIX only), no capabilities, of
#   /persist only the models (read only); the graphics chip's render nodes and nothing else of /dev; each job's files
#   live on a private tmpfs and go when the job ends (DK-07). A memory cap and low CPU and IO weights: an answer may
#   take a second longer, the server and the database never wait for it.
# - The fetcher: the network (it fetches from the sources the release's manifest names, checking each file's size and
#   sha256 before it renames it into place, NX-473), of /persist only its directory, no capabilities, no audio.
# - The runtime server learns of them through WHOMBAT_VOICE_SOCKET and WHOMBAT_VOICE_MODELS_SOCKET (runtime.nix).
{
  config,
  options,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.voice;
  inherit (lib) mkOption types;
  ids = config.whombat.ids;
  socket = "/run/whombat-voice/voice.sock";
  modelsSocket = "/run/whombat-voice-models/models.sock";
  modelsDir = "${config.whombat.persistDir}/voice-models";
  # The programs' environment: the Vulkan drivers (NX-472) and a shader cache for the service's life (its tmpfs).
  programEnv = lib.optionals cfg.gpu [
    "VK_DRIVER_FILES=${cfg.vulkan.package.passthru.driverFiles cfg.vulkan.package}"
    "MESA_SHADER_CACHE_DIR=/tmp/shader-cache"
  ];
  # A voice as --kokoro-voices takes it: name=speaker:accent:kind (NX-478).
  voiceFlag =
    v: "${v.name}=${toString v.speaker}:${v.accent}:${if v.man or false then "man" else "woman"}";
  # The default voice first (the health lists it first, NX-302).
  kokoroVoices =
    let
      all = cfg.kokoro.model.deskVoices;
    in
    lib.filter (v: v.name == cfg.kokoro.voice) all ++ lib.filter (v: v.name != cfg.kokoro.voice) all;
in
{
  options.whombat.voice = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Speech to text and text to speech for the desk display's Talk (Whombat DK-06, NX-175). On in the appliance
        profile; the runtime offers Talk only when the machine also has a microphone (the service's health says so).
      '';
    };
    package = mkOption {
      type = types.package;
      default = pkgs.whombat-voice;
      defaultText = lib.literalExpression "pkgs.whombat-voice";
    };
    whisper = {
      package = mkOption {
        type = types.package;
        default = pkgs.voice-whisper;
        defaultText = lib.literalExpression "pkgs.voice-whisper";
        description = "whisper.cpp with bin/whisper-cli, bin/parakeet-cli and bin/voice-gpu-probe (nix/packages/voice-engines).";
      };
    };
    vulkan.package = mkOption {
      type = types.package;
      default = pkgs.voice-vulkan;
      defaultText = lib.literalExpression "pkgs.voice-vulkan";
      description = "mesa's Vulkan drivers for AMD and Intel, without LLVM (nix/packages/voice-engines/vulkan.nix, NX-472).";
    };
    gpu = mkOption {
      type = types.bool;
      # The drivers are built for x86-64 only (their manifests name it): elsewhere speech runs on the processor.
      default = pkgs.stdenv.hostPlatform.isx86_64;
      defaultText = lib.literalExpression "pkgs.stdenv.hostPlatform.isx86_64";
      description = ''
        Speech to text on the box's graphics chip when it has one the service can use (Vulkan, NX-472): its render nodes
        and the drivers. Off: always the processor. On by default on x86-64, the only processor the drivers are built
        for.
      '';
    };
    models = {
      manifest = mkOption {
        type = types.path;
        default = pkgs.voice-models-manifest;
        defaultText = lib.literalExpression "pkgs.voice-models-manifest";
        description = "The speech and optional Dutch voice models the box downloads: ids, files, sources, sizes and sha256.";
      };
      dir = mkOption {
        type = types.str;
        default = modelsDir;
        readOnly = true;
        description = "Where the fetcher puts the models and the voice service reads them: a subvolume, never backed up.";
      };
      socket = mkOption {
        type = types.str;
        default = modelsSocket;
        readOnly = true;
        description = "The models socket (WHOMBAT_VOICE_MODELS_SOCKET of the runtime server), 0660 whombat-voice-models:whombat.";
      };
    };
    kokoro = {
      package = mkOption {
        type = types.package;
        default = pkgs.voice-kokoro;
        defaultText = lib.literalExpression "pkgs.voice-kokoro";
        description = "bin/kokoro-speak, Kokoro through sherpa-onnx's C library (nix/packages/voice-engines, NX-291).";
      };
      model = mkOption {
        type = types.package;
        default = pkgs.voice-kokoro-model;
        defaultText = lib.literalExpression "pkgs.voice-kokoro-model";
        description = ''
          The Kokoro model's directory: model.onnx, voices.bin, tokens.txt and the lexicons (NX-292), with the desk's
          voices in `passthru.deskVoices` (`{name, speaker, accent}`, NX-301).
        '';
      };
      voice = mkOption {
        type = types.enum (map (v: v.name) cfg.kokoro.model.deskVoices);
        default = "heart";
        description = ''
          The voice the box speaks with until the paired person chooses another in Settings (Whombat DK-50), listed
          first in the health's `voices` (NX-302).
        '';
      };
    };
    supertonic = {
      model = mkOption {
        type = types.nullOr types.package;
        # Off in the image: Supertonic 3 weights stay out of the image and are downloaded into /persist/voice-models
        # only after the person agrees to Open RAIL-M in Settings.
        default = null;
        description = ''
          Optional pre-bundled Supertonic 3 model directory (int8, sherpa-onnx packing). null (the default): the image
          carries only `bin/supertonic-speak`, and Dutch turns on dynamically once the fetcher downloads Supertonic 3
          into `/persist/voice-models` after the person agrees to Open RAIL-M in Settings.
        '';
      };
      speakers = {
        woman = mkOption {
          type = types.ints.between 0 9;
          default = 1;
          description = "Supertonic's speaker for a woman's English voice (0–4 its women F1…F5): F2 (NX-478).";
        };
        man = mkOption {
          type = types.ints.between 0 9;
          default = 8;
          description = "Supertonic's speaker for a man's English voice (5–9 its men M1…M5): M4 (NX-478).";
        };
      };
    };
    socket = mkOption {
      type = types.str;
      default = socket;
      readOnly = true;
      description = "The voice socket (WHOMBAT_VOICE_SOCKET of the runtime server), 0660 whombat-voice:whombat.";
    };
    threads = mkOption {
      type = types.ints.unsigned;
      default = 0;
      description = "whisper-cli's and kokoro-speak's threads; 0: the CPUs the service may use, at most 8 (NX-180).";
    };
    timeouts = {
      stt = mkOption {
        type = types.ints.positive;
        default = 90;
        description = "Seconds a speech-to-text job may take (whisper-cli is killed after; 503 unavailable).";
      };
      tts = mkOption {
        type = types.ints.positive;
        default = 60;
        description = "Seconds a text-to-speech job may take (kokoro-speak is killed after; 503 unavailable).";
      };
    };
    memoryMax = mkOption {
      type = types.str;
      default = "2G";
      description = ''
        The service's memory cap with the job it runs: parakeet-cli peaks near 820 MB for pieces of 30 s, whisper-cli
        with large-v3-turbo near 790 MB, kokoro-speak near 550 MB, supertonic-speak near 400 MB, and only one runs at a
        time (NX-180, NX-293, NX-474, NX-477).
      '';
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      # The appliance's storage makes the models' subvolume; a test machine without it gets a plain directory.
      (lib.optionalAttrs (options.whombat ? storage) {
        whombat.storage.extraSubvolumes = [ "voice-models" ];
      })
      {
        # ---- The account (NX-08: fixed ids; it owns nothing on /persist, but a fixed uid keeps the peer check and the
        # socket's owner the same in every generation) -------------------------------------------------------------------
        users.users.whombat-voice = {
          isSystemUser = true;
          uid = ids.whombat-voice;
          group = "whombat-voice";
          home = "/var/empty";
          createHome = false;
          shell = "/run/current-system/sw/bin/nologin";
        };
        users.groups.whombat-voice.gid = ids.whombat-voice;
        users.users.whombat-voice-models = {
          isSystemUser = true;
          uid = ids.whombat-voice-models;
          group = "whombat-voice-models";
          home = "/var/empty";
          createHome = false;
          shell = "/run/current-system/sw/bin/nologin";
        };
        users.groups.whombat-voice-models.gid = ids.whombat-voice-models;

        # ---- The models (NX-473): a subvolume of their own in Whombat's qgroup, not a backup source (they download
        # again). 2750 whombat-voice-models:whombat-voice: the fetcher writes, its files take the voice service's group, which
        # reads them.
        systemd.tmpfiles.settings."20-whombat-voice-models".${modelsDir}.d = {
          mode = "2750";
          user = "whombat-voice-models";
          group = "whombat-voice";
        };

        # ---- The socket: the server's (its primary group), made by systemd so the service needs no group of its own ----
        systemd.sockets.whombat-voice = {
          description = "Whombat voice socket";
          wantedBy = [ "sockets.target" ];
          socketConfig = {
            ListenStream = socket;
            SocketUser = "whombat-voice";
            SocketGroup = "whombat";
            SocketMode = "0660";
            DirectoryMode = "0755";
            RemoveOnStop = true;
          };
        };

        systemd.sockets.whombat-voice-models = {
          description = "Whombat voice models socket";
          wantedBy = [ "sockets.target" ];
          socketConfig = {
            ListenStream = modelsSocket;
            SocketUser = "whombat-voice-models";
            SocketGroup = "whombat";
            SocketMode = "0660";
            DirectoryMode = "0755";
            RemoveOnStop = true;
          };
        };

        # The fetcher (NX-473): at boot too, so a download that was asked for carries on before the runtime asks again.
        systemd.services.whombat-voice-models = {
          description = "Whombat voice models: download the speech models this box uses";
          requires = [ "whombat-voice-models.socket" ];
          wantedBy = [ "multi-user.target" ];
          wants = [ "network-online.target" ];
          after = [
            "whombat-voice-models.socket"
            "whombat-persist.target"
            "network-online.target"
          ];
          unitConfig.RequiresMountsFor = [ modelsDir ];
          serviceConfig = {
            Type = "notify";
            ExecStart = lib.escapeShellArgs [
              "${cfg.package}/bin/whombat-voice-models"
              "--socket"
              modelsSocket
              "--manifest"
              "${cfg.models.manifest}"
              "--dir"
              modelsDir
              "--allow-uid"
              "0,${toString ids.whombat}"
            ];
            Restart = "on-failure";
            RestartSec = "5s";
            User = "whombat-voice-models";
            Group = "whombat-voice-models";
            # The network, to the sources only: no listening, no other socket family.
            RestrictAddressFamilies = [
              "AF_UNIX"
              "AF_INET"
              "AF_INET6"
            ];
            # Of /persist its directory only.
            TemporaryFileSystem = [ "${config.whombat.persistDir}:ro" ];
            BindPaths = [ modelsDir ];
            # The one voice service with the network doesn't see the voice service's socket at all, so a flaw in it
            # can't reach the program that hears the person.
            InaccessiblePaths = [ "-${builtins.dirOf socket}" ];
            PrivateTmp = true;
            CapabilityBoundingSet = "";
            NoNewPrivileges = true;
            ProtectSystem = "strict";
            ProtectHome = true;
            PrivateDevices = true;
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
            SystemCallArchitectures = "native";
            SystemCallFilter = [
              "@system-service"
              "~@privileged @resources"
            ];
            UMask = "0027";
            MemoryMax = "256M";
            CPUWeight = 20;
            IOWeight = 20;
          };
        };

        systemd.services.whombat-voice = {
          description = "Whombat voice: speech to text and text to speech on this box";
          requires = [ "whombat-voice.socket" ];
          after = [
            "whombat-voice.socket"
            "whombat-persist.target"
          ];
          environment.TMPDIR = "/tmp";
          serviceConfig = {
            Type = "notify";
            ExecStart = lib.escapeShellArgs (
              [
                "${cfg.package}/bin/whombat-voice"
                "--socket"
                socket
                "--whisper"
                "${cfg.whisper.package}/bin/whisper-cli"
                "--parakeet"
                "${cfg.whisper.package}/bin/parakeet-cli"
                "--models"
                modelsDir
                "--manifest"
                "${cfg.models.manifest}"
                "--kokoro"
                "${cfg.kokoro.package}/bin/kokoro-speak"
                "--kokoro-model"
                "${cfg.kokoro.model}"
                "--kokoro-voices"
                (lib.concatMapStringsSep "," voiceFlag kokoroVoices)
                "--supertonic"
                "${cfg.kokoro.package}/bin/supertonic-speak"
                "--supertonic-speakers"
                "${toString cfg.supertonic.speakers.woman},${toString cfg.supertonic.speakers.man}"
                "--allow-uid"
                "0,${toString ids.whombat}"
                "--tmp"
                "/tmp"
                "--stt-timeout"
                "${toString cfg.timeouts.stt}s"
                "--tts-timeout"
                "${toString cfg.timeouts.tts}s"
              ]
              ++ lib.optionals cfg.gpu [
                "--gpu-probe"
                "${cfg.whisper.package}/bin/voice-gpu-probe"
                "--env"
                (lib.concatStringsSep "," programEnv)
              ]
              ++ lib.optionals (cfg.supertonic.model != null) [
                "--supertonic-model"
                "${cfg.supertonic.model}"
              ]
              ++ lib.optionals (cfg.threads > 0) [
                "--threads"
                (toString cfg.threads)
              ]
            );
            Restart = "on-failure";
            RestartSec = "2s";
            User = "whombat-voice";
            Group = "whombat-voice";

            # No network: what is heard stays on the box (DK-06).
            PrivateNetwork = true;
            IPAddressDeny = "any";
            RestrictAddressFamilies = [ "AF_UNIX" ];
            # Each job's files: a tmpfs of the unit's own, gone with it (DK-07); five minutes of speech are 9.6 MB, the
            # graphics chip's shader cache lives there for the service's life. Of /persist the models only, read only.
            TemporaryFileSystem = [
              "/tmp:size=256M,mode=1777,noexec"
              "${config.whombat.persistDir}:ro"
            ];
            BindReadOnlyPaths = [ "-${modelsDir}" ];

            CapabilityBoundingSet = "";
            NoNewPrivileges = true;
            ProtectSystem = "strict";
            ProtectHome = true;
            # The graphics chip's render nodes, and no other device (NX-472).
            PrivateDevices = !cfg.gpu;
            DevicePolicy = "closed";
            DeviceAllow = lib.optionals cfg.gpu [ "char-drm rw" ];
            SupplementaryGroups = lib.optionals cfg.gpu [ "render" ];
            ProtectKernelTunables = true;
            ProtectKernelModules = true;
            ProtectKernelLogs = true;
            ProtectControlGroups = true;
            ProtectClock = true;
            ProtectHostname = true;
            # /proc/asound/pcm says whether there is a microphone (NX-179): no ProcSubset=pid.
            ProtectProc = "invisible";
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
            # onnxruntime's and ggml's thread pools may try to pin threads (@resources): refused, not killed.
            SystemCallErrorNumber = "EPERM";
            UMask = "0077";

            # A cap and low weights (NX-180): speech waits, the server and the database don't.
            MemoryMax = cfg.memoryMax;
            MemorySwapMax = "0";
            TasksMax = 256;
            CPUWeight = 20;
            IOWeight = 20;
          };
        };
      }
    ]
  );
}
