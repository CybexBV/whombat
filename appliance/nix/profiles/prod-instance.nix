# The Whombat image (ONE-02; PI-10, NX-61): one image for every box. Production: control, app, relay and the own
# address's zone of production (environments.nix), updates from the GitHub repository (releases.whombat.com, LNK-24) on
# the box's channel, Production unless its owner chose Beta (wire name `development`, ONE-03), and self-registration
# (every box makes its identity itself, LNK-01; allowed in production on self-installed only, PI-04).
#
# The image pins production's public trust documents, in manifest/prod/:
#   tuf-root.json              the GitHub repository's root: three offline root keys, two of them needed.
#   client-channel-keys.json   the AI client channel's key document for env prod.
#   licence-keys.json          production control's licence key set (the licence is inert; kept for a rollback).
#   support-ca.pub             the production support CA, for remote help.
# Without one of the first three the image doesn't build; without the CA a box has no remote help.
#
# The Whombat image carries the servers' hub on every box, its agents signed with the Whombat agent-signing key (NX-523);
# the Incus agent, only inside an Incus VM; the merge re-run setting in production's environment. No serial console
# line (claim letters for whoever reads the serial port).
{ ... }:
let
  prod = ../../manifest/prod;
  required =
    name: what:
    let
      f = prod + "/${name}";
    in
    if builtins.pathExists f then
      f
    else
      throw "manifest/prod/${name} is missing: the Whombat image pins production's ${what} (docs/runbooks/install.md)";
in
{
  imports = [ ./environments.nix ];
  whombat.environment = "prod";
  whombat.manager.controlUrl = "https://api.whombat.com";
  whombat.relayHost = "relay.whombat.com";
  # The GitHub repository (LNK-24): the four settings go together (manager.nix checks it).
  whombat.helper.defaultChannel = "production";
  whombat.manager.tuf = {
    metadataUrl = "https://releases.whombat.com/";
    targetsUrl = "https://github.com/CybexBV/whombat-releases/releases/download/";
    targetsLayout = "github";
  };
  whombat.helper.tufRoot = required "tuf-root.json" "update repository root (ONE-05)";
  whombat.licence.keys = required "licence-keys.json" "licence key set (LC-04, NX-38)";
  # Without a channel key document a box installs no Claude Code, so no agent can run a turn.
  whombat.clients.channelKeys = required "client-channel-keys.json" "AI client channel key document";
  # The image-level CA, for images without environments; the box's environment picks the CA it uses (support.nix).
  whombat.support.caKeys =
    let
      f = prod + "/support-ca.pub";
    in
    if builtins.pathExists f then f else null;
  # whombat.runtime.appUrl: production's default, https://app.whombat.com; the environment's runtime.env sets the rest.
  whombat.provisioning = {
    selfRegister = true;
    factoryMedium = false;
  };

  # The servers people add in Whombat (Whombat ONE-11…ONE-15; NX-152, NX-523): the headless hub on /persist/hosts, agents
  # on 8443 from private networks only. hosts.nix takes it in production only with the agents signed by the Whombat
  # agent-signing key (NX-157).
  whombat.hosts.enable = true;

  # The Incus agent (NX-143, NX-290, NX-523): `incus exec` for whoever runs the Incus that hosts this box as a VM, over
  # the hypervisor's vsock only, no port on any network. It starts only when Incus's virtio port appears (its udev
  # rule); NixOS also wants it from multi-user.target, so without the condition a machine of its own or another
  # hypervisor tried it ten times at every boot. base.nix refuses it in production without this condition.
  virtualisation.incus.agent.enable = true;
  systemd.services.incus-agent.unitConfig.ConditionPathExists =
    "/dev/virtio-ports/org.linuxcontainers.incus";
}
