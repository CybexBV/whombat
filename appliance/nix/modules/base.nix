# Host baseline: Nix policy (the device never builds or evaluates), no remote login, logging caps,
# no core dumps, time sync. NX-03, NX-09, NX-10, NX-16.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat;
in
{
  options.whombat = {
    nix.trustedPublicKeys = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Nix signing keys the device trusts for store paths (our release cache key only; empty in
        development). The device has no substituters and max-jobs = 0: it can neither fetch nor build
        on its own. Closures arrive as TUF-verified `nix-store --export` files imported by the update
        helper (MA-11); this key list is defence in depth for any future signed import path.
      '';
    };
    journal = {
      systemMaxUse = lib.mkOption {
        type = lib.types.str;
        default = "512M";
      };
      systemKeepFree = lib.mkOption {
        type = lib.types.str;
        default = "1G";
      };
      maxRetention = lib.mkOption {
        type = lib.types.str;
        default = "30day";
      };
      rateLimitBurst = lib.mkOption {
        type = lib.types.int;
        default = 2000;
        description = "Messages per service per 30 s (0 disables rate limiting; tests only).";
      };
    };
    qualification.consoleShell = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Hardware-qualification builds only: a root shell on the local console (tty1) so the
        procedures in docs/runbooks/hardware-qualification.md can run. Never in prod (asserted); it is
        not a support account and is not reachable over the network.
      '';
    };
    timeServers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      # Every server must support NTS (authenticated NTP, RFC 8915; W4-SEC part 2 I-1).
      default = [
        "time.cloudflare.com"
        "nts.netnod.se"
        "ptbtime1.ptb.de"
        "ntppool1.time.nl"
      ];
      description = "NTS-capable time servers (NTS-KE TCP 4460 for chronyd only, NTP UDP 123).";
    };
  };

  config = {
    system.stateVersion = "26.05";

    # ---- Nix: receive prebuilt closures only (NX-09) -------------------------------------------
    nix = {
      channel.enable = false;
      nixPath = lib.mkForce [ ];
      registry = lib.mkForce { };
      # The manager owns retention: after every update the helper prunes runtime generations and collects the store
      # (UP-X18…UP-X20); profiles are the GC roots of known-good.
      gc.automatic = false;
      optimise.automatic = false;
      settings = {
        # Nothing may be built on the device and nothing is substituted from the network.
        max-jobs = 0;
        substituters = lib.mkForce [ ];
        trusted-substituters = lib.mkForce [ ];
        trusted-public-keys = lib.mkForce cfg.nix.trustedPublicKeys;
        require-sigs = true;
        # Only root (the update helper) talks to the store; the manager and runtime never do.
        allowed-users = lib.mkForce [ "root" ];
        trusted-users = lib.mkForce [ "root" ];
        experimental-features = lib.mkForce [ ];
        allow-import-from-derivation = false;
        # Keep builds impossible even if max-jobs were overridden on the command line.
        builders = lib.mkForce "";
      };
    };

    # ---- No remote login, no hidden accounts (NX-10) --------------------------------------------
    # No vendor login that works without an owner's grant (NX-411): remote help (support.nix) lets Whombat support in only
    # while an owner allows it, over the box's own outgoing relay line, never through a daemon here.
    services.openssh.enable = lib.mkForce false;
    users.mutableUsers = false;
    # Deliberate: nobody logs in to the appliance (NX-10, NX-411); recovery is the signed recovery UKI.
    users.allowNoPasswordLogin = true;
    users.users.root = {
      hashedPassword = lib.mkDefault "!"; # no password login, not even on the console
      openssh.authorizedKeys.keys = lib.mkForce [ ];
    };
    security.sudo.enable = false;
    security.sudo-rs.enable = false;
    # The console shows a status banner only; recovery is the signed recovery environment (NX-13). The tty1 console
    # says the same in one plain line (whombat.console.footer, NX-32).
    services.getty.helpLine = lib.mkForce ("\n" + config.whombat.console.banner);

    assertions = [
      {
        assertion = !(cfg.qualification.consoleShell && cfg.environment == "prod");
        message = "whombat.qualification.consoleShell is for hardware-qualification builds, never prod";
      }
      {
        # The Incus agent is a root shell for whoever runs the VM's Incus (NX-143), who has the VM's disk anyway: in
        # production only inside an Incus VM, started by Incus's virtio port alone (NX-290, NX-523).
        assertion =
          !(config.virtualisation.incus.agent.enable && cfg.environment == "prod")
          || (config.systemd.services.incus-agent.unitConfig.ConditionPathExists or null)
          == "/dev/virtio-ports/org.linuxcontainers.incus";
        message = "virtualisation.incus.agent in prod only inside an Incus VM: systemd.services.incus-agent.unitConfig.ConditionPathExists = \"/dev/virtio-ports/org.linuxcontainers.incus\"";
      }
    ];
    services.getty.autologinUser = lib.mkIf cfg.qualification.consoleShell (lib.mkForce "root");
    environment.etc."whombat/qualification-scripts" = lib.mkIf cfg.qualification.consoleShell {
      source = ../../vm-tests/hardware;
    };

    # ---- Logging: bounded, persistent, no content (NX-16) --------------------------------------
    services.journald = {
      storage = "persistent";
      extraConfig = ''
        SystemMaxUse=${cfg.journal.systemMaxUse}
        SystemKeepFree=${cfg.journal.systemKeepFree}
        RuntimeMaxUse=64M
        MaxRetentionSec=${cfg.journal.maxRetention}
        MaxFileSec=1week
        ForwardToConsole=no
        ForwardToWall=no
        RateLimitIntervalSec=30s
        RateLimitBurst=${toString cfg.journal.rateLimitBurst}
      '';
    };
    # Core dumps can contain decrypted content: never write them.
    systemd.coredump.enable = false;
    boot.kernel.sysctl = {
      "kernel.core_pattern" = "|/run/current-system/sw/bin/false";
      "fs.suid_dumpable" = 0;
      "kernel.dmesg_restrict" = 1;
      "kernel.kptr_restrict" = 2;
      "kernel.sysrq" = 0;
      "kernel.kexec_load_disabled" = 1;
      # Loose reverse-path filtering (RFC 3704): network.nix says why.
      "net.ipv4.conf.all.rp_filter" = 2;
      "net.ipv4.conf.default.rp_filter" = 2;
      "net.ipv4.conf.all.accept_redirects" = 0;
      "net.ipv6.conf.all.accept_redirects" = 0;
      "net.ipv4.conf.all.send_redirects" = 0;
      "net.ipv4.tcp_syncookies" = 1;
    };
    security.pam.loginLimits = [
      {
        domain = "*";
        item = "core";
        type = "hard";
        value = "0";
      }
    ];

    # ---- Time (NX-17, I-1) ---------------------------------------------------------------------------
    # chronyd with NTS: time from servers the device authenticates (an on-path attacker can't move the
    # clock). The TUF freshness checks additionally use the helper's and manager's own time floors from
    # verified, signed times (MA-11), which never go backwards. PID 1 starts the clock no earlier than the
    # mtime of /var/lib/systemd/timesync/clock; whombat-clock-floor keeps that file current while chrony
    # is synchronised (a board without RTC battery never starts before the last good time).
    services.timesyncd.enable = false;
    services.chrony = {
      enable = true;
      servers = cfg.timeServers;
      enableNTS = true;
      serverOption = "iburst";
      makestep = {
        enable = true;
        threshold = 1.0;
        limit = 3;
      };
    };
    systemd.services.whombat-clock-floor = {
      description = "Record the synchronised time as the boot clock floor";
      after = [ "chronyd.service" ];
      path = [
        pkgs.coreutils
        config.services.chrony.package
      ];
      serviceConfig.Type = "oneshot";
      script = ''
        if chronyc -n waitsync 1 0.5 >/dev/null 2>&1; then
          mkdir -p /var/lib/systemd/timesync
          touch /var/lib/systemd/timesync/clock
        fi
      '';
    };
    systemd.timers.whombat-clock-floor = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "5min";
        OnUnitActiveSec = "1h";
      };
    };
    time.timeZone = "UTC";

    # ---- Size and surface ----------------------------------------------------------------------------
    documentation.enable = false;
    documentation.man.enable = false;
    documentation.nixos.enable = false;
    programs.command-not-found.enable = false;
    services.udisks2.enable = false;
    xdg.autostart.enable = false;
    environment.defaultPackages = lib.mkForce [ ];
    environment.systemPackages = [ pkgs.whombat-appliance-tools ];
    boot.tmp.cleanOnBoot = true;
    # The appliance has no users to switch; a failed activation must never stop the boot.
    systemd.enableEmergencyMode = false;
  };
}
