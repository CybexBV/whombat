{
  description = "Whombat managed appliance: NixOS host, images, provisioning and VM tests";

  inputs = {
    # Stable release branch only (NX-01). The exact revision is pinned in flake.lock; bump it
    # deliberately with `nix flake update nixpkgs` and re-run every check.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

    # Secure Boot + boot counting (NX-05). Tagged release, built against our nixpkgs.
    lanzaboote = {
      url = "github:nix-community/lanzaboote/v1.1.0";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # The Whombat runtime (server, runner, CLI, web app) and the hosts service (the hub and its agents) are no inputs:
    # they are the folders beside this one, read through narrow copies (nix/lib/sources.nix). A release is one commit
    # of the repository.

    # Hermes Agent, the engine the runner drives over ACP (Whombat HE-10, NX-430): pinned to a tested release and built
    # here (nix/packages/hermes) with our nixpkgs' Python 3.14, not through its own flake (whose nixpkgs-unstable,
    # flake-parts, home-manager and npm inputs would come along). A new pin only after our tests (NX-433).
    hermes = {
      url = "github:NousResearch/hermes-agent/8fc0374447313e276f6b9a2764bfc750190c966a"; # v0.23.4
      flake = false;
    };
    # The uv2nix tool chain Hermes's own flake builds its locked Python environment with, at the revisions its
    # flake.lock names for that release, on our nixpkgs (NX-430). Bumped with the Hermes pin, to its lock's revisions.
    pyproject-nix = {
      url = "github:pyproject-nix/pyproject.nix/ddc400a6883b042646d0940e65971bb7f7e96107";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    uv2nix = {
      url = "github:pyproject-nix/uv2nix/0fdaa03ea3c3c16dbb1fe4d69108f07227a4b42d";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
    };
    pyproject-build-systems = {
      url = "github:pyproject-nix/build-system-pkgs/a17819c85163988e063806ffc4f6d2716bc8ead8";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.uv2nix.follows = "uv2nix";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      lanzaboote,
      hermes,
      pyproject-nix,
      uv2nix,
      pyproject-build-systems,
      ...
    }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = lib.genAttrs systems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};

      # What the builds read of the repository this folder is in (the root is one folder up), as narrow copies with
      # fixed names, and the fixed hashes of what they download.
      sources = import ./nix/lib/sources.nix {
        inherit lib;
        root = ./..;
      };
      # The nixpkgs every download was fetched with (flake.lock): part of what a fixed hash was taken for.
      nixpkgsRev = nixpkgs.rev;

      # The appliance's semver (UP-A1, NX-105): the core of every manager and helper version. A release build
      # (`applianceRelease`) makes it `<semver>-<appliance commit time UTC YYYYMMDDHHMMSS>.<shortrev>`, ordered by commit
      # time; every other build is `<semver>-0.dev`, so VM tests and dev images don't rebuild on every commit (UP-X09:
      # `0.dev` sorts before every commit time, so a box with a dev-built manager takes releases, and at or above
      # control's manager floor `<semver>-0`). Raise it when a manager must compare newer than every one before it
      # whatever its commit time (UP-A2). 0.3.0: managers that read closure indexes (UP-X14, UP-X17); "manager at least
      # 0.3.0-0" means a box takes index-only releases.
      applianceVersion = "0.3.0";
      # The manager and helper of a release build of this commit (NX-105). A tree with uncommitted changes has no rev
      # (`dirtyShortRev`; community releases with --allow-dirty only). This is the one place that reads the commit
      # being built: a host release's manager and helper are new with it, and nothing else may be.
      applianceReleaseVersion = "${applianceVersion}-${self.lastModifiedDate or "19700101000000"}.${
        self.shortRev or self.dirtyShortRev or "dirty"
      }";

      # Packages of this repository, added to pkgs as an overlay.
      overlay =
        final: _prev:
        let
          go = final.callPackage ./nix/packages/go.nix {
            inherit sources nixpkgsRev;
            version = "${applianceVersion}-0.dev";
          };
          voiceEngines = final.callPackage ./nix/packages/voice-engines { };
          voiceModels = final.callPackage ./nix/packages/voice-models { };
        in
        {
          inherit (go)
            whombat-provision
            whombat-manager
            whombat-update-helper
            whombat-release-tools
            whombat-backup
            whombat-recovery
            whombat-console
            whombat-installer-ui
            whombat-dns-fallback
            whombat-vault-wall
            ;
          whombat-standin-runtime = final.callPackage ./nix/packages/standin-runtime { };
          # The real runtime bundle from this repository (PI-07, NX-41), with its Hermes (NX-483). No release: the fixed
          # stamp and the version `<package.json>-0.dev` (a release gives it its stamp: `applianceRelease`).
          whombat-runtime = final.callPackage ./nix/packages/runtime {
            inherit sources nixpkgsRev;
            hermes = final.whombat-hermes;
          };
          # Hermes Agent for the runner (Whombat HE-10, NX-430…NX-435): the pinned source with Whombat's plugin and
          # patches from this repository's packages/hermes-whombat. Part of the runtime bundle, not the host (NX-483).
          whombat-hermes = final.callPackage ./nix/packages/hermes {
            src = hermes;
            inherit uv2nix pyproject-nix pyproject-build-systems;
            plugin = sources.hermesPlugin;
          };
          # The hosts service's hub and agents from hosts/ (NX-152).
          whombat-hosts = final.callPackage ./nix/packages/hosts { inherit sources nixpkgsRev; };
          # Its agents with the update key, unsigned files (the maintainers' sign-agents signs them), and the signing
          # tool (NX-157).
          whombat-hosts-agents = final.whombat-hosts.passthru.agents;
          whombat-hosts-sign = final.whombat-hosts.passthru.sign;
          whombat-appliance-tools = final.callPackage ./nix/packages/appliance-tools { };
          # The graphical installer's and console's web page (CG-01, CG-02).
          whombat-console-ui = final.callPackage ./nix/packages/console-ui { inherit sources nixpkgsRev; };
          # Speech for the desk display (NX-175…NX-184): the service, its two programs and its two models.
          inherit (go) whombat-voice;
          voice-whisper = voiceEngines.whisper;
          voice-vulkan = voiceEngines.vulkan;
          voice-kokoro = voiceEngines.kokoro;
          voice-models-manifest = voiceModels.manifest;
          voice-test-whisper = voiceModels.testWhisper;
          voice-test-parakeet = voiceModels.testParakeet;
          voice-kokoro-model = voiceModels.kokoro;
          voice-supertonic-model = voiceModels.supertonic;
          # Stay unlocked while you're here (NX-280…): the service, its camera program and its face detector.
          inherit (go) whombat-presence;
          presence-watch = final.callPackage ./nix/packages/presence-engine { };
          presence-model = final.callPackage ./nix/packages/presence-model { };
          # Bluetooth on the box (NX-350…): the service the runtime pairs devices through.
          inherit (go) whombat-bluetooth;
          # Input devices plugged in after the kiosk started (NX-400…).
          inherit (go) whombat-kiosk-udev;
          # Remote help (NX-411…): the support service.
          inherit (go) whombat-support;
        };

      # lzbt is wrapped by storage.nix (the PCR 11 policy is signed after every install).
      lzbtModule =
        { pkgs, ... }:
        {
          whombat.boot.lzbtPackage = lanzaboote.packages.${pkgs.stdenv.hostPlatform.system}.lzbt;
        };

      baseModules = [
        lanzaboote.nixosModules.lanzaboote
        ./nix/modules
        lzbtModule
        { nixpkgs.overlays = [ overlay ]; }
      ];

      mkSystem =
        system: modules:
        lib.nixosSystem {
          modules = baseModules ++ [ { nixpkgs.hostPlatform = system; } ] ++ modules;
        };

      # Systems that are not the appliance (installer, recovery) get the overlay only.
      mkBare =
        system: modules:
        lib.nixosSystem {
          modules = [
            {
              nixpkgs.hostPlatform = system;
              nixpkgs.overlays = [ overlay ];
            }
          ]
          ++ modules;
        };

      recoveryFor = system: mkBare system [ ./nix/profiles/recovery.nix ];
      # VM tests only: the same recovery environment with its kernel log on the serial console and a TPM
      # probe (vm-tests/common/recovery-probe.nix).
      recoveryProbeUkiFor =
        system:
        (mkBare system [
          ./nix/profiles/recovery.nix
          ./vm-tests/common/recovery-probe.nix
        ]).config.system.build.whombatRecoveryUki;
      recoveryUkiFor =
        system:
        if system == "x86_64-linux" then
          (recoveryFor system).config.system.build.whombatRecoveryUki
        else
          null;
      applianceFor =
        system: extra:
        mkSystem system (
          [
            ./nix/profiles/appliance.nix
            { whombat.boot.recoveryUki = recoveryUkiFor system; }
          ]
          ++ extra
        );
      installerWith =
        system: name: appliance:
        mkBare system [
          ./nix/profiles/installer.nix
          {
            whombat.installer.system = appliance.config.system.build.toplevel;
            whombat.installer.recoveryUki = recoveryUkiFor system;
            image.baseName = lib.mkForce name;
          }
        ];
      installerFor = system: installerWith system "whombat-factory-installer" (applianceFor system [ ]);
      # The self-installed platform (PI-02, PI-09, PI-21, PI-22; NX-50…NX-52): a dedicated machine or a VM, from the ISO;
      # host-encrypted storage, no TPM, keys not enrolled.
      selfInstalledFor =
        system: extra: applianceFor system ([ ./nix/profiles/self-installed.nix ] ++ extra);
      # The Whombat image (ONE-02; PI-10, NX-61): one image for every box, production by default, with the real runtime
      # bundle. Needs manifest/prod/licence-keys.json; the GitHub repository's root and client channel keys come from
      # manifest/prod/ once the cutover commits them, from manifest/dev-instance/ until then (prod-instance.nix).
      applianceSelfProd = selfInstalledFor "x86_64-linux" [ ./nix/profiles/prod-instance.nix ];
      # The community edition (Whombat HE-58, NX-445): no control, relay, licence or remote help; its own TUF repository
      # (test keys only, manifest/community/) and the real runtime bundle.
      applianceSelfCommunity = selfInstalledFor "x86_64-linux" [ ./nix/profiles/community-instance.nix ];

      # One release of the self-installed image (NX-66…NX-69; release/build): the appliance of an environment
      # with `selfFactoryRelease` = the release id (the id is chosen first; the toplevel depends on it), its
      # installer ISO, and what the release tuple is made of. `runtimeStamp` is the commit the runtime bundle says it
      # is (below). `runtimeLabel` rebuilds the runtime bundle as `<version>.<label>` (a runtime-only release of the
      # same files: proves that update path).
      # One image (ONE-02): `prod` is every Whombat's release; the DEV image is gone (its last releases are read only:
      # host-path, iso of an older build use that build's own flake).
      releaseEnvs = {
        prod = {
          profile = ./nix/profiles/prod-instance.nix;
          isoName = "whombat-installer";
        };
        # Release ids whombat-community-YYYYMMDD.N, signed by the community repository only (UP-X27, NX-445).
        community = {
          profile = ./nix/profiles/community-instance.nix;
          isoName = "whombat-installer-community";
        };
      };
      # The runtime of a release reports its own Nix version (NX-71): the manager accepts a candidate only when the
      # runtime's `/health` version is the tuple's `runtime.version`, and TUF refuses different bytes under a published
      # `runtime/<version>/…` target, so the version must name this bundle, not Whombat's package.json: it is
      # `<package.json>-<commit time>.<shortrev>` (NX-105). `bundle:runtime --version` compiles it in; the install step
      # follows the renamed bundle.
      # `label` (dev only) appends `.<label>`: the same source as a distinct bundle, to prove a runtime-only release.
      releaseRuntime =
        runtime: label:
        runtime.overrideAttrs (
          o:
          let
            pkgVersion = (lib.importJSON "${o.src}/package.json").version;
            v = if label == null then o.version else "${o.version}.${label}";
            subst =
              what: from: to: str:
              let
                r = builtins.replaceStrings [ from ] [ to ] str;
              in
              if r == str then throw "releaseRuntime: the runtime's ${what} no longer contains ${from}" else r;
          in
          {
            version = v;
            __intentionallyOverridingVersion = true;
            buildPhase =
              subst "buildPhase" ''pnpm bundle:runtime --out "$NIX_BUILD_TOP/bundle"''
                ''pnpm bundle:runtime --out "$NIX_BUILD_TOP/bundle" --version ${v}''
                o.buildPhase;
            installPhase = subst "installPhase" "\"version\":\"${pkgVersion}\"" "\"version\":\"${v}\"" (
              subst "installPhase" "/whombat-runtime-${pkgVersion}-linux-" "/whombat-runtime-${v}-linux-"
                o.installPhase
            );
          }
        );
      # The Hermes a runtime source pins (Whombat `packages/agent-runtime/src/hermes/pin.ts`, HE-28): the runner accepts
      # no other version (its check says `outdated`), so the runtime's Hermes must be that release (NX-433, NX-483). A
      # source without the file (before Hermes) pins none.
      whombatHermesPin =
        src:
        let
          # A path below the tree, never a string that names it: the string would carry the whole tree with it.
          file = src + "/packages/agent-runtime/src/hermes/pin.ts";
          lines = lib.splitString "\n" (builtins.readFile file);
          field =
            key:
            let
              m = lib.findFirst (x: x != null) null (map (builtins.match " *${key}: '([^']+)',?") lines);
            in
            if m == null then throw "${toString file} names no ${key}" else builtins.head m;
        in
        if builtins.pathExists file then
          {
            version = field "version";
            commit = field "commit";
          }
        else
          null;
      # A runtime whose Hermes isn't its Whombat's pin fails evaluation (NX-483): the job that moves the pin moves both
      # (NX-485), and a release can't ship a Hermes its runner refuses. Since the pin is in Whombat's source, a new Hermes
      # is a new Whombat commit, so a new runtime version (TUF refuses other bytes under a published one, NX-71).
      assertHermesPin =
        runtime:
        let
          h = runtime.passthru.hermes or null;
          pin = whombatHermesPin runtime.passthru.tree;
        in
        lib.assertMsg
          (
            h == null
            || pin == null
            || (h.passthru.hermesVersion == pin.version && h.passthru.hermesRev == pin.commit)
          )
          "the runtime's Hermes is ${h.passthru.hermesVersion} (${h.passthru.hermesRev}), but Whombat ${
            runtime.passthru.whombatRev or "?"
          } pins ${pin.version} (${pin.commit}) in packages/agent-runtime/src/hermes/pin.ts: move both (NX-433, NX-485)";
      # A release's Go build (NX-105): the manager and the helper carry the release version of this commit (the same
      # vendored modules: `goModules` is named after the version otherwise).
      releaseGo =
        pkg:
        assert lib.assertMsg (
          builtins.match "[0-9]{1,19}\\.[0-9]{1,19}\\.[0-9]{1,19}" applianceVersion != null
        ) "flake.nix: applianceVersion ${applianceVersion} isn't MAJOR.MINOR.PATCH (NX-105, MG-50)";
        pkg.overrideAttrs (o: {
          version = applianceReleaseVersion;
          __intentionallyOverridingVersion = true;
          inherit (o) goModules;
        });
      # A release's runtime (NX-105): Whombat's package.json a plain MAJOR.MINOR.PATCH (a "+" would make the whole runtime
      # version build metadata, so every runtime compared equal; a pre-release core would misorder; a numeric part beyond
      # 19 digits compares as text: MG-50) at 0.2.0 or later, so every runtime of the commit-time scheme compares newer
      # than every `0.1.0-<rev>` in the field (UP-A2), and a version the contracts' VersionString takes.
      checkedReleaseRuntime =
        runtime: label:
        let
          r = releaseRuntime runtime label;
          pkgVersion = (lib.importJSON "${runtime.src}/package.json").version;
        in
        assert lib.assertMsg (builtins.match "[0-9]{1,19}\\.[0-9]{1,19}\\.[0-9]{1,19}" pkgVersion != null)
          "applianceRelease: package.json's version ${pkgVersion} isn't MAJOR.MINOR.PATCH (no pre-release, no \"+\"): release runtime versions must order by commit time (NX-105, MG-50)";
        assert lib.assertMsg (lib.versionAtLeast pkgVersion "0.2.0")
          "applianceRelease: package.json says ${pkgVersion}; release runtimes need 0.2.0 or later so their versions (<semver>-<commit time>.<rev>) compare newer than every 0.1.0-<rev> runtime in the field (UP-A1, UP-A2, NX-105).";
        assert lib.assertMsg (lib.stringLength r.version <= 64)
          "applianceRelease: runtime version ${r.version} is longer than 64 characters (contracts VersionString)";
        assert lib.assertMsg (!lib.hasInfix "+" r.version)
          "applianceRelease: runtime version ${r.version} has a \"+\" (build metadata is ignored when versions are compared; MG-50)";
        assert assertHermesPin runtime;
        r;
      # A release's runtime stamp: the commit the bundle says it is, with its commit time as seconds since 1970 and as
      # UTC YYYYMMDDHHMMSS. The release tools choose it once per release and record it (build.json `runtime.stamp`):
      # the newest published runtime's stamp while this commit builds that very runtime, else this commit's. The same
      # files under the same stamp are the same derivation, so a release that changes nothing of the runtime keeps the
      # published one, version and bytes. Nothing here takes "this commit" by itself.
      checkedStamp =
        stamp:
        assert lib.assertMsg (stamp != null)
          "applianceRelease: a release needs its runtime's stamp: runtimeStamp = { rev = \"<commit>\"; time = <its commit time, seconds since 1970>; date = \"<the same, UTC YYYYMMDDHHMMSS>\"; } (release/build --runtime-stamp)";
        assert lib.assertMsg (
          builtins.isString (stamp.rev or null) && builtins.match "[0-9a-f]{40}" stamp.rev != null
        ) "applianceRelease: runtimeStamp.rev must be a full commit id";
        assert lib.assertMsg (builtins.isInt (stamp.time or null) && stamp.time > 0)
          "applianceRelease: runtimeStamp.time must be the commit time in seconds since 1970";
        assert lib.assertMsg (
          builtins.isString (stamp.date or null) && builtins.match "[0-9]{14}" stamp.date != null
        ) "applianceRelease: runtimeStamp.date must be the commit time as UTC YYYYMMDDHHMMSS";
        {
          inherit (stamp) rev time date;
        };
      applianceRelease =
        {
          env,
          releaseId,
          runtimeStamp ? null,
          runtimeLabel ? null,
          # The update repository's base URL (`<url>metadata/`, `<url>targets/`) instead of the profile's: the community
          # install test builds its release against the repository it serves (NX-445). null: the profile's.
          updatesUrl ? null,
        }:
        let
          system = "x86_64-linux";
          e =
            releaseEnvs.${env}
              or (throw "applianceRelease: env must be one of ${toString (lib.attrNames releaseEnvs)}");
          stamp = checkedStamp runtimeStamp;
          appliance = selfInstalledFor system [
            e.profile
            (
              { pkgs, ... }:
              {
                whombat.provisioning.selfFactoryRelease = releaseId;
                whombat.runtime.package = lib.mkOverride 90 (
                  checkedReleaseRuntime (pkgs.whombat-runtime.override { inherit stamp; }) runtimeLabel
                );
                whombat.manager.package = lib.mkOverride 90 (releaseGo pkgs.whombat-manager);
                whombat.helper.package = lib.mkOverride 90 (releaseGo pkgs.whombat-update-helper);
              }
            )
            (lib.optionalAttrs (updatesUrl != null) {
              whombat.manager.tuf = {
                metadataUrl = "${updatesUrl}metadata/";
                targetsUrl = "${updatesUrl}targets/";
              };
            })
          ];
          installer = installerWith system e.isoName appliance;
        in
        {
          inherit appliance;
          inherit (appliance.config.whombat) environment;
          toplevel = appliance.config.system.build.toplevel;
          manager = appliance.config.whombat.manager.package;
          runtime = appliance.config.whombat.runtime.package;
          iso = installer.config.system.build.isoImage;
          isoFile = "${e.isoName}.iso";
          # The host ABI the runtime declares it needs (tuple host.abi, runtime.hostAbi): 1 since the first tuple
          # (manifest/pins.json); raised when the host stops providing something a runtime relies on.
          hostAbi = 1;
        };
    in
    {
      overlays.default = overlay;

      # release/build (NX-66): `lib.applianceRelease { env = "prod" | "community"; releaseId; runtimeStamp;
      # runtimeLabel ? null; }` (`env = "dev"` in trees before ONE-02; no `runtimeStamp` in trees whose runtime was a
      # pinned input: `lib.takesRuntimeStamp` says which)
      # (`lib.proxmoxRelease` is its name before PI-22, kept for tools of older trees that evaluate this one).
      # release/upgrade-gates (UP-C2, NX-110, NX-118): `lib.upgradeGates { candidate = { build; flake; reusedHost ? { build;
      # flake; } }; previous = [ { build; flake; } … ]; }`: a candidate (its own commit's flake) installed as an update of
      # previous releases built from their commits. The gates are this tree's; the candidate, the releases and their
      # tools are theirs.
      # `lib.releaseRuntime runtime label`: a release's runtime bundle from a runtime package (NX-71); the upgrade gates
      # build a candidate's synthetic migration runtimes with the candidate's own (NX-125).
      lib = {
        inherit applianceRelease releaseRuntime;
        # This tree's releases are given their runtime's stamp (the tools ask before they call applianceRelease of a
        # commit that may be older than this).
        takesRuntimeStamp = true;
        # The environments applianceRelease takes (ONE-02): the upgrade gates pick `prod` where `dev` is gone.
        releaseEnvNames = lib.attrNames releaseEnvs;
        proxmoxRelease = applianceRelease;
        upgradeGates = import ./vm-tests/upgrade-gates {
          inherit lib releaseRuntime;
          pkgs = (pkgsFor "x86_64-linux").extend overlay;
        };
      };

      # The same, as an installable: `--impure`, with WHOMBAT_UPGRADE_GATES naming a JSON file `{candidate: <build.json>,
      # candidateFlake: <flake ref>, reusedHost?: <build.json>, previous: [<build.json> | {build, reusedHost} …],
      # repository: <the appliance repository>, flakes?: {<commit>: <flake ref>}, breakCandidate?: …}`
      # (release/upgrade-gates writes it). Lazy: nothing is read unless asked for.
      legacyPackages.x86_64-linux.upgradeGates =
        let
          readJSON = f: builtins.fromJSON (builtins.readFile f);
          args = readJSON (builtins.getEnv "WHOMBAT_UPGRADE_GATES");
          # A published release: its build.json and its commit's flake. `flakes` names it for each commit (it may be
          # in an archive, with the appliance at a repository's top or in a folder: release/lib/source.sh); a commit it
          # doesn't name is `repository`'s own.
          published =
            f:
            let
              build = readJSON f;
              rev = build.source.rev;
            in
            {
              inherit build;
              flake = builtins.getFlake (args.flakes.${rev} or "git+file://${args.repository}?rev=${rev}");
            };
          # A previous release: a build.json, or `{build, reusedHost}` for a runtime-only one (NX-126).
          previousOf =
            e:
            if builtins.isString e then
              published e
            else
              published e.build
              // lib.optionalAttrs (e.reusedHost or null != null) { reusedHost = published e.reusedHost; };
        in
        self.lib.upgradeGates (
          {
            candidate = {
              build = readJSON args.candidate;
              flake = builtins.getFlake args.candidateFlake;
            }
            // lib.optionalAttrs (args.reusedHost or null != null) { reusedHost = published args.reusedHost; };
            previous = map previousOf args.previous;
          }
          // lib.optionalAttrs (args.breakCandidate or null != null) { inherit (args) breakCandidate; }
        );

      nixosModules = {
        appliance = {
          imports = [
            lanzaboote.nixosModules.lanzaboote
            ./nix/modules
            lzbtModule
          ];
          nixpkgs.overlays = [ overlay ];
        };
        default = self.nixosModules.appliance;
      };

      nixosConfigurations = {
        appliance-x86_64 = applianceFor "x86_64-linux" [ ];
        # Development image: plain storage, stand-ins (NX-07).
        appliance-dev-x86_64 = applianceFor "x86_64-linux" [ ./nix/profiles/dev-image.nix ];
        # Evaluated (`checks.x86_64-linux.eval-aarch64`), not built or qualified (NX-15).
        appliance-aarch64 = applianceFor "aarch64-linux" [ ];
        # The factory's installer (NX-07, NX-11): installs the factory platform and provisions identities.
        installer-factory = installerFor "x86_64-linux";
        recovery-x86_64 = recoveryFor "x86_64-linux";
        # Self-installed from the ISO on a dedicated machine or a VM (PI-01, PI-02, PI-21): the Whombat image (ONE-02).
        self-installed-prod = applianceSelfProd;
        installer-prod = installerWith "x86_64-linux" "whombat-installer" applianceSelfProd;
        self-installed-community = applianceSelfCommunity;
        installer-community =
          installerWith "x86_64-linux" "whombat-installer-community"
            applianceSelfCommunity;
      };

      packages = forAllSystems (
        system:
        let
          pkgs = (pkgsFor system).extend overlay;
        in
        {
          inherit (pkgs)
            whombat-provision
            whombat-manager
            whombat-update-helper
            whombat-release-tools
            whombat-backup
            whombat-recovery
            whombat-console
            whombat-installer-ui
            whombat-dns-fallback
            whombat-vault-wall
            whombat-standin-runtime
            whombat-runtime
            whombat-hermes
            whombat-hosts
            whombat-hosts-agents
            whombat-hosts-sign
            whombat-appliance-tools
            whombat-console-ui
            whombat-voice
            voice-whisper
            voice-vulkan
            voice-kokoro
            voice-models-manifest
            voice-kokoro-model
            voice-supertonic-model
            whombat-presence
            presence-watch
            presence-model
            whombat-bluetooth
            whombat-kiosk-udev
            whombat-support
            ;
          console-ui = pkgs.whombat-console-ui;
        }
        // lib.optionalAttrs (system == "x86_64-linux") {
        }
        // lib.optionalAttrs (system == "x86_64-linux") {
          # The factory installer / provisioning image (boots into RAM, installs the factory platform onto the
          # internal disk, provisions identities; NX-07, NX-11).
          installer-iso-factory = self.nixosConfigurations.installer-factory.config.system.build.isoImage;
          # The installer people use (PI-01, PI-21, ONE-02): a dedicated machine or a VM, the graphical installer
          # (docs/runbooks/install.md), the Whombat image with the runtime bundle.
          installer-iso-prod = self.nixosConfigurations.installer-prod.config.system.build.isoImage;
          # The community edition's installer (NX-445): no release id (release/build community makes one).
          installer-iso-community = self.nixosConfigurations.installer-community.config.system.build.isoImage;
          # Signed recovery environment: a self-contained UKI installed on the ESP (NX-13).
          recovery-uki = self.nixosConfigurations.recovery-x86_64.config.system.build.whombatRecoveryUki;
          # The appliance system closure (what the update helper activates, class 2).
          appliance-toplevel = self.nixosConfigurations.appliance-x86_64.config.system.build.toplevel;
          # Development raw + qcow2 disk image: ESP + root, /persist created on first boot (NX-07).
          dev-image = self.nixosConfigurations.appliance-dev-x86_64.config.system.build.image;
          dev-image-qcow2 = pkgs.runCommand "whombat-dev-image.qcow2" { } ''
            ${pkgs.qemu-utils}/bin/qemu-img convert -f raw -O qcow2 \
              ${self.packages.${system}.dev-image}/*.raw $out
          '';
          default = self.packages.${system}.installer-iso-factory;
        }
      );

      checks.x86_64-linux =
        let
          system = "x86_64-linux";
          pkgs = (pkgsFor system).extend overlay;
          tests = import ./vm-tests {
            inherit pkgs lib releaseRuntime;
            recoveryUki = recoveryUkiFor system;
            recoveryProbeUki = recoveryProbeUkiFor system;
            # Tests use read-only pkgs (already extended with the overlay), so no nixpkgs.* settings.
            applianceModules = [
              lanzaboote.nixosModules.lanzaboote
              ./nix/modules
              lzbtModule
            ];
          };
        in
        tests
        // {
          # whombat-provision runs `go test ./provisioning/...` in its build.
          provision-unit = pkgs.whombat-provision;
          # Speech for the desk display (NX-175…NX-184): the service with its real programs and models in the build
          # sandbox (its Go tests run in its build), and its unit, socket and account as the appliance has them.
          voice-speech = pkgs.callPackage ./nix/checks/voice.nix { };
          voice-config =
            let
              c = self.nixosConfigurations.appliance-x86_64.config;
              s = c.systemd.services.whombat-voice;
              sc = s.serviceConfig;
              so = c.systemd.sockets.whombat-voice;
              uid = c.whombat.ids.whombat-voice;
              off =
                (self.nixosConfigurations.appliance-x86_64.extendModules {
                  modules = [ { whombat.voice.enable = false; } ];
                }).config;
            in
            assert
              c.whombat.voice.enable
              && self.nixosConfigurations.self-installed-prod.config.whombat.voice.enable
              && !(off.systemd.services ? whombat-voice)
              && !(off.systemd.sockets ? whombat-voice);
            assert
              so.wantedBy == [ "sockets.target" ]
              && so.socketConfig.ListenStream == c.whombat.voice.socket
              && c.whombat.voice.socket == "/run/whombat-voice/voice.sock"
              && so.socketConfig.SocketMode == "0660"
              && so.socketConfig.SocketUser == "whombat-voice"
              && so.socketConfig.SocketGroup == "whombat"
              && c.users.users.whombat.group == "whombat";
            assert
              uid == 966
              && c.users.users.whombat-voice.uid == uid
              && c.users.groups.whombat-voice.gid == uid
              && c.users.users.whombat-voice.extraGroups == [ ]
              && lib.length (lib.filter (u: u.uid == uid) (lib.attrValues c.users.users)) == 1
              && lib.length (lib.filter (g: g.gid == uid) (lib.attrValues c.users.groups)) == 1;
            assert
              s.wantedBy == [ ]
              && lib.elem "whombat-voice.socket" s.requires
              && sc.User == "whombat-voice"
              && sc.PrivateNetwork
              && sc.IPAddressDeny == "any"
              && sc.RestrictAddressFamilies == [ "AF_UNIX" ]
              && sc.CapabilityBoundingSet == ""
              && sc.NoNewPrivileges
              && sc.MemoryDenyWriteExecute
              && sc.ProtectSystem == "strict"
              && !(sc ? ProcSubset)
              &&
                sc.TemporaryFileSystem == [
                  "/tmp:size=256M,mode=1777,noexec"
                  "/persist:ro"
                ]
              && sc.BindReadOnlyPaths == [ "-/persist/voice-models" ]
              && sc.DevicePolicy == "closed"
              && sc.DeviceAllow == [ "char-drm rw" ]
              && !sc.PrivateDevices
              && sc.MemoryMax == "2G"
              && sc.CPUWeight < 100
              && sc.IOWeight < 100
              && lib.hasInfix "--allow-uid 0,${toString c.whombat.ids.whombat} " sc.ExecStart
              && lib.hasInfix "/bin/whisper-cli " sc.ExecStart
              && lib.hasInfix "/bin/parakeet-cli " sc.ExecStart
              && lib.hasInfix "/bin/voice-gpu-probe " sc.ExecStart
              && lib.hasInfix "--models /persist/voice-models " sc.ExecStart
              && lib.hasInfix "-voice-models.json " sc.ExecStart
              && lib.hasInfix "/bin/kokoro-speak " sc.ExecStart
              && lib.hasInfix "-kokoro-v1_0-en --kokoro-voices 'heart=3:us:woman,bella=2:us:woman,michael=16:us:man,fenrir=14:us:man,emma=21:gb:woman,george=26:gb:man' " sc.ExecStart
              # The GPL-3.0 supertonic-speak runner stays wired for downloaded Dutch weights, while the Open RAIL-M
              # Supertonic 3 model itself stays out of the image.
              && lib.hasInfix "/bin/supertonic-speak " sc.ExecStart
              && lib.hasInfix "--supertonic-speakers 1,8 " sc.ExecStart
              && !(lib.hasInfix "--supertonic-model" sc.ExecStart)
              && !(lib.hasInfix "supertonic-3-int8" sc.ExecStart);
            # The fetcher (NX-473): its own account, the network, of /persist its directory, a socket for the server.
            assert
              let
                f = c.systemd.services.whombat-voice-models;
                fc = f.serviceConfig;
                fs = c.systemd.sockets.whombat-voice-models;
              in
              c.whombat.ids.whombat-voice-models == 972
              && c.users.users.whombat-voice-models.uid == 972
              && fc.User == "whombat-voice-models"
              && !(fc ? PrivateNetwork)
              &&
                fc.RestrictAddressFamilies == [
                  "AF_UNIX"
                  "AF_INET"
                  "AF_INET6"
                ]
              && fc.CapabilityBoundingSet == ""
              && fc.TemporaryFileSystem == [ "/persist:ro" ]
              && fc.BindPaths == [ "/persist/voice-models" ]
              && fc.InaccessiblePaths == [ "-/run/whombat-voice" ]
              && lib.elem "multi-user.target" f.wantedBy
              && fs.socketConfig.ListenStream == c.whombat.voice.models.socket
              && fs.socketConfig.SocketGroup == "whombat"
              && fs.socketConfig.SocketMode == "0660"
              && lib.elem "voice-models" c.whombat.storage.extraSubvolumes
              && !(lib.elem "voice-models" c.whombat.storage.subvolumes)
              && lib.elem "WHOMBAT_VOICE_MODELS_SOCKET=/run/whombat-voice-models/models.sock" c.systemd.services.whombat-server.serviceConfig.Environment;
            # The models: free licences (allowUnfree is off) and names the image's secret scan skips; the image carries no
            # speech-to-text model (DT-05), only where to fetch them.
            assert lib.all (m: m.meta.license.free && !(lib.hasPrefix "whombat" m.name)) [
              pkgs.voice-test-parakeet
              pkgs.voice-test-whisper
              pkgs.voice-kokoro-model
            ];
            # The one exception (NX-477), built for the speech check only and not in the image: Supertonic 3,
            # Dutch, under Open RAIL-M (redistributable, with use restrictions that travel with it), its licence in the
            # package.
            assert
              pkgs.voice-supertonic-model.licence.fullName == "BigScience Open RAIL-M"
              && !(pkgs.voice-supertonic-model.meta ? license)
              && !(lib.hasPrefix "whombat" pkgs.voice-supertonic-model.name);
            assert
              let
                manifest = builtins.fromJSON (builtins.readFile pkgs.voice-models-manifest);
                st = lib.findFirst (m: m.id == "supertonic") null manifest.models;
              in
              map (m: m.id) manifest.models == [
                "parakeet"
                "whisper"
                "supertonic"
              ]
              && st != null
              && st.dir == "supertonic-3-int8"
              && lib.elem "LICENSE" (map (f: f.name) st.files);
            pkgs.runCommand "voice-config-check" { } "touch $out";
          # Stay unlocked while you're here (NX-280…NX-289): presence-watch and the whole service on pictures in the build
          # sandbox (its Go tests run in its build), and its unit, socket and account as the appliance has them.
          presence-detect = pkgs.callPackage ./nix/checks/presence.nix { };
          presence-config =
            let
              c = self.nixosConfigurations.appliance-x86_64.config;
              s = c.systemd.services.whombat-presence;
              sc = s.serviceConfig;
              so = c.systemd.sockets.whombat-presence;
              uid = c.whombat.ids.whombat-presence;
              off =
                (self.nixosConfigurations.appliance-x86_64.extendModules {
                  modules = [ { whombat.presence.enable = false; } ];
                }).config;
              senv = c.systemd.services.whombat-server.serviceConfig.Environment;
              runner = c.systemd.services.whombat-runner;
              kiosk = builtins.fromJSON c.environment.etc."chromium/policies/managed/whombat-kiosk.json".text;
            in
            assert
              c.whombat.presence.enable
              && self.nixosConfigurations.self-installed-prod.config.whombat.presence.enable
              && !(off.systemd.services ? whombat-presence)
              && !(off.systemd.sockets ? whombat-presence)
              && !(lib.any (lib.hasPrefix "WHOMBAT_PRESENCE_SOCKET=") off.systemd.services.whombat-server.serviceConfig.Environment);
            assert
              so.wantedBy == [ "sockets.target" ]
              && so.socketConfig.ListenStream == c.whombat.presence.socket
              && c.whombat.presence.socket == "/run/whombat-presence/presence.sock"
              && so.socketConfig.SocketMode == "0660"
              && so.socketConfig.SocketUser == "whombat-presence"
              && so.socketConfig.SocketGroup == "whombat"
              && lib.elem "WHOMBAT_PRESENCE_SOCKET=/run/whombat-presence/presence.sock" senv
              && !(runner.environment ? WHOMBAT_PRESENCE_SOCKET)
              && !(lib.any (lib.hasPrefix "WHOMBAT_PRESENCE") (lib.toList runner.serviceConfig.Environment));
            assert
              uid == 967
              && c.users.users.whombat-presence.uid == uid
              && c.users.groups.whombat-presence.gid == uid
              && c.users.users.whombat-presence.extraGroups == [ ]
              && lib.length (lib.filter (u: u.uid == uid) (lib.attrValues c.users.users)) == 1
              && lib.length (lib.filter (g: g.gid == uid) (lib.attrValues c.users.groups)) == 1;
            # The voice service's sandbox, with the camera and nothing else of /dev, and nothing writable.
            assert
              s.wantedBy == [ ]
              && lib.elem "whombat-presence.socket" s.requires
              && sc.User == "whombat-presence"
              && sc.SupplementaryGroups == [ "video" ]
              && sc.PrivateDevices == false
              && sc.DevicePolicy == "closed"
              && sc.DeviceAllow == [ "char-video4linux rw" ]
              && sc.PrivateNetwork
              && sc.IPAddressDeny == "any"
              && sc.RestrictAddressFamilies == [ "AF_UNIX" ]
              && sc.CapabilityBoundingSet == ""
              && sc.NoNewPrivileges
              && sc.MemoryDenyWriteExecute
              && sc.ProtectSystem == "strict"
              && !(sc ? ReadWritePaths)
              && !(sc ? TemporaryFileSystem)
              && !(sc ? PrivateTmp)
              && !(sc ? StateDirectory)
              && sc.MemoryMax == "256M"
              && sc.MemorySwapMax == "0"
              && sc.CPUWeight < 100
              && sc.IOWeight < 100
              && lib.hasInfix "--allow-uid 0,${toString c.whombat.ids.whombat}" sc.ExecStart
              && lib.hasInfix "/bin/presence-watch " sc.ExecStart
              && lib.hasInfix "/face_detection_yunet_2023mar.onnx " sc.ExecStart
              && !(lib.hasInfix "--frames" sc.ExecStart);
            # The kiosk's browser keeps the camera blocked (DK-31); the kernel has the USB camera driver, not blacklisted.
            assert
              kiosk.VideoCaptureAllowed == false
              && !(kiosk ? VideoCaptureAllowedUrls)
              && !(lib.elem "uvcvideo" c.boot.blacklistedKernelModules);
            # The model: a free licence (allowUnfree is off) and a name the image's secret scan skips.
            assert pkgs.presence-model.meta.license.free && !(lib.hasPrefix "whombat" pkgs.presence-model.name);
            pkgs.runCommand "presence-config-check" { } ''
              ls ${c.system.modulesTree}/lib/modules/*/kernel/drivers/media/usb/uvc/uvcvideo.ko*
              ! grep -qw uvcvideo ${c.environment.etc."modprobe.d/nixos.conf".source}
              # The kiosk's seat session gets no ACL on the camera: the uaccess tag goes before 73-seat-late applies it.
              grep -qx 'SUBSYSTEM=="video4linux", TAG-="uaccess"' ${
                c.environment.etc."udev/rules.d".source
              }/72-whombat-camera.rules
              touch $out
            '';
          # Bluetooth (NX-350…NX-363): BlueZ, the D-Bus policy, the service's unit, socket and account, the runtime's
          # variable, the sound server's Bluetooth parts and the factory reset, as the appliance has them.
          bluetooth-config =
            let
              c = self.nixosConfigurations.appliance-x86_64.config;
              s = c.systemd.services.whombat-bluetooth;
              sc = s.serviceConfig;
              so = c.systemd.sockets.whombat-bluetooth;
              uid = c.whombat.ids.whombat-bluetooth;
              bt = c.hardware.bluetooth;
              offWith = m: (self.nixosConfigurations.appliance-x86_64.extendModules { modules = [ m ]; }).config;
              off = offWith { whombat.bluetooth.enable = false; };
              noDesk = offWith { whombat.kiosk.desk = lib.mkForce false; };
              ic = self.nixosConfigurations.installer-prod.config;
              senv = c.systemd.services.whombat-server.serviceConfig.Environment;
              runner = c.systemd.services.whombat-runner;
              dbus = c.services.dbus.packages;
              policy = lib.last dbus;
              wp = c.services.pipewire.wireplumber;
              conf = wp.extraConfig."90-whombat";
              hasEnv =
                cfg:
                lib.any (lib.hasPrefix "WHOMBAT_BLUETOOTH_SOCKET=") cfg.systemd.services.whombat-server.serviceConfig.Environment;
            in
            # On with the desk (every appliance with a graphical console), off without it, never on the installer.
            assert
              c.whombat.bluetooth.enable
              && self.nixosConfigurations.self-installed-prod.config.whombat.bluetooth.enable
              && !noDesk.whombat.bluetooth.enable
              && !noDesk.hardware.bluetooth.enable
              && !off.hardware.bluetooth.enable
              && !(off.systemd.services ? whombat-bluetooth)
              && !(off.systemd.sockets ? whombat-bluetooth)
              && !(off.systemd.services ? whombat-bluetooth-on)
              && !hasEnv off
              && !hasEnv noDesk
              && !off.whombat.sound.bluetooth
              && !ic.hardware.bluetooth.enable;
            # BlueZ: never discoverable, pairable only with an agent, no Just Works re-pairing, bonded classic HID only.
            assert
              bt.enable
              && bt.powerOnBoot
              && bt.settings.General.AlwaysPairable == false
              && bt.settings.General.JustWorksRepairing == "never"
              && !(bt.settings.General ? Discoverable)
              && !(bt.settings.General ? DiscoverableTimeout)
              && bt.input.General.ClassicBondedOnly
              &&
                c.systemd.services.whombat-bluetooth-on.serviceConfig.ExecStart
                == "${pkgs.util-linux}/bin/rfkill unblock bluetooth"
              && lib.elem "bluetooth.service" c.systemd.services.whombat-bluetooth-on.before;
            # The D-Bus policy (BT-09): read after BlueZ's, the three users and nobody else.
            assert
              policy.name == "whombat-bluetooth.conf"
              && lib.findFirst (p: p.name == "whombat-bluetooth.conf") null dbus != null
              &&
                lib.lists.findFirstIndex (p: (p.pname or "") == "bluez") null dbus
                < lib.lists.findFirstIndex (p: p.name == "whombat-bluetooth.conf") null dbus
              &&
                c.whombat.bluetooth.dbusUsers == [
                  "root"
                  "whombat-bluetooth"
                  "pipewire"
                ];
            # The socket, the runtime server's variable (not the runner's), the account.
            assert
              so.wantedBy == [ "sockets.target" ]
              && so.socketConfig.ListenStream == c.whombat.bluetooth.socket
              && c.whombat.bluetooth.socket == "/run/whombat-bluetooth/bluetooth.sock"
              && so.socketConfig.SocketMode == "0660"
              && so.socketConfig.SocketUser == "whombat-bluetooth"
              && so.socketConfig.SocketGroup == "whombat"
              && lib.elem "WHOMBAT_BLUETOOTH_SOCKET=/run/whombat-bluetooth/bluetooth.sock" senv
              && !(runner.environment ? WHOMBAT_BLUETOOTH_SOCKET)
              && !(lib.any (lib.hasPrefix "WHOMBAT_BLUETOOTH") (lib.toList runner.serviceConfig.Environment))
              && uid == 968
              && c.users.users.whombat-bluetooth.uid == uid
              && c.users.groups.whombat-bluetooth.gid == uid
              && c.users.users.whombat-bluetooth.extraGroups == [ ]
              && lib.length (lib.filter (u: u.uid == uid) (lib.attrValues c.users.users)) == 1
              && lib.length (lib.filter (g: g.gid == uid) (lib.attrValues c.users.groups)) == 1;
            # The unit: on demand, no network, no devices, nothing writable, no capabilities.
            assert
              s.wantedBy == [ ]
              && lib.elem "whombat-bluetooth.socket" s.requires
              && sc.User == "whombat-bluetooth"
              && sc.PrivateNetwork
              && sc.IPAddressDeny == "any"
              && sc.RestrictAddressFamilies == [ "AF_UNIX" ]
              && sc.PrivateDevices
              && sc.CapabilityBoundingSet == ""
              && sc.NoNewPrivileges
              && sc.MemoryDenyWriteExecute
              && sc.ProtectSystem == "strict"
              && !(sc ? ReadWritePaths)
              && !(sc ? StateDirectory)
              && !(sc ? SupplementaryGroups)
              && sc.MemoryMax == "64M"
              && sc.CPUWeight < 100
              && lib.hasInfix "--allow-uid 0,${toString c.whombat.ids.whombat}" sc.ExecStart;
            # The sound server (BT-06): Bluetooth optional, the box sends only, a speaker first, the box's microphone first.
            assert
              c.whombat.sound.bluetooth
              && conf."wireplumber.profiles".main-systemwide."hardware.bluetooth" == "required"
              &&
                conf."wireplumber.profiles".main-systemwide."hooks.default-nodes.whombat-box-microphone"
                == "required"
              &&
                conf."monitor.bluez.properties"."bluez5.roles" == [
                  "a2dp_source"
                  "hfp_ag"
                  "hsp_ag"
                ]
              && (lib.head conf."monitor.bluez.rules").actions.update-props."priority.session" == 3000
              && conf."wireplumber.settings"."bluetooth.use-persistent-storage" == false
              && wp.extraScripts ? "whombat/box-microphone-first.lua"
              && !(noDesk.services.pipewire.wireplumber.extraScripts ? "whombat/box-microphone-first.lua");
            pkgs.runCommand "bluetooth-config-check" { } ''
              grep -q 'deny send_destination="org.bluez"' ${policy}/share/dbus-1/system.d/whombat-bluetooth.conf
              [ "$(grep -c '<policy user=' ${policy}/share/dbus-1/system.d/whombat-bluetooth.conf)" = 3 ]
              # The factory reset forgets the paired devices (NX-359).
              grep -qF 'rm -rf "$sysroot/var/lib/bluetooth/"*' ${pkgs.whombat-appliance-tools}/bin/whombat-factory-reset
              touch $out
            '';
          # Remote help (NX-411…NX-424, ONE-17): the support service's unit, socket and accounts, the runtime's variable, the
          # CA each image and environment pins, and a prod image never with the DEV CA. Its Go tests run in its build;
          # vm-tests/support.nix runs it.
          support-config =
            let
              c = self.nixosConfigurations.appliance-x86_64.config;
              prod = self.nixosConfigurations.self-installed-prod.config;
              prodCa = ./manifest/prod/support-ca.pub;
              envCa = name: prod.environment.etc."whombat/environments/${name}/support-ca.pub" or null;
              s = c.systemd.services.whombat-support;
              sc = s.serviceConfig;
              so = c.systemd.sockets.whombat-support;
              look = c.users.users.whombat-support-look;
              grp = c.users.groups.whombat-support;
              off =
                (self.nixosConfigurations.appliance-x86_64.extendModules {
                  modules = [ { whombat.support.enable = false; } ];
                }).config;
              senv = c.systemd.services.whombat-server.serviceConfig.Environment;
              runner = c.systemd.services.whombat-runner;
              hasEnv =
                cfg:
                lib.any (lib.hasPrefix "WHOMBAT_SUPPORT_SOCKET=") cfg.systemd.services.whombat-server.serviceConfig.Environment;
              failed = cfg: lib.any (a: !a.assertion && lib.hasInfix "support CA" a.message) cfg.assertions;
              prodWith =
                ca:
                (self.nixosConfigurations.self-installed-prod.extendModules {
                  modules = [ { whombat.support.caKeys = lib.mkForce ca; } ];
                }).config;
              devCa = ./manifest/dev-instance/support-ca.pub;
              testCa = pkgs.writeText "test-support-ca.pub" "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDaV1lsWk1QDBOGwT1AB1WaJbsEzvpIxuyJVBFI6m1TP test\n";
              devKeyCopy = pkgs.writeText "copied-ca.pub" (builtins.readFile devCa);
              # The placeholder has no key line yet; once the real DEV key is in, a copy of it is refused too.
              devHasKey = lib.any (l: lib.hasPrefix "ssh-ed25519 " (lib.trim l)) (
                lib.splitString "\n" (builtins.readFile devCa)
              );
            in
            # On every appliance, off without a trace when disabled; never an SSH daemon.
            assert
              c.whombat.support.enable
              && prod.whombat.support.enable
              && !(off.systemd.services ? whombat-support)
              && !(off.systemd.sockets ? whombat-support)
              && !(off.users.users ? whombat-support-look)
              && !hasEnv off
              && !c.services.openssh.enable
              && !prod.services.openssh.enable;
            # The socket and the runtime server's variable (not the runner's).
            assert
              so.wantedBy == [ "sockets.target" ]
              && so.socketConfig.ListenStream == "/run/whombat-support/api.sock"
              && c.whombat.support.socket == so.socketConfig.ListenStream
              && so.socketConfig.SocketMode == "0660"
              && so.socketConfig.SocketUser == "root"
              && so.socketConfig.SocketGroup == "whombat-support"
              && lib.elem "WHOMBAT_SUPPORT_SOCKET=/run/whombat-support/api.sock" senv
              && !(runner.environment ? WHOMBAT_SUPPORT_SOCKET)
              && !(lib.any (lib.hasPrefix "WHOMBAT_SUPPORT") (lib.toList runner.serviceConfig.Environment));
            # The accounts: Look's user reads the journal and nothing else; the socket's group is the server's and the
            # manager's alone.
            assert
              c.whombat.ids.whombat-support-look == 969
              && c.whombat.ids.whombat-support == 970
              && look.uid == 969
              && c.users.groups.whombat-support-look.gid == 969
              && look.extraGroups == [ "systemd-journal" ]
              && look.shell == "/run/current-system/sw/bin/nologin"
              && grp.gid == 970
              &&
                grp.members == [
                  "whombat"
                  "whombat-manager"
                ]
              && lib.length (lib.filter (u: u.uid == 969) (lib.attrValues c.users.users)) == 1
              && lib.length (lib.filter (g: g.gid == 969) (lib.attrValues c.users.groups)) == 1
              && lib.length (lib.filter (g: g.gid == 970) (lib.attrValues c.users.groups)) == 1
              && !(lib.any (u: lib.elem "whombat-support" (u.extraGroups or [ ])) (lib.attrValues c.users.users));
            # The unit: root, at boot, real root for Look and fix (NX-412), its own state, the manager's socket, no core.
            assert
              lib.elem "multi-user.target" s.wantedBy
              && lib.elem "whombat-support.socket" s.requires
              && !(sc ? User)
              && !(sc ? DynamicUser)
              && !(sc ? NoNewPrivileges)
              && !(sc ? ProtectSystem)
              && !(sc ? PrivateTmp)
              && !(sc ? ProtectHome)
              && !(sc ? CapabilityBoundingSet)
              && !(sc ? SystemCallFilter)
              && sc.KillMode == "control-group"
              && sc.StateDirectory == "whombat-support"
              && sc.StateDirectoryMode == "0700"
              && sc.SupplementaryGroups == [ "whombat-api" ]
              && sc.LimitCORE == 0
              && s.environment.PATH == "/run/wrappers/bin:/run/current-system/sw/bin"
              && lib.hasInfix "--environment dev " sc.ExecStart
              && lib.hasInfix "--environment prod " prod.systemd.services.whombat-support.serviceConfig.ExecStart
              && lib.hasInfix "--ca-keys /run/whombat/environment/support-ca.pub "
                prod.systemd.services.whombat-support.serviceConfig.ExecStart
              && lib.hasInfix "--runtime-uid 951 --manager-uid 950 " sc.ExecStart
              && lib.hasInfix "--ca-keys /etc/whombat/support-ca.pub " sc.ExecStart
              && lib.hasInfix "--look-user whombat-support-look " sc.ExecStart;
            # The CA each image pins: none on the factory image; on the Whombat image the box's environment picks it, the
            # DEV file for the development environment (until Home has moved, ONE-02) and production's once it is
            # committed (ONE-17: manifest/prod/support-ca.pub, made on the Hetzner host), none before; a prod image
            # refuses the DEV file and any of its keys.
            assert
              c.whombat.support.caKeys == null
              && !(c.environment.etc ? "whombat/support-ca.pub")
              && (envCa "dev").source == devCa
              && (envCa "dev").mode == "0444"
              && (
                if builtins.pathExists prodCa then
                  (envCa "prod").source == prodCa && prod.whombat.support.caKeys == prodCa
                else
                  envCa "prod" == null && prod.whombat.support.caKeys == null
              )
              && !(failed prod)
              && failed (prodWith devCa)
              && !(failed (prodWith testCa))
              && (devHasKey -> failed (prodWith devKeyCopy));
            pkgs.runCommand "support-config-check" { } "touch $out";
          appliance-toplevel = self.packages.${system}.appliance-toplevel;
          image-no-secrets = pkgs.callPackage ./nix/checks/image-no-secrets.nix {
            toplevel = self.packages.${system}.appliance-toplevel;
            image = self.packages.${system}.dev-image;
          };
          # The recovery menu's hardening (N-3): no pager, control characters stripped from names.
          recovery-menu =
            let
              rc = (recoveryFor system).config;
              env = rc.systemd.services.whombat-recovery-menu.environment;
            in
            assert env.SYSTEMD_PAGER == "cat" && env.PAGER == "cat" && env.SYSTEMD_PAGERSECURE == "1";
            pkgs.runCommand "recovery-menu-check" { } ''
              got=$(${rc.system.build.whombatRecoveryClean}/bin/whombat-recovery-clean "$(printf 'kit\033[2J\033]0;x\007\nname\r.json')")
              [ "$got" = "kit[2J]0;xname.json" ] || { echo "not cleaned: $got" | od -c; exit 1; }
              touch $out
            '';
          # AI clients (NX-37, MG-33): nothing of Claude Code or Codex in the image, the clients file for server and
          # runner, the install root read-only in tasks, nix-ld for Claude's glibc binary, the sign-in hosts allowed.
          clients =
            let
              c = self.nixosConfigurations.appliance-x86_64.config;
              renv = c.systemd.services.whombat-runner.environment;
              senv = c.systemd.services.whombat-server.environment;
              mrw = c.systemd.services.whombat-manager.serviceConfig.ReadWritePaths;
              allow = lib.splitString "," renv.WHOMBAT_SANDBOX_EGRESS_ALLOW;
            in
            assert
              !(renv ? WHOMBAT_PROVIDER_PINS)
              && !(renv ? WHOMBAT_CLAUDE_PATH)
              && !(renv ? WHOMBAT_CODEX_PATH)
              && !(c.systemd.services ? whombat-provider-profiles-init)
              && renv.WHOMBAT_CLIENTS_FILE == "/run/whombat-clients/clients.json"
              && senv.WHOMBAT_CLIENTS_FILE == renv.WHOMBAT_CLIENTS_FILE
              && renv.WHOMBAT_CLIENTS_ROOT == "/persist/whombat/clients"
              && senv.WHOMBAT_CLIENTS_ROOT == renv.WHOMBAT_CLIENTS_ROOT
              && lib.hasSuffix ":/persist/whombat/clients" renv.WHOMBAT_SANDBOX_RO_PATHS
              && lib.elem "/persist/whombat/clients" mrw
              && lib.elem "/run/whombat-clients" c.systemd.services.whombat-server.serviceConfig.ReadWritePaths
              && lib.all (h: lib.elem h allow) [
                "claude.ai"
                "console.anthropic.com"
                "platform.claude.com"
                "api.anthropic.com"
              ]
              && c.programs.nix-ld.enable;
            pkgs.runCommand "clients-check" { } "touch $out";
          # The runner's unit (NX-73, NX-76): what blocks a fresh procfs, bubblewrap's hostname and the runner's own task
          # cgroups is relaxed for it alone, everything else stays; its WHOMBAT_HOME is its own. The server keeps its
          # hardening and its home. runtime-live-turn runs a turn through it.
          runner-sandbox =
            let
              c = self.nixosConfigurations.appliance-x86_64.config;
              r = c.systemd.services.whombat-runner.serviceConfig;
              sv = c.systemd.services.whombat-server.serviceConfig;
            in
            assert
              !r.ProtectKernelTunables
              && !r.ProtectKernelLogs
              && !r.ProtectHostname
              && r.ProtectControlGroups == "private"
              && r.ProtectProc == "invisible"
              && r.ProcSubset == "all"
              && r.ProtectSystem == "strict"
              && r.PrivateDevices
              && r.ProtectKernelModules
              && r.ProtectClock
              && r.CapabilityBoundingSet == ""
              && lib.hasInfix "sethostname" (lib.head r.SystemCallFilter)
              && !(lib.hasInfix "syslog" (lib.head r.SystemCallFilter))
              && lib.elem "WHOMBAT_HOME=/persist/whombat/runner/home" r.Environment
              && !(lib.elem "WHOMBAT_HOME=/persist/whombat/home" r.Environment)
              && sv.ProtectKernelTunables
              && sv.ProtectKernelLogs
              && sv.ProtectHostname
              && sv.ProtectControlGroups == true
              && sv.ProcSubset == "pid"
              && lib.elem "AF_NETLINK" sv.RestrictAddressFamilies
              && lib.elem "WHOMBAT_HOME=/persist/whombat/home" sv.Environment;
            pkgs.runCommand "runner-sandbox-check" { } "touch $out";
          # The licence key set (NX-38, LC-03, LC-04): installed 0444, handed to the server and the manager (not the
          # runner); a prod image with a test key or with another environment's set fails its assertions. Since the
          # licence is inert (LNK-04) a prod image without one builds.
          licence =
            let
              testKeys = ./vm-tests/common/licence-keys.test.json;
              withKeys = applianceFor system [ { whombat.licence.keys = testKeys; } ];
              c = withKeys.config;
              senv = c.systemd.services.whombat-server.serviceConfig.Environment;
              renv = c.systemd.services.whombat-runner.serviceConfig.Environment;
              failed =
                extra:
                map (a: a.message) (lib.filter (a: !a.assertion) (applianceFor system extra).config.assertions);
              licenceFailures = extra: lib.filter (m: lib.hasInfix "licence" m) (failed extra);
              prod = [ { whombat.environment = "prod"; } ];
            in
            assert c.environment.etc."whombat/licence-keys.json".mode == "0444";
            assert lib.elem "WHOMBAT_LICENCE_KEYS_FILE=/etc/whombat/licence-keys.json" senv;
            assert !(lib.any (lib.hasPrefix "WHOMBAT_LICENCE") renv);
            assert licenceFailures [ ] == [ ];
            assert licenceFailures [ { whombat.licence.keys = testKeys; } ] == [ ];
            assert licenceFailures prod == [ ];
            assert lib.length (licenceFailures (prod ++ [ { whombat.licence.keys = testKeys; } ])) == 2;
            assert
              !(self.nixosConfigurations.appliance-x86_64.config.environment.etc ? "whombat/licence-keys.json");
            pkgs.runCommand "licence-check" { nativeBuildInputs = [ pkgs.jq ]; } ''
              jq -e '.licence == {keysFile: "/etc/whombat/licence-keys.json", stateFile: "/persist/manager/licence.json"}' \
                ${c.environment.etc."whombat/manager.json".source}
              jq -e '.licence == {}' ${
                self.nixosConfigurations.appliance-x86_64.config.environment.etc."whombat/manager.json".source
              }
              touch $out
            '';
          # The tty1 console (CC-08, NX-32): its unit, getty@tty1 masked, the banner is the console's own default
          # footer, the starting screen without a file, and a crafted file can't put an escape on the terminal.
          # The graphical console (CG-01…CG-05, NX-78…NX-84): the server as whombat-console in its own network namespace,
          # the kiosk in it as whombat-kiosk with the text console as its fallback, Chromium's policies, the token
          # directory; the installer ISO's server as root with the kiosk in the host's namespace.
          # The desk display (NX-160…NX-167): the desk socket for the server only, the kiosk's GPU, sound and desk loop,
          # the power behaviour, the sound server (NX-255); the installer keeps the software kiosk without any of it.
          console =
            let
              c = self.nixosConfigurations.appliance-x86_64.config;
              ipolicy = builtins.fromJSON ic.environment.etc."chromium/policies/managed/whombat-kiosk.json".text;
              # The GPU path (NX-161), off in the image (NX-169): evaluated and its launcher built here, never shipped.
              gc =
                (self.nixosConfigurations.appliance-x86_64.extendModules {
                  modules = [ { whombat.kiosk.gpu = true; } ];
                }).config;
              gpolicy = builtins.fromJSON gc.environment.etc."chromium/policies/managed/whombat-kiosk.json".text;
              login = c.services.logind.settings.Login;
              noGui =
                (self.nixosConfigurations.appliance-x86_64.extendModules {
                  modules = [ { whombat.console.gui = false; } ];
                }).config;
              u = c.systemd.services.whombat-console;
              sc = u.serviceConfig;
              srv = c.systemd.services.whombat-console-server;
              k = c.systemd.services.whombat-kiosk;
              policy = builtins.fromJSON c.environment.etc."chromium/policies/managed/whombat-kiosk.json".text;
              ic = self.nixosConfigurations.installer-prod.config;
              ik = ic.systemd.services.whombat-kiosk;
              iu = ic.systemd.services.whombat-installer-ui;
            in
            assert
              c.whombat.console.gui
              && u.wantedBy == [ ]
              && lib.elem "whombat-kiosk.service" u.conflicts
              && srv.serviceConfig.User == "whombat-console"
              && srv.serviceConfig.Type == "notify"
              && srv.serviceConfig.PrivateNetwork
              && srv.serviceConfig.CapabilityBoundingSet == ""
              && srv.serviceConfig.MemoryDenyWriteExecute
              && lib.hasInfix "--serve 127.0.0.1:8411 " srv.serviceConfig.ExecStart
              && lib.hasInfix "--token-file /run/whombat-console-ui/token" srv.serviceConfig.ExecStart
              && !(lib.hasInfix "recovery-key" srv.serviceConfig.ExecStart)
              && srv.serviceConfig.ReadWritePaths == [ "/run/whombat-console-ui" ]
              && k.serviceConfig.User == "whombat-kiosk"
              && k.serviceConfig.PrivateNetwork
              && k.unitConfig.JoinsNamespaceOf == "whombat-console-server.service"
              && k.onFailure == [ "whombat-console.service" ]
              && k.serviceConfig.CapabilityBoundingSet == ""
              && k.serviceConfig.NoNewPrivileges
              && k.serviceConfig.TTYPath == "/dev/tty1"
              && c.users.users.whombat-kiosk.extraGroups == [ "pipewire" ]
              && c.users.users.whombat-kiosk.uid == c.whombat.ids.whombat-kiosk
              && (
                let
                  d = c.systemd.tmpfiles.settings."22-whombat-kiosk"."/run/whombat-console-ui".d;
                in
                d.mode == "2750" && d.user == "whombat-console" && d.group == "whombat-kiosk"
              )
              && policy.URLAllowlist == [ "http://127.0.0.1:8411" ]
              && lib.elem "*" policy.URLBlocklist
              && lib.elem "chrome://*" policy.URLBlocklist
              && policy.DeveloperToolsAvailability == 2
              && lib.all (m: lib.elem m c.boot.initrd.availableKernelModules) [
                "bochs"
                "virtio_gpu"
                "qxl"
              ]
              && !(self.nixosConfigurations.appliance-x86_64.extendModules {
                modules = [ { whombat.console.gui = false; } ];
              }).config.systemd.services
                ? whombat-kiosk
              && iu.serviceConfig.Type == "notify"
              && lib.hasInfix "--serve 127.0.0.1:8412 " iu.serviceConfig.ExecStart
              && lib.hasInfix (builtins.unsafeDiscardStringContext "--system ${self.nixosConfigurations.self-installed-prod.config.system.build.toplevel} ") (
                builtins.unsafeDiscardStringContext iu.serviceConfig.ExecStart
              )
              && !(ik.serviceConfig.PrivateNetwork)
              && !(ik.unitConfig ? JoinsNamespaceOf)
              && ik.onFailure == [ "getty@tty1.service" ];
            # The console sleeps on a claimed box after 10 minutes without input (NX-147); the installer never does.
            # Displays plugged in or out restart the appliance's kiosk (NX-147); keyboards and mice plugged in later reach
            # the running one through whombat-kiosk-udev (NX-400…NX-403).
            # The desk socket (NX-160): the runtime opens it and the graphical console's server dials it (the runtime's uid
            # as its peer). The text console dials it too, for one request: new claim letters when someone presses N at
            # the box. So its only address family is AF_UNIX, and it still has no network. No desk without a
            # graphical console.
            assert
              c.whombat.console.deskSocket == "/run/whombat/console/desk.sock"
              && lib.hasInfix "--desk-socket /run/whombat/console/desk.sock --desk-peer-uid ${toString c.whombat.ids.whombat}" srv.serviceConfig.ExecStart
              && lib.hasSuffix " --desk-socket /run/whombat/console/desk.sock --desk-peer-uid ${toString c.whombat.ids.whombat}" sc.ExecStart
              && !(lib.hasInfix "--serve" sc.ExecStart)
              && sc.RestrictAddressFamilies == [ "AF_UNIX" ]
              && sc.PrivateNetwork
              && sc.IPAddressDeny == "any"
              && lib.elem "AF_UNIX" srv.serviceConfig.RestrictAddressFamilies
              && lib.elem "WHOMBAT_DESK_SOCKET=/run/whombat/console/desk.sock" c.systemd.services.whombat-server.serviceConfig.Environment
              && !(lib.any (lib.hasPrefix "WHOMBAT_DESK_SOCKET=") noGui.systemd.services.whombat-server.serviceConfig.Environment)
              && !(lib.any (lib.hasPrefix "WHOMBAT_DESK_SOCKET=") c.systemd.services.whombat-runner.serviceConfig.Environment)
              # This boot's id beside it, for an unlock that stays across runtime restarts (Whombat DK-75, NX-320).
              && lib.elem "WHOMBAT_BOOT_ID=%b" c.systemd.services.whombat-server.serviceConfig.Environment
              && !(lib.any (lib.hasPrefix "WHOMBAT_BOOT_ID=") noGui.systemd.services.whombat-server.serviceConfig.Environment)
              && !(lib.any (lib.hasPrefix "WHOMBAT_BOOT_ID=") c.systemd.services.whombat-runner.serviceConfig.Environment);
            # The kiosk on a desk (NX-162…NX-164): the microphone and autoplay for the page's origin only, sound cards set
            # up, the desk loop; none of it on the installer. Software rendering only (NX-169): no GPU drivers, no GPU in
            # Chromium; with `gpu` (not in the image) the drivers and Chromium's GPU where the launcher finds a real chip.
            assert
              !c.whombat.kiosk.gpu
              && c.whombat.kiosk.desk
              && !c.hardware.graphics.enable
              && c.whombat.kiosk.transform == "auto"
              && policy.HardwareAccelerationModeEnabled == false
              && gc.whombat.kiosk.gpu
              && gc.hardware.graphics.enable
              && gpolicy.HardwareAccelerationModeEnabled
              && gc.system.build.toplevel.drvPath != ""
              && policy.AudioCaptureAllowed == false
              && policy.AudioCaptureAllowedUrls == [ "http://127.0.0.1:8411" ]
              && policy.AutoplayAllowlist == [ "http://127.0.0.1:8411" ]
              && policy.VideoCaptureAllowed == false
              && lib.hasInfix "alsactl -g init" c.services.udev.extraRules
              && !ic.whombat.kiosk.gpu
              && !ic.whombat.kiosk.desk
              && ipolicy.HardwareAccelerationModeEnabled == false
              && !(ipolicy ? AudioCaptureAllowedUrls)
              && !(ipolicy ? AutoplayAllowlist)
              && !(lib.hasInfix "alsactl" ic.services.udev.extraRules);
            # The sound server with the desk (HD-04, NX-255): system-wide PipeWire with WirePlumber, ALSA and the
            # PulseAudio socket, started at boot, no JACK or cameras, Bluetooth only as bluetooth-config checks it
            # (NX-357), nothing kept; the kiosk's user in its group and Chromium pointed at the socket; neither on the
            # installer nor without a graphical console.
            assert
              (
                let
                  pw = c.services.pipewire;
                  wp = pw.wireplumber.extraConfig."90-whombat";
                  prof = wp."wireplumber.profiles".main-systemwide;
                in
                c.whombat.sound.enable
                && c.whombat.sound.users == [ "whombat-kiosk" ]
                && pw.enable
                && pw.systemWide
                && pw.audio.enable
                && pw.alsa.enable
                && pw.pulse.enable
                && !pw.jack.enable
                && pw.wireplumber.enable
                && prof."hardware.bluetooth" == "required"
                && lib.all (f: prof.${f} == "disabled") [
                  "hardware.video-capture"
                  "hooks.device.profile.state"
                  "hooks.device.routes.state"
                  "hooks.default-nodes.state"
                  "hooks.stream.state"
                ]
                && wp."wireplumber.settings"."device.routes.default-sink-volume" > 0.34
                && lib.elem "multi-user.target" c.systemd.services.pipewire.wantedBy
                &&
                  c.users.users.pipewire.extraGroups == [
                    "audio"
                    "video"
                  ]
                && c.whombat.sound.pulseServer == "unix:/run/pulse/native"
              )
              && !ic.whombat.sound.enable
              && !ic.services.pipewire.enable
              && !noGui.services.pipewire.enable;
            # The power (NX-165…NX-167): never suspend, the lid ignored, a long press powers off, the short press decided
            # at boot before logind, UPower's clean shutdown at 10 %, the charge limit at boot and for added batteries.
            assert
              login.HandleLidSwitch == "ignore"
              && login.HandleLidSwitchExternalPower == "ignore"
              && login.HandleLidSwitchDocked == "ignore"
              && login.HandleSuspendKey == "ignore"
              && login.HandlePowerKeyLongPress == "poweroff"
              && !(login ? HandlePowerKey)
              && c.systemd.sleep.settings.Sleep.AllowSuspend == "no"
              && c.systemd.sleep.settings.Sleep.AllowHibernation == "no"
              && lib.elem "systemd-logind.service" c.systemd.services.whombat-power-key.before
              && c.services.upower.enable
              && c.services.upower.usePercentageForPolicy
              && c.services.upower.percentageAction == 10
              && c.services.upower.criticalPowerAction == "PowerOff"
              && c.services.upower.percentageCritical > c.services.upower.percentageAction
              && c.services.upower.percentageLow > c.services.upower.percentageCritical
              && c.whombat.power.chargeLimit == 80
              && lib.hasInfix ''TEST=="charge_control_end_threshold", ATTR{charge_control_end_threshold}="80"'' c.services.udev.extraRules
              && c.systemd.services.whombat-charge-limit.serviceConfig.Type == "oneshot";
            assert
              c.whombat.kiosk.sleepAfterSec == 600
              && ic.whombat.kiosk.sleepAfterSec == null
              && !(lib.hasInfix "whombat-kiosk-replug" c.services.udev.extraRules)
              && !(c.systemd.services ? whombat-kiosk-replug)
              && (
                let
                  r = c.systemd.services.whombat-kiosk-udev;
                  rs = r.serviceConfig;
                  hs = c.systemd.sockets.whombat-kiosk-udev-host;
                  ks = c.systemd.sockets.whombat-kiosk-udev-kiosk;
                in
                # With the kiosk, its sockets from systemd (none of its own), root with CAP_NET_ADMIN alone, an empty
                # network namespace of its own.
                lib.elem "whombat-kiosk.service" r.wantedBy
                && lib.elem "whombat-kiosk.service" r.before
                && lib.hasSuffix "/bin/whombat-kiosk-udev --subsystems input" rs.ExecStart
                &&
                  rs.Sockets == [
                    "whombat-kiosk-udev-host.socket"
                    "whombat-kiosk-udev-kiosk.socket"
                  ]
                && !(rs ? User)
                && rs.CapabilityBoundingSet == "CAP_NET_ADMIN"
                && rs.NoNewPrivileges
                && rs.PrivateNetwork
                && !(r.unitConfig ? JoinsNamespaceOf)
                && rs.RestrictAddressFamilies == "none"
                && rs.IPAddressDeny == "any"
                && rs.ProtectSystem == "strict"
                && rs.PrivateDevices
                && rs.MemoryDenyWriteExecute
                # udevd's group in the host's namespace; the other end in the server's, which keeps making it (after the
                # server) with a private /tmp for everyone who shares it.
                && hs.socketConfig.ListenNetlink == "kobject-uevent 2"
                && hs.socketConfig.PassCredentials
                && hs.socketConfig.FileDescriptorName == "host"
                && !(hs.socketConfig ? PrivateNetwork)
                && !(hs.unitConfig ? JoinsNamespaceOf)
                && ks.socketConfig.ListenNetlink == "kobject-uevent"
                && ks.socketConfig.FileDescriptorName == "kiosk"
                && ks.socketConfig.PrivateNetwork
                && ks.socketConfig.PrivateTmp
                && ks.unitConfig.JoinsNamespaceOf == "whombat-console-server.service"
                && srv.serviceConfig.PrivateTmp
                && k.serviceConfig.PrivateTmp
                &&
                  lib.all
                    (
                      so:
                      lib.elem "whombat-console-server.service" so.after
                      && so.unitConfig.DefaultDependencies == false
                      && so.wantedBy == [ ]
                    )
                    [
                      hs
                      ks
                    ]
              )
              && !(ic.systemd.services ? whombat-kiosk-udev)
              && !(ic.systemd.sockets ? whombat-kiosk-udev-host)
              && lib.hasInfix ''ACTION=="change", SUBSYSTEM=="drm", ENV{HOTPLUG}=="1", TAG+="systemd", ENV{SYSTEMD_WANTS}+="whombat-kiosk-display.service"'' c.services.udev.extraRules
              && c.systemd.services.whombat-kiosk-display.serviceConfig.Type == "oneshot"
              && !(ic.systemd.services ? whombat-kiosk-display)
              # The protections stay: the no-display exit, NX-87's stop, the start limit.
              && k.serviceConfig.RestartPreventExitStatus == 3
              && lib.hasInfix "whombat-kiosk-stop" k.serviceConfig.ExecStop
              && k.serviceConfig.TimeoutStopSec == 5
              && k.unitConfig.StartLimitBurst == 3;
            assert
              sc.User == "whombat-console"
              && sc.TTYPath == "/dev/tty1"
              # the keyboard, read and dropped (NX-90); the console writes nothing
              && sc.StandardInput == "tty-force"
              && !(sc ? ReadWritePaths)
              && !(lib.hasInfix "recovery-key" sc.ExecStart)
              && sc.PrivateNetwork
              && sc.CapabilityBoundingSet == ""
              && !c.systemd.services."getty@tty1".enable
              && !c.systemd.services."autovt@tty1".enable
              && lib.elem "WHOMBAT_CONSOLE_FILE=${c.whombat.console.file}" c.systemd.services.whombat-server.serviceConfig.Environment
              && c.services.getty.helpLine == "\n" + c.whombat.console.banner
              # Terminus 16×32 bold (NX-90) and nothing else drawing on tty1 over the claim code (NX-74)
              && c.console.font == "ter-v32b"
              && lib.hasInfix "(you will need your disk recovery key)" c.whombat.console.banner
              && lib.elem "systemd.show_status=error" c.boot.kernelParams
              && lib.elem "loglevel=3" c.boot.kernelParams
              && !(lib.elem "loglevel=4" c.boot.kernelParams);
            pkgs.runCommand "console-check" { } ''
              bin=${c.whombat.console.package}/bin/whombat-console
              a=$($bin --once --file /nonexistent --width 100)
              b=$($bin --once --file /nonexistent --width 100 --footer-file ${pkgs.writeText "footer" c.whombat.console.footer})
              [ "$a" = "$b" ] || { echo "the console's default footer is not the appliance's"; exit 1; }
              printf '%s' "$a" | grep -q 'hold Space'
              printf '%s' "$a" | grep -q 'Starting Whombat…'
              printf '{"v":1,"state":"claimable","code":"KXQM","url":"https://dev.whombat.com/claim"}' > ok.json
              $bin --once --file ok.json | grep -q 'open dev.whombat.com/claim and enter'
              printf '{"v":1,"state":"claimable","code":"KXQM\\u001b]0;x\\u0007","url":"a.b/claim"}' > bad.json
              o=$($bin --once --file bad.json)
              printf '%s' "$o" | grep -q 'Starting Whombat'
              if printf '%s' "$o" | LC_ALL=C grep -q "$(printf '\033')"; then echo "escape on the terminal"; exit 1; fi
              # The Console API's state (CG-06, CG-31) from the same file: the claim states only (no recovery key screen),
              # the claimed screen's burrows (CT-116), dropped (not the whole file) when a name carries a bidi override.
              $bin --once --json --file ok.json | ${pkgs.jq}/bin/jq -e \
                '.mode == "console" and (has("key") | not) and (has("screen") | not) and .claim.code == "KXQM"'
              printf '{"v":1,"state":"claimed","url":"https://app.whombat.com/claim","burrows":{"first":"Banjo’s Burrow","more":2}}' > claimed.json
              $bin --once --json --file claimed.json | ${pkgs.jq}/bin/jq -e                 '.claim == {state: "claimed", claimUrl: "app.whombat.com/claim", appUrl: "app.whombat.com", burrows: {first: "Banjo’s Burrow", more: 2}}'
              printf '{"v":1,"state":"claimed","url":"https://app.whombat.com/claim","burrows":{"first":"Evil\u202eworrub","more":2}}' > evil.json
              $bin --once --json --file evil.json | ${pkgs.jq}/bin/jq -e '.claim.state == "claimed" and (.claim | has("burrows") | not)'
              $bin --once --file claimed.json | grep -q 'This Whombat is set up.'
              # The sleeping console's loop (NX-147, NX-162): swayidle's minute steps, 10 minutes and 12 polls (2 min)
              # claimed before it sleeps, the API's desk first (day never sleeps, dim, black after a minute), the
              # backlight through logind; the installer's loop is the plain one.
              sleeping=${c.whombat.kiosk.browser}
              ${pkgs.bash}/bin/bash -n "$sleeping"
              grep -q 'swayidle -C /dev/null timeout 60 "kill -USR1 \$\$" resume "kill -USR2 \$\$"' "$sleeping"
              grep -q "trap 'idle_since=\$((SECONDS - 60))' USR1" "$sleeping"
              grep -q 'http://127.0.0.1:8411/api/state' "$sleeping"
              grep -q 'claimed) \[ "$claimed" -ge 12 \] && \[ "$(idleFor)" -ge 600 \]' "$sleeping"
              grep -q 'black) \[ "$(idleFor)" -ge 60 \]' "$sleeping"
              # The mode query, and what it answers (NX-162, NX-170): never black while the screen is unlocked; awake at
              # the day's level while a sign-in's code shows (NX-304), paired or not.
              q='[(if .claim.signIn != null then "signin" elif .desk == null then "none" elif .desk.paired == null then "unpaired" elif .desk.paired.quiet then (if .desk.paired.night == "black" and .desk.lock.state != "unlocked" then "black" else "dim" end) else "day" end), (.claim.state // "")] | join(" ")'
              grep -qF "$q" "$sleeping"
              want() {
                got=$(printf '%s' "$1" | ${pkgs.jq}/bin/jq -r "$q")
                [ "$got" = "$2" ] || { echo "the kiosk's mode for $1 is $got, not $2"; exit 1; }
              }
              night='"claim":{"state":"claimed"},"desk":{"paired":{"quiet":true,"night":"black"}'
              want "{$night,\"lock\":{\"state\":\"locked\"}}}" "black claimed"
              want "{$night,\"lock\":{\"state\":\"phone\"}}}" "black claimed"
              want "{$night,\"lock\":{\"state\":\"unlocked\"}}}" "dim claimed"
              want '{"claim":{"state":"claimed"},"desk":{"paired":{"quiet":true,"night":"dim"},"lock":{"state":"locked"}}}' "dim claimed"
              want '{"claim":{"state":"claimed"},"desk":{"paired":{"quiet":false,"night":"black"},"lock":{"state":"unlocked"}}}' "day claimed"
              want '{"claim":{"state":"claimed"},"desk":{"paired":null}}' "unpaired claimed"
              want '{"claim":{"state":"claimable"},"desk":null}' "none claimable"
              # A sign-in's code on the screen (NX-304): awake in quiet hours set to Black, unpaired, and without a desk;
              # the console's own JSON for such a file answers the same.
              si='"claim":{"state":"claimed","signIn":{"code":"KXQMTR","name":"John","device":"Pixel","expiresAt":"2026-10-20T12:05:00Z"}}'
              want "{$si,\"desk\":{\"paired\":{\"quiet\":true,\"night\":\"black\"},\"lock\":{\"state\":\"locked\"}}}" "signin claimed"
              want "{$si,\"desk\":{\"paired\":null}}" "signin claimed"
              want "{$si,\"desk\":null}" "signin claimed"
              grep -q 'signin) got=$d ;;' "$sleeping"
              exp=$(date -u -d '+5 min' +%Y-%m-%dT%H:%M:%SZ)
              printf '{"v":1,"state":"claimed","url":"https://app.whombat.com/claim","signIn":{"code":"KXQMTR","name":"John Doe","device":"Pixel 9","expiresAt":"%s"}}' "$exp" > signin.json
              $bin --once --json --file signin.json | ${pkgs.jq}/bin/jq -e '.claim.signIn == {code: "KXQMTR", name: "John Doe", device: "Pixel 9", expiresAt: "'"$exp"'"}'
              [ "$($bin --once --json --file signin.json | ${pkgs.jq}/bin/jq -r "$q")" = "signin claimed" ]
              $bin --once --file signin.json | grep -q 'John Doe wants to sign in'
              grep -q 'if \[ -n "$held" \] && \[ $((SECONDS - held_at)) -lt 600 \]; then' "$sleeping"
              grep -q 'SetBrightness ssu backlight "$bl" "$v"' "$sleeping"
              grep -q 'whombat-kiosk-output' "$sleeping"
              # Every output into the page's fragment beside the token, the installer's too.
              grep -qF 'url="$url&o=$o"' "$sleeping"
              grep -qF 'url="$url&o=$o"' ${ic.whombat.kiosk.browser}
              grep -q -- '--disable-gpu --force-prefers-reduced-motion' "$sleeping"
              if grep -q 'swayidle\|busctl\|desk' ${ic.whombat.kiosk.browser}; then echo "the installer's kiosk sleeps or dims"; exit 1; fi
              grep -q -- '--disable-gpu --force-prefers-reduced-motion' ${ic.whombat.kiosk.browser}
              grep -q -- '--autoplay-policy=no-user-gesture-required' "$sleeping"
              if grep -q -- '--autoplay-policy' ${ic.whombat.kiosk.browser}; then echo "the installer plays sound by itself"; exit 1; fi
              # The launcher: in the image always pixman and Chromium's software flags (NX-169); with `gpu` the graphics
              # chip only with a real GPU driver and the drivers in place, pixman otherwise (NX-161).
              launcher=${c.whombat.kiosk.launcher}/bin/whombat-kiosk
              grep -q 'export WLR_RENDERER=pixman' "$launcher"
              grep -q 'export PULSE_SERVER=unix:/run/pulse/native' "$launcher"
              # No input device yet is no failure, there and on the installer: later ones reach cage (NX-405).
              grep -qx ' *export WLR_LIBINPUT_NO_DEVICES=1' "$launcher"
              grep -qx ' *export WLR_LIBINPUT_NO_DEVICES=1' ${ic.whombat.kiosk.launcher}/bin/whombat-kiosk
              if grep -q PULSE_SERVER ${ic.whombat.kiosk.launcher}/bin/whombat-kiosk; then echo "the installer's kiosk has a sound server"; exit 1; fi
              if grep -q 'render=gpu' "$launcher"; then echo "the appliance's kiosk draws with the GPU"; exit 1; fi
              if grep -q 'render=gpu' ${ic.whombat.kiosk.launcher}/bin/whombat-kiosk; then echo "the installer draws with the GPU"; exit 1; fi
              glauncher=${gc.whombat.kiosk.launcher}/bin/whombat-kiosk
              grep -q 'amdgpu | i915 | xe | nouveau | radeon) render=gpu' "$glauncher"
              grep -q '/run/opengl-driver/lib/dri' "$glauncher"
              grep -q 'export WLR_RENDERER=pixman' "$glauncher"
              ${pkgs.bash}/bin/bash -n "$glauncher"
              # Without a desk socket the Console API's desk is null (NX-160).
              $bin --once --json --file ok.json | ${pkgs.jq}/bin/jq -e 'has("desk") and .desk == null'
              $bin --once --json --file ok.json --desk-socket /nonexistent/desk.sock --desk-peer-uid 0 | ${pkgs.jq}/bin/jq -e '.desk == null' 
              touch $out
            '';
          # The Vault's home networks (VT-59, NX-40): the server gets the list file and its directory (the runner
          # neither), the wall is a dynamic user with CAP_NET_ADMIN only in the host's network namespace, the egress
          # table opens the sets to the server's uid only, and the binary refuses a never-listable network.
          vault-wall-config =
            let
              c = self.nixosConfigurations.appliance-x86_64.config;
              sc = c.systemd.services.whombat-vault-wall.serviceConfig;
              server = c.systemd.services.whombat-server.serviceConfig;
              runner = c.systemd.services.whombat-runner.serviceConfig;
              dir = c.systemd.tmpfiles.settings."20-whombat-vault"."/run/whombat-vault".d;
              egress = c.networking.nftables.tables.whombat-egress.content;
              uid = toString c.whombat.ids.whombat;
              vaultLines = lib.filter (lib.hasInfix "@vault") (lib.splitString "\n" egress);
              sshJumps = map lib.trim (lib.filter (lib.hasInfix "jump vault_ssh") (lib.splitString "\n" egress));
              sshWith =
                ports:
                (self.nixosConfigurations.appliance-x86_64.extendModules {
                  modules = [ { whombat.vault.sshPorts = ports; } ];
                }).config;
              sshOk = ports: lib.all (a: a.assertion) (sshWith ports).assertions;
            in
            assert c.whombat.vaultWall.file == "/run/whombat-vault/networks.json";
            assert lib.elem "WHOMBAT_VAULT_NETWORKS_FILE=/run/whombat-vault/networks.json" server.Environment;
            assert lib.elem "/run/whombat-vault" server.ReadWritePaths;
            assert !(lib.any (lib.hasPrefix "WHOMBAT_VAULT") runner.Environment);
            assert !(lib.elem "/run/whombat-vault" runner.ReadWritePaths);
            assert dir.mode == "0755" && dir.user == "whombat" && dir.group == "whombat";
            assert
              sc.DynamicUser
              && sc.CapabilityBoundingSet == [ "CAP_NET_ADMIN" ]
              && sc.AmbientCapabilities == [ "CAP_NET_ADMIN" ]
              && !(sc ? PrivateNetwork)
              && !(sc ? PrivateUsers)
              && !(sc ? User);
            # Two `return`s, the server's two rules and the agent's two (its commands' proxy and its containers, NX-460:
            # `agent_wall`, which only their uids reach).
            assert lib.length vaultLines == 6;
            assert lib.all (
              l: lib.hasInfix "meta skuid ${uid} " l || lib.hasInfix " return" l || lib.hasInfix "(agent)" l
            ) vaultLines;
            assert lib.length (lib.filter (lib.hasInfix "(agent)") vaultLines) == 2;
            # SSH from the Vault (VT-S14, IN-150, NX-128): one list, default [22], in the server's environment and in the
            # one jump to `vault_ssh` (the server's uid only; the chain returns every non-public address); 1 to 16
            # distinct ports, exported sorted.
            assert c.whombat.vault.sshPorts == [ 22 ];
            assert lib.elem "WHOMBAT_VAULT_SSH_PORTS=22" server.Environment;
            assert sshJumps == [ "meta skuid ${uid} tcp dport { 22 } jump vault_ssh" ];
            # Mail (Whombat CM-23, NX-156): the server's uid reaches public IMAP and SMTP submission ports, never 25.
            assert lib.hasInfix "meta skuid ${uid} tcp dport { 143, 465, 587, 993 } jump mail" egress;
            assert
              let
                lines = map lib.trim (lib.splitString "\n" egress);
                at = lib.lists.findFirstIndex (l: l == "chain mail {") null lines;
              in
              at != null
              &&
                lib.sublist (at + 1) 4 lines == [
                  "ip daddr @nonpublic4 return"
                  "ip6 daddr != 2000::/3 return"
                  "ip6 daddr @nonpublic6 return"
                  "accept comment \"IMAP and SMTP submission to a public address (runtime server)\""
                ];
            assert !(lib.hasInfix "dport { 25" egress);
            assert
              lib.hasInfix "ip daddr @nonpublic4 return" egress
              && lib.hasInfix "ip6 daddr != 2000::/3 return" egress;
            assert
              let
                c2 = sshWith [
                  2222
                  22
                ];
              in
              lib.elem "WHOMBAT_VAULT_SSH_PORTS=22,2222" c2.systemd.services.whombat-server.serviceConfig.Environment
              && lib.hasInfix "meta skuid ${uid} tcp dport { 2222, 22 } jump vault_ssh" c2.networking.nftables.tables.whombat-egress.content;
            assert lib.all (p: !(sshOk p)) [
              [ ]
              [
                22
                22
              ]
              (lib.range 2201 2217)
            ];
            assert sshOk (lib.range 2201 2216);
            pkgs.runCommand "vault-wall-config-check" { } ''
              bin=${c.whombat.vaultWall.package}/bin/whombat-vault-wall
              printf '{"version":1,"networks":[{"cidr":"192.168.1.0/24","ports":[8123]}]}' > ok.json
              $bin --check ok.json | grep -qxF '  192.168.1.0/24 . 8123'
              printf '{"version":1,"networks":[{"cidr":"169.254.169.254/32","ports":[80]}]}' > bad.json
              if $bin --check bad.json 2>err; then echo "a link-local network was accepted"; exit 1; fi
              grep -q link-local err
              touch $out
            '';
          # The agent's commands and containers (Whombat OP-04, OP-07, OP-13, OP-16, OP-19; NX-455…NX-466): nothing of the
          # computers or Incus; the engine's unit (its user and ids, socket, configuration from the store, cgroup, slice,
          # OOM score, what it sees); the runner's and the server's settings; the agent's tools and home; the commands'
          # network daemon's unit; the agent's wall in the egress table (each uid before the rules every uid has, the
          # computers' order); published ports from private networks only; the computers' cleanup after a blessed boot;
          # the qgroup of the containers; and who goes first when memory runs out (MP-02, NX-142): the core units' slice,
          # MemoryMin and OOM scores, the protection on whombat.slice too, the runner's -900 and the containers' 500.
          containers-config =
            let
              app = self.nixosConfigurations.appliance-x86_64;
              c = app.config;
              cc = c.whombat.containers;
              ag = c.whombat.agent;
              svc = c.systemd.services;
              eng = svc.whombat-containers;
              esc = eng.serviceConfig;
              sock = c.systemd.sockets.whombat-containers.socketConfig;
              net = svc.whombat-agent-net;
              nsc = net.serviceConfig;
              renv = svc.whombat-runner.environment;
              senv = svc.whombat-server.environment;
              units = c.whombat.slices.critical.units;
              slices = c.systemd.slices;
              users = c.users.users;
              egress = c.networking.nftables.tables.whombat-egress.content;
              # Where a rule is in the table; -1 unless it is there exactly once.
              at =
                s:
                let
                  parts = lib.splitString s egress;
                in
                if lib.length parts == 2 then lib.stringLength (lib.head parts) else -1;
              ordered =
                l:
                lib.all (i: at (lib.elemAt l i) >= 0 && at (lib.elemAt l i) < at (lib.elemAt l (i + 1))) (
                  lib.range 0 (lib.length l - 2)
                );
              withC = extra: (app.extendModules { modules = [ { whombat.containers = extra; } ]; }).config;
              ok = extra: lib.all (a: a.assertion) (withC extra).assertions;
              other = withC {
                publishPorts = {
                  from = 30000;
                  to = 30049;
                };
              };
              private4 = "ip saddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 }";
              tmp = c.systemd.tmpfiles.settings;
              home = tmp."20-whombat-agent"."/persist/whombat/agent/home";
            in
            # Nothing of the computers (NX-455).
            assert
              !(svc ? incus)
              && !(svc ? incus-instances)
              && !(svc ? whombat-computerd)
              && !(svc ? whombat-computers-lan)
              && !(svc ? whombat-computers-storage)
              && !(svc ? whombat-computers-move)
              && !(svc ? whombat-computers-memory)
              && !(users ? whombat-computerd)
              && !(c.users.groups ? incus-admin)
              && !(c.users.groups ? whombat-computers)
              && users.root.subUidRanges == [ ];
            assert !(lib.hasInfix "computers_" egress) && !(c.networking.nftables.tables ? whombat-computers);
            assert !(lib.any (p: lib.hasInfix "incus" (toString p)) c.environment.systemPackages);
            # The engine (NX-457).
            assert users.whombat-containers.uid == 971 && c.users.groups.whombat-containers.gid == 971;
            assert
              users.whombat-containers.subUidRanges == [
                {
                  startUid = 3000000;
                  count = 65536;
                }
              ];
            assert lib.elem "whombat-workspaces" users.whombat-containers.extraGroups;
            assert
              lib.elem "whombat-containers" users.whombat-runner.extraGroups
              && lib.elem "whombat-containers" users.whombat.extraGroups;
            assert cc.socket == "/run/whombat-containers/podman.sock" && sock.ListenStream == cc.socket;
            assert
              sock.SocketMode == "0660"
              && sock.SocketGroup == "whombat-containers"
              && sock.SocketUser == "whombat-containers";
            assert
              esc.User == "whombat-containers" && esc.Slice == "whombat-tasks.slice" && esc.OOMScoreAdjust == 500;
            assert esc.MemorySwapMax == "0" && esc.Delegate == "yes" && esc.KillMode == "process";
            assert !eng.restartIfChanged && lib.elem "multi-user.target" eng.wantedBy;
            assert esc.TemporaryFileSystem == [ "/persist:ro" ];
            assert
              esc.BindPaths == [
                "/persist/containers"
                "/persist/whombat/agent/home"
                "/persist/whombat/workspaces"
              ];
            assert lib.all (d: lib.elem "-${d}" esc.InaccessiblePaths) [
              "/run/whombat"
              "/run/postgresql"
              "/run/whombat-agent-net"
              "/var/lib/whombat-runner"
            ];
            assert
              esc.CapabilityBoundingSet == [
                "CAP_SETPCAP"
                "CAP_SETUID"
                "CAP_SETGID"
              ]
              && esc.DeviceAllow == [ "/dev/net/tun rw" ];
            assert
              !c.security.wrappers.newuidmap.setuid
              && c.security.wrappers.newuidmap.capabilities == "cap_setuid+ep";
            # conmon's cleanup finds Podman by the path it reads without the store's mount point (NX-462).
            assert
              tmp."20-whombat-containers"."/${builtins.unsafeDiscardStringContext (builtins.baseNameOf "${cc.package}")}"."L+".argument
              == "${cc.package}";
            assert esc.ExecStartPre == "${cc.package}/bin/podman unshare true";
            # No systemd-run for netavark (compose's DNS, NX-457).
            assert
              !(lib.hasInfix "systemd" eng.environment.PATH)
              && lib.hasSuffix ":/run/wrappers/bin" eng.environment.PATH;
            assert lib.all (k: lib.hasPrefix "/nix/store/" eng.environment.${k}) [
              "CONTAINERS_CONF"
              "CONTAINERS_STORAGE_CONF"
              "CONTAINERS_REGISTRIES_CONF"
            ];
            assert
              eng.environment.XDG_RUNTIME_DIR == "/run/whombat-containers/xdg"
              && eng.environment.HOME == "/persist/containers/home";
            assert
              lib.hasPrefix "+/nix/store/" (lib.head esc.ExecStartPost)
              && lib.hasInfix "listen-load" (lib.head esc.ExecStartPost);
            assert
              c.whombat.storage.containers == {
                subvolumes = [ "containers" ];
                percent = 50;
              };
            assert c.whombat.storage.qgroups.containers == "1/101";
            assert lib.elem "whombat/agent/home" c.whombat.storage.extraSubvolumes;
            # The runner and the server (I-1…I-4).
            assert renv.WHOMBAT_CONTAINERS_SOCKET == cc.socket && senv.WHOMBAT_CONTAINERS_SOCKET == cc.socket;
            assert
              renv.WHOMBAT_AGENT_TOOLS == "${ag.tools}"
              && renv.WHOMBAT_AGENT_HOME == "/persist/whombat/agent/home";
            assert
              renv.WHOMBAT_AGENT_NIX_LD_LIBRARY_PATH == "${ag.libraries}/lib"
              && lib.hasSuffix "/lib/ld-linux-x86-64.so.2" renv.WHOMBAT_AGENT_NIX_LD;
            assert
              renv.WHOMBAT_AGENT_NET_SOCKET == "/run/whombat-agent-net/proxy.sock"
              && !(senv ? WHOMBAT_AGENT_NET_SOCKET);
            assert
              renv.WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES == "15"
              && senv.WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES == "15";
            assert lib.hasSuffix "/bin/nsenter" renv.WHOMBAT_SANDBOX_NSENTER;
            assert
              !(renv ? WHOMBAT_COMPUTERS) && !(renv ? WHOMBAT_COMPUTERD_SOCKET) && !(senv ? WHOMBAT_COMPUTERS);
            # The agent's browser runs from the tools with the image's fonts (R2).
            assert c.fonts.fontconfig.enable && c.environment.etc.fonts.enable;
            assert renv.TMPDIR == "/var/lib/whombat-runner/tmp" && !(senv ? TMPDIR);
            assert lib.all (g: lib.elem g svc.whombat-runner.serviceConfig.SupplementaryGroups) [
              "whombat-containers"
              "whombat-agent-net"
            ];
            assert lib.elem "whombat-containers" svc.whombat-server.serviceConfig.SupplementaryGroups;
            assert !(lib.elem "whombat-agent-net" svc.whombat-server.serviceConfig.SupplementaryGroups);
            assert lib.elem "/persist/whombat/agent/home" svc.whombat-runner.serviceConfig.ReadWritePaths;
            assert
              home.d.mode == "2770" && home.d.user == "whombat-runner" && home.d.group == "whombat-containers";
            assert lib.hasInfix "default:group:whombat-containers:rwx" home."a+".argument;
            # The commands' network daemon (I-4, NX-456).
            assert
              users.whombat-agent-net.uid == 962 && lib.elem "whombat-agent-net" users.whombat-runner.extraGroups;
            assert
              nsc.User == "whombat-agent-net"
              && nsc.ExecStart == "/nix/var/nix/profiles/whombat-runtime/bin/whombat-agent-net";
            assert lib.elem "/nix/var/nix/profiles/whombat-runtime/bin/whombat-agent-net"
              net.unitConfig.ConditionPathExists;
            assert
              nsc.CapabilityBoundingSet == ""
              && nsc.NoNewPrivileges
              && lib.elem "-/persist" nsc.InaccessiblePaths;
            assert
              net.environment.WHOMBAT_AGENT_NET_SERVICE_PORTS == "20000-20099"
              && net.environment.WHOMBAT_AGENT_NET_SOCKET == ag.netSocket;
            assert tmp."20-whombat-agent"."/run/whombat-agent-net".d.mode == "0750";
            # The wall (NX-460): each uid's chain before the rules every uid has, the computers' order in agent_wall.
            assert ordered [
              "meta skuid 962 jump agent_net_out"
              "oifname \"lo\" accept"
            ];
            assert ordered [
              "meta skuid 971 jump containers_out"
              "oifname \"lo\" accept"
            ];
            assert ordered [
              "ip daddr . tcp dport @vault4 ct mark set 0x5641554c accept comment \"Vault home networks (agent)\""
              "ip daddr @agent_deny4 counter reject"
              "tcp dport 25 counter reject with tcp reset comment \"agent: no SMTP\""
              "ip daddr @local4 ip daddr != 100.100.100.200 meta l4proto { tcp, udp, icmp } counter accept"
              "ip daddr @nonpublic4 counter reject with icmpx admin-prohibited comment \"agent: not a public address\""
              "meta l4proto { tcp, udp, icmp, ipv6-icmp } accept comment \"agent: the public internet\""
            ];
            assert at "ip daddr 127.0.0.1 tcp dport 20000-20099 ct state new ct mark set 0x53455256 accept" > 0;
            assert
              at "oifname \"lo\" counter reject with icmpx admin-prohibited comment \"containers: nothing on this host\""
              > 0;
            # Published ports (NX-461).
            assert at "tcp dport 20000-20099 ct state new jump containers_published" > 0;
            assert ordered [
              "iifname \"lo\" ct mark 0x53455256 return"
              "iifname \"lo\" counter reject with icmpx admin-prohibited comment \"published ports: not from this host\""
              "${private4} return"
              "ip6 saddr { fc00::/7, fe80::/10 } return"
              "counter drop comment \"published ports: private networks only\""
            ];
            assert lib.hasInfix "${private4} tcp dport 20000-20099 accept"
              c.networking.firewall.extraInputRules;
            assert lib.hasInfix "tcp dport 30000-30049 ct state new jump containers_published"
              other.networking.nftables.tables.whombat-egress.content;
            assert lib.hasInfix "tcp dport 30000-30049 accept" other.networking.firewall.extraInputRules;
            assert
              other.systemd.services.whombat-agent-net.environment.WHOMBAT_AGENT_NET_SERVICE_PORTS
              == "30000-30049";
            assert lib.all (p: !(ok { publishPorts = p; })) [
              {
                from = 20100;
                to = 20099;
              }
              {
                from = 1000;
                to = 1010;
              }
              {
                from = 32700;
                to = 32768;
              }
              {
                from = 20000;
                to = 21000;
              }
            ];
            assert
              !(ok {
                idRange = {
                  start = 2000000;
                  count = 65536;
                };
              });
            # The computers' leftovers (NX-463): once the boot is blessed.
            assert
              lib.elem "boot-complete.target" svc.whombat-computers-cleanup.wantedBy
              && lib.elem "boot-complete.target" svc.whombat-computers-cleanup.after;
            # MP-02, NX-142.
            assert
              units == {
                postgresql = 320;
                whombat-server = 384;
                whombat-manager = 48;
                whombat-agent-net = 64;
              };
            assert lib.all (s: s.sliceConfig.MemoryMin == "816M" && s.sliceConfig.MemoryLow == "816M") [
              slices.whombat
              slices.whombat-critical
            ];
            assert lib.all (u: svc.${u}.serviceConfig.MemoryMin == "${toString units.${u}}M") (
              lib.attrNames units
            );
            assert lib.all (
              u:
              svc.${u}.serviceConfig.Slice == "whombat-critical.slice"
              && svc.${u}.serviceConfig.OOMScoreAdjust == -900
            ) (lib.attrNames units);
            assert svc.whombat-runner.serviceConfig.OOMScoreAdjust == -900;
            assert svc.whombat-runner.serviceConfig.Slice == "whombat-tasks.slice";
            assert svc.whombat-update-helper.serviceConfig.OOMScoreAdjust == -900;
            # Swap in RAM (NX-146): zram, a quarter of the memory and at most 4 GiB, zstd, zswap off, swappiness for
            # in-memory swap; never for the tasks or the containers; oomd unchanged; off with the option.
            assert c.zramSwap.enable && c.zramSwap.algorithm == "zstd" && c.zramSwap.swapDevices == 1;
            assert
              c.services.zram-generator.settings.zram0.zram-size
              == "min(25 / 100 * ram, 4294967296 / 1024 / 1024)";
            assert c.boot.kernel.sysctl."vm.swappiness" == 180 && c.boot.kernel.sysctl."vm.page-cluster" == 0;
            assert lib.elem "zswap.enabled=0" c.boot.kernelParams;
            assert slices.whombat-tasks.sliceConfig.MemorySwapMax == "0";
            assert !(slices.whombat-critical.sliceConfig ? MemorySwapMax);
            assert !c.systemd.oomd.enableRootSlice && !(slices.whombat-tasks.sliceConfig ? ManagedOOMSwap);
            assert
              let
                off = (app.extendModules { modules = [ { whombat.slices.swap.enable = false; } ]; }).config;
              in
              !off.zramSwap.enable
              && !(off.boot.kernel.sysctl ? "vm.swappiness")
              && !(lib.elem "zswap.enabled=0" off.boot.kernelParams);
            pkgs.runCommand "containers-config-check" { nativeBuildInputs = [ pkgs.remarshal ]; } ''
              # The engine's configuration as Podman reads it (TOML), and what it says.
              toml2json ${eng.environment.CONTAINERS_CONF} > containers.json
              ${pkgs.jq}/bin/jq -e '.containers.cgroups == "split" and .containers.oom_score_adj == 500
                and (.containers.annotations | index("run.oci.keep_original_groups=1")) != null
                and .engine.cgroup_manager == "cgroupfs" and .network.default_rootless_network_cmd == "pasta"
                and .engine.image_copy_tmp_dir == "/persist/containers/tmp"' containers.json
              toml2json ${eng.environment.CONTAINERS_STORAGE_CONF} | ${pkgs.jq}/bin/jq -e '.storage.driver == "overlay"
                and .storage.graphroot == "/persist/containers/storage"'
              # The tools a command finds (OP-13).
              for t in bash git ssh rsync curl wget jq rg fd tree file zip unzip tmux less nano vim sqlite3 gcc make cmake \
                       pkg-config node npm npx pnpm python3 pip uv ffmpeg magick pandoc pdftotext tesseract chromium \
                       agent-browser docker docker-compose; do
                test -x ${ag.tools}/bin/$t || { echo "no $t in the agent's tools"; exit 1; }
              done
              grep -q 'DOCKER_HOST.*unix:///run/whombat-containers/podman.sock' ${ag.tools}/bin/docker
              for l in libstdc++.so.6 libz.so.1 libssl.so.3 libcrypt.so.1 libX11.so.6 libnss3.so libgbm.so.1 libglib-2.0.so.0; do
                test -e ${ag.libraries}/lib/$l || { echo "no $l for nix-ld"; exit 1; }
              done
              touch $out
            '';
          # The sandbox toolchain's Python has the skills' document libraries (SL-11, NX-98), and they work.
          toolchain =
            let
              tc = self.nixosConfigurations.appliance-x86_64.config.whombat.sandbox.toolchain;
            in
            pkgs.runCommand "toolchain-check" { } ''
              cd $TMPDIR
              ${tc}/bin/python3 - <<'EOF'
              import docx, openpyxl, pptx, pypdf, PIL.Image
              d = docx.Document(); d.add_paragraph("Whombat"); d.save("a.docx")
              assert docx.Document("a.docx").paragraphs[0].text == "Whombat"
              wb = openpyxl.Workbook(); wb.active["A1"] = 42; wb.save("a.xlsx")
              assert openpyxl.load_workbook("a.xlsx").active["A1"].value == 42
              p = pptx.Presentation(); p.slides.add_slide(p.slide_layouts[5]).shapes.title.text = "Whombat"; p.save("a.pptx")
              assert len(pptx.Presentation("a.pptx").slides) == 1
              w = pypdf.PdfWriter(); w.add_blank_page(width=200, height=200); w.write("a.pdf")
              assert len(pypdf.PdfReader("a.pdf").pages) == 1
              PIL.Image.new("RGB", (4, 4), "white").save("a.png")
              assert PIL.Image.open("a.png").size == (4, 4)
              EOF
              touch $out
            '';
          # The versions and the runtime's defaults (PI-07, NX-47, NX-105). A release's runtime is
          # `<package.json>-<its stamp's commit time>.<rev>` and reports the stamp it was given, the same stamp is the
          # same derivation, and a release without a stamp doesn't evaluate; every other build's runtime is
          # `<package.json>-0.dev`. A release's manager and helper are `<appliance semver>-<commit time>.<rev>`, every
          # other build's `<appliance semver>-0.dev` (UP-X09). Prod defaults to the real bundle and still refuses the
          # stand-in; dev images keep the stand-in; the Whombat image runs the hub built here. Building the bundle
          # itself is `packages.whombat-runtime` (its install check).
          release-versions =
            let
              rt = pkgs.whombat-runtime;
              pkgVersion = (lib.importJSON (sources.root + "/package.json")).version;
              stamp = {
                rev = "0123456789abcdef0123456789abcdef01234567";
                time = 1767225600;
                date = "20260101000000";
              };
              release =
                args:
                (applianceRelease (
                  {
                    env = "prod";
                    releaseId = "whombat-20260101.1";
                  }
                  // args
                )).appliance.config.whombat;
              rel = release { runtimeStamp = stamp; };
              again = release { runtimeStamp = stamp; };
              later = release {
                runtimeStamp = stamp // {
                  time = stamp.time + 1;
                  date = "20260101000001";
                };
              };
              evaluates = v: (builtins.tryEval (builtins.deepSeq v v)).success;
              prodWith = extra: applianceFor system ([ { whombat.environment = "prod"; } ] ++ extra);
              failed =
                extra: map (a: a.message) (lib.filter (a: !a.assertion) (prodWith extra).config.assertions);
              standInRefused = "prod needs the real Whombat runtime bundle, not the stand-in";
              devCfg = self.nixosConfigurations.appliance-x86_64.config.whombat;
              commitTimed = core: v: builtins.match "${lib.escapeRegex core}-[0-9]{14}\\.[0-9a-f]{7}.*" v != null;
            in
            assert lib.assertMsg (rt.version == "${pkgVersion}-0.dev" && !rt.passthru.stamped)
              "a runtime that is no release is ${rt.version}, not ${pkgVersion}-0.dev";
            assert lib.assertMsg (rel.runtime.package.version == "${pkgVersion}-20260101000000.0123456")
              "a release's runtime is ${rel.runtime.package.version}, not <package.json>-<its stamp's time>.<rev> (NX-105)";
            assert rel.runtime.package.passthru.stamp == stamp && rel.runtime.package.passthru.stamped;
            assert lib.assertMsg (rel.runtime.package.drvPath == again.runtime.package.drvPath)
              "the same stamp gives another runtime";
            assert lib.assertMsg (rel.runtime.package.drvPath != later.runtime.package.drvPath)
              "another stamp gives the same runtime";
            assert lib.assertMsg (!evaluates (release { }).runtime.package.version)
              "a release without a runtime stamp evaluates: it would take this commit by itself";
            assert lib.assertMsg (
              !evaluates
                (release {
                  runtimeStamp = stamp // {
                    rev = "0123456";
                  };
                }).runtime.package.version
            ) "a release with a short commit as its runtime stamp evaluates";
            assert lib.assertMsg (commitTimed applianceVersion rel.manager.package.version)
              "a release's manager is ${rel.manager.package.version}, not ${applianceVersion}-<commit time>.<rev> (NX-105)";
            assert rel.helper.package.version == rel.manager.package.version;
            assert devCfg.manager.package.version == "${applianceVersion}-0.dev";
            assert devCfg.helper.package.version == "${applianceVersion}-0.dev";
            assert assertHermesPin rt;
            assert (prodWith [ ]).config.whombat.runtime.package.outPath == rt.outPath;
            assert devCfg.runtime.package.passthru.whombatStandIn or false;
            assert !(lib.elem standInRefused (failed [ ]));
            assert lib.elem standInRefused (failed [
              { whombat.runtime.package = pkgs.whombat-standin-runtime; }
            ]);
            assert self.nixosConfigurations.self-installed-prod.config.whombat.hosts.package.outPath == pkgs.whombat-hosts.outPath;
            pkgs.runCommand "release-versions-check" { } "touch $out";
          # Hermes for the runner (Whombat HE-10, HE-16; NX-430…NX-435, NX-483): the package is the pinned release, the one
          # the pinned Whombat pins too, and part of the runtime bundle, whose runner names it; the Whombat image gives
          # the runner the profile root (0700 whombat-runner, its own subvolume in Whombat's qgroup, writable for the runner
          # alone) and no Hermes of the host's, and check the runtime's Hermes at every activation, a unit the manager's
          # health counts (NX-484); images with the stand-in runtime leave it out. Building it is `packages.whombat-hermes`
          # (its install check: `hermes --version`, `hermes acp --help`, the plugin's entry point, the activation's check).
          hermes =
            let
              hp = pkgs.whombat-hermes;
              rt = pkgs.whombat-runtime;
              withHermes =
                name:
                let
                  c = self.nixosConfigurations.${name}.config;
                  r = c.systemd.services.whombat-runner;
                  hc = c.systemd.services.whombat-hermes-check;
                  t = c.systemd.tmpfiles.settings."20-whombat-hermes"."/persist/whombat/hermes".d;
                in
                c.whombat.hermes.enable
                && c.whombat.runtime.package.outPath == rt.outPath
                && c.whombat.hermes.package.outPath == hp.outPath
                && !(r.environment ? WHOMBAT_HERMES_BIN)
                && r.environment.WHOMBAT_HERMES_ROOT == "/persist/whombat/hermes"
                && lib.elem "/persist/whombat/hermes" r.serviceConfig.ReadWritePaths
                && hc.serviceConfig.ExecStart == "/nix/var/nix/profiles/whombat-runtime/bin/whombat-hermes-check"
                && hc.serviceConfig.DynamicUser
                && hc.serviceConfig.PrivateNetwork
                && lib.elem "whombat-runtime.target" hc.wantedBy
                && lib.elem "whombat-runtime.target" hc.partOf
                && !(hc.unitConfig.DefaultDependencies or true)
                && t.mode == "0700"
                && t.user == "whombat-runner"
                && t.group == "whombat-runner"
                && lib.elem "whombat/hermes" c.whombat.storage.extraSubvolumes
                && !(c.systemd.services.whombat-server.environment ? WHOMBAT_HERMES_BIN)
                && !(lib.elem "/persist/whombat/hermes" c.systemd.services.whombat-server.serviceConfig.ReadWritePaths);
              hw = self.nixosConfigurations.appliance-x86_64.config;
            in
            assert lib.assertMsg (hp.passthru.hermesRev == hermes.rev)
              "whombat-hermes is built from ${hp.passthru.hermesRev}, the flake input hermes is ${hermes.rev} (NX-433)";
            assert lib.assertMsg (
              rt.passthru.hermes.outPath == hp.outPath
            ) "the runtime bundle doesn't carry pkgs.whombat-hermes (NX-483)";
            assert assertHermesPin rt;
            assert lib.assertMsg (withHermes "self-installed-prod")
              "the Whombat image's runner lacks Hermes (NX-431)";
            assert lib.assertMsg (
              !hw.whombat.hermes.enable
              && !(hw.systemd.services.whombat-runner.environment ? WHOMBAT_HERMES_BIN)
              && !(hw.systemd.services ? whombat-hermes-check)
            ) "an image with the stand-in runtime carries Hermes (NX-431)";
            # The manager counts the check among the runtime's units (NX-484) where there is Hermes, and only there.
            pkgs.runCommand "hermes-check" { nativeBuildInputs = [ pkgs.jq ]; } ''
              units() { jq -c .runtime.units "$1"; }
              for f in ${
                lib.concatMapStringsSep " "
                  (n: self.nixosConfigurations.${n}.config.environment.etc."whombat/manager.json".source)
                  [
                    "self-installed-prod"
                  ]
              }; do
                units "$f" | grep -qF '"whombat-hermes-check.service"' || { echo "$f: $(units "$f")"; exit 1; }
              done
              ! units ${hw.environment.etc."whombat/manager.json".source} | grep -qF hermes
              touch $out
            '';
          # The signed agents (Whombat AU-02, NX-158): nix/packages/hosts/agent-manifest.json is sign-agents' manifest
          # of exactly the agents hosts/ builds (the version of agent-version.json, the committed key's fingerprint,
          # sizes, sha256s, signatures). Strict: only a match passes, and a release is built only when it does.
          hosts-agent-manifest = pkgs.whombat-hosts.passthru.manifestCheck;
          # A build without matching signatures (someone without the key who changed the agents, another Go): the
          # same package installs the agents without a manifest, and its hub starts and offers no update. The agents
          # here get a build id of their own, so they are other bytes than the committed manifest signs.
          hosts-unsigned-build =
            let
              hub = pkgs.whombat-hosts.override { agentBuildId = "unsigned-build-check"; };
              dist = "${hub}/share/whombat-hosts/agent";
            in
            pkgs.runCommand "hosts-unsigned-build-check"
              {
                nativeBuildInputs = [
                  pkgs.curl
                  pkgs.jq
                ];
              }
              ''
                test -s ${dist}/whombat-agent-linux-amd64
                if [ -e ${dist}/manifest.json ]; then echo "an unsigned build carries a manifest"; exit 1; fi
                # The strict check refuses the same agents, as other bytes and nothing else.
                status=0
                ${hub.passthru.checker}/bin/whombat-hosts-manifest-check --manifest ${./nix/packages/hosts/agent-manifest.json} \
                  --key ${./nix/packages/hosts/agent-update-key.pub} --version '${hub.version}' --dir ${dist} || status=$?
                [ "$status" = 3 ] || { echo "the manifest check exits $status for other bytes, not 3"; exit 1; }
                # The hub starts on them and says it has no signed build.
                mkdir data
                ${hub}/bin/whombat-hosts serve --headless --data "$PWD/data" --listen "unix:$PWD/api.sock" \
                  --agent-listen 127.0.0.1:0 --agent-url auto --agent-dist ${dist} \
                  --service-token-file "$PWD/token" >hub.log 2>&1 &
                hub=$!
                trap 'kill $hub 2>/dev/null || true' EXIT
                for _ in $(seq 100); do [ -S api.sock ] && [ -s token ] && break; sleep 0.1; done
                [ -S api.sock ] || { cat hub.log; echo "the hub didn't start"; exit 1; }
                code=$(curl -sS --unix-socket api.sock -o answer.json -w '%{http_code}' -X POST \
                  -H "Authorization: Bearer $(cat token)" -H 'Content-Type: application/json' -d '{}' \
                  http://hub/api/v1/agents/update)
                [ "$code" = 409 ] && jq -e '.. | strings | select(test("no signed agent build"))' answer.json >/dev/null ||
                  { cat hub.log answer.json; echo "the hub answered $code, not “no signed agent build”"; exit 1; }
                touch $out
              '';
          # The hosts service (Whombat ONE-11…ONE-15; NX-152…NX-154): on in the DEV image only, refused in prod; the hub's
          # unit (its fixed user, the flags, the socket's directory, the sandbox, outside the runtime target and the boot
          # assessment); the server's environment and group; /persist/hosts; agents on 8443 from private networks only and
          # nothing on this host; the hub's egress (the local network, on this host only the resolver); pings without
          # CAP_NET_RAW; the agents for both architectures in the package.
          hosts-config =
            let
              # The Whombat image (NX-523): every box has the hub.
              dev = self.nixosConfigurations.self-installed-prod.config;
              hw = self.nixosConfigurations.appliance-x86_64.config;
              h = dev.whombat.hosts;
              u = dev.systemd.services.whombat-hosts;
              sc = u.serviceConfig;
              srv = dev.systemd.services.whombat-server;
              tmp = dev.systemd.tmpfiles.settings."20-whombat-hosts"."/persist/hosts".d;
              # Its backup for the box's checkpoints (NX-407…NX-409, BK-31…BK-34).
              bkTmp = dev.systemd.tmpfiles.settings."20-whombat-hosts"."/persist/hosts-backup".d;
              bkSock = dev.systemd.sockets.whombat-hosts-backup;
              bkUnit = dev.systemd.services."whombat-hosts-backup@";
              bk = bkUnit.serviceConfig;
              backupUnits =
                svcs:
                map (n: svcs.${n}) [
                  "whombat-backup"
                  "whombat-backup-api"
                  "whombat-backup-drill"
                ];
              # The backup's configuration file, found at build time in its unit's command (its context builds it).
              configOf =
                cfg:
                "$(printf '%s' ${lib.escapeShellArg cfg.systemd.services.whombat-backup.serviceConfig.ExecStart} | grep -o '/nix/store/[^ ]*-whombat-backup.json')";
              egress = dev.networking.nftables.tables.whombat-egress.content;
              inputRules = dev.networking.firewall.extraInputRules;
              # Where a rule is in the table; -1 unless it is there exactly once.
              at =
                s:
                let
                  parts = lib.splitString s egress;
                in
                if lib.length parts == 2 then lib.stringLength (lib.head parts) else -1;
              ordered =
                l:
                lib.all (i: at (lib.elemAt l i) >= 0 && at (lib.elemAt l i) < at (lib.elemAt l (i + 1))) (
                  lib.range 0 (lib.length l - 2)
                );
              failed =
                extra:
                map (a: a.message) (lib.filter (a: !a.assertion) (applianceFor system extra).config.assertions);
              has = infix: extra: lib.any (lib.hasInfix infix) (failed extra);
              ping = map lib.toInt (lib.splitString " " dev.boot.kernel.sysctl."net.ipv4.ping_group_range");
              gid = dev.users.groups.whombat-hosts.gid;
              dist = "${h.package}/share/whombat-hosts/agent";
              private4 = "{ 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 }";
              assess = dev.systemd.services.whombat-boot-assessment.serviceConfig.ExecStart;
            in
            assert h.enable && !hw.whombat.hosts.enable && !(hw.systemd.services ? whombat-hosts);
            # Production takes the hub only with its agents signed by the Whombat agent-signing key (NX-157, NX-523): the
            # pinned package passes, one without that key's agents and manifest doesn't.
            assert has "signed with the Whombat agent-signing key" [
              {
                whombat.environment = "prod";
                whombat.hosts.enable = true;
                whombat.hosts.package = pkgs.hello;
              }
            ];
            assert
              !(has "signed with the Whombat agent-signing key" [
                {
                  whombat.environment = "prod";
                  whombat.hosts.enable = true;
                }
              ]);
            assert
              h.package.passthru.updateKey == lib.fileContents ./nix/packages/hosts/agent-update-key.pub
              && (lib.importJSON ./nix/packages/hosts/agent-manifest.json).key == "40f47772ee26385e";
            assert !(has "whombat.hosts" [ { whombat.hosts.enable = true; } ]);
            assert has "whombat.hosts.agentPort" [
              {
                whombat.hosts.enable = true;
                whombat.hosts.agentPort = 20050;
              }
            ];
            assert has "whombat.hosts.agentPort" [
              {
                whombat.hosts.enable = true;
                whombat.hosts.agentPort = 443;
              }
            ];
            # The account and the unit.
            assert dev.users.users.whombat-hosts.uid == 965 && gid == 965;
            assert sc.User == "whombat-hosts" && sc.Group == "whombat-hosts" && !(sc ? DynamicUser);
            assert u.wantedBy == [ "multi-user.target" ] && u.partOf == [ ];
            assert lib.elem "whombat-persist.target" u.requires && lib.elem "nftables.service" u.requires;
            assert
              u.unitConfig.ConditionPathExists == [
                "/persist/identity/device.json"
                "!/persist/backup/quarantine.json"
              ];
            assert
              sc.ExecStart == lib.escapeShellArgs [
                "${h.package}/bin/whombat-hosts"
                "serve"
                "--headless"
                "--data"
                "/persist/hosts"
                "--listen"
                "unix:/run/whombat-hosts/api.sock"
                "--agent-listen"
                ":8443"
                "--agent-url"
                "auto"
                "--agent-dist"
                dist
                "--service-token-file"
                "/persist/hosts/service-token"
              ];
            assert
              sc.RuntimeDirectory == "whombat-hosts" && sc.RuntimeDirectoryMode == "0750" && sc.UMask == "0077";
            assert sc.MemoryMax == "512M" && sc.CapabilityBoundingSet == "" && sc.NoNewPrivileges;
            assert sc.TemporaryFileSystem == [ "/persist:ro" ] && sc.BindPaths == [ "/persist/hosts" ];
            assert
              lib.elem "-/run/postgresql" sc.InaccessiblePaths && lib.elem "-/run/whombat" sc.InaccessiblePaths;
            assert sc.IPAddressDeny == [ "localhost" ];
            # Ping checks: unprivileged ICMP sockets for its group.
            assert lib.elemAt ping 0 <= gid && gid <= lib.elemAt ping 1;
            # The server: the socket, the token and the group; nothing of it on the hardware image.
            assert srv.environment.WHOMBAT_HOSTS_SOCKET == "/run/whombat-hosts/api.sock";
            assert srv.environment.WHOMBAT_HOSTS_TOKEN_FILE == "/persist/hosts/service-token";
            assert lib.elem "whombat-hosts" srv.serviceConfig.SupplementaryGroups;
            assert lib.elem "whombat-hosts" dev.users.users.whombat.extraGroups;
            assert !(hw.systemd.services.whombat-server.environment ? WHOMBAT_HOSTS_SOCKET);
            # /persist/hosts: its own subvolume, the group may traverse it (to the token) but not list it.
            assert
              lib.elem "hosts" dev.whombat.storage.extraSubvolumes
              && !(lib.elem "hosts" hw.whombat.storage.extraSubvolumes);
            assert tmp.mode == "0710" && tmp.user == "whombat-hosts" && tmp.group == "whombat-hosts";
            # Its backup: a subvolume of its own, the hub user's; a socket of the backup's group whose instance makes
            # it as the hub's user, sandboxed like the hub and without a network; the checkpoint wants the socket, its
            # units never see the hub's live data, the snapshot helper only the backup; prod has none of it.
            assert
              lib.elem "hosts-backup" dev.whombat.storage.extraSubvolumes
              && !(lib.elem "hosts-backup" hw.whombat.storage.extraSubvolumes);
            assert bkTmp.mode == "0700" && bkTmp.user == "whombat-hosts" && bkTmp.group == "whombat-hosts";
            assert h.backupDir == "/persist/hosts-backup" && h.backupSocket == "/run/whombat-backup/hosts.sock";
            assert
              bkSock.wantedBy == [ "sockets.target" ] && bkSock.socketConfig.ListenStream == h.backupSocket;
            assert
              bkSock.socketConfig.SocketUser == "root" && bkSock.socketConfig.SocketGroup == "whombat-backup";
            assert
              bkSock.socketConfig.SocketMode == "0660"
              && bkSock.socketConfig.Accept
              && bkSock.socketConfig.MaxConnections == 1;
            assert
              bk.User == "whombat-hosts"
              && bk.Group == "whombat-hosts"
              && bk.NoNewPrivileges
              && bk.CapabilityBoundingSet == "";
            assert
              bk.StandardInput == "socket" && bk.StandardOutput == "socket" && bk.StandardError == "journal";
            assert bk.PrivateNetwork && bk.RestrictAddressFamilies == [ "AF_UNIX" ] && bk.UMask == "0077";
            assert
              bk.TemporaryFileSystem == [ "/persist:ro" ]
              &&
                bk.BindPaths == [
                  "/persist/hosts"
                  "/persist/hosts-backup"
                ];
            assert
              lib.elem "-/run/whombat-backup" bk.InaccessiblePaths
              && lib.elem "-/run/credentials" bk.InaccessiblePaths;
            assert bkUnit.wantedBy == [ ] && !(sc ? StandardInput);
            assert lib.all (
              b:
              lib.elem "-/persist/hosts" b.serviceConfig.InaccessiblePaths
              && lib.elem "-/persist/hosts-backup" b.serviceConfig.InaccessiblePaths
            ) (backupUnits dev.systemd.services);
            assert lib.all (n: lib.elem "whombat-hosts-backup.socket" dev.systemd.services.${n}.wants) [
              "whombat-backup"
              "whombat-backup-api"
            ];
            assert lib.elem "-/persist/hosts"
              dev.systemd.services.whombat-backup-snapd.serviceConfig.InaccessiblePaths;
            assert
              !(lib.elem "-/persist/hosts-backup" dev.systemd.services.whombat-backup-snapd.serviceConfig.InaccessiblePaths);
            assert
              !(hw.systemd.sockets ? whombat-hosts-backup) && !(hw.systemd.services ? "whombat-hosts-backup@");
            assert lib.all (b: !(lib.elem "-/persist/hosts" b.serviceConfig.InaccessiblePaths)) (
              backupUnits hw.systemd.services
            );
            assert !(lib.elem "whombat-hosts-backup.socket" hw.systemd.services.whombat-backup.wants);
            # The agents' port: private networks only, nothing on this host (NX-138's rules).
            assert lib.hasInfix "ip saddr ${private4} tcp dport 8443 accept" inputRules;
            assert lib.hasInfix "ip6 saddr { fc00::/7, fe80::/10 } tcp dport 8443 accept" inputRules;
            assert !(lib.hasInfix "8443" hw.networking.firewall.extraInputRules);
            assert at "tcp dport 8443 ct state new jump hosts_agents" >= 0;
            assert lib.hasInfix (lib.concatStringsSep "\n  " [
              "chain hosts_agents {"
              ''iifname "lo" counter reject with icmpx admin-prohibited comment "hosts agents: not from this host"''
              "ip saddr ${private4} return"
              "ip6 saddr { fc00::/7, fe80::/10 } return"
              ''counter drop comment "hosts agents: private networks only"''
            ]) egress;
            # Its egress: before every other uid's rules, the resolver stub, then nothing else on this host, then the LAN.
            assert ordered [
              "meta skuid 965 jump hosts"
              ''oifname "lo" accept''
            ];
            assert lib.hasInfix (
              lib.concatStringsSep "\n  " [
                "chain hosts {"
                ''oifname "lo" ip daddr { 127.0.0.53, 127.0.0.54 } meta l4proto { tcp, udp } th dport 53 accept comment "resolver stub"''
                ''oifname "lo" counter reject with icmpx admin-prohibited comment "hosts: nothing on this host"''
                ''ip daddr @local4 ip daddr != 100.100.100.200 meta l4proto { tcp, udp } accept comment "the local network (hosts service)"''
                ''ip6 daddr @local6 ip6 daddr != fd00:ec2::254 meta l4proto { tcp, udp } accept comment "the local network (hosts service)"''
              ]
              + "\n}"
            ) egress;
            assert !(lib.hasInfix "skuid 965" hw.networking.nftables.tables.whombat-egress.content);
            pkgs.runCommand "hosts-config-check" { nativeBuildInputs = [ pkgs.jq ]; } ''
              test -x ${h.package}/bin/whombat-hosts
              # The backup's configuration: the hosts service's socket and its user where it runs (BK-32), nothing in
              # prod (whose checkpoints stay as they were, BK-35).
              jq -e '.hosts == {backupSocket: "/run/whombat-backup/hosts.sock", uid: 965, gid: 965}' "${configOf dev}"
              jq -e 'has("hosts") | not' "${configOf hw}"
              # The instance's script: the hub's own backup of /persist/hosts, kept under its name only when it is
              # complete, and the answer.
              script=${bk.ExecStart}
              grep -qF '${h.package}/bin/whombat-hosts backup --data /persist/hosts --out -' "$script"
              grep -qF 'mv -f -- "$tmp" "$dir/hub.tar.gz"' "$script"
              grep -qx 'echo ok' "$script"
              bash -n "$script"
              test -s ${dist}/whombat-agent-linux-amd64
              test -s ${dist}/whombat-agent-linux-arm64
              # Signed (NX-158): the hub offers agent self-update.
              test -s ${dist}/manifest.json
              # Outside the boot assessment (boot.nix): servers going quiet never roll an update back.
              if grep -q whombat-hosts ${assess}; then echo "the boot assessment names the hosts service"; exit 1; fi
              touch $out
            '';
          # The self-installed platform (PI-02, PI-10, PI-18, PI-19, PI-22; NX-50…NX-61, NX-90…): host-encrypted storage
          # by partlabel without LUKS or TPM units, lanzaboote with keys generated but not enrolled, self-provisioning
          # without Secure Boot and without a disk recovery key (only the unit that drops an earlier image's unconfirmed
          # one), the guest agent's allow-list, the drivers and watchdogs of dedicated machines and VMs (NX-189), and the
          # assertions: host-encrypted only on self-installed, no luks-tpm2 there, plain never prod, self-registration
          # in prod only on self-installed.
          self-installed-config =
            let
              c = self.nixosConfigurations.self-installed-prod.config;
              hw = self.nixosConfigurations.appliance-x86_64.config;
              failed =
                extra:
                map (a: a.message) (lib.filter (a: !a.assertion) (applianceFor system extra).config.assertions);
              has = infix: extra: lib.any (lib.hasInfix infix) (failed extra);
              pm = ./nix/profiles/self-installed.nix;
              pp = ./nix/profiles/prod-instance.nix;
              settings = cfg: cfg.environment.etc."whombat/self-provision.json".source;
              hwSelf = (applianceFor system [ { whombat.provisioning.selfRegister = true; } ]).config;
              ga = c.systemd.services.qemu-guest-agent.serviceConfig.ExecStart;
              # ONE-05: the GitHub repository's root and client channel keys, production's once the cutover commits them.
              rotated = ./manifest/prod/tuf-root.json;
              interimRoot = ./manifest/dev-instance/tuf-root.json;
              prodClients = ./manifest/prod/client-channel-keys.json;
              # Roots of made-up keys (no signatures: only the root role's threshold and keys are read at build time).
              rootOf =
                threshold: n:
                let
                  ids = lib.genList (i: "${toString i}${lib.fixedWidthString 63 "0" ""}") n;
                in
                builtins.toFile "root-${toString threshold}-of-${toString n}.json" (
                  builtins.toJSON {
                    signed = {
                      keys = lib.genAttrs ids (_: { keytype = "ed25519"; });
                      roles.root = {
                        keyids = ids;
                        inherit threshold;
                      };
                    };
                  }
                );
              withRoot = root: [
                pm
                pp
                { whombat.helper.tufRoot = lib.mkForce root; }
              ];
            in
            assert c.whombat.platform == "self-installed" && c.whombat.storage.mode == "host-encrypted";
            assert c.environment.etc."whombat/platform".text == "self-installed host-encrypted\n";
            assert hw.environment.etc."whombat/platform".text == "factory luks-tpm2\n";
            assert c.fileSystems."/".device == "/dev/disk/by-partlabel/whombat-root";
            assert
              c.fileSystems."/persist".device == "/dev/disk/by-partlabel/whombat-persist"
              && c.fileSystems."/persist".fsType == "btrfs";
            assert c.boot.initrd.luks.devices == { };
            assert !(c.systemd.services ? whombat-tpm-seal) && !(c.systemd.services ? whombat-tpm-reseal);
            assert
              !(c.systemd.paths ? whombat-tpm-reseal)
              && !(c.boot.initrd.systemd.services ? whombat-pcr-signature);
            assert hw.systemd.services ? whombat-tpm-seal;
            assert c.boot.lanzaboote.enable && c.boot.lanzaboote.bootCounting.initialTries == 3;
            assert !c.boot.lanzaboote.autoEnrollKeys.enable && !(c.systemd.services ? prepare-sb-auto-enroll);
            assert c.boot.lanzaboote.autoGenerateKeys.enable && hw.boot.lanzaboote.autoEnrollKeys.enable;
            assert
              !(c.systemd.paths ? whombat-recovery-key-confirm)
              && !(c.systemd.services ? whombat-recovery-key-confirm);
            assert lib.hasInfix "recovery-key drop-pending"
              c.systemd.services.whombat-recovery-key-drop.serviceConfig.ExecStart;
            assert
              c.systemd.services.whombat-recovery-key-drop.unitConfig.ConditionPathExists
              == "/persist/console/recovery-key.json";
            assert !(lib.hasInfix "recovery key" c.whombat.console.banner);
            assert
              lib.hasInfix "--allow-rpcs=" ga
              && !(lib.hasInfix "guest-exec" ga)
              && !(lib.hasInfix "guest-file" ga);
            # What the DEV image gave Home is the Whombat image's (NX-523): the hosts service and the Incus agent, which
            # starts only inside an Incus VM (NX-290: skipped elsewhere, not failed); no serial console line.
            assert c.whombat.hosts.enable && c.virtualisation.incus.agent.enable && !hw.virtualisation.incus.agent.enable;
            assert
              c.systemd.services.incus-agent.unitConfig.ConditionPathExists
              == "/dev/virtio-ports/org.linuxcontainers.incus";
            assert !(c.systemd.services ? whombat-dev-serial-console);
            # NX-524: no environment and no image names a repository for the merge re-run (Whombat AR-58): what every
            # box carries holds no company's own repository, and every repository has the runtime's default.
            assert !(c.whombat.runtime.environment ? WHOMBAT_MERGE_RERUN);
            assert lib.all (e: !(c.whombat.environments.${e}.runtime ? WHOMBAT_MERGE_RERUN)) [
              "dev"
              "prod"
            ];
            # NX-516: the own address follows the environment's zone; the image switches nothing on.
            assert lib.all (u: !(c.systemd.services.${u}.environment ? WHOMBAT_OWN_ADDRESS)) [
              "whombat-manager"
              "whombat-manager-recovery"
            ];
            # NX-520 (LNK-01a), ONE-02: the Whombat image carries production and, until Home has moved, the development
            # environment; a box is in production unless its file says otherwise, and nothing writes that file any more
            # (no bridge); the runtime and remote help follow the resolved environment.
            assert
              c.whombat.defaultEnvironment == "prod"
              && c.whombat.environmentBridge == null
              && c.whombat.environments ? prod
              && c.whombat.environments ? dev
              && c.whombat.link.possible;
            assert lib.elem "-/run/whombat/environment/runtime.env"
              c.systemd.services.whombat-server.serviceConfig.EnvironmentFile;
            assert
              !(lib.any (lib.hasInfix "environment set") (
                lib.toList c.systemd.services.whombat-environment.serviceConfig.ExecStart
              ));
            assert lib.elem "whombat-manager.service" c.systemd.services.whombat-environment.before;
            assert lib.hasInfix "--ca-keys /run/whombat/environment/support-ca.pub "
              c.systemd.services.whombat-support.serviceConfig.ExecStart;
            assert !(hw.environment.etc ? "whombat/environments.json");
            # ONE-03: a box still in the development environment keeps the Beta channel it followed by default (the
            # channel bridge, before either manager), never over a choice made; new boxes start on Production.
            assert
              let
                b = c.systemd.services.whombat-channel-bridge;
              in
              lib.hasInfix "set-channel development --if-unset" b.script
              && lib.hasInfix ''.name == "dev"'' b.script
              && lib.elem "whombat-environment.service" b.after
              && lib.all (u: lib.elem u b.before) [
                "whombat-manager.service"
                "whombat-manager-recovery.service"
              ]
              && b.unitConfig.ConditionPathExists == "/persist/whombat/environment.json";
            # LNK-24, ONE-02: every box takes its channel's newest from the GitHub repository, its layout in both manager
            # units' environment (an earlier known-good manager reads the same manager.json); channel, layout and
            # addresses only together.
            assert
              c.whombat.helper.defaultChannel == "production"
              && c.whombat.manager.tuf.targetsLayout == "github"
              && c.whombat.manager.tuf.metadataUrl == "https://releases.whombat.com/"
              && c.whombat.manager.tuf.targetsUrl == "https://github.com/CybexBV/whombat-releases/releases/download/";
            assert lib.all (u: c.systemd.services.${u}.environment.WHOMBAT_TUF_TARGETS_LAYOUT or null == "github") [
              "whombat-manager"
              "whombat-manager-recovery"
            ];
            # ONE-05: the rotated root once committed, the interim one (the chain's start, one online key) until then; a
            # production image refuses any other root that one root key alone can replace, and the interim root once it
            # isn't the one named.
            assert c.whombat.helper.tufRoot == (if builtins.pathExists rotated then rotated else interimRoot);
            assert
              c.whombat.clients.channelKeys == (
                if builtins.pathExists prodClients then
                  prodClients
                else
                  ./manifest/dev-instance/client-channel-keys.json
              );
            assert failed [
              pm
              pp
            ] == [ ];
            assert has "two root keys" (withRoot (rootOf 1 1));
            assert has "two root keys" (withRoot (rootOf 2 1));
            assert !(has "two root keys" (withRoot (rootOf 2 3)));
            assert has "two root keys" [
              pm
              pp
              { whombat.helper.interimRoot = lib.mkForce null; }
            ] == !(builtins.pathExists rotated);
            # A bridge that rolls back leaves the old repository's verified chain where the earlier manager and helper
            # keep it: the GitHub repository has folders of its own (manager.nix tufDir; the jq below reads the files).
            assert
              let
                tmp = c.systemd.tmpfiles.settings."20-whombat-manager";
                m = "${c.whombat.persistDir}/manager";
              in
              tmp ? "${m}/tuf/github/cache" && tmp ? "${m}/tuf/github/mirror" && tmp ? "${m}/tuf/cache";
            assert has "go together" [ { whombat.helper.defaultChannel = "development"; } ];
            assert has "go together" [
              {
                whombat.manager.tuf.targetsLayout = "github";
                whombat.manager.tuf.metadataUrl = "https://releases.example.com/";
                whombat.manager.tuf.targetsUrl = "https://github.com/example/releases/releases/download/";
              }
            ];
            assert has "the GitHub layout needs" [
              {
                whombat.helper.defaultChannel = "development";
                whombat.manager.tuf.targetsLayout = "github";
              }
            ];
            assert
              !(has "the GitHub layout needs" [
                {
                  whombat.helper.defaultChannel = "development";
                  whombat.manager.tuf.targetsLayout = "github";
                  whombat.manager.tuf.metadataUrl = "https://releases.example.com/";
                  whombat.manager.tuf.targetsUrl = "https://github.com/example/releases/releases/download/";
                }
              ]);
            # In production the Incus agent only with its virtio-port condition (NX-523).
            assert has "only inside an Incus VM" [
              pm
              {
                whombat.environment = "prod";
                virtualisation.incus.agent.enable = true;
              }
            ];
            assert
              !(has "only inside an Incus VM" [
                pm
                {
                  whombat.environment = "prod";
                  virtualisation.incus.agent.enable = true;
                  systemd.services.incus-agent.unitConfig.ConditionPathExists =
                    "/dev/virtio-ports/org.linuxcontainers.incus";
                }
              ]);
            assert lib.elem "virtio_scsi" c.boot.initrd.availableKernelModules;
            # HD-12 (NX-340): every image boots nixpkgs' newest stable kernel, the recovery environment too.
            assert lib.all
              (cfg: cfg.boot.kernelPackages.kernel.version == pkgs.linuxPackages_latest.kernel.version)
              [
                c
                hw
                self.nixosConfigurations.installer-prod.config
                self.nixosConfigurations.recovery-x86_64.config
              ];
            # NX-341: the servers' disk controllers and nixpkgs' “most hardware” list in the installed system's initrd.
            assert c.hardware.enableAllHardware && c.hardware.enableRedistributableFirmware;
            assert lib.all (m: lib.elem m c.boot.initrd.availableKernelModules) [
              "mpt3sas"
              "megaraid_sas"
              "hpsa"
              "smartpqi"
              "vmd"
            ];
            # NX-342: Wi-Fi without power saving, USB sticks switched to Wi-Fi, switched on at every start; the installer
            # too.
            assert lib.all
              (
                cfg:
                cfg.networking.wireless.iwd.settings.DriverQuirks.PowerSaveDisable == "*"
                && cfg.hardware.usb-modeswitch.enable
                && lib.elem "multi-user.target" cfg.systemd.services.whombat-wifi-on.wantedBy
              )
              [
                c
                self.nixosConfigurations.installer-prod.config
              ];
            # Installer and installed system share working secondary DNS, including when DHCP's server fails.
            assert lib.all
              (
                cfg:
                cfg.services.resolved.enable
                && lib.hasInfix "8.8.8.8" cfg.services.resolved.settings.Resolve.FallbackDNS
                && cfg.systemd.timers.whombat-dns-fallback.timerConfig.OnUnitInactiveSec == "15s"
              )
              [
                c
                self.nixosConfigurations.installer-prod.config
              ];
            assert self.nixosConfigurations.installer-prod.config.whombat.installer.espSize == "2G";
            # NX-509: the box's own domains on the installer's Wi-Fi as on the appliance's, and its DNS fallback knows them.
            assert lib.all
              (
                cfg:
                cfg.systemd.network.networks."91-whombat-wifi".domains == [ "~whombat.com" ]
                && cfg.systemd.services.whombat-dns-fallback.environment.WHOMBAT_OWN_DNS_DOMAINS == "whombat.com"
              )
              [
                c
                self.nixosConfigurations.installer-prod.config
              ];
            # NX-510: once the box is provisioned the hosts service starts with the manager and the runtime (it waits
            # for device.json at boot like them, but isn't part of the runtime target); a box without it starts none.
            assert
              lib.hasInfix "start whombat-manager.service whombat-runtime.target whombat-hosts.service"
                c.systemd.services.whombat-self-provision.script;
            assert
              lib.hasInfix "start whombat-manager.service whombat-runtime.target\n"
                hw.systemd.services.whombat-factory-provision.script
              && !(lib.hasInfix "whombat-hosts.service" hw.systemd.services.whombat-factory-provision.script);
            # NX-189: the watchdogs of machines and VMs on both platforms; the Intel TCO is skipped beside an i6300esb.
            assert lib.all
              (
                cfg:
                lib.all (m: lib.elem m cfg.boot.kernelModules) [
                  "i6300esb"
                  "iTCO_wdt"
                ]
                && !(lib.elem "iTCO_wdt" cfg.boot.blacklistedKernelModules)
                && lib.hasInfix "install iTCO_wdt /nix/store/" cfg.boot.extraModprobeConfig
              )
              [
                c
                hw
              ];
            assert
              c.whombat.helper.tufRoot != null
              && c.whombat.licence.keys != null
              && c.whombat.clients.channelKeys != null;
            assert failed [ pm ] == [ ];
            assert has "needs whombat.platform = \"self-installed\"" [
              { whombat.storage.mode = "host-encrypted"; }
            ];
            assert has "has no TPM" [
              pm
              { whombat.storage.mode = "luks-tpm2"; }
            ];
            assert has "never prod" [
              pm
              {
                whombat.storage.mode = "plain";
                whombat.environment = "prod";
              }
            ];
            assert has "selfRegister in prod" [
              {
                whombat.environment = "prod";
                whombat.provisioning.selfRegister = true;
              }
            ];
            assert
              !(has "selfRegister in prod" [
                pm
                {
                  whombat.environment = "prod";
                  whombat.provisioning.selfRegister = true;
                }
              ]);
            assert
              !(has "never prod" [
                pm
                { whombat.environment = "prod"; }
              ]);
            pkgs.runCommand "self-installed-config-check" { nativeBuildInputs = [ pkgs.jq ]; } ''
              # Every box makes its identity itself (LNK-01); its environment decides its env (LNK-01a).
              jq -e '.platform == "self-installed" and .requireSecureBoot == false and (has("luksDevices") | not)
                and .environment == "prod" and .controlUrl == "" and .environmentDir == "/run/whombat/environment"' ${settings c}
              jq -e '.v == 1 and .default == "prod" and .environments.dev.deviceEnv == "local"
                and .environments.dev.controlUrl == "https://api-dev.whombat.com" and .environments.dev.ownAddressZone == "dev.whombat.app"
                and .environments.dev.files["support-ca.pub"] == "/etc/whombat/environments/dev/support-ca.pub"
                and .environments.prod.deviceEnv == "prod" and .environments.prod.controlUrl == "https://api.whombat.com"
                and .environments.prod.ownAddressZone == "whombat.app"' ${c.environment.etc."whombat/environments.json".source}
              jq -e '.platform == "factory" and .requireSecureBoot == true and (has("luksDevices") | not)' ${settings hwSelf}
              # manager.json keeps to the keys the previous manager knows (LNK-24); the helper's channel (ONE-03).
              jq -e '(.tuf | keys - ["pinnedRoot", "metadataUrl", "targetsUrl", "cacheDir", "mirrorDir"]) == []
                and .tuf.metadataUrl == "https://releases.whombat.com/"' ${c.environment.etc."whombat/manager.json".source}
              jq -e '.defaultChannel == "production"' ${c.environment.etc."whombat/update-helper.json".source}
              # The GitHub repository verified in folders of its own (a bridge that rolls back keeps the old chain).
              jq -e '(.tuf.cacheDir | endswith("/manager/tuf/github/cache")) and (.tuf.mirrorDir | endswith("/manager/tuf/github/mirror"))' \
                ${c.environment.etc."whombat/manager.json".source}
              jq -e '(.mirrorDir | endswith("/manager/tuf/github/mirror")) and (.metadataDir | endswith("/tuf-github"))' \
                ${c.environment.etc."whombat/update-helper.json".source}
              touch $out
            '';
          # The community edition (Whombat HE-58, NX-445): one image, the edition decides what's in it. Evaluated; the
          # config files built and read. The install test (IN-430) is the end-to-end check.
          community-config =
            let
              c = self.nixosConfigurations.self-installed-community.config;
              d = self.nixosConfigurations.self-installed-prod.config;
              # An image without update channels (the factory's).
              hw = self.nixosConfigurations.appliance-x86_64.config;
              cp = ./nix/profiles/community-instance.nix;
              failed =
                extra:
                map (a: a.message) (lib.filter (a: !a.assertion) (selfInstalledFor system extra).config.assertions);
              has = infix: extra: lib.any (lib.hasInfix infix) (failed extra);
              etc = cfg: f: cfg.environment.etc."whombat/${f}".source;
              server = lib.concatStringsSep "\n" c.systemd.services.whombat-server.serviceConfig.Environment;
              egress = c.networking.nftables.tables.whombat-egress.content;
              rel = applianceRelease {
                env = "community";
                releaseId = "whombat-community-20261024.1";
                updatesUrl = "http://10.0.2.2:47081/";
                runtimeStamp = {
                  rev = "0123456789abcdef0123456789abcdef01234567";
                  time = 1767225600;
                  date = "20260101000000";
                };
              };
            in
            assert c.whombat.edition == "community" && d.whombat.edition == "commercial";
            assert c.whombat.environment == "dev" && c.whombat.platform == "self-installed";
            # No licence, remote help, Incus agent, console shell, hosts service or DEV serial line.
            assert c.whombat.licence.keys == null && !(c.environment.etc ? "whombat/licence-keys.json");
            assert
              !c.whombat.support.enable
              && !(c.systemd.services ? whombat-support)
              && !(c.environment.etc ? "whombat/support-ca.pub");
            assert
              !c.virtualisation.incus.agent.enable
              && !c.whombat.qualification.consoleShell
              && !c.whombat.hosts.enable;
            assert !(c.systemd.services ? whombat-dev-serial-console);
            # Its own trust: the community test repository's root and clients key; test keys, so never prod.
            assert
              builtins.readFile c.whombat.helper.tufRoot
              == builtins.readFile ./release-tools/fixtures/community-test/metadata/1.root.json;
            assert c.whombat.clients.channelKeys == ./manifest/community/client-channel-keys.json;
            assert has "trusts a development key" [
              cp
              { whombat.environment = lib.mkForce "prod"; }
            ];
            # The licence is inert (LNK-04): a key set is no longer refused or required anywhere.
            assert
              !(has "licence" [
                cp
                { whombat.licence.keys = ./manifest/dev-instance/licence-keys.json; }
              ]);
            # Remote help follows Whombat Link (LNK-07): an image whose boxes can't have it has none.
            assert !c.whombat.link.possible && d.whombat.link.possible;
            assert has "needs Whombat Link" [
              cp
              { whombat.support.enable = lib.mkForce true; }
            ];
            assert failed [ cp ] == [ ];
            # Tailscale on; tailscaled may reach a login server of the owner's own on the local network, on every box
            # (Tailscale is one of the two ways in, LNK-12).
            assert c.services.tailscale.enable && lib.hasInfix "owner's own login server" egress;
            assert lib.hasInfix "owner's own login server" d.networking.nftables.tables.whombat-egress.content;
            # The runtime and its CLI know the edition; a commercial box's environment doesn't change.
            assert lib.hasInfix "WHOMBAT_EDITION=community" server;
            # No hosted UI or Feedback drop: the box's own page is the app (Whombat HE-S202).
            assert
              c.whombat.runtime.appUrl == null
              && !(lib.hasInfix "WHOMBAT_APP_URL" server)
              && !(lib.hasInfix "WHOMBAT_EMBED_URL" server);
            # No claim card, licence or mail server set by the image; the console file and the master key as everywhere.
            assert !(lib.hasInfix "WHOMBAT_CLAIM_FILE" server) && !(c.whombat.runtime.credentials ? claim);
            assert !(lib.hasInfix "WHOMBAT_LICENCE" server) && !(lib.hasInfix "SMTP_URL" server);
            assert
              lib.hasInfix "WHOMBAT_CONSOLE_FILE=" server && lib.hasInfix "WHOMBAT_MASTER_KEY_FILE=" server;
            assert lib.hasInfix "WHOMBAT_CLAIM_FILE=%d/claim" (
              lib.concatStringsSep "\n" d.systemd.services.whombat-server.serviceConfig.Environment
            );
            assert
              !(lib.hasInfix "WHOMBAT_EDITION" (
                lib.concatStringsSep "\n" d.systemd.services.whombat-server.serviceConfig.Environment
              ));
            assert
              c.systemd.services.whombat-self-provision.description
              == "Provision this community appliance (its own identity)";
            assert !(c.systemd.paths ? whombat-self-reregister) && d.systemd.paths ? whombat-self-reregister;
            # A release: the community family, the ISO's name, the repository the install test serves.
            assert rel.environment == "dev" && rel.isoFile == "whombat-installer-community.iso";
            assert rel.appliance.config.whombat.manager.tuf.metadataUrl == "http://10.0.2.2:47081/metadata/";
            # The image reaches its own update repository's port (NX-445); the profile's address is on 443.
            assert lib.hasInfix "tcp dport { 443, 47081 } accept"
              rel.appliance.config.networking.nftables.tables.whombat-egress.content;
            assert lib.hasInfix "tcp dport { 443 } accept" egress;
            # NX-446: a factory tuple that wasn't recorded at the first start is recorded at a later one.
            assert lib.elem "|!/persist/manager/journal/journal.a.json"
              c.systemd.services.whombat-self-provision.unitConfig.ConditionPathExists;
            assert
              rel.appliance.config.whombat.provisioning.selfFactoryRelease == "whombat-community-20261024.1";
            pkgs.runCommand "community-config-check" { nativeBuildInputs = [ pkgs.jq ]; } ''
              jq -e '.edition == "community" and .control.url == "" and .licence == {} and .reregisterRequest == ""
                and (.clients.channelKeys | length > 0)' ${etc c "manager.json"}
              jq -e '.edition == "community"' ${etc c "update-helper.json"}
              jq -e '.edition == "community" and .controlUrl == "" and .platform == "self-installed"' ${etc c "self-provision.json"}
              jq -e '.edition == "community" and .appUrl == "" and .hosts.api == "" and .hosts.relay == ""' ${etc c "image.json"}
              grep -qx WHOMBAT_EDITION=community ${etc c "runtime.env"}
              # A commercial box's configuration names no edition: an older known-good manager still reads it.
              jq -e '(has("edition") | not) and .control.url != ""' ${etc d "manager.json"}
              jq -e 'has("edition") | not' ${etc d "update-helper.json"} ${etc d "self-provision.json"}
              # Without channels the old folders, and no metadataDir an earlier helper wouldn't know.
              jq -e '(has("metadataDir") | not) and (.mirrorDir | endswith("/manager/tuf/mirror"))' ${etc hw "update-helper.json"}
              jq -e '.tuf.cacheDir | endswith("/manager/tuf/cache")' ${etc hw "manager.json"}
              ! grep -q WHOMBAT_EDITION ${etc d "runtime.env"}
              touch $out
            '';
          # aarch64 is evaluated only: this forces evaluation of the whole configuration.
          eval-aarch64 = pkgs.writeText "eval-aarch64" (
            builtins.unsafeDiscardStringContext self.nixosConfigurations.appliance-aarch64.config.system.build.toplevel.drvPath
          );
          # Every installer ISO evaluated whole (NX-509): the checks above read parts of the installer's configuration
          # only, so an option the installer's modules use but don't import went unnoticed and no ISO could be built.
          eval-installers = pkgs.writeText "eval-installers" (
            lib.concatMapStringsSep "\n"
              (n: builtins.unsafeDiscardStringContext self.packages.${system}.${n}.drvPath)
              [
                "installer-iso-factory"
                "installer-iso-prod"
                "installer-iso-community"
              ]
          );
        };

      devShells = forAllSystems (
        system:
        let
          pkgs = (pkgsFor system).extend overlay;
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              go
              gopls
              nixfmt-rfc-style
              qemu
              swtpm
              sbctl
              cryptsetup
              librsvg
              jq
            ];
          };
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt-rfc-style);
    };
}
