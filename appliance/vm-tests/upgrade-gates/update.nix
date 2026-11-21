# Gates 1, 2, 4 and 6 (NX-110, NX-113): a box installed from a previous release (its disk, ./image.nix) takes a series
# of releases as its channel lists them, through its own manager and helper and the gate repository, with the owner's
# data in the database and a backup place on the control node (a release whose migration takes a checkpoint goes only
# to boxes with one, IN-765); after each step the test checks what the box runs and that the data is intact.
#
#   { name, gate (its channel history in ./repo.nix), from (a ./release.nix release), image, steps }
#   step: { release (tuple as published: releaseId, host.storePath, runtime.{version,storePath,schemaWrites}),
#           expect = "healthy" | "rolled-back" | "refused", code ? (the refusal's code), reboot ? (whether it reboots),
#           waitsForControl ? (rolled-back: the manager ending the rollback has MG-56) }
# Step n is published as the history's step n (after the release the box starts from, and the update to a runtime-only
# `from`); a step's release is the newest of what becomes visible with it.
#
# "healthy": the release is current and known-good, the box booted its host and runs its runtime, the schema is the
# release's. "rolled-back": the release was rolled back (unhealthy) and then waits to be offered again (MG-56) or is
# quarantined (managers before it, with the gate environment's single attempt), the box is back on what it ran before, booted and
# running it, the schema not below it, and nothing re-activates the release for 30 s. "refused": quarantined with
# `code` before anything changed
# (same boot, host, runtime and schema). In every case the data written before the first step is there, unchanged.
{
  pkgs,
  lib,
  nodes,
  prelude,
}:
{
  name,
  gate,
  description,
  from,
  image,
  steps,
}:
let
  pyStr = s: builtins.toJSON s;
  pyBool = b: if b then "True" else "False";
  # A runtime-only previous release is reached from its reused release's install by a runtime-only update (NX-126):
  # that update is step 1 of the channel history, the steps follow.
  factory = if from.factory == null then from else from.factory;
  seq0 = if from.factory == null then 0 else 1;
  stepPy =
    i: s:
    let
      t = s.release;
    in
    ''
      with subtest(${pyStr "step ${toString (i + 1)}: ${t.releaseId} (${s.expect})"}):
          before = {"release": journal()["current"]["releaseId"], "boot": boot_id(), "host": booted(),
                    "runtime": runtime_profile(), "version": health()["version"], "schema": schema()}
          publish(${toString (seq0 + i + 1)}, ${pyStr t.releaseId})
          expect = ${pyStr s.expect}
          if expect == "healthy":
              st = wait_journal(settled(${pyStr t.releaseId}), ${pyStr "${t.releaseId} healthy"})
              show(st, ${pyStr t.releaseId})
              not_refused(st, ${pyStr t.releaseId})
              q = (st.get("quarantine") or {}).get(${pyStr t.releaseId})
              assert not q, f"${t.releaseId} was not installed: {q['code']}: {q.get('reason') or '-'} (the box runs {st['current']['releaseId']})"
              assert not awaiting_control(${pyStr t.releaseId})(st), f"${t.releaseId} failed verification and was rolled back: {st.get('lastFailure')}"
              assert booted() == ${pyStr t.host.storePath}, booted()
              assert runtime_profile() == ${pyStr t.runtime.storePath}, runtime_profile()
              runtime_up(${pyStr t.runtime.version})
              assert st["knownGood"]["releaseId"] == ${pyStr t.releaseId}, st["knownGood"]
              hs = helper_state()
              assert hs["runtime"]["current"]["releaseId"] == ${pyStr t.releaseId}, hs["runtime"]
              assert schema() == ${toString t.runtime.schemaWrites}, schema()
              assert (boot_id() != before["boot"]) == ${pyBool s.reboot}, "reboot expected: ${lib.boolToString s.reboot}"
              reported(${pyStr t.releaseId})
          elif expect == "rolled-back":
              # A host candidate's verification ends at activation + the reboot timeout + the verify timeout (N−1's
              # manager sets the deadline; 3 + 3 min with the gate environment's timers, 20 + 3 before MG-55, NX-126),
              # not after its reboot; then a reboot into the known-good and its verification.
              st = wait_journal(settled(${pyStr t.releaseId}), ${pyStr "${t.releaseId} rolled back"},
                                timeout=${toString ((s.rollbackAfterS or 1380) + 600)})
              show(st, ${pyStr t.releaseId})
              not_refused(st, ${pyStr t.releaseId})
              assert quarantined(${pyStr t.releaseId})(st) or awaiting_control(${pyStr t.releaseId})(st), f"${t.releaseId} was installed ({st['current']['releaseId']} runs), not rolled back"
              # From MG-56 on the manager that ends the rollback waits for the release to be offered again; before, the
              # gate environment's single attempt quarantines the release.
              if ${pyBool (s.waitsForControl or false)}:
                  assert awaiting_control(${pyStr t.releaseId})(st), ("not waiting to be offered again (MG-56)", st.get("phase"), st.get("quarantine"))
              steps = [(h["from"], h["to"]) for h in history(st, ${pyStr t.releaseId})]
              assert ("Verifying", "RolledBack") in steps, steps
              assert st["lastFailure"]["code"] == ${pyStr (s.code or "unhealthy")}, st["lastFailure"]
              assert st["current"]["releaseId"] == before["release"], st["current"]
              runtime_up(before["version"])
              assert booted() == before["host"], booted()
              assert runtime_profile() == before["runtime"], runtime_profile()
              assert schema() >= before["schema"], schema()
              watch_not_reactivated(${pyStr t.releaseId}, before["release"])
          else:
              st = wait_journal(settled(${pyStr t.releaseId}), ${pyStr "${t.releaseId} refused"})
              show(st, ${pyStr t.releaseId})
              not_refused(st, ${pyStr t.releaseId})
              q = (st.get("quarantine") or {}).get(${pyStr t.releaseId})
              assert q, f"${t.releaseId} was installed ({st['current']['releaseId']} runs), not refused"
              print("refused:", q["code"], q.get("reason") or "-")
              assert q["code"] == ${pyStr (s.code or "")}, q
              assert st["current"]["releaseId"] == before["release"], st["current"]
              assert boot_id() == before["boot"] and booted() == before["host"], (boot_id(), booted())
              assert runtime_profile() == before["runtime"] and schema() == before["schema"], (runtime_profile(), schema())
              runtime_up(before["version"])
          assert fingerprint("a") == data, (fingerprint("a"), data)
          print(f"after ${t.releaseId}: {booted()} runtime {health()['version']} schema {schema()}")
    '';
in
pkgs.testers.runNixOSTest {
  name = "whombat-upgrade-gate-${name}";
  # Several host updates with real downloads take longer than the default hour.
  globalTimeout = 3 * 3600;
  defaults.imports = [ ../common/defaults.nix ];
  nodes = {
    inherit (nodes) box control;
  };
  testScript = ''
    ${prelude}

    # ${description}
    box_overlay("${image}/disk.qcow2")
    start(${pyStr gate}, ${pyStr factory.releaseId})

    with subtest(${pyStr "first boot of ${factory.releaseId}"}):
        provisioned(${pyStr factory.releaseId}, ${pyStr factory.tuple.runtime.version})

    # Before any update: the runtime-only hop to a previous release may take a checkpoint too.
    with subtest("a backup place, for a release whose migration takes a checkpoint"):
        backup_place()

    ${lib.optionalString (from.factory != null) ''
      with subtest(${pyStr "to ${from.releaseId}, a runtime-only update, as boxes on it got there"}):
          publish(1, ${pyStr from.releaseId})
          st = wait_journal(settled(${pyStr from.releaseId}), ${pyStr "${from.releaseId} healthy"})
          show(st, ${pyStr from.releaseId})
          assert healthy_on(${pyStr from.releaseId})(st), st.get("lastFailure") or st.get("lastRefusal")
          runtime_up(${pyStr from.tuple.runtime.version})
    ''}
    with subtest(${pyStr "on ${from.releaseId}, the owner's data"}):
        assert booted() == ${pyStr from.toplevel.outPath}, booted()
        assert runtime_profile() == ${pyStr from.runtime.outPath}, runtime_profile()
        assert schema() == ${toString from.tuple.runtime.schemaWrites}, schema()
        data = populate("a")
        print("data:", data)

    ${lib.concatStrings (lib.imap0 stepPy steps)}
  '';
}
