# The Whombat environments of the Whombat image (Whombat LNK-01a, NX-520, ONE-01, ONE-02): production, and for now the
# maintainers' development stack, with each one's public trust documents. A box picks one with its environment file
# (environment.nix); absent, production.
#
# The development environment stays only until Home has moved to production (ONE-02, ONE-06): a box whose environment
# file says `dev` must keep working on this image. Nothing writes that file any more; the cleanup release removes the
# entry and manifest/dev-instance/ (docs/runbooks/updates.md, “One environment”).
{ lib, ... }:
let
  prod = ../../manifest/prod;
  dev = ../../manifest/dev-instance;
  optional = f: if builtins.pathExists f then f else null;
in
{
  whombat.environments = {
    prod = {
      deviceEnv = "prod";
      controlUrl = "https://api.whombat.com";
      appUrl = "https://app.whombat.com";
      embedUrl = "https://embed.whombat.com";
      relayHost = "relay.whombat.com";
      ownAddressZone = "box.whombat.app";
      # The production support CA once the Hetzner host has made it (RH-10, ONE-17: `deploy.sh support-ca`, its public
      # half committed as manifest/prod/support-ca.pub); until then no remote help in production.
      supportCaKeys = optional (prod + "/support-ca.pub");
      # No `runtime` settings (NX-524): they would be in every box's image. A merge rule for one company's repository
      # (Whombat AR-58) is looked up by the name the box holds for it, so it belongs on that box, not here.
      # For the record (the manager reads the image's, prod-instance.nix): the GitHub repository's env prod channel keys.
      clientChannelKeys = optional (prod + "/client-channel-keys.json");
      licenceKeys = optional (prod + "/licence-keys.json");
    };
    dev = {
      # The development stack's control runs as env `local`: the identities of its boxes say `local`.
      deviceEnv = "local";
      controlUrl = "https://api-dev.whombat.com";
      appUrl = "https://dev.whombat.com";
      embedUrl = "https://embed-dev.whombat.com";
      relayHost = "relay-dev.whombat.com";
      ownAddressZone = "dev.whombat.app";
      supportCaKeys = dev + "/support-ca.pub";
      clientChannelKeys = dev + "/client-channel-keys.json";
      licenceKeys = dev + "/licence-keys.json";
    };
  };
  whombat.defaultEnvironment = lib.mkDefault "prod";
}
