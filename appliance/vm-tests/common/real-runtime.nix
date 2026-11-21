# The real runtime bundle in VM tests (PI-08, NX-47, NX-48).
#
#   machine    appliance module: `whombat.runtime.package` = the real bundle (pkgs.whombat-runtime), TUF from the
#              control node's republished repository below. Import it next to ./appliance-vm.nix.
#   control    control module: the fake control of ./control.nix plus, instead of the static fixtures, the development
#              fixture repository (release-tools/fixtures/dev/repo, its committed DEVELOPMENT keys) republished at
#              boot with one more release, `rt-real-1`, whose runtime is the real bundle. Republished in the VM so
#              its metadata is fresh (a timestamp signed at build time would expire in a day). The pinned root stays
#              the fixtures' root v1 (./manager-dev.nix).
#
# `rt-real-1` is rt-fixture-1's tuple with the real bundle as its runtime (store path, NAR hash, version, the
# bundle's schema version) and no providers. Its runtime index is a placeholder (`tufrepo add-index`, no blob): the
# bundle is in the VM's store already, so nothing downloads or stages it.
{ pkgs, lib }:
let
  runtime = pkgs.whombat-runtime;
  fixtures = ../../release-tools/fixtures;
  release =
    pkgs.runCommand "whombat-real-runtime-release"
      {
        nativeBuildInputs = [
          pkgs.jq
          pkgs.nix
        ];
      }
      ''
        mkdir $out
        nar=sha256:$(nix-hash --type sha256 --base16 ${runtime})
        schema=$(bash ${../../release/schema-numbers} ${runtime}/migrations/compat.json ${runtime}/share/whombat/release-manifest.json | cut -d' ' -f2)
        jq --arg sp ${runtime} --arg nar "$nar" --arg v ${runtime.version} --argjson s "$schema" '
          .releaseId = "rt-real-1"
          | .runtime.storePath = $sp | .runtime.narHash = $nar | .runtime.version = $v
          | .runtime.schemaWrites = $s | .runtime.schemaReads = {min: $s, max: $s}
          | .providers = []' ${fixtures}/dev/valid/targets/releases/*.rt-fixture-1.json > $out/tuple.json
        echo "$nar" > $out/nar-hash
        printf '{"placeholder":true,"storePath":"%s"}\n' ${runtime} > $out/artifact
      '';
  repoDir = "/srv/tuf/fixtures/dev/repo";
in
{
  inherit runtime release repoDir;
  releaseId = "rt-real-1";

  machine = {
    whombat.runtime.package = runtime;
    whombat.manager.tuf = {
      metadataUrl = lib.mkForce "http://control:8080/metadata/";
      targetsUrl = lib.mkForce "http://control:8080/targets/";
    };
    # Node server and runner next to PostgreSQL and the manager.
    virtualisation.memorySize = 3072;
  };

  control = {
    imports = [ ./control.nix ];
    environment.systemPackages = [ pkgs.whombat-release-tools ];
    systemd.services.tuf-fixtures.enable = lib.mkForce false;
    systemd.services.tuf-real = {
      wantedBy = [ "multi-user.target" ];
      path = [
        pkgs.coreutils
        pkgs.whombat-release-tools
      ];
      preStart = ''
        set -eu
        rm -rf /srv/tuf
        mkdir -p /srv/tuf/fixtures/dev
        cp -r ${fixtures}/dev/repo ${repoDir}
        cp -r ${fixtures}/dev-keys /srv/tuf/fixtures/dev-keys
        chmod -R u+w /srv/tuf
        tufrepo add-index --dir ${repoDir} --kind runtime \
          --target runtime/${runtime.version}/whombat-runtime.index.json --file ${release}/artifact \
          --version ${runtime.version} --store-path ${runtime} --nar-hash "$(cat ${release}/nar-hash)"
        tufrepo add-release --dir ${repoDir} --tuple ${release}/tuple.json
      '';
      serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server 8080 --directory ${repoDir}";
    };
  };
}
