# Hermes Agent for the runner (Whombat HE-10, HE-12, HE-16; NX-430…NX-435). Hermes and Whombat's plugin are part of the
# runtime bundle (Whombat HU-04; NX-483): its bin/whombat-runner names the bundle's own Hermes (WHOMBAT_HERMES_BIN), so a
# new Hermes arrives with a runtime release and goes back with it; the host names none. The runner starts
# `$WHOMBAT_HERMES_BIN acp` per turn inside its task sandbox, where /nix/store is bound read-only, so the store path is
# all it needs to reach it. What stays the host's: the person's Hermes home (HERMES_HOME, Hermes's default profile),
# `$WHOMBAT_HERMES_ROOT` itself, in Hermes's own layout, with the outsiders' profile beside it in `profiles/_feedback/`
# (Whombat one-person.md OP-08, OP-17; NX-466). Configuration is the runner's (`config.yaml` before every turn); nothing
# here configures Hermes.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.hermes;
  p = config.whombat.persistDir;
  inherit (lib) mkOption types;
in
{
  options.whombat.hermes = {
    enable = mkOption {
      type = types.bool;
      default = !(config.whombat.runtime.package.passthru.whombatStandIn or false);
      defaultText = lib.literalExpression "the factory runtime is the real one (not the stand-in)";
      description = ''
        Give the runner Hermes's home (WHOMBAT_HERMES_ROOT); its executable is the runtime bundle's (NX-483). On with
        the real runtime; images and VM tests with the stand-in, which runs no turns, leave it out.
      '';
    };
    package = mkOption {
      type = types.package;
      default = config.whombat.runtime.package.passthru.hermes or pkgs.whombat-hermes;
      defaultText = lib.literalExpression "config.whombat.runtime.package.passthru.hermes or pkgs.whombat-hermes";
      description = ''
        The factory runtime's Hermes (nix/packages/hermes). The runner never runs it from here: it runs the Hermes of
        the runtime profile in use (NX-483). The agent's tools take its agent-browser, and tests its Python.
      '';
    };
    root = mkOption {
      type = types.str;
      default = "${p}/whombat/hermes";
      readOnly = true;
      description = ''
        WHOMBAT_HERMES_ROOT: the person's Hermes home (memory, sessions, skills/) with the outsiders' profile
        (profiles/_feedback/), 0700 whombat-runner, kept across activations and updates; the backup's source `hermes`
        (BK-36, NX-466).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    warnings = lib.optional (!(cfg.package.passthru.withPlugin or false)) ''
      whombat.hermes: Hermes is built without Whombat's plugin: the pinned Whombat has no packages/hermes-whombat
      (NX-432). Turns on Hermes have no Claude Code mode and none of Whombat's tools.'';

    # A subvolume of its own in Whombat's qgroup (NX-12): memory, sessions and skills grow inside the space limit that
    # keeps PostgreSQL writable, and the backup snapshots it with home and credentials inside the quiesce (BK-36).
    whombat.storage.extraSubvolumes = [ "whombat/hermes" ];
    systemd.tmpfiles.settings."20-whombat-hermes".${cfg.root}.d = {
      mode = "0700";
      user = "whombat-runner";
      group = "whombat-runner";
    };

    systemd.services.whombat-runner = {
      # No WHOMBAT_HERMES_BIN: bin/whombat-runner sets its own bundle's (NX-483).
      environment.WHOMBAT_HERMES_ROOT = cfg.root;
      # ProtectSystem=strict: the runner writes the profiles and their config.yaml (sandbox.nix has the rest).
      serviceConfig.ReadWritePaths = [ cfg.root ];
    };

    # The activation's Hermes check (Whombat HU-05; NX-484): at every start of the runtime (an update's activation, a
    # rollback, a boot) the runtime profile's own bin/whombat-hermes-check runs that bundle's Hermes in a throwaway home:
    # its version, Whombat's plugin and providers, ACP `initialize` and a session. The manager counts this unit with the
    # server and the runner (manager.nix, `runtime.units`), so a release whose Hermes fails it never turns healthy and the
    # manager goes back to the known-good one by itself. A runtime without the check (or without a Hermes of its own)
    # fails it too: this host names no Hermes. Nothing of the person's is reachable from it: its own user, private /tmp,
    # no network but its own loopback.
    systemd.services.whombat-hermes-check = {
      description = "Check the runtime's Hermes Agent";
      wantedBy = [ "whombat-runtime.target" ];
      partOf = [ "whombat-runtime.target" ];
      # Without the target's implicit After=, `systemctl restart whombat-runtime.target` (the helper's activation, with
      # its own time limit) doesn't wait for the check; the manager's health checks do.
      unitConfig.DefaultDependencies = false;
      after = [
        "basic.target"
        "whombat-runtime-profile-init.service"
      ];
      requires = [ "basic.target" ];
      conflicts = [ "shutdown.target" ];
      before = [ "shutdown.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${config.whombat.runtime.profile}/bin/whombat-hermes-check";
        TimeoutStartSec = "5min";
        DynamicUser = true;
        PrivateTmp = true;
        PrivateNetwork = true;
        PrivateDevices = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        NoNewPrivileges = true;
        LockPersonality = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        RestrictNamespaces = true;
        CapabilityBoundingSet = "";
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        SystemCallArchitectures = "native";
        UMask = "0077";
        # Beside the agent's turns, never before Whombat's core (MP-02, NX-142); a check, not a workload.
        Slice = "whombat-tasks.slice";
        MemoryMax = "1G";
        Nice = 10;
        LimitCORE = 0;
      };
    };
  };
}
