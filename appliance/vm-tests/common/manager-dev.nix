# Point the real manager and helper at the test control and the development TUF fixtures. Every key
# behind them is a development key (release-tools/fixtures/README.md).
{ ... }:
{
  whombat.manager.controlUrl = "http://control:4600";
  whombat.manager.tuf = {
    metadataUrl = "http://control:8080/valid/metadata/";
    targetsUrl = "http://control:8080/valid/targets/";
  };
  whombat.manager.reserveBytes = 16 * 1024 * 1024;
  whombat.helper.tufRoot = ../../release-tools/fixtures/dev/pinned-root.json;
  # The TEST licence key set (env test, kid lic-test-1; its seed sha256("whombat/test-licence-key/1") is public,
  # the runtime's managed/__fixtures__/licence-keys.json). Never a real key (LC-04, NX-38).
  whombat.licence.keys = ./licence-keys.test.json;
  whombat.network.outboundTcpPorts = [
    443
    4600
    8080
  ];
}
