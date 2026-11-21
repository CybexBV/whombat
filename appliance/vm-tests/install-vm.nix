# The ISO in a VM with install.md's settings (PI-02, PI-09, PI-18…PI-22; NX-50…NX-59, NX-90…NX-92; the graphical
# installer and console CG-01…CG-17, CG-30…CG-34, NX-78…NX-84), end to end:
#   1. The graphical installer (whombat-installer-ui, the kiosk on tty1, read with OCR) installs through its API on a
#      blank 128 GiB disk: the pre-flight checks, the disk list, refusals (a wrong confirmation, a disk that isn't
#      eligible), progress from whombat-install's @@progress lines, Done. It lays out host-encrypted storage for the
#      self-installed image (no LUKS, no TPM); the CLI still refuses another platform than the image's.
#   2. The VM as a hypervisor runs it (install.md §5, Proxmox VE's defaults among them): q35 + OVMF with Secure Boot keys not enrolled (setup mode), no TPM, the disk on
#      virtio-scsi, the i6300esb watchdog and the QEMU guest agent (allow-listed RPCs only). First boot: keys
#      generated but not enrolled, Secure Boot off, no TPM units, /persist btrfs with subvolumes and quotas.
#   3. Self-provisioning makes the box's own identity (no Secure Boot; the fake control hears nothing until Link) and
#      creates no disk recovery key. The box has update channels as every Whombat (production by default), and its
#      release is first listed in no channel: the console says why it can't start (CG-409, NX-526). Then Beta
#      (development) alone lists it, as for a Beta installer: the box starts and follows Beta (MG-182).
#   4. The graphical console goes straight to the claim code (OCR, and the API agrees with `whombat-console --once
#      --json`), also after a reboot; a key an earlier image left unconfirmed for the console is removed at boot with
#      its hash.
#   5. A host update to a new generation that fails its boot assessment: after the attempts run out the
#      known-good generation boots again (boot counting without Secure Boot).
#   6. Factory reset. With a hash an earlier image stored (a confirmed key): refused with a wrong key in the running
#      system and in the recovery menu, done from the menu with the right key. Without one (every box since PI-19):
#      the running system's tools and the menu want a typed ERASE; a wrong word touches nothing, ERASE resets. After
#      each reset the appliance provisions itself again, without a key.
# What a VM run can't show about a real hypervisor host (its storage encryption, backups, the host's console) is in
# docs/runbooks/install.md and docs/runbooks/hardware-qualification.md ("Virtual machines").
{
  applianceModules,
  lib,
  pkgs,
  recoveryProbeUki,
  ...
}:
let
  # The release the image was built as, and the update repository with both channels (UP-X29), served over HTTPS as the
  # GitHub repository's Pages site is: the development fixtures' keys and root, channel roles added at the control's
  # start. The test lists the release in development only (a Beta installer).
  release = "whombat-20261120.1";
  fixtures = ../release-tools/fixtures;
  repoDir = "/srv/tuf/fixtures/dev/repo";
  tls = pkgs.runCommand "install-vm-releases-tls" { nativeBuildInputs = [ pkgs.openssl ]; } ''
    openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes -out cert.pem -keyout key.pem \
      -subj '/CN=control' -addext "subjectAltName=DNS:control"
    mkdir -p $out
    cp key.pem cert.pem $out
  '';
  targetModule =
    { lib, pkgs, ... }:
    {
      imports = applianceModules ++ [
        ../nix/profiles/self-installed.nix
        ./common/manager-dev.nix
      ];
      whombat.environment = "dev";
      # Update channels as on every Whombat (ONE-02): production by default, the GitHub layout (its targets are never
      # fetched here: the box's only release is the one it was installed with).
      whombat.helper.defaultChannel = "production";
      whombat.manager.tuf = {
        metadataUrl = lib.mkForce "https://control/metadata/";
        targetsUrl = lib.mkForce "https://github.com/example/releases/releases/download/";
        targetsLayout = "github";
      };
      security.pki.certificateFiles = [ "${tls}/cert.pem" ];
      whombat.storage.persistReserveMiB = 64;
      whombat.boot = {
        tries = 2;
        assessmentTimeoutSec = 90;
        settleSec = 5;
        recoveryUki = recoveryProbeUki;
      };
      whombat.provisioning = {
        factoryMedium = false;
        selfRegister = true;
        selfFactoryRelease = release;
        selfSeedHelper = false;
      };
      whombat.runtime.watchdogSec = 10;
      whombat.slices.critical.memoryMin = "256M";
      whombat.postgres.sharedBuffers = "64MB";
      environment.systemPackages = [
        pkgs.sbctl
        pkgs.sbsigntool
        pkgs.jq
      ];
      virtualisation = {
        directBoot.enable = false;
        mountHostNixStore = false;
        useDefaultFilesystems = false;
        fileSystems = lib.mkForce { };
        useEFIBoot = true;
        # OVMF with Secure Boot support and no keys (Proxmox VE: "Pre-Enroll keys" off; Incus: security.secureboot=false): setup mode, and it stays
        # there because the appliance doesn't enrol its keys on this platform.
        useSecureBoot = true;
        tpm.enable = false;
        memorySize = 3072;
        # The disk on virtio-scsi as hypervisors attach it (not the test driver's virtio-blk), plus the i6300esb
        # watchdog and the guest agent's virtio-serial port (PI-09).
        diskImage = null;
        qemu.options = [
          "-device virtio-scsi-pci,id=scsi0"
          ''-drive if=none,id=disk0,format=qcow2,file="$NIX_DISK_IMAGE"''
          "-device scsi-hd,bus=scsi0.0,drive=disk0,bootindex=1"
          "-device i6300esb"
          ''-chardev socket,id=qga0,path="$WB_QGA_SOCK",server=on,wait=off''
          "-device virtio-serial-pci"
          "-device virtserialport,chardev=qga0,name=org.qemu.guest_agent.0"
        ];
        qemu.drives = [
          {
            name = "xfer";
            file = ''"$WB_XFER_DISK"'';
            deviceExtraOpts.serial = "xfer";
          }
        ];
      };
    };
in
{
  name = "whombat-install-vm";
  enableOCR = true;

  nodes = {
    control =
      { pkgs, ... }:
      {
        imports = [ ./common/control.nix ];
        systemd.services.fake-control.serviceConfig.ExecStart =
          lib.mkForce "${pkgs.whombat-provision}/bin/whombat-fake-control --listen 0.0.0.0:4600 --token-file /etc/whombat-fake-control/token --env dev --self-registration";
        environment.systemPackages = [ pkgs.whombat-release-tools ];
        # The fixtures' repository with both channel roles and no release in either, over HTTPS (nginx below).
        systemd.services.tuf-fixtures.enable = lib.mkForce false;
        systemd.services.tuf-channels = {
          wantedBy = [ "multi-user.target" ];
          before = [ "nginx.service" ];
          path = [
            pkgs.coreutils
            pkgs.whombat-release-tools
          ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
          };
          script = ''
            set -eu
            rm -rf /srv/tuf
            mkdir -p /srv/tuf/fixtures/dev
            cp -r ${fixtures}/dev/repo ${repoDir}
            cp -r ${fixtures}/dev-keys /srv/tuf/fixtures/dev-keys
            chmod -R u+w /srv/tuf
            tufrepo add-channels --dir ${repoDir}
            chmod -R a+rX ${repoDir}
          '';
        };
        services.nginx = {
          enable = true;
          virtualHosts.control = {
            onlySSL = true;
            sslCertificate = "${tls}/cert.pem";
            sslCertificateKey = "${tls}/key.pem";
            root = repoDir;
          };
        };
        networking.firewall.allowedTCPPorts = [ 443 ];
      };

    target = targetModule;

    # The same system plus a fault: the runtime reports "degraded", so the boot assessment never passes.
    candidate =
      { ... }:
      {
        imports = [ targetModule ];
        systemd.tmpfiles.rules = [
          "d /run/whombat-standin 0755 root root -"
          "f /run/whombat-standin/unhealthy 0644 root root -"
        ];
      };

    installer =
      { nodes, pkgs, ... }:
      {
        imports = [ ../nix/profiles/installer-base.nix ];
        whombat.installer.system = nodes.target.system.build.toplevel;
        whombat.installer.recoveryUki = recoveryProbeUki;
        whombat.installer.rootSize = "7G";
        virtualisation.additionalPaths = [ nodes.candidate.system.build.toplevel ];
        virtualisation.memorySize = 4096;
        # The pre-flight's uefi check (CG-13): the installer boots through OVMF, as in any UEFI VM.
        virtualisation.useEFIBoot = true;
        environment.systemPackages = [ pkgs.jq ];
        virtualisation.emptyDiskImages = [
          # The qualified disk size (PI-09, CG-13: at least 128 GiB); sparse.
          {
            size = 131072;
            driveConfig.deviceExtraOpts.serial = "target";
          }
          {
            size = 4096;
            driveConfig.deviceExtraOpts.serial = "xfer";
          }
        ];
      };
  };

  testScript =
    { nodes, ... }:
    let
      good = nodes.target.system.build.toplevel;
      bad = nodes.candidate.system.build.toplevel;
    in
    ''
      import json, os, queue, re, socket, subprocess, time

      ${builtins.readFile ./common/pointer.py}

      good = "${good}"
      bad = "${bad}"
      tmp = os.environ.get("TMPDIR", "/tmp")
      os.environ["WB_QGA_SOCK"] = os.path.join(tmp, "wb-qga.sock")
      PENDING = "/persist/console/recovery-key.json"
      HASH = "/persist/secrets/recovery-key.argon2id"
      # A disk recovery key and its hash as an image before PI-19 stored them (PI-04; Argon2id, PHC string).
      OLD_KEY = "cbdefghi-jklnrtuv-cbdefghi-jklnrtuv-cbdefghi-jklnrtuv-cbdefghi-ttttvvvv"
      OLD_HASH = subprocess.run(
          ["${pkgs.libargon2}/bin/argon2", "whombat-test-salt", "-id", "-t", "3", "-m", "16", "-p", "4", "-l", "32", "-e"],
          input=OLD_KEY, capture_output=True, text=True, check=True,
      ).stdout.strip()

      def plant_old_key(m, pending):
          m.succeed(f"install -m 0600 -o root -g root /dev/stdin {HASH} <<'EOF'\n{OLD_HASH}\nEOF")
          if pending:
              m.succeed("install -d -m 0750 -o root -g whombat-console /persist/console")
              m.succeed(f"install -m 0440 -o root -g whombat-console /dev/stdin {PENDING} <<'EOF'\n"
                        + json.dumps({"v": 1, "key": OLD_KEY}) + "\nEOF")

      def sh(m, cmd):
          return m.succeed(cmd).strip()

      def reboot(m):
          # Not Ctrl+Alt+Del (the driver's reboot()): with the graphical console the keyboard is cage's, in raw mode,
          # so the kernel never sees the combination (NX-82). A clean reboot from inside, as a hypervisor's Reboot does.
          m.succeed("systemd-run --on-active=1 systemctl reboot")
          m.connected = False

      def reconnect(m):
          m.connected = False
          m.connect()

      def current(m):
          return sh(m, "readlink -f /run/current-system")

      def entries(m):
          return m.succeed("ls /boot/EFI/Linux").split()

      def drain(m):
          try:
              while True:
                  m.last_lines.get_nowait()
          except queue.Empty:
              pass

      def console(m, regex, timeout=600):
          buf, end = "", time.monotonic() + timeout
          while time.monotonic() < end:
              try:
                  while True:
                      buf += m.last_lines.get_nowait() + "\n"
              except queue.Empty:
                  pass
              mt = re.search(regex, buf)
              if mt:
                  print(f"console matched {regex!r}: {mt.group(0)!r}")
                  return mt.group(0)
              time.sleep(0.5)
          raise Exception(f"timed out after {timeout}s waiting for {regex!r} on the console")

      def qga(cmd):
          s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
          s.settimeout(20)
          s.connect(os.environ["WB_QGA_SOCK"])
          try:
              # Resynchronise first: the channel may hold a half reply from an earlier boot.
              s.sendall(b'\xff{"execute":"guest-sync-delimited","arguments":{"id":4711}}\n')
              buf = b""
              while b'"return": 4711' not in buf and b'"return":4711' not in buf:
                  buf += s.recv(4096)
              s.sendall(json.dumps(cmd).encode() + b"\n")
              buf = b""
              while not buf.endswith(b"\n"):
                  buf += s.recv(4096)
              return json.loads(buf.decode().strip().split("\n")[-1])
          finally:
              s.close()

      def write_state(doc):
          # As the runtime does it (console-self): a temporary file, 0640, rename.
          target.succeed(
              "runuser -u whombat -- sh -c 'umask 077; cat > /run/whombat/console/.console.json.tmp"
              " && chmod 0640 /run/whombat/console/.console.json.tmp"
              " && mv /run/whombat/console/.console.json.tmp /run/whombat/console/console.json' <<'EOF'\n"
              + doc + "\nEOF"
          )

      CLAIMABLE = '{"v":1,"state":"claimable","code":"KXQM","url":"https://dev.whombat.com/claim"}'
      RELEASE = "${release}"
      START = "${nodes.target.whombat.provisioning.startProblemFile}"
      REPO = "${repoDir}"

      def installer_api(method, path, body=None):
          data = f"-H 'Content-Type: application/json' -d '{json.dumps(body)}'" if body is not None else ""
          out = installer.succeed(
              f"curl -s -X {method} -w '\n%{{http_code}}' {data}"
              " -H \"Authorization: Bearer $(cat /run/whombat-installer-ui/token)\""
              f" http://127.0.0.1:8412{path}"
          ).strip()
          body, code = out.rsplit("\n", 1)
          return int(code), (json.loads(body) if body else None)

      def in_console_ns(m, cmd):
          pid = sh(m, "systemctl show -P MainPID whombat-console-server")
          return f"nsenter -t {pid} -n {cmd}"

      def console_api(m):
          return json.loads(m.succeed(in_console_ns(m,
              "curl -sf -H \"Authorization: Bearer $(cat /run/whombat-console-ui/token)\" http://127.0.0.1:8411/api/state")))

      def console_agree(m):
          # The graphical console's API and the text console's view are the same validated state.
          a = console_api(m)
          # With the footer the console's units are given (the self-installed banner names no recovery key, PI-19).
          footer = sh(m, "systemctl show -P ExecStart whombat-console-server | sed -n 's/.*--footer-file \\([^ ;]*\\).*/\\1/p'")
          b = json.loads(m.succeed(
              "runuser -u whombat-console -- ${nodes.target.whombat.console.package}/bin/whombat-console --once --json"
              f" --file /run/whombat/console/console.json --footer-file {footer} --start-file {START}"
          ))
          a.pop("now"); b.pop("now")
          assert a == b, (a, b)
          return a

      control.start()

      with subtest("the graphical installer: kiosk on tty1, pre-flight checks, disks"):
          installer.start()
          installer.wait_for_unit("multi-user.target")
          installer.wait_for_unit("whombat-installer-ui.service")
          installer.wait_for_unit("whombat-kiosk.service")
          installer.fail("systemctl is-active getty@tty1.service")
          assert sh(installer, "stat -c '%U:%G %a' /run/whombat-installer-ui/token") == "root:whombat-kiosk 640"
          installer.wait_for_text("set up your Whombat", timeout=300)
          installer.screenshot("installer-welcome")
          # No pointer in the middle of the installer at rest; a noVNC user's mouse shows one while it moves (CG-410).
          pointer_check(installer, "installer-welcome")
          # Without the token: 403.
          assert sh(installer, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8412/api/state") == "403"
          code, _ = installer_api("POST", "/api/preflight")
          assert code == 202, code
          installer.wait_until_succeeds(
              "curl -sf -H \"Authorization: Bearer $(cat /run/whombat-installer-ui/token)\" http://127.0.0.1:8412/api/state"
              " | jq -e '.preflight.status == \"done\"'", timeout=120)
          _, st = installer_api("GET", "/api/state")
          print(json.dumps(st["preflight"], indent=1))
          assert st["mode"] == "installer" and st["platform"] == "self-installed" and st["storage"] == "host-encrypted", st
          assert st["environment"] == "dev" and st["release"] == "${release}" and st["install"]["status"] == "idle", st
          checks = {c["id"]: c for c in st["preflight"]["checks"]}
          assert [c["id"] for c in st["preflight"]["checks"]] == ["uefi", "cpu", "memory", "disk", "network", "reach-api", "reach-updates", "reach-relay"]
          assert checks["uefi"]["status"] == "ok" and checks["disk"]["status"] == "ok", checks
          assert not any(c["status"] == "fail" for c in checks.values()), checks
          # No way out of the test network: the image's hosts are unreachable, a warning only.
          assert checks["reach-api"]["status"] == "warn", checks
          disks = {d["name"]: d for d in st["preflight"]["disks"]}
          eligible = [d for d in disks.values() if d["eligible"]]
          assert len(eligible) == 1 and eligible[0]["sizeBytes"] == 128 << 30, disks
          target_disk = eligible[0]
          assert sh(installer, "readlink -f /dev/disk/by-id/virtio-target") == target_disk["path"], target_disk
          # The installer's own disk is in use, the transfer disk too small.
          assert disks[sh(installer, "lsblk -no pkname $(findmnt -no SOURCE /) | head -1") or "vda"]["reason"] == "in-use", disks
          assert disks[os.path.basename(sh(installer, "readlink -f /dev/disk/by-id/virtio-xfer"))]["reason"] == "too-small", disks
          installer.wait_for_text("Checking this machine|set up your Whombat", timeout=60)

      with subtest("the installer page draws its regular text, Start works, and a switch to tty2 and back keeps it (NX-88)"):
          # The title alone is not enough: without fontconfig the page drew its title and empty boxes.
          installer.succeed("fc-list | grep -qi dejavu")
          installer.wait_for_text("installs Whombat on this", timeout=60)
          installer.send_key("ret")
          # Start asks how the box will be reached first (Easy or Expert); Easy has the focus, Enter continues with it.
          installer.wait_for_text("How will you reach", timeout=60)
          installer.screenshot("installer-reach")
          installer.send_key("ret")
          installer.wait_for_text("Checking this machine", timeout=60)
          installer.wait_for_text("Whombat service", timeout=60)
          installer.screenshot("installer-checks")
          installer.send_key("ctrl-alt-f2")
          installer.sleep(15)
          installer.send_key("ctrl-alt-f1")
          installer.wait_for_text("Checking this machine|set up your Whombat", timeout=120)
          installer.succeed("systemctl is-active whombat-kiosk.service")
          installer.fail("systemctl is-active getty@tty1.service")

      with subtest("install onto a blank disk through the installer: refusals, progress, done"):
          # The CLI stays, and still refuses another platform than the image's.
          out = installer.fail("whombat-install --platform factory --disk /dev/disk/by-id/virtio-target --yes-erase-disk 2>&1")
          assert "for self-installed, not factory" in out, out
          xfer = sh(installer, "readlink -f /dev/disk/by-id/virtio-xfer")
          for body, want in [
              ({"disk": target_disk["path"], "confirm": "sdz"}, "confirm"),
              ({"disk": target_disk["path"], "confirm": target_disk["name"].upper()}, "confirm"),
              ({"disk": xfer, "confirm": os.path.basename(xfer)}, "not-eligible"),
              ({"disk": "/dev/vda", "confirm": "vda"}, "not-eligible"),
          ]:
              code, res = installer_api("POST", "/api/install", body)
              assert code == 400 and res["message"] == want, (body, code, res)
          code, _ = installer_api("POST", "/api/restart")
          assert code == 409, code
          code, _ = installer_api("POST", "/api/install", {"disk": target_disk["path"], "confirm": target_disk["name"]})
          assert code == 202, code
          code, _ = installer_api("POST", "/api/install", {"disk": target_disk["path"], "confirm": target_disk["name"]})
          assert code == 409, code
          code, _ = installer_api("POST", "/api/preflight")
          assert code == 409, code
          seen, last = set(), -1
          end = time.monotonic() + 1800
          shot = False
          while True:
              _, st = installer_api("GET", "/api/state")
              inst = st["install"]
              assert inst["percent"] >= last, (inst["percent"], last)
              last = inst["percent"]
              if inst["step"]:
                  seen.add((inst["step"], inst["percent"]))
              if inst["status"] != "running":
                  break
              if inst["step"] == "copy" and 20 < inst["percent"] < 80 and not shot:
                  installer.screenshot("installer-installing")
                  shot = True
              assert time.monotonic() < end, "install took too long"
              time.sleep(2)
          print("\n".join(inst["log"][-30:]))
          print(sorted(seen))
          assert inst["status"] == "done" and inst["percent"] == 100 and inst["step"] == "finish" and inst["error"] == "", inst
          assert inst["disk"] == target_disk["path"], inst
          copies = [p for (s, p) in seen if s == "copy"]
          assert any(6 < p < 90 for p in copies), f"no copy progress between the ends: {sorted(seen)}"
          # The page's log is the last 200 lines; the journal has all of whombat-install's output.
          assert inst["log"][-1] == "== done: remove the installer medium and restart", inst["log"]
          assert not any(l.startswith("@@progress") for l in inst["log"]), inst["log"]
          installer.succeed(f"journalctl -u whombat-installer-ui --no-pager | grep -qF '== installing Whombat on {target_disk['path']}'")
          installer.wait_for_text("Whombat is installed", timeout=60)
          installer.screenshot("installer-done")
          code, _ = installer_api("POST", "/api/install", {"disk": target_disk["path"], "confirm": target_disk["name"]})
          assert code == 409, code
          print(installer.succeed("journalctl -u whombat-installer-ui --no-pager | tail -40"))
          for part in ["whombat-root", "whombat-persist"]:
              installer.fail(f"cryptsetup isLuks /dev/disk/by-partlabel/{part}")
          assert sh(installer, "blkid -o value -s TYPE /dev/disk/by-partlabel/whombat-persist") == "btrfs"
          assert sh(installer, "blkid -o value -s TYPE /dev/disk/by-partlabel/whombat-root") == "ext4"
          installer.succeed(f"nix-store --export $(nix-store -qR {bad}) > /dev/disk/by-id/virtio-xfer")
          installer.succeed("sync")
          # Done → Restart reboots the installer (QEMU exits: the test VM doesn't reboot).
          code, _ = installer_api("POST", "/api/restart")
          assert code == 202, code
          installer.wait_for_shutdown()
          state = str(installer.state_dir)
          os.environ["NIX_DISK_IMAGE"] = os.path.join(state, "empty0.qcow2")
          os.environ["WB_XFER_DISK"] = os.path.join(state, "empty1.qcow2")

      with subtest("first boot in a VM: keys generated, not enrolled; no TPM; /persist laid out"):
          target.start(allow_reboot=True)
          target.wait_for_unit("multi-user.target")
          assert current(target) == good
          # The disk is on virtio-scsi (virtio-scsi-single), found by partlabel.
          root = sh(target, "readlink -f /dev/disk/by-partlabel/whombat-root")
          assert sh(target, "findmnt -n -o SOURCE /") == root, root
          assert sh(target, "findmnt -n -o SOURCE /persist") == sh(target, "readlink -f /dev/disk/by-partlabel/whombat-persist")
          assert "virtio" in sh(target, f"readlink -f /sys/class/block/{os.path.basename(root)}"), "not on virtio-scsi"
          target.fail("test -e /dev/tpmrm0")
          target.fail("ls /dev/mapper/whombat-*")
          for unit in ["whombat-tpm-seal.service", "whombat-tpm-reseal.path", "prepare-sb-auto-enroll.service"]:
              target.fail(f"systemctl cat {unit}")
          status = target.succeed("bootctl status 2>&1 || true")
          print(status)
          assert "Secure Boot: disabled" in status, status
          target.wait_for_unit("generate-sb-keys.service")
          target.succeed("test -e /var/lib/sbctl/keys/db/db.key")
          target.fail("test -e /boot/loader/keys/auto/PK.auth")
          print(target.succeed("sbctl status 2>&1 || true"))
          assert sh(target, "cat /etc/whombat/platform") == "self-installed host-encrypted"
          # Subvolumes and the qgroup limit exactly as on hardware (NX-07, NX-12).
          target.wait_for_unit("whombat-persist-layout.service")
          for sv in ["secrets", "manager", "whombat/home", "whombat/workspaces", "postgres"]:
              target.succeed(f"btrfs subvolume show /persist/{sv} >/dev/null")
          target.succeed("btrfs qgroup show /persist | grep -q '^1/100 '")
          print(target.succeed("btrfs qgroup show -reFp /persist/secrets"))
          # Blessed factory generation, recovery UKI installed.
          assert any(e.startswith("nixos-generation-1-") and "+" not in e for e in entries(target)), entries(target)
          # Signed with the device's (unenrolled) db key once the keys exist.
          target.wait_until_succeeds("grep -q ' signed$' /boot/EFI/Linux/.whombat-recovery.source", timeout=120)
          # The installer's unsigned copy was replaced by a whole, signed one (the ESP can't hold two; NX-64).
          target.succeed("sbverify --cert /var/lib/sbctl/keys/db/db.pem /boot/EFI/Linux/whombat-recovery.efi")
          target.succeed("test ! -e /boot/EFI/Linux/whombat-recovery.efi.tmp")

      with subtest("the i6300esb watchdog is the only one, and PID 1 pets it"):
          dogs = sh(target, "for w in /sys/class/watchdog/*; do echo \"$(cat $w/identity): $(cat $w/state)\"; done")
          print(dogs)
          assert dogs.startswith("i6300ESB") and dogs.endswith(": active") and "\n" not in dogs, dogs

      with subtest("the guest agent answers the host's shutdown and freeze calls, nothing else"):
          target.wait_for_unit("qemu-guest-agent.service")
          assert qga({"execute": "guest-ping"}) == {"return": {}}
          info = qga({"execute": "guest-info"})["return"]
          enabled = sorted(c["name"] for c in info["supported_commands"] if c["enabled"])
          print("guest agent RPCs:", enabled)
          assert "guest-fsfreeze-freeze" in enabled and "guest-shutdown" in enabled, enabled
          for bad_rpc in ["guest-exec", "guest-file-open", "guest-set-user-password", "guest-ssh-add-authorized-keys"]:
              assert bad_rpc not in enabled, bad_rpc
          refused = qga({"execute": "guest-exec", "arguments": {"path": "/bin/sh", "arg": ["-c", "touch /qga-was-here"]}})
          print(refused)
          assert "error" in refused, refused
          target.fail("test -e /qga-was-here")
          frozen = qga({"execute": "guest-fsfreeze-status"})
          assert frozen == {"return": "thawed"}, frozen

      with subtest("a release no channel lists: the first start can't finish, and the screen says why (CG-409)"):
          target.wait_until_succeeds(f"test -e {START}", timeout=300)
          problem = json.loads(sh(target, f"cat {START}"))
          assert problem == {"v": 1, "problem": "release-missing", "release": RELEASE}, problem
          assert sh(target, f"stat -c '%U %a' {START}") == "root 644"
          plog = target.succeed("journalctl -u whombat-self-provision --no-pager")
          print(plog)
          assert "no update channel lists this release" in plog, plog
          target.fail("test -e /persist/manager/journal/journal.a.json")
          # The runtime may run already (it starts once the identity exists) and says it is starting until the manager
          # speaks; the manager doesn't run.
          target.fail("systemctl is-active whombat-manager.service")
          target.wait_for_unit("whombat-kiosk.service")
          target.wait_for_text("start yet", timeout=300)
          target.screenshot("vm-start-release-missing")
          st = console_agree(target)
          assert st["claim"]["state"] == "starting", st
          assert st["claim"]["start"] == {"problem": "release-missing", "release": RELEASE}, st
          text = target.succeed(
              f"runuser -u whombat-console -- ${nodes.target.whombat.console.package}/bin/whombat-console --once"
              f" --file /run/whombat/console/console.json --start-file {START} --width 200"
          )
          print(text)
          assert f"its version, {RELEASE}, on the update server" in text, text
          # The box still reads its default channel.
          target.fail("test -e /var/lib/whombat-update-helper/channel.json")

      with subtest("Beta alone lists the release: the box starts and follows Beta (MG-182)"):
          control.succeed(
              f"tufrepo add-fake-release --dir {REPO} --channel development --id {RELEASE}"
              " --host-version 26.05.1 --runtime-version 1.0.0"
          )
          control.succeed(f"chmod -R a+rX {REPO}")
          # What the screen says: a restart tries at once (the unit's own retry waits a while).
          target.succeed("systemctl start whombat-self-provision.service")
          target.wait_for_unit("whombat-manager.service")
          target.wait_for_unit("whombat-server.service")
          plog = target.succeed("journalctl -u whombat-self-provision --no-pager")
          print(plog)
          assert f"{RELEASE} is listed in the development channel only" in plog, plog
          channel = json.loads(sh(target, "cat /var/lib/whombat-update-helper/channel.json"))
          print(channel)
          assert "development" in json.dumps(channel), channel
          target.fail(f"test -e {START}")
          status = json.loads(sh(target, "runuser -u whombat-manager -- ${nodes.target.whombat.manager.package}/bin/whombat-manager --config /etc/whombat/manager.json status"))
          print(status)
          assert RELEASE in json.dumps(status), status

      with subtest("self-provisioning without Secure Boot and without a disk recovery key"):
          target.wait_until_succeeds("test -e /persist/identity/device.json", timeout=240)
          target.wait_until_succeeds("systemctl show -P ActiveState whombat-self-provision | grep -qx inactive", timeout=120)
          plog = target.succeed("journalctl -u whombat-self-provision --no-pager")
          print(plog)
          assert sh(target, "systemctl show -P Result whombat-self-provision") == "success"
          assert "recovery key" not in plog, plog
          rec = json.loads(sh(target, "whombat-provision verify"))
          assert rec["model"] == "self-installed" and rec["serial"].startswith("MID-"), rec
          assert not rec["recoveryKeyEnrolled"], rec
          # The box makes its own identity (Whombat LNK-01): control first hears of it at link.begin.
          assert not json.loads(sh(control, "curl -s http://127.0.0.1:4600/test/devices")), "control heard of the box"
          assert rec["deviceId"].startswith("wb-"), rec
          target.fail(f"test -e {HASH} || test -e {PENDING} || test -e /persist/console || test -e /run/whombat-console")
          target.fail("printf '%s\\n' 'cccccccc-cccccccc-cccccccc-cccccccc-cccccccc-cccccccc-cccccccc-cccccccc' | whombat-provision recovery-key check")
          target.wait_for_unit("whombat-server.service")

      with subtest("the graphical console goes straight to the claim code (CG-31)"):
          write_state(CLAIMABLE)
          target.wait_for_unit("whombat-kiosk.service")
          target.fail("systemctl is-active whombat-console.service")
          target.wait_for_text("Claim this Whombat", timeout=300)
          target.wait_for_text("KXQM", timeout=60)
          st = console_agree(target)
          assert "key" not in st and "screen" not in st, st
          assert st["claim"]["code"] == "KXQM" and st["claim"]["claimUrl"] == "dev.whombat.com/claim", st
          text = target.get_screen_text()
          print(text)
          assert "recovery key" not in text.lower(), text
          target.screenshot("vm-claimable")

      with subtest("at boot, a key an earlier image left unconfirmed goes with its hash; the claim code follows"):
          plant_old_key(target, pending=True)
          reboot(target)
          target.wait_for_unit("multi-user.target")
          target.wait_for_unit("whombat-server.service")
          print(target.succeed("journalctl -u whombat-recovery-key-drop --no-pager"))
          assert sh(target, "systemctl show -P Result whombat-recovery-key-drop") == "success"
          target.fail(f"test -e {PENDING} || test -e {HASH} || test -e /persist/console")
          write_state(CLAIMABLE)
          target.wait_for_text("Claim this Whombat", timeout=300)

      with subtest("host update: the candidate boots, fails its assessment, the known-good generation returns"):
          target.systemctl("start whombat-boot-assessment.service")
          target.succeed("systemctl is-active whombat-boot-assessment.service")
          out = target.succeed("nix-store --import < /dev/disk/by-id/virtio-xfer 2>&1 | tail -3", timeout=900)
          print(out)
          target.succeed(f"nix-store --check-validity {bad}")
          target.succeed(f"nix-env --profile /nix/var/nix/profiles/system --set {bad}")
          target.succeed(f"{bad}/bin/switch-to-configuration boot")
          e = entries(target)
          print(e)
          assert any(x.startswith("nixos-generation-2-") and x.endswith("+2.efi") for x in e), e
          reboot(target)
          target.connect()
          assert current(target) == bad, current(target)
          target.succeed("test -e /persist/identity/device.json")
          # Attempt 1 fails the assessment and reboots; attempt 2 the same; then the known-good boots.
          reconnect(target)
          assert current(target) == bad, current(target)
          reconnect(target)
          assert current(target) == good, current(target)
          e = entries(target)
          print(e)
          assert any(x.startswith("nixos-generation-2-") and x.endswith("+0-2.efi") for x in e), e
          target.wait_for_unit("whombat-boot-assessment.service", timeout=300)

      def retire(r):
          # Control never knew the box (it made its own identity, Whombat LNK-01), so nothing is retired there: the reset
          # makes a new identity on the box. The update helper's state must go with the reset.
          assert not json.loads(sh(control, "curl -s http://127.0.0.1:4600/test/devices")), r["deviceId"]
          target.succeed("mkdir -p /var/lib/whombat-update-helper && echo '{\"v\":1,\"maxAssignmentSeq\":99}' > /var/lib/whombat-update-helper/state.json")

      def to_recovery_menu():
          target.succeed("bootctl set-oneshot whombat-recovery.efi")
          drain(target)
          target.succeed("systemd-run --on-active=2 systemctl reboot")
          target.connected = False
          console(target, "whombat-recovery: menu started", 900)
          time.sleep(3)

      def menu_reset_done():
          # One wait: both lines can arrive in the same read.
          assert console(target, "factory reset (finished|failed)", 900) == "factory reset finished"
          assert "whombat-recovery: factory reset started" in "\n".join(target.full_console_log[-400:])
          target.send_chars("\n", delay=0.05)
          time.sleep(2)
          drain(target)
          target.send_chars("9\n", delay=0.05)  # Restart
          target.connect()

      def provisioned_again(old):
          assert current(target) == good, current(target)
          target.fail("test -e /var/lib/whombat-update-helper/state.json")
          target.wait_until_succeeds(f"test -e /persist/identity/device.json && ! grep -q '{old['deviceId']}' /persist/identity/device.json", timeout=300)
          new = json.loads(sh(target, "whombat-provision verify"))
          assert new["deviceId"] != old["deviceId"] and new["serial"] == old["serial"], (old, new)
          target.fail(f"test -e {HASH} || test -e {PENDING}")
          target.wait_for_unit("whombat-server.service")
          write_state(CLAIMABLE)
          target.wait_for_text("Claim this Whombat", timeout=300)
          return new

      with subtest("a confirmed key from an earlier image still gates factory reset"):
          plant_old_key(target, pending=False)
          target.fail("printf 'not-the-key\\n' | whombat-factory-reset 2>&1")
          target.fail("printf 'ERASE\\n' | whombat-secure-erase 2>&1")
          target.succeed("test -e /persist/identity/device.json && systemctl is-active whombat-server.service")
          retire(rec)

      with subtest("recovery menu with that key: a wrong key touches nothing, the right one resets"):
          to_recovery_menu()
          target.send_chars("4\n", delay=0.05)
          time.sleep(2)
          target.send_chars("not-the-recovery-key\n", delay=0.02)
          console(target, "recovery key refused", 120)
          time.sleep(2)
          target.send_chars("\n", delay=0.05)
          time.sleep(2)
          target.send_chars("4\n", delay=0.05)
          time.sleep(2)
          target.send_chars(OLD_KEY + "\n", delay=0.02)
          console(target, "recovery key accepted", 120)
          time.sleep(2)
          target.send_chars("ERASE\n", delay=0.05)
          target.screenshot("vm-recovery-reset")
          menu_reset_done()

      with subtest("after the reset: a new identity, still no key"):
          rec2 = provisioned_again(rec)

      with subtest("without a key the running system's erase wants a typed ERASE (NX-91)"):
          target.fail("printf 'erase\\n' | whombat-factory-reset 2>&1")
          target.fail("printf '\\n' | whombat-secure-erase 2>&1")
          target.succeed("test -e /persist/identity/device.json && systemctl is-active whombat-server.service")
          retire(rec2)

      with subtest("recovery menu without a key: a wrong word touches nothing, ERASE resets (NX-91)"):
          to_recovery_menu()
          target.send_chars("4\n", delay=0.05)
          time.sleep(2)
          target.send_chars("erase\n", delay=0.05)
          time.sleep(10)
          assert "factory reset started" not in "\n".join(target.full_console_log[-400:])
          target.screenshot("vm-recovery-nokey")
          target.send_chars("\n", delay=0.05)
          time.sleep(2)
          target.send_chars("4\n", delay=0.05)
          time.sleep(2)
          target.send_chars("ERASE\n", delay=0.05)
          menu_reset_done()

      with subtest("after the second reset: a new identity again"):
          provisioned_again(rec2)
    '';
}
