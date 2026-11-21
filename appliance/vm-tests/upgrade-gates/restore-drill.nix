# Gate 7, the restore drill (UP-F2, NX-116): the checkpoint taken before a contract migration that then fails is
# restored onto a fresh box, and the owner's data is there. Direct boot (as update-migration), the fake control serving
# assignments, the fixture repository republished with real runtime bundles (../common/migration-runtimes.nix), and a
# restic rest-server (append-only) on the control node as the backup destination.
#
#   box A     factory release rt-a (the pin), the owner's data, a backup destination. rt-fail (the pin plus a `contract`
#             migration whose SQL fails) needs a verified checkpoint: the manager takes it at the safe boundary, the
#             migration fails, the database stays as it was (one transaction), the known-good check says read-write and
#             A stays on rt-a with its data. rt-fail is quarantined.
#   fresh     another box, factory release rt-b (the pin again, its own host), freshly provisioned. The owner's recovery
#             kit (A's `kit-material`, taken when its destination was set) joins the repository (`destination adopt`),
#             what the fresh install created is set aside (`quarantine prepare`), the checkpoint the manager took is
#             restored (`quarantine apply`: every drill check first, then the files and the database, read-only), the
#             reconciliation items are resolved and the quarantine released — restore.md's commands, as root at the
#             console (BK-24); the runtime starts on the restored data, healthy and writable.
{
  applianceModules,
  pkgs,
  lib,
  releaseRuntime,
  # The runtime package the tested runtimes are made from (this tree's, or a candidate's in the upgrade gates, NX-125).
  migrationRuntime,
  ...
}:
let
  fixtures = ../../release-tools/fixtures;
  repoDir = "/srv/tuf/fixtures/dev/repo";
  rts = import ../common/migration-runtimes.nix {
    inherit pkgs lib releaseRuntime;
    runtime = migrationRuntime;
  };
  inherit (rts) new;
  failing = rts.contractFailing;
  # Tuples that name each box's own system and manager (the helper activates a runtime only on the host its tuple
  # names), published with placeholder closure indexes (the bundles are in the boxes' stores).
  releasesFor =
    list:
    pkgs.runCommand "whombat-restore-drill-releases"
      {
        nativeBuildInputs = [
          pkgs.jq
          pkgs.nix
        ];
      }
      (
        ''
          release() {
            local id=$1 host=$2 mgr=$3 rt=$4 v=$5 hv=$6
            local nar=sha256:$(nix-hash --type sha256 --base16 $rt)
            local hostNar=sha256:$(nix-hash --type sha256 --base16 $host)
            local mgrNar=sha256:$(nix-hash --type sha256 --base16 $mgr)
            local s=$(bash ${../../release/schema-numbers} $rt/migrations/compat.json $rt/share/whombat/release-manifest.json | cut -d' ' -f2)
            mkdir -p $out/$id
            jq --arg id $id --arg sp $rt --arg nar "$nar" --arg v "$v" --argjson s "$s" --arg host $host --arg hostNar "$hostNar" \
              --arg mgr $mgr --arg mgrNar "$mgrNar" --arg hv "$hv" '
              .releaseId = $id
              | .runtime.storePath = $sp | .runtime.narHash = $nar | .runtime.version = $v
              | .runtime.schemaWrites = $s | .runtime.schemaReads = {min: $s, max: $s}
              | .host = {version: $hv, storePath: $host, narHash: $hostNar, abi: .host.abi}
              | .manager = {version: .manager.version, storePath: $mgr, narHash: $mgrNar}
              | .providers = []' ${fixtures}/dev/valid/targets/releases/*.rt-fixture-1.json > $out/$id/tuple.json
            echo -n "$nar" > $out/$id/nar-hash
            echo -n "$v" > $out/$id/version
            echo -n "$rt" > $out/$id/store-path
            echo -n "$hv" > $out/$id/host-version
            echo -n "$host" > $out/$id/host
            echo -n "$hostNar" > $out/$id/host-nar
            echo -n "$mgr" > $out/$id/manager
            printf '{"placeholder":true,"release":"%s","storePath":"%s"}\n' $id $rt > $out/$id/artifact
            printf '{"placeholder":true,"release":"%s","storePath":"%s"}\n' $id $host > $out/$id/host-artifact
          }
        ''
        + lib.concatMapStrings (r: ''
          release ${r.id} ${r.host} ${r.manager} ${r.runtime} ${r.runtime.version} ${r.hostVersion}
        '') list
      );
  box =
    serial:
    { lib, ... }:
    {
      imports = applianceModules ++ [ (import ../common/appliance-vm.nix { inherit serial; }) ];
      whombat.runtime.package = new;
      system.extraDependencies = [ failing ];
      whombat.manager.tuf = {
        metadataUrl = lib.mkForce "http://control:8080/metadata/";
        targetsUrl = lib.mkForce "http://control:8080/targets/";
      };
      whombat.manager.settings = {
        pollSec = 5;
        policy = {
          healthIntervalMs = 3000;
          verifyTimeoutMs = 90000;
          drainPollMs = 2000;
          retryBaseMs = 5000;
          idleIntervalMs = 3000;
          healthyStreak = 2;
          maxAttempts = 1;
        };
      };
      whombat.network.outboundTcpPorts = lib.mkForce [
        443
        4600
        8000
        8080
      ];
      # The backup service keeps 2 GiB free for its staging (W3-BK reserveBytes).
      virtualisation.emptyDiskImages = lib.mkForce [
        {
          size = 8192;
          driveConfig.deviceExtraOpts.serial = "persist";
        }
        {
          size = 64;
          driveConfig.deviceExtraOpts.serial = "factory";
        }
      ];
      environment.systemPackages = [ pkgs.restic ];
      virtualisation.memorySize = 3072;
      virtualisation.diskSize = 4096;
    };
in
{
  name = "whombat-restore-drill";

  nodes = {
    control =
      { nodes, ... }:
      let
        a = nodes.machine;
        b = nodes.fresh;
        releases = releasesFor [
          {
            id = "rt-a";
            host = a.system.build.toplevel;
            manager = a.whombat.manager.package;
            runtime = new;
            hostVersion = "vm-restore-drill-a";
          }
          {
            id = "rt-fail";
            host = a.system.build.toplevel;
            manager = a.whombat.manager.package;
            runtime = failing;
            hostVersion = "vm-restore-drill-a";
          }
          {
            id = "rt-b";
            host = b.system.build.toplevel;
            manager = b.whombat.manager.package;
            runtime = new;
            hostVersion = "vm-restore-drill-b";
          }
        ];
      in
      {
        imports = [ ../common/control.nix ];
        environment.systemPackages = [
          pkgs.whombat-release-tools
          pkgs.restic
        ];
        services.restic.server = {
          enable = true;
          listenAddress = "8000";
          appendOnly = true;
          extraFlags = [ "--no-auth" ];
        };
        networking.firewall.allowedTCPPorts = [ 8000 ];
        systemd.services.tuf-fixtures.enable = lib.mkForce false;
        systemd.services.tuf-drill = {
          wantedBy = [ "multi-user.target" ];
          path = [
            pkgs.coreutils
            pkgs.whombat-release-tools
          ];
          preStart = ''
            set -eu
            rm -rf /srv/tuf
            mkdir -p /srv/tuf/fixtures/dev
            cp -r ${fixtures}/dev/repo ${repoDir}
            cp -r ${fixtures}/dev-keys /srv/tuf/fixtures/dev-keys
            chmod -R u+w /srv/tuf
            for id in rt-a rt-b; do
              r=${releases}/$id
              tufrepo add-index --dir ${repoDir} --kind host --target "host/$(cat $r/host-version)/whombat-host.index.json" \
                --file $r/host-artifact --version "$(cat $r/host-version)" --store-path "$(cat $r/host)" \
                --nar-hash "$(cat $r/host-nar)" --manager-store-path "$(cat $r/manager)"
            done
            # rt-b runs rt-a's runtime (one index per version).
            for id in rt-a rt-fail; do
              r=${releases}/$id
              tufrepo add-index --dir ${repoDir} --kind runtime --target "runtime/$(cat $r/version)/whombat-runtime.index.json" \
                --file $r/artifact --version "$(cat $r/version)" --store-path "$(cat $r/store-path)" --nar-hash "$(cat $r/nar-hash)"
            done
            for id in rt-a rt-fail rt-b; do
              tufrepo add-release --dir ${repoDir} --tuple ${releases}/$id/tuple.json
            done
          '';
          serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server 8080 --directory ${repoDir}";
        };
      };
    machine = box "SN-RD-0001";
    fresh = box "SN-RD-0002";
  };

  testScript =
    { nodes, ... }:
    ''
      import json, shlex

      # Plain HTTP to a destination only on a numeric private address (BK-29).
      REST = "rest:http://${nodes.control.networking.primaryIPAddress}:8000/whombat"
      NEW, FAILING = "${new}", "${failing}"
      NEW_V = "${new.version}"

      def sh(m, cmd):
          return m.succeed(cmd).strip()

      def psql(m, q):
          return sh(m, f"cd / && runuser -u whombat -- psql -X -A -t -q -v ON_ERROR_STOP=1 -d whombat <<'WBSQL'\n{q}\nWBSQL")

      def backup(m, args):
          # As root at the box's console, as backup.md and restore.md say (BK-24).
          cfg = "$(systemctl cat whombat-backup | grep -o '/nix/store/[^ ]*whombat-backup.json' | head -1)"
          return m.succeed(f"cd / && whombat-backup -config {cfg} {args} 2>&1").strip()

      def journal(m) -> dict:
          best: dict = {"seq": -1, "state": {}}
          for f in ["journal.a.json", "journal.b.json"]:
              code, out = m.execute(f"cat /persist/manager/journal/{f}")
              if code == 0 and out.strip():
                  r = json.loads(out)
                  if r["seq"] > best["seq"]:
                      best = r
          return best["state"]

      def wait_journal(m, pred, what, timeout=900):
          last = {}
          def ok(_):
              nonlocal last
              last = journal(m)
              return pred(last)
          try:
              retry(ok, timeout_seconds=timeout)
          except Exception:
              print("journal:", json.dumps(last, indent=1)[:20000])
              print(m.succeed("journalctl -u whombat-manager -u whombat-update-helper -u whombat-backup-api --no-pager | tail -80"))
              raise Exception(f"timed out waiting for: {what}")
          return last

      def runtime_up(m, version):
          m.wait_until_succeeds(
              "runuser -u whombat-manager -- curl -sf --unix-socket /run/whombat/admin.sock http://runtime/health"
              f" | jq -e '.status == \"ok\" and .version == \"{version}\"'",
              timeout=300,
          )

      def provision(m, release):
          station = json.dumps({"v": 1, "environment": "dev", "controlUrl": "http://control:4600", "tokenFile": "token",
                                "model": "whombat-one", "requireSecureBoot": False, "factoryRelease": release})
          m.succeed(
              "mkfs.vfat /dev/disk/by-id/virtio-factory",
              f"echo '{station}' > /tmp/station.json && mcopy -i /dev/disk/by-id/virtio-factory /tmp/station.json ::/station.json",
              "echo dev-station-token-for-vm-tests-only > /tmp/token && mcopy -i /dev/disk/by-id/virtio-factory /tmp/token ::/token",
              "fatlabel /dev/disk/by-id/virtio-factory WBFACTORY",
          )
          m.wait_until_succeeds("test -e /persist/identity/device.json", timeout=180)
          m.wait_until_succeeds(f"jq -e '.runtime.current.releaseId == \"{release}\"' /var/lib/whombat-update-helper/state.json", timeout=180)
          m.wait_until_succeeds("systemctl show -P ActiveState whombat-runtime-schema-init | grep -qx active", timeout=300)
          runtime_up(m, NEW_V)
          wait_journal(m, lambda s: s.get("current", {}).get("releaseId") == release, f"journal provisioned on {release}")
          return sh(m, "jq -r .deviceId /persist/identity/device.json")

      def populate(m, tag):
          psql(m, f"""
            insert into accounts (id, email, name) values ('acc_{tag}_1', 'mara-{tag}@example.com', 'Mara'), ('acc_{tag}_2', 'pip-{tag}@example.com', 'Pip');
            insert into burrows (id, name, slug, created_by_account_id) values ('brw_{tag}', 'Banjo’s Burrow {tag}', 'banjo-{tag}', 'acc_{tag}_1');
            insert into conversations (id, burrow_id, kind, slug, title) values ('cnv_{tag}', 'brw_{tag}', 'channel', 'general-{tag}', 'general');
            insert into messages (id, burrow_id, conversation_id, author_id, created_at, text)
              select 'msg_{tag}_' || lpad(i::text, 3, '0'), 'brw_{tag}', 'cnv_{tag}', 'acc_{tag}_' || (1 + i % 2), now(), 'Message ' || i || ': “kept” · €' || i
              from generate_series(1, 40) i;
          """)

      def fingerprint(m, tag):
          return psql(m, f"""
            select (select count(*) from accounts where id like 'acc_{tag}_%') || ':' || (select count(*) from burrows where id = 'brw_{tag}')
              || ':' || (select count(*) from conversations where id = 'cnv_{tag}') || ':' || (select count(*) from messages where id like 'msg_{tag}_%')
              || ':' || coalesce((select md5(string_agg(id || '|' || author_id || '|' || text, ',' order by id)) from messages where id like 'msg_{tag}_%'), '-');
          """)

      start_all()
      control.wait_for_unit("tuf-drill.service")
      control.wait_for_unit("restic-rest-server.socket")
      control.wait_for_open_port(4600)
      control.wait_for_open_port(8080)

      with subtest("box A: the owner's data and a backup destination"):
          machine.wait_for_unit("multi-user.target")
          device = provision(machine, "rt-a")
          populate(machine, "a")
          data = fingerprint(machine, "a")
          assert data.startswith("2:1:1:40:"), data
          machine.succeed("systemctl is-active whombat-backup-pgrole.service || systemctl start whombat-backup-pgrole.service")
          print(backup(machine, f"destination set -repository {REST} -init"))
          # The recovery kit's backup section, as the owner keeps it from the day the destination was set.
          kit = backup(machine, "kit-material")
          json.loads(kit)

      with subtest("box A: rt-fail takes a verified checkpoint, its contract migration fails, nothing changed"):
          control.succeed(f"tufrepo assign --dir ${repoDir} --device {device} --release rt-fail --seq 1 --out /tmp/a-1.json")
          control.succeed(f"curl -sf -X POST --data-binary @/tmp/a-1.json http://localhost:4600/test/assignment/{device}")
          st = wait_journal(machine, lambda s: (s.get("candidate") or {}).get("tuple", {}).get("releaseId") == "rt-fail"
                            and ((s["candidate"].get("schema") or {}).get("checkpointRef")), "rt-fail checkpointed")
          checkpoint = st["candidate"]["schema"]["checkpointRef"]
          print("checkpoint:", checkpoint, json.dumps(st["candidate"]["schema"]))
          st = wait_journal(machine, lambda s: "rt-fail" in (s.get("quarantine") or {}), "rt-fail failed and quarantined")
          for h in st.get("history", []):
              if h.get("releaseId") == "rt-fail":
                  print(f"  {h['from']} -> {h['to']}: {h.get('note') or '-'}")
          assert st["lastFailure"]["code"] == "migrate_failed", st["lastFailure"]
          assert st["current"]["releaseId"] == "rt-a", st["current"]
          runtime_up(machine, NEW_V)
          assert psql(machine, "select to_regclass('public.vmtest_contract_fails') is null") == "t"
          assert fingerprint(machine, "a") == data
          snaps = json.loads(backup(machine, "snapshots -json"))
          print("checkpoints:", json.dumps(snaps["checkpoints"]))
          assert any(c["ID"] == checkpoint for c in snaps["checkpoints"]), (checkpoint, snaps)

      with subtest("fresh box: provisioned, then the checkpoint restored with the recovery kit"):
          fresh.wait_for_unit("multi-user.target")
          provision(fresh, "rt-b")
          assert fingerprint(fresh, "a").startswith("0:0:0:0:"), fingerprint(fresh, "a")
          fresh.succeed(f"install -m 0600 /dev/stdin /root/kit.json <<'EOF'\n{kit}\nEOF")
          # restore.md: stop the runtime (the manager too: nothing may start it before the release), adopt, prepare, apply.
          fresh.succeed("systemctl stop whombat-manager.service whombat-runtime.target whombat-server.service whombat-runner.service")
          fresh.succeed("systemctl is-active whombat-backup-pgrole.service || systemctl start whombat-backup-pgrole.service")
          print(backup(fresh, "destination adopt -kit /root/kit.json"))
          admin = shlex.quote("host=/run/postgresql dbname=postgres user=postgres")
          dsn = shlex.quote("host=/run/postgresql dbname=whombat user=postgres")
          print(backup(fresh, f"quarantine prepare -admin-dsn {admin}"))
          print(backup(fresh, f"quarantine apply -snapshot {checkpoint} -dsn {dsn} -admin-dsn {admin} -check-data 100%"))
          marker = json.loads(sh(fresh, "cat /persist/backup/quarantine.json"))
          print("quarantine:", json.dumps(marker)[:3000])
          assert marker["restored"]["checkpointId"] == checkpoint, marker
          # Restored read-only, the owner's data exactly as it was before the failed migration.
          assert fingerprint(fresh, "a") == data, (fingerprint(fresh, "a"), data)
          fresh.fail("cd / && runuser -u whombat -- psql -X -d whombat -c \"insert into accounts (id, email) values ('acc_x', 'x@example.com')\"")

      with subtest("fresh box: reconciled, released, the runtime on the restored data"):
          for item, resolution in [("old-appliance", "decommissioned"), ("revocations", "none-after-checkpoint"),
                                   ("endpoints", "reviewed"), ("provider-logins", "verified"),
                                   ("external-outcomes", "none"), ("identity-repin", "repinned")]:
              backup(fresh, f"quarantine resolve -note restore-drill {item} {resolution}")
          print(backup(fresh, f"quarantine release -admin-dsn {admin}"))
          fresh.succeed("systemctl start whombat-manager.service whombat-runtime.target")
          runtime_up(fresh, NEW_V)
          assert fingerprint(fresh, "a") == data
          psql(fresh, "insert into accounts (id, email) values ('acc_after', 'after@example.com')")
    '';
}
