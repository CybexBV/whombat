# The graphical installer's and console's web page (CG-01, CG-02): console/ui built with its own pinned pnpm
# dependencies (a fixed-output store, like the runtime bundle NX-66) into static files the local Go servers serve
# at `/`:
#
#   share/whombat-console-ui/index.html      the page (root-absolute /assets/… references)
#   share/whombat-console-ui/assets/         the hashed JS, CSS and the vendored fonts (no network at runtime)
#   share/whombat-console-ui/PIN             the whombat-app tag the avatars, tokens and fonts come from
#   share/whombat-console-ui/NOTICES.md      what the page contains and under which licence (React's MIT text)
#   share/whombat-console-ui/LICENSE[.md], THIRD_PARTY_NOTICES.md, OFL*.txt   whombat-app's licence and the fonts'
#
# The dev-only demo fixtures (`?demo=`) are not in the build (`import.meta.env.DEV` is false in `vite build`), and
# the install check fails if they are.
{
  lib,
  stdenvNoCC,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpm_12,
  nodejs-slim_24,
  sources,
  nixpkgsRev,
}:
let
  nodejs = nodejs-slim_24;
  pnpm = pnpm_12.override { nodejs-slim = nodejs; };
  root = ../../../console/ui;
  pkg = lib.importJSON (root + "/package.json");
  # Only what the build reads: no node_modules, dist or screenshots of a dev checkout.
  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/pnpm-lock.yaml")
      (root + "/pnpm-workspace.yaml")
      (root + "/index.html")
      (root + "/tsconfig.json")
      (root + "/vite.config.ts")
      (root + "/NOTICES.md")
      (root + "/src")
      (root + "/vendor")
    ];
  };
  inherit (sources.fixedEntry "consolePnpm") fetcherVersion;
  # The pnpm store for console/ui/pnpm-lock.yaml: its hash is in nix/fixed-hashes.json with the digest of the files
  # it was taken for, and its name carries that digest, so a changed lockfile is another store path that Nix must
  # fetch and compare (appliance/scripts/ci/fixed-hashes.sh --refresh consolePnpm).
  fixed = sources.fixedHash "consolePnpm" {
    files = map (f: "appliance/console/ui/${f}") [
      "package.json"
      "pnpm-lock.yaml"
      "pnpm-workspace.yaml"
    ];
    params = {
      nixpkgs = nixpkgsRev;
      fetcherVersion = toString fetcherVersion;
    };
  };
in
assert lib.assertMsg (lib.hasPrefix "pnpm@${pnpm.version}" pkg.packageManager)
  "pnpm ${pnpm.version} from nixpkgs is not console/ui's ${pkg.packageManager}";
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "whombat-console-ui";
  inherit (pkg) version;
  inherit src;

  pnpmDeps = fetchPnpmDeps {
    pname = "${finalAttrs.pname}-${fixed.tag}";
    inherit (finalAttrs) version src;
    inherit pnpm fetcherVersion;
    inherit (fixed) hash;
  };

  nativeBuildInputs = [
    nodejs
    pnpm
    pnpmConfigHook
  ];

  buildPhase = ''
    runHook preBuild
    pnpm exec tsc --noEmit
    pnpm exec vite build --outDir "$NIX_BUILD_TOP/dist" --emptyOutDir
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    d=$out/share/whombat-console-ui
    mkdir -p $d
    cp -r "$NIX_BUILD_TOP/dist/." $d/
    # whombat-app's licence: LICENSE from its releases after Whombat HE-63 (AGPL-3.0-only), LICENSE.md before.
    cp vendor/whombat-app/PIN vendor/whombat-app/LICENSE* vendor/whombat-app/THIRD_PARTY_NOTICES.md $d/
    cp vendor/whombat-app/fonts/OFL*.txt NOTICES.md $d/
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    d=$out/share/whombat-console-ui
    test -f $d/index.html
    # Served at `/`: the page's assets are root-absolute and exist.
    for a in $(grep -o '/assets/[^"]*' $d/index.html); do test -f "$d$a" || { echo "missing $a"; exit 1; }; done
    # Nothing from the network, no demo fixtures in the production bundle.
    if grep -rlE 'https?://(fonts\.|unpkg|cdn)' $d/index.html $d/assets/*.css; then echo "the page loads from the network"; exit 1; fi
    if grep -rlF -e 'installer-live' -e 'Console UI fixtures' -e 'desk-ask-locked' $d/assets; then echo "the demo fixtures are in the build"; exit 1; fi
    # ($NIX_BUILD_TOP alone is "/build", which the notices contain; these are the build's own directories.)
    if grep -rlF -e "$NIX_BUILD_TOP/source" -e "$NIX_BUILD_TOP/dist" $d; then echo "the page names a directory of the build"; exit 1; fi
    runHook postInstallCheck
  '';

  disallowedReferences = [
    nodejs
    pnpm
    finalAttrs.pnpmDeps
  ];

  meta = {
    description = "Whombat appliance's graphical installer and console page (static files)";
    platforms = lib.platforms.linux;
  };
})
