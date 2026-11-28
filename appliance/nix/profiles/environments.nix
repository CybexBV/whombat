# The Whombat environments of the Whombat image (Whombat LNK-01a, NX-520, ONE-01, ONE-02): production, the one
# environment, with its public trust documents. A box picks one with its environment file (environment.nix); absent,
# production.
{ lib, ... }:
let
  prod = ../../manifest/prod;
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
      # New names land directly under whombat.app; a box under the earlier box.whombat.app keeps it and moves when
      # control names whombat.app (the manager allows both zones in prod).
      ownAddressZone = "whombat.app";
      # The production support CA once the Hetzner host has made it (RH-10, ONE-17: `deploy.sh support-ca`, its public
      # half committed as manifest/prod/support-ca.pub); until then no remote help in production.
      supportCaKeys = optional (prod + "/support-ca.pub");
      # No `runtime` settings (NX-524): they would be in every box's image. A merge rule for one company's repository
      # (Whombat AR-58) is looked up by the name the box holds for it, so it belongs on that box, not here.
      # For the record (the manager reads the image's, prod-instance.nix): the GitHub repository's env prod channel keys.
      clientChannelKeys = optional (prod + "/client-channel-keys.json");
      licenceKeys = optional (prod + "/licence-keys.json");
    };
  };
  whombat.defaultEnvironment = lib.mkDefault "prod";
}
