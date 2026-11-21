package release

// UpdateClass values (updateClass in @whombat/release).
const (
	UpdateClassNone        = "none"
	UpdateClassRuntime     = "runtime"
	UpdateClassHost        = "host"
	UpdateClassRuntimeHost = "runtime+host"
)

func sameStorePaths(a, b []ReleaseTupleProvidersItem) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[string]int{}
	for _, p := range a {
		seen[p.StorePath]++
	}
	for _, p := range b {
		if seen[p.StorePath] == 0 {
			return false
		}
		seen[p.StorePath]--
	}
	return true
}

// UpdateClass says which update classes a candidate needs: runtime/provider bundle (no reboot) and/or
// host/manager (reboot). Same results as updateClass in TypeScript (compat vectors).
func UpdateClass(current, candidate *ReleaseTuple) string {
	runtime := current.Runtime.StorePath != candidate.Runtime.StorePath ||
		!sameStorePaths(current.Providers, candidate.Providers)
	host := current.Host.StorePath != candidate.Host.StorePath || current.Manager.StorePath != candidate.Manager.StorePath
	switch {
	case runtime && host:
		return UpdateClassRuntimeHost
	case runtime:
		return UpdateClassRuntime
	case host:
		return UpdateClassHost
	}
	return UpdateClassNone
}

// Rollback access (RollbackAccess in TypeScript): what the current runtime may do on the database the candidate leaves.
const (
	RollbackAccessReadWrite = "read-write"
	RollbackAccessReadOnly  = "read-only"
	RollbackAccessNone      = "none"
)

// ActivationCheck is the result of CheckActivation, CheckMigratingActivation and CheckCompatibleActivation.
type ActivationCheck struct {
	OK                 bool `json:"ok"`
	RequiresCheckpoint bool `json:"requiresCheckpoint"`
	RollbackCompatible bool `json:"rollbackCompatible"`
	// RollbackAccess: read-write when RollbackCompatible; read-only only from the floors (CheckMigratingActivation,
	// CheckCompatibleActivation).
	RollbackAccess string   `json:"rollbackAccess"`
	Reasons        []string `json:"reasons"`
}

func within(r IntRange, v int64) bool { return r.Min <= v && v <= r.Max }

// CheckActivation mirrors checkActivation in TypeScript: the candidate must read dbSchema and not write an older
// schema, its host ABI range must include the candidate host's ABI, and it is rollback-compatible when the
// current runtime reads the candidate's schema (otherwise a checkpoint is required).
func CheckActivation(current, candidate *ReleaseTuple, dbSchema int64) ActivationCheck {
	reasons := []string{}
	if !within(candidate.Runtime.SchemaReads, dbSchema) {
		reasons = append(reasons, "candidate_cannot_read_schema")
	}
	if candidate.Runtime.SchemaWrites < dbSchema {
		reasons = append(reasons, "schema_downgrade")
	}
	if !within(candidate.Runtime.HostABI, candidate.Host.ABI) {
		reasons = append(reasons, "host_abi_unsupported")
	}
	rollback := within(current.Runtime.SchemaReads, candidate.Runtime.SchemaWrites)
	access := RollbackAccessNone
	if rollback {
		access = RollbackAccessReadWrite
	}
	return ActivationCheck{OK: len(reasons) == 0, RequiresCheckpoint: !rollback, RollbackCompatible: rollback,
		RollbackAccess: access, Reasons: reasons}
}

// SchemaMigration is what the candidate's own schema check (Whombat `schema-check`, MD-10/MD-12) answered about the
// live database when it must migrate it (migration required, not refused): the schema its migrations produce, that
// schema's reader and writer floors (the oldest binary schema that can read / write it; nil from runtimes that don't
// report them) and the pending migrations it says need a verified checkpoint (contract and incompatible classes).
type SchemaMigration struct {
	Target          int64    `json:"target"`
	Readers         *int64   `json:"readers"`
	Writers         *int64   `json:"writers"`
	NeedsCheckpoint []string `json:"needsCheckpoint"`
}

// CheckMigratingActivation mirrors checkMigratingActivation in TypeScript (CT-134): CheckActivation for a candidate
// whose schema check said the database at dbSchema must be migrated first. That answer is the proof the candidate
// migrates from dbSchema, so it must read the schema it migrates to (m.Target, which must be its schemaWrites), not
// dbSchema. The current runtime (schema current.Runtime.SchemaWrites) can then read the migrated database when it is
// at or above the target's reader floor and write it when at or above the writer floor — the floors decide, as they
// do in that runtime's own check, whatever its tuple's schemaReads claims: read-write is rollback-compatible,
// read-only is a rollback that runs read-only. A checkpoint is
// required for the migrations the runtime names and whenever a rollback would not be read-write. Without floors the
// answer is CheckActivation(current, candidate, dbSchema), plus a checkpoint for the migrations the runtime names.
func CheckMigratingActivation(current, candidate *ReleaseTuple, dbSchema int64, m SchemaMigration) ActivationCheck {
	if m.Readers == nil || m.Writers == nil {
		c := CheckActivation(current, candidate, dbSchema)
		c.RequiresCheckpoint = c.RequiresCheckpoint || len(m.NeedsCheckpoint) > 0
		return c
	}
	reasons := []string{}
	if !within(candidate.Runtime.SchemaReads, m.Target) {
		reasons = append(reasons, "candidate_cannot_read_schema")
	}
	if candidate.Runtime.SchemaWrites < dbSchema {
		reasons = append(reasons, "schema_downgrade")
	}
	if m.Target != candidate.Runtime.SchemaWrites {
		reasons = append(reasons, "schema_target_mismatch")
	}
	if !within(candidate.Runtime.HostABI, candidate.Host.ABI) {
		reasons = append(reasons, "host_abi_unsupported")
	}
	own := current.Runtime.SchemaWrites
	access := RollbackAccessNone
	switch {
	case own >= *m.Writers:
		access = RollbackAccessReadWrite
	case own >= *m.Readers:
		access = RollbackAccessReadOnly
	}
	rollback := access == RollbackAccessReadWrite
	return ActivationCheck{OK: len(reasons) == 0, RequiresCheckpoint: !rollback || len(m.NeedsCheckpoint) > 0,
		RollbackCompatible: rollback, RollbackAccess: access, Reasons: reasons}
}

// SchemaFloors are the live schema's floors as the candidate's own schema check reports them with exit 0 (Whombat
// MD-12): the oldest binary schema that can read the database (Readers) and write it (Writers).
type SchemaFloors struct {
	Readers int64 `json:"readers"`
	Writers int64 `json:"writers"`
}

func accessAt(own int64, f SchemaFloors) string {
	switch {
	case own >= f.Writers:
		return RollbackAccessReadWrite
	case own >= f.Readers:
		return RollbackAccessReadOnly
	}
	return RollbackAccessNone
}

// CheckCompatibleActivation mirrors checkCompatibleActivation in TypeScript (CT-135, UP-B2): CheckActivation for a
// candidate whose own schema check answered exit 0 and reported the live schema's floors. With own =
// candidate.Runtime.SchemaWrites: own >= dbSchema runs CheckActivation's candidate checks (its schemaReads must
// include dbSchema); own < dbSchema (an older runtime on a newer database, e.g. a custody rollback after an expand)
// is decided by the floors — own >= Writers activates, Readers <= own < Writers is candidate_read_only, own < Readers
// is candidate_cannot_read_schema — with no schema_downgrade and no schemaReads check; host_abi_unsupported as
// always. RollbackAccess is the installed runtime's own schema (current.Runtime.SchemaWrites) against the same
// floors; RollbackCompatible = read-write; RequiresCheckpoint is false (nothing migrates on exit 0). The forward
// check (allowDowngradeFrom) is separate and unchanged.
func CheckCompatibleActivation(current, candidate *ReleaseTuple, dbSchema int64, f SchemaFloors) ActivationCheck {
	reasons := []string{}
	own := candidate.Runtime.SchemaWrites
	if own >= dbSchema {
		if !within(candidate.Runtime.SchemaReads, dbSchema) {
			reasons = append(reasons, "candidate_cannot_read_schema")
		}
	} else {
		switch accessAt(own, f) {
		case RollbackAccessReadOnly:
			reasons = append(reasons, "candidate_read_only")
		case RollbackAccessNone:
			reasons = append(reasons, "candidate_cannot_read_schema")
		}
	}
	if !within(candidate.Runtime.HostABI, candidate.Host.ABI) {
		reasons = append(reasons, "host_abi_unsupported")
	}
	access := accessAt(current.Runtime.SchemaWrites, f)
	return ActivationCheck{OK: len(reasons) == 0, RequiresCheckpoint: false,
		RollbackCompatible: access == RollbackAccessReadWrite, RollbackAccess: access, Reasons: reasons}
}

func majors(r IntRange) []int64 {
	var out []int64
	for m := r.Min / 1000; m <= r.Max/1000; m++ {
		out = append(out, m)
	}
	return out
}

// ProtocolOverlap reports whether a client range and a runtime range (`major*1000+minor`) share a major.
func ProtocolOverlap(client, runtime IntRange) bool {
	set := map[int64]bool{}
	for _, m := range majors(runtime) {
		set[m] = true
	}
	for _, m := range majors(client) {
		if set[m] {
			return true
		}
	}
	return false
}

// ServesClient reports whether the tuple's runtime serves a client speaking major.minor.
func ServesClient(t *ReleaseTuple, major, minor int64) bool {
	_ = minor // minors are additive and negotiated down
	return t.Runtime.Protocol.Min/1000 <= major && major <= t.Runtime.Protocol.Max/1000
}

// ClientBelowFloor mirrors clientBelowFloor in TypeScript (CT-53): the minimum build and true when a client on
// platform with buildNumber (nil counts as 0) is below the floor. No floor, a 0 floor or an unknown platform: false.
func ClientBelowFloor(floor *ClientFloor, platform string, buildNumber *int64) (int64, bool) {
	if floor == nil {
		return 0, false
	}
	var min int64
	switch platform {
	case "web":
		min = floor.Web
	case "android":
		min = floor.Android
	case "ios":
		min = floor.Ios
	case "desktop":
		min = floor.Desktop
	case "cli":
		min = floor.Cli
	default:
		return 0, false
	}
	var build int64
	if buildNumber != nil {
		build = *buildNumber
	}
	if build < min {
		return min, true
	}
	return 0, false
}

// AssignmentKeysError is an invalid pinned assignment-keys document (CT-41); Code matches the TypeScript
// AssignmentKeysErrorCode.
type AssignmentKeysError struct{ Code string }

func (e *AssignmentKeysError) Error() string { return "assignment keys: " + e.Code }

// AssignmentKeyMap turns the pinned assignment-keys document into VerifyAssignment's key map at time now, like
// assignmentKeyMap in TypeScript. An invalid document is an *AssignmentKeysError (bad_schema, wrong_env,
// duplicate_kid, no_active_key, active_with_window, next_with_not_after, retired_without_not_after,
// retired_with_not_before). Accepted now: every active key, next keys with notBefore <= now, retired keys with
// now <= notAfter.
func AssignmentKeyMap(raw []byte, env Environment, now int64) (map[string]string, error) {
	fail := func(code string) (map[string]string, error) { return nil, &AssignmentKeysError{Code: code} }
	doc, err := ParseAssignmentKeys(raw)
	if err != nil {
		return fail("bad_schema")
	}
	if doc.Env != env {
		return fail("wrong_env")
	}
	seen := map[string]bool{}
	active := false
	for _, k := range doc.Keys {
		if seen[k.Kid] {
			return fail("duplicate_kid")
		}
		seen[k.Kid] = true
		switch k.State {
		case "active":
			active = true
			if k.NotBefore != nil || k.NotAfter != nil {
				return fail("active_with_window")
			}
		case "next":
			if k.NotAfter != nil {
				return fail("next_with_not_after")
			}
		case "retired":
			if k.NotAfter == nil {
				return fail("retired_without_not_after")
			}
			if k.NotBefore != nil {
				return fail("retired_with_not_before")
			}
		}
	}
	if !active {
		return fail("no_active_key")
	}
	out := map[string]string{}
	for _, k := range doc.Keys {
		switch {
		case k.State == "active",
			k.State == "next" && k.NotBefore != nil && *k.NotBefore <= now,
			k.State == "retired" && now <= *k.NotAfter:
			out[k.Kid] = k.PublicKey
		}
	}
	return out, nil
}

// RetryableUpdateFailures lists the manager failure codes that mean "this box can't right now; it retries by itself"
// and never a bad release (RETRYABLE_UPDATE_FAILURES in TypeScript, CT-147; compat.json → retryable).
var RetryableUpdateFailures = []string{"no_space", "not_assigned", "not_staged", "boundary_lost", "checkpoint_stale",
	"checkpoint_required", "activation_deferred"}

// IsRetryableUpdateFailure reports whether code is one of RetryableUpdateFailures.
func IsRetryableUpdateFailure(code string) bool {
	for _, c := range RetryableUpdateFailures {
		if c == code {
			return true
		}
	}
	return false
}
