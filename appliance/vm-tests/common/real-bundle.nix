# Opt a VM test's appliance nodes into the real runtime bundle (NX-47, NX-49): appended to `applianceModules` by the
# `*-real-runtime` variants in ../default.nix. Node server and runner next to PostgreSQL and the manager want more
# memory than the stand-in; a test that sets its own size keeps it.
{ lib, pkgs, ... }:
{
  whombat.runtime.package = lib.mkForce pkgs.whombat-runtime;
  virtualisation.memorySize = lib.mkOverride 999 3072;
}
