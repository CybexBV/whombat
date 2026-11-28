# The environments a box can be in (Whombat LNK-01, LNK-01a; NX-520): the Whombat image has one, production. One image
# carries every environment it knows, with each one's public trust documents; a root-owned file on the
# box picks one, absent meaning the image's default (internal/environment):
#
#   /etc/whombat/environments.json        {v, default, environments: {<name>: {deviceEnv, controlUrl, appUrl, …}}}
#   /etc/whombat/environments/<name>/…     each environment's trust documents (support CA, clients and licence keys)
#   /persist/whombat/environment.json      0644 root, {v: 1, env: "prod"}: written only by root (`whombat-manager
#                                          environment set`, which moves a box, ONE-06; the bridge release below)
#   /run/whombat/environment/              resolved at every boot by whombat-environment.service, before the manager,
#                                          the runtime, the support service and provisioning: environment.json,
#                                          runtime.env (the runtime's WHOMBAT_APP_URL, …) and links to the documents
#
# The environment is not the update channel (LNK-21): it says which control, app, zone and support CA a box uses. The
# update repository's root and its clients key follow the repository (the helper's), not this file.
#
# Without environments (images before NX-520, the VM tests' and the harness's) nothing here is installed and every
# service keeps its image settings; `whombat.link.possible` then follows the edition as before.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat;
  envs = cfg.environments;
  inherit (lib) mkOption types;
  run = "/run/whombat/environment";
  dir = name: "whombat/environments/${name}";
  docs = {
    supportCaKeys = "support-ca.pub";
    clientChannelKeys = "client-channel-keys.json";
    licenceKeys = "licence-keys.json";
  };
  envType = types.submodule {
    options = {
      deviceEnv = mkOption {
        type = types.enum [
          "local"
          "dev"
          "prod"
        ];
        description = "The env a box made in this environment gets in its identity (device.json): what control expects.";
      };
      controlUrl = mkOption {
        type = types.str;
        default = "";
        description = "Control's origin; \"\" for an environment without Whombat Link.";
      };
      appUrl = mkOption {
        type = types.str;
        default = "";
        description = "The hosted app's origin (WHOMBAT_APP_URL); \"\" for none.";
      };
      embedUrl = mkOption {
        type = types.str;
        default = "";
        description = "The Feedback widget's origin (WHOMBAT_EMBED_URL); \"\" for the app's.";
      };
      relayHost = mkOption {
        type = types.str;
        default = "";
        description = "The relay's host, for the record and the installer's checks.";
      };
      ownAddressZone = mkOption {
        type = types.str;
        default = "";
        description = "Where the boxes' own addresses live (whombat.app, dev.whombat.app); \"\" for none.";
      };
      supportCaKeys = mkOption {
        type = types.nullOr types.path;
        default = null;
        description = "The support CA's public keys of this environment (remote help, RH-05); null: no remote help here.";
      };
      clientChannelKeys = mkOption {
        type = types.nullOr types.path;
        default = null;
        description = "The AI client channel's keys of this environment, for the record (the manager reads the image's).";
      };
      licenceKeys = mkOption {
        type = types.nullOr types.path;
        default = null;
        description = "The licence key set of this environment (inert since LNK-04; kept for a rollback).";
      };
      runtime = mkOption {
        type = types.attrsOf types.str;
        default = { };
        description = "Runtime environment of this environment only (WHOMBAT_… variables, non-secret).";
      };
    };
  };
  imageFile = (pkgs.formats.json { }).generate "environments.json" {
    v = 1;
    default = cfg.defaultEnvironment;
    environments = lib.mapAttrs (
      name: e:
      {
        inherit (e) deviceEnv controlUrl appUrl;
        files = lib.mapAttrs' (opt: file: lib.nameValuePair file "/etc/${dir name}/${file}") (
          lib.filterAttrs (opt: _: e.${opt} != null) docs
        );
      }
      // lib.optionalAttrs (e.embedUrl != "") { inherit (e) embedUrl; }
      // lib.optionalAttrs (e.relayHost != "") { inherit (e) relayHost; }
      // lib.optionalAttrs (e.ownAddressZone != "") { inherit (e) ownAddressZone; }
      // lib.optionalAttrs (e.runtime != { }) { inherit (e) runtime; }
    ) envs;
  };
  on = envs != { };
  refusedCa = ./refused-support-ca.pub;
  # The key lines of a CA file (`ssh-ed25519 <base64> …`), by their key (as support.nix reads them).
  keysOf =
    f:
    map (l: lib.elemAt (lib.splitString " " l) 1) (
      lib.filter (lib.hasPrefix "ssh-ed25519 ") (
        map lib.trim (lib.splitString "\n" (builtins.readFile f))
      )
    );
  manager = "${config.whombat.manager.package}/bin/whombat-manager";
  # The services that read the resolved environment start after it (Before= here: a unit an image lacks is no matter,
  # and every one of them is in the boot transaction anyway).
  readers = [
    "whombat-manager"
    "whombat-manager-recovery"
    "whombat-server"
    "whombat-runner"
    "whombat-support"
    "whombat-self-provision"
  ];
in
{
  options.whombat = {
    environments = mkOption {
      type = types.attrsOf envType;
      default = { };
      description = ''
        Every environment this image can be in (LNK-01a), by name (`prod`). The box file picks one; absent, the
        default. Empty: no environment file is read (the image's own settings, as before NX-520).
      '';
    };
    defaultEnvironment = mkOption {
      type = types.str;
      default = "prod";
      description = "The environment of a box without an environment file (production, LNK-01a).";
    };
    environmentBridge = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        The bridge release (LNK-50): at boot, before anything reads it, write this environment into the box file unless
        the box already has one (`whombat-manager environment set <env> --if-absent`): Cybex's development boxes stay on
        the development stack when a later image defaults to production. Idempotent; never over a choice made.
      '';
    };
    link.possible = mkOption {
      type = types.bool;
      readOnly = true;
      default =
        if on then lib.any (e: e.controlUrl != "") (lib.attrValues envs) else cfg.edition != "community";
      defaultText = lib.literalExpression "any environment has a control (else: the edition isn't community)";
      description = ''
        Whether a box of this image can have Whombat Link (LNK-01): an environment with a control. What follows Link
        at runtime (remote help, the own address) is only in an image where it is possible.
      '';
    };
  };

  config = lib.mkIf on {
    assertions = [
      {
        assertion = envs ? ${cfg.defaultEnvironment};
        message = "whombat.defaultEnvironment ${cfg.defaultEnvironment} is not one of whombat.environments";
      }
      {
        assertion = cfg.environmentBridge == null || envs ? ${cfg.environmentBridge};
        message = "whombat.environmentBridge names an environment this image doesn't have";
      }
      {
        # A refused CA never opens a box in production (RH-05, NX-416): the production environment's CA is never the
        # refused file nor holds any of its keys.
        assertion =
          !(envs ? prod)
          || envs.prod.supportCaKeys == null
          || !(
            envs.prod.supportCaKeys == refusedCa
            || lib.any (k: lib.elem k (keysOf refusedCa)) (keysOf envs.prod.supportCaKeys)
          );
        message = "whombat.environments.prod.supportCaKeys: production never pins a refused support CA (nix/modules/refused-support-ca.pub)";
      }
      {
        # The box's identity says which control it belongs to: a production environment is a prod one.
        assertion = !(envs ? prod) || envs.prod.deviceEnv == "prod";
        message = "whombat.environments.prod.deviceEnv must be prod";
      }
      {
        assertion = lib.all (
          e:
          lib.all (u: u == "" || builtins.match "https://[^/?#[:space:]]+" u != null) [
            e.controlUrl
            e.appUrl
            e.embedUrl
          ]
        ) (lib.attrValues envs);
        message = "whombat.environments: controlUrl, appUrl and embedUrl must be https origins (no path) or empty";
      }
    ];

    environment.etc = {
      "whombat/environments.json".source = imageFile;
    }
    // lib.listToAttrs (
      lib.concatLists (
        lib.mapAttrsToList (
          name: e:
          lib.mapAttrsToList (
            opt: file:
            lib.nameValuePair "${dir name}/${file}" {
              source = e.${opt};
              mode = "0444";
            }
          ) (lib.filterAttrs (opt: _: e.${opt} != null) docs)
        ) envs
      )
    );

    # Resolved at every boot, by root: a box file that names nothing this image has leaves a marker instead, and the
    # manager then runs without Link (never quietly in the default environment).
    # An environment move that stopped (`whombat-manager environment set`, ONE-06) is finished or undone first, by
    # root; when it can be neither, this fails with its record kept, and every unit that reads the environment (the
    # manager first) is held, with the reason on the console and in the journal (R1 #13, R2 A9).
    systemd.services.whombat-environment-move = {
      description = "Whombat: finish or undo an environment move that stopped";
      wantedBy = [ "multi-user.target" ];
      after = [ "whombat-persist.target" ];
      requires = [ "whombat-persist.target" ];
      before = [ "whombat-environment.service" ] ++ map (u: "${u}.service") readers;
      requiredBy = [ "whombat-environment.service" ] ++ map (u: "${u}.service") readers;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${manager} environment recover";
        StandardOutput = "journal+console";
        StandardError = "journal+console";
        UMask = "0022";
      };
    };

    systemd.services.whombat-environment = {
      description = "Whombat: the environment this box is in";
      wantedBy = [ "multi-user.target" ];
      after = [ "whombat-persist.target" "whombat-environment-move.service" ];
      requires = [ "whombat-persist.target" ];
      before = map (u: "${u}.service") readers;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart =
          lib.optional (
            cfg.environmentBridge != null
          ) "${manager} environment set ${cfg.environmentBridge} --if-absent"
          ++ [ "${manager} environment write-run" ];
        UMask = "0022";
      };
    };
  };
}
