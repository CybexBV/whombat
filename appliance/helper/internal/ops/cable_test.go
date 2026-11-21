package ops

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/internal/activator"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
)

type cableWorld struct {
	t     *testing.T
	h     *Helper
	act   *activator.Fake
	state string
	cands string
}

func newCableWorld(t *testing.T) *cableWorld {
	t.Helper()
	d := t.TempDir()
	w := &cableWorld{t: t, state: filepath.Join(d, "state"), cands: filepath.Join(d, "candidates")}
	var err error
	if w.act, err = activator.NewFake(filepath.Join(d, "fake"), "/nix/store/00000000000000000000000000000000-system"); err != nil {
		t.Fatal(err)
	}
	if w.h, err = New(Config{StateDir: w.state, NetworkCandidatesDir: w.cands}, w.act); err != nil {
		t.Fatal(err)
	}
	return w
}

func (w *cableWorld) do(req proto.Request) (*proto.Result, *proto.Error) {
	w.t.Helper()
	req.V = proto.Version
	res, perr, _ := w.h.Handle(context.Background(), req)
	return res, perr
}

func (w *cableWorld) set(id, use string, deadline int) (*proto.Result, *proto.Error) {
	return w.do(proto.Request{Op: proto.OpCableSet, ChangeID: id, Use: use, DeadlineSec: deadline})
}

func (w *cableWorld) cable() (live, committed bool) {
	live, committed, _ = w.act.CableState(context.Background())
	return
}

func (w *cableWorld) live() string {
	b, _ := os.ReadFile(filepath.Join(w.act.Root, "network", "cable-live"))
	return string(b)
}

func TestCableRequests(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		req proto.Request
		ok  bool
	}{
		{proto.Request{Op: proto.OpCableSet, ChangeID: "c-abcdefgh", Use: "wifi", DeadlineSec: 120}, true},
		{proto.Request{Op: proto.OpCableSet, ChangeID: "c-abcdefgh", Use: "cable"}, true},
		{proto.Request{Op: proto.OpCableSet, ChangeID: "c-abcdefgh", Use: "off"}, false},
		{proto.Request{Op: proto.OpCableSet, ChangeID: "c-abcdefgh"}, false},
		{proto.Request{Op: proto.OpCableSet, ChangeID: "nope", Use: "wifi"}, false},
		{proto.Request{Op: proto.OpCableSet, ChangeID: "c-abcdefgh", Use: "wifi", SSID: "Home"}, false},
		{proto.Request{Op: proto.OpCableSet, ChangeID: "c-abcdefgh", Use: "wifi", DeadlineSec: proto.MaxWifiDeadlineSec + 1}, false},
		{proto.Request{Op: proto.OpCableConfirm, ChangeID: "c-abcdefgh"}, true},
		{proto.Request{Op: proto.OpCableConfirm, ChangeID: "c-abcdefgh", Use: "wifi"}, false},
		{proto.Request{Op: proto.OpCableRevert, ChangeID: "c-abcdefgh", DeadlineSec: 3}, false},
		{proto.Request{Op: proto.OpWifiConfirm, ChangeID: "c-abcdefgh", Use: "wifi"}, false},
		{proto.Request{Op: proto.OpCableStatus}, true},
		{proto.Request{Op: proto.OpCableStatus, ChangeID: "c-abcdefgh"}, false},
	} {
		c.req.V = proto.Version
		b, _ := json.Marshal(c.req)
		_, err := proto.DecodeRequest(b)
		if (err == nil) != c.ok {
			t.Errorf("%s: err %v, want ok %v", b, err, c.ok)
		}
	}
}

func TestCableGuardedOffConfirmed(t *testing.T) {
	t.Parallel()
	w := newCableWorld(t)
	res, perr := w.set("c-off00001", "wifi", 120)
	if perr != nil {
		t.Fatal(perr)
	}
	if !res.Cable.Off || res.Cable.CommittedOff || res.Cable.Pending != "c-off00001" {
		t.Fatalf("%+v", res.Cable)
	}
	if !w.act.CableDeadmanArmed() {
		t.Fatal("a guarded change arms the dead-man")
	}
	// Armed before the cable changed.
	ev := strings.Join(w.act.Events(), "\n")
	if strings.Index(ev, "cable-arm 180") > strings.Index(ev, "cable-set off=true") || !strings.Contains(ev, "cable-arm 180") {
		t.Fatal(ev)
	}
	for _, want := range []string{"Name=en* eth*", "DHCP=no", "IPv6AcceptRA=no", "LinkLocalAddressing=no"} {
		if !strings.Contains(w.live(), want) {
			t.Fatalf("%q not in\n%s", want, w.live())
		}
	}
	// The same change again is answered, another refused.
	if res, perr := w.set("c-off00001", "wifi", 120); perr != nil || !res.AlreadyDone {
		t.Fatal(res, perr)
	}
	if _, perr := w.set("c-other0001", "cable", 120); codeOf(perr) != proto.CodeCablePending {
		t.Fatal(perr)
	}
	st, perr := w.do(proto.Request{Op: proto.OpCableStatus})
	if perr != nil || st.Cable.Pending != "c-off00001" || !st.Cable.Off {
		t.Fatal(st, perr)
	}
	if _, perr := w.do(proto.Request{Op: proto.OpCableConfirm, ChangeID: "c-off00001"}); perr != nil {
		t.Fatal(perr)
	}
	if live, committed := w.cable(); !live || !committed || w.act.CableDeadmanArmed() {
		t.Fatal(live, committed)
	}
	// A confirm repeated after it ended answers done.
	if res, perr := w.do(proto.Request{Op: proto.OpCableConfirm, ChangeID: "c-off00001"}); perr != nil || !res.AlreadyDone {
		t.Fatal(res, perr)
	}
	// The cable again, guarded, confirmed: nothing switched off any more, now or after a restart.
	if _, perr := w.set("c-on000001", "cable", 60); perr != nil {
		t.Fatal(perr)
	}
	if live, committed := w.cable(); live || !committed {
		t.Fatal("the cable is on now, still off in the kept setting until confirmed", live, committed)
	}
	if _, perr := w.do(proto.Request{Op: proto.OpCableConfirm, ChangeID: "c-on000001"}); perr != nil {
		t.Fatal(perr)
	}
	if live, committed := w.cable(); live || committed {
		t.Fatal(live, committed)
	}
}

func TestCableGuardedRevertedAndDeadman(t *testing.T) {
	t.Parallel()
	w := newCableWorld(t)
	if _, perr := w.set("c-off00001", "wifi", 120); perr != nil {
		t.Fatal(perr)
	}
	if _, perr := w.do(proto.Request{Op: proto.OpCableRevert, ChangeID: "c-off00001"}); perr != nil {
		t.Fatal(perr)
	}
	if live, committed := w.cable(); live || committed || w.act.CableDeadmanArmed() {
		t.Fatal(live, committed)
	}
	// A confirm after the revert keeps nothing.
	if _, perr := w.do(proto.Request{Op: proto.OpCableConfirm, ChangeID: "c-off00001"}); codeOf(perr) != proto.CodeCableNotApplied {
		t.Fatal(perr)
	}
	// The dead-man undoes a change nobody confirmed or reverted.
	if _, perr := w.set("c-off00002", "wifi", 120); perr != nil {
		t.Fatal(perr)
	}
	if err := w.h.RevertCableDeadman(context.Background()); err != nil {
		t.Fatal(err)
	}
	if live, _ := w.cable(); live || w.act.CableDeadmanArmed() {
		t.Fatal("the dead-man put the cable back")
	}
	if _, perr := w.do(proto.Request{Op: proto.OpCableConfirm, ChangeID: "c-off00002"}); codeOf(perr) != proto.CodeCableNotApplied {
		t.Fatal(perr)
	}
}

func TestCableRestartWhileGuardedKeepsNothing(t *testing.T) {
	t.Parallel()
	w := newCableWorld(t)
	if _, perr := w.set("c-off00001", "wifi", 120); perr != nil {
		t.Fatal(perr)
	}
	w.act.SimulateCableRestart() // the kept setting (cable on) came back at the start
	if _, perr := w.do(proto.Request{Op: proto.OpCableConfirm, ChangeID: "c-off00001"}); codeOf(perr) != proto.CodeCableNotApplied {
		t.Fatal(perr)
	}
	if live, committed := w.cable(); live || committed {
		t.Fatal(live, committed)
	}
	if res, _ := w.do(proto.Request{Op: proto.OpCableStatus}); res.Cable.Pending != "" {
		t.Fatal("the change is over")
	}
}

func TestCableUnguardedIsKeptAtOnce(t *testing.T) {
	t.Parallel()
	w := newCableWorld(t)
	res, perr := w.set("c-off00001", "wifi", 0)
	if perr != nil || res.Cable.Pending != "" || !res.Cable.Off || !res.Cable.CommittedOff || w.act.CableDeadmanArmed() {
		t.Fatal(res, perr)
	}
	w.act.SimulateCableRestart()
	if live, _ := w.cable(); !live {
		t.Fatal("Wi-Fi only lasts across a restart")
	}
	if _, perr := w.set("c-on000001", "cable", 0); perr != nil {
		t.Fatal(perr)
	}
	if live, committed := w.cable(); live || committed {
		t.Fatal(live, committed)
	}
}

func TestCableFailedSwitchIsUndone(t *testing.T) {
	t.Parallel()
	w := newCableWorld(t)
	w.act.SetFail("cable-set", errors.New("networkctl failed"))
	if _, perr := w.set("c-off00001", "wifi", 120); codeOf(perr) != proto.CodeActivationFailed {
		t.Fatal(perr)
	}
	if res, _ := w.do(proto.Request{Op: proto.OpCableStatus}); res.Cable.Pending != "" || w.act.CableDeadmanArmed() {
		t.Fatal("a failed change leaves nothing pending")
	}
}

func TestCableSwitchesOffACommittedCandidatesInterface(t *testing.T) {
	t.Parallel()
	w := newCableWorld(t)
	os.MkdirAll(w.cands, 0o755)
	os.WriteFile(filepath.Join(w.cands, "n-static1.json"), []byte(`{"v":1,"id":"n-static1","interface":"enp3s0",
		"ipv4":{"mode":"static","address":"10.100.1.81/23","gateway":"10.100.0.1"},"ipv6":{"mode":"disabled"},
		"dns":["10.100.0.1"],"confirmTimeoutSec":120}`), 0o644)
	st, _ := loadState(w.state)
	st.Network.Committed = "n-static1"
	if err := saveState(w.state, st); err != nil {
		t.Fatal(err)
	}
	if _, perr := w.set("c-off00001", "wifi", 0); perr != nil {
		t.Fatal(perr)
	}
	if !strings.Contains(w.live(), "Name=en* eth* enp3s0\n") {
		t.Fatal(w.live())
	}
}

func TestCableMatchRefusesOddPatterns(t *testing.T) {
	t.Parallel()
	if _, err := activator.CableMatch([]string{"en*"}, []string{"eth0\nDHCP=yes"}); err == nil {
		t.Fatal("a pattern with a newline")
	}
	if m, err := activator.CableMatch([]string{"en*", "eth*"}, []string{"eth*"}); err != nil || len(m) != 2 {
		t.Fatal(m, err)
	}
}

func TestCableRevertThatFailsIsTriedAgain(t *testing.T) {
	t.Parallel()
	w := newCableWorld(t)
	if _, perr := w.set("c-off00001", "wifi", 120); perr != nil {
		t.Fatal(perr)
	}
	// networkd didn't take the cable back: the change stays pending (and its dead-man armed) instead of ending as if
	// the cable were back.
	w.act.SetFail("cable-set", errors.New("networkctl failed"))
	if _, perr := w.do(proto.Request{Op: proto.OpCableRevert, ChangeID: "c-off00001"}); codeOf(perr) != proto.CodeActivationFailed {
		t.Fatal(perr)
	}
	if res, _ := w.do(proto.Request{Op: proto.OpCableStatus}); res.Cable.Pending != "c-off00001" || !w.act.CableDeadmanArmed() {
		t.Fatal("a failed revert keeps the change pending", res.Cable)
	}
	if err := w.h.RevertCableDeadman(context.Background()); err == nil {
		t.Fatal("the dead-man says when it couldn't put the cable back")
	}
	w.act.SetFail("cable-set", nil)
	if _, perr := w.do(proto.Request{Op: proto.OpCableRevert, ChangeID: "c-off00001"}); perr != nil {
		t.Fatal(perr)
	}
	if live, committed := w.cable(); live || committed || w.act.CableDeadmanArmed() {
		t.Fatal(live, committed)
	}
}
