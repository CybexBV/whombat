// Package proto is the manager <-> update-helper wire protocol (MG-10): one JSON request line per
// unix-socket connection, one JSON response line back. Requests are typed operations on release or
// network-candidate ids only; there is no field that could carry a command, path, URL or Nix expression.
package proto

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/CybexBV/whombat/appliance/helper/pkg/netconfig"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
)

// Version is the protocol version.
const Version = 1

// CollectTimeout bounds collect-garbage in the helper (UP-X19); what a collection didn't reach goes the next time. The
// manager waits a little longer, so the helper has stopped the collection, and freed its operation lock, first.
const CollectTimeout = 30 * time.Minute

// MaxRequestBytes bounds a request line, except missing-paths requests (MaxPathsRequestBytes: up to MaxStorePaths
// store paths); MaxResponseBytes bounds a response line (a missing-paths answer lists up to MaxStorePaths paths).
const (
	MaxRequestBytes      = 1024
	MaxPathsRequestBytes = 16 << 20
	MaxResponseBytes     = 16 << 20
	// MaxStorePaths bounds the store paths of one missing-paths request (trust.MaxIndexPaths).
	MaxStorePaths = trust.MaxIndexPaths
)

// Op is a typed helper operation.
type Op string

// The complete operation set.
const (
	OpStageRuntime         Op = "stage-runtime"
	OpActivateRuntime      Op = "activate-runtime"
	OpRollbackRuntime      Op = "rollback-runtime"
	OpStageHost            Op = "stage-host"
	OpActivateHostOnReboot Op = "activate-host-on-reboot"
	OpBlessBoot            Op = "bless-boot"
	OpApplyNetwork         Op = "apply-network"
	OpConfirmNetwork       Op = "confirm-network"
	OpRevertNetwork        Op = "revert-network"
	// Database schema (MD-10 in Whombat docs/decisions/managed-db.md): run the release's own CLI as the
	// runtime user. check-schema is read-only; migrate-runtime is the single migration authority.
	OpCheckSchema Op = "check-schema"
	// OpPruneHostGenerations deletes system generations that are neither booted, current, known-good
	// (previous) nor pending, so the known-good kernel never falls off the boot partition.
	OpPruneHostGenerations Op = "prune-host-generations"
	OpMigrateRuntime       Op = "migrate-runtime"
	// OpKnownGoodManager returns the whombat-manager store paths of the recorded known-good hosts
	// (read-only; whombat-manager-recovery execs one from the store, M-3).
	OpKnownGoodManager Op = "known-good-manager"
	// OpMissingPaths returns which of the given store paths are not valid in the store (read-only; UP-X14): the
	// manager asks it to download only the blobs of a closure index the box lacks. The helper trusts nothing of the
	// answer's use: staging re-derives every path from its own verified index.
	OpMissingPaths Op = "missing-paths"
	// OpPruneRuntimeGenerations deletes runtime-profile generations whose runtime none of the helper's records
	// (current and previous runtime; current, previous and pending host) names, keeping the profile's current and
	// newest generation (UP-X18): every runtime the box can still roll back to stays a GC root.
	OpPruneRuntimeGenerations Op = "prune-runtime-generations"
	// OpCollectGarbage deletes the store paths no GC root reaches (`nix-store --gc`, low priority, bounded; UP-X19).
	// It deletes no generation: the profiles stay the roots, the prune operations decide what they keep.
	OpCollectGarbage Op = "collect-garbage"
	// Wi-Fi through iwd (NX-244, MG-100). wifi-status and wifi-scan are read-only and run beside other operations.
	// wifi-join and wifi-forget make a change (changeId); with deadlineSec > 0 it is guarded: the helper arms its
	// dead-man first and the change stays pending until wifi-confirm (keep it) or wifi-revert (undo it); the dead-man
	// undoes it when neither came (`whombat-update-helper wifi-revert-deadman`). A failed join or forget is undone at
	// once and answered with its failure code.
	OpWifiStatus  Op = "wifi-status"
	OpWifiScan    Op = "wifi-scan"
	OpWifiJoin    Op = "wifi-join"
	OpWifiForget  Op = "wifi-forget"
	OpWifiConfirm Op = "wifi-confirm"
	OpWifiRevert  Op = "wifi-revert"
	// The cable: cable-set switches the wired interfaces off (use "wifi": the link stays up, no address) or
	// on again (use "cable"). With deadlineSec > 0 it is guarded like a Wi-Fi change: the helper arms its dead-man first
	// and the change stays pending until cable-confirm or cable-revert; the dead-man undoes it when neither came
	// (`whombat-update-helper cable-revert-deadman`). cable-status is read-only and runs beside other operations.
	OpCableStatus  Op = "cable-status"
	OpCableSet     Op = "cable-set"
	OpCableConfirm Op = "cable-confirm"
	OpCableRevert  Op = "cable-revert"
	// Bringing the box back from a backup (BK-39, Whombat backup-options.md BKO-11): backup-restore starts the root
	// unit whombat-backup-restore@<checkpointId> without waiting (it stops the runtime, so nobody could); after the
	// person's answers ended the quarantine, backup-restored restarts the runtime and the hosts service, which
	// applies the servers it was handed.
	OpBackupRestore  Op = "backup-restore"
	OpBackupRestored Op = "backup-restored"
	// Update channels (Whombat LNK-21, UP-X29): channel reads the box's channel (read-only, beside other operations);
	// set-channel records another one (root-owned, the helper's own state). The manager asks for it only on the
	// owner's signed event; the helper still never activates anything but the newest release of the channel, forward
	// only, so a channel change moves no box back.
	OpChannel    Op = "channel"
	OpSetChannel Op = "set-channel"
)

// What a cable-set asks for: Wi-Fi only (the cable switched off) or the cable used again.
const (
	CableUseWifi  = "wifi"
	CableUseCable = "cable"
)

// MaxWifiDeadlineSec bounds a guarded Wi-Fi change's deadline (the local contract's confirmTimeoutSec is 30…600).
const MaxWifiDeadlineSec = 3600

type argKind int

const (
	argNone argKind = iota
	argRelease
	argCandidate
	argReleaseCheckpoint
	argOptionalRelease
	argStorePaths
	argWifiJoin
	argWifiForget
	argChange
	argCableSet
	argCheckpoint
	argChannel
)

var ops = map[Op]argKind{
	OpStageRuntime: argRelease, OpActivateRuntime: argRelease, OpRollbackRuntime: argOptionalRelease,
	OpStageHost: argRelease, OpActivateHostOnReboot: argRelease, OpBlessBoot: argNone,
	OpApplyNetwork: argCandidate, OpConfirmNetwork: argCandidate, OpRevertNetwork: argNone,
	OpCheckSchema: argRelease, OpMigrateRuntime: argReleaseCheckpoint, OpPruneHostGenerations: argNone,
	OpKnownGoodManager: argNone, OpMissingPaths: argStorePaths, OpPruneRuntimeGenerations: argNone,
	OpCollectGarbage: argNone, OpWifiStatus: argNone, OpWifiScan: argNone, OpWifiJoin: argWifiJoin,
	OpWifiForget: argWifiForget, OpWifiConfirm: argChange, OpWifiRevert: argChange,
	OpCableStatus: argNone, OpCableSet: argCableSet, OpCableConfirm: argChange, OpCableRevert: argChange,
	OpBackupRestore: argCheckpoint, OpBackupRestored: argNone,
	OpChannel: argNone, OpSetChannel: argChannel,
}

var changeIDRe = regexp.MustCompile(`^c-[a-z0-9]{8,32}$`)

// ValidChangeID reports whether s is a network change id (the contracts' NetworkChange.id).
func ValidChangeID(s string) bool { return changeIDRe.MatchString(s) }

// validSSID is wifi.ValidSSID (1…32 bytes of UTF-8 without NUL), here so the protocol doesn't link the D-Bus client.
func validSSID(s string) bool {
	return s != "" && len(s) <= 32 && utf8.ValidString(s) && !strings.ContainsRune(s, 0)
}

// ValidWifiPassphrase is wifi.ValidPassphrase (8…63 printable ASCII, or 64 hex digits), for callers that don't link
// the D-Bus client.
func ValidWifiPassphrase(p string) bool {
	if len(p) == 64 && strings.Trim(p, "0123456789abcdefABCDEF") == "" {
		return true
	}
	return len(p) >= 8 && len(p) <= 63 && strings.Trim(p, printableASCII) == ""
}

var printableASCII = func() string {
	var b strings.Builder
	for c := byte(0x20); c <= 0x7e; c++ {
		b.WriteByte(c)
	}
	return b.String()
}()

var checkpointRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// ValidCheckpointID reports whether s is an acceptable checkpoint reference (opaque id from the
// backup service; never a path or URL).
func ValidCheckpointID(s string) bool {
	return checkpointRe.MatchString(s) && !strings.Contains(s, "..")
}

// Request is one operation.
type Request struct {
	V            int    `json:"v"`
	Op           Op     `json:"op"`
	ReleaseID    string `json:"releaseId,omitempty"`
	CandidateID  string `json:"candidateId,omitempty"`
	CheckpointID string `json:"checkpointId,omitempty"`
	// StorePaths: missing-paths only (1…MaxStorePaths valid store paths).
	StorePaths []string `json:"storePaths,omitempty"`
	// Wi-Fi changes (wifi-join, wifi-forget; changeId also wifi-confirm and wifi-revert). Passphrase is a secret: it is
	// never logged, and String/GoString leave it out.
	ChangeID    string `json:"changeId,omitempty"`
	SSID        string `json:"ssid,omitempty"`
	Passphrase  string `json:"passphrase,omitempty"`
	Hidden      bool   `json:"hidden,omitempty"`
	DeadlineSec int    `json:"deadlineSec,omitempty"`
	// Use: cable-set only (CableUseWifi or CableUseCable).
	Use string `json:"use,omitempty"`
	// Channel: set-channel only (trust.ChannelProduction or trust.ChannelDevelopment).
	Channel string `json:"channel,omitempty"`
}

// String describes the request without its passphrase.
func (r Request) String() string {
	return fmt.Sprintf("{op %s releaseId %q candidateId %q changeId %q ssid %q hidden %v deadlineSec %d use %q passphrase given %v}",
		r.Op, r.ReleaseID, r.CandidateID, r.ChangeID, r.SSID, r.Hidden, r.DeadlineSec, r.Use, r.Passphrase != "")
}

// GoString leaves the passphrase out (%#v).
func (r Request) GoString() string { return r.String() }

// Validate checks the op and that exactly its argument is present and well-formed.
func (r Request) Validate() error {
	if r.V != Version {
		return fmt.Errorf("unsupported protocol version %d", r.V)
	}
	kind, ok := ops[r.Op]
	if !ok {
		return fmt.Errorf("unknown operation %q", r.Op)
	}
	if r.CheckpointID != "" && ((kind != argReleaseCheckpoint && kind != argCheckpoint) || !ValidCheckpointID(r.CheckpointID)) {
		return fmt.Errorf("%s: unexpected or invalid checkpointId", r.Op)
	}
	if r.StorePaths != nil && kind != argStorePaths {
		return fmt.Errorf("%s takes no storePaths", r.Op)
	}
	if r.Use != "" && kind != argCableSet {
		return fmt.Errorf("%s takes no use", r.Op)
	}
	if r.Channel != "" && kind != argChannel {
		return fmt.Errorf("%s takes no channel", r.Op)
	}
	if kind == argChannel {
		if r.ReleaseID != "" || r.CandidateID != "" || r.ChangeID != "" || r.SSID != "" || r.Passphrase != "" || r.Hidden ||
			r.DeadlineSec != 0 || !trust.ValidChannel(r.Channel) {
			return fmt.Errorf("%s needs exactly a channel (%s)", r.Op, strings.Join(trust.Channels, " or "))
		}
		return nil
	}
	if kind == argCableSet {
		if r.ReleaseID != "" || r.CandidateID != "" || r.SSID != "" || r.Passphrase != "" || r.Hidden ||
			!ValidChangeID(r.ChangeID) || (r.Use != CableUseWifi && r.Use != CableUseCable) ||
			r.DeadlineSec < 0 || r.DeadlineSec > MaxWifiDeadlineSec {
			return fmt.Errorf("%s needs exactly a valid changeId, use wifi or cable and a deadline of 0…%d s", r.Op, MaxWifiDeadlineSec)
		}
		return nil
	}
	wifi := kind == argWifiJoin || kind == argWifiForget || kind == argChange
	if !wifi && (r.ChangeID != "" || r.SSID != "" || r.Passphrase != "" || r.Hidden || r.DeadlineSec != 0) {
		return fmt.Errorf("%s takes no Wi-Fi fields", r.Op)
	}
	if wifi {
		if r.ReleaseID != "" || r.CandidateID != "" || !ValidChangeID(r.ChangeID) {
			return fmt.Errorf("%s needs exactly a valid changeId and its Wi-Fi fields", r.Op)
		}
		if kind == argChange && (r.SSID != "" || r.Passphrase != "" || r.Hidden || r.DeadlineSec != 0) {
			return fmt.Errorf("%s takes only a changeId", r.Op)
		}
		if kind != argChange && (!validSSID(r.SSID) || r.DeadlineSec < 0 || r.DeadlineSec > MaxWifiDeadlineSec) {
			return fmt.Errorf("%s needs a valid ssid and a deadline of 0…%d s", r.Op, MaxWifiDeadlineSec)
		}
		if kind == argWifiForget && (r.Passphrase != "" || r.Hidden) {
			return fmt.Errorf("%s takes no passphrase", r.Op)
		}
		if r.Passphrase != "" && !ValidWifiPassphrase(r.Passphrase) {
			return fmt.Errorf("%s: the passphrase is not valid", r.Op) // never the passphrase itself
		}
		return nil
	}
	switch kind {
	case argCheckpoint:
		if r.ReleaseID != "" || r.CandidateID != "" || !ValidCheckpointID(r.CheckpointID) {
			return fmt.Errorf("%s needs exactly a valid checkpointId", r.Op)
		}
	case argNone:
		if r.ReleaseID != "" || r.CandidateID != "" {
			return fmt.Errorf("%s takes no arguments", r.Op)
		}
	case argOptionalRelease:
		if r.CandidateID != "" || (r.ReleaseID != "" && !trust.ValidReleaseID(r.ReleaseID)) {
			return fmt.Errorf("%s takes at most a valid releaseId", r.Op)
		}
	case argRelease, argReleaseCheckpoint:
		if r.CandidateID != "" || !trust.ValidReleaseID(r.ReleaseID) {
			return fmt.Errorf("%s needs exactly a valid releaseId", r.Op)
		}
	case argCandidate:
		if r.ReleaseID != "" || !netconfig.ValidID(r.CandidateID) {
			return fmt.Errorf("%s needs exactly a valid candidateId", r.Op)
		}
	case argStorePaths:
		if r.ReleaseID != "" || r.CandidateID != "" || len(r.StorePaths) == 0 || len(r.StorePaths) > MaxStorePaths {
			return fmt.Errorf("%s needs 1…%d storePaths and nothing else", r.Op, MaxStorePaths)
		}
		for _, p := range r.StorePaths {
			if !trust.ValidStorePath(p) {
				return fmt.Errorf("%s: invalid store path %q", r.Op, p)
			}
		}
	}
	return nil
}

// DecodeRequest strictly parses one request line.
func DecodeRequest(line []byte) (Request, error) {
	var r Request
	if len(line) > MaxPathsRequestBytes {
		return r, errors.New("request too large")
	}
	dec := json.NewDecoder(strings.NewReader(string(line)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&r); err != nil {
		return r, fmt.Errorf("malformed request: %w", err)
	}
	if dec.More() {
		return r, errors.New("trailing data")
	}
	if len(line) > MaxRequestBytes && r.Op != OpMissingPaths {
		return r, errors.New("request too large")
	}
	return r, r.Validate()
}

// Error codes.
const (
	CodeBadRequest         = "bad_request"
	CodeForbidden          = "forbidden"
	CodeVerificationFailed = "verification_failed"
	CodeNotAssigned        = "not_assigned"
	CodeIncompatible       = "incompatible"
	CodeNotStaged          = "not_staged"
	CodeNothingToRollBack  = "nothing_to_roll_back"
	CodeBootMismatch       = "boot_mismatch"
	CodeActivationFailed   = "activation_failed"
	CodeNoSpace            = "no_space"
	CodeSchema             = "schema"
	// CodeMetadataStale: the helper's TUF refresh from the mirror failed for freshness/availability
	// (expired metadata, mirror incomplete). Not a verdict on the release; refresh and retry.
	CodeMetadataStale = "metadata_stale"
	// CodeDowngrade: the tuple is older than the installed one and custody did not allow it (M-2).
	CodeDowngrade = "downgrade"
	// CodeRollbackRefused: no unfinished activation to undo, or the target was withdrawn (L-2).
	CodeRollbackRefused = "rollback_refused"
	CodeInternal        = "internal"
	// Wi-Fi (NX-244). CodeNoWifi: no iwd, no Wi-Fi card, or this helper has no Wi-Fi configured. CodeWifiPending:
	// another change is pending (confirm or revert it first). A failed join or forget (undone) answers
	// CodeWrongPassword, CodeNetworkNotFound, CodeNoAddress, CodeNotSupported, CodeInvalidPassphrase or CodeWifiFailed;
	// CodeNotSaved: forgetting a network that isn't saved.
	CodeNoWifi            = "no_wifi"
	CodeWifiPending       = "wifi_pending"
	CodeWrongPassword     = "wrong_password"
	CodeNetworkNotFound   = "not_found"
	CodeNoAddress         = "no_address"
	CodeNotSupported      = "not_supported"
	CodeInvalidPassphrase = "invalid_passphrase"
	CodeNotSaved          = "not_saved"
	CodeWifiFailed        = "wifi_failed"
	// The cable. CodeCablePending: another cable change is pending (confirm or revert it first).
	// CodeCableNotApplied: cable-confirm found the cable not as the change left it (the box restarted meanwhile, which
	// put the committed setting back): nothing is kept, the change is over.
	CodeCablePending    = "cable_pending"
	CodeCableNotApplied = "cable_not_applied"
)

// Result is a successful operation's outcome.
type Result struct {
	ReleaseID      string   `json:"releaseId,omitempty"`
	CandidateID    string   `json:"candidateId,omitempty"`
	AlreadyDone    bool     `json:"alreadyDone,omitempty"`
	StorePaths     []string `json:"storePaths,omitempty"`
	RebootPending  bool     `json:"rebootPending,omitempty"`
	RolledBackFrom string   `json:"rolledBackFrom,omitempty"`
	Deleted        []int    `json:"deleted,omitempty"`
	Schema         *Schema  `json:"schema,omitempty"`
	// Missing: missing-paths' answer, the requested store paths that are not valid (request order).
	Missing []string `json:"missing,omitempty"`
	// Collected: collect-garbage's answer (UP-X19).
	Collected *Collected `json:"collected,omitempty"`
	// KernelLog: hardware-log's answer (MG-114).
	KernelLog []string `json:"kernelLog,omitempty"`
	// Wifi: the Wi-Fi operations' answer (NX-244).
	Wifi *WifiResult `json:"wifi,omitempty"`
	// Cable: the cable operations' answer.
	Cable *CableResult `json:"cable,omitempty"`
	// Channel: channel's and set-channel's answer, the box's update channel ("" the box has no channels: its image
	// updates through control's assignments or the community edition's own repository).
	Channel string `json:"channel,omitempty"`
}

// CableResult is what a cable operation answers: the cable's setting after it.
type CableResult struct {
	// Off: the wired interfaces are switched off now (Wi-Fi only), pending or kept.
	Off bool `json:"off"`
	// Committed: the setting kept across restarts.
	CommittedOff bool `json:"committedOff"`
	// Pending: the change that waits for cable-confirm or cable-revert ("" none).
	Pending string `json:"pending,omitempty"`
}

// WifiResult is what a Wi-Fi operation answers.
type WifiResult struct {
	// Status: wifi-status (and after wifi-join, wifi-forget and wifi-revert: the state they left).
	Status *WifiStatus `json:"status,omitempty"`
	// Networks: wifi-scan's networks, strongest first.
	Networks []WifiNetwork `json:"networks,omitempty"`
	// Pending: the change that waits for wifi-confirm or wifi-revert after this operation ("" none).
	Pending string `json:"pending,omitempty"`
	// Previous: wifi-join and wifi-forget: the network the station was on before ("" none).
	Previous string `json:"previous,omitempty"`
}

// WifiStatus is iwd's state as the manager needs it. Strings are iwd's (unchecked); the manager cleans them.
type WifiStatus struct {
	// Adapters: the Wi-Fi cards iwd manages; Powered false is a card switched off (rfkill or iwd).
	Adapters []WifiAdapter `json:"adapters"`
	// Interface is the station's interface ("" without a station).
	Interface string `json:"interface,omitempty"`
	// State is iwd's Station.State (connected, connecting, disconnected, disconnecting, roaming).
	State     string       `json:"state,omitempty"`
	Connected *WifiNetwork `json:"connected,omitempty"`
	Saved     []WifiSaved  `json:"saved"`
	// Pending is the helper's change waiting for wifi-confirm or wifi-revert ("" none).
	Pending string `json:"pending,omitempty"`
}

// WifiAdapter is a Wi-Fi card.
type WifiAdapter struct {
	Name    string `json:"name"`
	Powered bool   `json:"powered"`
}

// WifiNetwork is a network iwd sees.
type WifiNetwork struct {
	SSID      string `json:"ssid"`
	Security  string `json:"security"` // iwd's: open, psk, 8021x, wep
	SignalDBm int    `json:"signalDbm"`
	Known     bool   `json:"known,omitempty"`
	Connected bool   `json:"connected,omitempty"`
}

// WifiSaved is a saved network.
type WifiSaved struct {
	SSID     string `json:"ssid"`
	Security string `json:"security"`
	Hidden   bool   `json:"hidden,omitempty"`
}

// Collected is what a store collection deleted, from `nix-store --gc`'s summary line, and the free space it left.
type Collected struct {
	// Paths is the number of store paths deleted.
	Paths int `json:"paths"`
	// FreedBytes is what they took (`nix-store --gc` reports it rounded to its unit); -1 when it printed no summary.
	FreedBytes int64 `json:"freedBytes"`
	// FreeBytes is the space left on the store's file system (/) after the collection; -1 when unknown.
	FreeBytes int64 `json:"freeBytes"`
}

// Schema is the typed outcome of `whombat schema-check --json` / `whombat migrate --json`
// (formats whombat.schema-check/1 and whombat.migrate/1). Exit codes follow SCHEMA_EXIT: 0
// read-write, 10 migration required, 11 read-only, 12 refused, 13 checkpoint required, 14 lock
// timeout, 1 error.
type Schema struct {
	Exit            int      `json:"exit"`
	Verdict         string   `json:"verdict,omitempty"`
	Access          string   `json:"access,omitempty"` // read-write | read-only | none
	DatabaseVersion int      `json:"databaseVersion"`
	BinaryVersion   int      `json:"binaryVersion"`
	Pending         []string `json:"pending,omitempty"`
	NeedsCheckpoint []string `json:"needsCheckpoint,omitempty"`
	Applied         []string `json:"applied,omitempty"`
	// Target is the schema the runtime's migration authority leaves and its floors (`target` of
	// whombat.schema-check/1, Whombat MD-12); nil from runtimes before it.
	Target    *SchemaTarget `json:"target,omitempty"`
	OK        bool          `json:"ok"`
	ErrorKind string        `json:"errorKind,omitempty"`
	Reason    string        `json:"reason,omitempty"`
	Action    string        `json:"action,omitempty"`
}

// SchemaTarget is a schema version (journal position) with its reader and writer floors: the oldest binary schema
// that can read it and write it.
type SchemaTarget struct {
	Version int `json:"version"`
	Readers int `json:"readers"`
	Writers int `json:"writers"`
}

// Schema exit codes.
const (
	SchemaExitOK                 = 0
	SchemaExitMigrationRequired  = 10
	SchemaExitReadOnly           = 11
	SchemaExitRefused            = 12
	SchemaExitCheckpointRequired = 13
	SchemaExitLockTimeout        = 14
)

// Error is an operation failure.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Response is the reply line.
type Response struct {
	V      int     `json:"v"`
	OK     bool    `json:"ok"`
	Result *Result `json:"result,omitempty"`
	Error  *Error  `json:"error,omitempty"`
}

// Do sends one request to the helper socket and waits for the reply.
func Do(ctx context.Context, socket string, req Request) (*Result, error) {
	req.V = Version
	if err := req.Validate(); err != nil {
		return nil, &Error{Code: CodeBadRequest, Message: err.Error()}
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, fmt.Errorf("helper unavailable: %w", err)
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	} else {
		_ = conn.SetDeadline(time.Now().Add(time.Hour))
	}
	stop := context.AfterFunc(ctx, func() { _ = conn.SetDeadline(time.Now()) })
	defer stop()
	b, _ := json.Marshal(req)
	_, werr := conn.Write(append(b, '\n'))
	// The helper may refuse (peer check) and close before reading the request; its reply is still
	// readable, so read even after a failed write and prefer the helper's answer.
	rd := bufio.NewReaderSize(conn, 4096)
	line, err := readLine(rd, MaxResponseBytes)
	if err != nil {
		if werr != nil {
			return nil, fmt.Errorf("helper write: %w", werr)
		}
		return nil, fmt.Errorf("helper read: %w", err)
	}
	var resp Response
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, fmt.Errorf("helper response: %w", err)
	}
	if !resp.OK {
		if resp.Error == nil {
			return nil, &Error{Code: CodeInternal, Message: "helper failed without error"}
		}
		return nil, resp.Error
	}
	if resp.Result == nil {
		resp.Result = &Result{}
	}
	return resp.Result, nil
}

// ReadRequestLine reads one bounded line (DecodeRequest applies the per-operation bound).
func ReadRequestLine(rd *bufio.Reader) ([]byte, error) { return readLine(rd, MaxPathsRequestBytes) }

func readLine(rd *bufio.Reader, max int) ([]byte, error) {
	var out []byte
	for {
		chunk, isPrefix, err := rd.ReadLine()
		if err != nil {
			return nil, err
		}
		out = append(out, chunk...)
		if len(out) > max {
			return nil, errors.New("line too long")
		}
		if !isPrefix {
			return out, nil
		}
	}
}

// CodeOf returns the helper error code of err, or "".
func CodeOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}
