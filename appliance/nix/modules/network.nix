# Networking (NX-22): systemd-networkd (the update helper's network candidates are networkd units; Wi-Fi in wifi.nix),
# one inbound port, the runtime's direct port, from the local network and Tailscale only (Whombat HE-51, NX-440; and the
# ports the agent's services publish, from private networks: containers.nix, NX-461), outbound limited to
# what the appliance needs, per-uid egress hooks for sandboxes and for the agent's commands and containers (agent.nix,
# containers.nix: `uidChains`, NX-460), the Vault's home networks for the runtime server's uid (NX-40, filled by
# vault-wall.nix) and its SSH ports on public addresses (NX-128), and the local network for the runtime server and the
# agent's commands and containers (NX-144).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.network;
  sb = config.whombat.sandbox.uidRange;
  sbEnd = sb.start + sb.count - 1;
  helperNet = config.whombat.helper.networkStateDir;
  # The update repository's own port, when its address names one (a community repository on the owner's network or a
  # test's, NX-445): the manager must reach what the image says to update from.
  portOf =
    url:
    let
      m = builtins.match "[a-z]+://[^/:]+:([0-9]+)(/.*)?" url;
    in
    if m == null then [ ] else [ (lib.toInt (lib.head m)) ];
  updatePorts = lib.concatMap portOf [
    config.whombat.manager.tuf.metadataUrl
    config.whombat.manager.tuf.targetsUrl
  ];
  tcpOut = lib.concatMapStringsSep ", " toString (lib.unique (cfg.outboundTcpPorts ++ updatePorts));
  runnerUid = toString config.whombat.ids.whombat-runner;
  serverUid = toString config.whombat.ids.whombat;
  # The ports the Vault's SSH keys may reach on public addresses (VT-S14, NX-128; the runtime gets the same list).
  sshPorts = lib.concatMapStringsSep ", " toString config.whombat.vault.sshPorts;
  # The direct port (NX-440): the interfaces of the local network (a cable's, Wi-Fi's) and the addresses it comes from
  # there. The runtime keeps its own rule behind this one (WHOMBAT_DIRECT_INTERFACES=lan,tailscale0, runtime.nix).
  lanInterfaces = lib.splitString " " cfg.defaultInterfaceMatch ++ lib.optional config.whombat.wifi.enable "wl*";
  directPort = toString cfg.directPort;
  lan4 = "10.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16";
  lan6 = "fc00::/7, fe80::/10";
  ts = config.whombat.tailscale;
  # Connections the Vault rules accepted carry this conntrack mark ("VAUL"), so removing a network also ends
  # the connections already open to it (NX-40).
  vaultMark = cfg.vaultMark;
  # The hosts service's uid (NX-154): its checks reach the local network, nothing on this host but the resolver.
  hosts = config.whombat.hosts.enable;
  hostsUid = toString config.whombat.ids.whombat-hosts;
  runnerGrants = lib.concatMapStringsSep "\n          " (
    g:
    let
      fam = if lib.hasInfix ":" g.cidr then "ip6" else "ip";
      ports = lib.concatMapStringsSep ", " toString g.ports;
    in
    "meta skuid ${runnerUid} ${fam} daddr ${g.cidr} th dport { ${ports} } accept comment \"sandbox grant\""
  ) config.whombat.sandbox.grants;
in
{
  # whombat.network.ownDomains and the DNS fallback that knows them (shared with the installer, NX-509).
  imports = [ ./dns.nix ];

  options.whombat.network = {
    outboundTcpPorts = lib.mkOption {
      type = lib.types.listOf lib.types.port;
      default = [ 443 ];
      description = ''
        TCP destination ports the appliance may connect to (any address). 443 covers relay,
        control, update mirror, provider APIs and GitHub over HTTPS. DNS (53), NTP (123, time service
        only) and DHCP are allowed separately.
      '';
    };
    localNetwork = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Open the local network (every private address: 10.0.0.0/8, 100.64.0.0/10, 172.16.0.0/12, 192.168.0.0/16,
        fc00::/7; never the metadata addresses inside them) to the runtime server's uid (TCP and UDP) and the agents'
        agent's commands and containers (Whombat local-network.md LN-06, NX-144, NX-460). The switch “Agents may reach
        your local network” decides inside (the server's rules, the commands' proxy); off here, only the Vault's home
        networks open private addresses.
      '';
    };
    vaultMark = lib.mkOption {
      type = lib.types.str;
      default = "0x5641554c";
      readOnly = true;
      description = "The conntrack mark of connections the Vault's home-network rules opened (\"VAUL\", NX-40).";
    };
    uidChains = lib.mkOption {
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            uid = lib.mkOption { type = lib.types.int; };
            chain = lib.mkOption { type = lib.types.str; };
          };
        }
      );
      default = [ ];
      internal = true;
      description = ''
        Chains of the egress table that decide everything a uid sends, this host's loopback included: jumped to before
        the rules every uid has (the agent's commands' proxy and its containers, NX-460). Each must end with a verdict.
      '';
    };
    extraOutputRules = lib.mkOption {
      type = lib.types.lines;
      default = "";
      description = "Additional nftables rules for the output chain (tests, customer grants).";
    };
    directPort = lib.mkOption {
      type = lib.types.port;
      default = 4480;
      description = ''
        The runtime's direct listener (Whombat HE-50, HE-51; NX-440): browsers and the apps reach the box on it without
        the relay (the page and the WebSocket, contracts `DIRECT_PORT`). The only inbound port: from private addresses
        on the local network's interfaces (`lanInterfaces`), and on `tailscale0`; never from a public address. The
        runtime server gets it as WHOMBAT_DIRECT_PORT.
      '';
    };
    lanInterfaces = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = lanInterfaces;
      defaultText = lib.literalExpression ''lib.splitString " " defaultInterfaceMatch ++ lib.optional config.whombat.wifi.enable "wl*"'';
      readOnly = true;
      description = ''
        The local network's interfaces (nftables `iifname` patterns): the direct port opens on them for private
        source addresses (NX-440).
      '';
    };
    defaultInterfaceMatch = lib.mkOption {
      type = lib.types.str;
      default = "en* eth*";
      description = "Interfaces configured with DHCP/SLAAC until a committed candidate replaces it.";
    };
    cableOffFile = lib.mkOption {
      type = lib.types.str;
      default = "/run/systemd/network/05-whombat-cable-off.network";
      readOnly = true;
      description = ''
        The networkd file the update helper writes while the box uses Wi-Fi only: it sorts before every other
        wired file and gives the wired interfaces no address, so a plugged cable is seen but not used.
      '';
    };
  };

  config = {
    networking.useNetworkd = true;
    networking.useDHCP = false;
    # No temporary IPv6 addresses: the box is a server and keeps its stable address. A temporary one is deleted two
    # days after it was made, and connections opened from it then die without a word; the manager's connection to
    # control did, and nothing reached the box for 18 minutes (NX-489). networkd sets each link's own setting from
    # networkd.conf, where NixOS turns them on, so both places say no.
    networking.tempAddresses = "disabled";
    systemd.network.config.networkConfig.IPv6PrivacyExtensions = false;
    systemd.network.enable = true;
    systemd.network.wait-online.anyInterface = true;
    systemd.network.networks."90-whombat-default" = {
      matchConfig.Name = cfg.defaultInterfaceMatch;
      networkConfig = {
        DHCP = "yes";
        IPv6AcceptRA = true;
        LLMNR = false;
        MulticastDNS = false;
        # A link with only routing domains would stop answering other names: it stays a default route (NX-488).
        DNSDefaultRoute = true;
      };
      # The box's own services by this network's resolvers, whatever takes the other lookups (NX-488).
      domains = map (d: "~${d}") cfg.ownDomains;
      # The cable's routes come before Wi-Fi's (600, wifi.nix): a cable is used when both work (NX-241).
      dhcpV4Config = {
        UseDomains = false;
        RouteMetric = 100;
      };
      ipv6AcceptRAConfig.RouteMetric = 100;
    };
    # A cable and Wi-Fi on the same network (a laptop or tablet on a dock): by default Linux answers ARP for each of the
    # box's IPv4 addresses on both links, so the router sends part of the box's traffic to the other link and IPv4
    # connections stall for seconds or fail (NX-482). Each link answers only for its own address, with its own address.
    boot.kernel.sysctl = {
      "net.ipv4.conf.all.arp_ignore" = 1;
      "net.ipv4.conf.all.arp_announce" = 2;
    };
    # On such a network each address must also answer on its own link, so the reverse-path filter (base.nix's sysctl,
    # and the firewall's own check, which covers IPv6 too) is loose: it asks only whether the sender is reachable at
    # all. Strict mode dropped a packet that reached the Wi-Fi address over Wi-Fi while the cable carried the route
    # back, so the Wi-Fi address didn't answer while a cable was in, and servers couldn't move to it before the cable
    # went.
    networking.firewall.checkReversePath = "loose";

    # The helper writes the applied candidate to /run/systemd/network/10-whombat.network (sorts
    # before 90-whombat-default) and keeps the committed copy in its state dir. /run is empty after a
    # reboot, so restore the committed copy before networkd starts (MG network change guard).
    systemd.services.whombat-network-restore = {
      description = "Restore the committed network configuration";
      wantedBy = [ "systemd-networkd.service" ];
      before = [ "systemd-networkd.service" ];
      unitConfig = {
        DefaultDependencies = false;
        ConditionPathExists = "${helperNet}/committed.network";
        RequiresMountsFor = [ helperNet ];
      };
      after = [ "local-fs.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = [
          "${pkgs.coreutils}/bin/install -d -m 0755 /run/systemd/network"
          "${pkgs.coreutils}/bin/install -m 0644 ${helperNet}/committed.network /run/systemd/network/10-whombat.network"
        ];
      };
    };

    # Wi-Fi only: the helper keeps the switched-off cable's file in its state dir once the change is kept;
    # put it back before networkd starts, so a restart or a host update doesn't bring the cable back by itself.
    systemd.services.whombat-cable-restore = {
      description = "Keep the cable switched off (Wi-Fi only)";
      wantedBy = [ "systemd-networkd.service" ];
      before = [ "systemd-networkd.service" ];
      unitConfig = {
        DefaultDependencies = false;
        ConditionPathExists = "${helperNet}/cable-off.network";
        RequiresMountsFor = [ helperNet ];
      };
      after = [ "local-fs.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = [
          "${pkgs.coreutils}/bin/install -d -m 0755 /run/systemd/network"
          "${pkgs.coreutils}/bin/install -m 0644 ${helperNet}/cable-off.network ${cfg.cableOffFile}"
        ];
      };
    };

    # ---- Firewall: one inbound port, the direct port (NX-440; containers.nix adds the ports the agent's services
    # publish, NX-461), outbound allowlisted ---
    networking.nftables.enable = true;
    networking.firewall = {
      enable = true;
      allowedTCPPorts = lib.mkForce [ ];
      allowedUDPPorts = lib.mkForce [ ];
      allowPing = false;
      logRefusedConnections = false;
      rejectPackets = false;
      # The direct port (Whombat HE-51, NX-440): from private addresses on the local network's interfaces (never a
      # public one, whatever the interface: a box with a public address keeps NX-22's nothing inbound), and on Tailscale.
      extraInputRules = lib.concatMapStrings (i: ''
        iifname "${i}" ip saddr { ${lan4} } tcp dport ${directPort} accept comment "the direct port from the local network (HE-51)"
        iifname "${i}" ip6 saddr { ${lan6} } tcp dport ${directPort} accept comment "the direct port from the local network (HE-51)"
      '') cfg.lanInterfaces;
      interfaces = lib.optionalAttrs ts.enable { ${ts.interface}.allowedTCPPorts = [ cfg.directPort ]; };
    };
    networking.nftables.tables.whombat-egress = {
      family = "inet";
      content = ''
        set sandbox_uids { type uid; flags interval; elements = { ${toString sb.start}-${toString sbEnd} } }

        # The Vault's home networks (VT-59, NX-40): (network, TCP port) pairs the runtime server may reach. Empty
        # here; whombat-vault-wall replaces the elements from the runtime's list in one transaction.
        set vault4 { type ipv4_addr . inet_service; flags interval; }
        set vault6 { type ipv6_addr . inet_service; flags interval; }

        # Addresses that aren't public (NX-97, NX-128): every IPv4 range that isn't public (and Azure's metadata address,
        # which is); for IPv6, the special ranges inside global unicast 2000::/3 (everything outside it is refused by
        # `ip6 daddr != 2000::/3` where these are used). NX-97's and NX-128's rules (and NX-460's) use them.
        set nonpublic4 { type ipv4_addr; flags interval; elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10,
          127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16,
          198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/3, 168.63.129.16 } }
        set nonpublic6 { type ipv6_addr; flags interval; elements = { 2001::/23, 2001:db8::/32, 2002::/16,
          3fff::/20 } }

        # The local network (Whombat LN-06, NX-144): every private range; the metadata addresses inside them are left out
        # where these are used. Empty when whombat.network.localNetwork is off.
        set local4 { type ipv4_addr; flags interval; ${
          lib.optionalString cfg.localNetwork "elements = { 10.0.0.0/8, 100.64.0.0/10, 172.16.0.0/12, 192.168.0.0/16 }"
        } }
        set local6 { type ipv6_addr; flags interval; ${lib.optionalString cfg.localNetwork "elements = { fc00::/7 }"} }

        chain sandbox {
          ${config.whombat.sandbox.egressRules}
          counter drop comment "sandbox egress: fail closed"
        }

        # A connection the Vault rules opened stays usable only while its network and port are still listed.
        chain vault_established {
          ip daddr . tcp dport @vault4 return
          ip6 daddr . tcp dport @vault6 return
          counter reject with tcp reset comment "Vault network no longer listed"
        }

        # SSH from the Vault (Whombat VT-S01, VT-S06, VT-S14; IN-150, NX-128): the runtime server's uid on a port of
        # whombat.vault.sshPorts reaches public addresses only. A non-public address returns to the output chain, where
        # only the Vault's home-network sets (above it) can have let it through.
        chain vault_ssh {
          ip daddr @nonpublic4 return
          ip6 daddr != 2000::/3 return
          ip6 daddr @nonpublic6 return
          accept comment "Vault SSH to a public address (runtime server)"
        }

        # Mail from the runtime server (Whombat connections-more.md CM-23, NX-156): Email (IMAP) connections reach public
        # mail servers on IMAP (143 STARTTLS, 993) and SMTP submission (587 STARTTLS, 465), never port 25. A non-public
        # address returns to the output chain, where only the local network and the Vault's sets can let it through.
        chain mail {
          ip daddr @nonpublic4 return
          ip6 daddr != 2000::/3 return
          ip6 daddr @nonpublic6 return
          accept comment "IMAP and SMTP submission to a public address (runtime server)"
        }

        ${lib.optionalString hosts ''
          # The hosts service's uid (the hosts service, NX-154): its checks (HTTP, TCP, ping, DNS) reach the local network
          # like the runtime server's (LN-06); on this host only the resolver stub, not PostgreSQL, the server or any
          # other listener, by any address of this host (all of them go out on lo). Then the rules every uid has.
          chain hosts {
            oifname "lo" ip daddr { 127.0.0.53, 127.0.0.54 } meta l4proto { tcp, udp } th dport 53 accept comment "resolver stub"
            oifname "lo" counter reject with icmpx admin-prohibited comment "hosts: nothing on this host"
            ip daddr @local4 ip daddr != 100.100.100.200 meta l4proto { tcp, udp } accept comment "the local network (hosts service)"
            ip6 daddr @local6 ip6 daddr != fd00:ec2::254 meta l4proto { tcp, udp } accept comment "the local network (hosts service)"
          }
        ''}
        chain output {
          type filter hook output priority filter; policy drop;
          ${lib.optionalString hosts ''
            meta skuid ${hostsUid} jump hosts
          ''}
          ${lib.concatMapStringsSep "\n          " (
            u: "meta skuid ${toString u.uid} jump ${u.chain}"
          ) cfg.uidChains}
          oifname "lo" accept
          meta skuid @sandbox_uids jump sandbox
          ct mark ${vaultMark} jump vault_established
          ct state established,related accept
          meta l4proto { icmp, ipv6-icmp } accept
          udp dport { 67, 68, 546, 547 } accept comment "DHCP"
          meta l4proto { tcp, udp } th dport 53 accept comment "DNS"
          udp dport 123 accept comment "NTP"
          meta skuid ${toString config.ids.uids.chrony} tcp dport 4460 accept comment "NTS key exchange (chronyd only)"
          ${lib.optionalString ts.enable ''
            meta skuid 0 udp sport ${toString ts.port} accept comment "tailscaled: WireGuard and STUN (NX-440)"
          ''}
          ${lib.optionalString ts.enable ''
            meta skuid 0 ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 } meta l4proto tcp accept comment "tailscaled: the owner's own login server on the local network, any port (LNK-12, NX-445)"
            meta skuid 0 ip6 daddr fc00::/7 meta l4proto tcp accept comment "tailscaled: the owner's own login server on the local network, any port (LNK-12, NX-445)"
          ''}
          tcp dport { ${tcpOut} } accept
          meta skuid ${toString config.whombat.ids.whombat-runner} tcp dport 80 accept comment "runner egress proxy (MS-06: 80 and 443)"
          ${runnerGrants}
          meta skuid ${serverUid} ip daddr @local4 ip daddr != 100.100.100.200 meta l4proto { tcp, udp } accept comment "the local network (runtime server, LN-06)"
          meta skuid ${serverUid} ip6 daddr @local6 ip6 daddr != fd00:ec2::254 meta l4proto { tcp, udp } accept comment "the local network (runtime server, LN-06)"
          meta skuid ${serverUid} ip daddr . tcp dport @vault4 ct mark set ${vaultMark} accept comment "Vault home networks (runtime server)"
          meta skuid ${serverUid} ip6 daddr . tcp dport @vault6 ct mark set ${vaultMark} accept comment "Vault home networks (runtime server)"
          meta skuid ${serverUid} tcp dport { ${sshPorts} } jump vault_ssh
          meta skuid ${serverUid} tcp dport { 143, 465, 587, 993 } jump mail
          ${cfg.extraOutputRules}
          counter drop comment "egress not allowlisted"
        }
      '';
    };
  };
}
