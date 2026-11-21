# The community edition (Whombat HE-24, HE-58…HE-64; NX-445): the same image without control, the relay, the licence or
# remote help. Imported on top of appliance.nix and self-installed.nix (flake.nix `selfInstalledFor`), like the dev and
# prod instance profiles; whombat.edition itself gates what goes in the modules (licence, support, provisioning,
# manager, runtime, network), so this file only says where the edition's trust comes from.
#
# - Its own TUF repository and client channel keys: manifest/community/ pins the root and the clients role's key of the
#   community test repository (release-tools/fixtures/community-test). **Test keys only** (HE-62): nothing is
#   published, and a box with them trusts whoever has this repository. A published community edition gets keys of its
#   own first, and an image pinning them may then be `prod`.
# - Environment `dev` while the keys are test keys: a `prod` box refuses a root with development keys (L-4), and these
#   are development keys by definition. It changes nothing else here: no development conveniences are on (the real
#   runtime bundle, the nix activator, encrypted storage as on every self-installed box).
# - The update repository: `whombat.manager.tuf.*` (the manager takes its newest release, MG-136). No public channel
#   exists (HE-62); the defaults name the address one would have, which answers nothing. The install test builds its
#   release with the address of the repository it serves (`release/build community --updates-url`).
# - No control: the box makes its own identity at first boot (provisioning `edition: community`), stays unclaimed until
#   its owner claims it on its own page with the code on its screen (Whombat HE-59), and has no claim lease, licence,
#   status reports or remote help. No relay: clients come over the direct port, on the local network or Tailscale.
# - Tailscale on (tailscaled runs, signed out, until the owner signs in; with their own login server if they name one,
#   which the firewall lets tailscaled reach on the local network on any port, NX-445).
# - Decided for the community edition (NX-445): no console shell, no Incus agent (both DEV-box conveniences), no hosts
#   service (DEV only, its agents unsigned, NX-152), no serial console line with the claim code (NX-120 is the DEV box's).
{ lib, pkgs, ... }:
let
  pinned = ../../manifest/community;
in
{
  whombat.edition = "community";
  whombat.environment = "dev";
  whombat.manager.tuf = {
    metadataUrl = lib.mkDefault "https://community-updates.whombat.com/metadata/";
    targetsUrl = lib.mkDefault "https://community-updates.whombat.com/targets/";
  };
  whombat.helper.tufRoot = pinned + "/tuf-root.json";
  whombat.clients.channelKeys = pinned + "/client-channel-keys.json";
  # The real runtime bundle: a community box is used, not a stand-in (NX-66 for the dev instance likewise).
  whombat.runtime.package = pkgs.whombat-runtime;
  # Remote help comes through the relay with Whombat support's CA: off (support.nix refuses it on community).
  whombat.support.enable = false;
  whombat.tailscale.enable = true;
  whombat.provisioning = {
    selfRegister = true;
    factoryMedium = false;
  };
}
