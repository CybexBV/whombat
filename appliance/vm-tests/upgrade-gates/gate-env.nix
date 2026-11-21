# The upgrade gates' environment (NX-110): what turns a release's image (`lib.applianceRelease { env = "dev"; … }` of
# the release's own source, `env = "prod"` once that source has only the Whombat image, ONE-02) into the image of a box
# on the gates' test network. Applied with `extendModules` to every
# release a gate installs, the previous releases (built from their recorded commits) and the candidate alike, so the
# manager, update helper, runtime and every other module stay the release's own; only where the box looks for control
# and updates, which keys it trusts and how the test driver reaches it differ from the published image:
#
#   environment `dev` with the committed development TUF fixtures' pinned root (the gate repository continues the
#   fixture repository's root chain, ./repo.nix), the fake control at control:4600, the TEST licence key set, no AI
#   client channel (the fixtures have no clients role), the test network (box 192.168.1.1 by the test driver's MAC for
#   node 1 on vlan 1, control 192.168.1.2: the gates name their nodes `box` < `control` < …), the test driver's
#   backdoor (nixpkgs' test-instrumentation, from the release's own nixpkgs) and jq and curl for the test script, a
#   10 s boot-assessment settle, and short manager timings (a look at the update repository every 10 s, verify 3 min,
#   one attempt: a failed candidate is quarantined at once; ./release.nix adds a 3-minute host reboot timeout for
#   managers that take it, MG-55, NX-126).
#
# Updates reach the box as they reach every Whombat: it follows a channel of a repository in GitHub's layout and takes
# the newest release the channel lists. The gates' box follows development (Beta, where a candidate goes first) and
# asks the names in ./tls.nix, which the test network gives to the control node; ./release.nix adds the certificate
# those servers show. The image's environments are off: with them the box takes production's addresses and pinned
# root and refuses the test repository's keys.
#
# Only options every gated release has may be set here: the module is evaluated with each release's own option
# declarations, and the manager's configuration refuses unknown keys. Every gated release has update channels (the
# gates say so otherwise, ./default.nix); an option only newer releases have is set where it exists (`options`).
{
  lib,
  modulesPath,
  options,
  pkgs,
  ...
}:
let
  fixtures = ../../release-tools/fixtures;
  tls = import ./tls.nix { inherit pkgs; };
in
{
  imports = [ (modulesPath + "/testing/test-instrumentation.nix") ];

  config = lib.mkMerge [
    # The image's own settings say where control is, as before a box could be in one of several environments: without
    # this the manager takes production's from the image's environment list and refuses the test repository's root.
    (lib.optionalAttrs (options.whombat ? environments) {
      whombat.environments = lib.mkForce { };
    })
    {
      whombat.environment = lib.mkForce "dev";
      whombat.manager.controlUrl = lib.mkForce "http://control:4600";
      whombat.helper.defaultChannel = lib.mkForce "development";
      whombat.manager.tuf = {
        metadataUrl = lib.mkForce "https://${tls.pages}/";
        targetsUrl = lib.mkForce "https://${tls.github}/example/releases/releases/download/";
        targetsLayout = lib.mkForce "github";
      };
      whombat.helper.tufRoot = lib.mkForce (fixtures + "/dev/pinned-root.json");
      whombat.licence.keys = lib.mkForce ../common/licence-keys.test.json;
      whombat.clients.channelKeys = lib.mkForce null;
      whombat.relayHost = lib.mkForce null;
      whombat.network.outboundTcpPorts = lib.mkForce [
        443
        4600
        8000
      ];
      whombat.boot.settleSec = lib.mkForce 10;
      whombat.manager.settings = {
        pollSec = 5;
        refreshSec = 10;
        policy = {
          healthIntervalMs = 5000;
          verifyTimeoutMs = 180000;
          drainPollMs = 2000;
          retryBaseMs = 5000;
          idleIntervalMs = 5000;
          maxAttempts = 1;
        };
      };

      # The test network (nixos/lib/testing/network.nix gives node n on vlan 1 the MAC 52:54:00:12:01:0n and
      # 192.168.1.n): networkd matches the NIC by its MAC before the appliance's DHCP default.
      systemd.network.networks."10-gate" = {
        matchConfig.MACAddress = "52:54:00:12:01:01";
        address = [ "192.168.1.1/24" ];
        networkConfig.LinkLocalAddressing = "no";
      };
      networking.hosts."192.168.1.2" = [ "control" ] ++ tls.names;
      # What the gate tests use on the box (the image has neither).
      environment.systemPackages = [
        pkgs.jq
        pkgs.curl
      ];
      # test-instrumentation gives root an empty password for interactive test runs; the appliance's locked root stays.
      users.users.root.hashedPasswordFile = lib.mkForce null;
    }
  ];
}
