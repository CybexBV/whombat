# Ledger — feedback trail and reporter sign-in (2026-09-30)

Spec: `assignment.md`. Branch `feedback-reporters` in every repo.

| Stream | Scope | Worktree | State |
|---|---|---|---|
| C | contracts 0.25.0 (§1) | merged | DONE — contracts main ca35f25, tag contracts-v0.25.0 pushed |
| R | runtime (§2) | merged | DONE — Whombat main 17353dcf (+ docs 674286c3) pushed; FR-01…FR-19; app 0.15.0 vendored; check 1311, test:server 1205 green |
| A | control (§3) | merged | DONE — control's main (CL-98…CL-107, review fixes 9d28e93) pushed |
| W | widget, web, legal (§5) | merged | DONE — app main 9b532a9, tag app-v0.15.0 pushed, dist-release/0.15.0 built (AP-427…AP-436, widget 1.2.0) |
| M | manager, harness, candidate (§4) | merged | DONE — appliance main 4358a12 (MG-58, IN-129…IN-131, V-82/V-83); candidate 0.22.0 = release pve-20260930.2 (host release, schema 52) on the dev instance and the DEV box; not promoted |

## Lead notes
- Another session ships candidate 0.21.0 (shared sign-in) at the same time; this workstream takes 0.22.0.
- Security review (R + A, 2026-09-30): no takeover/cross-site/spoofing; fixed: control code-mail caps per site
  (100/h) and global (2000/h), daily 10 codes per site+address (both), expired card deletes reporter entries +
  runtime republishes after expiry/first sync (FR-12, CL-106), IPv6 /64 keys + TokenBuckets prune fix (FR-14), no
  recipient in mail error logs, dummy MAC compare, trail steps from foreign origins dropped (FR-18), backoff kept
  (FR-19), idle self-hosted reporters swept after 30 d (FR-17). Unkeyed drop digest documented (CL-107).

## Production (waits for John's yes), in this order
1. `~/Code/whombat-api/infra/hetzner/deploy.sh control b28e7b4` (migration 0013, additive)
2. `deploy.sh web app-v0.15.0` and `deploy.sh embed app-v0.15.0`
3. `cd ~/Code/whombat-appliance && release/ship promote-prod pve-20260930.2 --yes` (contains 0.21.0 too; pve-20260930.1 can stay unpromoted)
