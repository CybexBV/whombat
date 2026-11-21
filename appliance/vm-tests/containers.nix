# The agent's containers and its commands' network on the appliance (Whombat one-person.md OP-07, OP-13, OP-16, OP-19;
# the brief's I-1…I-5; NX-455…NX-466), on the test network (common/lan.nix: 1.2.3.4 is "public", 192.168.1.1 private,
# 169.254.169.254 metadata), with a stand-in commands' network daemon in the runtime bundle (it listens on its socket and
# says who it runs as):
#   - nothing of Incus or the computers: no daemon, client, units, users, tables, bridge or state; the cleanup after a
#     blessed boot deletes what an older box kept (nested and read-only subvolumes among it) and logs it
#   - the engine: rootless Podman as whombat-containers (971) with its own subordinate ids, the socket 0660 for the
#     runner's and the server's groups only, its storage on /persist/containers in the qgroup 1/101 with a limit
#   - through the socket with the agent's docker CLI, as the runner: an image loaded, built (Docker's classic builder) and
#     run, compose up; a container's processes as the engine's ids (root as 971, others in its range), at
#     oom_score_adj 500; bind mounts of the agent's home and a workspace writable both ways, nothing of Whombat's
#   - a container's published port in 20000–20099 opens from a private address, not from a public one, not outside the
#     range, not from this host but the agent's commands' proxy; a container's listener on another port of this host
#     gets no connection (NX-461)
#   - from a container and as the commands' proxy's uid: public addresses on any port but 25; never a private, metadata
#     or denied address or this host (but the resolver stub); the Vault's home networks open and close; DNS works
#   - the commands' network daemon's unit: its uid, socket directory for the runner only, nothing of /persist
#   - the agent's tools and nix-ld: a program not built for Nix runs with the commands' NIX_LD settings
#   - a reboot: the container with a restart policy is back and serving, the others were stopped with their own signal
{
  applianceModules,
  pkgs,
  lib,
  ...
}:
let
  lan = import ./common/lan.nix { inherit pkgs lib; };
  inherit (lan) pub4 priv4 meta4;
  denied4 = "1.2.3.7"; # public, but in whombat.agent.deny
  hostPort = 9999; # a service on the appliance that its own firewall admits from the LAN
  me = "192.168.1.2"; # the appliance on the test network
  me4 = "1.2.3.5"; # its "public" address there

  # A tiny image: busybox, a page on 8080.
  image = pkgs.dockerTools.buildImage {
    name = "wbtest";
    tag = "1";
    copyToRoot = pkgs.buildEnv {
      name = "wbtest-root";
      paths = [
        pkgs.busybox
        (pkgs.writeTextDir "www/index.html" "container page")
      ];
      pathsToLink = [
        "/bin"
        "/www"
      ];
    };
    config.Cmd = [
      "/bin/httpd"
      "-f"
      "-p"
      "8080"
      "-h"
      "/www"
    ];
  };

  # The stand-in commands' network daemon: listens on its socket and answers who it runs as.
  netStub = pkgs.writeText "agent-net-stub.py" ''
    import json, os, socket
    sock = os.environ["WHOMBAT_AGENT_NET_SOCKET"]
    try:
        os.unlink(sock)
    except FileNotFoundError:
        pass
    s = socket.socket(socket.AF_UNIX)
    s.bind(sock)
    s.listen(8)
    while True:
        c, _ = s.accept()
        with c:
            caps = [l.split()[1] for l in open("/proc/self/status") if l.startswith(("CapEff", "CapBnd"))]
            c.sendall((json.dumps({"uid": os.getuid(), "gid": os.getgid(), "groups": sorted(os.getgroups()),
                                   "caps": caps, "persist": os.path.exists("/persist/whombat"),
                                   "env": {k: v for k, v in os.environ.items() if k.startswith("WHOMBAT_")}}) + "\n").encode())
  '';
  standin = pkgs.whombat-standin-runtime;
  runtime =
    pkgs.runCommand "whombat-runtime-standin-agent-net"
      {
        passthru = {
          whombatStandIn = true;
          inherit (standin) version;
        };
      }
      ''
        mkdir -p $out/bin $out/share/whombat
        for f in whombat-server whombat-runner; do ln -s ${standin}/bin/$f $out/bin/$f; done
        cp ${standin}/share/whombat/bundle.json $out/share/whombat/
        cat > $out/bin/whombat-agent-net <<EOF
        #!${pkgs.runtimeShell}
        exec ${pkgs.python3}/bin/python3 ${netStub}
        EOF
        chmod 0755 $out/bin/whombat-agent-net
      '';

  # ask SOCKET: the stand-in daemon's one line.
  ask = pkgs.writeText "agent-net-ask.py" ''
    import socket, sys
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(10)
    s.connect(sys.argv[1])
    print(s.makefile().readline().strip())
  '';

  # A program built for another Linux: xz with the usual loader and no Nix paths (nix-ld runs it, NX-464).
  foreign = pkgs.runCommand "foreign-xz" { nativeBuildInputs = [ pkgs.patchelf ]; } ''
    cp ${pkgs.xz.bin}/bin/xz $out
    chmod u+w $out
    patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 --remove-rpath $out
  '';

  compose = pkgs.writeText "compose.yml" ''
    services:
      web:
        image: wbtest:1
        ports: ["20002:8080"]
        labels:
          whombat.service: "1"
  '';
  dockerfile = pkgs.writeTextDir "Dockerfile" ''
    FROM wbtest:1
    RUN echo built > /www/built.html
  '';
in
{
  name = "whombat-containers";

  nodes = {
    control =
      { pkgs, lib, ... }:
      {
        imports = [ lan.control ];
        networking.interfaces.eth1.ipv4.addresses = lib.mkAfter [
          {
            address = denied4;
            prefixLength = 24;
          }
        ];
        # An SMTP port answering HTTP, so a refusal can't be mistaken for a closed port.
        networking.firewall.allowedTCPPorts = [ 25 ];
        systemd.services.smtp-http = {
          wantedBy = [ "multi-user.target" ];
          serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server 25 --directory ${pkgs.writeTextDir "index.html" "smtp port"}";
        };
      };
    machine =
      { lib, ... }:
      {
        imports = applianceModules ++ [
          (import ./common/appliance-vm.nix { serial = "SN-CTR-0001"; })
          lan.machine
        ];
        # The closed wall this test checks: only the Vault's list opens private addresses (NX-144 opens the rest).
        whombat.network.localNetwork = false;
        virtualisation.memorySize = 3072;
        virtualisation.diskSize = 4096;
        # As on a box: /persist is nosuid,nodev (storage.nix).
        virtualisation.fileSystems."/persist".options = lib.mkAfter [
          "nosuid"
          "nodev"
        ];
        virtualisation.emptyDiskImages = lib.mkForce [
          {
            size = 6144;
            driveConfig.deviceExtraOpts.serial = "persist";
          }
          {
            size = 64;
            driveConfig.deviceExtraOpts.serial = "factory";
          }
        ];
        whombat.runtime.package = runtime;
        whombat.agent = {
          enable = true;
          deny = [ "${denied4}/32" ];
        };
        whombat.containers.enable = true;
        # A service on this host that its own firewall admits from the LAN (the control node reaches it); a container
        # and the commands' proxy still mustn't.
        networking.firewall.extraInputRules = "tcp dport ${toString hostPort} accept";
        systemd.services.host-http = {
          wantedBy = [ "multi-user.target" ];
          serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server ${toString hostPort} --directory ${pkgs.writeTextDir "index.html" "host page"}";
        };
        environment.systemPackages = [
          pkgs.btrfs-progs
          pkgs.acl
        ];
      };
  };

  testScript =
    { nodes, ... }:
    let
      ag = nodes.machine.whombat.agent;
      cc = nodes.machine.whombat.containers;
      renv = nodes.machine.systemd.services.whombat-runner.environment;
    in
    lan.prelude
    + ''
      SOCK = "${cc.socket}"
      DOCKER = "${ag.tools}/bin/docker"
      AHOME = "${ag.home}"

      def docker(args, user="whombat-runner", check=True):
          cmd = as_user(user, f"env HOME={AHOME} DOCKER_HOST=unix://{SOCK} {DOCKER} {args}")
          return sh(cmd) if check else machine.execute(cmd + " 2>&1")

      def diag(what):
          print(f"--- {what}: the engine's journal and containers")
          print(machine.execute("journalctl -u whombat-containers.service -n 80 --no-pager -o cat")[1])
          print(machine.execute(as_user("whombat-runner", f"env HOME={AHOME} {DOCKER} ps -a"))[1])

      def attached(args, timeout=60):
          rc, out = machine.execute(
              f"timeout {timeout} " + as_user("whombat-runner", f"env HOME={AHOME} {DOCKER} run {args}") + " 2>&1")
          if rc != 0:
              diag(f"docker run {args} (exit {rc})")
          assert rc == 0, (args, rc, out)
          return out.strip()

      def in_ctr(name, cmd, timeout=15):
          rc, out = docker(f"exec {name} timeout {timeout} sh -c {shlex.quote(cmd)}", check=False)
          return rc, out.strip()

      def get(name, url):
          rc, out = in_ctr(name, f"wget -T 3 -q -O - {url}")
          return out if rc == 0 else None

      def counter(table, chain, comment):
          out = sh(f"nft list chain {table} {chain}")
          for line in out.splitlines():
              if comment in line and "packets" in line:
                  return int(line.split("packets")[1].split()[0])
          raise Exception(f"no counter {comment!r} in {chain}: {out}")

      def status_of(pid):
          return {l.split(":")[0]: l.split(":", 1)[1].split() for l in sh(f"cat /proc/{pid}/status").splitlines()}

      with subtest("nothing of Incus or the computers"):
          for unit in ["incus", "incus-instances", "whombat-computerd", "whombat-computers-lan", "lxcfs"]:
              machine.fail(f"systemctl cat {unit}.service")
          for cmd in ["incus", "incusd", "lxc-start"]:
              machine.fail(f"command -v {cmd}")
          machine.fail("id whombat-computerd")
          for group in ["incus-admin", "whombat-computers"]:
              machine.fail(f"getent group {group}")
          machine.fail("test -e /var/lib/incus")
          machine.fail("ls -d /persist/incus*")
          assert "root:" not in sh("cat /etc/subuid"), sh("cat /etc/subuid")
          tables = sh("nft list tables")
          assert "incus" not in tables and "whombat-computers" not in tables, tables
          assert "computers" not in sh("nft list table inet whombat-egress")
          assert "wbc" not in sh("ip -o link")

      with subtest("the engine: its user, ids, socket and storage"):
          assert sh("id -u whombat-containers") == "971"
          assert sh("id -u whombat-agent-net") == "962"
          assert "whombat-containers:3000000:65536" in sh("cat /etc/subuid")
          assert "whombat-runner:2000000:65536" in sh("cat /etc/subuid")
          for u in ["whombat", "whombat-runner"]:
              assert "whombat-containers" in sh(f"id -nG {u}").split(), u
          machine.wait_for_unit("whombat-containers.socket")
          machine.wait_for_unit("whombat-containers.service")
          assert sh(f"stat -c '%a %U %G' {SOCK}") == "660 whombat-containers whombat-containers"
          assert sh("stat -c '%a %U %G' /run/whombat-containers") == "750 whombat-containers whombat-containers"
          pid = sh("systemctl show -P MainPID whombat-containers.service")
          assert status_of(pid)["Uid"][0] == "971", status_of(pid)
          for user in ["whombat-runner", "whombat"]:
              assert docker("version --format '{{.Server.Version}}'", user=user), user
          for user in ["nobody", "whombat-console", "whombat-agent-net"]:
              rc, out = docker("version", user=user, check=False)
              assert rc != 0 and "permission denied" in out.lower(), (user, out)
          info = json.loads(docker("info --format '{{json .}}'"))
          assert info["DockerRootDir"] == "/persist/containers/storage", info["DockerRootDir"]
          assert sh("btrfs subvolume show /persist/containers | awk '/Subvolume ID:/ {print $3}'")
          sid = sh("btrfs subvolume show /persist/containers | awk '/Subvolume ID:/ {print $3}'")
          q = {g["qgroupid"]: g for g in json.loads(sh("btrfs --format json qgroup show -p /persist"))["qgroup-show"]}
          assert q[f"0/{sid}"]["parents"] == ["1/101"], q[f"0/{sid}"]
          assert isinstance(q["1/101"]["max_referenced"], int) and q["1/101"]["parents"] == ["2/100"], q["1/101"]

      with subtest("images, builds, containers and compose through the socket, as the runner"):
          docker("load -i ${image}")
          docker("run -d --name web -p 20001:8080 --label whombat.service=1 --restart always wbtest:1")
          assert docker("inspect -f '{{.State.Running}}' web") == "true"
          cpid = docker("inspect -f '{{.State.Pid}}' web")
          st = status_of(cpid)
          assert st["Uid"][0] == "971" and st["Gid"][0] == "971", st
          assert sh(f"cat /proc/{cpid}/oom_score_adj") == "500"
          assert "whombat-containers.service" in sh(f"cat /proc/{cpid}/cgroup"), sh(f"cat /proc/{cpid}/cgroup")
          docker("run -d --name other --user 1000:1000 wbtest:1 sleep 600")
          opid = docker("inspect -f '{{.State.Pid}}' other")
          assert status_of(opid)["Uid"][0] == "3000999", status_of(opid)
          machine.succeed(f"cp -r ${dockerfile} {AHOME}/ctx && chown -R whombat-runner {AHOME}/ctx")
          docker(f"build -t wbtest:2 {AHOME}/ctx")
          # Attached, as a command runs one: output, exit and removal (conmon's cleanup finds Podman, NX-462).
          podman = "${cc.package}"
          assert sh(f"readlink /{podman.removeprefix('/nix/store/')}") == podman
          assert attached("--rm wbtest:2 cat /www/built.html") == "built"
          rc, out = machine.execute("timeout 60 " + as_user("whombat-runner", f"env HOME={AHOME} {DOCKER} run --rm wbtest:1 sh -c 'exit 3'"))
          assert rc == 3, (rc, out)
          machine.succeed(f"cp ${compose} {AHOME}/compose.yml && chown whombat-runner {AHOME}/compose.yml")
          docker(f"compose -p demo -f {AHOME}/compose.yml up -d")
          labels = docker("ps --filter label=whombat.service=1 --format '{{.Names}} {{.Ports}}'")
          assert "web" in labels and "20001" in labels and "20002" in labels, labels

      with subtest("bind mounts: the agent's home and a workspace both ways, nothing of Whombat's"):
          # The agent's home and the workspaces keep what is made in them writable for both (default ACLs), whatever
          # umask made it (the runner's is 0077).
          machine.succeed(as_user("whombat-runner", f"sh -c 'umask 077; mkdir -p {AHOME}/src'"))
          machine.succeed(as_user("whombat-runner", "sh -c 'umask 077; mkdir -p /persist/whombat/workspaces/w1'"))
          attached(f"--rm -v {AHOME}/src:/app wbtest:1 sh -c 'echo from-root > /app/a'")
          attached(f"--rm --user 1000:1000 -v {AHOME}/src:/app wbtest:1 sh -c 'echo from-user > /app/b'")
          attached("--rm --user 1000:1000 -v /persist/whombat/workspaces/w1:/w wbtest:1 sh -c 'echo ws > /w/c'")
          # What a container made, the runner changes; what the runner makes, a container's user changes.
          machine.succeed(as_user("whombat-runner", f"sh -c 'echo again >> {AHOME}/src/a && echo again >> {AHOME}/src/b'"))
          machine.succeed(as_user("whombat-runner", "sh -c 'echo again >> /persist/whombat/workspaces/w1/c'"))
          machine.succeed(as_user("whombat-runner", f"sh -c 'echo mine > {AHOME}/src/d'"))
          attached(f"--rm --user 1000:1000 -v {AHOME}/src:/app wbtest:1 sh -c 'echo theirs >> /app/d'")
          assert sh(f"cat {AHOME}/src/d") == "mine\ntheirs"
          machine.succeed("touch /persist/secrets/marker /persist/whombat/home/marker")
          for path in ["/persist/secrets", "/persist/whombat/home", "/persist/identity", "/persist/whombat/credentials",
                       "/run/whombat", "/run/postgresql", "/var/lib/whombat-runner"]:
              rc, out = machine.execute("timeout 60 " + as_user("whombat-runner", f"env HOME={AHOME} {DOCKER} run --rm -v {path}:/x wbtest:1 ls /x") + " 2>&1")
              assert rc != 0 or "marker" not in out, (path, out)
          machine.succeed("rm /persist/secrets/marker /persist/whombat/home/marker")

      with subtest("published ports: from private networks only, and from this host only the commands' proxy"):
          control.wait_until_succeeds("curl -sf --max-time 3 http://${me}:20001/ | grep -q 'container page'", timeout=60)
          control.wait_until_succeeds("curl -sf --max-time 3 http://${me}:20002/ | grep -q 'container page'", timeout=60)
          n = counter("inet whombat-egress", "containers_published", "private networks only")
          control.fail("curl -sf --max-time 3 --interface ${pub4} http://${me4}:20001/")
          assert counter("inet whombat-egress", "containers_published", "private networks only") > n
          # Outside the range: the firewall has nothing open there.
          docker("run -d --name outside -p 20100:8080 wbtest:1")
          machine.wait_until_succeeds("ss -Htln | grep -q ':20100 '", timeout=30)
          control.fail("curl -sf --max-time 3 http://${me}:20100/")
          n = counter("inet whombat-egress", "containers_published", "not from this host")
          for user in ["root", "whombat", "whombat-runner"]:
              machine.fail(as_user(user, "curl -sf --max-time 3 http://127.0.0.1:20001/"))
          assert counter("inet whombat-egress", "containers_published", "not from this host") > n
          assert "container page" in sh(as_user("whombat-agent-net", "curl -sf --max-time 3 http://127.0.0.1:20001/"))
          # A container's listener on any other port of this host takes nothing (NX-461), Whombat's own ports included.
          docker("run -d --name squatter -p 127.0.0.1:9100:8080 wbtest:1")
          machine.wait_until_succeeds("ss -Htln | grep -q '127.0.0.1:9100 '", timeout=30)
          n = counter("inet whombat_containers", "input", "listeners on published ports only")
          machine.fail("curl -sf --max-time 3 http://127.0.0.1:9100/")
          assert counter("inet whombat_containers", "input", "listeners on published ports only") > n

      with subtest("a container's network: public addresses but port 25, nothing private, not this host"):
          for url in ["http://${pub4}:80/", "http://${pub4}:443/", "http://${pub4}:8123/"]:
              assert "public page" in (get("web", url) or ""), url
          for url in ["http://${pub4}:25/", "http://${priv4}:80/", "http://${meta4}:80/", "http://${denied4}:80/",
                      "http://${me}:${toString hostPort}/", "http://${me4}:${toString hostPort}/",
                      "http://169.254.1.2:${toString hostPort}/", "http://10.0.2.2:80/"]:
              assert get("web", url) is None, url
          rc, out = in_ctr("web", "nslookup public.test")
          assert rc == 0 and "${pub4}" in out, out
          assert counter("inet whombat-egress", "containers_out", "nothing on this host") > 0

      with subtest("the commands' proxy's uid: the same wall"):
          for host, port in [("${pub4}", 80), ("${pub4}", 8123)]:
              assert reaches("whombat-agent-net", host, port), (host, port)
          for host, port in [("${pub4}", 25), ("${priv4}", 80), ("${meta4}", 80), ("${denied4}", 80),
                             ("${me}", ${toString hostPort}), ("127.0.0.1", ${toString nodes.machine.whombat.sandbox.serverPort}),
                             ("127.0.0.1", 5432), ("127.0.0.1", 20100)]:
              assert not reaches("whombat-agent-net", host, port), (host, port)
          machine.succeed(as_user("whombat-agent-net", "getent hosts public.test"))
          assert counter("inet whombat-egress", "agent_net_out", "nothing else on this host") > 0

      with subtest("the Vault's home networks open a private address, and close it again"):
          put_networks(json.dumps({"version": 1, "networks": [{"cidr": "${priv4}/32", "ports": [8123]}]}))
          machine.wait_until_succeeds(as_user("whombat-agent-net", "${pkgs.python3}/bin/python3 ${lan.tcp} ${priv4} 8123"), timeout=30)
          assert "public page" in (get("web", "http://${priv4}:8123/") or "")
          assert get("web", "http://${priv4}:80/") is None
          put_networks(json.dumps({"version": 1, "networks": []}))
          machine.wait_until_succeeds("! " + as_user("whombat-agent-net", "${pkgs.python3}/bin/python3 ${lan.tcp} ${priv4} 8123"), timeout=30)
          assert get("web", "http://${priv4}:8123/") is None

      with subtest("the commands' network daemon's unit"):
          machine.wait_for_unit("whombat-agent-net.service")
          machine.wait_until_succeeds("test -S ${ag.netSocket}", timeout=30)
          assert sh("stat -c '%a %U %G' /run/whombat-agent-net") == "750 whombat-agent-net whombat-agent-net"
          p = json.loads(sh(as_user("whombat-runner", f"{PY} ${ask} ${ag.netSocket}")))
          assert p["uid"] == 962 and p["gid"] == 962 and not p["persist"], p
          assert all(int(c, 16) == 0 for c in p["caps"]), p
          assert p["env"]["WHOMBAT_AGENT_NET_SERVICE_PORTS"] == "20000-20099" and p["env"]["WHOMBAT_AGENT_NET_DENY"] == "${denied4}/32", p
          for user in ["whombat", "nobody", "whombat-containers"]:
              machine.fail(as_user(user, f"{PY} ${ask} ${ag.netSocket}"))

      with subtest("the agent's tools, home and nix-ld"):
          renv = sh("systemctl show whombat-runner -p Environment")
          for e in ["WHOMBAT_AGENT_TOOLS=${ag.tools}", "WHOMBAT_AGENT_HOME=${ag.home}", f"WHOMBAT_CONTAINERS_SOCKET={SOCK}",
                    "WHOMBAT_AGENT_NET_SOCKET=${ag.netSocket}", "WHOMBAT_AGENT_NIX_LD=${renv.WHOMBAT_AGENT_NIX_LD}",
                    "WHOMBAT_AGENT_NIX_LD_LIBRARY_PATH=${renv.WHOMBAT_AGENT_NIX_LD_LIBRARY_PATH}"]:
              assert e in renv, e
          assert sh(f"stat -c '%a %U %G' {AHOME}") == "2770 whombat-runner whombat-containers"
          assert "default:group:whombat-containers:rwx" in sh(f"getfacl -p {AHOME}")
          machine.succeed(as_user("whombat-runner", f"cp ${foreign} {AHOME}/xz && chmod +x {AHOME}/xz"))
          out = sh(as_user("whombat-runner", f"env NIX_LD=${renv.WHOMBAT_AGENT_NIX_LD} NIX_LD_LIBRARY_PATH=${renv.WHOMBAT_AGENT_NIX_LD_LIBRARY_PATH} {AHOME}/xz --version"))
          assert "liblzma" in out, out
          for t in ["git", "node", "python3", "rg", "ffmpeg", "pandoc", "tesseract", "docker"]:
              machine.succeed(f"test -x ${ag.tools}/bin/{t}")

      with subtest("the computers' leftovers on an older box go after a blessed boot, and are logged"):
          machine.succeed(
              "btrfs subvolume create /persist/incus-computers",
              "mkdir -p /persist/incus-computers/containers /persist/incus-computers/images",
              "btrfs subvolume create /persist/incus-computers/containers/c1",
              "btrfs subvolume create /persist/incus-computers/containers/c1/docker",
              "head -c 1M /dev/urandom > /persist/incus-computers/containers/c1/docker/blob",
              "btrfs subvolume snapshot -r /persist/incus-computers/containers/c1 /persist/incus-computers/images/img1",
              "btrfs subvolume create /persist/incus",
              "echo db > /persist/incus/database",
              "btrfs subvolume create /persist/incus-pool",
              "mkdir -p /persist/incus-pool/containers/old && touch /persist/incus-pool/containers/old/f",
              "chown -R 1000000000:1000000000 /persist/incus-pool/containers",
              "mkdir -p /var/lib/incus /var/lib/whombat-computerd && touch /var/lib/whombat-computerd/x",
          )
          machine.succeed("systemctl start whombat-computers-cleanup.service")
          machine.fail("ls -d /persist/incus*")
          machine.fail("test -e /var/lib/incus -o -e /var/lib/whombat-computerd")
          assert "incus" not in sh("btrfs subvolume list /persist")
          log = sh("journalctl -u whombat-computers-cleanup.service -o cat")
          for d in ["/persist/incus-computers", "/persist/incus-pool", "/persist/incus", "/var/lib/whombat-computerd"]:
              assert f"deleted {d}" in log, (d, log)
          assert "the agents' computers are gone" in log, log
          deps = sh("systemctl show -P WantedBy -P After whombat-computers-cleanup.service")
          assert "boot-complete.target" in deps, deps

      with subtest("a reboot: containers stopped cleanly, the ones with a restart policy back"):
          machine.succeed(as_user("whombat-runner", f"mkdir -p {AHOME}/stop"))
          docker(f"run -d --name trap -v {AHOME}/stop:/out wbtest:1 sh -c 'trap \"echo stopped > /out/stopped; exit 0\" TERM; while :; do sleep 1; done'")
          machine.shutdown()
          machine.start()
          machine.wait_for_unit("whombat-containers.service")
          assert sh(f"cat {AHOME}/stop/stopped") == "stopped"
          machine.wait_until_succeeds(
              as_user("whombat-runner", f"env HOME={AHOME} {DOCKER} inspect -f '{{{{.State.Running}}}}' web") + " | grep -qx true",
              timeout=120)
          assert docker("inspect -f '{{.State.Running}}' trap") == "false"
          control.wait_until_succeeds("curl -sf --max-time 3 http://${me}:20001/ | grep -q 'container page'", timeout=60)
          # The listeners' table is loaded again with the engine.
          assert "listeners on published ports only" in sh("nft list table inet whombat_containers")
    '';
}
