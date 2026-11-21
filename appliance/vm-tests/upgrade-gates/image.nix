# The installed disk of one gate release (NX-111): the release's own installer (its `installer-base.nix`, its packages,
# the text path: `whombat-install --disk … --yes-erase-disk`, as the ISO's shell and its graphical installer run it) puts
# the gate image of the release on a blank 128 GiB disk, never booted. The result, `disk.qcow2`, is a store path: built
# once per release and cached; every gate that starts from the release boots a copy-on-write overlay of it, so the
# box's first boot (keys, /persist, self-registration with that gate's control, the factory tuple) happens in the gate.
{ lib }:
release:
release.pkgs.testers.runNixOSTest {
  name = "whombat-gate-image-${release.releaseId}";
  defaults.imports = [ ../common/defaults.nix ];
  nodes.installer =
    { ... }:
    {
      imports = [ "${release.src}/nix/profiles/installer-base.nix" ];
      whombat.installer = {
        system = release.toplevel;
        inherit (release) recoveryUki;
        gui = false;
      };
      virtualisation = {
        memorySize = 4096;
        cores = 4;
        useEFIBoot = true;
        restrictNetwork = true;
        emptyDiskImages = [
          {
            # The qualified disk size (PI-09); sparse.
            size = 131072;
            driveConfig.deviceExtraOpts.serial = "target";
          }
        ];
      };
    };
  testScript = ''
    import os, subprocess
    installer.start()
    installer.wait_for_unit("multi-user.target")
    print(installer.succeed("set -o pipefail; whombat-install --disk /dev/disk/by-id/virtio-target --yes-erase-disk 2>&1 | grep -v '^@@progress'", timeout=3600))
    installer.succeed("sync")
    installer.shutdown()
    out = os.environ["out"]
    subprocess.run(["${release.pkgs.qemu_test}/bin/qemu-img", "convert", "-O", "qcow2",
                    str(installer.state_dir / "empty0.qcow2"), os.path.join(out, "disk.qcow2")], check=True)
    with open(os.path.join(out, "release"), "w") as f:
        f.write("${release.releaseId} ${release.toplevel}\n")
  '';
}
