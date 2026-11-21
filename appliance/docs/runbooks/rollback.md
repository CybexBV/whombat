# Rollback: undoing the cutover, step by step

Companion to `../archive/cutover.md` (archived with the self-hosted monolith, HE-48). For each phase: what triggers a rollback, the exact undo, and what cannot be undone.
Nothing here has been executed. Device-level update rollback (a bad appliance release) is **not** this document:

- a box rolls back a candidate that fails its checks by itself, and reports why as structured fields control shows
  (`updates.md` “Failure detail”);
- stopping a rollout is control's pause / emergency stop and release quarantine (`shipping.md`, control
  `incident-response.md` “Faulty release”, `vulnerability-response.md` §5);
- taking boxes that already run a bad release back to an older one is a **custody rollback**: a new release with the
  older components, signed with `--allow-downgrade-from` the bad release (`updates.md` “Custody rollback”, MG-44,
  MG-45). After an `expand` migration the older runtime runs on the newer schema; after a `contract` it can't, and the
  way out is a fix-forward release or the owner-authorized restore of the pre-migration checkpoint (`restore.md`).

## 1. Principles

- The monolith is never modified by the cutover until phase 7, so “roll back” for the product always means
  **route people back to the monolith**, which still holds their pre-cutover data.
- Data created on an appliance belongs to that customer and stays on the appliance. Rolling back routing never
  deletes it; bringing it back into the monolith is manual (§4).
- DNS rollbacks depend on the TTL lowered in advance (60 s, ≥ 48 h before a switch). Check it before every switch:
  `dig +noall +answer app.whombat.com` shows the TTL.
- Record every rollback action with UTC time in the incident timeline (control `incident-response.md`).

## 2. Triggers (any one, during a phase's observation window)

- A SEV1 attributable to the new stack (control `incident-response.md` severity table).
- Data loss or a suspected content exposure.
- Sign-in success or session establishment below 99 % for 30 min (proposal), or relay/control unavailable for
  more than 15 min with no fix in sight.
- A migrated org's owner withdraws sign-off during the verification step.
- A security finding rated Critical in the new stack without a mitigation within its target time
  (`vulnerability-response.md` §3).

## 3. Per phase

| Phase (`../archive/cutover.md`) | Undo | Time | Leaves behind |
|---|---|---|---|
| 1 — dev stack beside the dev monolith | delete `api.dev`, `w1.relay.dev` (and any preview) records; `tofu destroy -var-file=dev.tfvars` | minutes | nothing on the monolith |
| 1.5 — `dev.whombat.com` switched | point `dev.whombat.com` back at the dev monolith (record or reverse-proxy name); remove `legacy-dev.whombat.com` | TTL (60 s) | dev appliances keep their data; reachable again once switched forward |
| 2 — legacy dry run | delete the restored copy (`~/cutover/*-copy`, its Postgres data) | minutes | nothing: the dry run is read-only |
| 3 — prod control/relay + pilot UI | remove the pilot origin from control CORS and relay `allowed-origins`; delete `pilot.whombat.com`; retire internal appliances (operator retire, CL-23); `tofu destroy` if abandoning | minutes to 1 h | production keys created in the ceremony remain in custody (revoke/rotate them if the stack is abandoned for good, `updates-release-signing.md`) |
| 4 — pilot org | none at the product level; for the org: export (`whombat-recovery export -kit …`, `recovery-export.md`), then factory reset or keep the box; release or retire the org's device in control | per org | the customer's backups (theirs) |
| 5 — org import, **before** owner sign-off | stop using the appliance for that org; the monolith still has the org's data as of the freeze; discard the appliance's imported state (factory reset `factory-reset.md`, or re-provision) | hours | nothing written to the monolith |
| 5 — org import, **after** sign-off | see §4 (point of no return per org) | manual | — |
| 6 — `app.whombat.com` switched | point `app.whombat.com` back at the monolith; remove `app.whombat.com` from control CORS/WebAuthn and relay origins only if it misbehaves there; re-enable `pilot.whombat.com` for pilot/migrated orgs | TTL (60 s) | passkeys registered on `app.whombat.com` during the window stay registered in control and work again at the next switch |
| 7 — decommission | **none**: irreversible. Only the final encrypted backup of the monolith remains (restorable with `whombat restore` into a new instance) | — | — |

## 4. Point of no return (per migrated org)

After an org's owner signs off an import (phase 5 step 6) and people start working on the appliance, the two
copies diverge. Rolling that org back to the monolith then means:

1. Freeze work on the appliance (owners announce; automations paused).
2. Export from the appliance with the kit (`whombat-recovery export`), which gives the database as SQL/pgdump,
   files, workspaces with git bundles (unpushed commits included) and a README with counts.
3. Move what matters back by hand: repositories via the git bundles (push to the forge), files by upload,
   conversations are **not** re-importable into the monolith (no importer exists in that direction); keep the
   export as the record.
4. Re-enable the org on the monolith; people sign in there again (their monolith accounts were never removed).

This cost is why phase 5 has a verification step before sign-off, and why the monolith stays available
read-only on `legacy.whombat.com` for 90 days after phase 6 (RL-03).

## 5. After a rollback

- Keep the new stack's state (don't destroy) unless the decision is to abandon; the next attempt reuses it.
- Write the review within 5 working days: trigger, timeline, what the exit criteria missed.
- Re-plan the phase with a fix; don't retry the same switch without a changed precondition.
