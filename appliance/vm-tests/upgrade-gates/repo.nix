# The gates' update repository (NX-112): what a box of today's image reads. A box learns of a release only from its
# channel, in the GitHub repository's layout, so the gates serve one made the way the real one was: the committed
# development fixture repository (release-tools/fixtures, its DEVELOPMENT keys and pinned root) continued as a GitHub
# repository (`tufrepo gh-continue`: the next root, the channel roles, the snapshot and timestamp keys set aside for the
# workflow's step), and every gate release published into the development channel (Beta, where a
# candidate goes first, and the one channel whose key stays with the publisher) by the release tools, the way a release
# reaches a box: `tufrepo export-release` (a closure index per component with the compressed NAR of every path, NAR
# hashes and closure sizes read from the store) and `tufrepo publish-release --channel` (verifies the directory again
# from its bytes and signs it into the channel, as `gh-publish` does before it uploads).
#
# A box takes the newest release its channel lists, so each gate has a channel history of its own: its `chain`, a list
# of steps, each the releases that become visible together. The build publishes them in order and keeps the role
# metadata after every step; the gate's control node serves step 0 before the box starts and the next step when the
# test says a release is published (./nodes.nix). The files are there from the start, as on GitHub, where a release's
# files go up before its metadata. Blobs are written once and shared by the gates. Built once per candidate and cached.
#
# Indexes and blobs are real, downloaded (what the box lacks) and imported by the box's own manager and helper, except
# the hosts of the previous releases: the box boots them from its disk, so nothing downloads them, and their host index
# is a placeholder (`tufrepo add-index`, no blob; as in update-migration) under a runtime-only publish of the release.
#
#   exportRelease { name, tuple, reuseHost ? false }   the export-release directory of one tuple
#   repository { <gate> = [ [ { name, tuple, placeholderHost ? false, reuseHost ? false } … ] … ]; … }
#       $out/gates/<gate>/targets        what the gate's file server serves (nar → $out/nar)
#       $out/gates/<gate>/<step>/        the metadata folder after that step
#       $out/offline                     the snapshot and timestamp keys, for the workflow's step
#       $out/tuples/<name>.json          each tuple as it was exported
#
# `tuple` is a release tuple whose store paths are the gate's (host, manager, runtime); NAR hashes are computed here.
# Its id is a channel's: `whombat-YYYYMMDD.N` or `whombat-dev-YYYYMMDD.N`, later than the ids before it in its chain.
{
  pkgs,
  lib,
  # The release tools (tufrepo) that export and sign.
  tools,
}:
let
  fixtures = ../../release-tools/fixtures;
  channel = "development";

  # The template export-release takes: host and manager NAR hashes computed from the store paths (a runtime-only
  # release must carry them; export-release checks them against the store otherwise), the runtime's filled in there.
  template =
    name: tuple:
    pkgs.runCommand "whombat-gate-tuple-${name}.json"
      {
        nativeBuildInputs = [
          pkgs.jq
          pkgs.nix
        ];
        tuple = builtins.toJSON tuple;
        passAsFile = [ "tuple" ];
      }
      ''
        hostNar=sha256:$(nix-hash --type sha256 --base16 ${tuple.host.storePath})
        mgrNar=sha256:$(nix-hash --type sha256 --base16 ${tuple.manager.storePath})
        jq --arg h "$hostNar" --arg m "$mgrNar" '.host.narHash = $h | .manager.narHash = $m | .runtime.narHash = ""' \
          "$tuplePath" > $out
      '';
in
rec {
  inherit template tools channel;

  exportRelease =
    {
      name,
      tuple,
      reuseHost ? false,
    }:
    pkgs.runCommand "whombat-gate-export-${name}"
      {
        nativeBuildInputs = [
          pkgs.nix
          tools
        ];
        # A private Nix database of the closures (as make-disk-image does): export-release reads the closures and their
        # NARs through it; the store paths themselves are this build's inputs.
        closure = pkgs.closureInfo {
          rootPaths = [ tuple.runtime.storePath ] ++ lib.optional (!reuseHost) tuple.host.storePath;
        };
      }
      ''
        export NIX_STATE_DIR=$TMPDIR/state NIX_REMOTE=
        nix-store --load-db < $closure/registration
        mkdir -p $out
        tufrepo export-release --out $out/release --template ${template name tuple} \
          ${lib.optionalString reuseHost "--reuse-host"} --nix-store ${pkgs.nix}/bin/nix-store --nix ${pkgs.nix}/bin/nix \
          --nar-cache $TMPDIR/nar > $out/tuple.json
      '';

  repository =
    chains:
    let
      publish =
        r:
        let
          ex = exportRelease {
            inherit (r) name tuple;
            reuseHost = r.placeholderHost or false || r.reuseHost or false;
          };
          h = r.tuple.host;
        in
        lib.optionalString (r.placeholderHost or false) ''
          printf '{"placeholder":true,"release":"%s","storePath":"%s"}\n' ${r.tuple.releaseId} ${h.storePath} > $TMPDIR/placeholder
          tufrepo add-index --dir $repo --channel ${channel} --kind host --target host/${h.version}/whombat-host.index.json \
            --file $TMPDIR/placeholder --version ${h.version} --store-path ${h.storePath} \
            --nar-hash "$(jq -r .host.narHash ${ex}/tuple.json)" --manager-store-path ${r.tuple.manager.storePath} > /dev/null
        ''
        + ''
          echo "== ${r.name}: ${r.tuple.releaseId}"
          tufrepo publish-release --dir $repo --channel ${channel} --release-dir ${ex}/release > $TMPDIR/published.json
          jq -c '{releaseId, added, reused, blobsAdded, blobsReused, bytesAdded}' $TMPDIR/published.json
          [ -e $out/tuples/${r.name}.json ] || cp ${ex}/tuple.json $out/tuples/${r.name}.json
        '';
      step = i: releases: ''
        echo "= step ${toString i}"
        ${lib.concatMapStrings publish releases}
        cp -r $repo/metadata $gate/${toString i}
      '';
      chain = gate: steps: ''
        echo "=== gate ${gate}"
        gate=$out/gates/${gate}
        repo=$TMPDIR/gate-${gate}
        mkdir -p $gate
        cp -r $TMPDIR/base $repo
        ln -s $out/nar $repo/targets/nar
        ${lib.concatStrings (lib.imap0 step steps)}
        rm $repo/targets/nar
        cp -r $repo/targets $gate/targets
        ln -s ../../../nar $gate/targets/nar
      '';
    in
    pkgs.runCommand "whombat-gate-repository"
      {
        nativeBuildInputs = [
          tools
          pkgs.jq
        ];
      }
      ''
        mkdir -p $out/tuples $out/nar $out/gates $TMPDIR/fixtures/dev
        cp -r ${fixtures}/dev/repo $TMPDIR/fixtures/dev/repo
        cp -r ${fixtures}/dev-keys $TMPDIR/fixtures/dev-keys
        chmod -R u+w $TMPDIR/fixtures
        # The keys a publish signs with stay in this build; the workflow's two are kept for the control node.
        tufrepo gh-continue --from $TMPDIR/fixtures/dev/repo --out $TMPDIR/base --keys-dir $TMPDIR/keys \
          --offline-keys-dir $TMPDIR/offline > /dev/null
        rm -f $TMPDIR/base/.lock
        mkdir $out/offline
        cp $TMPDIR/offline/snapshot.json $TMPDIR/offline/timestamp.json $out/offline/
        ${lib.concatStrings (lib.mapAttrsToList chain chains)}
        chmod -R a+rX $out
      '';
}
