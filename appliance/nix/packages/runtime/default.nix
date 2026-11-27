# The real Whombat runtime bundle (PI-07, NX-20, NX-41…NX-44), built from this repository (narrow copies of it:
# nix/lib/sources.nix) with the workspace's own `pnpm bundle:runtime`:
#
#   bin/whombat-server   the server unit's entry point   (node app/server.mjs)
#   bin/whombat-runner   the runner unit's entry point   (node app/runner.mjs)
#   bin/whombat          the CLI; the helper runs `schema-check` / `migrate --json --env` with it (MD-10)
#   bin/whombat-agent-net  the commands' network daemon's entry point (node app/agent-net.mjs), when the source
#                        ships it (Whombat OP-07, I-4; NX-456)
#   app/                 esbuild bundles (server, runner, cli, image-worker)
#   migrations/  skills/  what the runtime reads from its release directory (WHOMBAT_APP_DIR, set by the bundles):
#                        the shipped skills by category since Whombat skill-store.md SST-03 (NX-406), `packs/` before
#   node_modules/node-pty  the sign-in console's PTY with its addon, built here with node-gyp (NX-37, MR-72)
#   node_modules/@1password  1Password's SDK with its WASM core, which the 1Password worker loads
#   web/                 the web app the direct listener serves to browsers on the local network and Tailscale (Whombat
#                        HE-50, NX-442): a link to `passthru.web`, built from apps/web in a derivation of its own whose
#                        source is only what that build reads, so a runtime update that doesn't change the web app
#                        downloads none of it again (delta updates). A Whombat from before the app moved into it
#                        vendors the app's release instead (`vendor/whombat-app/PIN`).
#   share/whombat/       bundle.json, the release manifest and the third-party notices
#   hermes               Hermes Agent with Whombat's plugin from this source (`hermes`: nix/packages/hermes, Whombat
#                        HU-04; NX-483): bin/whombat-runner runs exactly it (WHOMBAT_HERMES_BIN), so Hermes and the
#                        plugin move with every runtime release (a runner restart, the manager's go-back) and never with
#                        the host. Its store paths are shared with every runtime that has the same Hermes, so a runtime
#                        update downloads it only when it changed (delta updates).
#   bin/whombat-hermes-check  that Hermes's activation check (the host's whombat-hermes-check unit runs it, NX-484)
#
# The wrappers exec the pinned Node (the unit's main PID stays Node: its sd_notify and watchdog are that process's).
# Nothing of pnpm, the dependency store, node-gyp, Python or the compiler is in the closure (disallowedReferences).
#
# The stamp. A bundle says which commit it is and when that was committed: its version
# (`<package.json>-<commit time>.<short rev>`), `gitSha` in bundle.json, SOURCE_DATE_EPOCH. In one repository "this
# commit" is new with every change to anything, so the package never takes it by itself: a release is given its stamp
# (`stamp`: flake.nix `applianceRelease`'s `runtimeStamp`, chosen once by the release tools), and every other build
# (VM tests, `nix build .#whombat-runtime`) has the fixed one below and the version `<package.json>-0.dev`. The same
# files under the same stamp are then the same derivation, whatever commit they are built at.
#
# `fetchedWhombat` builds a fetched Whombat commit instead of this tree, whole, with that commit as its stamp: the
# migration tests' old runtime.
{
  lib,
  stdenv,
  stdenvNoCC,
  # This repository's narrow sources (nix/lib/sources.nix), and the nixpkgs revision the pnpm store was fetched with.
  sources,
  nixpkgsRev,
  # { rev; time; date; }: the commit, its time in seconds since 1970 and as UTC YYYYMMDDHHMMSS. null: no release.
  stamp ? null,
  # A fetched Whombat commit (`rev`, `lastModified`, `lastModifiedDate`) to build instead of this tree, and the hash
  # of that commit's pnpm store. Both come from the migration test's baseline (vm-tests/common/migration-baseline.nix).
  fetchedWhombat ? null,
  fetchedPnpmDepsHash ? null,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpm_12,
  nodejs-slim_24,
  node-gyp,
  python3,
  makeBinaryWrapper,
  gitMinimal,
  # Hermes Agent with Whombat's plugin (pkgs.whombat-hermes; NX-483), or null: a runtime without Hermes (a Whombat from
  # before it, as the migration tests' baseline).
  hermes ? null,
}:
let
  # The Node major Whombat requires (`engines.node` ">=24"), from the pinned nixpkgs; pnpm runs on the same Node.
  nodejs = nodejs-slim_24;
  pnpm = pnpm_12.override { nodejs-slim = nodejs; };
  fetched = fetchedWhombat != null;
  src = fetchedWhombat;
  # Where files are read while evaluating: the fetched commit, or this repository's root.
  tree = if fetched then "${src}" else sources.root;
  rootPkg = lib.importJSON (tree + "/package.json");
  releaseVersion = rootPkg.version;
  # A build that is no release: a fixed commit and time (2000-01-01 UTC; the bundler wants a time after 1970).
  devStamp = {
    rev = "0000000000000000000000000000000000000000";
    time = 946684800;
    date = "20000101000000";
  };
  given =
    if stamp != null then
      stamp
    else if fetched then
      {
        inherit (src) rev;
        time = src.lastModified;
        date = src.lastModifiedDate;
      }
    else
      null;
  theStamp = if given == null then devStamp else given;
  shortRev = builtins.substring 0 7 theStamp.rev;
  # `<package.json>-<commit time UTC YYYYMMDDHHMMSS>.<shortrev>` (NX-105, UP-A1): the version orders runtimes by
  # their stamp's time, where a bare `<package.json>-<shortrev>` compared revs as text. `<package.json>-0.dev` sorts
  # before every one of them.
  bundleVersion =
    if given == null then
      "${releaseVersion}-0.dev"
    else
      "${releaseVersion}-${theStamp.date}.${shortRev}${patchTag}";
  arch =
    {
      x86_64-linux = "x64";
      aarch64-linux = "arm64";
    }
    .${stdenv.hostPlatform.system};
  bundleName = "whombat-runtime-${releaseVersion}-linux-${arch}";

  # Fixes to apply on top of the source (NX-43). None: a fix is a commit of this repository.
  patches = [ ];
  # A patched bundle is other bytes than the commit's: its version says so (`.p<digest of the patches>`), so it never
  # takes a published `runtime/<version>/` target of the unpatched commit (NX-71, NX-77).
  patchTag = lib.optionalString (patches != [ ]) (
    ".p"
    + builtins.substring 0 7 (
      builtins.hashString "sha256" (lib.concatMapStrings builtins.readFile patches)
    )
  );

  # Whombat holds the apps and the contracts since whombat-app and whombat-contracts moved into it: the web app is built
  # from its source here. Before that it vendored the app's release (below), and the oldest sources have neither.
  appSource = builtins.pathExists (tree + "/apps/web/package.json");

  # The pnpm store: only what the runtime bundle and the web app need, so the mobile app's packages (Expo, React
  # Native) are never fetched. Whombats from before the apps moved in fetch their whole lockfile, as their pinned hashes
  # were taken.
  fetchedWorkspaces = lib.optionals appSource [
    "@whombat/package..."
    "@whombat/web..."
  ];
  pnpmWorkspaces = if fetched then fetchedWorkspaces else (sources.fixedEntry "runtimePnpm").pnpmWorkspaces;
  fetcherVersion = if fetched then 4 else (sources.fixedEntry "runtimePnpm").fetcherVersion;
  # This tree's store, fetched for the lockfile, the workspace's manifests and the patches and nothing else, so no
  # other change fetches it again. Its hash is in nix/fixed-hashes.json with the digest of exactly these inputs, and
  # its name carries that digest: a changed lockfile is then another store path, which Nix must fetch and compare,
  # where an old path of the same name would be reused unseen (appliance/scripts/ci/fixed-hashes.sh --refresh
  # runtimePnpm).
  fixed = sources.fixedHash "runtimePnpm" {
    files = sources.pnpmFiles;
    params = {
      nixpkgs = nixpkgsRev;
      fetcherVersion = toString fetcherVersion;
      pnpmWorkspaces = lib.concatStringsSep " " pnpmWorkspaces;
    };
  };
  pnpmDeps =
    if fetched then
      fetchPnpmDeps {
        pname = "whombat-runtime";
        version = bundleVersion;
        inherit
          src
          pnpm
          pnpmWorkspaces
          fetcherVersion
          ;
        # A fetched commit's store is the baseline's own (nothing ships it). This tree's is in nix/fixed-hashes.json.
        hash =
          if fetchedPnpmDepsHash != null then
            fetchedPnpmDepsHash
          else
            throw "nix/packages/runtime: no pnpm store hash for the fetched Whombat commit ${src.rev} (fetchedPnpmDepsHash)";
      }
    else
      fetchPnpmDeps {
        pname = "whombat-runtime-${fixed.tag}";
        src = sources.pnpm;
        inherit pnpm pnpmWorkspaces fetcherVersion;
        inherit (fixed) hash;
      };

  # The packages under packages/ that only the runtime uses: the web build never reads them, so a change to them
  # doesn't rebuild the web app.
  runtimeOnly = [
    "packages/agent-runtime"
    "packages/commands"
    "packages/hermes-whombat"
    "packages/node-io"
  ];
  # The files the web build reads: the workspace's manifests and lockfile, the patches, every workspace package's
  # package.json (pnpm installs from the whole workspace's lockfile), apps/web with the packages it can import,
  # without tests, browser suites or stories, and the changelog its What's new page shows.
  fetchedWebSource = builtins.path {
    name = "whombat-web-source";
    path = src;
    filter =
      path: type:
      let
        rel = lib.removePrefix "${toString src}/" (toString path);
        parts = lib.splitString "/" rel;
        depth = builtins.length parts;
        top = builtins.head parts;
        tree = lib.concatStringsSep "/" (lib.take 2 parts);
        name = baseNameOf rel;
        skipped =
          builtins.elem name [
            "node_modules"
            "dist"
            "dist-hosted"
            "test"
            "__tests__"
          ]
          || lib.hasPrefix "e2e-" name
          || builtins.match ".*\\.(test|spec|stories)\\.tsx?" name != null;
        webTree =
          tree == "apps/web" || tree == "tools/visual" || lib.hasPrefix "packages/" tree && !builtins.elem tree runtimeOnly;
      in
      if skipped then
        false
      else if depth == 1 then
        type == "directory"
        && builtins.elem top [
          "apps"
          "packages"
          "tools"
          "contracts"
          "scripts"
          "patches"
          "docs"
        ]
        || builtins.elem top [
          "package.json"
          "pnpm-workspace.yaml"
          "pnpm-lock.yaml"
          "tsconfig.base.json"
        ]
      else if top == "patches" then
        true
      else if top == "docs" then
        rel == "docs/changelog.md"
      else if depth == 2 then
        type == "directory"
      else if depth == 3 && name == "package.json" then
        true
      else
        webTree && rel != "apps/web/visual" && !lib.hasPrefix "apps/web/visual/" rel;
  };
  webSource = if fetched then fetchedWebSource else sources.web;
  appVersion = (lib.importJSON (tree + "/apps/web/package.json")).version;
  webFromSource = stdenv.mkDerivation {
    pname = "whombat-web";
    version = appVersion;
    src = webSource;
    inherit pnpmDeps;
    pnpmWorkspaces = [ "@whombat/web..." ];
    nativeBuildInputs = [
      nodejs
      pnpm
      pnpmConfigHook
    ];
    # The box's own page: it talks to the box's own origin, never to the fixtures. Without git the build id is the
    # version alone, so the output doesn't change with the commit.
    buildPhase = ''
      runHook preBuild
      VITE_FIXTURES= VITE_WHOMBAT_TARGET=box pnpm --filter @whombat/web build:prod
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      test -f apps/web/dist/index.html
      cp -r apps/web/dist $out
      runHook postInstall
    '';
    dontFixup = true;
    meta.description = "The web app ${appVersion} the Whombat runtime serves to direct browsers";
  };

  # A Whombat from before the app moved into it: `web/` of the whombat-app release it vendors
  # (`vendor/whombat-app/<PIN>/whombat-app-dist-<PIN>.tar.gz`, checked against its SHA256SUMS). Only that release's
  # directory is an input (builtins.path), so a commit that keeps the release builds the same store path.
  appPinFile = tree + "/vendor/whombat-app/PIN";
  appPin = lib.trim (builtins.readFile appPinFile);
  webLabel = if appSource then appVersion else appPin;
  web =
    if appSource then
      webFromSource
    else if !builtins.pathExists appPinFile then
      null
    else
      stdenvNoCC.mkDerivation {
        pname = "whombat-app-web";
        version = appPin;
        src = builtins.path {
          name = "whombat-app-${appPin}-release";
          path = tree + "/vendor/whombat-app/${appPin}";
        };
        dontConfigure = true;
        dontBuild = true;
        dontFixup = true;
        installPhase = ''
          runHook preInstall
          sha256sum -c SHA256SUMS
          mkdir "$NIX_BUILD_TOP/app"
          tar -xzf whombat-app-dist-${appPin}.tar.gz -C "$NIX_BUILD_TOP/app" web
          rm -f "$NIX_BUILD_TOP/app/web/.whombat-build"
          test -f "$NIX_BUILD_TOP/app/web/index.html"
          cp -r "$NIX_BUILD_TOP/app/web" $out
          runHook postInstall
        '';
        meta.description = "The whombat-app web build the Whombat runtime ${appPin} serves to direct browsers";
      };
in
assert lib.assertMsg (
  lib.versions.major pnpm.version == "12"
) "Whombat pins pnpm 12 (packageManager ${rootPkg.packageManager})";
assert lib.assertMsg (lib.hasPrefix "pnpm@${pnpm.version}" rootPkg.packageManager)
  "pnpm ${pnpm.version} from nixpkgs is not Whombat's ${rootPkg.packageManager}";
stdenv.mkDerivation (finalAttrs: {
  pname = "whombat-runtime";
  version = bundleVersion;
  src = if fetched then fetchedWhombat else sources.runtime;
  inherit patches;

  # Fixed-output: the pnpm store for pnpm-lock.yaml (every platform's optional packages, `--force`).
  inherit pnpmDeps;
  # Only the runtime bundle's packages are installed here; the web app's are installed in its own build.
  pnpmWorkspaces = lib.optionals appSource [ "@whombat/package..." ];

  nativeBuildInputs = [
    nodejs
    pnpm
    pnpmConfigHook
    # node-pty 1.1.0 has no Linux prebuilds: its addon is compiled here (NX-37). The compiler and make are stdenv's.
    node-gyp
    python3
    makeBinaryWrapper
  ];

  buildPhase = ''
    runHook preBuild

    # The same bytes as `pnpm bundle:runtime` in a checkout of the stamp's commit: its time, its sha. The Nix source
    # has no .git, so build.ts's three git questions are answered here, from the stamp; the tree is the commit plus
    # `patches` ("dirty" if any).
    export SOURCE_DATE_EPOCH=${toString theStamp.time}
    mkdir -p "$NIX_BUILD_TOP/git-shim"
    cat > "$NIX_BUILD_TOP/git-shim/git" <<'EOF'
    #!${stdenv.shell}
    case "$*" in
      "rev-parse HEAD") echo ${theStamp.rev} ;;
      "log -1 --format=%ct") echo ${toString theStamp.time} ;;
      "status --porcelain --untracked-files=no") ${
        lib.optionalString (patches != [ ]) "echo ' M patched'"
      } ;;
      *) echo "git shim: unexpected git $*" >&2; exit 1 ;;
    esac
    EOF
    chmod +x "$NIX_BUILD_TOP/git-shim/git"
    export PATH="$NIX_BUILD_TOP/git-shim:$PATH"

    # node-pty's addon against the pinned Node's headers (pnpmConfigHook installed with --ignore-scripts).
    pushd "$(readlink -f packages/agent-runtime/node_modules/node-pty)"
    node-gyp rebuild --nodedir=${nodejs}
    test -f build/Release/pty.node
    popd

    pnpm bundle:runtime --out "$NIX_BUILD_TOP/bundle"

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    b="$NIX_BUILD_TOP/bundle/${bundleName}"
    mkdir -p $out/bin $out/share/whombat
    cp -r "$b/app" "$b/migrations" "$b/node_modules" $out/
    # The shipped skills (`skills/<category>/<name>/`, Whombat SST-03): a managed server reads them only from its release
    # directory, so a runtime without them has none (NX-406). Runtimes before the skill store ship `packs/` instead.
    for d in skills packs; do
      if [ -d "$b/$d" ]; then cp -r "$b/$d" $out/; fi
    done
    if [ -d skills ] && [ ! -d $out/skills ]; then
      echo "the runtime bundle lacks the shipped skills (skills/, NX-406)" >&2
      exit 1
    fi
    # The embedded Postgres is the self-hosted CLI's (`whombat init`); the appliance has its own PostgreSQL 17
    # (NX-18) and never starts it. Its FHS binaries couldn't run here anyway.
    rm -rf $out/node_modules/@embedded-postgres
    # Kept for inspection; its file list still names the embedded Postgres removed above (NX-44).
    cp "$b/manifest.json" $out/share/whombat/release-manifest.json
    cp "$b/THIRD-PARTY-NOTICES.txt" $out/share/whombat/
    for f in LICENSE LICENSE.md NOTICE; do
      if [ -f "$b/$f" ]; then cp "$b/$f" $out/share/whombat/; fi
    done
    cat > $out/share/whombat/bundle.json <<EOF
    {"v":1,"kind":"runtime","version":"${releaseVersion}","gitSha":"${theStamp.rev}","patched":${
      lib.boolToString (patches != [ ])
    },"node":"${nodejs.version}","standIn":false,"web":${
      if web == null then "null" else ''"${webLabel}"''
    },"removed":["node_modules/@embedded-postgres"]}
    EOF
    # The web app for direct browsers (NX-442): the runtime finds it at $WHOMBAT_APP_DIR/web.
    ${lib.optionalString (web != null) "ln -s ${web} $out/web"}

    ${lib.optionalString (hermes != null) ''
      ln -s ${hermes} $out/hermes
      ln -s ${hermes}/bin/whombat-hermes-check $out/bin/whombat-hermes-check
    ''}
    # The entry points (NX-20). The units' PATH comes first (systemd-notify for sd_notify, MR-37); git is the
    # workspace manager's (agent-runtime workspace/), appended so it's always there.
    # The runner runs this bundle's Hermes and nothing else (NX-483): `--set`, so even a host that still names its own
    # (an image before NX-483) gets the one this runtime was built and tested with.
    for pair in whombat:cli whombat-server:server whombat-runner:runner; do
      hermesFlags=
      ${lib.optionalString (hermes != null) ''
        [ "''${pair%%:*}" != whombat-runner ] || hermesFlags="--set WHOMBAT_HERMES_BIN ${lib.getExe hermes}"
      ''}
      makeWrapper ${lib.getExe nodejs} $out/bin/''${pair%%:*} \
        --add-flags $out/app/''${pair##*:}.mjs \
        --suffix PATH : ${lib.makeBinPath [ gitMinimal ]} \
        $hermesFlags
    done
    # The agent's commands' network daemon (Whombat OP-07, I-4; NX-456), when the bundle has it: the whombat-agent-net
    # unit runs bin/whombat-agent-net from the profile; a runtime without it has none, and the unit is skipped.
    if [ -f $out/app/agent-net.mjs ]; then
      makeWrapper ${lib.getExe nodejs} $out/bin/whombat-agent-net --add-flags $out/app/agent-net.mjs
    fi

    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    # No path of the build sandbox in the output (the bundler checks its text files; this checks everything).
    # ($NIX_BUILD_TOP alone is "/build", which also matches "dist/build.js"; these are the build's own directories.)
    if grep -rlF -e "$NIX_BUILD_TOP/source" -e "$NIX_BUILD_TOP/bundle" -e "$STORE_PATH" -e "$HOME" $out; then
      echo "the bundle names a directory of the build"; exit 1
    fi
    # Every entry point gets past its imports to its own configuration check (MR-72, MR-76: before them all three
    # failed while loading), and the addon runs a PTY.
    HOME=$NIX_BUILD_TOP $out/bin/whombat --help | grep -q 'Usage: whombat'
    # The managed sandbox's shim, which the runner opens next to its bundle (Whombat MR-77, NX-77).
    test -f $out/app/shim.mjs
    ${lib.optionalString (web != null) "test -f $out/web/index.html"}
    (cd $NIX_BUILD_TOP && NODE_ENV=production WHOMBAT_MODE=managed $out/bin/whombat-server 2>&1 || true) \
      | tee server.out | grep -q 'Invalid server configuration' || { cat server.out; exit 1; }
    (cd $NIX_BUILD_TOP && RUNNER_TOKEN_FILE=runner-token $out/bin/whombat-runner 2>&1 || true) \
      | tee runner.out | grep -q 'Invalid runner configuration' || { cat runner.out; exit 1; }
    ${lib.optionalString (hermes != null) ''
      grep -qF 'WHOMBAT_HERMES_BIN' $out/bin/whombat-runner
      grep -qF '${lib.getExe hermes}' $out/bin/whombat-runner
      test -x $out/bin/whombat-hermes-check
    ''}
    # 1Password's SDK compiles its WASM core as it loads, from beside itself; nothing is requested.
    (cd $out && ${lib.getExe nodejs} --input-type=module -e "await import('@1password/sdk')")
    (cd $out && ${lib.getExe nodejs} --input-type=module -e "
      const m = await import('node-pty');
      const t = m.spawn('${stdenv.shell}', ['-c', 'echo pty-ok'], {});
      let out = String(); t.onData((d) => { out += d; });
      t.onExit(() => { if (!out.includes('pty-ok')) { console.error('pty:', out); process.exit(1); } process.exit(0); });
    ")
    runHook postInstallCheck
  '';

  # Build-only inputs must not leak into the closure.
  disallowedReferences = [
    pnpm
    python3
    node-gyp
    finalAttrs.pnpmDeps
  ];

  passthru = {
    inherit nodejs web hermes;
    # The stamp this bundle carries, and whether it was given one (a release's, or a fetched commit's own).
    stamp = theStamp;
    stamped = given != null;
    whombatRev = theStamp.rev;
    # The whole Whombat tree this bundle is of, for what reads its files while evaluating (the schema, the Hermes
    # pin): this repository's root, or the fetched commit.
    inherit tree;
    whombatStandIn = false;
  };

  meta = {
    description = "Whombat runtime bundle (server, runner, CLI) for the managed appliance";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
    mainProgram = "whombat";
  };
})
