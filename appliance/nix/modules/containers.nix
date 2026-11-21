# The agent's containers (Whombat one-person.md OP-16, OP-19; the brief's I-2 and I-5; NX-457…NX-463): rootless Podman
# with Docker's API, run as its own user, `whombat-containers`, which owns nothing of Whombat's. The agent's commands
# reach it through its socket (the runner binds it into their wrapper, `DOCKER_HOST`), so `docker`, `docker build` and
# `docker compose` work; the server lists and stops the agent's services through the same socket.
#
# - The engine (NX-457): `podman system service` on the socket `/run/whombat-containers/podman.sock` (socket-activated,
#   0660, group whombat-containers: the runner and the server), its own subordinate ids (`idRange`, never the runner's
#   sandbox range), its configuration from the store (CONTAINERS_CONF, CONTAINERS_STORAGE_CONF,
#   CONTAINERS_REGISTRIES_CONF). Containers live in the unit's own cgroup (`cgroups = "split"` under Delegate=yes), in
#   the tasks' slice, every process at oom_score_adj 500 (the computers' score, MP-02, NX-142), no swap (NX-146).
# - Storage (NX-458): the subvolume /persist/containers (images, containers, their volumes, the engine's home and
#   temporary files) in the qgroup 1/101 with a limit of its own (`storagePercent` of /persist), inside 2/100, the one that
#   keeps the database's reserve (NX-12). Not backed up: a restored box pulls the images again.
# - What the engine sees (NX-459): of /persist only its storage, the agent's home and the workspaces (bind mounts reach
#   nothing else, OP-16); Whombat's sockets and data are out of its sight. Containers keep the engine's groups
#   (`run.oci.keep_original_groups`), so a container's process may write what the agent's commands write there.
# - Network (NX-460): the containers' traffic leaves through pasta as this user: the agent's wall (agent.nix,
#   `agent_wall`: the Vault's home networks, the local network, public addresses but port 25), and nothing on this host
#   but the resolver stub.
# - Published ports (OP-19, I-5; NX-461): 20000–20099 (`publishPorts`), new connections from private networks only (the
#   home network, Tailscale), never the internet, and from this host only the agent's commands through their proxy. The
#   engine's own listeners on this host take nothing else (a table loaded with the unit: a listener of its cgroup on any
#   other port, Whombat's own included, gets no connection).
# - Start and stop (NX-462): the containers with a restart policy come back when the engine starts after a boot; all of
#   them stop cleanly (their own stop signal, 10 s) before the host goes down. A host activation leaves the engine and
#   its containers running. Podman's path without the store's mount point resolves (a link at the root), so conmon's
#   cleanup of an exited container runs.
# - The computers' leftovers (NX-463): once a boot of this release is blessed, `whombat-computers-cleanup` deletes what
#   Incus kept on /persist and the root file system, and logs it.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.containers;
  inherit (lib) mkOption types;
  p = config.whombat.persistDir;
  ids = config.whombat.ids;
  sb = config.whombat.sandbox.uidRange;
  r = cfg.idRange;
  user = "whombat-containers";

  dir = "/run/whombat-containers";
  socket = "${dir}/podman.sock";
  # XDG_RUNTIME_DIR: the engine's run state (the storage's runroot, libpod's tmp_dir, the pause process). Kept across
  # restarts of the engine (tmpfiles, not RuntimeDirectory=), emptied by a boot, which tells Podman to refresh.
  xdg = "${dir}/xdg";
  storage = "${p}/containers";
  graphroot = "${storage}/storage";
  home = "${storage}/home";
  tmp = "${storage}/tmp";
  agentHome = config.whombat.agent.home;
  workspaces = "${p}/whombat/workspaces";

  publish = "${toString cfg.publishPorts.from}-${toString cfg.publishPorts.to}";
  # Where a published port may be opened from (RA-43, NX-138): private networks (RFC 1918, CGNAT with Tailscale,
  # link-local; ULA and IPv6 link-local).
  private4 = "10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16";
  private6 = "fc00::/7, fe80::/10";
  # The agent's commands' connections to its own published ports on this host carry this conntrack mark (agent.nix);
  # nothing else from this host opens one.
  ownMark = config.whombat.agent.servicesMark;
  slice = "whombat.slice/whombat-tasks.slice";
  cgroupPath = "${slice}/whombat-containers.service";

  podman = cfg.package;
  toml = pkgs.formats.toml { };
  containersConf = toml.generate "containers.conf" {
    containers = {
      # Containers inherit the unit's 500 anyway; said here so the engine never asks for less (MP-02, NX-142).
      oom_score_adj = 500;
      # In the unit's own cgroup (Delegate=yes): the container and its conmon in sub-cgroups of it.
      cgroups = "split";
      # The engine's groups for every container's processes (crun's annotation): whombat-containers and
      # whombat-workspaces, so a bind mount of the agent's home or a workspace is writable inside, whatever user the
      # image runs as.
      annotations = [ "run.oci.keep_original_groups=1" ];
      log_driver = "k8s-file";
      log_size_max = 10 * 1024 * 1024;
      pids_limit = 4096;
      tz = "local";
    };
    engine = {
      cgroup_manager = "cgroupfs";
      events_logger = "file";
      events_logfile_max_size = "1m";
      runtime = "crun";
      init_path = "${pkgs.catatonit}/bin/catatonit";
      # Image layers are unpacked and builds' contexts kept on /persist, inside the storage's limit (not /var/tmp).
      image_copy_tmp_dir = tmp;
      # A container's own stop timeout, as Docker's default.
      stop_timeout = 10;
    };
    network = {
      network_backend = "netavark";
      firewall_driver = "nftables";
      default_rootless_network_cmd = "pasta";
    };
  };
  storageConf = toml.generate "storage.conf" {
    storage = {
      driver = "overlay";
      inherit graphroot;
      runroot = "${xdg}/containers";
      # The kernel's own overlay in a user namespace (Linux 5.13 and later): no fuse-overlayfs.
      options.overlay.mountopt = "nodev";
    };
  };
  # Short names like Docker's (`nginx` is docker.io/library/nginx), never a prompt.
  registriesConf = toml.generate "registries.conf" {
    unqualified-search-registries = [ "docker.io" ];
    short-name-mode = "permissive";
  };

  environment = {
    HOME = home;
    XDG_RUNTIME_DIR = xdg;
    TMPDIR = tmp;
    CONTAINERS_CONF = "${containersConf}";
    CONTAINERS_STORAGE_CONF = "${storageConf}";
    CONTAINERS_REGISTRIES_CONF = "${registriesConf}";
  };
  podmanBin = "${podman}/bin/podman";

  # The engine's listeners on this host (pasta's and rootlessport's forwards, in its cgroup) get no connection but on a
  # published port (NX-461): one of them on a port of Whombat's own (the server's 4620 while it restarts, the direct
  # port) would otherwise take what the runner or a person's device sent there. Loaded once the cgroup exists (nft
  # resolves cgroup paths at load time, as the runner's wall, sandbox.nix).
  listenRules = pkgs.writeText "whombat-containers-listen.nft" ''
    table inet whombat_containers {
      chain input {
        type filter hook input priority filter - 2; policy accept;
        ct state new socket cgroupv2 level 3 "${cgroupPath}" tcp dport != ${publish} counter drop comment "containers: listeners on published ports only"
        ct state new socket cgroupv2 level 3 "${cgroupPath}" meta l4proto udp counter drop comment "containers: no UDP from outside"
      }
    }
  '';
  nft = "${pkgs.nftables}/bin/nft";
  listenLoad = pkgs.writeShellScript "whombat-containers-listen-load" ''
    ${nft} delete table inet whombat_containers 2>/dev/null || true
    ${nft} -f ${listenRules}
  '';
  listenUnload = pkgs.writeShellScript "whombat-containers-listen-unload" ''
    ${nft} delete table inet whombat_containers 2>/dev/null || true
  '';

  # The containers with a restart policy, when the engine starts (after a boot, Podman's refresh has reset them).
  restart = pkgs.writeShellScript "whombat-containers-restart" ''
    ${podmanBin} start --all --filter restart-policy=always --filter restart-policy=unless-stopped
  '';
  # Every container, before the engine stops (the host's shutdown): each with its own stop signal and timeout.
  stopAll = pkgs.writeShellScript "whombat-containers-stop" ''
    ${podmanBin} stop --all --time 10 || true
  '';

  # whombat-computers-cleanup (NX-463): what the agents' computers left (computers.nix, NX-129…NX-151). Incus's state
  # and its pools on /persist (subvolumes with the computers' own subvolumes nested in them, read-only image snapshots
  # among them), the mount points and computerd's and the move's state on the root file system. Nothing is kept: a
  # computer's files were never backed up (NX-130), and its agent has none any more (OP-04).
  cleanup = pkgs.writeShellScript "whombat-computers-cleanup" ''
    set -u
    PATH=${
      lib.makeBinPath [
        pkgs.btrfs-progs
        pkgs.coreutils
        pkgs.util-linux
        pkgs.findutils
        pkgs.gawk
      ]
    }
    gone=0
    size() { du -sxB1 "$1" 2>/dev/null | cut -f1; }
    gib() { awk -v b="''${1:-0}" 'BEGIN { printf "%.1f GiB", b / 1073741824 }'; }
    for d in ${p}/incus-computers ${p}/incus-pool ${p}/incus; do
      [ -e "$d" ] || continue
      if mountpoint -q "$d"; then umount -R "$d" || { echo "$d is still mounted: left for the next boot" >&2; continue; }; fi
      was=$(size "$d")
      if btrfs subvolume show "$d" >/dev/null 2>&1; then
        # The subvolumes nested in it (the computers, their images, Docker's on a computer) writable first: a read-only
        # one can't lose what is in it. Then all of them at once.
        rel=''${d#${p}/}
        btrfs subvolume list ${p} 2>/dev/null | awk '{print $NF}' | while read -r path; do
          case "$path" in "$rel"/*) btrfs property set -ts "${p}/$path" ro false 2>/dev/null || true ;; esac
        done
        if btrfs subvolume delete -R -c "$d" >/dev/null; then
          echo "deleted $d ($(gib "$was")), the agents' computers' storage"
          gone=1
        else
          echo "$d couldn't be deleted: left for the next boot" >&2
        fi
      elif rm -rf --one-file-system "$d"; then
        echo "deleted $d ($(gib "$was")), the agents' computers' storage"
        gone=1
      else
        echo "$d couldn't be deleted: left for the next boot" >&2
      fi
    done
    for d in /var/lib/incus /var/lib/incus-pool /var/lib/whombat-computerd /var/lib/whombat-computers-move /var/lib/lxcfs; do
      [ -e "$d" ] || continue
      mountpoint -q "$d" && { echo "$d is mounted: left" >&2; continue; }
      rm -rf --one-file-system "$d" && echo "deleted $d" && gone=1
    done
    if [ "$gone" = 1 ]; then
      btrfs qgroup clear-stale ${p} >/dev/null 2>&1 || true
      echo "the agents' computers are gone from this Whombat"
    fi
    exit 0
  '';
in
{
  options.whombat.containers = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        The agent's containers (Whombat OP-16, OP-19): rootless Podman with Docker's API as `whombat-containers`, its
        storage, wall and published ports; the runner's and the server's WHOMBAT_CONTAINERS_SOCKET. On in every
        appliance profile (nix/profiles/appliance.nix); VM tests opt in.
      '';
    };
    package = mkOption {
      type = types.package;
      default = pkgs.podman.override {
        # newuidmap and newgidmap (set-uid wrappers) for the engine's subordinate ids.
        extraPackages = [ "/run/wrappers" ];
        # crun only (the package's default runtime), not runc as well.
        extraRuntimes = [ ];
      };
      defaultText = lib.literalExpression ''pkgs.podman.override { extraPackages = [ "/run/wrappers" ]; extraRuntimes = [ ]; }'';
      description = "Podman (its helpers: crun, conmon, netavark, aardvark-dns, pasta, catatonit).";
    };
    idRange = mkOption {
      default = { };
      description = ''
        The engine's subordinate uids and gids (each container's users, root included, map into them). Never the
        runner's sandbox range (`whombat.sandbox.uidRange`).
      '';
      type = types.submodule {
        options = {
          start = mkOption {
            type = types.int;
            default = 3000000;
          };
          count = mkOption {
            type = types.int;
            default = 65536;
          };
        };
      };
    };
    publishPorts = {
      from = mkOption {
        type = types.port;
        default = 20000;
        description = "The first of the ports the agent's services publish (Whombat OP-19, RA-43).";
      };
      to = mkOption {
        type = types.port;
        default = 20099;
        description = ''
          The last of the ports the agent's services publish (Whombat OP-19, NX-138): a container's published port in
          `from`–`to` opens to new connections from private networks only (RFC 1918, CGNAT, link-local, ULA), never the
          internet, and from this host only to the agent's commands through their proxy.
        '';
      };
    };
    storagePercent = mkOption {
      type = types.ints.between 5 90;
      default = 50;
      description = ''
        The containers may hold at most this share of /persist (the limit of their qgroup 1/101, NX-458), inside the
        limit that keeps the database's reserve (NX-12). When it is full, containers can't write; Whombat itself can.
      '';
    };
    socket = mkOption {
      type = types.str;
      default = socket;
      readOnly = true;
      description = "The engine's Docker API socket (WHOMBAT_CONTAINERS_SOCKET of the runner and the server).";
    };
    storage = mkOption {
      type = types.str;
      default = storage;
      readOnly = true;
      description = "The containers' storage, a subvolume of its own (not backed up).";
    };
    environment = mkOption {
      type = types.attrsOf types.str;
      default = environment;
      readOnly = true;
      internal = true;
      description = "The engine's environment (the flake checks and the VM test read it).";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = r.start >= sb.start + sb.count || r.start + r.count <= sb.start;
        message = "whombat.containers.idRange overlaps whombat.sandbox.uidRange";
      }
      {
        assertion = r.start >= 1000000 && r.count >= 65536;
        message = "whombat.containers.idRange must start above 1000000 and hold at least 65536 ids";
      }
      {
        # Above the privileged ports, below the kernel's ephemeral range (32768–60999: a listener there could take the
        # port of an outgoing connection), at most 1000.
        assertion =
          let
            pp = cfg.publishPorts;
          in
          pp.from >= 1024 && pp.from <= pp.to && pp.to < 32768 && pp.to - pp.from < 1000;
        message = "whombat.containers.publishPorts: from ≤ to, within 1024–32767, at most 1000 ports.";
      }
      {
        assertion = config.whombat.agent.enable;
        message = "whombat.containers needs whombat.agent (the agent's home and its wall)";
      }
    ];

    # ---- The account (NX-457) ----------------------------------------------------------------------------------------
    users.users.${user} = {
      isSystemUser = true;
      uid = ids.whombat-containers;
      group = user;
      # The workspaces' group: bind mounts of a workspace (OP-16); the containers keep it (keep_original_groups).
      extraGroups = [ "whombat-workspaces" ];
      home = "/var/empty";
      createHome = false;
      shell = "/run/current-system/sw/bin/nologin";
      subUidRanges = [
        {
          startUid = r.start;
          count = r.count;
        }
      ];
      subGidRanges = [
        {
          startGid = r.start;
          count = r.count;
        }
      ];
    };
    users.groups.${user}.gid = ids.whombat-containers;
    users.users.whombat.extraGroups = [ user ];
    users.users.whombat-runner.extraGroups = [ user ];

    # newuidmap and newgidmap with file capabilities, not set-uid root (as Fedora and Debian ship them): they run as the
    # engine's uid, the owner of the user namespace they map, with only CAP_SETUID or CAP_SETGID. Set-uid root, they
    # would need CAP_SYS_ADMIN (root isn't the namespace's owner) and CAP_DAC_OVERRIDE (the map is the engine's file).
    security.wrappers.newuidmap = {
      setuid = lib.mkForce false;
      capabilities = "cap_setuid+ep";
    };
    security.wrappers.newgidmap = {
      setuid = lib.mkForce false;
      capabilities = "cap_setgid+ep";
    };

    # Rootless containers: the kernel's overlay and pasta's tap device.
    boot.kernelModules = [
      "overlay"
      "tun"
    ];
    # The engine's policy for image signatures, as Docker's: accept what the registry serves (the only file it reads
    # from /etc).
    environment.etc."containers/policy.json".text = builtins.toJSON {
      default = [ { type = "insecureAcceptAnything"; } ];
    };

    # ---- Storage (NX-458) ------------------------------------------------------------------------------------------
    whombat.storage.containers = {
      subvolumes = [ (lib.removePrefix "${p}/" storage) ];
      percent = cfg.storagePercent;
    };
    systemd.tmpfiles.settings."20-whombat-containers" = {
      ${storage}.d = {
        mode = "0700";
        inherit user;
        group = user;
      };
      ${graphroot}.d = {
        mode = "0700";
        inherit user;
        group = user;
      };
      ${home}.d = {
        mode = "0700";
        inherit user;
        group = user;
      };
      # Emptied at every boot: unpacked layers and build contexts left by a crash.
      ${tmp}.D = {
        mode = "0700";
        inherit user;
        group = user;
      };
      # The socket's directory: the runner and the server traverse it (group).
      ${dir}.d = {
        mode = "0750";
        inherit user;
        group = user;
      };
      ${xdg}.d = {
        mode = "0700";
        inherit user;
        group = user;
      };
      # A workspace like the agent's home (NX-459): what a container makes in one (as the engine's ids, with the
      # workspaces' group) stays writable for the runner, and what the runner makes for the containers, whatever umask
      # made it. Default ACLs on the root, inherited by everything made under it from now on.
      "${workspaces}"."a+".argument = lib.concatStringsSep "," [
        "group:whombat-workspaces:rwx"
        "default:user:whombat-runner:rwx"
        "default:group:whombat-workspaces:rwx"
        "default:mask::rwx"
      ];
      # Podman's own path as the engine sees it (NX-462): a Podman that joined the pause process's mount namespace
      # from the unit's reads /proc/self/exe without the store's mount point, `/<hash>-podman-<version>/bin/…`, and
      # gives conmon that as the exit command (`podman container cleanup`). Without it a stopped container is never
      # cleaned up or removed, so `docker run --rm` never returns. This link makes that path the package's.
      "/${builtins.unsafeDiscardStringContext (builtins.baseNameOf "${podman}")}"."L+".argument = "${podman}";
    };

    # ---- The engine (NX-457, NX-459, NX-462) -----------------------------------------------------------------------
    systemd.sockets.whombat-containers = {
      description = "The agent's container engine (Docker's API)";
      wantedBy = [ "sockets.target" ];
      socketConfig = {
        ListenStream = socket;
        SocketUser = user;
        SocketGroup = user;
        SocketMode = "0660";
        DirectoryMode = "0750";
      };
    };
    systemd.services.whombat-containers = {
      description = "The agent's container engine (rootless Podman)";
      # At boot too, not only when someone connects: the containers with a restart policy come back. With the runtime's
      # target as well (provisioning starts it), never part of it: a runtime update leaves the containers running.
      wantedBy = [
        "multi-user.target"
        "whombat-runtime.target"
      ];
      requires = [ "whombat-containers.socket" ];
      wants = [ "network-online.target" ];
      after = [
        "whombat-containers.socket"
        "network-online.target"
        "nftables.service"
        "whombat-persist.target"
        "systemd-tmpfiles-setup.service"
        # Whombat's own listeners first (NX-461 holds anyway).
        "whombat-runtime.target"
      ];
      unitConfig = {
        RequiresMountsFor = [ p ];
        # Nothing of the agent's before provisioning.
        ConditionPathExists = "${p}/identity/device.json";
      };
      # A host activation leaves the engine and its containers running (its new unit at the next boot).
      restartIfChanged = false;
      stopIfChanged = false;
      # Not systemd's tools, which NixOS puts on every unit's PATH: netavark starts aardvark-dns (compose's DNS) with
      # `systemd-run --user --scope` when it finds systemd-run, and the engine has no user manager; without it,
      # aardvark-dns is netavark's own child, in the engine's cgroup.
      environment = environment // {
        PATH = lib.mkForce "${
          lib.makeBinPath [
            podman
            pkgs.coreutils
            pkgs.util-linux
          ]
        }:/run/wrappers/bin";
      };
      serviceConfig = {
        Type = "exec";
        User = user;
        Group = user;
        # The engine's user namespace (Podman's pause process) first: the API process and the restart below would
        # otherwise both make it at once, and the API, re-executed into it, loses its socket from systemd.
        ExecStartPre = "${podmanBin} unshare true";
        ExecStart = "${podmanBin} system service --time=0";
        ExecStartPost = [
          "+${listenLoad}"
          "-${restart}"
        ];
        ExecStop = stopAll;
        ExecStopPost = [ "+${listenUnload}" ];
        # The containers outlive a crash of the API process (conmon keeps them); ExecStop stopped them on a stop.
        KillMode = "process";
        Restart = "on-failure";
        RestartSec = "2s";
        TimeoutStopSec = "120s";
        Delegate = "yes";
        Slice = "whombat-tasks.slice";
        # Every process in a container at 500, as the computers' (MP-02, NX-142): the first the kernel kills.
        OOMScoreAdjust = 500;
        MemorySwapMax = "0";
        TasksMax = 4096;
        LimitNOFILE = 1048576;
        UMask = "0022";

        # What it sees (NX-459): of /persist its storage, the agent's home and the workspaces; nothing of Whombat's.
        TemporaryFileSystem = [ "${p}:ro" ];
        BindPaths = [
          storage
          agentHome
          workspaces
        ];
        InaccessiblePaths = [
          "-/run/postgresql"
          "-/run/whombat"
          "-/run/whombat-manager"
          "-/run/whombat-backup"
          "-/run/whombat-update-helper"
          "-/run/whombat-vault"
          "-/run/whombat-clients"
          "-/run/whombat-agent-net"
          "-/run/whombat-runner"
          "-/run/credentials"
          "-/var/lib/whombat-runner"
          "-/boot"
        ];
        ProtectSystem = "strict";
        ReadWritePaths = [
          storage
          agentHome
          workspaces
          dir
        ];
        ProtectHome = true;
        PrivateTmp = true;
        # newuidmap/newgidmap carry file capabilities (below): no NoNewPrivileges, and the bounding set is what their
        # wrappers may raise (CAP_SETPCAP only to put the other into the ambient set). The engine itself has none.
        NoNewPrivileges = false;
        CapabilityBoundingSet = [
          "CAP_SETPCAP"
          "CAP_SETUID"
          "CAP_SETGID"
        ];
        AmbientCapabilities = "";
        # pasta's tap device; the rest of /dev a container gets is the usual null, zero, random, tty and pts.
        DevicePolicy = "closed";
        DeviceAllow = [ "/dev/net/tun rw" ];
        # crun mounts a container's own proc and sys: the locked mounts these make would refuse it (as the runner's
        # bubblewrap, NX-69, NX-73); it makes cgroups under its own (Delegate).
        ProtectKernelTunables = false;
        ProtectKernelLogs = false;
        ProtectControlGroups = false;
        ProtectKernelModules = true;
        ProtectClock = true;
        ProtectHostname = false;
        # Not `invisible`: the set-uid newuidmap (no ptrace capability) must see the engine's own child in /proc.
        ProtectProc = "default";
        LockPersonality = true;
        RestrictRealtime = true;
        RemoveIPC = false;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
        SystemCallArchitectures = "native";
        MemoryDenyWriteExecute = false;
        LimitCORE = 0;
      };
    };

    # ---- The runner and the server (I-2): the socket through its group --------------------------------------------
    systemd.services.whombat-runner = {
      environment.WHOMBAT_CONTAINERS_SOCKET = socket;
      serviceConfig.SupplementaryGroups = [ user ];
    };
    systemd.services.whombat-server = {
      environment.WHOMBAT_CONTAINERS_SOCKET = socket;
      serviceConfig.SupplementaryGroups = [ user ];
    };

    # ---- Published ports (OP-19, I-5; NX-461) ----------------------------------------------------------------------
    # The NixOS firewall's input chain drops everything not listed: the published ports from private networks. The
    # egress table's containers_published drops every other new connection to them first, this host's included but the
    # agent's commands' (their proxy marks its connections, agent.nix).
    networking.firewall.extraInputRules = ''
      ip saddr { ${private4} } tcp dport ${publish} accept comment "the agent's services (Whombat OP-19)"
      ip6 saddr { ${private6} } tcp dport ${publish} accept comment "the agent's services (Whombat OP-19)"
    '';
    networking.nftables.tables.whombat-egress.content = lib.mkAfter ''
      # ---- The agent's containers (Whombat OP-16, OP-19; NX-460, NX-461). ---------------------------------------
      chain containers_input {
        type filter hook input priority filter - 1; policy accept;
        tcp dport ${publish} ct state new jump containers_published
      }
      chain containers_published {
        iifname "lo" ct mark ${ownMark} return comment "published ports: the agent's commands, through their proxy"
        iifname "lo" counter reject with icmpx admin-prohibited comment "published ports: not from this host"
        ip saddr { ${private4} } return
        ip6 saddr { ${private6} } return
        counter drop comment "published ports: private networks only"
      }
      # The engine's own connections (image pulls) and the containers' (through pasta): the agent's wall, and on this
      # host only the resolver stub (pasta forwards the containers' DNS to it).
      chain containers_out {
        ct mark ${config.whombat.network.vaultMark} jump vault_established
        ct state established,related accept
        oifname "lo" ip daddr { 127.0.0.53, 127.0.0.54 } meta l4proto { tcp, udp } th dport 53 accept comment "containers: the resolver stub"
        oifname "lo" counter reject with icmpx admin-prohibited comment "containers: nothing on this host"
        goto agent_wall
      }
    '';
    whombat.network.uidChains = [
      {
        uid = ids.whombat-containers;
        chain = "containers_out";
      }
    ];

    # ---- The computers' leftovers (NX-463) -------------------------------------------------------------------------
    systemd.services.whombat-computers-cleanup = {
      description = "Remove what the agents' computers left on this Whombat";
      # Once this release's boot is blessed: a fallback to a release with computers still finds them until then.
      wantedBy = [ "boot-complete.target" ];
      after = [
        "boot-complete.target"
        "systemd-bless-boot.service"
      ];
      unitConfig = {
        RequiresMountsFor = [ p ];
        ConditionPathExists = [
          "|${p}/incus"
          "|${p}/incus-computers"
          "|${p}/incus-pool"
          "|/var/lib/incus"
          "|/var/lib/whombat-computerd"
        ];
      };
      serviceConfig = {
        Type = "oneshot";
        ExecStart = cleanup;
        TimeoutStartSec = "30min";
        Nice = 10;
        IOSchedulingClass = "idle";
      };
    };
  };
}
