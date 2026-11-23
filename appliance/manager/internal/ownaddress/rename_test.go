package ownaddress

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/CybexBV/whombat/contracts/go/device"
)

const (
	oldHost  = "maple-otter-river.box.whombat.app"
	newHost  = "maple-otter-river.whombat.app"
	homeHost = "home.whombat.app"
)

// newServiceIn is newService in an environment of zone.
func newServiceIn(t *testing.T, c *clock, zone string) (*Service, *Store, *fakeOrderer) {
	t.Helper()
	st, err := OpenStore(filepath.Join(t.TempDir(), "own-address"))
	if err != nil {
		t.Fatal(err)
	}
	s, err := Open(Mode{Enabled: true, Zone: zone, Directory: "https://ca.example.com/dir"}, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	o := &fakeOrderer{t: t, store: st, now: c.now, life: 90 * 24 * time.Hour}
	s.Prober, s.Orderer, s.Now = &fakeProber{}, o, c.now
	return s, st, o
}

func adopt(t *testing.T, s *Service, a Address) bool {
	t.Helper()
	changed, err := s.Adopt(a)
	if err != nil {
		t.Fatal(err)
	}
	return changed
}

func pairFiles(t *testing.T, st *Store, serial string) bool {
	t.Helper()
	_, err1 := os.Stat(filepath.Join(st.Dir(), serial+".key"))
	_, err2 := os.Stat(filepath.Join(st.Dir(), serial+".pem"))
	return err1 == nil && err2 == nil
}

// A prod box under box.whombat.app moves when control names whombat.app: the same label under the new zone, the old
// host served with the pair it has for 30 days (no new orders for it), the new host's certificate ordered at once.
func TestMoveKeepsTheOldPairAsLeaving(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)}
	s, st, o := newServiceIn(t, c, "whombat.app")
	adopt(t, s, Address{Label: "maple-otter-river", Host: oldHost, RegisteredAt: 1_790_000_000})
	_, states := step(t, s, c, 1)
	old := states[0].Cert
	if old == nil || o.n != 1 || o.hosts[0] != oldHost {
		t.Fatalf("before the move: %+v, orders %v", states[0], o.hosts)
	}
	for zone, want := range map[string]bool{"whombat.app": true, "box.whombat.app": false, "": false, "dev.whombat.app": false} {
		if label, ok := s.MoveWanted(zone); ok != want || (ok && label != "maple-otter-river") {
			t.Fatalf("MoveWanted(%q) = %q %v", zone, label, ok)
		}
	}
	until := c.now().Add(30 * 24 * time.Hour)
	if !adopt(t, s, Address{Label: "maple-otter-river", Host: newHost, RegisteredAt: 1_790_000_000,
		Leaving: &device.AddressLeaving{Label: "maple-otter-river", Host: oldHost, Until: until.Unix()}}) {
		t.Fatal("the move changed nothing")
	}
	r := s.State()
	if *r.Host != newHost || r.Cert != nil || r.Leaving == nil || r.Leaving.Host != oldHost ||
		r.Leaving.Until != until.Format(time.RFC3339) || r.Validate() != nil {
		t.Fatalf("after the move: %+v %+v", r, r.Leaving)
	}
	if c, ok := s.Cert(oldHost); !ok || c.Serial != old.Serial || c.Host != oldHost {
		t.Fatalf("the old host's pair: %+v", c)
	}
	if _, ok := s.Cert(""); ok {
		t.Fatal("a current pair before the new host's was ordered")
	}
	if _, ok := s.Cert("other-name.whombat.app"); ok {
		t.Fatal("a pair for a host the box doesn't answer at")
	}
	if h := s.Hosts(); !slices.Equal(h, []string{newHost, oldHost}) {
		t.Fatal(h)
	}
	if _, ok := s.MoveWanted("whombat.app"); ok {
		t.Fatal("a second move")
	}
	_, states = step(t, s, c, 1)
	if o.n != 2 || o.hosts[1] != newHost || states[0].Cert == nil || states[0].Cert.Serial == old.Serial {
		t.Fatalf("after the move: orders %v, %+v", o.hosts, states[0])
	}
	if c, ok := s.Cert(oldHost); !ok || c.Serial != old.Serial || !pairFiles(t, st, old.Serial) {
		t.Fatal("the old pair went with the new host's order")
	}
	// A restart keeps both.
	s2, err := Open(s.Mode, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	s2.Now = c.now
	if r := s2.State(); *r.Host != newHost || r.Cert == nil || r.Leaving == nil || r.Leaving.Host != oldHost {
		t.Fatalf("after a restart: %+v", r)
	}
	if c, ok := s2.Cert(oldHost); !ok || c.Serial != old.Serial {
		t.Fatal("the old pair after a restart")
	}
}

// The owner's rename: the new name takes over, the old host answers for 30 days; a second rename while it does keeps
// that one and its date, and the name in between stops at once, with its pair.
func TestRenameAndRenameDuringLeaving(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)}
	s, st, o := newServiceIn(t, c, "whombat.app")
	adopt(t, s, Address{Label: "maple-otter-river", Host: newHost})
	_, states := step(t, s, c, 1)
	first := states[0].Cert.Serial
	until := c.now().Add(30 * 24 * time.Hour).Unix()
	leaving := &device.AddressLeaving{Label: "maple-otter-river", Host: newHost, Until: until}
	adopt(t, s, Address{Label: "garden-shed", Host: "garden-shed.whombat.app", Leaving: leaving})
	_, states = step(t, s, c, 1)
	between := states[0].Cert.Serial
	if *states[0].Label != "garden-shed" || states[0].Leaving == nil || states[0].Leaving.Host != newHost {
		t.Fatalf("after the rename: %+v", states[0])
	}
	c.add(24 * time.Hour)
	adopt(t, s, Address{Label: "home", Host: homeHost, Leaving: leaving})
	r := s.State()
	if *r.Host != homeHost || r.Leaving == nil || r.Leaving.Host != newHost || r.Leaving.Until != time.Unix(until, 0).UTC().Format(time.RFC3339) {
		t.Fatalf("after the second rename: %+v %+v", r, r.Leaving)
	}
	if _, ok := s.Cert("garden-shed.whombat.app"); ok {
		t.Fatal("the name in between still answers")
	}
	if c, ok := s.Cert(newHost); !ok || c.Serial != first {
		t.Fatal("the leaving address lost its pair")
	}
	if pairFiles(t, st, between) || !pairFiles(t, st, first) {
		t.Fatal("the files of the name in between stayed, or the leaving pair's went")
	}
	_, _ = step(t, s, c, 1)
	if o.hosts[len(o.hosts)-1] != homeHost || slices.Contains(o.hosts, "") {
		t.Fatalf("orders %v", o.hosts)
	}
	for _, h := range o.hosts[2:] {
		if h == newHost {
			t.Fatal("an order for the leaving host")
		}
	}
}

// The leaving address stops at control's date (the loop wakes for it) and is forgotten with its files; with a pair
// that ends earlier, at the pair's end.
func TestLeavingStopsAndIsForgotten(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)}
	s, st, _ := newServiceIn(t, c, "dev.whombat.app")
	register(t, s)
	_, states := step(t, s, c, 1)
	old := states[0].Cert.Serial
	adopt(t, s, Address{Label: "home-box", Host: "home-box.dev.whombat.app",
		Leaving: &device.AddressLeaving{Label: "maple-otter-river", Host: testHost, Until: c.now().Add(30 * 24 * time.Hour).Unix()}})
	waits, states := step(t, s, c, 2)
	// The new host's pair renews in 60 days, but the loop wakes when the old address stops.
	if waits[0] != 30*24*time.Hour || states[0].Leaving == nil {
		t.Fatalf("waits %v, %+v", waits, states[0])
	}
	if states[1].Leaving != nil {
		t.Fatalf("still leaving after its date: %+v", states[1].Leaving)
	}
	if saved, _ := st.State(); saved.Leaving != nil {
		t.Fatal("still saved")
	}
	if pairFiles(t, st, old) {
		t.Fatal("the old pair's files stayed")
	}
	if _, ok := s.Cert(testHost); ok {
		t.Fatal("the old host still answers")
	}
	// The pair's end comes first: that is when it stops.
	l := &Leaving{Until: c.now().Add(30 * 24 * time.Hour)}
	p := &Pair{NotAfter: c.now().Add(10 * 24 * time.Hour)}
	if !l.End(p).Equal(p.NotAfter) || !l.End(nil).Equal(l.Until) {
		t.Fatal("End")
	}
}

// A new host without a pair yet leaves nothing to serve: no leaving address (none is ever ordered for it).
func TestRenameBeforeACertificateLeavesNothing(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)}
	s, _, _ := newServiceIn(t, c, "whombat.app")
	adopt(t, s, Address{Label: "maple-otter-river", Host: oldHost})
	adopt(t, s, Address{Label: "maple-otter-river", Host: newHost,
		Leaving: &device.AddressLeaving{Label: "maple-otter-river", Host: oldHost, Until: c.now().Add(time.Hour).Unix()}})
	if r := s.State(); r.Leaving != nil || *r.Host != newHost {
		t.Fatalf("%+v", r)
	}
}

// A certificate ordered for a host the box left during the order is dropped, and the new host's is ordered.
func TestOrderForALeftHostIsDropped(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)}
	s, _, o := newServiceIn(t, c, "whombat.app")
	adopt(t, s, Address{Label: "maple-otter-river", Host: newHost})
	o.during = func() { adopt(t, s, Address{Label: "home", Host: homeHost}) }
	_, states := step(t, s, c, 1)
	if !slices.Equal(o.hosts, []string{newHost, homeHost}) || states[0].Cert == nil {
		t.Fatalf("orders %v", o.hosts)
	}
	if c, ok := s.Cert(""); !ok || c.Host != homeHost {
		t.Fatalf("%+v", c)
	}
}

// A prod box's saved address under box.whombat.app stays when the environment's zone is whombat.app (the box moves
// only when control says so): never wipe an address and its certificate because the zone changed.
func TestOpenKeepsAnAddressUnderAnEarlierZone(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)}
	s, st, _ := newServiceIn(t, c, "box.whombat.app")
	adopt(t, s, Address{Label: "maple-otter-river", Host: oldHost})
	_, states := step(t, s, c, 1)
	s2, err := Open(Mode{Enabled: true, Zone: "whombat.app", Directory: s.Mode.Directory}, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	if l, h := s2.Label(); l != "maple-otter-river" || h != oldHost {
		t.Fatal(l, h)
	}
	if c, ok := s2.Cert(""); !ok || c.Serial != states[0].Cert.Serial {
		t.Fatal("the pair went")
	}
	// A dev environment never answers at a prod host.
	s3, err := Open(Mode{Enabled: true, Zone: "dev.whombat.app"}, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	if l, _ := s3.Label(); l != "" {
		t.Fatal("kept a prod name in dev")
	}
}

// Control's host must be the label directly under one of the environment's zones; a leaving address elsewhere is
// ignored.
func TestAdoptChecksEveryHost(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)}
	s, _, _ := newServiceIn(t, c, "whombat.app")
	for _, a := range []Address{
		{Label: "maple-otter-river", Host: "maple-otter-river.dev.whombat.app"},
		{Label: "box", Host: "box.whombat.app"},
		{Label: "home", Host: "home.box.whombat.app.example.com"},
		{Label: "ho", Host: "ho.whombat.app"},
	} {
		if _, err := s.Adopt(a); err == nil {
			t.Fatalf("%+v taken", a)
		}
	}
	adopt(t, s, Address{Label: "home", Host: homeHost,
		Leaving: &device.AddressLeaving{Label: "home", Host: "home.dev.whombat.app", Until: c.now().Add(time.Hour).Unix()}})
	if r := s.State(); r.Leaving != nil {
		t.Fatal("a leaving address of another environment")
	}
}

// Back to the address that is leaving: its pair, still valid, is the current one again at once (with its directory,
// so no order follows), and the name in between stops with its files.
func TestBackToTheLeavingAddressKeepsItsPair(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)}
	s, st, o := newServiceIn(t, c, "whombat.app")
	adopt(t, s, Address{Label: "maple-otter-river", Host: newHost})
	_, states := step(t, s, c, 1)
	first := states[0].Cert.Serial
	leaving := &device.AddressLeaving{Label: "maple-otter-river", Host: newHost, Until: c.now().Add(30 * 24 * time.Hour).Unix()}
	adopt(t, s, Address{Label: "home", Host: homeHost, Leaving: leaving})
	_, states = step(t, s, c, 1)
	between := states[0].Cert.Serial
	if o.n != 2 {
		t.Fatalf("orders %v", o.hosts)
	}
	c.add(24 * time.Hour)
	// Control leaves nothing leaving when the box goes back to the name that was.
	if !adopt(t, s, Address{Label: "maple-otter-river", Host: newHost}) {
		t.Fatal("going back changed nothing")
	}
	r := s.State()
	if *r.Host != newHost || r.Cert == nil || r.Cert.Serial != first || r.Leaving != nil {
		t.Fatalf("after going back: %+v", r)
	}
	if cert, ok := s.Cert(""); !ok || cert.Serial != first || cert.Host != newHost {
		t.Fatalf("current pair %+v", cert)
	}
	if !pairFiles(t, st, first) || pairFiles(t, st, between) {
		t.Fatal("the files of the pair kept, or of the name in between")
	}
	_, states = step(t, s, c, 1)
	if o.n != 2 || states[0].Acme.State != "valid" || states[0].Cert.Serial != first {
		t.Fatalf("an order after going back: %v, %+v", o.hosts, states[0])
	}
	// Kept across a restart.
	s2, err := Open(s.Mode, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	s2.Now = c.now
	if r := s2.State(); r.Cert == nil || r.Cert.Serial != first {
		t.Fatalf("after a restart: %+v", r)
	}
}

// A rename the box never heard of (its answer lost, or the box off past the leaving date): control's host is taken
// whatever control names as leaving, and its certificate ordered. An earlier pair answers only for the host control
// still names.
func TestControlsHostIsTakenWhateverIsLeaving(t *testing.T) {
	c := &clock{t: time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)}
	s, _, o := newServiceIn(t, c, "whombat.app")
	adopt(t, s, Address{Label: "maple-otter-river", Host: oldHost})
	step(t, s, c, 1)
	until := c.now().Add(30 * 24 * time.Hour).Unix()
	adopt(t, s, Address{Label: "maple-otter-river", Host: newHost,
		Leaving: &device.AddressLeaving{Label: "maple-otter-river", Host: oldHost, Until: until}})
	step(t, s, c, 1)
	// Control renamed newHost to home and keeps oldHost leaving; the box missed the answer.
	if !adopt(t, s, Address{Label: "home", Host: homeHost,
		Leaving: &device.AddressLeaving{Label: "maple-otter-river", Host: oldHost, Until: until}}) {
		t.Fatal("control's host not taken")
	}
	if r := s.State(); *r.Host != homeHost || r.Leaving == nil || r.Leaving.Host != oldHost {
		t.Fatalf("%+v", r)
	}
	if _, ok := s.Cert(newHost); ok {
		t.Fatal("the name in between still answers")
	}
	_, states := step(t, s, c, 1)
	if o.hosts[len(o.hosts)-1] != homeHost || states[0].Cert == nil {
		t.Fatalf("orders %v", o.hosts)
	}
	// Past every leaving date, control names another host and nothing leaving: taken, nothing kept.
	c.add(60 * 24 * time.Hour)
	if !adopt(t, s, Address{Label: "garden-shed", Host: "garden-shed.whombat.app"}) {
		t.Fatal("control's host not taken")
	}
	if r := s.State(); *r.Host != "garden-shed.whombat.app" || r.Leaving != nil || r.Cert != nil {
		t.Fatalf("%+v", r)
	}
}
