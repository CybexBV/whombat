# Runtime bundle layout (NX-20) filled with the stand-in: bin/whombat-server and bin/whombat-runner.
{
  callPackage,
  runCommand,
  version ? "standin-1",
}:
let
  standins = callPackage ../standins { inherit version; };
in
runCommand "whombat-runtime-${version}"
  {
    passthru = {
      whombatStandIn = true;
      inherit version;
    };
  }
  ''
    mkdir -p $out/bin $out/share/whombat
    ln -s ${standins}/bin/standin-runtime $out/bin/whombat-server
    ln -s ${standins}/bin/standin-runtime $out/bin/whombat-runner
    echo '{"v":1,"kind":"runtime","version":"${version}","standIn":true}' > $out/share/whombat/bundle.json
  ''
