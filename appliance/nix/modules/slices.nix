# Resource reservation (assignment §7, MA-12, NX-19). Slices under whombat.slice, a sibling of system.slice:
#   whombat-critical.slice  PostgreSQL, manager, the interactive API (server), the commands' network daemon (NX-142): high
#                           weights, guaranteed memory (each unit's MemoryMin, the slice's and whombat.slice's their
#                           sum: a protection counts only when every ancestor has it) and OOMScoreAdjust=-900.
#   whombat-tasks.slice     the runner and every sandboxed task, and the agent's containers (NX-457): low weights and
#                           hard caps, so a runaway build cannot starve the database or the API.
#
# Swap in RAM (NX-146): zram, a quarter of the memory and at most 4 GiB, zstd; nothing reaches a disk. Who may use it:
# not the tasks and the containers (MemorySwapMax=0 below and on the engine, containers.nix), because a page in zram is
# charged to no cgroup: swapping would let them past their caps into Whombat's reserve. Everything else
# (the core above its MemoryMin, system services, the console's kiosk) may page its cold memory out to zram.
{ config, lib, ... }:
let
  cfg = config.whombat.slices;
  inherit (lib) mkOption types;
  criticalMin =
    if cfg.critical.memoryMin != null then
      cfg.critical.memoryMin
    else
      "${toString (lib.foldl' (a: b: a + b) 0 (lib.attrValues cfg.critical.units))}M";
in
{
  options.whombat.slices = {
    critical = {
      units = mkOption {
        type = types.attrsOf types.ints.unsigned;
        default = { };
        example = {
          postgresql = 320;
        };
        description = ''
          `MemoryMin=` in MiB of each core unit in the critical slice (Whombat MP-02, NX-142), set by the module that
          defines the unit. The critical slice's and whombat.slice's `MemoryMin`/`MemoryLow` are their sum unless
          `memoryMin` says otherwise.
        '';
      };
      memoryMin = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "256M";
        description = ''
          The critical slice's (and whombat.slice's) `MemoryMin`/`MemoryLow`; null (the default): the sum of `units`.
          Small VM tests set less; the units then share it in proportion to their use (cgroup v2).
        '';
      };
      cpuWeight = mkOption {
        type = types.int;
        default = 1000;
      };
      ioWeight = mkOption {
        type = types.int;
        default = 1000;
      };
    };
    tasks = {
      memoryHigh = mkOption {
        type = types.str;
        default = "70%";
      };
      memoryMax = mkOption {
        type = types.str;
        default = "80%";
      };
      cpuWeight = mkOption {
        type = types.int;
        default = 50;
      };
      cpuQuota = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "600%";
        description = "Optional hard CPU cap for all tasks together.";
      };
      ioWeight = mkOption {
        type = types.int;
        default = 50;
      };
      tasksMax = mkOption {
        type = types.int;
        default = 8192;
      };
    };
    # zram swap (NX-146). Platform-neutral: the same on a machine of its own and in any VM.
    swap = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Swap in compressed RAM (zram, zstd); no swap on a disk ever.";
      };
      memoryPercent = mkOption {
        type = types.ints.between 1 100;
        default = 25;
        description = "The zram device's size (uncompressed) as a share of MemTotal.";
      };
      maxMiB = mkOption {
        type = types.ints.positive;
        default = 4096;
        description = "The zram device's size at most, in MiB (uncompressed; zstd stores it in about a third).";
      };
    };
  };

  config = {
    # Swap in RAM (NX-146). zram-generator (via nixpkgs' zramSwap) sizes /dev/zram0 at boot from MemTotal, loads the
    # module (CONFIG_ZRAM=m, zstd backend built in) and swaps on before swap.target, so systemd-oomd (After=swap.target)
    # starts with swap. Pages in zram cost RAM-speed decompression, not disk IO: swappiness above 100 makes the kernel
    # page cold anonymous memory out before it drops file cache (PostgreSQL's tables, the Nix store's code), as the
    # kernel's sysctl documentation advises for in-memory swap; page-cluster 0 reads one page per fault (readahead only
    # pays on seeking disks). zswap stays off: in front of zram it would compress every page twice.
    zramSwap = lib.mkIf cfg.swap.enable {
      enable = true;
      algorithm = "zstd";
      inherit (cfg.swap) memoryPercent;
      memoryMax = cfg.swap.maxMiB * 1024 * 1024;
    };
    boot.kernel.sysctl = lib.mkIf cfg.swap.enable {
      "vm.swappiness" = lib.mkDefault 180;
      "vm.page-cluster" = lib.mkDefault 0;
    };
    boot.kernelParams = lib.mkIf cfg.swap.enable [ "zswap.enabled=0" ];

    # The parent of the slices: a cgroup's memory.min counts only up to its parent's, so whombat.slice carries the
    # critical slice's protection (NX-19's 1G on the critical slice alone protected nothing, NX-142). Nothing else of
    # it is protected: the tasks compete with the containers.
    systemd.slices.whombat = {
      description = "Whombat";
      sliceConfig = {
        MemoryMin = criticalMin;
        MemoryLow = criticalMin;
      };
    };
    # Each core unit's own share of the protection (NX-142).
    systemd.services = lib.mapAttrs (_: mib: {
      serviceConfig.MemoryMin = "${toString mib}M";
    }) cfg.critical.units;
    systemd.slices.whombat-critical = {
      description = "Whombat critical services (PostgreSQL, manager, interactive API, the commands' network)";
      sliceConfig = {
        CPUWeight = cfg.critical.cpuWeight;
        IOWeight = cfg.critical.ioWeight;
        MemoryMin = criticalMin;
        MemoryLow = criticalMin;
        ManagedOOMPreference = "avoid";
      };
    };
    systemd.slices.whombat-tasks = {
      description = "Whombat agent tasks (runner, sandboxes and the agent's containers)";
      sliceConfig = {
        CPUWeight = cfg.tasks.cpuWeight;
        IOWeight = cfg.tasks.ioWeight;
        MemoryHigh = cfg.tasks.memoryHigh;
        MemoryMax = cfg.tasks.memoryMax;
        # No swap (NX-146): a page in zram is charged to no cgroup, so swapping would take a runaway task past
        # MemoryMax into Whombat's reserve. Its memory pressure (oomd's 80 %) is therefore the RAM's alone.
        MemorySwapMax = "0";
        TasksMax = cfg.tasks.tasksMax;
        ManagedOOMMemoryPressure = "kill";
        ManagedOOMMemoryPressureLimit = "80%";
      }
      // lib.optionalAttrs (cfg.tasks.cpuQuota != null) { CPUQuota = cfg.tasks.cpuQuota; };
    };
    # Unchanged with swap (NX-146): oomd watches the tasks slice's memory pressure only. No ManagedOOMSwap= anywhere: it
    # kills the cgroup that uses the most swap, which can't be a container or a task (they have none), so it would pick
    # Whombat's own services, against NX-142's order (the containers first). The kernel's OOM killer keeps that order.
    systemd.oomd = {
      enable = true;
      enableRootSlice = false;
    };
  };
}
