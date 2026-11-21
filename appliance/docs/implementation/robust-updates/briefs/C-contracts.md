# Brief C — contracts 0.22.0

Worktree `~/Code/.wt/whombat-contracts-robust-updates`, branch `robust-updates` (from main `dea86b8`, 0.21.0). Ids
CT-135…CT-149 in `docs/decisions/contracts.md`. You are the only writer of contracts. **You are on the critical path**:
seven other agents wait for this release. Cut `0.22.0` as soon as everything below is in and checked (target: a few
hours), then stay available for a 0.22.x patch if an agent reports a gap (the orchestrator will message you).

Read `docs/decisions/contracts.md` CT-14 (tolerant wire, strict commands), CT-53 (client floor), CT-130 (closed unions),
CT-134 (checkMigratingActivation), and `docs/publishing.md` (how a release is cut: tag, `pnpm release`, dist-release,
double build, smoke consumer). Everything below is additive (optional members, new functions/endpoints) unless noted.

## 1. `@whombat/release` (TS) and `go/release` (Go), with shared vectors — CT-135

1. `compareVersions(a, b): -1|0|1` — exactly the semantics of the appliance helper's `CompareVersions`
   (`~/Code/whombat-appliance/helper/pkg/trust/forward.go`, read it): build metadata after `+` ignored; split core and
   pre-release at the first `-`; dotted segments numeric-numerically, numeric before alphanumeric, else lexical; a
   pre-release sorts before the release. Go `release.CompareVersions` with the same code. Vectors
   (`vectors/…`, the existing vector layout) include: semver basics; `pve-20260928.5` < `pve-20260928.6` <
   `pve-20260928.10` < `pve-20260929.1`, `pve-dev-…` likewise; the text-ordering trap (`0.1.0-e847497` > `0.1.0-195421a`,
   `0.1.0-a2abeeb.p26a328c` > `0.1.0-843d1ba`); **the transition** (UP-A2): every one of these published versions is
   older than `0.2.0-20260928190000.abcdef1` and than `0.2.0-dev`: `0.1.0-a2abeeb.p26a328c`, `0.1.0-843d1ba`,
   `0.1.0-2be6fc1`, `0.1.0-e847497`, `0.1.0-195421a`, `0.1.0`, `0.0.48-2be6fc1`; new-scheme ordering by commit time then
   rev (`0.2.0-20260928190000.aaaaaaa` < `0.2.0-20260928190001.0000000`), with `.p<digest>` and `.<label>` suffixes.
2. `checkCompatibleActivation(current, candidate, dbSchema, floors: {readers, writers})` (Go
   `CheckCompatibleActivation(current, candidate *ReleaseTuple, dbSchema int64, f SchemaFloors) ActivationCheck`) —
   UP-B2 in `updates.md`: for a candidate whose own schema check answered exit 0 **and reported the live schema's
   floors**. Let `own = candidate.runtime.schemaWrites`. Reasons: if `own >= dbSchema` → exactly `checkActivation`'s
   candidate checks (reads range contains dbSchema; no `schema_downgrade`); if `own < dbSchema` → `own >= writers` ok,
   `readers <= own < writers` → `candidate_read_only`, `own < readers` → `candidate_cannot_read_schema` (no
   `schema_downgrade`, no schemaReads-range check: the floors decide); always `host_abi_unsupported` as before.
   Rollback access = the installed runtime's own schema (`current.runtime.schemaWrites`) against the same floors
   (read-write ≥ writers, read-only ≥ readers, else none); `rollbackCompatible` = read-write; `requiresCheckpoint` =
   false (nothing migrates on exit 0; keep the field false). Vectors: the custody-rollback pair (current writes 49,
   candidate writes 48, db 49 floors {readers 47, writers 48} → ok, read-write), a contract case (floors {49,49} →
   `candidate_read_only`/`candidate_cannot_read_schema`), the `current` case equal to `checkActivation`.
3. Keep `checkActivation`/`checkMigratingActivation` unchanged.

## 2. Tolerant decoding and the runtime's self-description — `@whombat/protocol`, CT-136

1. `decodeTolerant(schema, value, opts?)` → `{ ok: true, data, skipped: SkippedItem[] } | { ok: false, error }`: parse;
   on failure, if every issue is an unknown enum member / union discriminator (zod 4 issue codes; check what the repo's
   zod emits), repair and retry (bounded, e.g. 64 repairs): an array element that carries the unknown value is dropped
   (recorded in `skipped` with its path and the unknown value), an optional/nullable field holding it becomes
   undefined/null; anything else fails as before. Unknown object members are already stripped (CT-14). Tests: a
   0.22-shaped answer with a new `MessageCard` kind, a new `WorkItemKind`, a new `AGENT_ROLES` member, a new realtime
   event type, fed through the 0.21 schemas, decodes with the item skipped; and an older (0.20-era) answer through
   0.22 schemas decodes. Export also `isTolerableIssue`.
2. `SESSION_API_LEVEL = 22` (`session/version.ts`), with a doc comment: bumped by every contracts minor that changes a
   session op, output, frame or union; add the rule to `docs/publishing.md`'s checklist. `apiLevelWindow(level)` →
   `{min: level-2, max: level+1}`; `runtimeSkew(clientLevel, runtimeLevel|undefined)` → `'ok' | 'runtime_too_old' |
   'client_too_old'` (undefined runtime level counts as 21, `LEGACY_API_LEVEL`).
3. `RUNTIME_FEATURES` — a const list of feature names (strings) with a comment per name saying which contracts
   version brought it (look at CT entries: vault, vault.login, browser, skills, roles, spend, delegation, work,
   guides, feedback, licence, clients.install, packs, … — cover every user-visible feature area added since 0.10).
   `LEGACY_FEATURES` = every feature a runtime of contracts ≤ 0.21 has (runtimes before the advertisement are assumed
   to be capabilities-era: every box in the field is). `RuntimeFeature` type = the known names; the schema is an open
   string (`z.string().regex(/^[a-z][a-z0-9_.-]*$/).max(64)`), unknown names ignored.
4. `Welcome.runtime` optional: `z.object({ version: VersionString, apiLevel: z.number().int().min(0).max(100000),
   features: z.array(FeatureName).max(128) })`. Welcome is a tolerant message: older clients strip it.
5. Replace CT-130's closed-union statement with the new policy in CT-136: unions still grow in minors, clients decode
   with `decodeTolerant` and skip what they don't know; signed/security documents stay strict (CT-14 unchanged).

## 3. Update failure detail, update facts, owner summary — `@whombat/control-contracts`, CT-137, CT-138

1. `device/status.ts`: `UpdateFailureDetail = z.strictObject({ stage: UpdateJournalState, code: Ident, reasons:
   z.array(Ident).max(8), release: ReleaseId, schema: z.strictObject({ database: int, target: int.nullable(),
   candidateWrites: int, candidateReads: IntRange }).optional(), rollbackAccess: z.enum(['read-write','read-only',
   'none']).optional(), failedChecks: <the existing health check enum>.array().max(8), at: EpochSeconds })` — codes,
   ids and numbers only (the file's §12 allowlist; say so in its comment). Add `failureDetail:
   UpdateFailureDetail.nullable().optional()` to `DeviceStatusReport.update` and to `UpdateProgressReport`, and
   `runtimeVersion: VersionString.optional()` to `DeviceStatusReport`. Regenerate Go (`go/device/types_gen.go`) and the
   JSON schemas with the repo's generator; vectors if the file has them.
2. `describeUpdateFailure(detail): string` — plain English for operators and owners, one or two sentences, from a
   catalogue keyed by code and reasons (known codes: `schema_incompatible` with reasons `candidate_cannot_read_schema`,
   `candidate_read_only`, `schema_downgrade`, `schema_target_mismatch`, `host_abi_unsupported`, `protocol_no_overlap`;
   `unhealthy`, `boot_fallback`, `download_corrupt`, `verification_failed`, `no_space`, `incompatible`, `checkpoint`,
   … — grep the appliance manager (`~/Code/whombat-appliance/manager/internal/update/*.go`) for every `Code:` and
   `beginRollback(` code). The 2026-09-28 failure `{code: schema_incompatible, reasons: [candidate_cannot_read_schema],
   release: pve-20260928.5, schema: {database: 48, target: null, candidateWrites: 49, candidateReads: {49,49}}}` must
   render like “pve-20260928.5 couldn’t start on this Whombat’s database: it reads schema 49 only and the database is at
   48. Nothing was changed.” Unknown codes render generically with the code. Tests.
3. `local/index.ts` `UpdateFacts` (z.object, tolerant) gains optional: `failureDetail: UpdateFailureDetail.nullable()`,
   `waiting: z.object({ reason: z.enum(['boundary','checkpoint','window','hold','lock','metadata']), since: Rfc3339,
   blockers: z.array(z.object({ kind: Ident, count: int })).max(16) }).nullable()`, `lastUpdate: z.object({ release:
   ReleaseId, from: ReleaseId.nullable(), at: Rfc3339 }).nullable()`. `summarizeUpdate` passes them through
   (`UpdateStatus` mirrors them). Old runtimes strip them (fine).
4. Owner-facing release summary (orgs/session API): `GET /v1/releases/:release/summary` (auth `session`) →
   `{ release, summary: string ≤ 500, publishedAt: EpochSeconds }`, 404 when control has no record.

## 4. Operator contracts — CT-139…CT-141 (`operator.ts`, `rollout.ts`)

1. `ReleaseRecord = z.object({ notes: z.object({ summary: z.string().max(500), markdown: z.string().max(20000)
   }).optional(), apiLevel: int.optional(), features: FeatureName[] ≤128 optional, migrations: z.array(z.object({ tag:
   string ≤80, class: string ≤16, readers: int, writers: int, version: int })).max(1000).optional(), twin:
   ReleaseId.optional(), env: z.enum(['dev','prod']).optional(), gates: z.object({ build, validate, upgradeGates,
   devSoak }) each optional `{ ok: boolean, at: EpochSeconds, sha256: Sha256Hex, summary: string ≤ 500 }`, builtFrom:
   z.object({ appliance: GitCommit, whombat: GitCommit.optional(), app: string ≤40 optional, contracts: string ≤40
   optional }).optional(), knownIssues: z.array(z.string().max(300)).max(20).optional() })`.
   `registerRelease` body gains `record: ReleaseRecord.optional()`; a new `PUT /v1/operator/releases/:release/record`
   (permission `releases.write`) updates it (records arrive stage by stage). `RegisteredRelease` gains optional
   `record`, `versions {host, runtime, manager}`, `schemaWrites`, `createdAt`.
2. Rollouts: `ROLLOUT_PRESETS` exported (`default`, `all-at-once`) exactly as UP-E1 (`updates.md`): default = internal
   100 % 3600 s, pilot 100 % 21600 s, canary 100 % 43200 s, general 1000 bp 86400 s, general 10000 bp 0 s; all with
   `failureThresholdBp 0`, `minSample 1`; all-at-once = one wave of all four cohorts, 10000 bp, 0 s, threshold 0, sample
   1. `Rollout.pauseDetail` optional nullable `{ device: DeviceId.nullable(), reason: Ident, failureDetail:
   UpdateFailureDetail.nullable(), at: EpochSeconds }`. Pause reasons documented: `operator`, `failure_threshold`,
   `device_failed`, `health_regression`, `quarantined`.
   New `GET /v1/operator/rollouts/:rollout/devices` → `{ devices: [{ device, org: OrgId.nullable(), cohort,
   wave: int.nullable(), state: UpdateJournalState.nullable(), attempt, failure: Ident.nullable(), failureDetail:
   UpdateFailureDetail.nullable(), hold: Ident.nullable() /* manager_too_old, failed_before, … */, managerVersion:
   VersionString.nullable(), updatedAt: EpochSeconds.nullable() }] }` (≤ 10 000).
3. `GET /v1/operator/fleet` (`fleet.read`) → `FleetSummary { generatedAt, devices: { total, live, unseen24h },
   releases: [{ release, devices: int, apiLevel: int.nullable(), managerVersions: string[] ≤ 16 }], rollouts: Rollout[]
   (open), alerts: { open: int, critical: int } }`.
4. Alerts: `OperatorAlert { id: Ident, kind: z.enum(['rollout_paused','rollout_stopped','device_update_failed',
   'device_unseen','tuf_timestamp_stale','tuf_expiring','client_channel_expiring','backup_failing']), severity:
   z.enum(['warning','critical']), subject: string ≤ 120, detail: string ≤ 500, openedAt, lastSeenAt, resolvedAt:
   nullable, acknowledgedAt: nullable, acknowledgedBy: OperatorId.nullable() }`; `GET /v1/operator/alerts?state=open|all`
   (`fleet.read`), `POST /v1/operator/alerts/:alert/ack` (`fleet.write`).
5. Pending re-registrations (UP-E5): `GET /v1/operator/registrations` (`fleet.read`) → `{ registrations: [{ id: Ident,
   existingDevice: DeviceId, existingState: string ≤ 32, attempts: int, firstAt, lastAt }] }`;
   `POST /v1/operator/registrations/:id/retire-existing` body `{ reason: Ident }` (`fleet.write`) → the retired device.
6. Keep the operator panel (whombat-app `apps/admin`) in mind: every new endpoint in `operatorApi`/`rolloutApi` so its
   typed client picks it up.

## 5. Release

- Update `README`/docs where they list endpoints or policies; CT-135…CT-141 entries (format of the file).
- `pnpm check`, Go tests (`go test ./...` in `go/`), `pnpm gen:check`, then bump every package to 0.22.0, commit, tag
  `contracts-v0.22.0` (annotated, local), `pnpm release` → `dist-release/0.22.0/` (double build identical, smoke
  consumer). Do not push. Report the tag commit and the dist-release path; the orchestrator vendors it everywhere.
