package winpc

import (
	"errors"
	"io/fs"
	"path/filepath"
	"slices"
	"testing"
)

const sidUser = "S-1-5-21-1-2-3-1001" // someone signed in to the PC

var agentOwn = objectSecurity{Owner: sidAdmins, DACL: true, Protected: true, Grants: []string{sidSystem, sidAdmins}}

// fakeTree is a file system of objects by path; Secure gives an object the
// agent's own security unless the object is stubborn.
type fakeTree struct {
	objs    map[string]*fakeObj
	secured []string
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
	return &fakeHandle{t, path, o}, nil
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

const top = "/ProgramData/Whombat"

func TestSecureTreeCreatesTheFolder(t *testing.T) {
	tr := newTree()
	if err := secureTree(tr, top); err != nil {
		t.Fatal(err)
	}
	if o := tr.objs[top]; o == nil || !o.info.Security.trusted(true) {
		t.Fatalf("top not created as the agent's own: %+v", o)
	}
	if len(tr.secured) != 0 {
		t.Errorf("a fresh folder was secured again: %v", tr.secured)
	}
}

// Someone made the folder and put things in it before the agent came: the
// agent takes over every one of them and leaves its own alone.
func TestSecureTreeTakesOverSomeoneElsesTree(t *testing.T) {
	theirs := objectSecurity{Owner: sidUser, DACL: true, Grants: []string{sidUser, sidSystem}}
	inherited := objectSecurity{Owner: sidSystem, DACL: true, Grants: []string{sidSystem, sidAdmins}}
	tr := newTree()
	tr.add(top, objectInfo{Dir: true, Security: theirs})
	tr.add(top+"/agent", objectInfo{Dir: true, Security: objectSecurity{Owner: sidUser, DACL: true, Protected: true, Grants: []string{sidUser}}})
	tr.add(top+"/agent/agent.toml", objectInfo{Names: 1, Security: objectSecurity{Owner: sidUser}}) // no list: everyone
	tr.add(top+"/state", objectInfo{Dir: true, Security: agentOwn})
	tr.add(top+"/state/whombat-facts.ps1", objectInfo{Names: 1, Security: inherited})
	tr.add(top+"/state/exec", objectInfo{Dir: true, Security: inherited}) // made by the agent, not protected
	tr.add(top+"/logs", objectInfo{Dir: true, Security: objectSecurity{Owner: sidAdmins, DACL: true, Protected: true, Grants: []string{sidAdmins, ""}}})

	if err := secureTree(tr, top); err != nil {
		t.Fatal(err)
	}
	want := []string{top, top + "/agent", top + "/agent/agent.toml", top + "/logs", top + "/state/exec"}
	if !slices.Equal(tr.secured, want) {
		t.Errorf("secured %v, want %v", tr.secured, want)
	}
	for p, o := range tr.objs {
		if !o.info.Security.trusted(o.info.Dir) {
			t.Errorf("%s is not the agent's own: %+v", p, o.info.Security)
		}
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
			err := secureTree(tr, top)
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

// Windows kept someone else's owner or list: the agent says so instead of
// carrying on.
func TestSecureTreeChecksTheResult(t *testing.T) {
	tr := newTree()
	tr.add(top, objectInfo{Dir: true, Security: agentOwn})
	tr.add(top+"/state", objectInfo{Dir: true, Security: objectSecurity{Owner: sidUser, DACL: true, Grants: []string{sidUser}}}).stubborn = true
	err := secureTree(tr, top)
	var unsafe *UnsafeError
	if !errors.As(err, &unsafe) || unsafe.Path != top+"/state" {
		t.Fatalf("err = %v, want one about state", err)
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
