// Screen contents for the fixture thumbnails, extracted once from the mockup's
// static HTML (docs/handoff/design/static/server-incus-screens.html and
// proxmox-vm-screens.html: each tile's lines and inline colors). Keyed by guest
// name. The cursor sits at the end of the last line. Container tiles are kept
// for reference (containers have no screen: the API answers 404 no_screen).

export type TermColor = 'fg' | 'dim' | 'green' | 'blue' | 'yellow' | 'red';
export type TermLine = readonly [TermColor, string];

/** --term colors of the design tokens. */
export const TERM_COLORS: Record<TermColor, string> = {
  fg: '#c9d1d9',
  dim: '#7d8590',
  green: '#56d364',
  blue: '#79c0ff',
  yellow: '#e3b341',
  red: '#ff7b72',
};

export const SCREEN_LINES: Record<string, readonly TermLine[]> = {
  'nixbuild': [
    ["dim", "<<< Welcome to NixOS 26.05 (Yarara) - Linux 6.12.48 (tty1) >>>"],
    ["fg", ""],
    ["fg", "nixbuild login: jdoe"],
    ["dim", "Last login: Sun Oct 11 09:12:44 on tty1"],
    ["green", "[jdoe@nixbuild:~/src/fleet-agent]$ nix build .#default"],
    ["fg", "building '/nix/store/9f2kq7…-fleet-agent-0.14.2.drv'..."],
    ["dim", "   Compiling tokio v1.47.1"],
    ["dim", "   Compiling hyper v1.7.0"],
    ["dim", "   Compiling rustls v0.23.31"],
    ["blue", "[214/340] fleet-agent (bin)"],
  ],
  'ci-runner': [
    ["fg", "Debian GNU/Linux 13 ci-runner tty1"],
    ["fg", ""],
    ["fg", "ci-runner login: root"],
    ["fg", "Password:"],
    ["fg", "root@ci-runner:~# systemctl status gitlab-runner --no-pager"],
    ["green", "● gitlab-runner.service - GitLab Runner"],
    ["fg", "     Loaded: loaded (/etc/systemd/system/gitlab-runner.service; enabled)"],
    ["fg", "     Active: active (running) since Thu 2026-10-08 11:02:17 CEST; 3 days ago"],
    ["fg", "   Main PID: 842 (gitlab-runner)"],
    ["fg", "      Tasks: 14 (limit: 4631)"],
    ["fg", "     Memory: 412.6M"],
    ["fg", "root@ci-runner:~# "],
  ],
  'dev-shell': [
    ["green", "[jdoe@dev-shell:~/src/fleet-agent]$ git status -sb"],
    ["fg", "## main...origin/main"],
    ["fg", " M src/collector/kvm.rs"],
    ["fg", " M src/collector/mod.rs"],
    ["fg", "?? src/collector/proxmox.rs"],
    ["green", "[jdoe@dev-shell:~/src/fleet-agent]$ cargo test --lib"],
    ["dim", "   Compiling fleet-agent v0.14.2"],
    ["fg", "running 48 tests"],
    ["fg", "test collector::kvm::parses_domstats ... ok"],
    ["fg", "test collector::kvm::maps_vcpu_pinning ... ok"],
    ["green", "[jdoe@dev-shell:~/src/fleet-agent]$ "],
  ],
  'git-mirror': [
    ["fg", "git-mirror:~# ls /srv/git"],
    ["blue", "agent.git  infra.git  dotfiles.git  docs.git"],
    ["fg", "git-mirror:~# tail -n 4 /var/log/mirror.log"],
    ["dim", "2026-10-11 14:15:01 sync infra.git ok (0 new)"],
    ["dim", "2026-10-11 14:30:02 sync agent.git ok (3 new)"],
    ["dim", "2026-10-11 14:30:03 sync docs.git ok (0 new)"],
    ["dim", "2026-10-11 14:45:01 sync infra.git ok (1 new)"],
    ["fg", "git-mirror:~# "],
  ],
  'mqtt-bridge': [
    ["fg", "root@mqtt-bridge:~# journalctl -u mosquitto -n 5 --no-pager"],
    ["dim", "Oct 11 14:46:12 mosquitto[311]: New connection from 10.20.0.31:51522 on port 1883."],
    ["dim", "Oct 11 14:46:12 mosquitto[311]: New client connected as sensor-hall (p2, c1, k60)."],
    ["dim", "Oct 11 14:46:58 mosquitto[311]: Client sensor-attic closed its connection."],
    ["dim", "Oct 11 14:47:03 mosquitto[311]: New connection from 10.20.0.34:49970 on port 1883."],
    ["dim", "Oct 11 14:47:03 mosquitto[311]: New client connected as sensor-attic (p2, c1, k60)."],
    ["fg", "root@mqtt-bridge:~# "],
  ],
  'dns': [
    ["fg", "dns:~# unbound-control status"],
    ["fg", "version: 1.22.0"],
    ["fg", "verbosity: 1"],
    ["fg", "threads: 2"],
    ["fg", "uptime: 3542112 seconds"],
    ["fg", "dns:~# unbound-control stats_noreset | grep total.num"],
    ["fg", "total.num.queries=1204331"],
    ["fg", "total.num.cachehits=1081902"],
    ["fg", "total.num.cachemiss=122429"],
    ["fg", "dns:~# "],
  ],
  'k3s-node-2': [
    ["fg", "root@k3s-node-2:~# kubectl get nodes -o wide"],
    ["dim", "NAME         STATUS   ROLES           AGE   VERSION        INTERNAL-IP"],
    ["fg", "k3s-node-1   Ready    control-plane   88d   v1.34.1+k3s1   10.20.1.21"],
    ["fg", "k3s-node-2   Ready    <none>          88d   v1.34.1+k3s1   10.20.1.22"],
    ["fg", "root@k3s-node-2:~# kubectl top pod -A --sort-by=cpu | head -4"],
    ["dim", "NAMESPACE     NAME                      CPU(cores)   MEMORY(bytes)"],
    ["fg", "monitoring    prometheus-0              412m         1840Mi"],
    ["fg", "default       ingest-7c9d6f5b8-x2k4q    240m         610Mi"],
    ["fg", "root@k3s-node-2:~# "],
  ],
  'k3s-node-1': [
    ["fg", "root@k3s-node-1:~# journalctl -u k3s -n 6 --no-pager"],
    ["dim", "Oct 11 14:46:41 k3s[912]: I1011 14:46:41.204 scheduler.go:372] \"Successfully bound pod\" pod=\"default/ingest-7c9d6f5b8-x2k4q\""],
    ["dim", "Oct 11 14:46:52 k3s[912]: I1011 14:46:52.118 job_controller.go:560] \"enqueueing job\" key=\"monitoring/rollup-28741\""],
    ["dim", "Oct 11 14:47:09 k3s[912]: I1011 14:47:09.402 range_allocator.go:193] \"Node has CIDR\" node=\"k3s-node-2\""],
    ["fg", "root@k3s-node-1:~# "],
  ],
  'postgres-prod': [
    ["fg", "postgres@postgres-prod:~$ pg_lsclusters"],
    ["dim", "Ver Cluster Port Status Owner    Data directory"],
    ["fg", "17  main    5432 online postgres /var/lib/postgresql/17/main"],
    ["fg", "postgres@postgres-prod:~$ psql -c \"select count(*) from pg_stat_activity;\""],
    ["dim", " count"],
    ["dim", "-------"],
    ["fg", "    38"],
    ["fg", "(1 row)"],
    ["fg", "postgres@postgres-prod:~$ "],
  ],
  'gitlab-runner': [
    ["fg", "root@gitlab-runner:~# gitlab-runner list"],
    ["dim", "Runtime platform  arch=amd64 os=linux version=18.4.0"],
    ["dim", "Listing configured runners  ConfigFile=/etc/gitlab-runner/config.toml"],
    ["fg", "shell-01   Executor=shell   URL=https://git.example.lan"],
    ["fg", "docker-01  Executor=docker  URL=https://git.example.lan"],
    ["fg", "root@gitlab-runner:~# "],
  ],
  'opnsense-fw': [
    ["fg", "*** opnsense-fw.lan: OPNsense 25.7.4 (amd64) ***"],
    ["fg", ""],
    ["fg", " LAN (vtnet1)  -> v4: 10.30.0.1/24"],
    ["fg", " WAN (vtnet0)  -> v4/DHCP4: 203.0.113.50/24"],
    ["fg", " HTTPS: SHA256 4C 9D 0A 7B 1E 55 A2 06 F1 3C 8E 90 …"],
    ["fg", ""],
    ["fg", " 0) Logout                              7) Ping host"],
    ["fg", " 1) Assign interfaces                   8) Shell"],
    ["fg", " 2) Set interface IP address            9) pfTop"],
    ["fg", " 3) Reset the root password             10) Firewall log"],
    ["fg", " 4) Reset to factory defaults           11) Reload all services"],
    ["fg", " 5) Power off system                    12) Update from console"],
    ["fg", " 6) Reboot system                       13) Restore a backup"],
    ["fg", ""],
    ["fg", "Enter an option: "],
  ],
  'haos-prod': [
    ["fg", "Home Assistant OS 15.2"],
    ["fg", "homeassistant login: root"],
    ["fg", ""],
    ["fg", "Welcome to Home Assistant"],
    ["fg", ""],
    ["fg", "  System information"],
    ["fg", "     IPv4 address for enp1s0:   10.30.1.12/24"],
    ["fg", "     OS version:                Home Assistant OS 15.2"],
    ["fg", "     Home Assistant Core:       2026.10.1"],
    ["fg", "     Home Assistant Supervisor: 2026.10.0"],
    ["fg", ""],
    ["fg", "     Home Assistant URL:        http://homeassistant.local:8123"],
    ["fg", ""],
    ["fg", "ha > "],
  ],
};

/** A desktop window on a Windows guest (server-qemu-console-windows / proxmox-vm-screens). */
export interface WindowScreen {
  title: string;
  lines: readonly TermLine[];
  /** Progress bar fill, 0..1. */
  progress: number;
}

export const WINDOW_SCREENS: Record<string, WindowScreen> = {
  'win-build': {
    title: 'Build · Release x64',
    lines: [
      ['fg', 'Project   fleet-agent.sln'],
      ['fg', 'Target    x86_64-pc-windows-msvc'],
      ['fg', 'Step      Compiling (214 of 340)'],
      ['fg', 'Elapsed   04:12'],
      ['dim', 'Worker 3 of 8 · 38% CPU'],
    ],
    progress: 0.68,
  },
  default: {
    title: 'Task Manager · Performance',
    lines: [
      ['fg', 'CPU       9.8%    4 vCPU'],
      ['fg', 'Memory    7.4 / 8.0 GB'],
      ['fg', 'Disk 0    28 MB/s read · 64 MB/s write'],
      ['fg', 'Ethernet  6 / 2 Mb/s'],
      ['dim', 'Windows 11 Pro · build 26100'],
    ],
    progress: 0.92,
  },
};
