# One release as the upgrade gates install it (NX-110, NX-111): the release's own source (a flake: the candidate's tree,
# or `builtins.getFlake "git+file://…?rev=<build.json source.rev>"` for a published one), its `lib.applianceRelease`
# for the dev image (`lib.proxmoxRelease` in sources before PI-22), then ./gate-env.nix on top. Manager and runtime are
# that source's own, so their store paths are the published ones (`matchesPublished`); the host differs from the
# published one by the environment module and the id it was built as.
#
#   host { flake, build, releaseId, hostVersion ? build.tuple.host.version, runtimeLabel ? build.runtime.label }
#   runtimeOnly { flake, build, releaseId, reused }   a release/build --reuse-host release (NX-118, NX-126): the
#                                                     host, manager and image of `reused` (a `host` release), its own
#                                                     runtime; `factory` is the release a box starts from to reach it
#
# `build` is the release's build.json (release/build); `publishedId` its id. `releaseId` is the id the release has
# in the gate repository (the image's factory release, NX-112): its published id, which a channel signs.
# The gate's tuple is the recorded one under that id, with the gate host (its NAR hash is filled in by ./repo.nix) and
# `hostVersion` (its published host version, so the boxes order versions as in the field).
{
  lib,
  # Modules every gated image gets beside ./gate-env.nix: what must be the runner's, not the release's own (the
  # certificate of the gates' update servers).
  boxModules ? [ ],
}:
let
  system = "x86_64-linux";
  # The gate environment's verify timeout (./gate-env.nix) and, for managers that take it (MG-55, NX-126), its host
  # reboot timeout: a host candidate that fails verification is rolled back this long after its activation.
  verifyS = 180;
  hostRebootS = 180;
  # A manager before MG-55 has its 20 minutes.
  defaultHostRebootS = 1200;
  # The release environment a release's own flake builds the gated image from: the DEV image's before ONE-02, the
  # Whombat image's after (that flake has no `dev`).
  gateEnv = flake: if lib.elem "dev" (flake.lib.releaseEnvNames or [ "dev" ]) then "dev" else "prod";
in
rec {
  # The runtime's stamp, for a release whose flake is given one (a tree of the merged repository: `takesRuntimeStamp`):
  # the one its build recorded, so the runtime evaluated here is the one that was built. A tree from before the merge
  # reads its pinned Whombat by itself.
  stampOf =
    flake: build:
    lib.optionalAttrs (flake.lib.takesRuntimeStamp or false) {
      runtimeStamp =
        build.runtime.stamp
          or (throw "upgrade gates: ${build.releaseId}'s build.json records no runtime stamp (runtime.stamp)");
    };

  host =
    {
      flake,
      build,
      releaseId,
      hostVersion ? build.tuple.host.version,
      runtimeLabel ? build.runtime.label or null,
      extraModules ? [ ],
    }:
    let
      published = (flake.lib.applianceRelease or flake.lib.proxmoxRelease) (
        {
          env = gateEnv flake;
          inherit releaseId;
        }
        // stampOf flake build
        // lib.optionalAttrs (runtimeLabel != null) { inherit runtimeLabel; }
      );
      engine = builtins.readFile "${flake.outPath}/manager/internal/update/engine.go";
      managerConfig = builtins.readFile "${flake.outPath}/manager/internal/config/config.go";
      # The manager's configuration refuses unknown keys: short host timers only for managers that have them.
      hostTimers = lib.hasInfix ''json:"hostRebootTimeoutMs"'' managerConfig;
      timers = {
        whombat.manager.settings.policy.hostRebootTimeoutMs = hostRebootS * 1000;
      };
      appliance = published.appliance.extendModules {
        modules = [ ./gate-env.nix ] ++ boxModules ++ lib.optional hostTimers timers ++ extraModules;
      };
      cfg = appliance.config;
      # A box learns of a release from its channel: an image from before update channels can't be gated this way.
      channels = (appliance.options.whombat.helper or { }) ? defaultChannel;
    in
    assert lib.assertMsg channels
      "upgrade gates: ${build.releaseId} is from before update channels (its image has no whombat.helper.defaultChannel); the gates publish into a channel";
    assert lib.assertMsg (build.class or "host" == "host")
      "upgrade gates: ${build.releaseId} is a runtime-only release (it reuses ${build.reusedHostFrom or "?"}'s host), not a host release";
    rec {
      inherit
        releaseId
        build
        appliance
        hostTimers
        ;
      publishedId = build.releaseId;
      src = flake.outPath;
      rev = build.source.rev;
      toplevel = cfg.system.build.toplevel;
      runtime = cfg.whombat.runtime.package;
      manager = cfg.whombat.manager.package;
      recoveryUki = cfg.whombat.boot.recoveryUki;
      # A box on this release is installed from it.
      factory = null;
      # The release's own packages (its overlay on its nixpkgs): what its installer and tools were built with.
      pkgs = flake.inputs.nixpkgs.legacyPackages.${system}.extend flake.overlays.default;
      # The published tuple's versions and schema facts, this image's host.
      # Store paths are the built ones (the same strings as the build's when `matchesPublished`, with their derivations).
      tuple = build.tuple // {
        inherit releaseId;
        host = build.tuple.host // {
          version = hostVersion;
          storePath = toplevel.outPath;
          narHash = "";
        };
        manager = build.tuple.manager // {
          storePath = manager.outPath;
        };
        runtime = build.tuple.runtime // {
          storePath = runtime.outPath;
        };
      };
      matchesPublished = {
        runtime =
          published.runtime.outPath == build.tuple.runtime.storePath
          && runtime.outPath == published.runtime.outPath;
        manager =
          published.manager.outPath == build.tuple.manager.storePath
          && manager.outPath == published.manager.outPath;
      };
      # Whether this release's manager judges a migrating candidate by its target schema (MG-43): managers before it
      # refuse every candidate whose runtime must migrate (UP-E6).
      migratingReleases = lib.hasInfix "CheckMigratingActivation" engine;
      # Whether this release's manager, after a candidate failed verification and was rolled back, waits for control to
      # assign it again instead of retrying it by itself (MG-56).
      verifyFailureWaitsForControl = lib.hasInfix "afterVerificationFailure" engine;
      # How long after its activation a host candidate that fails verification is rolled back by this manager.
      rollbackAfterS = (if hostTimers then hostRebootS else defaultHostRebootS) + verifyS;
    };

  runtimeOnly =
    {
      flake,
      build,
      releaseId,
      reused,
    }:
    let
      # Its runtime from its commit (release/build builds it the same way, NX-71).
      runtime =
        ((flake.lib.applianceRelease or flake.lib.proxmoxRelease) (
          {
            env = gateEnv flake;
            inherit releaseId;
          }
          // stampOf flake build
          // lib.optionalAttrs ((build.runtime.label or null) != null) { runtimeLabel = build.runtime.label; }
        )).runtime;
    in
    # The release it reuses, or the host release that one runs when it is runtime-only too (IN-128): then the published
    # host and manager must be the ones this build recorded.
    assert lib.assertMsg
      (
        reused.publishedId == build.reusedHostFrom
        || (
          reused.build.tuple.host.storePath == build.tuple.host.storePath
          && reused.build.tuple.manager.storePath == build.tuple.manager.storePath
        )
      )
      "upgrade gates: ${build.releaseId} reuses ${build.reusedHostFrom}'s host, not ${reused.publishedId}'s";
    {
      inherit
        releaseId
        build
        runtime
        reused
        ;
      publishedId = build.releaseId;
      rev = build.source.rev;
      # Everything a box runs but the runtime is the reused release's (its manager decides the gates' steps).
      inherit (reused)
        toplevel
        manager
        recoveryUki
        hostTimers
        migratingReleases
        verifyFailureWaitsForControl
        rollbackAfterS
        ;
      # A box reaches it from the reused release's install, by a runtime-only update.
      factory = reused;
      # The build's tuple (runtime facts, versions) with the gates' host: the reused release's gate image.
      tuple = build.tuple // {
        inherit releaseId;
        host = reused.tuple.host;
        manager = reused.tuple.manager;
        runtime = build.tuple.runtime // {
          storePath = runtime.outPath;
        };
      };
      matchesPublished = {
        runtime = runtime.outPath == build.tuple.runtime.storePath;
        manager =
          reused.manager.outPath == build.tuple.manager.storePath
          && reused.matchesPublished.runtime
          && reused.matchesPublished.manager;
      };
    };
}
