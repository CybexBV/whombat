# Stand-ins for the runtime and manager (VM tests only; refused for prod by the modules).
{
  lib,
  buildGoModule,
  postgresql_17,
  version ? "standin-1",
}:
buildGoModule {
  pname = "whombat-standins";
  inherit version;
  src = lib.cleanSource ./.;
  vendorHash = null;
  env.CGO_ENABLED = "0";
  ldflags = [
    "-s"
    "-w"
    "-X main.version=${version}"
    "-X main.psql=${postgresql_17}/bin/psql"
  ];
  meta.description = "Whombat runtime/manager stand-ins for VM tests";
}
