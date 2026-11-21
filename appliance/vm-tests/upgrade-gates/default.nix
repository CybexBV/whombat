# Upgrade gates (UP-C2, UP-F2; NX-110…NX-119, NX-125, NX-126): a candidate installed as an update of the releases boxes actually run.
# `lib.upgradeGates { candidate = { build; flake; reusedHost ? { build; flake; } }; previous = [ { build; flake; } … ]; }`
# (flake.nix), run by release/upgrade-gates. The gates are this tree's, all seven; the candidate is its own commit's
# flake (its release, its runtime, its release tools), as every previous release is. `previous` is newest first: N−1,
# then N−2, releases from the migration baseline on (./previous.json, IN-415); it may be shorter or empty, and the gates
# that update from a missing release are recorded as not applicable (1, 4, 6 without N−1; 2 without N−2). Each gate is
# a NixOS test (`.driver` to run it outside the sandbox, as the runner does); `record` is what the runner writes about
# the inputs.
#
# A box takes the newest release its update channel lists, so a gate updates its box by publishing: each gate has a
# channel history of its own in the gate repository (./repo.nix), and a step of the test makes the next part visible.
#
#   1  N−1 → candidate                          through manager, helper and the channel repository; data intact
#   2  N−2 → candidate                          a box that skipped a release (see ./update.nix for the steps)
#   3  fresh install from the candidate's ISO   its own identity, first boot healthy, what the console shows
#   4  N−1 → a candidate that fails verification → automatic rollback to N−1, not re-activated afterwards (MG-56)
#   5  migration classes on the candidate's runtime and its host's manager (this tree's update-migration)
#   6  a runtime-only release on N−1's host, then a host release that keeps that runtime
#   7  restore drill: a failed contract migration's checkpoint restored onto a fresh box (this tree's restore-drill)
#
# A runtime-only candidate (build.json `class: runtime`, `reusedHostFrom`: release/build --reuse-host) runs the
# host and manager of the release it reuses (`candidate.reusedHost`, built from that release's commit like a previous
# release; they must be the build's store paths) and its own runtime. Gates 3 (it has no ISO) and 6 (it is itself the
# runtime-only case) don't apply to it (NX-118).
{
  pkgs,
  lib,
  # flake.nix's releaseRuntime, for a candidate whose flake doesn't export its own (before NX-125).
  releaseRuntime,
}:
{
  candidate,
  previous,
  # A self-test of the gates (`release/upgrade-gates --break-candidate`): a candidate broken on purpose must fail them.
  #   "runtime"   its runtime server never starts: gate 1 must fail, the box back on N−1 with its data (gate 4 still
  #               passes: the rollback works)
  #   "rollback"  its update helper can't set a boot generation (its nix-env is `false`), so the rollback the manager
  #               asks for after the reboot fails: gate 4 must fail, the box stuck on the bad candidate instead of back
  #               on N−1. (A longer verify timeout wouldn't do: a host candidate's deadline is set at activation, by the
  #               manager of the release it replaces, NX-113.)
  # Both break the candidate's host: a runtime-only candidate has none of its own.
  breakCandidate ? null,
}:
let
  tls = import ./tls.nix { inherit pkgs; };
  releases = import ./release.nix {
    inherit lib;
    # Every gated image trusts the certificate the gates' update servers show (./nodes.nix).
    boxModules = [ { security.pki.certificateFiles = [ "${tls.cert}/cert.pem" ]; } ];
  };
  candFlake = candidate.flake;
  runtimeOnly = (candidate.build.class or "host") == "runtime";
  breakModule =
    assert lib.assertMsg (!runtimeOnly)
      "upgrade gates: --break-candidate breaks the candidate's host; ${candidate.build.releaseId} is runtime-only";
    {
      runtime =
        { lib, pkgs, ... }:
        {
          systemd.services.whombat-server.serviceConfig.ExecStartPre =
            lib.mkForce "${pkgs.coreutils}/bin/false";
        };
      rollback =
        { pkgs, ... }:
        {
          whombat.helper.extraSettings.nix.NixEnv = "${pkgs.coreutils}/bin/false";
        };
    }
    .${breakCandidate} or (throw "upgrade gates: breakCandidate must be runtime or rollback");
  # Ids in the gate repository (NX-112): a channel signs `whombat-YYYYMMDD.N` and `whombat-dev-YYYYMMDD.N` ids, as one
  # family ordered by day and number, and nothing older than what it lists. The candidate and the previous releases
  # are gated under their published ids, so the box orders them as in the field. The gates' own releases (a candidate
  # made to fail, a runtime-only release, a host release that keeps a runtime) get ids of the candidate's day with
  # numbers no real release reaches, in the order a gate publishes them.
  channelId =
    rid:
    let
      m = builtins.match "whombat-(dev-)?([0-9]{8})\\.([1-9][0-9]{0,3})" rid;
    in
    if m == null then
      throw "upgrade gates: ${rid} is not a release id a channel signs (whombat-YYYYMMDD.N)"
    else
      {
        day = builtins.elemAt m 1;
        number = lib.toInt (builtins.elemAt m 2);
      };
  variantId =
    n:
    let
      c = channelId id;
    in
    assert lib.assertMsg (c.number < 9000) "upgrade gates: ${id} leaves no numbers for the gates' own releases";
    "whombat-dev-${c.day}.${toString (9000 + n)}";
  # A published release (`{ build; flake; reusedHost ? { build; flake; } }`) as the gates build it: a host release from its
  # commit; a runtime-only one (NX-126) as its own runtime on the host of the release it reuses, which a box reaches by a
  # runtime-only update from that release's install.
  hostRelease =
    p:
    releases.host {
      inherit (p) flake build;
      inherit (p.build) releaseId;
    };
  reusedOf =
    p:
    assert lib.assertMsg (p ? reusedHost)
      "upgrade gates: ${p.build.releaseId} is runtime-only (it reuses ${p.build.reusedHostFrom or "?"}'s host): pass that release's build.json";
    hostRelease p.reusedHost;
  published =
    p:
    if (p.build.class or "host") == "runtime" then
      releases.runtimeOnly {
        inherit (p) flake build;
        inherit (p.build) releaseId;
        reused = reusedOf p;
      }
    else
      hostRelease p;
  factoryOf = r: if r.factory == null then r else r.factory;
  prevs = map published previous;
  n1 = if prevs != [ ] then builtins.elemAt prevs 0 else null;
  n2 = if lib.length prevs > 1 then builtins.elemAt prevs 1 else null;
  # Gate 6 (a runtime-only release on N−1's host, then a host release keeping it): host candidates with an N−1.
  hasG6 = !runtimeOnly && n1 != null;

  id = candidate.build.releaseId;
  cand =
    if !runtimeOnly then
      releases.host (
        {
          flake = candFlake;
          inherit (candidate) build;
          releaseId = id;
        }
        // lib.optionalAttrs (breakCandidate != null) { extraModules = [ breakModule ]; }
      )
    else
      releases.runtimeOnly {
        flake = candFlake;
        inherit (candidate) build;
        releaseId = id;
        reused = reusedOf candidate;
      };
  # The release whose host a runtime-only candidate runs (the same derivation as that release's when it is also a
  # previous one).
  reused = cand.reused;
  # The candidate's own release tools, the ones that export and sign its release (NX-112), when they can publish into
  # a channel of a repository directory; this tree's for a candidate from before that.
  candTools = candFlake.packages.x86_64-linux.whombat-release-tools or null;
  toolsFrom =
    if
      candTools != null
      && lib.hasInfix "channel-publish" (
        builtins.readFile "${candFlake.outPath}/release-tools/cmd/tufrepo/main.go"
      )
    then
      "candidate"
    else
      "runner";
  repoLib = import ./repo.nix {
    inherit pkgs lib;
    tools = if toolsFrom == "candidate" then candTools else pkgs.whombat-release-tools;
  };

  # Gates 5 and 7 (NX-125): this tree's update-migration and restore-drill on the stack a box runs with the candidate —
  # the candidate's runtime (its pin, made into release bundles by its own releaseRuntime), the modules, manager,
  # update helper and backup service of the host it runs on (its own; a runtime-only candidate's reused release's), and
  # the candidate's release tools on the control node.
  hostFlake = if runtimeOnly then candidate.reusedHost.flake else candFlake;
  flakePkgs = f: f.inputs.nixpkgs.legacyPackages.x86_64-linux.extend f.overlays.default;
  candPkgs = flakePkgs candFlake;
  hostPkgs = (flakePkgs hostFlake).extend (_: _: { inherit (candPkgs) whombat-release-tools; });
  hostModules = [
    hostFlake.inputs.lanzaboote.nixosModules.lanzaboote
    "${hostFlake}/nix/modules"
    (
      { pkgs, ... }:
      {
        whombat.boot.lzbtPackage =
          hostFlake.inputs.lanzaboote.packages.${pkgs.stdenv.hostPlatform.system}.lzbt;
      }
    )
  ];
  candReleaseRuntime = candFlake.lib.releaseRuntime or releaseRuntime;
  # The candidate's runtime package as its release built it: under the stamp its build recorded, where its tree is
  # given one (a tree of the merged repository), so the runtimes made from it here are the published ones.
  candStamp = releases.stampOf candFlake cand.build;
  migrationRuntime =
    if candStamp ? runtimeStamp then
      candPkgs.whombat-runtime.override { stamp = candStamp.runtimeStamp; }
    else
      candPkgs.whombat-runtime;
  stackTest =
    file:
    hostPkgs.testers.runNixOSTest {
      imports = [ file ];
      _module.args = {
        applianceModules = hostModules;
        releaseRuntime = candReleaseRuntime;
        inherit migrationRuntime;
        managerSource = hostFlake.outPath;
        recoveryUki = null;
        recoveryProbeUki = null;
      };
      defaults.imports = [ ../common/defaults.nix ];
    };
  # Gate 5's `rt-new` is the candidate's published runtime when the candidate's releaseRuntime is the one it was built
  # with (recorded).
  stackRuntime = (candReleaseRuntime migrationRuntime null).outPath;

  # A runtime whose tuple names a version the bundle doesn't report (as update-migration's rt-new-bad): its own store
  # path over the candidate bundle's entries. It activates, reports the candidate's version and fails verification.
  badRuntime = pkgs.runCommand "whombat-runtime-${cand.tuple.runtime.version}-bad" { } ''
    mkdir $out
    for f in ${cand.runtime}/*; do ln -s "$f" $out/; done
  '';
  # Gate 6's runtime (host candidates): the candidate's when it differs from N−1's; otherwise the same source rebuilt
  # as `<version>.g6` (release/build --runtime-label), a distinct runtime-only release.
  r6 =
    if cand.runtime.outPath != n1.runtime.outPath then
      cand.tuple.runtime
    else
      let
        rt =
          ((candFlake.lib.applianceRelease or candFlake.lib.proxmoxRelease) (
            {
              env = if lib.elem "dev" (candFlake.lib.releaseEnvNames or [ "dev" ]) then "dev" else "prod";
              releaseId = id;
              runtimeLabel = "g6";
            }
            // candStamp
          )).runtime;
      in
      cand.tuple.runtime
      // {
        storePath = rt.outPath;
        version = rt.version;
      };
  withRuntime =
    t: rid: rt:
    t
    // {
      releaseId = rid;
      runtime = rt;
    };
  tuples = {
    candidate = cand.tuple;
    bad = withRuntime cand.tuple (variantId 1) (
      cand.tuple.runtime
      // {
        storePath = badRuntime.outPath;
        version = "${cand.tuple.runtime.version}.bad";
      }
    );
  }
  // lib.optionalAttrs (n1 != null) { n1 = n1.tuple; }
  // lib.optionalAttrs hasG6 {
    g6rt = withRuntime n1.tuple (variantId 2) r6;
    g6host = withRuntime cand.tuple (variantId 3) r6;
  }
  // lib.optionalAttrs (n2 != null) { n2 = n2.tuple; };

  # Each gate's channel history (./repo.nix): the release its box was installed from (a first start reads its release
  # from its channel), for a runtime-only previous release the update that brought the box there, then one step per
  # step of the test. A previous release's host is a placeholder (boxes boot it from their disk), except the host a
  # runtime-only candidate runs: a box on another host downloads it (gate 2), as from production's repository.
  hostReused = r: runtimeOnly && r.releaseId == reused.releaseId;
  previousEntry = r: {
    name = r.releaseId;
    inherit (r) tuple;
    placeholderHost = r.factory == null && !hostReused r;
    reuseHost = r.factory != null;
  };
  candidateEntry = {
    name = "candidate";
    tuple = tuples.candidate;
    reuseHost = runtimeOnly;
  };
  # One of the gates' own releases. One that keeps a host its channel lists already is published without it.
  variant = name: reuseHost: {
    inherit name reuseHost;
    tuple = tuples.${name};
  };
  startOf = from: lib.optional (from.factory != null) [ (previousEntry from.factory) ] ++ [ [ (previousEntry from) ] ];
  # A runtime-only candidate's host is the release's it reuses: listed with it where the history hasn't got it yet.
  withReused =
    start: step:
    if runtimeOnly && !lib.any (lib.any (e: e.tuple.releaseId == reused.releaseId)) start then
      [ (previousEntry reused) ] ++ step
    else
      step;
  historyOf =
    from: steps:
    let
      start = startOf from;
    in
    start ++ map (withReused start) steps;
  histories =
    lib.optionalAttrs (n1 != null) {
      "1" = historyOf n1 [ [ candidateEntry ] ];
      # The candidate and, after it, the same release made to fail: the box takes the newest, which is the one that fails.
      "4" = historyOf n1 [
        [
          candidateEntry
          (variant "bad" true)
        ]
      ];
    }
    // lib.optionalAttrs hasG6 {
      "6" = historyOf n1 [
        [ (variant "g6rt" true) ]
        [ (variant "g6host" false) ]
      ];
    }
    // lib.optionalAttrs (!runtimeOnly) { "3" = [ [ candidateEntry ] ]; }
    // lib.optionalAttrs (n2 != null) { "2" = historyOf n2 [ [ candidateEntry ] ]; };
  repo = repoLib.repository histories;

  nodes = import ./nodes.nix { inherit pkgs lib; } {
    inherit repo;
    inherit (repoLib) tools;
  };
  prelude = import ./prelude.nix { inherit pkgs; };
  image = import ./image.nix { inherit lib; };
  # One installed disk per release a box starts from (a runtime-only previous release's is its reused release's).
  images = lib.listToAttrs (
    map (
      r:
      let
        f = factoryOf r;
      in
      lib.nameValuePair f.releaseId (image f)
    ) prevs
  );
  imageOf = r: images.${(factoryOf r).releaseId};
  # Gate 3's ISO: the candidate's installer (its commit's profile, as its flake's installerWith builds the ISO) of its
  # gate image, with the test driver's backdoor.
  iso =
    (candFlake.inputs.nixpkgs.lib.nixosSystem {
      modules = [
        {
          nixpkgs.hostPlatform = "x86_64-linux";
          nixpkgs.overlays = [ candFlake.overlays.default ];
        }
        "${candFlake}/nix/profiles/installer.nix"
        {
          whombat.installer.system = cand.toplevel;
          whombat.installer.recoveryUki = cand.recoveryUki;
          image.baseName = lib.mkForce "whombat-installer-dev";
        }
        (
          { modulesPath, ... }:
          {
            imports = [ (modulesPath + "/testing/test-instrumentation.nix") ];
          }
        )
      ];
    }).config.system.build.isoImage;
  update = import ./update.nix {
    inherit
      pkgs
      lib
      nodes
      prelude
      ;
  };
  step =
    from: t: expect: extra:
    {
      release = t;
      inherit expect;
      reboot = t.host.storePath != from;
    }
    // extra;
  noPrevious = "not applicable: no previous release from the migration baseline on (vm-tests/upgrade-gates/previous.json, IN-415)";
  # Gate 5 updates from the migration test's baseline (../common/migration-baseline.nix): this tree names none, the
  # maintainers' CI gives it one (WHOMBAT_MIGRATION_BASELINE).
  hasBaseline = import ../common/migration-baseline.nix != null;
  notApplicable =
    lib.optionalAttrs (!hasBaseline) {
      "5" = "not applicable: no release to migrate from (vm-tests/common/migration-baseline.json is empty and WHOMBAT_MIGRATION_BASELINE names none)";
    }
    // lib.optionalAttrs (n1 == null) {
      "1" = noPrevious;
      "4" = noPrevious;
      "6" = noPrevious;
    }
    // lib.optionalAttrs (n2 == null) {
      "2" =
        "not applicable: no N−2 from the migration baseline on (vm-tests/upgrade-gates/previous.json, IN-415)";
    }
    // lib.optionalAttrs runtimeOnly {
      "3" =
        "not applicable: runtime-only (no ISO: boxes are installed from ${reused.publishedId}'s, whose host it runs)";
      "6" =
        "not applicable: runtime-only (the candidate is itself a runtime-only release on ${reused.publishedId}'s host)";
    };

  gates =
    lib.optionalAttrs (n1 != null) {
      "1" = update {
        name = "1-n1-candidate";
        gate = "1";
        description = "${n1.publishedId} → ${id}";
        from = n1;
        image = imageOf n1;
        steps = [ (step n1.toplevel.outPath tuples.candidate "healthy" { }) ];
      };
      # The rollback ends in N−1's manager, which decides what happens next: from MG-56 on it waits for the release to
      # be offered again and never re-activates it by itself, though its channel still lists it as the newest; before,
      # the gate environment's single attempt quarantines it (production's three would retry it locally, the DEV
      # finding MG-56 fixes).
      "4" = update {
        name = "4-rollback";
        gate = "4";
        description = "${n1.publishedId} → ${id} made to fail verification → back to ${n1.publishedId}";
        from = n1;
        image = imageOf n1;
        steps = [
          (step n1.toplevel.outPath tuples.bad "rolled-back" {
            code = "unhealthy";
            waitsForControl = n1.verifyFailureWaitsForControl;
            inherit (n1) rollbackAfterS;
          })
        ];
      };
    }
    // lib.optionalAttrs hasG6 {
      "6" = update {
        name = "6-runtime-host";
        gate = "6";
        description = "runtime-only on ${n1.publishedId}'s host, then a host release keeping that runtime";
        from = n1;
        image = imageOf n1;
        steps = [
          (step n1.toplevel.outPath tuples.g6rt "healthy" { })
          (step n1.toplevel.outPath tuples.g6host "healthy" { })
        ];
      };
    }
    // lib.optionalAttrs (!runtimeOnly) {
      "3" = import ./install.nix {
        inherit
          pkgs
          lib
          nodes
          prelude
          ;
      } { inherit cand iso; };
    }
    // {
      "7" = stackTest ./restore-drill.nix;
    }
    // lib.optionalAttrs hasBaseline {
      "5" = stackTest ../update-migration.nix;
    }
    // lib.optionalAttrs (n2 != null) {
      # A box that skipped N−1: its channel lists the candidate as the newest, and the box takes it from N−2. (Managers
      # before MG-43 refused every candidate that migrates the database and needed a release in between; they are from
      # before update channels, which every gated release has.)
      "2" = update {
        name = "2-n2-candidate";
        gate = "2";
        description = "${n2.publishedId} → ${id}";
        from = n2;
        image = imageOf n2;
        steps = [ (step n2.toplevel.outPath tuples.candidate "healthy" { }) ];
      };
    };
in
{
  inherit
    cand
    prevs
    tuples
    repo
    images
    iso
    gates
    ;
  record = {
    releaseId = cand.publishedId;
    gateReleaseId = id;
    inherit breakCandidate runtimeOnly notApplicable;
    candidate = {
      inherit (cand) rev;
      runtimeStorePath = cand.runtime.outPath;
      managerStorePath = cand.manager.outPath;
      matchesBuild = cand.matchesPublished.runtime && cand.matchesPublished.manager;
    }
    // lib.optionalAttrs runtimeOnly {
      reusedHost = {
        releaseId = reused.publishedId;
        inherit (reused) rev;
        hostStorePath = reused.toplevel.outPath;
        matchesPublished = reused.matchesPublished.runtime && reused.matchesPublished.manager;
      };
    };
    previous = map (r: {
      inherit (r)
        rev
        migratingReleases
        verifyFailureWaitsForControl
        hostTimers
        ;
      reusedHost = if r.factory == null then null else r.factory.publishedId;
      releaseId = r.publishedId;
      gateReleaseId = r.releaseId;
      runtimeStorePath = r.runtime.outPath;
      managerStorePath = r.manager.outPath;
      matchesPublished = r.matchesPublished.runtime && r.matchesPublished.manager;
    }) prevs;
    # Whose release tools made the gate repository.
    repositoryTools = toolsFrom;
    # Gates 5 and 7: whose host stack, and whether rt-new is the candidate's published runtime.
    stack = {
      host = if runtimeOnly then reused.publishedId else cand.publishedId;
      runtimeStorePath = stackRuntime;
      runtimeIsCandidates = stackRuntime == cand.runtime.outPath;
      releaseRuntimeFrom = if candFlake.lib ? releaseRuntime then "candidate" else "runner";
    };
    gates = lib.mapAttrs (_: g: g.name or g.config.name or "") gates;
  };
}
