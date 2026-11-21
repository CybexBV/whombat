# Stand-ins for the cloud side: the fake control (devices.register, contracts 0.4.0) on :4600 and a
# static server for the DEVELOPMENT TUF fixtures (release-tools/fixtures/dev, W1-MG) on :8080.
{ pkgs, ... }:
{
  networking.firewall.allowedTCPPorts = [
    4600
    8080
  ];
  environment.etc."whombat-fake-control/token".text = "dev-station-token-for-vm-tests-only";
  systemd.services.fake-control = {
    wantedBy = [ "multi-user.target" ];
    serviceConfig.ExecStart = "${pkgs.whombat-provision}/bin/whombat-fake-control --listen 0.0.0.0:4600 --token-file /etc/whombat-fake-control/token --env dev";
  };
  systemd.services.tuf-fixtures = {
    wantedBy = [ "multi-user.target" ];
    serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server 8080 --directory ${../../release-tools/fixtures/dev}";
  };
}
