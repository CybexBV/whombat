# Prerequisites for the runner sandbox (assignment §7, NX-21). The sandbox itself — which mechanism
# wraps a provider turn, mounts, credential homes, network policy details — is W3-SBX's workstream.
# This module provides the knobs it builds on and fails closed: sandbox uids have no network until a
# rule allows it, and a missing prerequisite marks whombat-sandbox-prereqs failed (the runner must then
# refuse tasks, never run them unsandboxed).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.sandbox;
  inherit (lib) mkOption types;
  sb = cfg.uidRange;
  nft = "${pkgs.nftables}/bin/nft";
  v4 = g: !(lib.hasInfix ":" g.cidr);
  grantRules = lib.concatMapStringsSep "\n" (
    g:
    "    ${if v4 g then "ip" else "ip6"} daddr ${g.cidr} th dport { ${lib.concatMapStringsSep ", " toString g.ports} } accept"
  ) cfg.grants;
  # MS "NixOS nftables design": the wall under the runner's egress proxy. Only processes in the runner's
  # cgroup (the runner and every task sub-cgroup) are affected; IPv4 and IPv6.
  wallRules = pkgs.writeText "whombat-runner-wall.nft" ''
    table inet whombat_runner {
      set denied4 { type ipv4_addr; flags interval; elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10,
        127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15,
        224.0.0.0/3, 168.63.129.16 } }
      set denied6 { type ipv6_addr; flags interval; elements = { ::/127, ::ffff:0:0/96, 64:ff9b::/96,
        64:ff9b:1::/48, 2001::/32, 2002::/16, fc00::/7, fe80::/10, fec0::/10, ff00::/8 } }
      # Only an equality match is reliable: `level N !=` does not match sockets in shallower cgroups.
      chain output {
        type filter hook output priority -10; policy accept;
        socket cgroupv2 level 3 "whombat.slice/whombat-tasks.slice/whombat-runner.service" jump runner
      }
      chain runner {
        oif "lo" tcp dport ${toString cfg.serverPort} accept comment "runtime server (MCP)"
        oif "lo" th dport 53 accept comment "host resolver stub"
    ${grantRules}
        ip daddr @denied4 counter reject with icmpx admin-prohibited
        ip6 daddr @denied6 counter reject with icmpx admin-prohibited
        meta l4proto tcp th dport { 80, 443 } accept
        counter reject with icmpx admin-prohibited
      }
    }
  '';
  wallLoad = pkgs.writeShellScript "whombat-runner-wall-load" ''
    ${nft} delete table inet whombat_runner 2>/dev/null || true
    ${nft} -f ${wallRules}
  '';
  wallUnload = pkgs.writeShellScript "whombat-runner-wall-unload" ''
    ${nft} delete table inet whombat_runner 2>/dev/null || true
  '';
  # The runner's TMPDIR (NX-133, kept by NX-455): its temporary root (`<TMPDIR>/whombat-runner-<uid>`: turn files,
  # read-only exports) on the root file system, 0700 the runner's, emptied at every boot like a /tmp.
  runnerTmp = "/var/lib/whombat-runner/tmp";
in
{
  options.whombat.sandbox = {
    packages = mkOption {
      type = types.listOf types.package;
      default = [
        pkgs.bubblewrap
        pkgs.util-linux
      ];
      description = "Sandbox tooling on the runner's PATH (bubblewrap by default, NX-21).";
    };
    subordinateIdMapping = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Let the runner map its subordinate uid range (per-task uids) into user namespaces with the
        setuid newuidmap/newgidmap helpers. This requires NoNewPrivileges=false on the runner unit
        (the only unit without it). Set false if W3-SBX settles on single-uid user namespaces.
      '';
    };
    delegateCgroups = mkOption {
      type = types.bool;
      default = true;
      description = "Delegate the runner's cgroup subtree so it can give each task its own limits.";
    };
    egressRules = mkOption {
      type = types.lines;
      default = "";
      example = ''
        ip daddr 127.0.0.1 tcp dport 4621 accept   # the runner's egress proxy
      '';
      description = ''
        nftables rules evaluated for packets from sandbox uids (chain `whombat-sandbox-egress`,
        inet filter table). Anything not accepted here is dropped and counted (fail closed; IPv4 and
        IPv6 alike). W3-SBX fills this (egress proxy, provider allowlist, customer LAN grants).
      '';
    };
    toolchain = mkOption {
      type = types.package;
      default = pkgs.buildEnv {
        name = "whombat-sandbox-toolchain";
        paths = with pkgs; [
          bashInteractive
          coreutils
          findutils
          diffutils
          gnugrep
          gnused
          gawk
          gnutar
          gzip
          xz
          which
          patch
          gnumake
          git
          nodejs_22
          pnpm
          # Python with the libraries the shipped skills' scripts use for documents, spreadsheets, slides and PDFs
          # (Whombat SL-11; NX-98): python-docx, openpyxl, python-pptx, pypdf, Pillow.
          (python3.withPackages (
            ps: with ps; [
              python-docx
              openpyxl
              python-pptx
              pypdf
              pillow
            ]
          ))
        ];
      };
      defaultText = lib.literalExpression "a buildEnv of the qualified tools";
      description = ''
        The pinned toolchain available read-only inside every task (WHOMBAT_SANDBOX_RO_PATHS, MS-16). Part of
        the host generation, so it changes only with a host release; tasks see it under its store path. Its python3
        has python-docx, openpyxl, python-pptx, pypdf and Pillow (SL-11, NX-98).
      '';
    };
    limits = {
      memoryMB = mkOption { type = types.int; default = 4096; };
      pids = mkOption { type = types.int; default = 1024; };
      cpuWeight = mkOption { type = types.int; default = 100; };
      tmpMB = mkOption { type = types.int; default = 1024; };
      outputMB = mkOption { type = types.int; default = 256; };
      # Whombat RA-14: a turn may run up to 8 hours (the runner's and the server's default, NX-140).
      wallMinutes = mkOption { type = types.int; default = 480; };
    };
    egressAllowHosts = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Extra public hosts tasks may reach through the runner's egress proxy (MS-06).";
    };
    grants = mkOption {
      type = types.listOf (
        types.submodule {
          options = {
            cidr = mkOption { type = types.str; };
            ports = mkOption { type = types.listOf types.port; };
          };
        }
      );
      default = [ ];
      example = [
        {
          cidr = "10.20.0.0/16";
          ports = [ 5432 ];
        }
      ];
      description = ''
        Explicit customer-network grants (MS-08): passed to the runner (WHOMBAT_SANDBOX_GRANTS) and opened in
        the nftables wall for the runner's cgroup. Nothing private is reachable without one.
      '';
    };
    serverPort = mkOption {
      type = types.port;
      default = 4620;
      description = "The runtime server's loopback port the runner forwards MCP to (MA-14).";
    };
    runnerTmp = mkOption {
      type = types.str;
      default = runnerTmp;
      readOnly = true;
      description = "The runner's TMPDIR (NX-133, NX-455): 0700 whombat-runner, emptied at every boot.";
    };
    runnerServiceOverrides = mkOption {
      type = types.attrsOf types.anything;
      internal = true;
      default = { };
    };
  };

  config = {
    # Unprivileged user namespaces (bubblewrap without setuid).
    security.unprivilegedUsernsClone = true;
    boot.kernel.sysctl."user.max_user_namespaces" = 65536;
    security.allowUserNamespaces = true;

    whombat.sandbox.runnerServiceOverrides = {
      NoNewPrivileges = !cfg.subordinateIdMapping;
      RestrictNamespaces = false;
      RestrictSUIDSGID = !cfg.subordinateIdMapping;
      Delegate = if cfg.delegateCgroups then "cpu memory pids" else false;
      # A crashed runner must not leave task processes behind: stop kills the whole cgroup (all task
      # sub-cgroups included) at once; the runner also cgroup.kill-s tasks itself (MS-11).
      KillMode = "control-group";
      TimeoutStopSec = "30s";
      ReadWritePaths = [
        "${config.whombat.persistDir}/whombat/workspaces"
        "${config.whombat.persistDir}/whombat/credentials"
        "${config.whombat.persistDir}/whombat/runner"
        runnerTmp
      ];
      # The wall is loaded once the unit's cgroup exists (nft resolves cgroup paths at load time).
      ExecStartPost = [ "+${wallLoad}" ];
      ExecStopPost = [ "+${wallUnload}" ];
      # sethostname: bubblewrap names each task's own UTS namespace (`--hostname whombat-task`, both stages); outside
      # the filter it is killed with SIGSYS. Without capabilities it can't touch the host's name (NX-73).
      # syslog(2) stays outside the allow list (what ProtectKernelLogs= also denied).
      # @pkey (pkey_alloc, pkey_free, pkey_mprotect; NX-512): the agent's Chromium, which the runner starts in the
      # commands' wrapper, calls pkey_alloc at start on a CPU with memory protection keys and was killed with SIGSYS, so
      # Hermes's browser never started. Keys guard the calling process's own memory only. ptrace (@debug) stays out:
      # only Chromium's crash handler wants it.
      # mincore (NX-513): Chromium's memory accounting (MemoryInfra, a renderer under memory pressure) asks which of its
      # own pages are in memory; killed for it, a tab's renderer died and the tab never answered again, and once the
      # processes that start renderers were killed the browser couldn't open a tab at all. It reads only the calling
      # process's own memory.
      SystemCallFilter = [
        "@system-service @mount @pkey sethostname mincore"
        "~@reboot @swap @module @raw-io @cpu-emulation @obsolete @clock"
      ];
      # bubblewrap mounts a fresh procfs for each task's pid namespace. From a user namespace the kernel allows that
      # only when the runner's own /proc is fully visible: no locked mount over anything under it
      # (fs/namespace.c mount_too_revealing). These three put read-only or inaccessible mounts there
      # (/proc/{sys,sysrq-trigger,kcore,kallsyms,acpi,bus,fs,irq,mtrr,scsi}, /proc/kmsg,
      # /proc/sys/kernel/{hostname,domainname}), and every live turn failed with “bwrap: Can't mount proc on /proc:
      # Operation not permitted” (NX-69, NX-73). What they guarded needs host root or capabilities the runner doesn't
      # have (empty bounding set); tasks see only their own procfs, never the runner's. `ProtectProc=invisible`
      # doesn't block it and stays.
      ProtectKernelTunables = false;
      ProtectKernelLogs = false;
      ProtectHostname = false;
      # The runner makes its task cgroups inside its own delegated cgroup (supervisor/, tasks/<task>): `yes` mounts all
      # of /sys/fs/cgroup read-only (EROFS, “no task cgroups”); `private` gives it a cgroup namespace with a writable
      # mount of its own subtree only (the rest of the hierarchy stays out of sight). The nftables wall matches the
      # real cgroup path, which a namespace doesn't change.
      ProtectControlGroups = "private";
      # The runner needs CAP_SETUID/SETGID only inside its own user namespaces, which bounding-set
      # emptiness does not prevent; host capabilities stay empty.
      CapabilityBoundingSet = "";
      # bubblewrap reads /proc/sys/kernel/overflowuid (and the user-namespace limits) to build the sandbox; with the
      # runtime's `ProcSubset=pid` it can't, and the managed runner refuses every live turn (NX-69). Processes of
      # other units stay hidden (`ProtectProc=invisible`).
      ProcSubset = "all";
    };
    # socat: the sandbox's network proxy (Whombat MS-06; the runner says “socat is not installed” without it, NX-69).
    # gh: GitHub sign-ins (Whombat PV-06) and agents' gh commands, which the runner runs for them outside the sandbox
    # (Whombat agent-gh.md AGH-03; NX-135). Not in the tasks' toolchain: an agent's own gh is Whombat's stand-in.
    systemd.services.whombat-runner.path = cfg.packages ++ [
      pkgs.socat
      pkgs.gh
      "/run/wrappers"
    ];
    systemd.services.whombat-runner.environment = {
      TMPDIR = runnerTmp;
      WHOMBAT_SANDBOX_CGROUP = "delegated";
      WHOMBAT_SANDBOX_BWRAP = "${pkgs.bubblewrap}/bin/bwrap";
      WHOMBAT_RUNNER_STATE = "${config.whombat.persistDir}/whombat/runner";
      # The toolchain and the installed AI clients (NX-37), colon-separated.
      WHOMBAT_SANDBOX_RO_PATHS = "${cfg.toolchain}:${config.whombat.clients.root}";
      WHOMBAT_SANDBOX_MEMORY_MB = toString cfg.limits.memoryMB;
      WHOMBAT_SANDBOX_PIDS = toString cfg.limits.pids;
      WHOMBAT_SANDBOX_CPU_WEIGHT = toString cfg.limits.cpuWeight;
      WHOMBAT_SANDBOX_TMP_MB = toString cfg.limits.tmpMB;
      WHOMBAT_SANDBOX_OUTPUT_MB = toString cfg.limits.outputMB;
      WHOMBAT_SANDBOX_WALL_MINUTES = toString cfg.limits.wallMinutes;
      WHOMBAT_SANDBOX_EGRESS_ALLOW = lib.concatStringsSep "," (
        lib.unique (cfg.egressAllowHosts ++ config.whombat.clients.signInHosts)
      );
      WHOMBAT_SANDBOX_GRANTS = lib.concatMapStringsSep ";" (
        g: lib.concatMapStringsSep ";" (port: "${g.cidr}:${toString port}") g.ports
      ) cfg.grants;
    };
    systemd.tmpfiles.settings."20-whombat-runner" = {
      "${config.whombat.persistDir}/whombat/runner".d = {
        mode = "0700";
        user = "whombat-runner";
        group = "whombat-runner";
      };
      # The runner's own WHOMBAT_HOME (NX-76, runtime.nix): guarded agents' empty `gh` config, workspace locks, where
      # it looks for host configuration (ACP runtimes). Not the server's 0700 home, which it can't enter.
      ${config.whombat.runtime.runnerHome}.d = {
        mode = "0700";
        user = "whombat-runner";
        group = "whombat-runner";
      };
      "/var/lib/whombat-runner".d = {
        mode = "0700";
        user = "whombat-runner";
        group = "whombat-runner";
      };
      # Emptied at every boot, like the /tmp it replaces.
      ${runnerTmp}.D = {
        mode = "0700";
        user = "whombat-runner";
        group = "whombat-runner";
      };
    };

    # Fail-closed prerequisite check. The runner reads its result (unit state) before taking tasks.
    systemd.services.whombat-sandbox-prereqs = {
      description = "Check runner sandbox prerequisites";
      path = cfg.packages ++ [
        pkgs.coreutils
        pkgs.gnugrep
      ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = "whombat-runner";
        Group = "whombat-runner";
        PrivateTmp = true;
      };
      script = ''
        set -eu
        test "$(cat /proc/sys/user/max_user_namespaces)" -gt 0
        # A user namespace with a private mount namespace, as bubblewrap uses it.
        bwrap --unshare-all --ro-bind /nix/store /nix/store --proc /proc --dev /dev \
          ${pkgs.coreutils}/bin/true
        grep -q '^whombat-runner:${toString sb.start}:${toString sb.count}$' /etc/subuid
        echo "sandbox prerequisites present"
      '';
    };
  };
}
