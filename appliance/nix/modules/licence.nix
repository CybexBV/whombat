# The appliance licence's pinned key set (LC-03, LC-04, NX-38). The runtime (WHOMBAT_LICENCE_KEYS_FILE, required in
# managed mode, runtime MR-55) and the manager (licence.keysFile, MG-34) trust only this file: tokens from control
# verify against it, and nothing on the device ever fetches licence keys. Rotation ships a release whose key set
# also carries the next key (LC-03).
{ config, lib, ... }:
let
  cfg = config.whombat.licence;
  env = config.whombat.environment;
  inherit (lib) mkOption types;
  keySet = if cfg.keys == null then null else builtins.fromJSON (builtins.readFile cfg.keys);
  kids = if keySet == null then [ ] else map (k: k.kid) (keySet.keys or [ ]);
  # Development and test kids (control's dev-init writes lic-local-…, CL-39; the VM tests' TEST set is lic-test-…).
  devKid = k: lib.hasPrefix "lic-local-" k || lib.hasPrefix "lic-dev-" k || lib.hasPrefix "lic-test" k;
in
{
  options.whombat.licence = {
    keys = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = ''
        The licence key set of this environment: a LicenceKeySet {v: 1, env, keys: [Ed25519 JWK, 1…8]}
        (public keys only), installed at /etc/whombat/licence-keys.json (0444). Its env must be this image's
        environment (a non-prod image may pin a `test` set). A prod image without it fails to build: prod has no
        licence key until the production key ceremony (LC-04). null elsewhere: the runtime refuses to start in
        managed mode and the manager renews nothing.
      '';
    };
    file = mkOption {
      type = types.str;
      default = "/etc/whombat/licence-keys.json";
      readOnly = true;
      description = "Where the pinned key set is installed.";
    };
  };

  config = {
    assertions = [
      # The licence is inert (Whombat LNK-04): nothing requires a key set any more, on any image or edition. A key set an
      # image does pin is still checked, so a rollback to the release before finds a sound one.
      {
        assertion =
          keySet == null
          || (
            (keySet.v or null) == 1
            && builtins.isList (keySet.keys or null)
            && keySet.keys != [ ]
            && lib.length keySet.keys <= 8
            && lib.all (k: (k.kty or "") == "OKP" && (k.crv or "") == "Ed25519" && lib.hasPrefix "lic-" (k.kid or "")) keySet.keys
          );
        message = "whombat.licence.keys is not a LicenceKeySet of Ed25519 keys with lic- kids";
      }
      {
        assertion = keySet == null || (if env == "prod" then keySet.env == "prod" else keySet.env != "prod");
        message = "whombat.licence.keys is for environment ${if keySet == null then "?" else keySet.env or "?"}, the image is ${env}";
      }
      {
        assertion = env != "prod" || !(lib.any devKid kids);
        message = "whombat.licence.keys carries a development or test key (lic-local-/lic-dev-/lic-test…): never in prod";
      }
    ];

    environment.etc."whombat/licence-keys.json" = lib.mkIf (cfg.keys != null) {
      source = cfg.keys;
      mode = "0444";
    };
  };
}
