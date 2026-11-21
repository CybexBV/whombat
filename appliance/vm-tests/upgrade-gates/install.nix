# Gate 3 (NX-114): a fresh install from the candidate's ISO. The ISO is the candidate's installer (flake.nix
# installerWith, the dev ISO's name) of the candidate's gate image, plus the test driver's backdoor so the test can use
# the installer's shell, as a person at the console would (`whombat-install --disk … --yes-erase-disk`; the graphical
# installer calls the same command). The box boots it from a virtio-scsi CD-ROM onto a blank 128 GiB disk, powers off,
# and boots the disk with the CD-ROM empty: first boot, the box's own identity (control first hears of a box when its
# owner turns Link on), the factory tuple as the box's channel lists it, the runtime healthy on its schema, the boot
# assessment passed. The fake control has no claim flow (claims go through the relay, CL-…): the gate records what the
# console offers instead (the claim state the runtime writes for it).
{
  pkgs,
  lib,
  nodes,
  prelude,
}:
{
  cand,
  iso,
}:
pkgs.testers.runNixOSTest {
  name = "whombat-upgrade-gate-3-install";
  globalTimeout = 2 * 3600;
  defaults.imports = [ ../common/defaults.nix ];
  nodes = {
    control = nodes.control;
    box =
      { lib, ... }:
      {
        imports = [ nodes.box ];
        virtualisation.memorySize = lib.mkForce 6144;
        virtualisation.qemu.options = lib.mkAfter [
          ''-drive if=none,id=cd0,media=cdrom,file="$WB_BOX_CDROM"''
          "-device scsi-cd,bus=scsi0.0,drive=cd0,bootindex=0"
        ];
      };
  };
  testScript = ''
    ${prelude}
    import glob

    isos = glob.glob("${iso}/iso/*.iso")
    assert len(isos) == 1, isos
    os.environ["WB_BOX_CDROM"] = isos[0]
    disk = blank_disk()
    start("3", "${cand.releaseId}")

    with subtest("install from the candidate's ISO onto a blank disk"):
        box.wait_for_unit("multi-user.target", timeout=900)
        target = sh("lsblk -dnbo NAME,SIZE,TYPE | awk '$3 == \"disk\" && $2 == 137438953472 {print \"/dev/\" $1}'")
        assert target.startswith("/dev/sd"), target
        print(box.succeed(f"set -o pipefail; whombat-install --disk {target} --yes-erase-disk 2>&1 | grep -v '^@@progress'", timeout=3600))
        box.succeed("sync")
        box.shutdown()
        os.environ["WB_BOX_CDROM"] = ""

    with subtest("first boot: its own identity, the factory tuple, the runtime healthy"):
        box.start(allow_reboot=True)
        kernel_started()
        st = provisioned("${cand.releaseId}", "${cand.tuple.runtime.version}")
        assert booted() == "${cand.toplevel}", booted()
        assert runtime_profile() == "${cand.runtime}", runtime_profile()
        assert schema() == ${toString cand.tuple.runtime.schemaWrites}, schema()
        # The box makes its own identity: control hears of it only when its owner turns Link on.
        registered = json.loads(control.succeed("curl -sf http://127.0.0.1:4600/test/devices"))
        assert not registered, f"control heard of a box that isn't linked: {registered}"
        rec = json.loads(sh("whombat-provision verify"))
        assert rec["model"] == "self-installed" and rec["deviceId"] == DEVICE and rec["deviceId"].startswith("wb-"), rec
        # The platform's name before PI-22 in the releases built before it.
        assert sh("cat /etc/whombat/platform") in ("self-installed host-encrypted", "proxmox-vm host-encrypted")
        box.wait_until_succeeds("systemctl show -P Result whombat-boot-assessment | grep -qx success", timeout=900)
        st = wait_journal(healthy_on("${cand.releaseId}"), "the journal healthy on ${cand.releaseId}", timeout=600)
        print("journal:", json.dumps({k: st.get(k) for k in ["phase", "current", "knownGood"]})[:2000])
        hs = helper_state()
        assert hs["runtime"]["current"]["releaseId"] == "${cand.releaseId}", hs

    with subtest("what the console offers for the claim (the fake control has no claim flow)"):
        code, out = box.execute("cat /run/whombat/console/console.json", timeout=60)
        print("console.json:", out.strip() if code == 0 else f"(none: {code})")
        print(box.succeed("whombat-console --once --json --file /run/whombat/console/console.json 2>&1 || true"))
        data = populate("a")
        box.succeed("systemctl restart whombat-runtime.target")
        runtime_up("${cand.tuple.runtime.version}")
        assert fingerprint("a") == data
  '';
}
