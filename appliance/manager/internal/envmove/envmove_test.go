package envmove_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/envmove"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/protocol"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// TestMain makes every rename across the manager's folder and anything else fail with EXDEV, as on an installed box,
// where /persist/manager is a btrfs subvolume of its own (MG-179): every test moves and undoes that way.
func TestMain(m *testing.M) {
	inManager := func(p string) bool {
		sep := string(filepath.Separator)
		return strings.Contains(p+sep, sep+"persist"+sep+"manager"+sep)
	}
	envmove.SetRenameHook(func(oldpath, newpath string) error {
		if inManager(oldpath) != inManager(newpath) {
			return syscall.EXDEV
		}
		return nil
	})
	os.Exit(m.Run())
}

// box is a box of the development stack, as Home is: environment file `dev`, an identity it made itself with env
// local, the kept registration signed for local, and Link and own-address state.
type box struct {
	p      envmove.Paths
	mgmt   ed25519.PrivateKey
	device map[string]any
}

const image = `{"v": 1, "default": "prod", "environments": {
  "prod": {"deviceEnv": "prod", "controlUrl": "https://api.example.com", "ownAddressZone": "box.example.com"},
  "dev": {"deviceEnv": "local", "controlUrl": "https://api-dev.example.com", "ownAddressZone": "dev.example.com"},
  "staging": {"deviceEnv": "local", "controlUrl": "https://api-dev.example.com"},
  "dev2": {"deviceEnv": "dev", "controlUrl": "https://api-dev.example.com"}}}`

func newBox(t *testing.T, route string) *box {
	t.Helper()
	dir := t.TempDir()
	b := &box{p: envmove.Paths{Image: filepath.Join(dir, "environments.json"), Box: filepath.Join(dir, "persist", "whombat", "environment.json"),
		IdentityDir: filepath.Join(dir, "persist", "identity"), ManagerDir: filepath.Join(dir, "persist", "manager")}}
	write := func(p string, data []byte, mode os.FileMode) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, data, mode); err != nil {
			t.Fatal(err)
		}
	}
	write(b.p.Image, []byte(image), 0o644)
	write(b.p.Box, []byte(`{"v":1,"env":"dev"}`+"\n"), 0o644)
	_, mgmt, _ := ed25519.GenerateKey(rand.Reader)
	_, content, _ := ed25519.GenerateKey(rand.Reader)
	b.mgmt = mgmt
	der, err := x509.MarshalPKCS8PrivateKey(mgmt)
	if err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(b.p.IdentityDir, envmove.ManagementKey), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600)
	write(filepath.Join(b.p.IdentityDir, envmove.ContentKey), append([]byte{0x08, 0x01, 0x12, 0x40}, content...), 0o600)
	peer, err := protocol.PeerIDFromEd25519PublicKey(content.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	reg := device.DeviceRegistration{Env: "local", HardwareSerial: "SERIAL-1", Model: "self-installed",
		ManagementPublicKey: hex.EncodeToString(mgmt.Public().(ed25519.PublicKey)), ContentPeerID: peer,
		ContentPublicKey: hex.EncodeToString(content.Public().(ed25519.PublicKey)), ProvisionedAt: 1763000000}
	if err := device.SignRegistration(&reg, mgmt, content); err != nil {
		t.Fatal(err)
	}
	rb, _ := json.Marshal(&reg)
	write(filepath.Join(b.p.IdentityDir, envmove.RegistrationFile), append(rb, '\n'), 0o644)
	b.device = map[string]any{"v": 1, "deviceId": "wb-abcd-efgh-jkmn", "env": "local", "applianceRoute": route,
		"model": reg.Model, "serial": reg.HardwareSerial, "contentPeerId": reg.ContentPeerID,
		"contentPublicKey": reg.ContentPublicKey, "managementPublicKey": reg.ManagementPublicKey,
		"fingerprint": "fp-1", "provisionedAt": reg.ProvisionedAt, "recoveryKeyEnrolled": false}
	db, _ := json.MarshalIndent(b.device, "", "  ")
	write(filepath.Join(b.p.IdentityDir, envmove.DeviceFile), append(db, '\n'), 0o644)
	write(filepath.Join(b.p.ManagerDir, envmove.LinkDir, "journal.a.json"), []byte(`{"state":"on","label":"brave-otter"}`), 0o600)
	write(filepath.Join(b.p.ManagerDir, envmove.OwnAddressDir, "state.json"), []byte(`{"label":"brave-otter"}`), 0o600)
	// What the address keeps besides: a folder of keys, a link to the current one, a file others of its group may read.
	write(filepath.Join(b.p.ManagerDir, envmove.OwnAddressDir, "certs", "brave-otter.key"), []byte("made-up key"), 0o600)
	if err := os.Symlink("certs/brave-otter.key", filepath.Join(b.p.ManagerDir, envmove.OwnAddressDir, "current")); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(b.p.ManagerDir, envmove.LinkDir, "journal.b.json"), []byte(`{"state":"on"}`), 0o640)
	write(filepath.Join(b.p.ManagerDir, "journal", "journal.a.json"), []byte(`{}`), 0o600)
	return b
}

func (b *box) read(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func (b *box) registration(t *testing.T) device.DeviceRegistration {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(b.p.IdentityDir, envmove.RegistrationFile))
	if err != nil {
		t.Fatal(err)
	}
	var r device.DeviceRegistration
	if err := json.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

// Home's move (ONE-06): the identity's env becomes prod with every other member as it was, the kept registration is
// signed again for prod and verifies, Link and the own address are put aside (the journal stays), and the environment
// file names prod. A second run changes nothing.
func TestMoveToProduction(t *testing.T) {
	t.Parallel()
	b := newBox(t, "local")
	now := time.Date(2026, 11, 20, 9, 30, 0, 0, time.UTC)
	res, err := envmove.Move(b.p, "prod", now)
	if err != nil {
		t.Fatal(err)
	}
	if res.From != "dev" || res.To != "prod" || res.IdentityFrom != "local" || res.IdentityTo != "prod" ||
		!res.Registration || !res.BoxFile || res.SetAside == "" {
		t.Fatalf("result %+v", res)
	}
	got := b.read(t, filepath.Join(b.p.IdentityDir, envmove.DeviceFile))
	want := map[string]any{}
	for k, v := range b.device {
		want[k] = v
	}
	want["env"] = "prod"
	wb, _ := json.Marshal(want)
	var wantJSON map[string]any
	_ = json.Unmarshal(wb, &wantJSON)
	if !reflect.DeepEqual(got, wantJSON) {
		t.Fatalf("device.json: got %v, want %v", got, wantJSON)
	}
	reg := b.registration(t)
	if reg.Env != release.Environment("prod") || !device.VerifyRegistration(&reg) {
		t.Fatalf("the kept registration: env %s, verifies %v", reg.Env, device.VerifyRegistration(&reg))
	}
	if exists(filepath.Join(b.p.ManagerDir, envmove.LinkDir)) || exists(filepath.Join(b.p.ManagerDir, envmove.OwnAddressDir)) {
		t.Fatal("the Link or own-address state is still where the manager reads it")
	}
	if filepath.Base(res.SetAside) != "20261120T093000Z-dev" {
		t.Fatalf("set aside in %s", res.SetAside)
	}
	for _, f := range []string{filepath.Join(envmove.LinkDir, "journal.a.json"), filepath.Join(envmove.OwnAddressDir, "state.json")} {
		if !exists(filepath.Join(res.SetAside, f)) {
			t.Fatalf("%s wasn't kept", f)
		}
	}
	if st, err := os.Stat(filepath.Dir(res.SetAside)); err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("the moves folder: %v %v", st, err)
	}
	if !exists(filepath.Join(b.p.ManagerDir, "journal", "journal.a.json")) {
		t.Fatal("the update journal went")
	}
	if bx := b.read(t, b.p.Box); bx["env"] != "prod" {
		t.Fatalf("the environment file says %v", bx["env"])
	}
	again, err := envmove.Move(b.p, "prod", now.Add(time.Hour))
	if err != nil || again.Changed() {
		t.Fatalf("again: %+v, %v", again, err)
	}
}

// A move that stopped before its environment file finishes when it runs again: the identity and registration are
// already prod, the state is aside, and only the file is written.
func TestMoveFinishesAfterAStop(t *testing.T) {
	t.Parallel()
	b := newBox(t, "local")
	if _, err := envmove.Move(b.p, "prod", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(b.p.Box, []byte(`{"v":1,"env":"dev"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := envmove.Move(b.p, "prod", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !res.BoxFile || res.IdentityTo != "" || res.Registration || res.SetAside != "" {
		t.Fatalf("result %+v", res)
	}
}

// An identity control made keeps its env with that control (MG-178): another env of the same control is refused, and
// nothing is changed.
func TestMoveRefusesAControlIdentity(t *testing.T) {
	t.Parallel()
	b := newBox(t, "relay-7")
	if _, err := envmove.Move(b.p, "dev2", time.Now()); !errors.Is(err, envmove.ErrControlIdentity) {
		t.Fatalf("got %v", err)
	}
	if bx := b.read(t, b.p.Box); bx["env"] != "dev" {
		t.Fatal("the environment file changed")
	}
	if !exists(filepath.Join(b.p.ManagerDir, envmove.LinkDir)) {
		t.Fatal("the Link state went")
	}
	if d := b.read(t, filepath.Join(b.p.IdentityDir, envmove.DeviceFile)); d["env"] != "local" {
		t.Fatal("the identity changed")
	}
}

// The same control (and the same device env): only the environment file; Link and the own address stay.
func TestMoveWithinOneControl(t *testing.T) {
	t.Parallel()
	b := newBox(t, "local")
	res, err := envmove.Move(b.p, "staging", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !res.BoxFile || res.IdentityTo != "" || res.Registration || res.SetAside != "" {
		t.Fatalf("result %+v", res)
	}
	if !exists(filepath.Join(b.p.ManagerDir, envmove.LinkDir)) {
		t.Fatal("the Link state went")
	}
}

// An environment the image lacks is refused before anything changes; a kept registration that names other keys than
// device.json is refused too.
func TestMoveRefusals(t *testing.T) {
	t.Parallel()
	b := newBox(t, "local")
	if _, err := envmove.Move(b.p, "elsewhere", time.Now()); err == nil {
		t.Fatal("moved to an environment the image lacks")
	}
	if !exists(filepath.Join(b.p.ManagerDir, envmove.LinkDir)) {
		t.Fatal("a refused move put the state aside")
	}
	reg := b.registration(t)
	reg.HardwareSerial = "ANOTHER-1"
	rb, _ := json.Marshal(&reg)
	if err := os.WriteFile(filepath.Join(b.p.IdentityDir, envmove.RegistrationFile), rb, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := envmove.Move(b.p, "prod", time.Now()); !errors.Is(err, envmove.ErrIdentity) {
		t.Fatalf("a foreign registration: %v", err)
	}
	if d := b.read(t, filepath.Join(b.p.IdentityDir, envmove.DeviceFile)); d["env"] != "local" {
		t.Fatal("the identity changed after a refusal")
	}
	// Checked before anything moved (R1 #13): the address state is where the manager reads it.
	if !exists(filepath.Join(b.p.ManagerDir, envmove.LinkDir, "journal.a.json")) ||
		!exists(filepath.Join(b.p.ManagerDir, envmove.OwnAddressDir, "state.json")) {
		t.Fatal("a refused move put the address state aside")
	}
	if bx := b.read(t, b.p.Box); bx["env"] != "dev" || exists(filepath.Join(b.moves(), envmove.PendingFile)) {
		t.Fatal("a refused move changed the environment file or left a move under way")
	}
}

// A box without a kept registration (made before provisioning kept one) moves; the runtime's proof is used at
// link.begin.
func TestMoveWithoutARegistration(t *testing.T) {
	t.Parallel()
	b := newBox(t, "local")
	if err := os.Remove(filepath.Join(b.p.IdentityDir, envmove.RegistrationFile)); err != nil {
		t.Fatal(err)
	}
	res, err := envmove.Move(b.p, "prod", time.Now())
	if err != nil || res.Registration || res.IdentityTo != "prod" {
		t.Fatalf("result %+v, %v", res, err)
	}
	if exists(filepath.Join(b.p.IdentityDir, envmove.RegistrationFile)) {
		t.Fatal("a registration appeared")
	}
}

// unchanged checks the box is as newBox made it: Link and the own address where the manager reads them, the identity
// and the registration local (and verifying), the environment file dev, no move under way.
func (b *box) unchanged(t *testing.T) {
	t.Helper()
	for _, f := range []string{filepath.Join(envmove.LinkDir, "journal.a.json"), filepath.Join(envmove.OwnAddressDir, "state.json")} {
		if !exists(filepath.Join(b.p.ManagerDir, f)) {
			t.Fatalf("%s isn't where the manager reads it", f)
		}
	}
	if d := b.read(t, filepath.Join(b.p.IdentityDir, envmove.DeviceFile)); d["env"] != "local" {
		t.Fatalf("the identity says %v", d["env"])
	}
	if reg := b.registration(t); reg.Env != "local" || !device.VerifyRegistration(&reg) {
		t.Fatalf("the registration: %s", reg.Env)
	}
	if bx := b.read(t, b.p.Box); bx["env"] != "dev" {
		t.Fatalf("the environment file says %v", bx["env"])
	}
	if exists(filepath.Join(b.moves(), envmove.PendingFile)) {
		t.Fatal("a move is still under way")
	}
}

func (b *box) moves() string { return filepath.Join(filepath.Dir(b.p.ManagerDir), envmove.MovesDir) }

// moved checks the box is on production with everything of the move done.
func (b *box) moved(t *testing.T) {
	t.Helper()
	if exists(filepath.Join(b.p.ManagerDir, envmove.LinkDir)) || exists(filepath.Join(b.p.ManagerDir, envmove.OwnAddressDir)) {
		t.Fatal("the Link or own-address state is still where the manager reads it")
	}
	if d := b.read(t, filepath.Join(b.p.IdentityDir, envmove.DeviceFile)); d["env"] != "prod" {
		t.Fatalf("the identity says %v", d["env"])
	}
	if reg := b.registration(t); reg.Env != "prod" || !device.VerifyRegistration(&reg) {
		t.Fatalf("the registration: %s", reg.Env)
	}
	if bx := b.read(t, b.p.Box); bx["env"] != "prod" {
		t.Fatalf("the environment file says %v", bx["env"])
	}
	if exists(filepath.Join(b.moves(), envmove.PendingFile)) {
		t.Fatal("the move is still under way")
	}
}

// The move's folder is root's, beside the manager's (never inside it), and a link there is refused before anything
// changes (R1 #13).
func TestMoveKeepsItsFolderOutOfTheManagersReach(t *testing.T) {
	t.Parallel()
	b := newBox(t, "local")
	res, err := envmove.Move(b.p, "prod", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(res.SetAside) != b.moves() || strings.HasPrefix(res.SetAside, b.p.ManagerDir+string(filepath.Separator)) {
		t.Fatalf("set aside in %s", res.SetAside)
	}
	for _, f := range []string{"record.json", filepath.Join("before", envmove.DeviceFile), filepath.Join("new", envmove.DeviceFile)} {
		if !exists(filepath.Join(res.SetAside, f)) {
			t.Fatalf("the move's folder has no %s", f)
		}
	}

	linked := newBox(t, "local")
	elsewhere := t.TempDir()
	if err := os.Symlink(elsewhere, linked.moves()); err != nil {
		t.Fatal(err)
	}
	if _, err := envmove.Move(linked.p, "prod", time.Now()); !errors.Is(err, envmove.ErrPlace) {
		t.Fatalf("a link as the moves folder: %v", err)
	}
	linked.unchanged(t)
	if entries, _ := os.ReadDir(elsewhere); len(entries) != 0 {
		t.Fatal("something was written through the link")
	}
}

// A folder the move can't write to is found before anything changes.
func TestMovePreflight(t *testing.T) {
	t.Parallel()
	if os.Getuid() == 0 {
		t.Skip("root writes into a read-only folder")
	}
	b := newBox(t, "local")
	if err := os.Chmod(b.p.IdentityDir, 0o555); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(b.p.IdentityDir, 0o755)
	if _, err := envmove.Move(b.p, "prod", time.Now()); !errors.Is(err, envmove.ErrPlace) {
		t.Fatalf("a read-only identity folder: %v", err)
	}
	b.unchanged(t)
}

// A step that fails is undone: the box is as it was, the address state back where the manager reads it.
func TestMoveUndoesAFailedStep(t *testing.T) {
	for _, step := range []string{"aside", "registration", "identity", "box", "done"} {
		t.Run(step, func(t *testing.T) {
			b := newBox(t, "local")
			undo := envmove.SetApplyHook(func(s string) error {
				if s == step {
					return errors.New("disk full")
				}
				return nil
			})
			_, err := envmove.Move(b.p, "prod", time.Now())
			undo()
			if !errors.Is(err, envmove.ErrUndone) {
				t.Fatalf("got %v", err)
			}
			b.unchanged(t)
			// The next run moves it.
			if _, err := envmove.Move(b.p, "prod", time.Now()); err != nil {
				t.Fatal(err)
			}
			b.moved(t)
		})
	}
}

// A move that stopped (a crash before a step) is finished by Recover at the next boot (write-run), or by the next
// `environment set`; one that can't be finished then is undone.
func TestMoveFinishesOrUndoesAfterACrash(t *testing.T) {
	crash := func(t *testing.T, b *box, step string) {
		t.Helper()
		undo := envmove.SetApplyHook(func(s string) error {
			if s == step {
				runtime.Goexit() // the process stops here: nothing after this step runs, not even the undo
			}
			return nil
		})
		defer undo()
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, _ = envmove.Move(b.p, "prod", time.Now())
		}()
		<-done
		if !exists(filepath.Join(b.moves(), envmove.PendingFile)) {
			t.Fatal("the stopped move isn't under way")
		}
	}
	for _, step := range []string{"aside", "registration", "identity", "box", "done"} {
		t.Run(step+" then boot", func(t *testing.T) {
			b := newBox(t, "local")
			crash(t, b, step)
			res, err := envmove.Recover(b.p)
			if err != nil || res == nil || res.To != "prod" {
				t.Fatalf("recover: %+v %v", res, err)
			}
			b.moved(t)
			if res, err := envmove.Recover(b.p); res != nil || err != nil {
				t.Fatalf("recover again: %+v %v", res, err)
			}
		})
		t.Run(step+" then set again", func(t *testing.T) {
			b := newBox(t, "local")
			crash(t, b, step)
			if _, err := envmove.Move(b.p, "prod", time.Now()); err != nil {
				t.Fatal(err)
			}
			b.moved(t)
		})
	}
	t.Run("can't finish: undone", func(t *testing.T) {
		if os.Getuid() == 0 {
			t.Skip("root writes into a read-only folder")
		}
		b := newBox(t, "local")
		crash(t, b, "registration")
		box := filepath.Dir(b.p.Box)
		if err := os.Chmod(box, 0o555); err != nil {
			t.Fatal(err)
		}
		_, err := envmove.Recover(b.p)
		os.Chmod(box, 0o755)
		if !errors.Is(err, envmove.ErrUndone) {
			t.Fatalf("got %v", err)
		}
		b.unchanged(t)
	})
}

// The boot's gate (R2 A9): it goes on after a finished move or a confirmed undo, and holds everything (an error, the
// record kept, Pending true) when a stopped move can be neither finished nor undone; nothing then resolves the old
// environment with a moved identity.
func TestBootCheck(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root writes into a read-only folder")
	}
	crash := func(t *testing.T, b *box, step string) {
		t.Helper()
		undo := envmove.SetApplyHook(func(s string) error {
			if s == step {
				runtime.Goexit()
			}
			return nil
		})
		defer undo()
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, _ = envmove.Move(b.p, "prod", time.Now())
		}()
		<-done
	}
	t.Run("nothing under way", func(t *testing.T) {
		b := newBox(t, "local")
		if msg, err := envmove.BootCheck(b.p); err != nil || msg != "" {
			t.Fatalf("%q %v", msg, err)
		}
	})
	t.Run("finished", func(t *testing.T) {
		b := newBox(t, "local")
		crash(t, b, "box")
		if msg, err := envmove.BootCheck(b.p); err != nil || !strings.Contains(msg, "finished") {
			t.Fatalf("%q %v", msg, err)
		}
		b.moved(t)
	})
	t.Run("undone", func(t *testing.T) {
		b := newBox(t, "local")
		crash(t, b, "registration")
		box := filepath.Dir(b.p.Box)
		os.Chmod(box, 0o555)
		msg, err := envmove.BootCheck(b.p)
		os.Chmod(box, 0o755)
		if err != nil || !strings.Contains(msg, "undone") {
			t.Fatalf("%q %v", msg, err)
		}
		b.unchanged(t)
	})
	t.Run("neither: held", func(t *testing.T) {
		b := newBox(t, "local")
		crash(t, b, "box") // the identity says prod, the environment file still dev
		box, id := filepath.Dir(b.p.Box), b.p.IdentityDir
		os.Chmod(box, 0o555) // finishing can't write the environment file
		os.Chmod(id, 0o555)  // undoing can't write the identity back
		_, err := envmove.BootCheck(b.p)
		os.Chmod(box, 0o755)
		os.Chmod(id, 0o755)
		if err == nil || errors.Is(err, envmove.ErrUndone) || !strings.Contains(err.Error(), "holds the manager") {
			t.Fatalf("got %v", err)
		}
		if pending, err := envmove.Pending(b.p); err != nil || !pending {
			t.Fatalf("the record went: %v %v", pending, err)
		}
		// Once the disk takes writes again, the next boot finishes it.
		if msg, err := envmove.BootCheck(b.p); err != nil || !strings.Contains(msg, "finished") {
			t.Fatalf("the next boot: %q %v", msg, err)
		}
		b.moved(t)
	})
}

// homeRoute is Home's route: DEV control registered it on 2026-10-20, before LNK-01.
const homeRoute = "rt_jw3bs1kz18n4hkj8hm65q1fxb4"

// home is Home as it is: an identity DEV control made (route rt_…, env local) and no kept registration.
func home(t *testing.T) (*box, []byte) {
	t.Helper()
	b := newBox(t, homeRoute)
	if err := os.Remove(filepath.Join(b.p.IdentityDir, envmove.RegistrationFile)); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(b.p.IdentityDir, envmove.DeviceFile))
	if err != nil {
		t.Fatal(err)
	}
	return b, before
}

// adopted checks Home after its move: the identity is the box's own (route local, env prod), every other member as it
// was, and a kept registration signed for prod with the identity's keys.
func (b *box) adopted(t *testing.T) {
	t.Helper()
	got := b.read(t, filepath.Join(b.p.IdentityDir, envmove.DeviceFile))
	for k, v := range b.device {
		want := v
		switch k {
		case "env":
			want = "prod"
		case "applianceRoute":
			want = "local"
		}
		wb, _ := json.Marshal(want)
		gb, _ := json.Marshal(got[k])
		if string(wb) != string(gb) {
			t.Fatalf("device.json %s: %s, want %s", k, gb, wb)
		}
	}
	if len(got) != len(b.device) {
		t.Fatalf("device.json has other members: %v", got)
	}
	reg := b.registration(t)
	if reg.Env != "prod" || !device.VerifyRegistration(&reg) || reg.ManagementPublicKey != b.device["managementPublicKey"] ||
		reg.ContentPublicKey != b.device["contentPublicKey"] || reg.HardwareSerial != b.device["serial"] {
		t.Fatalf("the registration: %+v", reg)
	}
}

// Home's move (MG-178): its identity DEV control made becomes the box's own with the same device id and keys, a kept
// registration for prod is made (so Link can start from the box alone), and the undo puts everything back as it was:
// the identity byte for byte, no registration, Link and the own address where the manager reads them (what the manager
// made since goes into the move's folder). Undone once, there is nothing more to undo; moved again, it is adopted again.
func TestMoveAdoptsAControlIdentityAndUndo(t *testing.T) {
	t.Parallel()
	b, before := home(t)
	res, err := envmove.Move(b.p, "prod", time.Date(2026, 11, 20, 9, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if !res.Adopted || res.RouteFrom != homeRoute || res.IdentityFrom != "local" || res.IdentityTo != "prod" ||
		!res.Registration || !res.BoxFile || res.SetAside == "" || !res.Changed() {
		t.Fatalf("result %+v", res)
	}
	b.adopted(t)
	if bx := b.read(t, b.p.Box); bx["env"] != "prod" {
		t.Fatalf("the environment file says %v", bx["env"])
	}
	if exists(filepath.Join(b.p.ManagerDir, envmove.LinkDir)) {
		t.Fatal("DEV's Link state is still where the manager reads it")
	}
	// The manager ran in production: a Link state of its own.
	if err := os.MkdirAll(filepath.Join(b.p.ManagerDir, envmove.LinkDir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(b.p.ManagerDir, envmove.LinkDir, "journal.a.json"), []byte(`{"state":"starting"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	again, err := envmove.Move(b.p, "prod", time.Now())
	if err != nil || again.Changed() {
		t.Fatalf("moved again: %+v %v", again, err)
	}

	undone, err := envmove.Undo(b.p)
	if err != nil {
		t.Fatal(err)
	}
	if !undone.Adopted || undone.From != "dev" || undone.To != "prod" {
		t.Fatalf("undo %+v", undone)
	}
	if now, _ := os.ReadFile(filepath.Join(b.p.IdentityDir, envmove.DeviceFile)); string(now) != string(before) {
		t.Fatalf("device.json isn't as it was:\n%s", now)
	}
	if exists(filepath.Join(b.p.IdentityDir, envmove.RegistrationFile)) {
		t.Fatal("the registration the move made is still there")
	}
	if bx := b.read(t, b.p.Box); bx["env"] != "dev" {
		t.Fatalf("the environment file says %v", bx["env"])
	}
	j, err := os.ReadFile(filepath.Join(b.p.ManagerDir, envmove.LinkDir, "journal.a.json"))
	if err != nil || !strings.Contains(string(j), "brave-otter") {
		t.Fatalf("DEV's Link state isn't back: %s %v", j, err)
	}
	if !exists(filepath.Join(b.p.ManagerDir, envmove.OwnAddressDir, "state.json")) {
		t.Fatal("DEV's own address isn't back")
	}
	if !exists(filepath.Join(res.SetAside, "after", envmove.LinkDir, "journal.a.json")) {
		t.Fatal("production's Link state wasn't kept")
	}
	if _, err := envmove.Undo(b.p); !errors.Is(err, envmove.ErrNoMove) {
		t.Fatalf("a second undo: %v", err)
	}
	if _, err := envmove.Move(b.p, "prod", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	b.adopted(t)
}

// The undo refuses when the box changed since the move (it would put back more than the move did), and changes nothing.
func TestUndoRefusesAChangedBox(t *testing.T) {
	t.Parallel()
	b, _ := home(t)
	if _, err := envmove.Undo(b.p); !errors.Is(err, envmove.ErrNoMove) {
		t.Fatalf("no move yet: %v", err)
	}
	if _, err := envmove.Move(b.p, "prod", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(b.p.IdentityDir, envmove.DeviceFile), []byte(`{"deviceId":"wb-other","env":"prod"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := envmove.Undo(b.p); !errors.Is(err, envmove.ErrMovedSince) {
		t.Fatalf("got %v", err)
	}
	if bx := b.read(t, b.p.Box); bx["env"] != "prod" {
		t.Fatal("a refused undo changed the environment file")
	}
}

// Home's move that stopped is finished at the next boot (adopted) or undone when a step fails (Home as it was, no
// registration), as every move (MG-177).
func TestAdoptionStoppedOrFailed(t *testing.T) {
	for _, step := range []string{"aside", "registration", "identity", "box", "done"} {
		t.Run(step+" stopped then boot", func(t *testing.T) {
			b, _ := home(t)
			undo := envmove.SetApplyHook(func(s string) error {
				if s == step {
					runtime.Goexit()
				}
				return nil
			})
			done := make(chan struct{})
			go func() {
				defer close(done)
				_, _ = envmove.Move(b.p, "prod", time.Now())
			}()
			<-done
			undo()
			res, err := envmove.Recover(b.p)
			if err != nil || res == nil || !res.Adopted {
				t.Fatalf("recover: %+v %v", res, err)
			}
			b.adopted(t)
		})
		t.Run(step+" failed", func(t *testing.T) {
			b, before := home(t)
			undo := envmove.SetApplyHook(func(s string) error {
				if s == step {
					return errors.New("disk full")
				}
				return nil
			})
			_, err := envmove.Move(b.p, "prod", time.Now())
			undo()
			if !errors.Is(err, envmove.ErrUndone) {
				t.Fatalf("got %v", err)
			}
			if now, _ := os.ReadFile(filepath.Join(b.p.IdentityDir, envmove.DeviceFile)); string(now) != string(before) {
				t.Fatal("device.json isn't as it was")
			}
			if exists(filepath.Join(b.p.IdentityDir, envmove.RegistrationFile)) {
				t.Fatal("a registration stayed")
			}
		})
	}
}

// tree is what a folder holds, entry by entry: kind and mode, and the bytes of a file or the target of a link.
func tree(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		v := info.Mode().String()
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			l, _ := os.Readlink(path)
			v += " -> " + l
		case info.Mode().IsRegular():
			b, _ := os.ReadFile(path)
			v += " " + string(b)
		}
		out[rel] = v
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// state is the manager's Link and own-address folders as they are now.
func (b *box) state(t *testing.T) map[string]map[string]string {
	t.Helper()
	return map[string]map[string]string{
		envmove.LinkDir:       tree(t, filepath.Join(b.p.ManagerDir, envmove.LinkDir)),
		envmove.OwnAddressDir: tree(t, filepath.Join(b.p.ManagerDir, envmove.OwnAddressDir)),
	}
}

// The move's own rename refuses to cross into or out of the manager's folder in these tests (EXDEV, as two subvolumes
// do), so every move and undo here ran without one (MG-179).
func TestRenamesStayInTheirSubvolume(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	from := filepath.Join(dir, "persist", "manager", "link")
	to := filepath.Join(dir, "persist", "environment-moves", "link")
	if err := os.MkdirAll(from, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := envmove.Rename(from, to); !errors.Is(err, syscall.EXDEV) {
		t.Fatalf("a rename across: %v", err)
	}
}

// The state the move set aside is a copy that keeps folders, modes and links, and the undo brings back the same.
func TestSetAsideCopiesEverything(t *testing.T) {
	t.Parallel()
	b, _ := home(t)
	want := b.state(t)
	res, err := envmove.Move(b.p, "prod", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for name, w := range want {
		if got := tree(t, filepath.Join(res.SetAside, name)); !reflect.DeepEqual(got, w) {
			t.Fatalf("the copy of %s:\n%v\nwant\n%v", name, got, w)
		}
	}
	if _, err := envmove.Undo(b.p); err != nil {
		t.Fatal(err)
	}
	if got := b.state(t); !reflect.DeepEqual(got, want) {
		t.Fatalf("after the undo:\n%v\nwant\n%v", got, want)
	}
}

// The new steps of setting aside (MG-179), each stopped (finished at the next boot) and each failed (undone: the box
// as it was, its state the same entry by entry).
var asideSteps = []string{
	"aside:link:copy", "aside:link:copying", "aside:link:remove",
	"aside:own-address:copy", "aside:own-address:copying", "aside:own-address:remove",
}

func stopAt(t *testing.T, step string, run func()) {
	t.Helper()
	undo := envmove.SetApplyHook(func(s string) error {
		if s == step {
			runtime.Goexit() // the process stops here: nothing after this step runs
		}
		return nil
	})
	defer undo()
	done := make(chan struct{})
	go func() {
		defer close(done)
		run()
	}()
	<-done
}

func TestSetAsideStoppedOrFailed(t *testing.T) {
	for _, step := range asideSteps {
		t.Run(step+" stopped then boot", func(t *testing.T) {
			b, _ := home(t)
			want := b.state(t)
			stopAt(t, step, func() { _, _ = envmove.Move(b.p, "prod", time.Now()) })
			if !exists(filepath.Join(b.moves(), envmove.PendingFile)) {
				t.Fatal("the stopped move isn't under way")
			}
			res, err := envmove.Recover(b.p)
			if err != nil || res == nil || !res.Adopted {
				t.Fatalf("recover: %+v %v", res, err)
			}
			b.adopted(t)
			for name, w := range want {
				if got := tree(t, filepath.Join(res.SetAside, name)); !reflect.DeepEqual(got, w) {
					t.Fatalf("the copy of %s after the boot: %v", name, got)
				}
				if exists(filepath.Join(b.p.ManagerDir, name)) || exists(filepath.Join(res.SetAside, name+".copying")) {
					t.Fatalf("%s: the original or a temporary copy is left", name)
				}
			}
		})
		t.Run(step+" failed", func(t *testing.T) {
			b, before := home(t)
			want := b.state(t)
			undo := envmove.SetApplyHook(func(s string) error {
				if s == step {
					return errors.New("disk full")
				}
				return nil
			})
			_, err := envmove.Move(b.p, "prod", time.Now())
			undo()
			if !errors.Is(err, envmove.ErrUndone) {
				t.Fatalf("got %v", err)
			}
			if now, _ := os.ReadFile(filepath.Join(b.p.IdentityDir, envmove.DeviceFile)); string(now) != string(before) {
				t.Fatal("device.json isn't as it was")
			}
			if got := b.state(t); !reflect.DeepEqual(got, want) {
				t.Fatalf("the state after the undo: %v", got)
			}
		})
	}
	// A move that failed stops again while it is being undone: the next boot finishes the move.
	t.Run("undoing stopped then boot", func(t *testing.T) {
		b, _ := home(t)
		undo := envmove.SetApplyHook(func(s string) error {
			switch s {
			case "aside:own-address:copy":
				return errors.New("disk full")
			case "restore:link:copying":
				runtime.Goexit()
			}
			return nil
		})
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, _ = envmove.Move(b.p, "prod", time.Now())
		}()
		<-done
		undo()
		if res, err := envmove.Recover(b.p); err != nil || res == nil {
			t.Fatalf("recover: %+v %v", res, err)
		}
		b.adopted(t)
	})
}

// production makes the state the manager keeps in production after the move.
func (b *box) production(t *testing.T) map[string]map[string]string {
	t.Helper()
	for name, file := range map[string]string{envmove.LinkDir: "journal.a.json", envmove.OwnAddressDir: "state.json"} {
		d := filepath.Join(b.p.ManagerDir, name)
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, file), []byte(`{"state":"starting","label":"calm-heron"}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return b.state(t)
}

// environment undo stopped at every new step (keeping production's state, putting the move's copy back) is finished at
// the next boot, or by running it again: the identity, the registration, the file and DEV's state as they were,
// production's state kept in after/ (MG-179).
func TestUndoStoppedThenFinished(t *testing.T) {
	steps := []string{
		"after:link:copy", "after:link:copying", "after:link:remove",
		"after:own-address:copy", "after:own-address:copying", "after:own-address:remove",
		"restore:link:copy", "restore:link:copying", "restore:link:remove",
		"restore:own-address:copy", "restore:own-address:copying", "restore:own-address:remove",
	}
	for _, step := range steps {
		for _, finish := range []string{"boot", "undo again"} {
			t.Run(step+" then "+finish, func(t *testing.T) {
				b, before := home(t)
				want := b.state(t)
				res, err := envmove.Move(b.p, "prod", time.Now())
				if err != nil {
					t.Fatal(err)
				}
				prod := b.production(t)
				stopAt(t, step, func() { _, _ = envmove.Undo(b.p) })
				if pending, err := envmove.Pending(b.p); err != nil || !pending {
					t.Fatalf("the stopped undo isn't under way: %v %v", pending, err)
				}
				var got *envmove.Result
				if finish == "boot" {
					got, err = envmove.Recover(b.p)
				} else {
					got, err = envmove.Undo(b.p)
				}
				if err != nil || got == nil || !got.Undone {
					t.Fatalf("%s: %+v %v", finish, got, err)
				}
				if now, _ := os.ReadFile(filepath.Join(b.p.IdentityDir, envmove.DeviceFile)); string(now) != string(before) {
					t.Fatal("device.json isn't as it was")
				}
				if exists(filepath.Join(b.p.IdentityDir, envmove.RegistrationFile)) {
					t.Fatal("the registration the move made is still there")
				}
				if bx := b.read(t, b.p.Box); bx["env"] != "dev" {
					t.Fatalf("the environment file says %v", bx["env"])
				}
				if s := b.state(t); !reflect.DeepEqual(s, want) {
					t.Fatalf("DEV's state isn't back: %v", s)
				}
				for name, w := range prod {
					if kept := tree(t, filepath.Join(res.SetAside, "after", name)); !reflect.DeepEqual(kept, w) {
						t.Fatalf("production's %s wasn't kept: %v", name, kept)
					}
				}
				if pending, _ := envmove.Pending(b.p); pending {
					t.Fatal("the undo is still under way")
				}
			})
		}
	}
}

// A moves folder without room for the copy refuses the move before anything changes, and the undo too.
func TestNoRoomRefusesBeforeAnything(t *testing.T) {
	b, before := home(t)
	want := b.state(t)
	restore := envmove.SetFreeSpace(func(string) (int64, error) { return 1 << 20, nil })
	_, err := envmove.Move(b.p, "prod", time.Now())
	restore()
	if !errors.Is(err, envmove.ErrPlace) {
		t.Fatalf("got %v", err)
	}
	if now, _ := os.ReadFile(filepath.Join(b.p.IdentityDir, envmove.DeviceFile)); string(now) != string(before) {
		t.Fatal("device.json changed")
	}
	if got := b.state(t); !reflect.DeepEqual(got, want) {
		t.Fatal("the state changed")
	}
	if _, err := envmove.Move(b.p, "prod", time.Now()); err != nil {
		t.Fatal(err)
	}
	b.production(t)
	restore = envmove.SetFreeSpace(func(string) (int64, error) { return 1 << 20, nil })
	_, err = envmove.Undo(b.p)
	restore()
	if !errors.Is(err, envmove.ErrPlace) {
		t.Fatalf("the undo: %v", err)
	}
	if pending, _ := envmove.Pending(b.p); pending {
		t.Fatal("a refused undo is under way")
	}
	b.adopted(t)
}
