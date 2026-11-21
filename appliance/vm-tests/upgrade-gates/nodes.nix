# The gates' two nodes (NX-110). Node names order the test network (nixos/lib/testing/network.nix numbers nodes by
# name): `box` is 192.168.1.1 and `control` 192.168.1.2, as ./gate-env.nix has them.
#
#   control  the fake control on :4600 (a box that turns Link on would register there; the gates' boxes don't), the
#            gate repository (./repo.nix) over HTTPS the way GitHub serves the real one, and the box's backup place, a
#            restic rest-server on :8000. Three names, one certificate (./tls.nix):
#              the Pages site      the role metadata of the step the gate is at, at the site's root
#              github.com          a release download answers with a redirect to the storage
#              the storage         the files, with Range: a release's tuple and indexes under its id, a blob under its
#                                  bucket (nar-xx), all served from the store
#            `gate-serve <gate>` picks the gate's channel history, `gate-publish <step>` makes its next step visible:
#            the role files of that step, then snapshot and timestamp signed as the repository's workflow signs them
#            (`tufrepo gh-resign`; what the build signed expires within days).
#   box      a VM with install.md's settings (q35, OVMF with Secure Boot in setup mode, no TPM, the disk on virtio-scsi,
#            the i6300esb watchdog) that boots a copy-on-write overlay of a release's installed disk (./image.nix) from
#            $WB_BOX_DISK. The node's own configuration only makes QEMU's command line: what boots is the disk.
{ pkgs, lib }:
{
  repo,
  # tufrepo on the control node (the workflow's step): the release tools the repository was made with.
  tools,
  boxMemory ? 4096,
}:
let
  tls = import ./tls.nix { inherit pkgs; };
  served = "/srv/tuf";
  resign = pkgs.writeShellScript "gate-resign" ''
    set -eu
    TUF_SNAPSHOT_KEY=$(cat ${repo}/offline/snapshot.json) TUF_TIMESTAMP_KEY=$(cat ${repo}/offline/timestamp.json) \
      ${tools}/bin/tufrepo gh-resign --metadata ${served}/metadata
    chmod -R a+rX ${served}
  '';
  gateServe = pkgs.writeShellScriptBin "gate-serve" ''
    set -eu
    gate=${repo}/gates/$1
    [ -d "$gate/0" ] || { echo "gate-serve: no gate $1 in ${repo}" >&2; exit 1; }
    rm -rf ${served}
    mkdir -p ${served}/metadata
    ln -s "$gate" ${served}/gate
    ln -s "$gate/targets" ${served}/targets
  '';
  gatePublish = pkgs.writeShellScriptBin "gate-publish" ''
    set -eu
    step=${served}/gate/$1
    [ -d "$step" ] || { echo "gate-publish: this gate has no step $1" >&2; exit 1; }
    # A step only adds role versions: what is served stays, as the repository's history does.
    cp --update=none "$step"/* ${served}/metadata/
    chmod -R u+w ${served}/metadata
    ${resign}
  '';
  site = {
    onlySSL = true;
    sslCertificate = "${tls.cert}/cert.pem";
    sslCertificateKey = "${tls.cert}/key.pem";
  };
in
{
  control =
    { ... }:
    {
      imports = [ ../common/control.nix ];
      systemd.services.fake-control.serviceConfig.ExecStart =
        lib.mkForce "${pkgs.whombat-provision}/bin/whombat-fake-control --listen 0.0.0.0:4600 --token-file /etc/whombat-fake-control/token --env dev --self-registration";
      systemd.services.tuf-fixtures.enable = lib.mkForce false;
      services.nginx = {
        enable = true;
        virtualHosts.${tls.pages} = site // {
          root = "${served}/metadata";
        };
        virtualHosts.${tls.github} = site // {
          # <release or bucket>/<file>, nothing else: what a release's files are called.
          locations."~ ^/[^/]+/[^/]+/releases/download/([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)$".return =
            "302 https://${tls.storage}/$1";
        };
        virtualHosts.${tls.storage} = site // {
          root = "${served}/targets";
          locations."~ ^/nar-[0-9a-f][0-9a-f]/([A-Za-z0-9._-]+)$".alias = "${served}/targets/nar/$1";
        };
      };
      networking.firewall.allowedTCPPorts = [
        443
        8000
      ];
      environment.systemPackages = [
        tools
        pkgs.jq
        gateServe
        gatePublish
      ];
      # The box's backup place (./update.nix, before the steps): an append-only rest-server, as update-migration's.
      services.restic.server = {
        enable = true;
        listenAddress = "8000";
        appendOnly = true;
        extraFlags = [ "--no-auth" ];
      };
      virtualisation.memorySize = 1536;
      virtualisation.restrictNetwork = true;
    };

  box =
    { lib, ... }:
    {
      virtualisation = {
        directBoot.enable = false;
        mountHostNixStore = false;
        useDefaultFilesystems = false;
        fileSystems = lib.mkForce { };
        useEFIBoot = true;
        useSecureBoot = true;
        tpm.enable = false;
        memorySize = boxMemory;
        cores = 4;
        diskImage = null;
        restrictNetwork = true;
        qemu.options = [
          "-device virtio-scsi-pci,id=scsi0"
          ''-drive if=none,id=disk0,format=qcow2,file="$WB_BOX_DISK"''
          "-device scsi-hd,bus=scsi0.0,drive=disk0,bootindex=1"
          "-device i6300esb"
        ];
      };
      # Never booted (the disk is): only what this configuration needs to evaluate.
      fileSystems."/" = {
        device = "/dev/disk/by-partlabel/whombat-root";
        fsType = "ext4";
      };
      boot.loader.grub.enable = false;
    };
}
