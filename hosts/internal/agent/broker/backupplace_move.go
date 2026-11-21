package broker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"rackoon/internal/proto"
)

// Where on the server a Whombat's backups live, and moving them (Whombat's
// backup-places BPL-13, BPL-14; docs/MANAGE.md 2.10).
//
// A location is the dedicated root (Unraid's share whombat-backups, or
// /srv/whombat-backups elsewhere) or, on Unraid, a folder "whombat" in any
// other user share but system. Ensure with another location than the
// client's moves its backups: the app (and its cleanup) stop, the data
// folder is copied to a hidden folder in the new root and compared file by
// file (names, kinds and sizes), the client's files in .whombat follow,
// the copy takes the data folder's name, both containers are made again on
// the new root with the same port and files, and only when the backup app
// answers there are the old folder and files deleted. A failure on the way
// drops the copy and puts the containers back on the old root, so the
// box's repository URL, user and repository never change. On Unraid
// /mnt/user is one file system across shares, so a move is always a copy.

// sharesDir is Unraid's /mnt/user (or the tests').
func (m *placeManager) sharesDir() string {
	if m.userShares != "" {
		return m.userShares
	}
	return unraidUserShares
}

// locationRoot is the root of a location; another Unraid share must be
// there already (Whombat never makes a share but its own).
func (m *placeManager) locationRoot(id string) (string, error) {
	notHere := invalidField("location", "That isn’t a place on this server.")
	if !proto.ValidPlaceLocation(id) {
		return "", notHere
	}
	if r, ok := m.testLocations[id]; ok {
		return r, nil
	}
	if !m.isUnraid() {
		if id == proto.PlaceLocationLinux {
			return m.rootDir(), nil
		}
		return "", notHere
	}
	switch id {
	case proto.PlaceShareName:
		return m.rootDir(), nil
	case proto.PlaceUnraidSystemShare:
		return "", notHere
	}
	dir := filepath.Join(m.sharesDir(), id)
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return "", notHere
	}
	return filepath.Join(dir, proto.PlaceShareFolder), nil
}

// locationOf is the id of the location a root is ("" = none Whombat
// knows).
func (m *placeManager) locationOf(root string) string {
	root = filepath.Clean(root)
	for _, id := range sortedKeys(m.testLocations) {
		if filepath.Clean(m.testLocations[id]) == root {
			return id
		}
	}
	if root == filepath.Clean(m.rootDir()) {
		if m.isUnraid() {
			return proto.PlaceShareName
		}
		return proto.PlaceLocationLinux
	}
	if m.isUnraid() && filepath.Base(root) == proto.PlaceShareFolder {
		share := filepath.Dir(root)
		if name := filepath.Base(share); filepath.Dir(share) == filepath.Clean(m.sharesDir()) && name != proto.PlaceShareName &&
			name != proto.PlaceUnraidSystemShare && proto.ValidPlaceLocation(name) {
			return name
		}
	}
	return ""
}

// locationRoots are the roots of every location there is now.
func (m *placeManager) locationRoots() []string {
	roots := []string{m.rootDir()}
	for _, id := range sortedKeys(m.testLocations) {
		roots = append(roots, m.testLocations[id])
	}
	if m.isUnraid() {
		ents, _ := os.ReadDir(m.sharesDir())
		for _, e := range ents {
			if e.IsDir() && e.Name() != proto.PlaceShareName && e.Name() != proto.PlaceUnraidSystemShare && proto.ValidPlaceLocation(e.Name()) {
				roots = append(roots, filepath.Join(m.sharesDir(), e.Name(), proto.PlaceShareFolder))
			}
		}
	}
	return roots
}

// clientRoots are the roots a client has anything in: its containers'
// and every location with its data folder or user file (the dedicated
// root when there is none).
func (m *placeManager) clientRoots(ctx context.Context, client string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	add := func(r string) {
		if r = filepath.Clean(r); !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	for _, name := range []string{m.serverName(client), m.cleanupName(client)} {
		c, err := m.docker.inspectContainer(ctx, name)
		if err != nil {
			return nil, err
		}
		if c != nil {
			if r := clientRoot(c.HostConfig.Binds, client); r != "" {
				add(r)
			}
		}
	}
	for _, r := range m.locationRoots() {
		if exists(dataIn(r, client)) || exists(stateFileIn(r, client, "htpasswd")) || exists(kitDirIn(r, client)) {
			add(r)
		}
	}
	if len(out) == 0 {
		add(m.rootDir())
	}
	return out, nil
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// emptyOrMissing reports whether a folder has nothing in it.
func emptyOrMissing(dir string) bool {
	ents, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	return err == nil && len(ents) == 0
}

// within reports whether p is dir or below it.
func within(p, dir string) bool {
	p, dir = filepath.Clean(p), filepath.Clean(dir)
	return p == dir || strings.HasPrefix(p, dir+string(filepath.Separator))
}

// clientStateFiles are the client's files in a root's .whombat
// (<client>.htpasswd, .pass, .cleanup.json …, and the kit folder
// <client>.kit), temporary files left out.
func clientStateFiles(root, client string) []string {
	ents, _ := os.ReadDir(stateDirIn(root))
	var out []string
	for _, e := range ents {
		n := e.Name()
		kit := n == client+".kit" && e.IsDir()
		if !strings.HasPrefix(n, client+".") || !(e.Type().IsRegular() || kit) || strings.HasSuffix(n, ".tmp") ||
			strings.HasSuffix(n, ".whombat-tmp") {
			continue
		}
		out = append(out, filepath.Join(stateDirIn(root), n))
	}
	sort.Strings(out)
	return out
}

// moveRestoreWait bounds putting the backup app back after a failed move.
const moveRestoreWait = 5 * time.Minute

// move moves a client's backups from one root to another and runs its
// containers there (see the top of this file).
func (m *placeManager) move(ctx context.Context, req *proto.PlaceRequest, cur *placeContainer, from, to string) (proto.PlaceResult, error) {
	client := req.Client
	src, dst := dataIn(from, client), dataIn(to, client)
	if within(src, to) || within(dst, from) || filepath.Clean(from) == filepath.Clean(to) {
		return proto.PlaceResult{}, invalidField("location", "The backups can’t move into their own folder.")
	}
	if st, err := os.Stat(src); err != nil || !st.IsDir() {
		return proto.PlaceResult{}, codeErr(CodePlatformError, "This Whombat’s backup folder is missing on this server, so there is nothing to move.")
	}
	if err := m.prepareRoot(ctx, to); err != nil {
		return proto.PlaceResult{}, err
	}
	if !emptyOrMissing(dst) {
		// A copy an interrupted move finished may be reused; anything else
		// are other backups, never mixed with these.
		if sameTree(ctx, src, dst) != nil {
			return proto.PlaceResult{}, codeErr(proto.CodeExists,
				"That place already has other backups of this Whombat, from before. Whombat doesn’t mix them: choose another place.")
		}
	}
	// The images first, so the backup app is stopped only for the copy.
	if err := m.ensureImage(ctx, m.restImage); err != nil {
		return proto.PlaceResult{}, err
	}
	cl, err := m.docker.inspectContainer(ctx, m.cleanupName(client))
	if err != nil {
		return proto.PlaceResult{}, err
	}
	keep := placeKeep{All: proto.PlaceKeepDaysDefault}
	if cl != nil {
		keep = keepFromLabels(cl.Config.Labels)
		if err := m.ensureImage(ctx, m.cleanupImage); err != nil {
			return proto.PlaceResult{}, err
		}
	}
	oldPort := cur.publishedPort(placeRestPort)
	if oldPort == 0 {
		oldPort, _ = strconv.Atoi(cur.Config.Labels[placeLabelPort])
	}
	port := req.Port
	if port == 0 {
		port = oldPort
	}
	oldHtpasswd, _ := os.ReadFile(stateFileIn(from, client, "htpasswd"))
	if need, err := dirSize(ctx, src); err == nil {
		if free, _, ok := spaceOf(to); ok && free < need+need/20 {
			return proto.PlaceResult{}, codeErr(CodePlatformError, fmt.Sprintf("There isn’t room for the backups there: %s needed, %s free.",
				humanBytes(need), humanBytes(free)))
		}
	}

	// Nothing writes to the backups while they are copied.
	var stopped []string
	for _, name := range []string{m.cleanupName(client), m.serverName(client)} {
		if name == m.cleanupName(client) && cl == nil {
			continue
		}
		if err := m.docker.stopContainer(ctx, name); err != nil {
			m.startAgain(ctx, stopped)
			return proto.PlaceResult{}, err
		}
		stopped = append(stopped, name)
	}
	copied, err := m.copyClient(ctx, client, from, to)
	if err != nil {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), moveRestoreWait)
		defer cancel()
		m.dropCopy(rctx, copied)
		m.startAgain(rctx, stopped)
		return proto.PlaceResult{}, err
	}
	if err := m.runOn(ctx, to, client, req.RestPassword, port, cl != nil, keep); err != nil {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), moveRestoreWait)
		defer cancel()
		if rerr := m.runOld(rctx, from, client, oldPort, string(oldHtpasswd), cl != nil, keep); rerr != nil {
			// The copy stays: the old folder is there too, and the person
			// needs one of them working.
			return proto.PlaceResult{}, codeErr(CodePlatformError, firstLine(err.Error(), 200)+
				" Putting the backup app back where it was failed too: "+firstLine(rerr.Error(), 200))
		}
		m.dropCopy(rctx, copied)
		return proto.PlaceResult{}, err
	}
	// The backups answer from their new place: only now the old copy goes.
	m.dropOld(ctx, client, from)
	return proto.PlaceResult{Client: client, Port: port, Addresses: m.addresses(), Path: dst, Location: m.locationOf(to), Moved: true,
		Kit: true}, nil
}

// startAgain starts containers a failed move stopped.
func (m *placeManager) startAgain(ctx context.Context, names []string) {
	for _, n := range names {
		_ = m.docker.startContainer(ctx, n)
	}
}

// copyClient copies the client's data folder and files from one root to
// another and checks the copy; it returns what it made (for dropCopy).
func (m *placeManager) copyClient(ctx context.Context, client, from, to string) ([]string, error) {
	fsys := m.filesystem()
	src, dst := dataIn(from, client), dataIn(to, client)
	tmp := filepath.Join(to, "."+client+".moving")
	var made []string
	// A copy an interrupted move left behind.
	if err := fsys.removeAll(ctx, tmp); err != nil {
		return made, placeFSError("clear an earlier copy", err)
	}
	made = append(made, tmp)
	if err := fsys.copyTree(ctx, src, tmp); err != nil {
		return made, placeFSError("copy the backups", err)
	}
	if err := sameTree(ctx, src, tmp); err != nil {
		return made, err
	}
	for _, f := range clientStateFiles(from, client) {
		d := filepath.Join(stateDirIn(to), filepath.Base(f))
		made = append(made, d)
		if err := fsys.removeAll(ctx, d); err != nil {
			return made, placeFSError("copy the backup app’s files", err)
		}
		if err := fsys.copyTree(ctx, f, d); err != nil {
			return made, placeFSError("copy the backup app’s files", err)
		}
		if err := sameTree(ctx, f, d); err != nil {
			return made, err
		}
	}
	// An empty folder there, or a complete copy of an interrupted move
	// (move checked it is the same), makes way for this copy.
	if exists(dst) {
		if err := fsys.removeAll(ctx, dst); err != nil {
			return made, placeFSError("make way for the copy", err)
		}
	}
	made = append(made, dst)
	if err := fsys.rename(ctx, tmp, dst); err != nil {
		return made, placeFSError("put the copy in place", err)
	}
	return made, nil
}

// dropCopy removes what a failed move made in the new root; never
// anything of the old one.
func (m *placeManager) dropCopy(ctx context.Context, made []string) {
	for i := len(made) - 1; i >= 0; i-- {
		_ = m.filesystem().removeAll(ctx, made[i])
	}
}

// dropOld removes the client's old folder and files once the move is
// done. What can't be removed stays; nothing reads it any more.
func (m *placeManager) dropOld(ctx context.Context, client, from string) {
	fsys := m.filesystem()
	if dir := dataIn(from, client); filepath.Dir(dir) == filepath.Clean(from) {
		_ = fsys.removeAll(ctx, dir)
	}
	for _, f := range clientStateFiles(from, client) {
		_ = fsys.removeAll(ctx, f)
	}
	m.sizeMu.Lock()
	delete(m.sizes, dataIn(from, client))
	m.sizeMu.Unlock()
}

// runOn makes the client's containers again on a root: the cleanup (when
// it had one) first, then the backup app, which must answer.
func (m *placeManager) runOn(ctx context.Context, root, client, password string, port int, cleanup bool, keep placeKeep) error {
	for _, name := range []string{m.cleanupName(client), m.serverName(client)} {
		if err := m.docker.removeContainer(ctx, name); err != nil {
			return err
		}
	}
	if cleanup {
		if err := m.installCleanup(ctx, root, client, keep); err != nil {
			return err
		}
	}
	_, err := m.install(ctx, client, root, password, port, nil)
	return err
}

// runOld puts the client's containers back on their old root after a
// failed move, as they were (the files there were never touched).
func (m *placeManager) runOld(ctx context.Context, root, client string, port int, htpasswd string, cleanup bool, keep placeKeep) error {
	for _, name := range []string{m.cleanupName(client), m.serverName(client)} {
		if err := m.docker.removeContainer(ctx, name); err != nil {
			return err
		}
	}
	if cleanup {
		name, spec := m.cleanupName(client), m.cleanupSpec(root, client, keep)
		if err := m.apply(ctx, name, nil, spec); err != nil {
			return err
		}
		if m.isUnraid() {
			if err := m.unraidTemplate(ctx, name, spec, 0); err != nil {
				return err
			}
		}
	}
	// A server from before the kit user had no kit folder to bind.
	_ = m.filesystem().mkdirAll(ctx, kitDirIn(root, client), 0o700)
	name, spec := m.serverName(client), m.serverSpec(root, client, port, htpasswd)
	if err := m.apply(ctx, name, nil, spec); err != nil {
		return err
	}
	if m.isUnraid() {
		return m.unraidTemplate(ctx, name, spec, port)
	}
	return nil
}

// treeEntry is what a move compares of a file: its kind and size.
type treeEntry struct {
	kind fs.FileMode
	size int64
}

// sameTree checks that a copy has the same names, kinds and sizes as the
// original (a file or a folder).
func sameTree(ctx context.Context, a, b string) error {
	ta, na, err := readTree(ctx, a)
	if err != nil {
		return placeFSError("read the backups", err)
	}
	tb, nb, err := readTree(ctx, b)
	if err != nil {
		return placeFSError("read the copy of the backups", err)
	}
	differ := len(ta) != len(tb) || na != nb
	for rel, e := range ta {
		if differ {
			break
		}
		if tb[rel] != e {
			differ = true
		}
	}
	if differ {
		return codeErr(CodePlatformError, fmt.Sprintf("The copy of the backups doesn’t match them (%d files and folders, %s, against %d, %s): they stay where they were.",
			len(ta), humanBytes(uint64(na)), len(tb), humanBytes(uint64(nb))))
	}
	return nil
}

// readTree lists a file or folder: relative name → kind and size, and the
// total size.
func readTree(ctx context.Context, root string) (map[string]treeEntry, int64, error) {
	out := map[string]treeEntry{}
	var total int64
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		e := treeEntry{kind: info.Mode().Type()}
		if info.Mode().IsRegular() {
			e.size = info.Size()
			total += e.size
		}
		out[rel] = e
		return nil
	})
	return out, total, err
}

// humanBytes is a size for a sentence ("12.3 GB").
func humanBytes(n uint64) string {
	const unit = 1000
	if n < unit {
		return strconv.FormatUint(n, 10) + " bytes"
	}
	div, exp := uint64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "kMGTPE"[exp])
}

// copyTreeDirect copies a file or a folder with everything in it (files,
// folders and links, their modes, times and, when allowed, owners); the
// target must not exist. Every file is synced before the copy counts.
func copyTreeDirect(ctx context.Context, src, dst string) error {
	type dirMode struct {
		path string
		info fs.FileInfo
	}
	var dirs []dirMode
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		switch {
		case info.IsDir():
			if err := os.Mkdir(target, 0o700); err != nil {
				return err
			}
			dirs = append(dirs, dirMode{target, info})
		case info.Mode()&fs.ModeSymlink != 0:
			link, err := os.Readlink(p)
			if err != nil {
				return err
			}
			if err := os.Symlink(link, target); err != nil {
				return err
			}
		case info.Mode().IsRegular():
			if err := copyFileDirect(p, target, info); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%s isn’t a file or a folder", rel)
		}
		keepOwner(target, info)
		return nil
	})
	if err != nil {
		return err
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		if err := os.Chmod(dirs[i].path, dirs[i].info.Mode().Perm()); err != nil {
			return err
		}
		_ = os.Chtimes(dirs[i].path, dirs[i].info.ModTime(), dirs[i].info.ModTime())
	}
	return nil
}

func copyFileDirect(src, dst string, info fs.FileInfo) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if err := os.Chmod(dst, info.Mode().Perm()); err != nil {
		return err
	}
	return os.Chtimes(dst, info.ModTime(), info.ModTime())
}

// keepOwner gives a copy the original's owner when the agent may (as
// root); otherwise the copy is the agent's.
func keepOwner(target string, info fs.FileInfo) {
	if st, ok := info.Sys().(*syscall.Stat_t); ok && os.Geteuid() == 0 {
		_ = os.Lchown(target, int(st.Uid), int(st.Gid))
	}
}
