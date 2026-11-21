package provision

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/device"

	"github.com/CybexBV/whombat/appliance/internal/recoverykey"
	"github.com/CybexBV/whombat/appliance/provisioning/internal/claim"
	"github.com/CybexBV/whombat/appliance/provisioning/internal/control"
)

// fakeControl verifies with the contracts binding and rejects repeated serials/keys like control; it
// also takes the claim verifier (devices.registerClaimVerifier, CT-43).
type fakeCtl struct {
	mu          sync.Mutex
	regs        []device.DeviceRegistration
	selfRegs    int // registrations through the self-register endpoint (CC-10)
	verifiers   map[string]string
	verifierErr int // HTTP status to answer the verifier call with (0 = normal)
	selfStatus  int // HTTP status to answer self-register with (0 = normal)
}

func fakeControl(t *testing.T) (*httptest.Server, *[]device.DeviceRegistration) {
	srv, fc := fakeControlCtl(t)
	return srv, &fc.regs
}

func fakeControlCtl(t *testing.T) (*httptest.Server, *fakeCtl) {
	fc := &fakeCtl{verifiers: map[string]string{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		self := r.URL.Path == control.SelfRegisterPath
		if self && (r.Header.Get("Authorization") != "" || fc.selfStatus != 0) {
			// A self-installed appliance holds no credential (CC-10).
			w.WriteHeader(map[bool]int{true: 400, false: fc.selfStatus}[r.Header.Get("Authorization") != ""])
			return
		}
		if !self && r.Header.Get("Authorization") != "Bearer station-token" {
			w.WriteHeader(401)
			return
		}
		body, _ := io.ReadAll(r.Body)
		fc.mu.Lock()
		defer fc.mu.Unlock()
		if dev, ok := strings.CutSuffix(strings.TrimPrefix(r.URL.Path, control.Path+"/"), "/claim-verifier"); ok && r.URL.Path != control.Path {
			if fc.verifierErr != 0 {
				w.WriteHeader(fc.verifierErr)
				return
			}
			known := false
			for _, reg := range fc.regs {
				known = known || "dev_"+reg.HardwareSerial == dev
			}
			v, err := device.ParseClaimVerifierRegistration(body)
			switch {
			case !known:
				w.WriteHeader(404)
			case err != nil:
				w.WriteHeader(400)
			case fc.verifiers[dev] != "" && fc.verifiers[dev] != v.ClaimVerifier:
				w.WriteHeader(409)
			default:
				fc.verifiers[dev] = v.ClaimVerifier
				w.WriteHeader(201)
				_, _ = w.Write([]byte(`{"ok":true}`))
			}
			return
		}
		if r.URL.Path != control.Path && !self {
			w.WriteHeader(404)
			return
		}
		var reg device.DeviceRegistration
		if json.Unmarshal(body, &reg) != nil || !device.VerifyRegistration(&reg) {
			w.WriteHeader(400)
			return
		}
		for _, o := range fc.regs {
			if o.HardwareSerial == reg.HardwareSerial || o.ContentPublicKey == reg.ContentPublicKey {
				w.WriteHeader(409)
				return
			}
		}
		if self {
			if reg.Model != SelfInstalledModel {
				w.WriteHeader(400)
				return
			}
			fc.selfRegs++
		}
		fc.regs = append(fc.regs, reg)
		w.WriteHeader(201)
		_ = json.NewEncoder(w).Encode(device.DeviceRegistrationResponse{Device: "dev_" + reg.HardwareSerial, ApplianceRoute: "rt_x", Env: reg.Env})
	}))
	t.Cleanup(srv.Close)
	return srv, fc
}

var displaySecret = regexp.MustCompile(`[A-Z2-7]{4}(-[A-Z2-7]{1,4}){6}`)

// TestClaimVerifierRegisteredBeforeCard: control holds exactly protocol.ClaimVerifier(deviceId,
// secret on the card); control never receives the secret or its appliance-side hash.
func TestClaimVerifierRegisteredBeforeCard(t *testing.T) {
	srv, fc := fakeControlCtl(t)
	o := opts(t, srv.URL, "SN-CV1")
	rec, err := Provision(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	svg, _ := os.ReadFile(filepath.Join(o.CardDir, "claim-"+rec.DeviceID+".svg"))
	printed := displaySecret.FindString(string(svg))
	if printed == "" {
		t.Fatal("no claim code on the card")
	}
	want, err := claim.Verifier(rec.DeviceID, printed)
	if err != nil || fc.verifiers[rec.DeviceID] != want {
		t.Fatalf("control verifier %q, want %q (%v)", fc.verifiers[rec.DeviceID], want, err)
	}
	cj, _ := os.ReadFile(filepath.Join(o.PersistDir, "identity", ClaimSecretRef))
	if strings.Contains(string(cj), want) || strings.Contains(string(cj), claim.Normalize(printed)) {
		t.Fatal("claim.json must hold only the appliance hash")
	}
}

// If control does not take the verifier, provisioning fails and leaves no claim.json, no identity and
// no card (a card whose claim control could never open must not exist).
func TestClaimVerifierFailureAbortsProvisioning(t *testing.T) {
	for _, status := range []int{409, 500} {
		srv, fc := fakeControlCtl(t)
		fc.verifierErr = status
		o := opts(t, srv.URL, "SN-CV-FAIL")
		if _, err := Provision(context.Background(), o); err == nil || !strings.Contains(err.Error(), "claim verifier") {
			t.Fatalf("HTTP %d: provisioning did not fail: %v", status, err)
		}
		for _, f := range identityFiles {
			if _, err := os.Stat(filepath.Join(o.PersistDir, "identity", f)); err == nil {
				t.Fatalf("HTTP %d: %s left behind", status, f)
			}
		}
		if entries, _ := os.ReadDir(o.CardDir); len(entries) != 0 {
			t.Fatalf("HTTP %d: cards printed: %v", status, entries)
		}
		if enr := o.Enroller.(*fakeEnroller); len(enr.wiped) != len(o.LUKSDevices) {
			t.Fatalf("HTTP %d: recovery keyslots not wiped: %v", status, enr.wiped)
		}
	}
}

type fakeEnroller struct{ enrolled, wiped []string }

func (f *fakeEnroller) EnrollRecovery(_ context.Context, dev, key string) error {
	f.enrolled = append(f.enrolled, dev+"="+key)
	return nil
}
func (f *fakeEnroller) WipeRecovery(_ context.Context, dev, _ string) error {
	f.wiped = append(f.wiped, dev)
	return nil
}

func opts(t *testing.T, url, serial string) *Options {
	dir := t.TempDir()
	return &Options{
		PersistDir: filepath.Join(dir, "persist"), CardDir: filepath.Join(dir, "cards"), Environment: "dev",
		Model: "whombat-one", Serial: serial, ManagerUID: os.Getuid(), ManagerGID: os.Getgid(),
		Registrar:   &control.Client{BaseURL: url, Token: "station-token"},
		LUKSDevices: []string{"/dev/root", "/dev/persist"}, Enroller: &fakeEnroller{},
		Euid: func() int { return 0 },
	}
}

func TestProvisionAndVerify(t *testing.T) {
	srv, regs := fakeControl(t)
	o := opts(t, srv.URL, "SN-0001")
	rec, err := Provision(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if rec.DeviceID != "dev_SN-0001" || len(*regs) != 1 {
		t.Fatalf("record %+v", rec)
	}
	// Verify expects root-owned files; in the test everything is owned by the test user.
	got, err := verifyAs(o.PersistDir, os.Getuid())
	if err != nil || got.ContentPeerID != rec.ContentPeerID {
		t.Fatalf("verify: %v", err)
	}
	for _, f := range []string{"claim-dev_SN-0001.svg", "disk-recovery-dev_SN-0001.svg", "record-dev_SN-0001.json"} {
		if _, err := os.Stat(filepath.Join(o.CardDir, f)); err != nil {
			t.Fatal(err)
		}
	}
	svg, _ := os.ReadFile(filepath.Join(o.CardDir, "claim-dev_SN-0001.svg"))
	// CC-02: the card no longer prints a fingerprint to compare; it keeps the id, the secret and the QR code.
	if strings.Contains(string(svg), rec.Fingerprint) || !strings.Contains(string(svg), "<path") ||
		!strings.Contains(string(svg), rec.DeviceID) || displaySecret.FindString(string(svg)) == "" {
		t.Fatal("claim card: a fingerprint, or no id, secret or QR code")
	}
	rep, _ := os.ReadFile(filepath.Join(o.CardDir, "record-dev_SN-0001.json"))
	enr := o.Enroller.(*fakeEnroller)
	key := strings.SplitN(enr.enrolled[0], "=", 2)[1]
	if strings.Contains(string(rep), key) {
		t.Fatal("public record contains the recovery key")
	}
	// No secret material outside /persist and the cards.
	dev, _ := os.ReadFile(filepath.Join(o.PersistDir, "identity", DeviceFile))
	if strings.Contains(string(dev), key) {
		t.Fatal("device.json contains the recovery key")
	}
	// A second run on the same device is refused.
	if _, err := Provision(context.Background(), o); !errors.Is(err, ErrAlreadyProvisioned) {
		t.Fatalf("second run: %v", err)
	}
}

func TestDuplicateSerialLeavesDeviceUnprovisioned(t *testing.T) {
	srv, _ := fakeControl(t)
	if _, err := Provision(context.Background(), opts(t, srv.URL, "SN-DUP")); err != nil {
		t.Fatal(err)
	}
	o := opts(t, srv.URL, "SN-DUP")
	_, err := Provision(context.Background(), o)
	if !errors.Is(err, control.ErrConflict) {
		t.Fatalf("want conflict, got %v", err)
	}
	ents, _ := os.ReadDir(filepath.Join(o.PersistDir, "identity"))
	if len(ents) != 0 {
		t.Fatalf("identity dir not cleaned up: %v", ents)
	}
	if _, err := os.Stat(filepath.Join(o.PersistDir, "secrets", "master.key")); err == nil {
		t.Fatal("master key left behind")
	}
	if enr := o.Enroller.(*fakeEnroller); len(enr.wiped) != 2 {
		t.Fatalf("recovery keyslots not wiped: %v", enr.wiped)
	}
	if ents, _ := os.ReadDir(o.CardDir); len(ents) != 0 {
		t.Fatalf("cards written for a failed registration: %v", ents)
	}
}

func TestPreflightRefusals(t *testing.T) {
	o := opts(t, "http://127.0.0.1:1", "SN-x")
	o.Euid = func() int { return 1000 }
	if err := Preflight(o); err == nil {
		t.Fatal("non-root accepted")
	}
	o = opts(t, "http://127.0.0.1:1", "SN-x")
	o.RequireMount = true
	_ = os.MkdirAll(o.PersistDir, 0o755)
	if err := Preflight(o); err == nil || !strings.Contains(err.Error(), "not a mounted") {
		t.Fatalf("unmounted persist accepted: %v", err)
	}
	o = opts(t, "http://127.0.0.1:1", "SN-x")
	o.RequireSecureBoot = true
	o.SecureBootEnabled = func() (bool, error) { return false, nil }
	if err := Preflight(o); err == nil {
		t.Fatal("secure boot off accepted")
	}
	o = opts(t, "http://127.0.0.1:1", "SN-x")
	o.Environment = "prod"
	if err := Preflight(o); err == nil {
		t.Fatal("prod without a mounted /persist accepted")
	}
}

func selfOpts(t *testing.T, url, serial string) *Options {
	o := opts(t, url, serial)
	o.SelfInstalled, o.Model, o.LUKSDevices, o.Enroller = true, SelfInstalledModel, nil, nil
	o.Registrar = &control.SelfClient{BaseURL: url}
	return o
}

// noRecoveryKey: a self-installed appliance has no disk recovery key (PI-19): no hash, nothing for a console.
func noRecoveryKey(t *testing.T, persist string) {
	t.Helper()
	for _, f := range []string{recoverykey.HashFile, recoverykey.PendingFile, recoverykey.PendingDir} {
		if _, err := os.Lstat(filepath.Join(persist, f)); err == nil {
			t.Fatalf("%s exists", f)
		}
	}
}

// CC-10: a self-installed appliance gets the factory's identity layout, registered without a credential,
// with a claim.json that has no card secret, no claim verifier at control and no cards. PI-19: no disk
// recovery key.
func TestSelfInstalledProvisioning(t *testing.T) {
	srv, fc := fakeControlCtl(t)
	o := selfOpts(t, srv.URL, "SN-SELF-1")
	o.CardDir = ""
	rec, err := Provision(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if fc.selfRegs != 1 || len(fc.verifiers) != 0 || rec.Model != SelfInstalledModel || rec.RecoveryKeyEnrolled {
		t.Fatalf("self-register %d, verifiers %v, record %+v", fc.selfRegs, fc.verifiers, rec)
	}
	if _, err := verifyAs(o.PersistDir, os.Getuid()); err != nil {
		t.Fatalf("verify: %v", err)
	}
	noRecoveryKey(t, o.PersistDir)
	cj, _ := os.ReadFile(filepath.Join(o.PersistDir, "identity", ClaimSecretRef))
	var raw map[string]any
	if err := json.Unmarshal(cj, &raw); err != nil {
		t.Fatal(err)
	}
	if v, ok := raw["secretHash"]; !ok || v != nil || raw["deviceId"] != rec.DeviceID || raw["algorithm"] != ClaimAlgorithm {
		t.Fatalf("claim.json %s", cj)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(o.PersistDir), "cards")); err == nil {
		t.Fatal("a self-installed appliance writes no cards")
	}
	// A second run is refused like the factory's.
	if _, err := Provision(context.Background(), o); !errors.Is(err, ErrAlreadyProvisioned) {
		t.Fatalf("second run: %v", err)
	}
}

func TestSelfInstalledRefusals(t *testing.T) {
	srv, fc := fakeControlCtl(t)
	o := selfOpts(t, srv.URL, "SN-SELF-2")
	o.Environment = "prod"
	if _, err := Provision(context.Background(), o); !errors.Is(err, ErrSelfInstalledProd) {
		t.Fatalf("prod: %v", err)
	}
	// prod on the qualified VM platform passes that check (and then needs a mounted /persist).
	o = selfOpts(t, srv.URL, "SN-SELF-2")
	o.Environment, o.Platform = "prod", PlatformSelfInstalled
	if err := Preflight(o); errors.Is(err, ErrSelfInstalledProd) || err == nil || !strings.Contains(err.Error(), "mounted") {
		t.Fatalf("prod self-installed: %v", err)
	}
	// No disk recovery key, so nothing to enrol on LUKS volumes, on any platform (PI-19).
	for _, platform := range []string{PlatformSelfInstalled, PlatformFactory} {
		o = selfOpts(t, srv.URL, "SN-SELF-2")
		o.Platform = platform
		enr := &fakeEnroller{}
		o.LUKSDevices, o.Enroller = []string{"/dev/root"}, enr
		if _, err := Provision(context.Background(), o); err == nil || !strings.Contains(err.Error(), "no disk recovery key") {
			t.Fatalf("LUKS on %s: %v", platform, err)
		}
		if len(enr.enrolled) != 0 {
			t.Fatalf("%s: enrolled %v", platform, enr.enrolled)
		}
	}
	o = selfOpts(t, srv.URL, "SN-SELF-2")
	o.Platform = "raspberry"
	if err := Preflight(o); err == nil {
		t.Fatal("unknown platform accepted")
	}
	f := opts(t, srv.URL, "SN-SELF-2")
	f.Platform = PlatformSelfInstalled
	if err := Preflight(f); err == nil {
		t.Fatal("factory provisioning on self-installed accepted")
	}
	o = selfOpts(t, srv.URL, "SN-SELF-2")
	o.Model = "whombat-one"
	if _, err := Provision(context.Background(), o); err == nil {
		t.Fatal("a self-installed appliance with a factory model")
	}
	// Factory provisioning needs the verifier-capable client; the self client can't stand in for it.
	o = opts(t, srv.URL, "SN-SELF-2")
	o.Registrar = &control.SelfClient{BaseURL: srv.URL}
	if _, err := Provision(context.Background(), o); err == nil || !strings.Contains(err.Error(), "claim verifier") {
		t.Fatalf("factory with the self client: %v", err)
	}
	// Control closed (403) or rate-limited (429): nothing is left behind.
	for status, want := range map[int]error{403: control.ErrSelfRegistrationClosed, 404: control.ErrSelfRegistrationClosed, 429: control.ErrRateLimited} {
		fc.selfStatus = status
		o = selfOpts(t, srv.URL, "SN-SELF-3")
		if _, err := Provision(context.Background(), o); !errors.Is(err, want) {
			t.Fatalf("HTTP %d: %v", status, err)
		}
		if ents, _ := os.ReadDir(filepath.Join(o.PersistDir, "identity")); len(ents) != 0 {
			t.Fatalf("HTTP %d: identity left behind: %v", status, ents)
		}
		noRecoveryKey(t, o.PersistDir)
	}
	if len(fc.regs) != 0 {
		t.Fatalf("registered: %v", fc.regs)
	}
}

// verify ties a null secretHash to the self-installed model and nothing else.
func TestVerifyClaimFileByModel(t *testing.T) {
	srv, _ := fakeControlCtl(t)
	factory := opts(t, srv.URL, "SN-V-1")
	if _, err := Provision(context.Background(), factory); err != nil {
		t.Fatal(err)
	}
	self := selfOpts(t, srv.URL, "SN-V-2")
	if _, err := Provision(context.Background(), self); err != nil {
		t.Fatal(err)
	}
	swap := func(dir string, mutate func(map[string]any)) {
		p := filepath.Join(dir, "identity", ClaimSecretRef)
		b, _ := os.ReadFile(p)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		mutate(m)
		b, _ = json.Marshal(m)
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	swap(factory.PersistDir, func(m map[string]any) { m["secretHash"] = nil })
	if _, err := verifyAs(factory.PersistDir, os.Getuid()); err == nil {
		t.Fatal("a factory appliance without a card secret hash verified")
	}
	swap(self.PersistDir, func(m map[string]any) { m["secretHash"] = strings.Repeat("A", 43) })
	if _, err := verifyAs(self.PersistDir, os.Getuid()); err == nil {
		t.Fatal("a self-installed appliance with a card secret hash verified")
	}
}

// MG-30/NX-35: a retired, never-claimed self-installed appliance gets new keys and registers again; the
// secrets (master key, runner token) stay so the runtime's database remains readable.
func TestSelfInstalledReplace(t *testing.T) {
	srv, fc := fakeControlCtl(t)
	o := selfOpts(t, srv.URL, "SN-SELF-R")
	first, err := Provision(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	master, _ := os.ReadFile(filepath.Join(o.PersistDir, "secrets", "master.key"))
	token, _ := os.ReadFile(filepath.Join(o.PersistDir, "secrets", RunnerToken))
	// A disk recovery key hash an earlier image stored (PI-04) stays through re-registration.
	hash, err := recoverykey.Hash(nil, "cbdefghi-jklnrtuv-cbdefghi-jklnrtuv-cbdefghi-jklnrtuv-cbdefghi-jklnrtuv",
		recoverykey.Params{MemoryKiB: 64, Time: 1, Threads: 1})
	if err != nil {
		t.Fatal(err)
	}
	hashPath := filepath.Join(o.PersistDir, recoverykey.HashFile)
	if err := os.WriteFile(hashPath, []byte(hash+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Control retired it: the serial is free again (CL-34).
	fc.mu.Lock()
	fc.regs = nil
	fc.mu.Unlock()
	o.Replace = true
	second, err := Provision(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if second.ContentPeerID == first.ContentPeerID || second.ManagementPublicKey == first.ManagementPublicKey {
		t.Fatal("no new keys")
	}
	got, err := verifyAs(o.PersistDir, os.Getuid())
	if err != nil || got.ContentPeerID != second.ContentPeerID {
		t.Fatalf("verify after replace: %v", err)
	}
	m2, _ := os.ReadFile(filepath.Join(o.PersistDir, "secrets", "master.key"))
	t2, _ := os.ReadFile(filepath.Join(o.PersistDir, "secrets", RunnerToken))
	if string(m2) != string(master) || string(t2) != string(token) {
		t.Fatal("secrets replaced")
	}
	if h, _ := os.ReadFile(hashPath); string(h) != hash+"\n" {
		t.Fatal("re-registration touched the earlier recovery key hash")
	}
	if _, err := os.Lstat(filepath.Join(o.PersistDir, recoverykey.PendingFile)); err == nil {
		t.Fatal("re-registration left a key for the console")
	}
	if ents, _ := filepath.Glob(filepath.Join(o.PersistDir, "identity", ".staging-*")); len(ents) != 0 {
		t.Fatalf("staging left behind: %v", ents)
	}
	// Control refusing (the old registration still live): nothing changes.
	o.Serial = "SN-SELF-R"
	if _, err := Provision(context.Background(), o); !errors.Is(err, control.ErrConflict) {
		t.Fatalf("conflict: %v", err)
	}
	if again, _ := verifyAs(o.PersistDir, os.Getuid()); again == nil || again.ContentPeerID != second.ContentPeerID {
		t.Fatal("a refused re-registration touched the identity")
	}
	// A broken hash from an earlier image fails verification (the recovery menu relies on it); none is fine.
	if err := os.WriteFile(hashPath, []byte("not a hash\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyAs(o.PersistDir, os.Getuid()); err == nil || !strings.Contains(err.Error(), recoverykey.HashFile) {
		t.Fatalf("broken hash: %v", err)
	}
	_ = os.Remove(hashPath)
	if _, err := verifyAs(o.PersistDir, os.Getuid()); err != nil {
		t.Fatalf("no hash: %v", err)
	}
	// Only self-installed appliances.
	f := opts(t, srv.URL, "SN-F-R")
	f.Replace = true
	if _, err := Provision(context.Background(), f); err == nil {
		t.Fatal("factory replace accepted")
	}
}

// A community box makes its own identity (NX-445): the self-installed flow with the local registrar, no control.
func TestLocalRegistrar(t *testing.T) {
	idRe := regexp.MustCompile(`^wb-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$`)
	ids := map[string]bool{}
	for i := range 3 {
		o := selfOpts(t, "http://control.invalid", "SN-LOCAL-"+strconv.Itoa(i))
		o.CardDir, o.Registrar = "", LocalRegistrar{}
		rec, err := Provision(context.Background(), o)
		if err != nil {
			t.Fatal(err)
		}
		if !idRe.MatchString(rec.DeviceID) || rec.ApplianceRoute != LocalRoute || rec.Model != SelfInstalledModel || rec.RecoveryKeyEnrolled {
			t.Fatalf("%+v", rec)
		}
		if _, err := verifyAs(o.PersistDir, os.Getuid()); err != nil {
			t.Fatalf("verify: %v", err)
		}
		// The signed registration the manager sends with link.begin (LNK-03): both proofs, the identity's facts.
		b, err := os.ReadFile(filepath.Join(o.PersistDir, "identity", RegistrationFile))
		if err != nil {
			t.Fatal(err)
		}
		var reg device.DeviceRegistration
		if err := json.Unmarshal(b, &reg); err != nil || !device.VerifyRegistration(&reg) ||
			reg.ContentPeerID != rec.ContentPeerID || reg.ProvisionedAt != rec.ProvisionedAt || reg.HardwareSerial != rec.Serial {
			t.Fatalf("registration.json %s (%v)", b, err)
		}
		if fi, _ := os.Stat(filepath.Join(o.PersistDir, "identity", RegistrationFile)); fi.Mode().Perm() != 0o644 {
			t.Fatalf("registration.json mode %v", fi.Mode())
		}
		ids[rec.DeviceID] = true
	}
	if len(ids) != 3 {
		t.Fatal("ids repeat")
	}
	if _, err := (LocalRegistrar{}).Register(context.Background(), &device.DeviceRegistration{HardwareSerial: "SN-X"}); err == nil {
		t.Fatal("a registration whose signatures don't verify was accepted")
	}
}
