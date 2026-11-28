package winpc

import (
	"errors"
	"io/fs"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const sidUser = "S-1-5-21-1-2-3-1001" // someone signed in to the PC

var agentOwn = objectSecurity{Owner: sidAdmins, DACL: true, Protected: true, Grants: []string{sidSystem, sidAdmins}}

// fakeTree is a file system of objects by path; Secure gives an object the
// agent's own security unless the object is stubborn.
type fakeTree struct {
	objs    map[string]*fakeObj
	secured []string
	opened  []string
	// afterAside runs after each move aside: someone acting in between.
	afterAside func(t *fakeTree)
}

type fakeObj struct {
	info     objectInfo
	stubborn bool
}

func (t *fakeTree) add(path string, info objectInfo) *fakeObj {
	o := &fakeObj{info: info}
	t.objs[path] = o
	return o
}

func (t *fakeTree) MkdirSecure(path string) error {
	if _, ok := t.objs[path]; ok {
		return fs.ErrExist
	}
	t.add(path, objectInfo{Dir: true, Security: agentOwn})
	return nil
}

func (t *fakeTree) Open(path string) (treeObject, error) {
	o, ok := t.objs[path]
	if !ok {
		return nil, fs.ErrNotExist
	}
	t.opened = append(t.opened, path)
	return &fakeHandle{t, path, o}, nil
}

func (t *fakeTree) SetAside(path, to string) error {
	if _, ok := t.objs[to]; ok {
		return fs.ErrExist
	}
	for p, o := range t.objs {
		if p == path || strings.HasPrefix(p, path+"/") {
			delete(t.objs, p)
			t.objs[to+strings.TrimPrefix(p, path)] = o
		}
	}
	if t.afterAside != nil {
		t.afterAside(t)
	}
	return nil
}

func (t *fakeTree) List(dir string) ([]string, error) {
	var names []string
	for p := range t.objs {
		if filepath.Dir(p) == dir && p != dir {
			names = append(names, filepath.Base(p))
		}
	}
	slices.Sort(names)
	return names, nil
}

type fakeHandle struct {
	t    *fakeTree
	path string
	o    *fakeObj
}

func (h *fakeHandle) Info() (objectInfo, error) { return h.o.info, nil }
func (h *fakeHandle) Close() error              { return nil }
func (h *fakeHandle) Secure(bool) error {
	h.t.secured = append(h.t.secured, h.path)
	if !h.o.stubborn {
		h.o.info.Security = agentOwn
	}
	return nil
}

func newTree() *fakeTree { return &fakeTree{objs: map[string]*fakeObj{}} }

const (
	top   = "/ProgramData/Whombat"
	stamp = "20261128-120000"
)

func aside(n string) string { return top + ".set-aside-" + stamp + "-" + n }

// theirs is what someone signed in made: their own, open to them.
var theirs = objectSecurity{Owner: sidUser, DACL: true, Grants: []string{sidUser, sidSystem}}

func secure(tr *fakeTree) ([]Moved, error) { return secureTree(tr, top, stamp) }

func TestSecureTreeCreatesTheFolder(t *testing.T) {
	tr := newTree()
	moved, err := secure(tr)
	if err != nil {
		t.Fatal(err)
	}
	if o := tr.objs[top]; o == nil || !o.info.Security.trusted(true) {
		t.Fatalf("top not created as the agent's own: %+v", o)
	}
	if len(tr.secured) != 0 || len(moved) != 0 {
		t.Errorf("a fresh folder was secured again or moved: %v %v", tr.secured, moved)
	}
}

// Someone made the folder and filled it before the agent came: nothing in
// it is read or adopted. It moves aside whole and the agent makes its own.
func TestSecureTreeMovesSomeoneElsesFolderAside(t *testing.T) {
	tr := newTree()
	tr.add(top, objectInfo{Dir: true, Security: theirs})
	// What they left looks like the agent's: owned by the administrators,
	// SYSTEM and the administrators only (they could set that as owner of
	// the folder). Still theirs to have written.
	tr.add(top+"/agent", objectInfo{Dir: true, Security: agentOwn})
	tr.add(top+"/agent/agent.toml", objectInfo{Names: 1, Security: agentOwn})
	tr.add(top+"/state/update-pending.json", objectInfo{Names: 1, Security: agentOwn})
	tr.add(top+"/state/elsewhere", objectInfo{Dir: true, Link: true, Security: theirs})

	moved, err := secure(tr)
	if err != nil {
		t.Fatal(err)
	}
	if want := []Moved{{top, aside("1")}}; !slices.Equal(moved, want) {
		t.Errorf("moved %v, want %v", moved, want)
	}
	if o := tr.objs[top]; o == nil || !o.info.Security.trusted(true) {
		t.Fatalf("top not made again as the agent's own: %+v", o)
	}
	if names, _ := tr.List(top); len(names) != 0 {
		t.Errorf("the new folder holds %v", names)
	}
	if tr.objs[aside("1")+"/agent/agent.toml"] == nil || tr.objs[aside("1")+"/state/elsewhere"] == nil {
		t.Errorf("what was theirs didn't move with the folder: %v", tr.objs)
	}
	for _, p := range tr.opened {
		if p != top {
			t.Errorf("opened %s inside someone else's folder", p)
		}
	}
	if len(tr.secured) != 0 {
		t.Errorf("adopted %v", tr.secured)
	}
}

// In the agent's own folder, only what someone else owns or may change
// moves aside; what is only SYSTEM's and the administrators' stays, and a
// folder that merely inherits gets its own protected list.
func TestSecureTreeKeepsOnlyWhatIsOurs(t *testing.T) {
	inherited := objectSecurity{Owner: sidSystem, DACL: true, Grants: []string{sidSystem, sidAdmins}}
	tr := newTree()
	tr.add(top, objectInfo{Dir: true, Security: agentOwn})
	tr.add(top+"/agent", objectInfo{Dir: true, Security: agentOwn})
	tr.add(top+"/agent/agent.key", objectInfo{Names: 1, Security: inherited})
	tr.add(top+"/agent/agent.toml", objectInfo{Names: 1, Security: objectSecurity{Owner: sidUser, DACL: true, Grants: []string{sidSystem}}})
	tr.add(top+"/agent/rollback.json", objectInfo{Names: 1, Security: objectSecurity{Owner: sidAdmins}}) // no list: everyone
	tr.add(top+"/state", objectInfo{Dir: true, Security: agentOwn})
	tr.add(top+"/state/whombat-facts.ps1", objectInfo{Names: 1, Security: inherited})
	tr.add(top+"/state/scripts.ps1", objectInfo{Names: 1, Security: objectSecurity{Owner: sidAdmins, DACL: true, Grants: []string{sidAdmins, sidUser}}})
	tr.add(top+"/state/exec", objectInfo{Dir: true, Security: inherited}) // made by the agent, not protected
	tr.add(top+"/state/exec/run.ps1", objectInfo{Names: 1, Security: inherited})
	tr.add(top+"/logs", objectInfo{Dir: true, Security: objectSecurity{Owner: sidAdmins, DACL: true, Protected: true, Grants: []string{sidAdmins, ""}}})
	tr.add(top+"/logs/whombat-agent.log", objectInfo{Names: 1, Security: inherited})

	moved, err := secure(tr)
	if err != nil {
		t.Fatal(err)
	}
	var from []string
	for _, m := range moved {
		from = append(from, m.From)
	}
	if want := []string{top + "/agent/agent.toml", top + "/agent/rollback.json", top + "/logs", top + "/state/scripts.ps1"}; !slices.Equal(from, want) {
		t.Errorf("moved aside %v, want %v", from, want)
	}
	if !slices.Equal(tr.secured, []string{top + "/state/exec"}) {
		t.Errorf("secured %v, want only state/exec", tr.secured)
	}
	for _, keep := range []string{"/agent/agent.key", "/state/whombat-facts.ps1", "/state/exec/run.ps1"} {
		if tr.objs[top+keep] == nil {
			t.Errorf("%s didn't stay", keep)
		}
	}
	for p, o := range tr.objs {
		if inside(top, p) && !o.info.Security.trusted(o.info.Dir) {
			t.Errorf("%s is not the agent's own: %+v", p, o.info.Security)
		}
	}
	for _, p := range tr.opened {
		if strings.HasPrefix(p, top+"/logs/") {
			t.Errorf("opened %s in a folder that moved aside", p)
		}
	}
}

// A name beside the folder that someone took first is skipped.
func TestSecureTreeSetsAsideUnderAFreeName(t *testing.T) {
	tr := newTree()
	tr.add(top, objectInfo{Dir: true, Security: theirs})
	tr.add(aside("1"), objectInfo{Dir: true, Security: theirs})
	moved, err := secure(tr)
	if err != nil {
		t.Fatal(err)
	}
	if want := []Moved{{top, aside("2")}}; !slices.Equal(moved, want) {
		t.Errorf("moved %v, want %v", moved, want)
	}
}

// Someone makes the folder again each time it moves aside: the agent gives
// up instead of taking theirs.
func TestSecureTreeGivesUpOnAFolderThatKeepsComingBack(t *testing.T) {
	tr := newTree()
	tr.add(top, objectInfo{Dir: true, Security: theirs})
	tr.afterAside = func(t *fakeTree) { t.add(top, objectInfo{Dir: true, Security: theirs}) }
	moved, err := secure(tr)
	var unsafe *UnsafeError
	if !errors.As(err, &unsafe) || unsafe.Path != top {
		t.Fatalf("err = %v, want one about the folder", err)
	}
	if len(moved) != topAttempts || len(tr.secured) != 0 {
		t.Errorf("moved %v, secured %v", moved, tr.secured)
	}
}

func TestSecureTreeRefusesLinksAndSecondNames(t *testing.T) {
	for _, tc := range []struct {
		name, bad string
		info      objectInfo
	}{
		{"top is a junction", top, objectInfo{Dir: true, Link: true, Security: agentOwn}},
		{"top is a file", top, objectInfo{Names: 1, Security: agentOwn}},
		{"a folder inside is a junction", top + "/state", objectInfo{Dir: true, Link: true, Security: agentOwn}},
		{"a file inside is a symbolic link", top + "/agent/agent.key", objectInfo{Link: true, Security: agentOwn}},
		{"a file inside has a second name", top + "/agent/agent.key", objectInfo{Names: 2, Security: agentOwn}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tr := newTree()
			tr.add(top, objectInfo{Dir: true, Security: agentOwn})
			tr.add(top+"/agent", objectInfo{Dir: true, Security: agentOwn})
			tr.add(tc.bad, tc.info)
			tr.add(tc.bad+"/below", objectInfo{Names: 1, Security: objectSecurity{Owner: sidUser}})
			_, err := secure(tr)
			var unsafe *UnsafeError
			if !errors.As(err, &unsafe) || unsafe.Path != tc.bad {
				t.Fatalf("err = %v, want one about %s", err, tc.bad)
			}
			if slices.Contains(tr.secured, tc.bad) || slices.Contains(tr.secured, tc.bad+"/below") {
				t.Errorf("changed what it refused: %v", tr.secured)
			}
		})
	}
}

// Windows kept another list: the agent says so instead of carrying on.
func TestSecureTreeChecksTheResult(t *testing.T) {
	tr := newTree()
	tr.add(top, objectInfo{Dir: true, Security: agentOwn})
	tr.add(top+"/state", objectInfo{Dir: true, Security: objectSecurity{Owner: sidSystem, DACL: true, Grants: []string{sidSystem}}}).stubborn = true
	_, err := secure(tr)
	var unsafe *UnsafeError
	if !errors.As(err, &unsafe) || unsafe.Path != top+"/state" {
		t.Fatalf("err = %v, want one about state", err)
	}
}

// The settings and the state folder are read only from the folder the
// agent keeps safe: a configuration elsewhere, or one naming a state folder
// elsewhere, stops the agent before it reads anything there.
func TestPrepareDataDirKeepsSettingsAndStateInside(t *testing.T) {
	noConfig := func(string) (string, bool) { return "", false }
	names := func(state string) func(string) (string, bool) {
		return func(string) (string, bool) { return state, true }
	}
	for _, tc := range []struct {
		name, dir, stateDir string
		stateOf             func(string) (string, bool)
		outside             string // "" when it goes ahead
		secured             bool   // the folder was taken over
	}{
		{"the defaults", top + "/agent", "", names(top + "/state"), "", true},
		{"not enrolled yet", top + "/agent", "", noConfig, "", true},
		{"enroll's state folder", top + "/agent", top + "/state", noConfig, "", true},
		{"settings elsewhere", "/Users/Public/agent", "", names(top + "/state"), "/Users/Public/agent", false},
		{"settings beside the folder", top + ".old/agent", "", noConfig, top + ".old/agent", false},
		{"enroll's state folder elsewhere", top + "/agent", "/Users/Public/state", noConfig, "/Users/Public/state", false},
		{"agent.toml names a state folder elsewhere", top + "/agent", "", names("/Users/Public/state"), "/Users/Public/state", true},
		{"agent.toml climbs out", top + "/agent", "", names(top + "/../Temp"), top + "/../Temp", true},
		{"a relative state folder", top + "/agent", "", names("state"), "state", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tr := newTree()
			_, err := prepareDataDir(tr, top, stamp, tc.dir, tc.stateDir, tc.stateOf)
			var out *OutsideError
			switch {
			case tc.outside == "" && err != nil:
				t.Fatalf("err = %v", err)
			case tc.outside != "" && (!errors.As(err, &out) || out.Path != tc.outside):
				t.Fatalf("err = %v, want one about %s", err, tc.outside)
			}
			if got := tr.objs[top] != nil; got != tc.secured {
				t.Errorf("folder taken over = %v, want %v", got, tc.secured)
			}
		})
	}
}

// The state folder agent.toml names is read only once the folder is the
// agent's: someone's agent.toml is moved aside first, never read.
func TestPrepareDataDirReadsTheConfigAfterTheTakeover(t *testing.T) {
	tr := newTree()
	tr.add(top, objectInfo{Dir: true, Security: theirs})
	tr.add(top+"/agent/agent.toml", objectInfo{Names: 1, Security: theirs})
	var read []string
	stateOf := func(dir string) (string, bool) {
		read = append(read, dir)
		if tr.objs[dir+"/agent.toml"] == nil {
			return "", false
		}
		return "/Users/Public/state", true
	}
	if _, err := prepareDataDir(tr, top, stamp, top+"/agent", "", stateOf); err != nil {
		t.Fatalf("err = %v: someone else's agent.toml was read", err)
	}
	if !slices.Equal(read, []string{top + "/agent"}) {
		t.Errorf("read %v", read)
	}
}

func TestTrustedSecurity(t *testing.T) {
	for _, tc := range []struct {
		name string
		s    objectSecurity
		dir  bool
		want bool
	}{
		{"the agent's folder", agentOwn, true, true},
		{"owned by SYSTEM", objectSecurity{Owner: sidSystem, DACL: true, Protected: true, Grants: []string{sidSystem}}, true, true},
		{"a file inheriting the agent's list", objectSecurity{Owner: sidSystem, DACL: true, Grants: []string{sidSystem, sidAdmins}}, false, true},
		{"a folder inheriting", objectSecurity{Owner: sidSystem, DACL: true, Grants: []string{sidSystem, sidAdmins}}, true, false},
		{"owned by a user", objectSecurity{Owner: sidUser, DACL: true, Protected: true, Grants: []string{sidSystem}}, true, false},
		{"no owner read", objectSecurity{DACL: true, Protected: true}, true, false},
		{"a user let in", objectSecurity{Owner: sidAdmins, DACL: true, Protected: true, Grants: []string{sidSystem, sidUser}}, true, false},
		{"an entry it can't read", objectSecurity{Owner: sidAdmins, DACL: true, Protected: true, Grants: []string{""}}, false, false},
		{"no list at all", objectSecurity{Owner: sidAdmins, Protected: true}, false, false},
	} {
		if got := tc.s.trusted(tc.dir); got != tc.want {
			t.Errorf("%s: trusted = %v, want %v", tc.name, got, tc.want)
		}
	}
}
