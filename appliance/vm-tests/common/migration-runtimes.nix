# Real runtime bundles for the migration tests (update-migration, restore-drill; NX-103, NX-115, NX-116):
#
#   old              the baseline's Whombat (./migration-baseline.nix: a Git address, a commit and its pnpm store's
#                    hash, or none). The maintainers' is candidate 0.268.0, the bridge, schema 77 (0076_trackers): the
#                    release that has the pin's floors (IN-763). 0076_trackers is incompatible (readers and writers
#                    77), so no older release reads or writes the pin's schema, and from one (schema 62, IN-753) every
#                    update rightly waits for a checkpoint. Its version is set to 0.0.1-<short commit> so the tests
#                    don't depend on how commit hashes sort. Only update-migration builds it; without a baseline
#                    that test isn't among the checks (../default.nix).
#   new              this tree's runtime; its schema check reports target floors (MD-12).
#   bad              its own store path over the new bundle's entries, published under a version it doesn't report:
#                    it migrates like `new`, activates and fails verification.
#   badExpanded      the same over the expanded bundle: it migrates like `expanded` (update-migration's step 2 when
#                    the old runtime's schema is the pin's).
#   expanded         the pin plus one synthetic `expand` migration (floors: the pin's schema, so the pin's binary
#                    reads and writes it).
#   contracted       the pin plus that expand and a synthetic `contract` migration (readers: the expand, writers: itself).
#   contractFailing  the pin plus a `contract` migration whose SQL fails (all pending migrations apply in one
#                    transaction, so the database stays as it was): a checkpoint is taken, then the migration fails.
#
# Synthetic migrations are added in postPatch: journal entry, SQL and compat.json entry, the binary's own needs moved to
# the last one. Labels order the versions along the chain (`<pin version>.m1expand` < `.m2contract`).
{
  pkgs,
  lib,
  releaseRuntime,
  # The Whombat runtime package the runtimes are made from (its pin): the tree's own, or a candidate's (upgrade gates).
  runtime ? pkgs.whombat-runtime,
}:
let
  version =
    v: drv:
    drv.overrideAttrs {
      version = v;
      __intentionallyOverridingVersion = true;
      inherit (drv) pnpmDeps; # the same pnpm store (its name follows the version otherwise)
    };
  # A schema version is the chain's schemaBase plus a migration's position (release/schema-numbers): the cut's chain
  # starts with one baseline that stands for the 76 migrations before it.
  schemaOf =
    src:
    let
      d = src + "/apps/server/src/db/migrations";
    in
    ((lib.importJSON (d + "/compat.json")).schemaBase or 0)
    + lib.length (lib.importJSON (d + "/meta/_journal.json")).entries;
  # The release to update from; only `old` and `oldSchema` ask for it.
  baseline =
    let
      b = import ./migration-baseline.nix;
    in
    if b == null then
      throw "vm-tests: no migration baseline (vm-tests/common/migration-baseline.json is empty and WHOMBAT_MIGRATION_BASELINE names none)"
    else
      b;
  oldBase = runtime.override (
    {
      fetchedWhombat = builtins.fetchGit {
        inherit (baseline) url rev;
        ref = baseline.ref or "main";
      };
    }
    # A runtime package from before the baseline was a file (a candidate's, in the upgrade gates) knows the hash of its
    # baseline's store itself and takes no other.
    // lib.optionalAttrs ((lib.functionArgs runtime.override) ? fetchedPnpmDepsHash) {
      fetchedPnpmDepsHash = baseline.pnpmDepsHash;
    }
  );
  withMigrations =
    label: migrations:
    releaseRuntime (runtime.overrideAttrs (o: {
      inherit (o) pnpmDeps;
      nativeBuildInputs = o.nativeBuildInputs ++ [ pkgs.jq ];
      postPatch =
        (o.postPatch or "")
        + lib.concatMapStrings (
          m:
          let
            # An expand keeps older binaries writing (the writer floor stays the previous schema), a contract doesn't.
            writers = if m.class == "expand" then "$prev" else "$tag";
          in
          ''
            d=apps/server/src/db/migrations
            prev=$(jq -r '.entries[-1].tag' $d/meta/_journal.json)
            tag=$(printf '%04d_${m.name}' "$(jq '.entries | length' $d/meta/_journal.json)")
            printf '%s\n' ${lib.escapeShellArg m.sql} > $d/$tag.sql
            jq --arg tag "$tag" '.entries += [{idx: (.entries | length), version: "7", when: (.entries[-1].when + 1000),
              tag: $tag, breakpoints: true}]' $d/meta/_journal.json > journal.json
            mv journal.json $d/meta/_journal.json
            jq --arg tag "$tag" --arg prev "$prev" '.migrations[$tag] = {class: "${m.class}", readers: $prev,
              writers: ${writers}} | .runtime = {readsFrom: $tag, writesFrom: $tag}' \
              $d/compat.json > compat.json
            mv compat.json $d/compat.json
          ''
        ) migrations;
    })) label;
  expand = {
    name = "vmtest_expand";
    class = "expand";
    sql = ''CREATE TABLE "vmtest_expand" ("id" integer);'';
  };
  contract = {
    name = "vmtest_contract";
    class = "contract";
    sql = ''CREATE TABLE "vmtest_contract" ("id" integer);'';
  };
  failing = {
    name = "vmtest_contract_fails";
    class = "contract";
    sql = ''
      CREATE TABLE "vmtest_contract_fails" ("id" integer);
      --> statement-breakpoint
      SELECT 1 / 0;'';
  };
  # A bundle's own store path over its entries: published under a version it doesn't report, it migrates like the
  # bundle, activates and fails verification.
  badOf =
    b:
    pkgs.runCommand "whombat-runtime-${b.version}-bad" { } ''
      mkdir $out
      for f in ${b}/*; do ln -s "$f" $out/; done
    '';
in
rec {
  old = releaseRuntime (version "0.0.1-${builtins.substring 0 7 baseline.rev}" oldBase) null;
  new = releaseRuntime runtime null;
  bad = badOf new;
  badExpanded = badOf expanded;
  expanded = withMigrations "m1expand" [ expand ];
  contracted = withMigrations "m2contract" [
    expand
    contract
  ];
  contractFailing = withMigrations "m3failing" [ failing ];
  # The pin's schema, and so the synthetic ones': expanded S+1, contracted S+2, contractFailing S+1.
  schema = schemaOf runtime.passthru.tree;
  # The old runtime's schema.
  oldSchema = schemaOf oldBase.passthru.tree;
}
