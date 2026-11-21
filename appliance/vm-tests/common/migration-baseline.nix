# The release the migration test updates from (update-migration; gate 5 of the upgrade gates):
# `{ url, rev, pnpmDepsHash }`, or null when there is none. `url` is a Git address, `rev` a commit of it that holds a
# Whombat tree (on `ref`, default main), `pnpmDepsHash` the hash of that commit's pnpm store, as nix/packages/runtime
# fetches it.
#
# It is migration-baseline.json beside this file. That file is empty: this repository has no release of its own to
# migrate from yet, so the test isn't among the checks, and nothing here names an address a reader can't reach. Once
# such a release exists, an ordinary commit writes it there.
#
# Until then the maintainers' own CI tests the migration from a release made before the repository was published:
# WHOMBAT_MIGRATION_BASELINE names a file of the same shape outside the repository. Only an evaluation that may read
# its surroundings sees it (`nix … --impure`); every other reads the variable as empty and so the file here.
let
  named = builtins.getEnv "WHOMBAT_MIGRATION_BASELINE";
  file = if named != "" then /. + named else ./migration-baseline.json;
  baseline = builtins.fromJSON (builtins.readFile file);
in
if baseline ? rev then baseline else null
