# Compatibility policy

What still has to work when parts of a Whombat update at different times. Whombat is unreleased and every box was
rebuilt at the migration baseline (Whombat `0000_baseline`, candidate 0.141.0, IN-397…IN-399), so nothing here keeps an
older client, protocol or manager working: compatibility code is deleted, not deprecated (Whombat hermes-engine.md
HE-27, HE-52; IN-413…IN-420).

## Clients and the box: one contracts major

- The clients (hosted web, embed, Android) and the box speak one contracts major (1.0.0). A client that meets a box on
  another major says so in plain words: “Update the app”, or that the Whombat needs an update when the box is the one
  behind. There is no window of older majors or API levels, no feature flags, no client floors and no skew check in the
  release pipeline.
- A breaking change is a new major, which clients and the box take together.
- Control lets a hosted web or embed build out only when it vendors the contracts major of every live box's release,
  which each release record names (`builtFrom.contracts`, the contracts the runtime vendors; IN-420).

## What has to work across an update

**Update classes** (`updateClass`, `@whombat/release/compat`; MA-11):

| Class | Changes | Activation | Rollback |
|---|---|---|---|
| `runtime` | runtime bundle (Nix closure) | profile switch + unit restart at a safe boundary, no reboot | to the recorded known-good; read-only fallback if the schema moved (`rolled_back_read_only`) |
| `host` | NixOS generation and/or manager | staged, activated on reboot, boot counting and blessing (NX-04, NX-05) | boot fallback to the previous generation |
| `runtime+host` | both | host first on reboot, then runtime, as one tuple | per class; the tuple is the unit of known-good |

Only TUF-approved tuples activate; control's assignment only chooses among them (MA-11, CL-19); a downgrade needs a
custody-signed tuple that permits it (MA-21c).

**Schema rollback classes** (Whombat `apps/server/src/db/compat.ts`, `compat.json`; managed-db.md MD-01…MD-12):

- Schema versions are migration journal positions, started again at `0000_baseline` (an `incompatible` migration: a
  database from before it is refused as `foreign`). Every migration records its class (**expand**, **backfill**,
  **contract**, **incompatible**) and its floors: the oldest binary schema that can still **read** and **write** what it
  produces.
- `checkActivation` lets a candidate start only if it reads the current schema and never rolls it back. The update is
  **rollback-compatible** when the known-good runtime still reads and writes the candidate's schema; otherwise it
  waits for a **verified backup checkpoint** first (MD-06, BK-17; the reason `checkpoint` while there is none).
- Authors expand and backfill first and contract in a later release, so ordinary releases stay rollback-compatible. An
  incompatible migration ships alone, behind a checkpoint; after activation the way out of a failure is a fix-forward
  release (`ForwardRepairRequired`). A PostgreSQL major is its own class (MD-09); none so far.
- A runtime validates the schema at start and refuses one outside its range; only `whombat migrate` migrates (MD-07).
- Proven in VMs from the baseline runtime on: `release/upgrade-gates` gates 1, 2, 4 and 6 (updates from the releases
  boxes run, `vm-tests/upgrade-gates/previous.json`, IN-415), 5 (`update-migration`: expand, contract, checkpoint,
  rollback, IN-416) and 7 (the restore drill).

**Manager ↔ runtime local IPC** (`@whombat/control-contracts/local`, CT-23): both ship in the same tuple but update in
different classes, so every local IPC change works across one class update in each direction: a new runtime with the
current manager, a new manager with the current runtime. The host ABI (`tuple.host.abi`, `tuple.runtime.hostAbi`)
names what the host provides; `checkActivation` refuses a runtime outside it (`host_abi_unsupported`).

**Long-offline boxes** (TUF, `updates-release-signing.md`): timestamp 24 h, snapshot 7 d, targets 90 d, root 1 year.
A box offline past expiry keeps running its installed release and activates nothing until its metadata refreshes; it
walks root rotations when it is back (tested over three rotations and 200 days). Assignment keys retire with a grace
of at least 90 days (CT-34, CT-35), so an assignment stays verifiable after that long offline.

## How people are told

Owners see why an update waits (`boundary`, `hold`, `lock`, `window`, `checkpoint`, `metadata`, `no_space`; manager
facts relayed by `appliance.status`), and that a rolled back or quarantined release left the previous one running with
nothing lost. Copy stays free of protocol words (R-66): “Update the app”, “Your Whombat will update tonight”.
