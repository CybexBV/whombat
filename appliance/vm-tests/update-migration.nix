# Releases that migrate the database, through the real manager, helper, backup service and runtimes (MG-43, NX-103;
# the migration classes of the upgrade gates, UP-C2 5, NX-115). Direct boot, the fake control serving assignments, the
# development fixture repository republished with the releases below, whose runtimes are real bundles (placeholder
# closure indexes: the bundles are in the VM's store; ./common/migration-runtimes.nix). S is the pinned Whombat's schema,
# O the old runtime's.
#
#   rt-old       Whombat 1488be2a (candidate 0.268.0, the bridge), schema O = 77 (0076_trackers): the oldest schema from
#                which the pin's migrations are all expands whose floors it meets. The bridge's 0076_trackers is
#                incompatible (floors 77/77), so that is the pin's own schema, O = S (IN-763); before, 85eba417 at 62
#                (IN-753), and 14057e5a at the baseline before that. The factory release.
#   rt-new       the pin, schema S (expands since O, whose floors are at most O).
#   rt-new-bad   a bundle under a tuple whose runtime version it doesn't report: migrates, activates, fails
#                verification — a rollback without a broken build. The pin's (to S) when O < S; when O = S, the expanded
#                bundle's (to S+1, floors S/S), so step 2 still migrates without a checkpoint.
#   rt-expand    the pin plus a synthetic `expand` (schema S+1, floors S/S: the pin's binary reads and writes it).
#   rt-custody   the pin again, published by release custody as a rollback from rt-expand (allowDowngradeFrom, MA-21c).
#   rt-contract  the pin plus that expand and a synthetic `contract` (schema S+2, floors S+1/S+2).
#
# The box starts without a backup destination (the backup service answers “unprotected”), as the production box has.
#   1. rt-contract: the migration the runtime names needs a verified checkpoint; the update waits with the checkpoint
#      explanation and nothing changes (schema O, rt-old running and resumed).
#   2. rt-new-bad: migrated O → S (O = S: → S+1) without a checkpoint, activated, unhealthy → rolled back: the
#      known-good runtime's own check says read-write on that schema and it runs read-write there (health:
#      newer_compatible, read-write). From MG-56
#      the manager then waits for control (the release is never re-activated by itself; watched for 30 s); before, it
#      quarantines the release. The next assignment is another release, which starts as before.
#   3. The database is recreated at schema O by rt-old and populated again; rt-new: migrated (O = S: nothing to
#      migrate), activated, healthy, no checkpoint asked for, the rows kept.
#   4. rt-expand: an expand migrates S → S+1 without a checkpoint on a box without a destination; healthy, rows kept.
#   5. rt-custody: custody rolls the runtime back to the pin after the expand (UP-B2): its own check reads and writes
#      S+1 (floors S/S), it activates without a migration and is healthy, the schema stays S+1, rows kept.
#   6. With a backup destination (a restic rest-server, append-only, on the control node): rt-contract takes a
#      verified checkpoint, then migrates S+1 → S+2 and is healthy; the checkpoint is in the repository, rows kept.
# Step 5 is recorded and the test goes on to step 6 when it fails; the test fails at the end.
{
  applianceModules,
  pkgs,
  lib,
  releaseRuntime,
  # The runtime package the tested runtimes are made from, and the source whose manager runs (vm-tests/default.nix: this
  # tree; the upgrade gates: a candidate's runtime and the manager of the host it runs on, NX-125).
  migrationRuntime,
  managerSource,
  ...
}:
let
  fixtures = ../release-tools/fixtures;
  repoDir = "/srv/tuf/fixtures/dev/repo";
  rts = import ./common/migration-runtimes.nix {
    inherit pkgs lib releaseRuntime;
    runtime = migrationRuntime;
  };
  # MG-56: a release that failed after activation is rolled back and waits for control; before, it is quarantined (the
  # test's single attempt).
  waitsForControl = lib.hasInfix "afterVerificationFailure" (
    builtins.readFile (managerSource + "/manager/internal/update/engine.go")
  );
  inherit (rts) old new;
  expand = rts.expanded;
  contract = rts.contracted;
  S = rts.schema;
  O = rts.oldSchema;
  # O = S when the pin's floors are its own schema (IN-763): step 2's release is then the expand, migrating S → S+1.
  sameSchema = O == S;
  bad = if sameSchema then rts.badExpanded else rts.bad;
  badVersion = "${if sameSchema then expand.version else new.version}.bad";
  badSchema = if sameSchema then S + 1 else S;
  # The tuples name the machine's own system and manager (the helper activates a runtime only on the host its tuple
  # names), published with a placeholder host index.
  releasesFor =
    machine:
    pkgs.runCommand "whombat-update-migration-releases"
      {
        nativeBuildInputs = [
          pkgs.jq
          pkgs.nix
        ];
      }
      ''
        host=${machine.system.build.toplevel}
        mgr=${machine.whombat.manager.package}
        hostNar=sha256:$(nix-hash --type sha256 --base16 $host)
        mgrNar=sha256:$(nix-hash --type sha256 --base16 $mgr)
        mkdir -p $out/host
        echo -n "$host" > $out/host/store-path
        echo -n "$hostNar" > $out/host/nar-hash
        echo -n "$mgr" > $out/host/manager
        printf '{"placeholder":true,"storePath":"%s"}\n' $host > $out/host/artifact
        release() {
          local id=$1 rt=$2 v=$3
          local nar=sha256:$(nix-hash --type sha256 --base16 $rt)
          local s=$(bash ${../release/schema-numbers} $rt/migrations/compat.json $rt/share/whombat/release-manifest.json | cut -d' ' -f2)
          mkdir -p $out/$id
          jq --arg id $id --arg sp $rt --arg nar "$nar" --arg v "$v" --argjson s "$s" '
            .releaseId = $id
            | .runtime.storePath = $sp | .runtime.narHash = $nar | .runtime.version = $v
            | .runtime.schemaWrites = $s | .runtime.schemaReads = {min: $s, max: $s}
            | .host = {version: "vm-update-migration", storePath: $host, narHash: $hostNar, abi: .host.abi}
            | .manager = {version: .manager.version, storePath: $mgr, narHash: $mgrNar}
            | .providers = []' --arg host $host --arg hostNar "$hostNar" --arg mgr $mgr --arg mgrNar "$mgrNar" \
            ${fixtures}/dev/valid/targets/releases/*.rt-fixture-1.json > $out/$id/tuple.json
          echo -n "$nar" > $out/$id/nar-hash
          echo -n "$v" > $out/$id/version
          echo -n "$rt" > $out/$id/store-path
          printf '{"placeholder":true,"release":"%s","storePath":"%s"}\n' $id $rt > $out/$id/artifact
        }
        release rt-old ${old} ${old.version}
        release rt-contract ${contract} ${contract.version}
        release rt-new-bad ${bad} ${badVersion}
        release rt-new ${new} ${new.version}
        release rt-expand ${expand} ${expand.version}
        release rt-custody ${new} ${new.version}
      '';
in
{
  name = "whombat-update-migration";

  nodes = {
    control =
      { nodes, ... }:
      let
        releases = releasesFor nodes.machine;
      in
      {
      imports = [ ./common/control.nix ];
      environment.systemPackages = [
        pkgs.whombat-release-tools
        pkgs.restic
      ];
      # The backup destination of step 6 (as sandbox-backup): an append-only rest-server on the test network.
      services.restic.server = {
        enable = true;
        listenAddress = "8000";
        appendOnly = true;
        extraFlags = [ "--no-auth" ];
      };
      networking.firewall.allowedTCPPorts = [ 8000 ];
      systemd.services.tuf-fixtures.enable = lib.mkForce false;
      systemd.services.tuf-update = {
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
          h=${releases}/host
          tufrepo add-index --dir ${repoDir} --kind host --target host/vm-update-migration/whombat-host.index.json \
            --file $h/artifact --version vm-update-migration --store-path "$(cat $h/store-path)" \
            --nar-hash "$(cat $h/nar-hash)" --manager-store-path "$(cat $h/manager)"
          for id in rt-old rt-contract rt-new-bad rt-new rt-expand; do
            r=${releases}/$id
            tufrepo add-index --dir ${repoDir} --kind runtime --target "runtime/$(cat $r/version)/whombat-runtime.index.json" \
              --file $r/artifact --version "$(cat $r/version)" --store-path "$(cat $r/store-path)" --nar-hash "$(cat $r/nar-hash)"
            tufrepo add-release --dir ${repoDir} --tuple $r/tuple.json
          done
          # The custody rollback: rt-new's runtime (published above) as a release devices on rt-expand may move back to.
          # Release tools before MG-44 can't say so; the release is then published plain and step 5 fails at the
          # forward check, as it should.
          if grep -q allow-downgrade-from "$(command -v tufrepo)"; then
            tufrepo add-release --dir ${repoDir} --tuple ${releases}/rt-custody/tuple.json --allow-downgrade-from rt-expand
          else
            tufrepo add-release --dir ${repoDir} --tuple ${releases}/rt-custody/tuple.json
          fi
        '';
        serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server 8080 --directory ${repoDir}";
      };
      };
    machine = {
      imports = applianceModules ++ [ (import ./common/appliance-vm.nix { serial = "SN-UM-0001"; }) ];
      whombat.runtime.package = old;
      # The candidates' bundles are in the store already (nothing downloads or stages the placeholders).
      system.extraDependencies = [
        new
        bad
        expand
        contract
      ];
      whombat.network.outboundTcpPorts = lib.mkForce [
        443
        4600
        8000
        8080
      ];
      # The backup service keeps 2 GiB free for its staging (W3-BK reserveBytes): a larger /persist than the default.
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
      environment.systemPackages = [
        pkgs.restic
        pkgs.socat
      ];
      whombat.manager.tuf = {
        metadataUrl = lib.mkForce "http://control:8080/metadata/";
        targetsUrl = lib.mkForce "http://control:8080/targets/";
      };
      # Poll the fake control every 5 s; short health checks. The verification window is 4 min: the known-good
      # runtime's own start after a rollback (Hermes's check with the plugin) takes over a minute under emulation,
      # where a host without KVM runs the gates, and a window it outlasts reads as known_good_unhealthy.
      whombat.manager.settings = {
        pollSec = 5;
        policy = {
          healthIntervalMs = 3000;
          verifyTimeoutMs = 240000;
          drainPollMs = 2000;
          retryBaseMs = 5000;
          idleIntervalMs = 3000;
          healthyStreak = 2;
          maxAttempts = 1;
        };
      };
      virtualisation.memorySize = 3072;
      virtualisation.diskSize = 4096;
    };
  };

  testScript =
    { nodes, ... }:
    ''
    import datetime, json, time

    # Plain HTTP to a destination only on a numeric private address (BK-29).
    REST = "rest:http://${nodes.control.networking.primaryIPAddress}:8000/whombat"
    OLD, NEW, EXPAND, CONTRACT = "${old}", "${new}", "${expand}", "${contract}"
    OLD_V, NEW_V, EXPAND_V, CONTRACT_V = "${old.version}", "${new.version}", "${expand.version}", "${contract.version}"
    S = ${toString S}
    O = ${toString O}
    # The schema rt-new-bad migrates to: S, or S+1 when O = S (the expand).
    S_BAD = ${toString badSchema}
    SAME_SCHEMA = ${if sameSchema then "True" else "False"}
    WAITS_FOR_CONTROL = ${if waitsForControl then "True" else "False"}
    ACTIVE = {"Assigned", "Downloading", "Verified", "Staged", "WaitingForSafeBoundary", "Activating", "Verifying"}

    def when(h):
        return datetime.datetime.fromisoformat(h["at"])

    soft_failures = []

    def sh(cmd):
        return machine.succeed(cmd).strip()

    def psql(q):
        return sh(f"runuser -u whombat -- psql -X -A -t -d whombat -c \"{q}\"")

    def schema():
        return int(psql("select coalesce(max(version), 0) from whombat_meta.schema_versions"))

    def health():
        return json.loads(sh("runuser -u whombat-manager -- curl -sf --max-time 10 --unix-socket /run/whombat/admin.sock http://runtime/health"))

    def journal() -> dict:
        best: dict = {"seq": -1, "state": {}}
        for f in ["journal.a.json", "journal.b.json"]:
            code, out = machine.execute(f"cat /persist/manager/journal/{f}")
            if code == 0 and out.strip():
                r = json.loads(out)
                if r["seq"] > best["seq"]:
                    best = r
        return best["state"]

    def wait_journal(pred, what, timeout=600):
        last = {}
        def ok(_):
            nonlocal last
            last = journal()
            return pred(last)
        try:
            retry(ok, timeout_seconds=timeout)
        except Exception:
            print("journal:", json.dumps(last, indent=1)[:20000])
            print(machine.succeed("journalctl -u whombat-manager -u whombat-update-helper -u whombat-backup-api --no-pager | tail -80"))
            raise Exception(f"timed out waiting for: {what}")
        return last

    def history(st, rid):
        return [h for h in st.get("history", []) if h.get("releaseId") == rid]

    def show(st, rid):
        for h in history(st, rid):
            print(f"{h['from']} -> {h['to']}: {h.get('note') or '-'}")

    def assign(rid, seq):
        control.succeed(f"tufrepo assign --dir ${repoDir} --device {device} --release {rid} --seq {seq} --out /tmp/a-{seq}.json")
        control.succeed(f"curl -sf -X POST --data-binary @/tmp/a-{seq}.json http://localhost:4600/test/assignment/{device}")

    def populate(tag):
        psql(f"insert into accounts (id, email, name) values ('acc_{tag}_1', 'mara-{tag}@example.com', 'Mara'), ('acc_{tag}_2', 'pip-{tag}@example.com', 'Pip')")
        psql(f"insert into burrows (id, name, slug, created_by_account_id) values ('brw_{tag}', 'HQ {tag}', 'hq-{tag}', 'acc_{tag}_1')")

    def collections():
        return int(sh("journalctl -u whombat-manager -o cat | grep -c -e 'store collected after the update' -e 'collecting the store failed' || true"))

    def end_store_collection(before):
        # After an update turns Healthy the manager collects the store and takes no other step until that ends (UP-X19).
        # The VM's store is the host's, shared: `nix-store --gc` there walks the host's whole store and runs to its 30-min
        # bound, where a box's own store takes seconds. So the test ends it (the manager logs that it failed and goes on).
        def done(_):
            if collections() > before:
                return True
            print(machine.execute("systemctl status whombat-store-gc.scope --no-pager 2>&1 | head -4")[1])
            machine.execute("systemctl stop whombat-store-gc.scope")
            return False
        retry(done, timeout_seconds=180)

    def rows(tag):
        return int(psql(f"select count(*) from accounts where id like 'acc_{tag}_%'")) + int(psql(f"select count(*) from burrows where id = 'brw_{tag}'"))

    def runtime_up(expect_version):
        machine.wait_until_succeeds(
            "runuser -u whombat-manager -- curl -sf --unix-socket /run/whombat/admin.sock http://runtime/health"
            f" | jq -e '.status == \"ok\" and .version == \"{expect_version}\"'",
            timeout=240,
        )

    start_all()
    control.wait_for_unit("tuf-update.service")
    control.wait_for_open_port(4600)
    control.wait_for_open_port(8080)
    machine.wait_for_unit("multi-user.target")

    with subtest("factory provisioning on rt-old; its runtime creates schema O on the empty database"):
        station = json.dumps({
            "v": 1, "environment": "dev", "controlUrl": "http://control:4600", "tokenFile": "token",
            "model": "whombat-one", "requireSecureBoot": False, "factoryRelease": "rt-old",
        })
        machine.succeed(
            "mkfs.vfat /dev/disk/by-id/virtio-factory",
            f"echo '{station}' > /tmp/station.json && mcopy -i /dev/disk/by-id/virtio-factory /tmp/station.json ::/station.json",
            "echo dev-station-token-for-vm-tests-only > /tmp/token && mcopy -i /dev/disk/by-id/virtio-factory /tmp/token ::/token",
            "fatlabel /dev/disk/by-id/virtio-factory WBFACTORY",
        )
        machine.wait_until_succeeds("test -e /persist/identity/device.json", timeout=120)
        device = sh("jq -r .deviceId /persist/identity/device.json")
        # The helper is seeded with the factory tuple (it names this system): the runtime a rollback returns to.
        machine.wait_until_succeeds("jq -e '.runtime.current.releaseId == \"rt-old\"' /var/lib/whombat-update-helper/state.json", timeout=120)
        machine.wait_until_succeeds("systemctl show -P ActiveState whombat-runtime-schema-init | grep -qx active", timeout=240)
        assert schema() == O, schema()
        runtime_up(OLD_V)
        assert sh("readlink -f /nix/var/nix/profiles/whombat-runtime") == OLD
        st = wait_journal(lambda s: s.get("current", {}).get("releaseId") == "rt-old", "journal provisioned on rt-old")
        populate("a")
        assert rows("a") == 3
        # No backup destination: the backup service refuses checkpoints as unprotected.
        print(sh("curl -s --unix-socket /run/whombat-backup/api.sock http://backup/v1/status || true"))

    with subtest("rt-contract: the contract migration needs a checkpoint; without a destination it waits, nothing changed"):
        assign("rt-contract", 1)
        st = wait_journal(lambda s: (s.get("candidate") or {}).get("tuple", {}).get("releaseId") == "rt-contract"
                          and ((s["candidate"].get("deferral") or {}).get("waiting") == "checkpoint")
                          and not s["candidate"]["deferral"].get("draining"), "rt-contract waiting for a checkpoint")
        c = st["candidate"]
        print("plan:", json.dumps(c["schema"]))
        print("explanation:", c["deferral"]["explanation"])
        assert st["phase"] == "WaitingForSafeBoundary", st["phase"]
        assert c["schema"]["needsMigration"] and c["schema"]["rollbackAccess"] == "none", c["schema"]
        assert c["schema"]["target"]["version"] == S + 2 and c["schema"]["target"]["writers"] == S + 2, c["schema"]
        assert any(m.endswith("_vmtest_contract") for m in c["schema"]["needsCheckpoint"]), c["schema"]
        ex = c["deferral"]["explanation"]
        assert "verified checkpoint" in ex and "Nothing was changed" in ex, ex
        assert schema() == O, schema()
        assert sh("readlink -f /nix/var/nix/profiles/whombat-runtime") == OLD
        runtime_up(OLD_V)
        assert not health().get("draining"), health()
        assert rows("a") == 3

    with subtest("rt-new-bad: migrated without a checkpoint, activated, unhealthy, rolled back; rt-old runs read-write on its schema"):
        assign("rt-new-bad", 2)
        st = wait_journal(lambda s: (s.get("candidate") or {}).get("tuple", {}).get("releaseId") == "rt-new-bad"
                          and ((s["candidate"].get("schema") or {}).get("checked")), "rt-new-bad schema checked")
        plan = st["candidate"]["schema"]
        print("plan:", json.dumps(plan))
        assert plan["needsMigration"] and plan["rollbackAccess"] == "read-write" and plan["rollbackCompatible"], plan
        assert plan["target"] == {"version": S_BAD, "readers": O, "writers": O}, plan
        assert not plan.get("needsCheckpoint"), plan
        # Activated on the migrated database: no checkpoint was taken (on this box it would have waited for ever).
        st = wait_journal(lambda s: s["phase"] == "Verifying" and s["candidate"]["tuple"]["releaseId"] == "rt-new-bad", "rt-new-bad verifying")
        plan = st["candidate"]["schema"]
        assert plan["migrated"] and not plan.get("checkpointRef") and plan["databaseVersion"] == S_BAD, plan
        assert schema() == S_BAD, schema()
        # MG-56: rolled back and waiting for control (the release kept as the candidate, failed after activation);
        # managers before it quarantine it (one attempt here).
        def awaiting_control(s):
            c = s.get("candidate") or {}
            return (s.get("phase") == "RolledBack" and (c.get("tuple") or {}).get("releaseId") == "rt-new-bad"
                    and bool((c.get("failure") or {}).get("afterActivation")))
        # The verification window, then the rollback's own (each up to 4 min).
        st = wait_journal(lambda s: "rt-new-bad" in (s.get("quarantine") or {}) or awaiting_control(s), "rt-new-bad rolled back", timeout=900)
        show(st, "rt-new-bad")
        if WAITS_FOR_CONTROL:
            assert awaiting_control(st), ("not waiting for control (MG-56)", st.get("phase"), st.get("quarantine"))
        else:
            assert "rt-new-bad" in (st.get("quarantine") or {}), st.get("phase")
        steps = [(h["from"], h["to"]) for h in history(st, "rt-new-bad")]
        assert ("WaitingForSafeBoundary", "Activating") in steps and ("Activating", "Verifying") in steps, steps
        assert ("Verifying", "RolledBack") in steps, steps
        assert st["lastFailure"]["code"] == "unhealthy" and st["lastFailure"]["knownGoodAccess"] == "read-write", st["lastFailure"]
        assert st["current"]["releaseId"] == "rt-old", st["current"]
        assert schema() == S_BAD, schema()
        assert sh("readlink -f /nix/var/nix/profiles/whombat-runtime") == OLD
        runtime_up(OLD_V)
        h = health()
        print("known-good health:", json.dumps(h))
        m = h["checks"]["migrations"]
        assert m["schemaVersion"] == S_BAD and m["access"] == "read-write" and m["verdict"] == "newer_compatible", m
        assert rows("a") == 3
        # The old binary's own check, as the helper runs it: read-write on the migrated schema, floors O/O recorded.
        out = machine.succeed(f"cd / && runuser -u whombat -- env NODE_ENV=production WHOMBAT_MODE=managed WHOMBAT_ENV_FILE=/etc/whombat/runtime.env {OLD}/bin/whombat schema-check --json --env || true")
        chk = json.loads(out)
        assert chk["verdict"] == "newer_compatible" and chk["access"] == "read-write", chk
        assert chk["database"]["readers"] == O and chk["database"]["writers"] == O, chk
        # Nothing re-activates it from local state (MG-56): a retry would come after the retry interval (5 s here).
        since = max(when(h) for h in history(st, "rt-new-bad") if h["to"] == "RolledBack")
        for _ in range(6):
            again = [h for h in history(journal(), "rt-new-bad") if when(h) > since and h["to"] in ACTIVE]
            assert not again, f"rt-new-bad was re-activated after its rollback: {again}"
            time.sleep(5)

    with subtest("schema O again: the database recreated by rt-old and populated"):
        machine.succeed("systemctl stop whombat-runtime.target whombat-server whombat-runner")
        machine.succeed("runuser -u postgres -- dropdb whombat", "runuser -u postgres -- createdb -O whombat whombat")
        machine.succeed("systemctl restart whombat-runtime-schema-init")
        assert schema() == O, schema()
        machine.succeed("systemctl reset-failed whombat-server whombat-runner || true", "systemctl start whombat-runtime.target")
        runtime_up(OLD_V)
        populate("b")
        assert rows("b") == 3

    with subtest("rt-new: on S (migrated when O < S), activated, healthy, no checkpoint asked for"):
        gc = collections()
        assign("rt-new", 3)
        st = wait_journal(lambda s: (s.get("candidate") or {}).get("tuple", {}).get("releaseId") == "rt-new"
                          and ((s["candidate"].get("schema") or {}).get("checked")), "rt-new schema checked")
        plan = st["candidate"]["schema"]
        if SAME_SCHEMA:
            # The pin on its own schema: nothing to migrate.
            assert not plan["needsMigration"] and plan["databaseVersion"] == S, plan
        else:
            assert plan["needsMigration"] and plan["databaseVersion"] == O and plan["rollbackAccess"] == "read-write", plan
        st = wait_journal(lambda s: s["phase"] == "Verifying" and s["candidate"]["tuple"]["releaseId"] == "rt-new", "rt-new verifying")
        plan = st["candidate"]["schema"]
        assert plan["migrated"] != SAME_SCHEMA and not plan.get("checkpointRef") and plan["databaseVersion"] == S, plan
        st = wait_journal(lambda s: s["phase"] == "Healthy" and s["current"]["releaseId"] == "rt-new", "rt-new healthy")
        end_store_collection(gc)
        show(st, "rt-new")
        notes = [h.get("note") or "" for h in history(st, "rt-new")]
        assert "candidate verified healthy" in notes, notes
        assert schema() == S, schema()
        assert sh("readlink -f /nix/var/nix/profiles/whombat-runtime") == NEW
        runtime_up(NEW_V)
        m = health()["checks"]["migrations"]
        assert m["schemaVersion"] == S and m["access"] == "read-write" and m["verdict"] == "current", m
        assert rows("b") == 3
        # The contract candidate never ran: its table isn't there.
        assert psql("select to_regclass('public.vmtest_contract') is null") == "t"
        # What control heard (update.progress): the last reports end with rt-new healthy.
        def reported(_):
            ps = json.loads(control.succeed("curl -sf http://localhost:4600/test/progress"))
            return bool(ps) and ps[-1].get("state") == "Healthy" and ps[-1].get("current") == "rt-new"
        retry(reported, timeout_seconds=120)
        for p in json.loads(control.succeed("curl -sf http://localhost:4600/test/progress"))[-8:]:
            print("progress:", json.dumps(p)[:300])

    with subtest("rt-expand: an expand migrates S → S+1 without a checkpoint, on a box without a destination"):
        gc = collections()
        assign("rt-expand", 4)
        st = wait_journal(lambda s: s["phase"] == "Healthy" and s["current"]["releaseId"] == "rt-expand", "rt-expand healthy")
        end_store_collection(gc)
        show(st, "rt-expand")
        # No destination: had a checkpoint been asked for, the update would still be waiting.
        assert schema() == S + 1, schema()
        assert sh("readlink -f /nix/var/nix/profiles/whombat-runtime") == EXPAND
        runtime_up(EXPAND_V)
        m = health()["checks"]["migrations"]
        assert m["schemaVersion"] == S + 1 and m["access"] == "read-write" and m["verdict"] == "current", m
        assert rows("b") == 3

    with subtest("rt-custody: custody rolls the runtime back to the pin after the expand; it reads and writes S+1 (UP-B2)"):
        try:
            gc = collections()
            assign("rt-custody", 5)
            st = wait_journal(lambda s: (s["phase"] == "Healthy" and s["current"]["releaseId"] == "rt-custody")
                              or "rt-custody" in (s.get("quarantine") or {}), "rt-custody healthy or refused", timeout=600)
            if st["phase"] == "Healthy":
                end_store_collection(gc)
            show(st, "rt-custody")
            q = (st.get("quarantine") or {}).get("rt-custody")
            assert not q, f"rt-custody refused: {q['code']}: {q.get('reason') or '-'}"
            assert schema() == S + 1, schema()
            assert sh("readlink -f /nix/var/nix/profiles/whombat-runtime") == NEW
            runtime_up(NEW_V)
            m = health()["checks"]["migrations"]
            assert m["schemaVersion"] == S + 1 and m["access"] == "read-write" and m["verdict"] == "newer_compatible", m
            steps = [(h["from"], h["to"]) for h in history(st, "rt-custody")]
            assert not any(n and n.startswith("migrat") for n in [h.get("note") for h in history(st, "rt-custody")]), steps
            assert rows("b") == 3
        except Exception as e:
            print(f"SOFT FAILURE (custody rollback after an expand, UP-B2): {e}")
            soft_failures.append(f"rt-custody: {e}")

    with subtest("rt-contract with a backup destination: a verified checkpoint, then S+1 → S+2, healthy"):
        machine.succeed("systemctl is-active whombat-backup-pgrole.service || systemctl start whombat-backup-pgrole.service")
        control.wait_for_unit("restic-rest-server.socket")
        # As root at the console (backup.md, BK-24).
        out = machine.succeed(
            "cd / && whombat-backup -config $(systemctl cat whombat-backup | grep -o '/nix/store/[^ ]*whombat-backup.json' | head -1)"
            f" destination set -repository {REST} -init 2>&1"
        )
        print(out)
        before = journal()["current"]["releaseId"]
        assign("rt-contract", 6)
        st = wait_journal(lambda s: (s.get("candidate") or {}).get("tuple", {}).get("releaseId") == "rt-contract"
                          and ((s["candidate"].get("schema") or {}).get("checked")), "rt-contract schema checked")
        plan = st["candidate"]["schema"]
        print("plan:", json.dumps(plan))
        assert plan["needsMigration"] and any(m.endswith("_vmtest_contract") for m in plan["needsCheckpoint"]), plan
        assert plan["target"]["version"] == S + 2, plan
        # The checkpoint first (at the safe boundary), then the migration.
        st = wait_journal(lambda s: ((s.get("candidate") or {}).get("schema") or {}).get("checkpointRef")
                          or s["phase"] == "Healthy" or "rt-contract" in (s.get("quarantine") or {}), "rt-contract checkpointed")
        checkpoint = ((st.get("candidate") or {}).get("schema") or {}).get("checkpointRef")
        assert checkpoint, ("no checkpoint was taken", st.get("phase"), st.get("lastFailure"))
        print("checkpoint:", checkpoint)
        st = wait_journal(lambda s: s["phase"] == "Healthy" and s["current"]["releaseId"] == "rt-contract"
                          or "rt-contract" in (s.get("quarantine") or {}), "rt-contract healthy")
        show(st, "rt-contract")
        assert st["current"]["releaseId"] == "rt-contract", (before, st.get("lastFailure"))
        assert schema() == S + 2, schema()
        assert psql("select to_regclass('public.vmtest_contract') is not null") == "t"
        runtime_up(CONTRACT_V)
        assert rows("b") == 3
        # The checkpoint the manager asked for is in the repository, and the backup service lists it.
        snaps = machine.succeed(
            "cd / && whombat-backup -config $(systemctl cat whombat-backup | grep -o '/nix/store/[^ ]*whombat-backup.json' | head -1)"
            " snapshots -json"
        )
        print("checkpoints:", snaps)
        assert any(c["ID"] == checkpoint for c in json.loads(snaps)["checkpoints"]), (checkpoint, snaps)
        assert int(control.succeed("ls /var/lib/restic/whombat/snapshots | wc -l").strip()) >= 1

    if soft_failures:
        raise Exception("failed: " + "; ".join(soft_failures))
    '';
}
