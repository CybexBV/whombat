// Package envmove moves a box to another environment of its image (ONE-06): `whombat-manager environment set prod` on
// a box of the development stack (Home) makes it a production box and keeps everything that is the box's own.
//
// What changes:
//
//  1. The control-bound state, when the new environment's control is another one: the Link state (<manager>/link) and
//     the own address's state (<manager>/own-address: the label, its certificate and keys) go aside, into the move's
//     folder. The manager starts with neither: Link off (or on again from the owner's reach choice), a new label and
//     certificate under the new zone once Link is on.
//  2. The kept registration (<identity>/registration.json), when its env isn't the new one: the same members with the
//     new env, signed again with the management key and the content key, so link.begin without the runtime's proof
//     still verifies (both keys sign the env: device.RegistrationSigningBytes).
//  3. The identity's env (<identity>/device.json), when it isn't the new environment's deviceEnv: the box's own word,
//     which control takes at link.begin; nothing else signs or pins it (the device id, its keys, its certificates and
//     the data stay).
//     An identity control made (route not `local`: a box registered before LNK-01, Home) is adopted when the box moves
//     to another control (MG-178): that route names a device of the old control only, so the identity becomes the
//     box's own, route `local` like every box's since LNK-01, with the same device id and keys, and a kept registration
//     signed for the new env is written when there was none, so the box can start Link on its own (the recovery menu,
//     the reach choice) as every box-made identity can. Within one control it can't move.
//  4. The box's environment file, last.
//
// The Link and own-address state is copied, never renamed (MG-179): /persist/manager is a btrfs subvolume of its own on
// an installed box, so a rename into the move's folder (in /persist's top subvolume) fails with EXDEV. Each folder is
// copied (files, modes, owners, links as links, every file and folder synced) into the move's folder under a temporary
// name, checked against the original, renamed there to its own name, and only then is the original removed. Putting it
// back copies the same way into the manager's folder. Each of these steps can run again after a stop.
//
// A move is all or nothing (R1 #13). Everything is read, checked and signed first, and every folder it writes to is
// tried, before anything changes. Then the move's folder, root's (<moves>/<time>-<from>/, under /persist/environment-
// moves, never under the manager's own folder), gets what is there now (before/), what will be (new/) and the move's
// record, and <moves>/pending names it; only then do the four steps run. One that fails is undone from before/ (the
// state comes back where the manager reads it). One that stopped (power, a crash) is finished by the next `environment
// set` or, at boot, by `environment write-run` (whombat-environment.service, root, before the manager), and undone
// when it can't be finished. The box is never left half-moved without its address state.
//
// Undo puts the newest finished move back from its own copies (`environment undo`): the identity, the registration and
// the environment file as they were, the Link and own-address state it set aside back where the manager reads it (what
// was made since goes into the move's folder, after/).
//
// The manager must not be running (its state is moved): the command refuses while it answers on its socket.
package envmove

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/internal/environment"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Paths are the files a move reads and writes.
type Paths struct {
	// Image and Box are the environment files (environment.ImageFile, environment.BoxFile).
	Image, Box string
	// IdentityDir holds device.json, registration.json, management.key and content.key (/persist/identity).
	IdentityDir string
	// ManagerDir holds the manager's link and own-address state (/persist/manager).
	ManagerDir string
	// Moves is root's folder of moves (/persist/environment-moves; another subvolume than ManagerDir on a box); "" is
	// MovesDir beside ManagerDir.
	Moves string
}

// DefaultPaths are the box's.
func DefaultPaths() Paths {
	return Paths{Image: environment.ImageFile, Box: environment.BoxFile, IdentityDir: "/persist/identity",
		ManagerDir: "/persist/manager", Moves: "/persist/environment-moves"}
}

func (p Paths) moves() string {
	if p.Moves != "" {
		return p.Moves
	}
	return filepath.Join(filepath.Dir(p.ManagerDir), MovesDir)
}

// The files and folders a move touches.
const (
	DeviceFile       = "device.json"
	RegistrationFile = "registration.json"
	ManagementKey    = "management.key"
	ContentKey       = "content.key"
	// LinkDir and OwnAddressDir are the manager's control-bound state (daemon: beside its journal).
	LinkDir       = "link"
	OwnAddressDir = "own-address"
	// MovesDir keeps each move's folder (what it put aside, what was there before, its record) and PendingFile, which
	// names the move under way.
	MovesDir    = "environment-moves"
	PendingFile = "pending"
	// localRoute is the appliance route of an identity the box made itself (provisioning's LocalRoute).
	localRoute = "local"
)

// Result says what a move did.
type Result struct {
	From string `json:"from"`
	To   string `json:"to"`
	// IdentityEnv is the identity's env before and after ("" each when it didn't change).
	IdentityFrom string `json:"identityFrom,omitempty"`
	IdentityTo   string `json:"identityTo,omitempty"`
	// Registration: the kept registration was signed again.
	Registration bool `json:"registration,omitempty"`
	// SetAside is where the Link and own-address state went ("" when the control is the same, or there was none).
	SetAside string `json:"setAside,omitempty"`
	// Adopted: an identity control made became the box's own (route `local`, MG-178); RouteFrom was its route.
	Adopted   bool   `json:"adopted,omitempty"`
	RouteFrom string `json:"routeFrom,omitempty"`
	// Undone: Recover finished an undo of this move that stopped (`environment undo`), not the move itself.
	Undone bool `json:"undone,omitempty"`
	// BoxFile: the environment file was written.
	BoxFile bool `json:"boxFile"`
}

// Changed reports whether the move changed anything.
func (r *Result) Changed() bool {
	return r.BoxFile || r.IdentityTo != "" || r.Registration || r.SetAside != "" || r.Adopted
}

// Errors of Move.
var (
	// ErrControlIdentity: the identity was made by control (its route isn't local) and the move stays with that control,
	// which knows the device by the identity it made.
	ErrControlIdentity = errors.New("this Whombat's identity was made by its control and can't change env with the same control")
	// ErrIdentity: device.json, registration.json or a key doesn't fit the others.
	ErrIdentity = errors.New("this Whombat's identity files don't fit together")
	// ErrPlace: a folder the move writes to can't take it (not writable, another file system, not root's own).
	ErrPlace = errors.New("this Whombat can't be moved here")
	// ErrUndone: the move stopped and everything it had changed was put back.
	ErrUndone = errors.New("the move stopped and was undone")
)

// plan is what a move will change, worked out before anything is.
type plan struct {
	res          *Result
	aside        []string // under ManagerDir
	identity     []byte   // device.json's new bytes; nil: unchanged
	registration []byte   // registration.json's new bytes; nil: unchanged
	box          bool     // the environment file is written
}

func (pl *plan) changes() bool {
	return len(pl.aside) > 0 || pl.identity != nil || pl.registration != nil || pl.box
}

// Move moves the box to the image's environment `to` (see the package comment). now names the move's folder. A move
// that stopped earlier is finished first.
func Move(p Paths, to string, now time.Time) (*Result, error) {
	if _, err := Recover(p); err != nil {
		return nil, fmt.Errorf("the move that stopped earlier: %w", err)
	}
	pl, err := prepare(p, to)
	if err != nil {
		return nil, err
	}
	if !pl.changes() {
		return pl.res, nil
	}
	if err := preflight(p, pl); err != nil {
		return nil, err
	}
	dir, err := begin(p, pl, now)
	if err != nil {
		return nil, err
	}
	if len(pl.aside) > 0 {
		pl.res.SetAside = dir
	}
	if err := writeRecordResult(dir, pl.res); err != nil {
		return nil, errors.Join(err, rollback(p, dir))
	}
	if err := apply(p, dir); err != nil {
		if rerr := rollback(p, dir); rerr != nil {
			return nil, fmt.Errorf("the move stopped (%v) and couldn't be undone: %w; run it again", err, rerr)
		}
		return nil, fmt.Errorf("%w: %v", ErrUndone, err)
	}
	return pl.res, nil
}

// Recover finishes the move <moves>/pending names, or undoes it when it can't be finished (ErrUndone). Nil, nil: no
// move under way. whombat-environment.service runs it at boot (`environment write-run`), before the manager starts.
func Recover(p Paths) (*Result, error) {
	b, err := os.ReadFile(filepath.Join(p.moves(), PendingFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	name := string(bytes.TrimSpace(b))
	// An undo that stopped is finished, never the move again (MG-179).
	undo := false
	if rest, ok := bytes.CutPrefix(bytes.TrimSpace(b), []byte(undoPrefix)); ok {
		name, undo = string(rest), true
	}
	if name == "" || name != filepath.Base(name) {
		return nil, fmt.Errorf("%w: %s names %q", ErrPlace, PendingFile, name)
	}
	dir := filepath.Join(p.moves(), name)
	rec, err := readRecord(dir)
	if err != nil {
		return nil, err
	}
	if undo {
		if err := finishUndo(p, dir, rec); err != nil {
			return nil, fmt.Errorf("the undo of the move to %s stopped (%v): run it again", rec.To, err)
		}
		res := rec.Result
		res.Undone = true
		return &res, nil
	}
	if err := apply(p, dir); err != nil {
		if rerr := rollback(p, dir); rerr != nil {
			return nil, fmt.Errorf("the move to %s stopped (%v) and couldn't be undone: %w", rec.To, err, rerr)
		}
		return nil, fmt.Errorf("%w: the move to %s: %v", ErrUndone, rec.To, err)
	}
	return &rec.Result, nil
}

// Pending reports whether a move is under way (<moves>/pending names one): one that stopped and was neither finished
// nor undone. Nothing may resolve the environment then (R2 A9).
func Pending(p Paths) (bool, error) {
	_, err := os.Lstat(filepath.Join(p.moves(), PendingFile))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// BootCheck is the boot's gate (whombat-environment-move.service, before the environment is resolved and before the
// manager and every other service that reads it): nil when no move is under way, when the one that stopped is finished
// now, or when it was undone (each said in words); any other outcome is an error, the move's record is kept, and the
// box must not go on: the environment it would resolve is not the identity's (R2 A9).
func BootCheck(p Paths) (string, error) {
	res, err := Recover(p)
	switch {
	case err == nil && res == nil:
		return "", nil
	case err == nil && res.Undone:
		return fmt.Sprintf("The undo of the move to the %s environment that stopped is finished: this Whombat is back in the %s environment.", res.To, res.From), nil
	case err == nil:
		return fmt.Sprintf("The move to the %s environment that stopped is finished.", res.To), nil
	case errors.Is(err, ErrUndone):
		return fmt.Sprintf("The environment move that stopped couldn't be finished and was undone: %v. This Whombat stays where it was.", err), nil
	}
	if pending, perr := Pending(p); perr != nil || !pending {
		return "", errors.Join(err, perr, errors.New("and its record is gone"))
	}
	return "", fmt.Errorf("an environment move stopped and could neither be finished nor undone (%v): this Whombat holds the manager until it is; its record is %s, the guide is docs/runbooks/updates.md “Moving Home to production”", err, filepath.Join(p.moves(), PendingFile))
}

// prepare works out the move without changing anything: the environments, the identity, the registration signed again
// in memory with both keys (checked against device.json), the state that goes aside.
func prepare(p Paths, to string) (*plan, error) {
	ib, err := os.ReadFile(p.Image)
	if err != nil {
		return nil, err
	}
	im, err := environment.ParseImage(ib)
	if err != nil {
		return nil, err
	}
	target, ok := im.Environments[to]
	if !ok {
		return nil, fmt.Errorf("%w: %q", environment.ErrUnknown, to)
	}
	pl := &plan{res: &Result{To: to}}
	// Where the box is now. A file naming nothing this image has, or a broken one, is no known control: its state goes.
	var cur *environment.Resolved
	if r, err := environment.Resolve(p.Image, p.Box); err == nil {
		cur = r
		pl.res.From = r.Name
	} else {
		pl.res.From = "unknown"
	}
	idPath := filepath.Join(p.IdentityDir, DeviceFile)
	id, err := readIdentity(idPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	otherControl := cur == nil || cur.ControlURL != target.ControlURL
	// An identity control made goes with the box to another control as the box's own (MG-178); within one control its
	// env can't change.
	adopt := id != nil && id.Route != localRoute && otherControl
	if id != nil && id.Env != target.DeviceEnv && id.Route != localRoute && !otherControl {
		return nil, fmt.Errorf("%w (route %q)", ErrControlIdentity, id.Route)
	}
	moveIdentity := id != nil && (id.Env != target.DeviceEnv || adopt)
	if otherControl {
		for _, name := range []string{LinkDir, OwnAddressDir} {
			if _, err := os.Lstat(filepath.Join(p.ManagerDir, name)); err == nil {
				pl.aside = append(pl.aside, name)
			} else if !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
		}
	}
	if id != nil {
		if pl.registration, err = resign(p.IdentityDir, id, target.DeviceEnv, adopt); err != nil {
			return nil, err
		}
		pl.res.Registration = pl.registration != nil
	}
	if moveIdentity {
		route := id.Route
		if adopt {
			route = localRoute
			pl.res.Adopted, pl.res.RouteFrom = true, id.Route
		}
		if pl.identity, err = identityWith(id, target.DeviceEnv, route); err != nil {
			return nil, err
		}
		if id.Env != target.DeviceEnv {
			pl.res.IdentityFrom, pl.res.IdentityTo = id.Env, target.DeviceEnv
		}
	}
	bx, err := os.ReadFile(p.Box)
	switch {
	case err == nil:
		parsed, perr := environment.ParseBox(bx)
		pl.box = perr != nil || parsed.Env != to
	case errors.Is(err, os.ErrNotExist):
		pl.box = true
	default:
		return nil, err
	}
	pl.res.BoxFile = pl.box
	return pl, nil
}

// preflight tries every place the move writes before anything changes: the moves folder (root's own, made here when
// missing, never through a link), the identity's folder and the environment file's (a file made and removed in
// each), and that the moves folder has room for a copy of the state going aside (MG-179).
func preflight(p Paths, pl *plan) error {
	moves := p.moves()
	if err := ownFolder(moves); err != nil {
		return err
	}
	dirs := []string{moves}
	if pl.identity != nil || pl.registration != nil {
		dirs = append(dirs, p.IdentityDir)
	}
	if pl.box {
		dirs = append(dirs, filepath.Dir(p.Box))
	}
	for _, d := range dirs {
		if err := tryWrite(d); err != nil {
			return fmt.Errorf("%w: %s takes no file: %v", ErrPlace, d, err)
		}
	}
	// The state going aside is copied into the moves folder (another subvolume than the manager's on a box, MG-179):
	// only files, folders and links, and room for all of it.
	var need int64
	for _, name := range pl.aside {
		n, err := treeSize(filepath.Join(p.ManagerDir, name))
		if err != nil {
			return fmt.Errorf("%w: %v", ErrPlace, err)
		}
		need += n
	}
	return haveRoom(moves, need)
}

// spaceMargin is left free on top of what a copy needs.
const spaceMargin = 32 << 20

// freeSpace is the room left in dir's file system for this process (tests replace it).
var freeSpace = func(dir string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

// haveRoom refuses (ErrPlace) when dir's file system can't take need bytes and the margin.
func haveRoom(dir string, need int64) error {
	if need == 0 {
		return nil
	}
	free, err := freeSpace(dir)
	if err != nil {
		return err
	}
	if free < need+spaceMargin {
		return fmt.Errorf("%w: %s has %d bytes free, the copy needs %d and %d to spare", ErrPlace, dir, free, need, int64(spaceMargin))
	}
	return nil
}

// ownFolder makes dir (0700) when it is missing and checks it is a folder of this process's user (root on a box),
// not a link and not open to others.
func ownFolder(dir string) error {
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("%w: %v", ErrPlace, err)
	}
	st, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if st.Mode()&os.ModeSymlink != 0 || !st.IsDir() || !ok || int(sys.Uid) != os.Getuid() {
		return fmt.Errorf("%w: %s is not a folder of %d's own", ErrPlace, dir, os.Getuid())
	}
	if st.Mode().Perm()&0o077 != 0 {
		return os.Chmod(dir, 0o700)
	}
	return nil
}

func tryWrite(dir string) error {
	f, err := os.CreateTemp(dir, ".envmove-try-*")
	if err != nil {
		return err
	}
	name := f.Name()
	_, werr := f.Write([]byte{0})
	serr := f.Sync()
	cerr := f.Close()
	return errors.Join(werr, serr, cerr, os.Remove(name))
}

// record is a move's own account of itself (<move>/record.json): what it changes, and which files were there before
// (their copies in <move>/before/).
type record struct {
	V               int      `json:"v"`
	From            string   `json:"from"`
	To              string   `json:"to"`
	Aside           []string `json:"aside,omitempty"`
	Identity        bool     `json:"identity,omitempty"`
	Registration    bool     `json:"registration,omitempty"`
	Box             bool     `json:"box,omitempty"`
	HadRegistration bool     `json:"hadRegistration,omitempty"`
	HadBox          bool     `json:"hadBox,omitempty"`
	Result          Result   `json:"result"`
}

const (
	recordFile   = "record.json"
	beforeDir    = "before"
	newDir       = "new"
	boxCopy      = "environment.json"
	undoneMarker = "undone"
)

// begin makes the move's folder with its record and copies, then names it in <moves>/pending. Nothing else has
// changed yet; a failure here removes the folder.
func begin(p Paths, pl *plan, now time.Time) (dir string, err error) {
	moves := p.moves()
	base := now.UTC().Format("20060102T150405Z") + "-" + pl.res.From
	for i := 1; ; i++ {
		dir = filepath.Join(moves, base)
		if i > 1 {
			dir = fmt.Sprintf("%s-%d", dir, i)
		}
		if err = os.Mkdir(dir, 0o700); err == nil {
			break
		}
		if !errors.Is(err, os.ErrExist) || i > 99 {
			return "", err
		}
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(dir)
		}
	}()
	for _, d := range []string{beforeDir, newDir} {
		if err := os.Mkdir(filepath.Join(dir, d), 0o700); err != nil {
			return "", err
		}
	}
	rec := &record{V: 1, From: pl.res.From, To: pl.res.To, Aside: pl.aside, Identity: pl.identity != nil,
		Registration: pl.registration != nil, Box: pl.box, Result: *pl.res}
	keep := func(src, name string) (bool, error) {
		b, err := os.ReadFile(src)
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		return true, writeNew(filepath.Join(dir, beforeDir, name), b)
	}
	if rec.Identity {
		if _, err := keep(filepath.Join(p.IdentityDir, DeviceFile), DeviceFile); err != nil {
			return "", err
		}
		if err := writeNew(filepath.Join(dir, newDir, DeviceFile), pl.identity); err != nil {
			return "", err
		}
	}
	if rec.Registration {
		if rec.HadRegistration, err = keep(filepath.Join(p.IdentityDir, RegistrationFile), RegistrationFile); err != nil {
			return "", err
		}
		if err := writeNew(filepath.Join(dir, newDir, RegistrationFile), pl.registration); err != nil {
			return "", err
		}
	}
	if rec.Box {
		if rec.HadBox, err = keep(p.Box, boxCopy); err != nil {
			return "", err
		}
	}
	if err := writeRecord(dir, rec); err != nil {
		return "", err
	}
	if err := atomicfile.WriteFile(filepath.Join(moves, PendingFile), []byte(filepath.Base(dir)+"\n"), 0o600); err != nil {
		return "", err
	}
	return dir, atomicfile.SyncDir(moves)
}

// applyHook, when set (tests), runs before each step of apply: an error stops the move there, as a crash would.
var applyHook func(step string) error

func hook(step string) error {
	if applyHook == nil {
		return nil
	}
	return applyHook(step)
}

// apply does what the move's record says, each step only when it isn't done yet, then drops <moves>/pending.
func apply(p Paths, dir string) error {
	rec, err := readRecord(dir)
	if err != nil {
		return err
	}
	if err := hook("aside"); err != nil {
		return err
	}
	for _, name := range rec.Aside {
		if err := setAside(p, dir, name); err != nil {
			return err
		}
	}
	put := func(step, name string) error {
		if err := hook(step); err != nil {
			return err
		}
		b, err := os.ReadFile(filepath.Join(dir, newDir, name))
		if err != nil {
			return err
		}
		return atomicfile.WriteFile(filepath.Join(p.IdentityDir, name), b, 0o644)
	}
	if rec.Registration {
		if err := put("registration", RegistrationFile); err != nil {
			return err
		}
	}
	if rec.Identity {
		if err := put("identity", DeviceFile); err != nil {
			return err
		}
	}
	if rec.Box {
		if err := hook("box"); err != nil {
			return err
		}
		if _, err := environment.Set(p.Image, p.Box, rec.To, false); err != nil {
			return err
		}
	}
	if err := hook("done"); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(p.moves(), PendingFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return atomicfile.SyncDir(p.moves())
}

// rollback puts back what the move changed: the environment file, the identity and the registration from before/, the
// state from the move's folder; then drops <moves>/pending and marks the folder undone.
func rollback(p Paths, dir string) error {
	rec, err := readRecord(dir)
	if err != nil {
		return err
	}
	restore := func(had bool, copyPath, target string) error {
		if !had {
			if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			return nil
		}
		b, err := os.ReadFile(copyPath)
		if err != nil {
			return err
		}
		if now, err := os.ReadFile(target); err == nil && bytes.Equal(now, b) {
			return nil // never changed: nothing to put back
		}
		return atomicfile.WriteFile(target, b, 0o644)
	}
	var errs []error
	if rec.Box {
		errs = append(errs, restore(rec.HadBox, filepath.Join(dir, beforeDir, boxCopy), p.Box))
	}
	if rec.Identity {
		errs = append(errs, restore(true, filepath.Join(dir, beforeDir, DeviceFile), filepath.Join(p.IdentityDir, DeviceFile)))
	}
	if rec.Registration {
		errs = append(errs, restore(rec.HadRegistration, filepath.Join(dir, beforeDir, RegistrationFile),
			filepath.Join(p.IdentityDir, RegistrationFile)))
	}
	for _, name := range rec.Aside {
		errs = append(errs, putBack(p, dir, name))
	}
	if err := errors.Join(errs...); err != nil {
		return err
	}
	if err := writeNew(filepath.Join(dir, undoneMarker), []byte(time.Now().UTC().Format(time.RFC3339)+"\n")); err != nil &&
		!errors.Is(err, os.ErrExist) {
		return err
	}
	if err := os.Remove(filepath.Join(p.moves(), PendingFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return atomicfile.SyncDir(p.moves())
}

// ErrNoMove: there is no finished move to undo (none yet, or the newest was undone already).
var ErrNoMove = errors.New("there is no environment move to undo")

// ErrMovedSince: something the move wrote has changed since (another move, a hand edit), so its copies would put back
// more than the move did.
var ErrMovedSince = errors.New("this Whombat changed since that move")

const afterDir = "after"

// Undo puts the newest finished move back (MG-178): the identity, the registration and the environment file from its
// before/ copies (a registration the move made is removed), the state it set aside back where the manager reads it,
// what was made since in its place going into the move's after/. Every file must still be what the move wrote, or
// what it had before (an undo that stopped is run again), else ErrMovedSince and nothing changes. A move under way is
// finished first. The answer is the move that was undone.
func Undo(p Paths) (*Result, error) {
	res, err := Recover(p)
	if err != nil {
		return nil, fmt.Errorf("the move that stopped earlier: %w", err)
	}
	if res != nil && res.Undone {
		return res, nil // the undo that stopped is finished now
	}
	dir, rec, err := newestMove(p)
	if err != nil {
		return nil, err
	}
	same := func(path string, wants ...[]byte) error {
		now, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			now = nil
		} else if err != nil {
			return err
		}
		for _, w := range wants {
			if bytes.Equal(now, w) {
				return nil
			}
		}
		return fmt.Errorf("%w: %s", ErrMovedSince, path)
	}
	read := func(name string) []byte {
		b, err := os.ReadFile(name)
		if err != nil {
			return nil
		}
		return b
	}
	var errs []error
	if rec.Identity {
		errs = append(errs, same(filepath.Join(p.IdentityDir, DeviceFile), read(filepath.Join(dir, newDir, DeviceFile)),
			read(filepath.Join(dir, beforeDir, DeviceFile))))
	}
	if rec.Registration {
		errs = append(errs, same(filepath.Join(p.IdentityDir, RegistrationFile), read(filepath.Join(dir, newDir, RegistrationFile)),
			read(filepath.Join(dir, beforeDir, RegistrationFile))))
	}
	if rec.Box {
		bx, err := os.ReadFile(p.Box)
		if err == nil {
			parsed, perr := environment.ParseBox(bx)
			if perr != nil || (parsed.Env != rec.To && !bytes.Equal(bx, read(filepath.Join(dir, beforeDir, boxCopy)))) {
				errs = append(errs, fmt.Errorf("%w: %s", ErrMovedSince, p.Box))
			}
		} else if !errors.Is(err, os.ErrNotExist) || rec.HadBox {
			errs = append(errs, fmt.Errorf("%w: %s", ErrMovedSince, p.Box))
		}
	}
	if err := errors.Join(errs...); err != nil {
		return nil, err
	}
	// Room for what goes into after/ (the moves folder) and for what comes back (the manager's folder).
	var after, back int64
	for _, name := range rec.Aside {
		n, err := treeSize(filepath.Join(p.ManagerDir, name))
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrPlace, err)
		}
		after += n
		if n, err = treeSize(filepath.Join(dir, name)); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrPlace, err)
		}
		back += n
	}
	if err := errors.Join(haveRoom(p.moves(), after), haveRoom(p.ManagerDir, back)); err != nil {
		return nil, err
	}
	// From here the undo is under way: <moves>/pending names it, so a stop is finished at boot before anything reads
	// the environment (Recover), never left half done.
	if err := atomicfile.WriteFile(filepath.Join(p.moves(), PendingFile), []byte(undoPrefix+filepath.Base(dir)+"\n"), 0o600); err != nil {
		return nil, err
	}
	if err := atomicfile.SyncDir(p.moves()); err != nil {
		return nil, err
	}
	if err := finishUndo(p, dir, rec); err != nil {
		return nil, fmt.Errorf("the undo stopped (%w); run it again", err)
	}
	return &rec.Result, nil
}

// undoPrefix marks an undo in <moves>/pending: `undo <move's folder>`.
const undoPrefix = "undo "

// finishUndo does what an undo does, each step only when it isn't done yet: what the manager made since the move goes
// into the move's after/ (copied, checked, then removed), then rollback puts everything the move changed back and drops
// <moves>/pending.
func finishUndo(p Paths, dir string, rec *record) error {
	for _, name := range rec.Aside {
		if err := keepAfter(p, dir, name); err != nil {
			return err
		}
	}
	return rollback(p, dir)
}

// newestMove is the newest move's folder (the names start with the time) and its record; ErrNoMove when there is none
// or the newest was undone.
func newestMove(p Paths) (string, *record, error) {
	entries, err := os.ReadDir(p.moves())
	if errors.Is(err, os.ErrNotExist) {
		return "", nil, ErrNoMove
	}
	if err != nil {
		return "", nil, err
	}
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(p.moves(), e.Name())
		rec, err := readRecord(dir)
		if err != nil {
			continue
		}
		if _, err := os.Lstat(filepath.Join(dir, undoneMarker)); err == nil {
			return "", nil, fmt.Errorf("%w: the newest, %s, was undone already", ErrNoMove, e.Name())
		}
		return dir, rec, nil
	}
	return "", nil, ErrNoMove
}

func readRecord(dir string) (*record, error) {
	b, err := os.ReadFile(filepath.Join(dir, recordFile))
	if err != nil {
		return nil, err
	}
	var rec record
	if err := json.Unmarshal(b, &rec); err != nil || rec.V != 1 {
		return nil, fmt.Errorf("%w: %s: %v", ErrPlace, filepath.Join(dir, recordFile), err)
	}
	return &rec, nil
}

func writeRecord(dir string, rec *record) error {
	b, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.WriteFile(filepath.Join(dir, recordFile), append(b, '\n'), 0o600)
}

// writeRecordResult keeps the result (with the move's folder) in its record, for Recover's answer.
func writeRecordResult(dir string, res *Result) error {
	rec, err := readRecord(dir)
	if err != nil {
		return err
	}
	rec.Result = *res
	return writeRecord(dir, rec)
}

// writeNew writes a file that must not exist yet, never through a link, synced.
func writeNew(path string, b []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// identity is what a move reads of device.json.
type identity struct {
	raw   map[string]json.RawMessage
	Env   string
	Route string
	reg   device.DeviceRegistration // the members a registration is made of
}

func readIdentity(path string) (*identity, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrIdentity, path, err)
	}
	var f struct {
		DeviceID            string `json:"deviceId"`
		Env                 string `json:"env"`
		ApplianceRoute      string `json:"applianceRoute"`
		Model               string `json:"model"`
		Serial              string `json:"serial"`
		ContentPeerID       string `json:"contentPeerId"`
		ContentPublicKey    string `json:"contentPublicKey"`
		ManagementPublicKey string `json:"managementPublicKey"`
		ProvisionedAt       int64  `json:"provisionedAt"`
	}
	if err := json.Unmarshal(b, &f); err != nil || f.DeviceID == "" || f.Env == "" {
		return nil, fmt.Errorf("%w: %s has no device id or env", ErrIdentity, path)
	}
	return &identity{raw: raw, Env: f.Env, Route: f.ApplianceRoute, reg: device.DeviceRegistration{
		Env: release.Environment(f.Env), HardwareSerial: f.Serial, Model: f.Model, ManagementPublicKey: f.ManagementPublicKey,
		ContentPeerID: f.ContentPeerID, ContentPublicKey: f.ContentPublicKey, ProvisionedAt: f.ProvisionedAt}}, nil
}

// identityWith is device.json with its env and route set (every other member as it is, an unknown one too).
func identityWith(id *identity, env, route string) ([]byte, error) {
	raw := map[string]json.RawMessage{}
	for k, v := range id.raw {
		raw[k] = v
	}
	ev, _ := json.Marshal(env)
	raw["env"] = ev
	if route != id.Route {
		rv, _ := json.Marshal(route)
		raw["applianceRoute"] = rv
	}
	b, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// resign is the kept registration signed again for env, when it says another one (nil: nothing to do, or no file).
// Its members must be the identity's; both keys must be the ones it names. With create, a box without the file gets
// one (an adopted identity: control kept its registration, MG-178). Nothing is written.
func resign(dir string, id *identity, env string, create bool) ([]byte, error) {
	path := filepath.Join(dir, RegistrationFile)
	b, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist) && !create:
		return nil, nil
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		var kept device.DeviceRegistration
		if err := json.Unmarshal(b, &kept); err != nil {
			return nil, fmt.Errorf("%w: %s: %v", ErrIdentity, path, err)
		}
		if string(kept.Env) == env && device.VerifyRegistration(&kept) {
			return nil, nil
		}
		want := id.reg
		want.Env, want.Proof, want.ContentProof = kept.Env, "", ""
		got := kept
		got.Proof, got.ContentProof = "", ""
		if got != want {
			return nil, fmt.Errorf("%w: %s doesn't name device.json's keys and facts", ErrIdentity, path)
		}
	}
	mgmt, err := readManagementKey(filepath.Join(dir, ManagementKey))
	if err != nil {
		return nil, err
	}
	content, err := readContentKey(filepath.Join(dir, ContentKey))
	if err != nil {
		return nil, err
	}
	if hex.EncodeToString(mgmt.Public().(ed25519.PublicKey)) != id.reg.ManagementPublicKey ||
		hex.EncodeToString(content.Public().(ed25519.PublicKey)) != id.reg.ContentPublicKey {
		return nil, fmt.Errorf("%w: the keys on disk aren't the ones device.json names", ErrIdentity)
	}
	reg := id.reg
	reg.Env = release.Environment(env)
	if err := device.SignRegistration(&reg, mgmt, content); err != nil {
		return nil, err
	}
	if !device.VerifyRegistration(&reg) {
		return nil, fmt.Errorf("%w: the registration signed again doesn't verify", ErrIdentity)
	}
	out, err := json.Marshal(&reg)
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

// readSecret reads a small key file without following a link.
func readSecret(path string) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, 8192))
}

// readManagementKey reads management.key (PKCS#8 PEM, the manager's; root reads it here).
func readManagementKey(path string) (ed25519.PrivateKey, error) {
	b, err := readSecret(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(b)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("%w: %s is not a PKCS#8 PEM key", ErrIdentity, path)
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrIdentity, path, err)
	}
	priv, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%w: %s is not Ed25519", ErrIdentity, path)
	}
	return priv, nil
}

// readContentKey reads content.key: libp2p's protobuf private key, Ed25519 (0x08 0x01 0x12 0x40 ‖ seed ‖ public).
func readContentKey(path string) (ed25519.PrivateKey, error) {
	b, err := readSecret(path)
	if err != nil {
		return nil, err
	}
	if len(b) != 68 || !bytes.Equal(b[:4], []byte{0x08, 0x01, 0x12, 0x40}) {
		return nil, fmt.Errorf("%w: %s is not a libp2p Ed25519 key", ErrIdentity, path)
	}
	priv := ed25519.NewKeyFromSeed(b[4:36])
	if !bytes.Equal(priv.Public().(ed25519.PublicKey), b[36:]) {
		return nil, fmt.Errorf("%w: %s: its public half isn't its seed's", ErrIdentity, path)
	}
	return priv, nil
}
