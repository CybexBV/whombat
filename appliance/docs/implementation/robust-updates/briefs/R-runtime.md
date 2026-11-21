# Brief R — the Whombat runtime (MD-13+)

Worktree `~/Code/.wt/Whombat-robust-updates`, branch `robust-updates`. Follow `CLAUDE.md` in that repository (it is
this repo's rulebook). Ids MD-13…MD-19 in `docs/decisions/managed-db.md` (and ids of other decision files you touch,
following each file's series). Ports 5750–5799.

Contracts: the repo vendors 0.20.3. Agent C is cutting **0.22.0** (`…/briefs/C-contracts.md`): `Welcome.runtime
{version, apiLevel, features}`, `SESSION_API_LEVEL`, `RUNTIME_FEATURES`, `UpdateFacts` additions (`failureDetail`,
`waiting`, `lastUpdate`), backup destination fields (`s3*`, `sftp*`, `disk:`), op `backup.sshPublicKey`. Develop
against the contracts worktree (`~/Code/.wt/whombat-contracts-robust-updates`, link without committing); vendor 0.22.0
when the orchestrator says it's cut. Later the orchestrator will also ask you to vendor whombat-app 0.12.0.

## Tasks

1. **MD-13 the runtime's version**: root `package.json` → `0.2.0` (the appliance's runtime version is
   `<this semver>-<commit time>.<shortrev>`; `0.2.0` makes every new version sort after the field's `0.1.0-<hex>`,
   UP-A1/UP-A2). Check nothing else depends on `0.1.0` (bundle scripts, health, tests).
2. **Advertise the runtime (UP-B3c)**: the session `welcome` carries `runtime: {version, apiLevel:
   SESSION_API_LEVEL, features}`; `features` lists every `RUNTIME_FEATURES` name this runtime implements (code-level
   support, not per-box availability). Write `apiLevel` and `features` into the runtime bundle's
   `share/whombat/release-manifest.json` too (the appliance's release notes and control records read them).
3. **MD-14 `use_export_stream`** (known issue 10): both direct export refusals in `apps/server/src/managed/dispatcher.ts`
   (`spec.transfer === 'export'`, `spec.exportOp`) carry `details: { code: 'use_export_stream' }`; test.
4. **Backup destinations (UP-F1)**: `backup.configureDestination` forwards the new fields to the backup service,
   `backup.sshPublicKey` is served (owner only), secrets never logged or put in receipts (the op is `secret`); tests.
   The backup service side is agent B's (appliance); keep to the contract's shapes.
5. **Owner update facts (UP-E4)**: `appliance.status.update` passes the new `UpdateFacts` members through
   (`summarizeUpdate` from contracts); nothing else unless tests need it.
6. Anything the skew work needs from the runtime (e.g. a test proving an older client strips `welcome.runtime`).

## Done when

`TMPDIR=~/.cache/wb-tmp pnpm check` and `pnpm test:server` pass; decisions written; the report lists the commits.
