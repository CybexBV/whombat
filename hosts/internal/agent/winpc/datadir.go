package winpc

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

// The agent keeps its key, its settings and the scripts it runs as SYSTEM
// under %ProgramData%\Whombat. Every user may create folders in
// %ProgramData%, so someone could make that folder, or one inside it,
// before the agent is installed, fill it, and keep it as their own, or
// leave a link there to a place of theirs. Making such a thing the agent's
// own would keep what they wrote in it: a configuration that points the
// agent elsewhere, a rollback note naming their program. PrepareDataDir
// (datadir_windows.go) therefore trusts only what nobody but SYSTEM and the
// administrators could have written: whatever someone else owns or may
// change is moved out of the folder, whole and unread, beside it in
// %ProgramData%, and the agent makes its own again. What stays is made the
// agent's: the administrators own it, only SYSTEM and the administrators
// are on its access list, and a folder inherits nothing from above. It
// refuses links of any kind and files with a second name, checks each
// result after setting it, and the agent doesn't start on a tree it
// couldn't make its own, nor with settings or a state folder outside it.
// The decisions are here, apart from Windows' calls, so they are tested
// everywhere.

// The two accounts the agent's tree may name, as SID strings.
const (
	sidSystem = "S-1-5-18"     // LocalSystem, the agent's service
	sidAdmins = "S-1-5-32-544" // the Administrators group
)

// objectSecurity is what the agent reads of a file's or folder's security.
type objectSecurity struct {
	Owner     string   // the owner's SID
	DACL      bool     // false: no access list, which lets everyone in
	Protected bool     // nothing inherited from the folder above
	Grants    []string // the SIDs that allowing entries name; "" for one the agent can't read
}

// onlyOurs: only SYSTEM or the administrators own it and are let in, so
// nobody else can have written it, or anything in it. An owner may always
// change the access list, so someone else's object is never ours.
func (s objectSecurity) onlyOurs() bool {
	if !trustedSID(s.Owner) || !s.DACL {
		return false
	}
	for _, g := range s.Grants {
		if !trustedSID(g) {
			return false
		}
	}
	return true
}

// trusted: only ours, and a folder inherits nothing from above.
func (s objectSecurity) trusted(dir bool) bool {
	return s.onlyOurs() && (!dir || s.Protected)
}

func trustedSID(sid string) bool { return sid == sidSystem || sid == sidAdmins }

// objectInfo is what the agent reads of a file or folder itself, never of
// what a link points to.
type objectInfo struct {
	Dir      bool
	Link     bool   // a reparse point: a symbolic link, a junction, a mount point
	Names    uint32 // how many names (hard links) a file has
	Security objectSecurity
}

// treeObject is one file or folder, held open while the agent checks it.
type treeObject interface {
	Info() (objectInfo, error)
	// Secure makes the administrators its owner and gives it the agent's
	// protected access list.
	Secure(dir bool) error
	Close() error
}

// treeFS is what securing the tree needs of the file system.
type treeFS interface {
	// MkdirSecure creates a folder owned by the administrators with the
	// agent's access list from the start; an error that is fs.ErrExist
	// when something is there.
	MkdirSecure(path string) error
	Open(path string) (treeObject, error)
	List(dir string) ([]string, error)
	// SetAside renames the file or folder at path itself (a link, never
	// what it points to), with everything in it, to to; an error that is
	// fs.ErrExist when to is taken.
	SetAside(path, to string) error
}

// Moved is something the agent found in its folder that someone else
// could have written: it is at To now, and the agent doesn't use it.
type Moved struct{ From, To string }

// UnsafeError: something in the agent's tree can't be made the agent's own.
type UnsafeError struct {
	Path   string
	Reason string
}

func (e *UnsafeError) Error() string {
	return "the agent's folder isn't safe to use: " + e.Path + " " + e.Reason
}

// OutsideError: the agent was to keep its settings or state outside the
// one folder it keeps safe.
type OutsideError struct {
	What string // "settings" or "state"
	Path string
	Top  string
}

func (e *OutsideError) Error() string {
	return fmt.Sprintf("the agent keeps its %s only in %s, the folder it keeps safe, and %s is elsewhere", e.What, e.Top, e.Path)
}

// inside: path is top or in it.
func inside(top, path string) bool {
	rel, err := filepath.Rel(top, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// prepareDataDir is what the agent does on Windows before it reads or
// writes its folders. Its settings folder dir and its state folder must be
// in top, the one tree it keeps safe; then it takes top over. stateDir ""
// means the state folder dir's agent.toml names (stateOf, read once the
// tree is the agent's), which must be in top as well. stamp goes into the
// names of what is moved aside.
func prepareDataDir(f treeFS, top, stamp, dir, stateDir string, stateOf func(dir string) (string, bool)) ([]Moved, error) {
	if !inside(top, dir) {
		return nil, &OutsideError{"settings", dir, top}
	}
	if stateDir != "" && !inside(top, stateDir) {
		return nil, &OutsideError{"state", stateDir, top}
	}
	moved, err := secureTree(f, top, stamp)
	if err != nil || stateDir != "" {
		return moved, err
	}
	if s, ok := stateOf(dir); ok && !inside(top, s) {
		return moved, &OutsideError{"state", s, top}
	}
	return moved, nil
}

// topAttempts: how often the agent makes its folder again when someone
// else's keeps taking its place.
const topAttempts = 3

// asideAttempts: how many names the agent tries for one thing it moves
// aside before it gives up.
const asideAttempts = 10

// takeover is one run of securing the tree.
type takeover struct {
	f     treeFS
	top   string
	stamp string
	n     int
	moved []Moved
}

// secureTree creates top or takes it over, and then everything in it.
func secureTree(f treeFS, top, stamp string) ([]Moved, error) {
	t := &takeover{f: f, top: top, stamp: stamp}
	for range topAttempts {
		if err := f.MkdirSecure(top); err != nil && !errors.Is(err, fs.ErrExist) {
			return t.moved, fmt.Errorf("creating %s: %w", top, err)
		}
		kept, err := t.secure(top, true)
		if err != nil || kept {
			return t.moved, err
		}
	}
	return t.moved, &UnsafeError{top, "keeps coming back as someone else's after the agent moved it aside. Restart the PC, then run the install line again."}
}

// secure takes over path (top when isTop), checks the result, and then
// does the same for what a folder holds. false: path was moved aside.
func (t *takeover) secure(path string, isTop bool) (bool, error) {
	dir, kept, err := t.secureOne(path, isTop)
	if err != nil || !kept || !dir {
		return kept, err
	}
	names, err := t.f.List(path)
	if err != nil {
		return true, fmt.Errorf("reading %s: %w", path, err)
	}
	for _, n := range names {
		if _, err := t.secure(filepath.Join(path, n), false); err != nil {
			return true, err
		}
	}
	return true, nil
}

// secureOne takes over one file or folder, or moves it aside when someone
// else could have written it; it says whether it is a folder and whether
// it stayed.
func (t *takeover) secureOne(path string, isTop bool) (dir, kept bool, err error) {
	o, err := t.f.Open(path)
	if err != nil {
		return false, false, fmt.Errorf("checking %s: %w", path, err)
	}
	info, err := o.Info()
	if err != nil {
		o.Close()
		return false, false, fmt.Errorf("checking %s: %w", path, err)
	}
	if !info.Security.onlyOurs() {
		// Not read, not walked into: everything in it may be theirs.
		o.Close()
		return info.Dir, false, t.setAside(path)
	}
	defer o.Close()
	switch {
	case info.Link:
		return false, false, &UnsafeError{path, "is a link to another place. Remove it, then run the install line again."}
	case isTop && !info.Dir:
		return false, false, &UnsafeError{path, "is a file, not a folder. Remove it, then run the install line again."}
	case !info.Dir && info.Names > 1:
		return false, false, &UnsafeError{path, "has a second name elsewhere (a hard link). Remove it, then run the install line again."}
	}
	if info.Security.trusted(info.Dir) {
		return info.Dir, true, nil
	}
	// Only SYSTEM and the administrators are let in already; the folder
	// just inherits its list. Someone's handle opened earlier keeps the
	// rights it was opened with until it is closed, at the latest when its
	// program ends or the PC restarts; with a list like this one nobody
	// else was let in to open one, and what others could open was moved
	// aside above, so their handles point outside the agent's folder.
	if err := o.Secure(info.Dir); err != nil {
		return false, false, fmt.Errorf("securing %s: %w", path, err)
	}
	if info, err = o.Info(); err != nil {
		return false, false, fmt.Errorf("checking %s: %w", path, err)
	}
	if !info.Security.trusted(info.Dir) {
		return false, false, &UnsafeError{path, "kept another owner or access list after the agent set its own."}
	}
	return info.Dir, true, nil
}

// setAside moves path out of the agent's tree to a name of its own beside
// top (in %ProgramData%, a folder only the administrators can take things
// out of), so nothing of it is read and the agent makes its own afresh.
func (t *takeover) setAside(path string) error {
	var err error
	for range asideAttempts {
		t.n++
		to := fmt.Sprintf("%s.set-aside-%s-%d", t.top, t.stamp, t.n)
		if err = t.f.SetAside(path, to); err == nil {
			t.moved = append(t.moved, Moved{From: path, To: to})
			return nil
		}
		if !errors.Is(err, fs.ErrExist) {
			break
		}
	}
	return &UnsafeError{path, fmt.Sprintf("could be changed by someone else, and the agent couldn't move it aside (%v). Restart the PC, then run the install line again.", err)}
}
