# The Whombat image (ONE-02; PI-10, NX-61): one image for every box. Production: control, app, relay and the own
# address's zone of production (environments.nix), updates from the GitHub repository (releases.whombat.com, LNK-24) on
# the box's channel, Production unless its owner chose Beta (wire name `development`, ONE-03), and self-registration
# (every box makes its identity itself, LNK-01; allowed in production on self-installed only, PI-04).
#
# Its public trust documents, in manifest/prod/:
#   tuf-root.json              the GitHub repository's root after the key ceremony (ONE-05: three root keys, two of them
#                              needed, all offline). Until the cutover commits it the image pins the start of that same
#                              chain, manifest/dev-instance/tuf-root.json (the DEV repository's root version 2, which
#                              the GitHub repository continues; one online key). manager.nix refuses a production image
#                              that pins a root of one key unless it is that interim root (whombat.helper.interimRoot).
#   client-channel-keys.json   the AI client channel's key document for env prod (`tufrepo clients-keys` on the
#                              publisher's clone once its channel is env prod, ONE-05). Until then the GitHub
#                              repository's channel is env local, the image pins manifest/dev-instance's, and a box whose
#                              identity is env prod installs no AI clients.
#   licence-keys.json          production control's licence key set (inert since LNK-04; kept for a rollback).
#   support-ca.pub             the production support CA (ONE-17), made on the Hetzner host (`deploy.sh support-ca`);
#                              until it is committed no remote help in production (environments.nix).
#
# What the DEV image gave Home is the product (NX-523): the servers' hub on every box, its agents signed with the Whombat
# agent-signing key; the Incus agent, only inside an Incus VM; the merge re-run setting in production's environment. Not
# here: the serial console line (claim letters for whoever reads the serial port; only dev/devbox read it) and DEV's
# addresses and keys.
#
# Home's move (ONE-02, ONE-06): the image keeps the development environment (environments.nix) until Home has moved, so
# a box whose environment file says `dev` keeps working; nothing writes `dev` any more (no environmentBridge). Such a box
# keeps the Beta channel it followed by default (the channel bridge below). The cleanup release after Home's move
# removes both, the `dev` environment and manifest/dev-instance/ (docs/runbooks/updates.md, “One environment”).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  prod = ../../manifest/prod;
  interim = ../../manifest/dev-instance;
  # The production document when the cutover has committed it, else the interim one of the same repository.
  pinnedOr = name: fallback: if builtins.pathExists (prod + "/${name}") then prod + "/${name}" else fallback;
  required =
    name: what:
    let
      f = prod + "/${name}";
    in
    if builtins.pathExists f then
      f
    else
      throw "manifest/prod/${name} is missing: the Whombat image pins production's ${what} (docs/runbooks/install.md)";
  helper = "${config.whombat.helper.package}/bin/whombat-update-helper";
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
  whombat.helper.tufRoot = pinnedOr "tuf-root.json" (interim + "/tuf-root.json");
  whombat.helper.interimRoot = interim + "/tuf-root.json";
  whombat.licence.keys = required "licence-keys.json" "licence key set (LC-04, NX-38)";
  # Without a channel key document a box installs no Claude Code, so no agent can run a turn.
  whombat.clients.channelKeys = pinnedOr "client-channel-keys.json" (interim + "/client-channel-keys.json");
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

  # The channel bridge (ONE-03): a box still in the development environment that never chose a channel took
  # development as its image's default; this image's default is production, so before the helper or the manager runs,
  # the box records development as its own choice (`set-channel --if-unset`: never over a choice made). Only that
  # environment: a new box starts on Production. Goes with the `dev` environment in the cleanup release.
  systemd.services.whombat-channel-bridge = {
    description = "Whombat: a box on the development stack keeps its Beta updates";
    wantedBy = [ "multi-user.target" ];
    after = [ "whombat-environment.service" ];
    requires = [ "whombat-environment.service" ];
    # The helper runs on the manager's requests (socket activation): before the managers is before its first one.
    before = [
      "whombat-manager.service"
      "whombat-manager-recovery.service"
    ];
    unitConfig.ConditionPathExists = "/persist/whombat/environment.json";
    path = [ pkgs.jq ];
    script = ''
      if jq -e '.name == "dev"' /run/whombat/environment/environment.json >/dev/null 2>&1; then
        exec ${helper} --config /etc/whombat/update-helper.json set-channel development --if-unset
      fi
    '';
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
  };
}
