# What this image is, for the installer that puts it on a disk (CG-13, NX-80): /etc/whombat/image.json names the
# platform and storage mode (as /etc/whombat/platform does for whombat-install), the environment, the release the
# image was built as, the app's address, and the hosts the box needs at its first start (control, the update
# repository, the relay). The graphical installer reads it from the system it installs, shows it, and checks it can
# reach those hosts before it erases a disk. Nothing in it is secret or per device.
{ config, lib, ... }:
let
  cfg = config.whombat;
  hostOf =
    url:
    let
      m = if url == null then null else builtins.match "[a-z]+://([^/:?#]+).*" url;
    in
    if m == null then "" else lib.head m;
in
{
  options.whombat.relayHost = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = null;
    example = "relay.whombat.com";
    description = ''
      The relay the box connects to (control hands out the worker URL at runtime; this is its host, for the installer's
      reachability check only, CG-13). null: the installer's relay check warns without a host.
    '';
  };

  config.environment.etc."whombat/image.json".text = builtins.toJSON {
    v = 1;
    inherit (cfg) platform environment edition;
    storage = cfg.storage.mode;
    release = cfg.provisioning.selfFactoryRelease;
    # "" on the community edition: no hosted UI (the installer takes it there only).
    appUrl = if cfg.runtime.appUrl == null then "" else cfg.runtime.appUrl;
    hosts = {
      api = if cfg.edition == "community" then "" else hostOf cfg.manager.controlUrl;
      updates = hostOf cfg.manager.tuf.metadataUrl;
      relay = if cfg.relayHost == null then "" else cfg.relayHost;
    };
  };
}
