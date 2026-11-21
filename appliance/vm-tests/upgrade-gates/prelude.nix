# Python shared by the gate tests (NX-110): the box's disk, provisioning, the manager's journal (followed across the
# reboots the update helper schedules), releases published into the box's channel, and the owner's data.
{ pkgs }:
''
  import datetime, json, os, queue, re, subprocess, time

  QEMU_IMG = "${pkgs.qemu_test}/bin/qemu-img"
  TMP = os.environ.get("TMPDIR", "/tmp")


  def box_overlay(image, name="box"):
      """A copy-on-write overlay of an installed disk (a store path), the box's disk from now on."""
      disk = os.path.join(TMP, f"{name}.qcow2")
      if os.path.exists(disk):
          os.unlink(disk)
      subprocess.run([QEMU_IMG, "create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", image, disk], check=True)
      os.environ["WB_BOX_DISK"] = disk
      return disk


  def blank_disk(name="box", size="128G"):
      disk = os.path.join(TMP, f"{name}.qcow2")
      if os.path.exists(disk):
          os.unlink(disk)
      subprocess.run([QEMU_IMG, "create", "-q", "-f", "qcow2", disk, size], check=True)
      os.environ["WB_BOX_DISK"] = disk
      return disk


  def sh(cmd, timeout=900):
      return box.succeed(cmd, timeout=timeout).strip()


  def sql(q):
      """Run SQL as the runtime's database user (stdin, so nothing is expanded by a shell)."""
      return box.succeed(f"cd / && runuser -u whombat -- psql -X -A -t -q -v ON_ERROR_STOP=1 -d whombat <<'WBSQL'\n{q}\nWBSQL").strip()


  def schema():
      return int(sql("select coalesce(max(version), 0) from whombat_meta.schema_versions"))


  def health():
      return json.loads(sh("runuser -u whombat-manager -- curl -sf --max-time 10 --unix-socket /run/whombat/admin.sock http://runtime/health"))


  def runtime_up(version, timeout=600):
      box.wait_until_succeeds(
          "runuser -u whombat-manager -- curl -sf --max-time 10 --unix-socket /run/whombat/admin.sock http://runtime/health"
          f" | jq -e '.status == \"ok\" and .version == \"{version}\"'",
          timeout=timeout,
      )


  def booted():
      return sh("readlink -f /run/current-system")


  def runtime_profile():
      return sh("readlink -f /nix/var/nix/profiles/whombat-runtime")


  def boot_id():
      return sh("cat /proc/sys/kernel/random/boot_id")


  def journal():
      best = {"seq": -1, "state": {}}
      for f in ["journal.a.json", "journal.b.json"]:
          code, out = box.execute(f"cat /persist/manager/journal/{f}", timeout=60)
          if code == 0 and out.strip():
              try:
                  r = json.loads(out)
              except ValueError:
                  continue
              if r["seq"] > best["seq"]:
                  best = r
      return best["state"]


  def helper_state():
      return json.loads(sh("cat /var/lib/whombat-update-helper/state.json"))


  BOOTS = []


  def kernel_started(timeout=900):
      """Wait for the box's kernel on its serial console. The driver's connect() waits for the backdoor for ever, so a
      box stuck before its kernel (seen in the firmware's boot stub on a host at a load of 200) would hold a gate until
      its global timeout; this fails it after `timeout` seconds instead. Each boot's line is consumed by the wait for
      it, so a wait matches the next boot's."""
      buf, end = "", time.monotonic() + timeout
      while time.monotonic() < end:
          try:
              while True:
                  buf += box.last_lines.get_nowait() + "\n"
          except queue.Empty:
              pass
          if "Linux version" in buf:
              return
          buf = buf[-20000:]
          time.sleep(0.5)
      raise Exception(f"the box's kernel didn't start within {timeout} s (stuck in its firmware or boot loader)")


  def follow_reboot():
      """The update helper scheduled `systemctl reboot` (whombat-reboot.timer, 10 s): wait for the next boot's shell."""
      print("the update helper scheduled a reboot; following it")
      box.connected = False
      kernel_started()
      box.connect()
      BOOTS.append(boot_id())
      print(f"booted {booted()} (boot {len(BOOTS)})")


  def reboot_pending():
      code, _ = box.execute("systemctl is-active --quiet whombat-reboot.timer", timeout=60)
      return code == 0


  def dump():
      code, out = box.execute("journalctl -b -u whombat-manager -u whombat-update-helper -u whombat-self-provision -u whombat-boot-assessment --no-pager | tail -150", timeout=120)
      print(out)
      print("journal:", json.dumps(journal(), indent=1)[:30000])


  def wait_journal(pred, what, timeout=2400):
      """Poll the manager's journal until pred holds, following the reboots the update helper schedules (and any other
      reboot: a boot assessment that fails on a counted entry reboots at once, NX-05)."""
      end = time.monotonic() + timeout
      last = {}
      while time.monotonic() < end:
          try:
              if reboot_pending():
                  follow_reboot()
                  continue
              last = journal()
          except Exception as e:
              print(f"lost the box's shell ({e}); waiting for the next boot")
              follow_reboot()
              continue
          if pred(last):
              return last
          time.sleep(3)
      dump()
      raise Exception(f"timed out after {timeout}s waiting for: {what} (phase {last.get('phase')})")


  def history(st, rid):
      return [h for h in st.get("history", []) if h.get("releaseId") == rid]


  def show(st, rid):
      for h in history(st, rid):
          print(f"  {rid}: {h['from']} -> {h['to']}: {h.get('note') or '-'}")


  def healthy_on(rid):
      return lambda s: s.get("phase") == "Healthy" and (s.get("current") or {}).get("releaseId") == rid and not s.get("candidate")


  def quarantined(rid):
      return lambda s: rid in (s.get("quarantine") or {}) and not s.get("candidate")


  def refused_offer(rid):
      """The manager refused the offer itself (e.g. the forward check): nothing is quarantined, it says why."""
      return lambda s: re.search(re.escape(rid) + r"(?![A-Za-z0-9._-])", s.get("lastRefusal") or "") is not None


  def awaiting_control(rid):
      """Rolled back after it was activated, and waiting to be offered again (MG-56): by control, or on a channel by
      its owner's check; the channel's same release is no new offer."""
      def p(s):
          c = s.get("candidate") or {}
          return (s.get("phase") == "RolledBack" and (c.get("tuple") or {}).get("releaseId") == rid
                  and bool((c.get("failure") or {}).get("afterActivation")))
      return p


  def settled(rid):
      """Healthy, quarantined, rolled back and waiting to be offered again, or its offer refused: waiting changes nothing."""
      return lambda s: (healthy_on(rid)(s) or quarantined(rid)(s) or awaiting_control(rid)(s)
                        or refused_offer(rid)(s))


  def when(h):
      return datetime.datetime.fromisoformat(h["at"])


  ACTIVE = {"Assigned", "Downloading", "Verified", "Staged", "WaitingForSafeBoundary", "Activating", "Verifying"}


  def watch_not_reactivated(rid, before_release, seconds=30):
      """MG-56: after its rollback the release is never re-activated from local state, although the channel still lists
      it as its newest and the box looks every 10 s (./gate-env.nix): a release is offered once. A manager that retries
      by itself does so after its retry interval (5 s here): 30 s is six of them (NX-126)."""
      st = journal()
      since = max(when(h) for h in history(st, rid) if h["to"] == "RolledBack")
      end = time.monotonic() + seconds
      while time.monotonic() < end:
          st = journal()
          again = [h for h in history(st, rid) if when(h) > since and h["to"] in ACTIVE]
          assert not again, f"{rid} was re-activated from local state after its rollback (MG-56): {again}"
          assert st["current"]["releaseId"] == before_release, st["current"]
          time.sleep(5)
      print(f"{rid}: not re-activated in the {seconds} s after its rollback (phase {st.get('phase')})")


  def not_refused(st, rid):
      assert not refused_offer(rid)(st), f"the offer of {rid} was refused: {st.get('lastRefusal')}"


  DEVICE = None


  def provisioned(release, runtime_version):
      """First boot of an installed disk: the box's own identity, the factory tuple as its channel lists it, the runtime
      on its schema."""
      global DEVICE
      box.wait_for_unit("multi-user.target", timeout=1200)
      box.wait_until_succeeds("test -e /persist/identity/device.json", timeout=900)
      box.wait_until_succeeds("systemctl show -P ActiveState whombat-self-provision | grep -qx inactive", timeout=600)
      print(sh("journalctl -u whombat-self-provision --no-pager | tail -40"))
      assert sh("systemctl show -P Result whombat-self-provision") == "success"
      DEVICE = sh("jq -r .deviceId /persist/identity/device.json")
      box.wait_until_succeeds(f"jq -e '.runtime.current.releaseId == \"{release}\"' /var/lib/whombat-update-helper/state.json", timeout=300)
      box.wait_until_succeeds("systemctl show -P ActiveState whombat-runtime-schema-init | grep -qx active", timeout=600)
      runtime_up(runtime_version)
      st = wait_journal(lambda s: (s.get("current") or {}).get("releaseId") == release, f"the journal provisioned on {release}", timeout=600)
      BOOTS.append(boot_id())
      print(f"device {DEVICE} on {release}: phase {st.get('phase')}, schema {schema()}, booted {booted()}")
      return st


  def publish(step, what):
      """The gate's next step becomes visible in the box's channel (./repo.nix, ./nodes.nix): the role metadata of
      that step, snapshot and timestamp signed as the repository's workflow signs them. The box looks every 10 s and
      takes the newest release the channel lists."""
      print(control.succeed(f"gate-publish {step}"))
      print(f"published {what} (step {step})")


  def backup_place():
      """The box's backup place on the control node (plain HTTP to a numeric private address, BK-29): an update whose
      migration takes a checkpoint waits for ever without one (MD-06), and promote-prod refuses to send such a release
      to a box that has none."""
      sh("systemctl is-active whombat-backup-pgrole.service || systemctl start whombat-backup-pgrole.service")
      control.wait_for_unit("restic-rest-server.socket")
      # As root at the console (backup.md, BK-24).
      print(sh("cd / && whombat-backup -config $(systemctl cat whombat-backup | grep -o '/nix/store/[^ ]*whombat-backup.json' | head -1)"
               " destination set -repository rest:http://192.168.1.2:8000/whombat -init 2>&1"))


  def populate(tag):
      """The owner's data, written as the runtime's database user: people, a burrow, a channel and its messages."""
      sql(f"""
        insert into accounts (id, email, name) values ('acc_{tag}_1', 'mara-{tag}@example.com', 'Mara'), ('acc_{tag}_2', 'pip-{tag}@example.com', 'Pip');
        insert into burrows (id, name, slug, created_by_account_id) values ('brw_{tag}', 'Banjo’s Burrow {tag}', 'banjo-{tag}', 'acc_{tag}_1');
        insert into conversations (id, burrow_id, kind, slug, title) values ('cnv_{tag}', 'brw_{tag}', 'channel', 'general-{tag}', 'general');
        insert into messages (id, burrow_id, conversation_id, author_id, created_at, text)
          select 'msg_{tag}_' || lpad(i::text, 3, '0'), 'brw_{tag}', 'cnv_{tag}', 'acc_{tag}_' || (1 + i % 2), now(), 'Message ' || i || ': “kept” · €' || i
          from generate_series(1, 40) i;
      """)
      fp = fingerprint(tag)
      assert fp.startswith("2:1:1:40:"), fp
      return fp


  def fingerprint(tag):
      return sql(f"""
        select (select count(*) from accounts where id like 'acc_{tag}_%') || ':' || (select count(*) from burrows where id = 'brw_{tag}')
          || ':' || (select count(*) from conversations where id = 'cnv_{tag}') || ':' || (select count(*) from messages where id like 'msg_{tag}_%')
          || ':' || (select md5(string_agg(id || '|' || author_id || '|' || text, ',' order by id)) from messages where id like 'msg_{tag}_%');
      """)


  def reported(rid, state="Healthy"):
      """What the box has to tell control (update.progress): its newest report names rid in state. The box isn't
      linked, so nothing is sent (control heard nothing) and the report waits in the manager's outbox."""
      def newest():
          code, out = box.execute("cat /persist/manager/journal/progress-outbox-v2.json", timeout=60)
          entries = json.loads(out).get("entries", []) if code == 0 and out.strip() else []
          return entries[-1]["report"] if entries else {}
      def ok(_):
          r = newest()
          return r.get("state") == state and r.get("current") == rid
      try:
          retry(ok, timeout_seconds=300)
      except Exception:
          print("outbox:", box.execute("cat /persist/manager/journal/progress-outbox-v2.json", timeout=60)[1][-3000:])
          raise
      heard = json.loads(control.succeed("curl -sf http://localhost:4600/test/progress"))
      assert not heard, f"control heard from a box that isn't linked: {heard[-3:]}"


  def start(gate, first):
      """The control node with the gate's channel history, its first step published (the release the box was installed
      from: a first start reads its release from its channel), then the box."""
      control.start()
      control.wait_for_unit("nginx.service")
      control.wait_for_open_port(443)
      control.wait_for_open_port(4600)
      control.succeed(f"gate-serve {gate}")
      publish(0, first)
      box.start(allow_reboot=True)
      kernel_started()
''
