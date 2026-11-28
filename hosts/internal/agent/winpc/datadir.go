package winpc

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
)

// The agent keeps its key, its settings and the scripts it runs as SYSTEM
// under %ProgramData%\Whombat. Every user may create folders in
// %ProgramData%, so someone could make that folder, or one inside it,
// before the agent is installed and keep it as their own, or leave a link
// there to a place of theirs. SecureDataDir (datadir_windows.go) therefore
// takes over everything in the tree: the administrators own it, only
// SYSTEM and the administrators are on its access list, and a folder
// inherits nothing from above. It refuses links of any kind and files with
// a second name, checks each result after setting it, and the agent
// doesn't start on a tree it couldn't make its own. The decisions are here,
// apart from Windows' calls, so they are tested everywhere.

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

// trusted: only SYSTEM or the administrators own it and are let in, and a
// folder inherits nothing from above.
func (s objectSecurity) trusted(dir bool) bool {
	if !trustedSID(s.Owner) || !s.DACL || (dir && !s.Protected) {
		return false
	}
	for _, g := range s.Grants {
		if !trustedSID(g) {
			return false
		}
	}
	return true
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
	// MkdirSecure creates a folder with the agent's access list from the
	// start; an error that is fs.ErrExist when something is there.
	MkdirSecure(path string) error
	Open(path string) (treeObject, error)
	List(dir string) ([]string, error)
}

// UnsafeError: something in the agent's tree can't be made the agent's own.
type UnsafeError struct {
	Path   string
	Reason string
}

func (e *UnsafeError) Error() string {
	return "the agent's folder isn't safe to use: " + e.Path + " " + e.Reason
}

// secureTree creates top or takes it over, and then everything in it.
func secureTree(f treeFS, top string) error {
	if err := f.MkdirSecure(top); err != nil && !errors.Is(err, fs.ErrExist) {
		return fmt.Errorf("creating %s: %w", top, err)
	}
	return secureObject(f, top, true)
}

// secureObject takes over path (top when mustBeDir), checks the result,
// and then does the same for what a folder holds.
func secureObject(f treeFS, path string, mustBeDir bool) error {
	dir, err := secureOne(f, path, mustBeDir)
	if err != nil || !dir {
		return err
	}
	names, err := f.List(path)
	if err != nil {
		return fmt.Errorf("reading %s: %w", path, err)
	}
	for _, n := range names {
		if err := secureObject(f, filepath.Join(path, n), false); err != nil {
			return err
		}
	}
	return nil
}

// secureOne takes over one file or folder; it says whether it is a folder.
func secureOne(f treeFS, path string, mustBeDir bool) (bool, error) {
	o, err := f.Open(path)
	if err != nil {
		return false, fmt.Errorf("checking %s: %w", path, err)
	}
	defer o.Close()
	info, err := o.Info()
	if err != nil {
		return false, fmt.Errorf("checking %s: %w", path, err)
	}
	switch {
	case info.Link:
		return false, &UnsafeError{path, "is a link to another place. Remove it, then run the install line again."}
	case mustBeDir && !info.Dir:
		return false, &UnsafeError{path, "is a file, not a folder. Remove it, then run the install line again."}
	case !info.Dir && info.Names > 1:
		return false, &UnsafeError{path, "has a second name elsewhere (a hard link). Remove it, then run the install line again."}
	}
	if info.Security.trusted(info.Dir) {
		return info.Dir, nil
	}
	if err := o.Secure(info.Dir); err != nil {
		return false, fmt.Errorf("securing %s: %w", path, err)
	}
	if info, err = o.Info(); err != nil {
		return false, fmt.Errorf("checking %s: %w", path, err)
	}
	if !info.Security.trusted(info.Dir) {
		return false, &UnsafeError{path, "kept another owner or access list after the agent set its own."}
	}
	return info.Dir, nil
}
