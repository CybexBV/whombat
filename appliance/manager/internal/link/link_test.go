package link

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// box is a box that made its identity itself, with a control it may or may not know.
type box struct {
	fc   *fakecontrol.Control
	c    *controlapi.Client
	reg  device.DeviceRegistration
	dir  string
	now  time.Time
	keep *Keeper
}

func newBox(t *testing.T, carried bool) *box {
	t.Helper()
	mpub, mpriv, _ := ed25519.GenerateKey(rand.Reader)
	cpub, cpriv, _ := ed25519.GenerateKey(rand.Reader)
	peer, err := protocol.PeerIDFromEd25519PublicKey(cpub)
	if err != nil {
		t.Fatal(err)
	}
	reg := device.DeviceRegistration{Env: release.Environment("dev"), HardwareSerial: "SN-LINK-1", Model: "self-installed",
		ManagementPublicKey: hexOf(mpub), ContentPeerID: peer, ContentPublicKey: hexOf(cpub), ProvisionedAt: 1790000000}
	if err := device.SignRegistration(&reg, mpriv, cpriv); err != nil {
		t.Fatal(err)
	}
	fc := fakecontrol.New("dev")
	t.Cleanup(fc.Close)
	b := &box{fc: fc, reg: reg, dir: t.TempDir(), now: time.Unix(1790000000, 0)}
	fc.Now = func() time.Time { return b.now }
	if carried {
		fc.Devices["wb-test-0000-0001"] = mpub
	}
	b.c = &controlapi.Client{BaseURL: fc.Server.URL, Env: "dev", DeviceID: "wb-test-0000-0001", Key: mpriv,
		Now: func() time.Time { return b.now }}
	b.keep = b.open(t, carried)
	return b
}

func hexOf(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, x := range b {
		out = append(out, digits[x>>4], digits[x&15])
	}
	return string(out)
}

func (b *box) open(t *testing.T, carried bool) *Keeper {
	t.Helper()
	k, err := Open(b.dir, carried, b.now)
	if err != nil {
		t.Fatal(err)
	}
	k.Control = b.c
	k.Now = func() time.Time { return b.now }
	k.Registration = func(proof string) (*device.DeviceRegistration, error) {
		r := b.reg
		if proof != "" {
			r.ContentProof = proof
		}
		return &r, nil
	}
	return k
}

func calls(fc *fakecontrol.Control) int {
	return fc.LinkCount(device.DeviceOpNameLinkBegin) + fc.LinkCount(device.DeviceOpNameLinkStatus) +
		fc.LinkCount(device.DeviceOpNameLinkLeave) + fc.Tickets
}

func TestNewBoxStartsOffAndCallsNothing(t *testing.T) {
	b := newBox(t, false)
	r := b.keep.Snapshot()
	if r.State != protocol.LinkStateOff || r.Active() || r.Known() || b.keep.Active() || b.keep.Known() {
		t.Fatalf("%+v", r)
	}
	// The poll loop's step with Link off asks control nothing (LNK-03).
	for range 3 {
		if _, err := b.keep.step(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if n := calls(b.fc); n != 0 {
		t.Fatalf("%d control calls with Link off", n)
	}
	if st := r.Status(); st.State != protocol.LinkStateOff || st.Pending != nil || st.CheckedAt != nil {
		t.Fatalf("%+v", st)
	}
}

func TestCarriedBoxStartsOn(t *testing.T) {
	b := newBox(t, true)
	r := b.keep.Snapshot()
	if r.State != protocol.LinkStateOn || !r.Carried || !b.keep.Active() {
		t.Fatalf("%+v", r)
	}
	// A control from before Link answers link.status 404: the carried box keeps working as it did.
	wait, err := b.keep.step(context.Background())
	if err != nil || wait != carriedRetry || b.keep.Snapshot().State != protocol.LinkStateOn {
		t.Fatalf("wait %v err %v %+v", wait, err, b.keep.Snapshot())
	}
	// A control that speaks Link decides.
	b.fc.SetLink(&device.DeviceLinkStatus{State: protocol.LinkStateGrace, Since: b.now.Unix(), GraceEndsAt: ptr(b.now.Add(7 * 24 * time.Hour).Unix())})
	if wait, err := b.keep.step(context.Background()); err != nil || wait != pollGrace {
		t.Fatal(wait, err)
	}
	if r := b.keep.Snapshot(); r.State != protocol.LinkStateGrace || r.Carried || r.CheckedAt == nil || r.GraceEndsAt == nil || !r.Active() {
		t.Fatalf("%+v", r)
	}
}

// A carried box that meets a control speaking Link before its comp (LNK-50's order slipped) hears `off`. That wasn't
// its owner's choice: it keeps asking, and comes back by itself once control comps it. The owner's own off stops it.
func TestCarriedBoxTurnedOffByControlComesBackWithItsComp(t *testing.T) {
	b := newBox(t, true)
	b.fc.SetLink(&device.DeviceLinkStatus{State: protocol.LinkStateOff, Since: b.now.Unix()})
	wait, err := b.keep.step(context.Background())
	if r := b.keep.Snapshot(); err != nil || r.State != protocol.LinkStateOff || !r.CarriedOff || r.Carried || wait != pollEnded {
		t.Fatalf("wait %v err %v %+v", wait, err, r)
	}
	n := b.fc.LinkCount(device.DeviceOpNameLinkStatus)
	if _, err := b.keep.step(context.Background()); err != nil || b.fc.LinkCount(device.DeviceOpNameLinkStatus) != n+1 {
		t.Fatal("a carried box turned off by control stopped asking", err)
	}
	b.fc.SetLink(&device.DeviceLinkStatus{State: protocol.LinkStateOn, Since: b.now.Unix(), Label: ptr("quiet-river-otter")})
	if _, err := b.keep.step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r := b.keep.Snapshot(); r.State != protocol.LinkStateOn || r.CarriedOff || r.Label != "quiet-river-otter" || !r.Active() {
		t.Fatalf("%+v", r)
	}

	// Turned off by control again, then by its owner: no more calls.
	c := newBox(t, true)
	c.fc.SetLink(&device.DeviceLinkStatus{State: protocol.LinkStateOff, Since: c.now.Unix()})
	if _, err := c.keep.step(context.Background()); err != nil || !c.keep.Snapshot().CarriedOff {
		t.Fatal(err, c.keep.Snapshot())
	}
	if _, err := c.keep.Off(context.Background()); err != nil {
		t.Fatal(err)
	}
	n = calls(c.fc)
	if wait, err := c.keep.step(context.Background()); err != nil || calls(c.fc) != n || wait != 24*time.Hour || c.keep.Snapshot().CarriedOff {
		t.Fatalf("after the owner's off: wait %v err %v calls %d → %d", wait, err, n, calls(c.fc))
	}
}

func ptr[T any](v T) *T { return &v }

func TestOnIntroducesTheBoxAndShowsTheCode(t *testing.T) {
	b := newBox(t, false)
	var seen []protocol.LinkState
	b.keep.OnChange = func(_, after Record) { seen = append(seen, after.State) }
	r, err := b.keep.On(context.Background(), "", "Kitchen")
	if err != nil {
		t.Fatal(err)
	}
	if r.State != protocol.LinkStateStarting || r.Pending == nil || r.Pending.Code != "ABCD-EFGH" || !r.Active() {
		t.Fatalf("%+v", r)
	}
	if len(b.fc.Registered) != 1 || b.fc.Registered[0].ContentPeerID != b.reg.ContentPeerID {
		t.Fatalf("control registered %+v", b.fc.Registered)
	}
	if len(seen) != 1 || seen[0] != protocol.LinkStateStarting {
		t.Fatalf("OnChange %v", seen)
	}
	st := r.Status()
	if st.State != protocol.LinkStateStarting || st.Pending == nil || st.Pending.Code != "ABCD-EFGH" || st.CheckedAt == nil {
		t.Fatalf("%+v", st)
	}
	if err := (&local.LinkStateResponse{V: 1, Enabled: true, Link: st}).Validate(); err != nil {
		t.Fatalf("not the contract's LocalLinkStatus: %v", err)
	}
	// Kept across a restart, with the proof and the name for a fresh code later.
	k2 := b.open(t, false)
	if r2 := k2.Snapshot(); r2.State != protocol.LinkStateStarting || r2.Name != "Kitchen" || r2.ContentProof != b.reg.ContentProof {
		t.Fatalf("%+v", r2)
	}
	// The person confirms: control answers on, with the label.
	b.fc.SetLink(&device.DeviceLinkStatus{State: protocol.LinkStateOn, Since: b.now.Unix(), Label: ptr("amber-otter-field"), Email: ptr("owner@example.com")})
	if wait, err := b.keep.step(context.Background()); err != nil || wait != pollOn {
		t.Fatal(wait, err)
	}
	if r := b.keep.Snapshot(); r.State != protocol.LinkStateOn || r.Label != "amber-otter-field" || r.Pending != nil {
		t.Fatalf("%+v", r)
	}
}

// The box is named after it linked (an Easy box links at its first start, before its setup asks for a name): while
// Link runs the runtime gives the name with On, and only a new one goes to control, after control says Link still runs.
func TestANameWhileLinkRunsGoesToControlOnce(t *testing.T) {
	b := newBox(t, false)
	if _, err := b.keep.On(context.Background(), "", ""); err != nil {
		t.Fatal(err)
	}
	b.fc.SetLink(&device.DeviceLinkStatus{State: protocol.LinkStateOn, Since: b.now.Unix(), Label: ptr("amber-otter-field")})
	if _, err := b.keep.step(context.Background()); err != nil {
		t.Fatal(err)
	}
	begins := func() int { return b.fc.LinkCount(device.DeviceOpNameLinkBegin) }
	if n := begins(); n != 1 {
		t.Fatalf("%d link.begin", n)
	}

	r, err := b.keep.On(context.Background(), "", "Kitchen")
	if err != nil || r.State != protocol.LinkStateOn || r.Pending != nil || r.Name != "Kitchen" {
		t.Fatalf("%v %+v", err, r)
	}
	if n := begins(); n != 2 || b.fc.BeginNames[1] != "Kitchen" {
		t.Fatalf("%d link.begin, names %q", n, b.fc.BeginNames)
	}
	// The same name again (the runtime's next start): no call at all.
	calls0 := calls(b.fc)
	if r, err := b.keep.On(context.Background(), "", "Kitchen"); err != nil || r.State != protocol.LinkStateOn || calls(b.fc) != calls0 {
		t.Fatalf("%v %+v, %d → %d calls", err, r, calls0, calls(b.fc))
	}
	// Kept across a restart.
	if r := b.open(t, false).Snapshot(); r.Name != "Kitchen" {
		t.Fatalf("%+v", r)
	}

	// Control ended Link meanwhile: the new name doesn't start it again with a fresh code.
	b.fc.SetLink(&device.DeviceLinkStatus{State: protocol.LinkStateEnded, Since: b.now.Unix()})
	r, err = b.keep.On(context.Background(), "", "Garden")
	if err != nil || r.State != protocol.LinkStateEnded || r.Pending != nil {
		t.Fatalf("%v %+v", err, r)
	}
	if n := begins(); n != 2 {
		t.Fatalf("%d link.begin after Link ended", n)
	}
}

func TestTheCodeIsRenewedWhenItRunsOut(t *testing.T) {
	b := newBox(t, false)
	if _, err := b.keep.On(context.Background(), "", ""); err != nil {
		t.Fatal(err)
	}
	b.now = b.now.Add(time.Duration(protocol.LinkCodeTTLS+1) * time.Second)
	b.fc.SetLink(nil) // control would answer starting without a code; link.begin gives a fresh one
	before := b.fc.LinkCount(device.DeviceOpNameLinkBegin)
	if _, err := b.keep.step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if b.fc.LinkCount(device.DeviceOpNameLinkBegin) != before+1 {
		t.Fatal("no fresh code")
	}
	if r := b.keep.Snapshot(); r.Pending == nil || !b.now.Before(r.Pending.ExpiresAt) {
		t.Fatalf("%+v", r)
	}
}

func TestTicketAnswersCarryTheState(t *testing.T) {
	b := newBox(t, false)
	if _, err := b.keep.On(context.Background(), "", ""); err != nil {
		t.Fatal(err)
	}
	ended := &device.DeviceLinkStatus{State: protocol.LinkStateEnded, Since: b.now.Unix()}
	b.fc.SetLink(ended)
	b.keep.Observe(ended)
	r := b.keep.Snapshot()
	if r.State != protocol.LinkStateEnded || r.Active() || !r.Known() {
		t.Fatalf("%+v", r)
	}
	// Something that isn't the contract's is ignored.
	b.keep.Observe(&device.DeviceLinkStatus{State: "paused", Since: b.now.Unix()})
	if b.keep.Snapshot().State != protocol.LinkStateEnded {
		t.Fatal("an invalid state was taken")
	}
	// Ended: link.status now and then (no tickets any more), so the box sees its owner subscribe again within minutes.
	if wait, err := b.keep.step(context.Background()); err != nil || wait != pollEnded || wait > 15*time.Minute {
		t.Fatal(wait, err)
	}
}

func TestOffHoldsAtOnceAndControlIsToldLater(t *testing.T) {
	b := newBox(t, false)
	if _, err := b.keep.On(context.Background(), "", ""); err != nil {
		t.Fatal(err)
	}
	b.fc.SetLink(&device.DeviceLinkStatus{State: protocol.LinkStateOn, Since: b.now.Unix(), Label: ptr("amber-otter-field")})
	b.fc.SetDown(true)
	r, err := b.keep.Off(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !r.Leaving || r.Active() || r.Known() || r.Status().State != protocol.LinkStateOff {
		t.Fatalf("%+v", r)
	}
	// Still leaving after a restart: the owner's off holds.
	if k2 := b.open(t, false); !k2.Snapshot().Leaving {
		t.Fatal("leaving lost")
	}
	// Ticket answers while leaving don't bring Link back.
	b.keep.Observe(&device.DeviceLinkStatus{State: protocol.LinkStateOn, Since: b.now.Unix()})
	if b.keep.Snapshot().Active() {
		t.Fatal("a ticket answer turned Link back on")
	}
	if _, err := b.keep.step(context.Background()); !errors.Is(err, controlapi.ErrUnavailable) {
		t.Fatalf("leave while control is down: %v", err)
	}
	b.fc.SetDown(false)
	if _, err := b.keep.step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r := b.keep.Snapshot(); r.Leaving || r.State != protocol.LinkStateOff || r.Label != "amber-otter-field" {
		t.Fatalf("%+v", r)
	}
	// Control took one link.leave (the ones while it was down never reached it).
	if b.fc.LinkCount(device.DeviceOpNameLinkLeave) != 1 {
		t.Fatalf("link.leave %d", b.fc.LinkCount(device.DeviceOpNameLinkLeave))
	}
	// Off again: nothing more is sent.
	n := calls(b.fc)
	if _, err := b.keep.Off(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := b.keep.step(context.Background()); err != nil || calls(b.fc) != n {
		t.Fatalf("calls after off: %d → %d (%v)", n, calls(b.fc), err)
	}
}

func TestTheReachChoiceWaitsForControl(t *testing.T) {
	b := newBox(t, false)
	b.fc.SetDown(true)
	if err := b.keep.WantOn(1); err != nil {
		t.Fatal(err)
	}
	if r := b.keep.Snapshot(); r.Want != "on" || r.ReachSeq != 1 || r.Active() {
		t.Fatalf("%+v", r)
	}
	if _, err := b.keep.step(context.Background()); err == nil {
		t.Fatal("began while control was down")
	}
	b.fc.SetDown(false)
	if _, err := b.keep.step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r := b.keep.Snapshot(); r.State != protocol.LinkStateStarting || r.Want != "" || r.Pending == nil {
		t.Fatalf("%+v", r)
	}
}

func TestRefusals(t *testing.T) {
	for code, want := range map[string]error{"device_exists": ErrDeviceExists, "rate_limited": ErrRateLimited,
		"registration_invalid": ErrInvalid} {
		b := newBox(t, false)
		b.fc.LinkRefuse2 = code
		if _, err := b.keep.On(context.Background(), "", ""); !errors.Is(err, want) {
			t.Fatalf("%s: %v", code, err)
		}
		if b.keep.Snapshot().State != protocol.LinkStateOff {
			t.Fatalf("%s: state changed", code)
		}
	}
	// A registration whose proofs don't verify never leaves the box.
	b := newBox(t, false)
	// A different first byte (a proof may start with 00 itself).
	bad := "00"
	if strings.HasPrefix(b.reg.ContentProof, bad) {
		bad = "ff"
	}
	if _, err := b.keep.On(context.Background(), bad+b.reg.ContentProof[2:], ""); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad proof: %v", err)
	}
	if calls(b.fc) != 0 {
		t.Fatal("sent a bad registration")
	}
	// No control in the environment: no Link.
	k, _ := Open(t.TempDir(), false, b.now)
	if _, err := k.On(context.Background(), "", ""); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
}

func TestStatusShowsOnlyWhatTheStateHas(t *testing.T) {
	now := time.Unix(1790000000, 0)
	r := Record{State: protocol.LinkStateOn, Since: now, Pending: &Pending{Code: "ABCD-EFGH", URL: "https://app.whombat.com/link", ExpiresAt: now},
		WaitingForAddress: true}
	if st := r.Status(); st.Pending != nil || st.WaitingForAddress != nil {
		t.Fatalf("%+v", st)
	}
}

// The claim link the runtime hands over goes with link.status, at once when it is new, and stops once the runtime takes
// it back (the box was claimed). A box whose Link is off sends nothing, claim link or not.
func TestTheClaimLinkGoesWithLinkStatus(t *testing.T) {
	b := newBox(t, false)
	b.keep.SetClaimLink("pqrtvw")
	if calls(b.fc) != 0 || len(b.fc.ClaimLinks) != 0 {
		t.Fatal("a box with Link off called control")
	}
	if wait, err := b.keep.step(context.Background()); err != nil || calls(b.fc) != 0 {
		t.Fatal(wait, err)
	}
	b.fc.SetLink(&device.DeviceLinkStatus{State: protocol.LinkStateOn, Since: b.now.Unix(), Label: ptr("maple-otter-river")})
	if _, err := b.keep.On(context.Background(), "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := b.keep.step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := b.fc.ClaimLinks; len(got) != 1 || got[0] != "pqrtvw" {
		t.Fatalf("%q", got)
	}
	// A new link wakes the loop, so it reaches control without waiting for the hourly look.
	drain(b.keep)
	b.keep.SetClaimLink("abcdef")
	if !woken(b.keep) {
		t.Fatal("a new claim link didn't wake the loop")
	}
	b.keep.SetClaimLink("abcdef")
	if woken(b.keep) {
		t.Fatal("the same link again woke the loop")
	}
	if _, err := b.keep.step(context.Background()); err != nil {
		t.Fatal(err)
	}
	b.keep.SetClaimLink("")
	if _, err := b.keep.step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := b.fc.ClaimLinks; len(got) != 3 || got[1] != "abcdef" || got[2] != "" {
		t.Fatalf("%q", got)
	}
	// The local view never shows it.
	if st := b.keep.Snapshot().Status(); strings.Contains(fmt.Sprintf("%+v", st), "abcdef") {
		t.Fatalf("%+v", st)
	}
}

// A control from before the field refuses the body: the state still comes, and the link is offered again an hour later.
func TestAControlBeforeClaimLinksStillGivesTheState(t *testing.T) {
	b := newBox(t, false)
	b.fc.SetLink(&device.DeviceLinkStatus{State: protocol.LinkStateOn, Since: b.now.Unix()})
	if _, err := b.keep.On(context.Background(), "", ""); err != nil {
		t.Fatal(err)
	}
	b.fc.StatusBeforeClaimLinks = true
	b.keep.SetClaimLink("pqrtvw")
	b.fc.SetLink(&device.DeviceLinkStatus{State: protocol.LinkStateGrace, Since: b.now.Unix(), GraceEndsAt: ptr(b.now.Unix() + 86400)})
	if _, err := b.keep.step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r := b.keep.Snapshot(); r.State != protocol.LinkStateGrace {
		t.Fatalf("%+v", r)
	}
	if got := b.fc.ClaimLinks; len(got) != 1 || got[0] != "" {
		t.Fatalf("%q", got)
	}
	// Within the hour it isn't offered again; after it, it is.
	b.fc.StatusBeforeClaimLinks = false
	if _, err := b.keep.step(context.Background()); err != nil {
		t.Fatal(err)
	}
	b.now = b.now.Add(claimRetry)
	if _, err := b.keep.step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := b.fc.ClaimLinks; len(got) != 3 || got[1] != "" || got[2] != "pqrtvw" {
		t.Fatalf("%q", got)
	}
}

func drain(k *Keeper) {
	for woken(k) {
	}
}

func woken(k *Keeper) bool {
	select {
	case <-k.wake:
		return true
	default:
		return false
	}
}
