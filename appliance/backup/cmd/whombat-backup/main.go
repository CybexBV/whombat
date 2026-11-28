// Command whombat-backup is the appliance backup service (docs/runbooks/backup.md).
//
//	whombat-backup [-config /etc/whombat-backup/config.json] <command> [flags]
//
//	run [-reason scheduled|manual|pre-migration]   take one checkpoint (exit 0 ok, 2 unprotected, 3 busy, 1 failed)
//	status [-json]                                  backup status (whombat.backup-status/1)
//	destination set -repository URL [-init] [-cacert F]
//	    rest:  [-user U -password-file F]
//	    s3:    -s3-key-id ID -s3-secret-file F [-s3-region R]
//	    sftp:  -sftp-user U [-sftp-host-key "ssh-ed25519 AAAA…"|SHA256:…]   (no host key: trust on first use)
//	    disk:  (the disk labelled WHOMBAT-BACKUP; -init prepares an empty one)
//	destination adopt -kit FILE [-from main|offsite]  join an existing repository (replacement): the main place, else
//	                                                the kit's second place
//	offsite set|remove|status|copy [-if-due]         the second place: a copy of the backups somewhere else
//	ssh-public-key [-json]                          the box's SFTP key (made on first use)
//	kit-material                                    the recovery kit's backup section (JSON)
//	snapshots [-json]                               authentic checkpoints and the chain report
//	drill [-snapshot ID] [-check-data 10%] [-server-admin-dsn DSN] [-audit-verify CMD] [-keep] [-json]
//	serve                                           local API (socket activation or -socket)
//	disk-init | disk-scan                           root: prepare the one empty disk (path unit) | list disks
//	quarantine prepare|apply|status|resolve|release restore onto a fresh or replacement appliance
//	                                                (docs/runbooks/restore.md, replacement.md)
//	coverage [-persist /persist] [-hosts=false]     the coverage inventory (Markdown)
//	quarantine undo                                 root: put back what an unfinished restore set aside
//	restore -snapshot ID [-release-schema N]        root: the app's restore (whombat-backup-restore@ID.service)
//	restore-end -snapshot ID [-failed newer|migration|check]  root: the restore unit's last step
//	restore-recover                                 root: undo a restore a crash or power cut stopped; remove what a
//	                                                released one set aside (whombat-backup-restore-recover.service)
//	run -if-due / drill -if-due                     the 15-minute and hourly timers: only when the policy says so
//	peek-sweep                                      at boot: close a backup opened for reading
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/api"
	"github.com/CybexBV/whombat/appliance/backup/internal/checkpoint"
	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/disk"
	"github.com/CybexBV/whombat/appliance/backup/internal/drill"
	"github.com/CybexBV/whombat/appliance/backup/internal/listing"
	"github.com/CybexBV/whombat/appliance/backup/internal/peek"
	"github.com/CybexBV/whombat/appliance/backup/internal/quarantine"
	"github.com/CybexBV/whombat/appliance/backup/internal/runtimeadmin"
	"github.com/CybexBV/whombat/appliance/backup/internal/snap"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/coverage"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

func logf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, time.Now().UTC().Format("15:04:05Z ")+format+"\n", a...)
}

// atExit runs before the process exits (die included): the unsealed secrets of a root run are removed.
var atExit = func() {}

func die(code int, format string, a ...any) {
	fmt.Fprintf(os.Stderr, "whombat-backup: "+format+"\n", a...)
	atExit()
	os.Exit(code)
}

func main() {
	global := flag.NewFlagSet("whombat-backup", flag.ExitOnError)
	cfgPath := global.String("config", "/etc/whombat-backup/config.json", "configuration file")
	_ = global.Parse(os.Args[1:])
	args := global.Args()
	if len(args) == 0 {
		die(64, "usage: whombat-backup [-config F] run|status|destination|offsite|ssh-public-key|kit-material|snapshots|drill|serve|disk-init|disk-attach|disk-scan|quarantine|coverage")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if args[0] == "coverage" {
		fs := flag.NewFlagSet("coverage", flag.ExitOnError)
		persist := fs.String("persist", "/persist", "layout root")
		hosts := fs.Bool("hosts", true, "a box with the hosts service (its servers are a class of their own)")
		_ = fs.Parse(args[1:])
		fmt.Print(coverage.Markdown(coverage.Layout{Persist: *persist, Hosts: *hosts}))
		return
	}
	cfg, err := state.LoadConfig(*cfgPath)
	if err != nil {
		die(78, "%v", err)
	}
	if timerRun(args) {
		cfg.RetryLock = restic.TimerRetryLock // nobody waits on a timer's run: it outwaits a short NAS cleanup
	}
	if os.Geteuid() == 0 && cfg.BackupUID > 0 {
		asRoot(ctx, cfg, args)
	}
	switch args[0] {
	case "run":
		cmdRun(ctx, cfg, args[1:])
	case "status":
		cmdStatus(cfg, args[1:])
	case "destination":
		cmdDestination(ctx, cfg, args[1:])
	case "ssh-public-key":
		fs := flag.NewFlagSet("ssh-public-key", flag.ExitOnError)
		asJSON := fs.Bool("json", false, "JSON")
		_ = fs.Parse(args[1:])
		k, err := dest.PublicKey(cfg)
		if err != nil {
			die(1, "%v", err)
		}
		if *asJSON {
			printJSON(k)
			return
		}
		fmt.Printf("%s\n%s\n", k.PublicKey, k.Fingerprint)
	case "disk-init":
		cmdDiskInit(ctx, cfg)
	case "disk-attach":
		msg, err := diskSystem(cfg).Attach(ctx, cfg.DiskPinPath(), cfg.DiskMount, cfg.BackupUID, backupGID(cfg))
		if err != nil {
			die(1, "disk-attach: %v", err)
		}
		logf("disk-attach: %s", msg)
	case "disk-scan":
		disks, err := diskSystem(cfg).Scan(ctx)
		if err != nil {
			die(1, "%v", err)
		}
		printJSON(disks)
	case "kit-material":
		m, err := dest.Material(cfg)
		if err != nil {
			die(1, "%v", err)
		}
		printJSON(m)
	case "snapshots":
		cmdSnapshots(ctx, cfg, args[1:])
	case "drill":
		cmdDrill(ctx, cfg, args[1:])
	case "serve":
		cmdServe(ctx, cfg, args[1:])
	case "quarantine":
		cmdQuarantine(ctx, cfg, args[1:])
	case "restore":
		cmdRestore(ctx, cfg, args[1:])
	case "restore-end":
		cmdRestoreEnd(ctx, cfg, args[1:])
	case "restore-recover":
		cmdRestoreRecover(ctx, cfg, args[1:])
	case "offsite":
		cmdOffsite(ctx, cfg, args[1:])
	case "peek-sweep":
		peek.Sweep(ctx, cfg) // at boot: a backup opened for reading closes (its database and files go)
	default:
		die(64, "unknown command %q", args[0])
	}
}

// timerRun: a run the timers start (`run -if-due`, `drill -if-due`, `offsite copy -if-due`), which nobody waits on.
func timerRun(args []string) bool {
	rest := args[1:]
	switch {
	case args[0] == "offsite" && len(args) > 1 && args[1] == "copy":
		rest = args[2:]
	case args[0] != "run" && args[0] != "drill":
		return false
	}
	for _, a := range rest {
		if a == "-if-due" || a == "--if-due" || a == "-if-due=true" || a == "--if-due=true" {
			return true
		}
	}
	return false
}

// rootCommand: what a root run does itself (BK-26): putting a restore in place and the database (quarantine
// prepare/apply/release), and the disk helper. Everything else runs as the backup user.
func rootCommand(args []string) bool {
	switch args[0] {
	case "disk-init", "disk-attach", "disk-scan":
		return true
	case "quarantine":
		return len(args) > 1 && (args[1] == "prepare" || args[1] == "apply" || args[1] == "release" || args[1] == "undo")
	case "restore", "restore-end", "restore-recover":
		return true
	}
	return false
}

func backupGID(cfg *state.Config) int {
	if u, err := user.LookupId(strconv.Itoa(cfg.BackupUID)); err == nil {
		if g, err := strconv.Atoi(u.Gid); err == nil {
			return g
		}
	}
	return cfg.BackupUID
}

// asRoot prepares a run as root (BK-24, BK-26). The state directory is the backup user's: root mode
// reaches it without following anything that user planted, and takes secrets only from a private directory
// on /run it fills itself. Commands that don't need root run in a child process as the backup user (with
// the unsealed secrets handed over); this process waits for it and removes them.
func asRoot(ctx context.Context, cfg *state.Config, args []string) {
	uid, gid := cfg.BackupUID, backupGID(cfg)
	state.EnterRootMode(cfg, uid, gid)
	if args[0] == "run" || args[0] == "serve" {
		die(64, "%s is the backup service's: systemctl start %s", args[0], map[string]string{"run": "whombat-backup.service", "serve": "whombat-backup-api.socket"}[args[0]])
	}
	if args[0] == "disk-init" || args[0] == "disk-attach" || args[0] == "disk-scan" || args[0] == "restore-end" ||
		args[0] == "restore-recover" || (args[0] == "quarantine" && len(args) > 1 && args[1] == "undo") {
		return // no secrets, no network: files and the local database only
	}
	done, err := state.MaterializeForRoot(cfg, cfg.SystemdCreds)
	if err != nil {
		die(1, "%v", err)
	}
	atExit = done
	if rootCommand(args) {
		// restic without its cache (no root-owned files there); the backup group is what the egress rule lets
		// reach destinations on any port (BK-22).
		cfg.NoCache = true
		if err := syscall.Setgid(gid); err != nil {
			die(1, "setgid %d: %v", gid, err)
		}
		return
	}
	argv, err := filesForChild(cfg.RuntimeDir, os.Args[1:])
	if err != nil {
		die(1, "%v", err)
	}
	if err := state.HandOver(cfg); err != nil {
		die(1, "%v", err)
	}
	var groups []uint32
	if u, err := user.LookupId(strconv.Itoa(uid)); err == nil {
		if ids, err := u.GroupIds(); err == nil {
			for _, g := range ids {
				if n, err := strconv.Atoi(g); err == nil {
					groups = append(groups, uint32(n))
				}
			}
		}
	}
	self, err := os.Executable()
	if err != nil {
		die(1, "%v", err)
	}
	cmd := exec.CommandContext(ctx, self, argv...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=/var/empty", "LANG=C.UTF-8", "CREDENTIALS_DIRECTORY=" + cfg.RuntimeDir}
	if t := os.Getenv("TMPDIR"); t != "" {
		cmd.Env = append(cmd.Env, "TMPDIR="+t)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid), Groups: groups}}
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	err = cmd.Run()
	code := 0
	if err != nil {
		code = 1
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() > 0 {
			code = ee.ExitCode()
		} else {
			fmt.Fprintf(os.Stderr, "whombat-backup: as the backup user: %v\n", err)
		}
	}
	done()
	os.Exit(code)
}

// filesForChild: files the operator names on the command line (a recovery kit in /root, a password file)
// are read here, as root, and handed to the child as private copies.
func filesForChild(dir string, args []string) ([]string, error) {
	files := map[string]bool{"kit": true, "password-file": true, "s3-secret-file": true, "cacert": true}
	argv := append([]string(nil), args...)
	n := 0
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		if !strings.HasPrefix(a, "-") {
			continue
		}
		name, val, eq := strings.Cut(strings.TrimLeft(a, "-"), "=")
		if !files[name] {
			continue
		}
		if !eq {
			if i+1 >= len(argv) {
				break
			}
			val = argv[i+1]
		}
		b, err := os.ReadFile(val)
		if err != nil {
			return nil, err
		}
		n++
		p := filepath.Join(dir, fmt.Sprintf("arg-%d-%s", n, name))
		if err := os.WriteFile(p, b, 0o400); err != nil {
			return nil, err
		}
		if eq {
			argv[i] = "-" + name + "=" + p
		} else {
			argv[i+1] = p
			i++
		}
	}
	return argv, nil
}

func printJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

// Snapshotter builds the configured snapshotter.
func snapshotter(cfg *state.Config) snap.Snapshotter {
	if cfg.SnapSocket != "" {
		return &snap.Remote{Socket: cfg.SnapSocket}
	}
	return &snap.Local{Driver: driver(cfg), Sources: cfg.Layout().Sources(), FilesDir: cfg.StagingDir() + "/files"}
}

func driver(cfg *state.Config) snap.Driver {
	switch cfg.Driver {
	case "btrfs":
		return snap.Btrfs{}
	case "zfs":
		return snap.ZFS{Datasets: cfg.SnapDatasets, Tag: "whombat-backup"}
	default:
		return snap.Copy{Reserve: cfg.ReserveBytes}
	}
}

func newRunner(cfg *state.Config) *checkpoint.Runner {
	r := &checkpoint.Runner{Cfg: cfg, Snap: snapshotter(cfg), Log: logf}
	if cfg.RuntimeSocket != "" {
		r.Runtime = runtimeadmin.New(cfg.RuntimeSocket)
	}
	return r
}

func cmdRun(ctx context.Context, cfg *state.Config, args []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	reason := fs.String("reason", "scheduled", "scheduled|manual|pre-migration")
	under := fs.String("under-drain", "", "request id of a drain the caller holds (pre-migration)")
	asJSON := fs.Bool("json", false, "print the result as JSON")
	ifDue := fs.Bool("if-due", false, "only when the policy's schedule says a backup is due (the timer)")
	_ = fs.Parse(args)
	if *ifDue {
		peek.Sweep(ctx, cfg) // every 15 minutes: a backup opened for reading past its time closes even with the API idle
		if due, why := backupDue(cfg, time.Now()); !due {
			logf("not due: %s", why)
			return
		} else {
			logf("due: %s", why)
		}
	}
	res, err := newRunner(cfg).Run(ctx, checkpoint.Options{Reason: *reason, UnderDrain: *under})
	if err == nil && *reason == "scheduled" {
		clearOldBackups(ctx, cfg)
	}
	switch {
	case errors.Is(err, checkpoint.ErrUnprotected):
		die(2, "%v", err)
	case errors.Is(err, state.ErrBusy):
		die(3, "%v", err)
	case err != nil:
		die(1, "checkpoint failed: %v", err)
	}
	if *asJSON {
		printJSON(map[string]any{"id": res.Manifest.ID, "seq": res.Manifest.Seq, "snapshotId": res.Summary.SnapshotID,
			"manifestSha256": res.ManifestSHA256, "durationMs": res.Duration.Milliseconds(), "quiesce": res.Manifest.Quiesce})
		return
	}
	fmt.Printf("checkpoint %s (seq %d) → snapshot %s in %s; writes paused %d ms (%s)\n", res.Manifest.ID, res.Manifest.Seq,
		res.Summary.SnapshotID[:8], res.Duration.Round(time.Millisecond), res.Manifest.Quiesce.HeldMs, res.Manifest.Quiesce.Method)
}

func cmdStatus(cfg *state.Config, args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "JSON")
	_ = fs.Parse(args)
	dest.RefreshPresence(cfg)
	st, err := state.CurrentStatus(cfg)
	if err != nil {
		die(1, "%v", err)
	}
	if *asJSON {
		printJSON(st)
		return
	}
	fmt.Printf("state: %s\n", st.State)
	if !st.Destination.Configured {
		fmt.Println("destination: none — this appliance is unprotected")
	} else {
		fmt.Printf("destination: %s (append-only: %s)\n", st.Destination.Display, st.Destination.AppendOnly)
	}
	if s := st.LastSuccess; s != nil {
		fmt.Printf("last success: %s (%s ago), %s, writes paused %d ms\n", s.At.Format(time.RFC3339), time.Duration(s.AgeSeconds)*time.Second, s.Method, s.QuiesceHeldMs)
	}
	if f := st.LastFailure; f != nil {
		fmt.Printf("last failure: %s at %s: %s\n", f.At.Format(time.RFC3339), f.Stage, f.Reason)
	}
	if d := st.Recoverability.LastDrill; d != nil {
		fmt.Printf("last drill: %s ok=%v RTO %ds backup age %ds failed=%v skipped=%v\n", d.At.Format(time.RFC3339), d.OK, d.RTOSeconds, d.BackupAgeSeconds, d.Failed, d.Skipped)
	} else {
		fmt.Println("last drill: never (recoverability not verified)")
	}
}

func readSecret(path string) string {
	if path == "" {
		return ""
	}
	b, err := os.ReadFile(path)
	if err != nil {
		die(1, "%v", err)
	}
	return strings.TrimSpace(string(b))
}

func cmdDestination(ctx context.Context, cfg *state.Config, args []string) {
	if len(args) == 0 {
		die(64, "destination set|adopt")
	}
	fs := flag.NewFlagSet("destination", flag.ExitOnError)
	repo := fs.String("repository", "", "restic repository: rest:https://host/path/, s3:https://host/bucket/path, sftp:host:/path, disk:, or a local path")
	user := fs.String("user", "", "REST user (append-only credential)")
	pwFile := fs.String("password-file", "", "file with the REST password")
	cacert := fs.String("cacert", "", "PEM file: CA certificate of a private rest: or s3: destination")
	initRepo := fs.Bool("init", false, "create the repository if it doesn't exist (disk: also prepares an empty disk)")
	s3ID := fs.String("s3-key-id", "", "S3 access key ID")
	s3Secret := fs.String("s3-secret-file", "", "file with the S3 secret access key")
	s3Region := fs.String("s3-region", "", "S3 region (when the service needs one)")
	sftpUser := fs.String("sftp-user", "", "SFTP user")
	sftpHostKey := fs.String("sftp-host-key", "", `the server's host key ("ssh-ed25519 AAAA…") or its fingerprint (SHA256:…); none = trust on first use`)
	kitFile := fs.String("kit", "", "recovery kit (adopt)")
	from := fs.String("from", "", "adopt: main or offsite (default: the main place, then the kit's second place)")
	_ = fs.Parse(args[1:])
	req := dest.Request{Repository: *repo, RESTUser: *user, RESTPassword: readSecret(*pwFile), AllowInit: *initRepo,
		S3AccessKeyID: *s3ID, S3SecretAccessKey: readSecret(*s3Secret), S3Region: *s3Region,
		SFTPUser: *sftpUser, SFTPHostKey: *sftpHostKey, AllowLocal: true}
	if *cacert != "" {
		b, err := os.ReadFile(*cacert)
		if err != nil {
			die(1, "%v", err)
		}
		req.CACert = string(b)
	}
	switch args[0] {
	case "set":
		if req.Repository == "" {
			die(64, "-repository required")
		}
	case "adopt":
		m, err := kit.Load(*kitFile)
		if err != nil {
			die(1, "%v", err)
		}
		// Everything from the kit: the repository, its password, the destination's credentials, the old
		// appliance's manifest key (the checkpoints a quarantine restore trusts), the newest checkpoint it knew and
		// the Whombats it was brought back from. The main place first, then the kit's second place (or only the one
		// -from names).
		cacert := req.CACert
		from, d, err := dest.Adopt(ctx, cfg, m, *from, func(r *dest.Request) {
			r.CACert, r.AllowLocal = cacert, true
			if *repo != "" { // the same repository reached another way (e.g. a copy on a local path)
				r.Repository = *repo
			}
		})
		if err != nil {
			die(1, "%v", err)
		}
		fmt.Printf("joined the backups at the %s place: %s, repository %s — issue a new recovery kit\n", from,
			d.Display(), d.RepositoryID)
		return
	default:
		die(64, "destination set|adopt")
	}
	d, err := dest.Configure(ctx, cfg, req)
	if err != nil {
		die(1, "%v", err)
	}
	fmt.Printf("destination %s: repository %s, append-only %s, kit generation %d — issue a new recovery kit\n",
		d.Display(), d.RepositoryID, d.AppendOnly, d.Generation)
	if d.HostKeyFingerprint != "" {
		fmt.Printf("pinned host key %s — compare it with the server's (ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub on the server)\n", d.HostKeyFingerprint)
	}
}

func diskSystem(cfg *state.Config) disk.System {
	or := func(v, def string) string {
		if v == "" {
			return def
		}
		return v
	}
	return disk.System{Sys: "/sys", Dev: "/dev", Mountinfo: "/proc/self/mountinfo", Blkid: or(cfg.Blkid, "blkid"),
		Mkfs: or(cfg.MkfsExt4, "mkfs.ext4"), Udevadm: cfg.Udevadm, SystemdMount: or(cfg.SystemdMount, "systemd-mount")}
}

// cmdDiskInit is the root helper behind the owner's disk destination (BK-20, BK-27): it pins and mounts the
// backup disk (formatting the one empty disk when the owner allowed it) and answers the service.
func cmdDiskInit(ctx context.Context, cfg *state.Config) {
	dir := dest.InitDir(cfg)
	b, err := state.ReadStateFile(filepath.Join(dir, "request.json"))
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		die(1, "%v", err)
	}
	_ = state.RemoveStateFile(filepath.Join(dir, "request.json"))
	var req dest.InitRequest
	if err := json.Unmarshal(b, &req); err != nil || req.Nonce == "" {
		die(1, "disk-init: malformed request")
	}
	res := dest.InitResult{Nonce: req.Nonce}
	dev, err := diskSystem(cfg).Adopt(ctx, cfg.DiskPinPath(), cfg.DiskMount, req.Init, cfg.BackupUID, backupGID(cfg))
	res.Device = dev
	if err != nil {
		res.Message = state.ASCII(err.Error(), 500)
		logf("disk-init: %v", err)
	} else {
		res.OK = true
		logf("disk-init: %s pinned and mounted at %s", dev, cfg.DiskMount)
	}
	res.At = time.Now().UTC()
	if err := state.WriteJSON(filepath.Join(dir, "result.json"), res, 0o644); err != nil {
		die(1, "%v", err)
	}
}

func manifestKey(cfg *state.Config) ed25519.PublicKey {
	k, err := manifest.LoadOrCreateKey(cfg.ManifestKeyPath())
	if err != nil {
		die(1, "%v", err)
	}
	return k.Public().(ed25519.PublicKey)
}

func mustDest(cfg *state.Config) *state.Destination {
	d, err := state.LoadDestination(cfg)
	if err != nil {
		die(1, "%v", err)
	}
	if d == nil {
		die(2, "no destination configured: this appliance is unprotected")
	}
	return d
}

func cmdSnapshots(ctx context.Context, cfg *state.Config, args []string) {
	fs := flag.NewFlagSet("snapshots", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "JSON")
	_ = fs.Parse(args)
	cps, chain, err := restore.ListCached(ctx, cfg.Repo(mustDest(cfg)), manifestKey(cfg), time.Now(), listing.ManifestCache(cfg))
	if err != nil {
		die(1, "%v", err)
	}
	if *asJSON {
		type row struct {
			ID, Snapshot string
			Seq          int64
			CreatedAt    time.Time
			Method       string
		}
		var rows []row
		for _, c := range cps {
			rows = append(rows, row{c.Manifest.ID, c.Snapshot.ID, c.Manifest.Seq, c.Manifest.CreatedAt, c.Manifest.Quiesce.Method})
		}
		printJSON(map[string]any{"checkpoints": rows, "chain": chain})
		return
	}
	for _, c := range cps {
		fmt.Printf("%4d  %s  %s  %s  %s\n", c.Manifest.Seq, c.Snapshot.ShortID, c.Manifest.CreatedAt.Format(time.RFC3339), c.Manifest.ID, c.Manifest.Quiesce.Method)
	}
	if len(chain.Unauthentic) > 0 {
		fmt.Printf("UNAUTHENTIC snapshots (ignored): %v\n", chain.Unauthentic)
	}
	if len(chain.Gaps) > 0 {
		fmt.Printf("chain gaps: %v\n", chain.Gaps)
	}
	if len(chain.ForeignTagged) > 0 {
		fmt.Printf("snapshots that aren't checkpoints: %v\n", chain.ForeignTagged)
	}
}

func cmdDrill(ctx context.Context, cfg *state.Config, args []string) {
	fs := flag.NewFlagSet("drill", flag.ExitOnError)
	snapID := fs.String("snapshot", "latest", "snapshot or checkpoint id")
	checkData := fs.String("check-data", "", "restic check --read-data level: \"\", all, 10%, 1/5")
	server := fs.String("server-admin-dsn", "", "restore into a new database on this server instead of a private cluster")
	prefix := fs.String("db-prefix", "whombat_quarantine_", "quarantine database name prefix (with -server-admin-dsn)")
	audit := fs.String("audit-verify", "", "the runtime's audit verifier command (gets DATABASE_URL)")
	keep := fs.Bool("keep", false, "keep the quarantine")
	asJSON := fs.Bool("json", false, "JSON report")
	ifDue := fs.Bool("if-due", false, "a requested check first; else only when the weekly check is due (the timer)")
	_ = fs.Parse(args)
	o := drill.Options{Snapshot: *snapID, CheckData: *checkData, ServerAdminDSN: *server, DBPrefix: *prefix, Keep: *keep, Log: logf,
		Record: func(id string, at time.Time, ok bool) { _ = listing.RecordCheck(cfg, id, at, ok) }}
	if *ifDue {
		var req *drill.Request
		if drill.Pending(cfg) {
			// The request is taken only once this check holds the run lock: a backup running now delays it, never
			// drops it.
			lock, err := drill.WaitLock(ctx, cfg, 5*time.Second)
			if err != nil {
				die(1, "drill: waiting for the running backup: %v", err)
			}
			defer lock.Unlock() // die exits without it; the lock goes with the process
			o.Locked = true
			if req, err = drill.Take(cfg); err != nil {
				die(1, "drill: %v", err)
			}
		}
		if req != nil {
			o.Snapshot = req.CheckpointID
			if !req.Own {
				// An earlier Whombat's backup: checked with the key that signed it (the adopted Whombat's, or one before
				// it the kit carried).
				if keys, err := listing.LoadKeys(cfg); err == nil && keys.Adopted != nil {
					o.ManifestKey = keys.Adopted
					if d, err := state.LoadDestination(cfg); err == nil && d != nil {
						if signer, _, err := listing.Signer(ctx, cfg, cfg.Repo(d), keys, req.CheckpointID); err == nil && !signer.Equal(keys.Own) {
							o.ManifestKey = signer
						}
					}
				}
			}
			logf("the person asked to check %s", req.CheckpointID)
		} else if !drillDue(cfg, time.Now()) {
			logf("no check due")
			return
		}
	}
	if *audit != "" {
		o.AuditVerify = strings.Fields(*audit)
	}
	rep, err := drill.Run(ctx, cfg, o)
	if rep != nil && *asJSON {
		printJSON(rep)
	}
	if errors.Is(err, state.ErrBusy) {
		die(3, "drill: %v; the next hour's timer tries again", err)
	}
	if err != nil {
		die(1, "drill: %v", err)
	}
	if !rep.OK {
		die(1, "drill failed: %v", rep.Failed())
	}
	if !*asJSON {
		fmt.Printf("drill ok: checkpoint %s, RTO %.1fs, backup age %.0fs, skipped %v\n", rep.CheckpointID, rep.RTOSeconds, rep.BackupAgeSeconds, rep.Skipped())
	}
}

func listener(socket string) (net.Listener, error) {
	if os.Getenv("LISTEN_FDS") == "1" && os.Getenv("LISTEN_PID") == fmt.Sprint(os.Getpid()) {
		f := os.NewFile(3, "socket")
		return net.FileListener(f)
	}
	_ = os.Remove(socket)
	l, err := net.Listen("unix", socket)
	if err == nil {
		_ = os.Chmod(socket, 0o660)
	}
	return l, err
}

func cmdServe(ctx context.Context, cfg *state.Config, args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	socket := fs.String("socket", cfg.APISocket, "unix socket (ignored under socket activation)")
	_ = fs.Parse(args)
	l, err := listener(*socket)
	if err != nil {
		die(1, "%v", err)
	}
	runner := newRunner(cfg)
	srv := &api.Server{Cfg: cfg, RuntimeUID: cfg.RuntimeUID, ManagerUID: cfg.ManagerUID,
		Checkpoint: func(ctx context.Context, opts checkpoint.Options) (*checkpoint.Result, error) {
			return runner.Run(ctx, opts)
		}, Peeks: &peek.Manager{Cfg: cfg, Log: logf}}
	srv.Peeks.Sweep(ctx) // a peek this process didn't open is closed if it should be, a ready one gets its timer
	go func() { <-ctx.Done(); _ = srv.Close() }()
	if _, err := state.UpdateStatus(cfg, nil); err != nil {
		logf("status: %v", err)
	}
	if err := srv.Serve(l); err != nil && ctx.Err() == nil {
		die(1, "%v", err)
	}
}

func cmdQuarantine(ctx context.Context, cfg *state.Config, args []string) {
	if len(args) == 0 {
		die(64, "quarantine prepare|apply|status|resolve|release|undo")
	}
	fs := flag.NewFlagSet("quarantine", flag.ExitOnError)
	snapID := fs.String("snapshot", "latest", "checkpoint")
	dsn := fs.String("dsn", "", "the appliance's empty database")
	adminDSN := fs.String("admin-dsn", "", "maintenance database (read-only switch; prepare: set aside and create)")
	db := fs.String("db", "whombat", "database name (prepare, release)")
	dbOwner := fs.String("db-owner", "whombat", "role owning the database (prepare) and what is restored into it (apply)")
	kitFile := fs.String("kit", "", "recovery kit: the manifest key and newest checkpoint it knows (default: those recorded by destination adopt)")
	note := fs.String("note", "", "note (resolve)")
	checkData := fs.String("check-data", "10%", "restic check --read-data level")
	_ = fs.Parse(args[1:])
	switch args[0] {
	case "prepare":
		if *adminDSN == "" {
			die(64, "-admin-dsn required")
		}
		aside, err := quarantine.Prepare(ctx, cfg, &pgtool.Admin{DSN: *adminDSN}, *db, *dbOwner, logf)
		if err != nil {
			die(1, "%v", err)
		}
		fmt.Printf("ready for quarantine apply; the fresh install's files are in %s\n", aside)
	case "apply":
		d := mustDest(cfg)
		if state.InRootMode() && d.Kind == state.KindLocal {
			// restic would work as root in a directory the backup user chose (BK-26).
			die(1, "a local-path repository isn't restored as root: copy it and use whombat-recovery, or set the real destination with destination adopt")
		}
		key, head, adopted := trustedKey(cfg, *kitFile)
		m, rep, err := quarantine.Apply(ctx, cfg, quarantine.ApplyOptions{Repo: cfg.Repo(d), ManifestKey: key,
			Snapshot: *snapID, DSN: *dsn, Admin: &pgtool.Admin{DSN: *adminDSN}, DBRole: *dbOwner, ExpectHead: head,
			Bins: pgtool.Bins{Dir: cfg.PGBin}, Git: gitinv.Runner{Git: cfg.Git}, CheckData: *checkData, Adopted: adopted, Log: logf})
		if err != nil {
			if rep != nil {
				printJSON(rep)
			}
			die(1, "%v", err)
		}
		printJSON(m)
	case "status":
		m, err := quarantine.Load(cfg)
		if err != nil {
			die(1, "%v", err)
		}
		if m == nil {
			fmt.Println("not in quarantine")
			return
		}
		printJSON(m)
	case "resolve":
		rest := fs.Args()
		if len(rest) != 2 {
			die(64, "quarantine resolve [-note N] ITEM RESOLUTION")
		}
		if _, err := quarantine.Resolve(cfg, rest[0], rest[1], *note); err != nil {
			die(1, "%v", err)
		}
	case "undo":
		if *adminDSN == "" {
			*adminDSN = defaultAdminDSN
		}
		m, err := quarantine.Load(cfg)
		if err != nil {
			die(1, "%v", err)
		}
		j := quarantine.Pending(cfg, m)
		if j == nil {
			die(1, "nothing is set aside: there is no restore to undo")
		}
		if err := quarantine.Undo(ctx, cfg, &pgtool.Admin{DSN: *adminDSN}, j); err != nil {
			die(1, "%v", err)
		}
		fmt.Println("the restore is undone: this Whombat is back as it was; start the runtime (systemctl start whombat-runtime.target)")
	case "release":
		var admin *pgtool.Admin
		if *adminDSN != "" {
			admin = &pgtool.Admin{DSN: *adminDSN}
		}
		if err := quarantine.Release(ctx, cfg, admin, *db); err != nil {
			die(1, "%v", err)
		}
		fmt.Println("quarantine released")
	default:
		die(64, "quarantine prepare|apply|status|resolve|release|undo")
	}
}

// trustedKey is the manifest key whose checkpoints a restore trusts: the kit's when given, else the one
// recorded by `destination adopt`, else this appliance's own (restoring its own checkpoint). adopted: the key is an
// earlier Whombat's.
func trustedKey(cfg *state.Config, kitFile string) (ed25519.PublicKey, *restore.ExpectedHead, bool) {
	text := ""
	var head *restore.ExpectedHead
	if kitFile != "" {
		m, err := kit.Load(kitFile)
		if err != nil {
			die(1, "%v", err)
		}
		text = m.ManifestKey
		if m.Head != nil {
			head = &restore.ExpectedHead{Seq: m.Head.Seq, ManifestSHA256: m.Head.ManifestSHA256}
		}
	} else if b, err := state.ReadStateFile(cfg.AdoptedManifestKeyPath()); err == nil {
		text = strings.TrimSpace(string(b))
		head = quarantine.AdoptedHead(cfg)
	}
	if text == "" {
		if state.InRootMode() { // this appliance's own key, read without following anything and never created
			seed, err := state.ReadStateFile(cfg.ManifestKeyPath())
			if err != nil || len(seed) != ed25519.SeedSize {
				die(1, "no trusted manifest key: give the recovery kit with -kit")
			}
			return ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey), nil, false
		}
		return manifestKey(cfg), nil, false
	}
	k, err := manifest.ParseKey(text)
	if err != nil {
		die(1, "manifest key: %v", err)
	}
	return k, head, true
}
