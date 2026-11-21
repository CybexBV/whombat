// Command whombat-recovery is the customer's recovery and export tool (docs/runbooks/recovery-export.md). It
// works without Whombat cloud and without the appliance: the recovery kit authorizes it (repository location,
// append-only read credential, repository password, manifest key). It is a restricted command-line tool, not a
// hosted UI: it can list, verify and export — never write to a backup repository.
//
//	whombat-recovery list   -kit KIT [-repo-dir DIR]
//	whombat-recovery verify -kit KIT [-repo-dir DIR] [-snapshot latest] [-check-data 10%]
//	whombat-recovery export -kit KIT [-repo-dir DIR] [-snapshot latest] -out DIR [-include-secrets] [-check-data 10%]
//	whombat-recovery export-disk -persist /mnt/persist -out DIR [-include-secrets] [-pg-user USER]
//
// -repo-dir opens a copy of the repository on a local disk (e.g. the storage provider's export, a USB disk,
// the mounted backup disk) instead of the kit's address. The kit reaches rest:, s3: and sftp: repositories
// by itself (its credentials, the SFTP key and the pinned host key); a disk: kit needs -repo-dir.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
	"github.com/CybexBV/whombat/appliance/recovery/internal/export"
)

func die(code int, format string, a ...any) {
	fmt.Fprintf(os.Stderr, "whombat-recovery: "+format+"\n", a...)
	os.Exit(code)
}

func logf(format string, a ...any) { fmt.Fprintf(os.Stderr, format+"\n", a...) }

type common struct {
	kit, repoDir, snapshot, checkData, restic, ssh, pgBin, git, work string
}

func (c *common) flags(fs *flag.FlagSet) {
	fs.StringVar(&c.kit, "kit", "", "recovery kit file (whole kit or its backup section)")
	fs.StringVar(&c.repoDir, "repo-dir", "", "open a local copy of the repository instead of the kit's URL")
	fs.StringVar(&c.snapshot, "snapshot", "latest", "checkpoint id or snapshot id")
	fs.StringVar(&c.checkData, "check-data", "", `restic check --read-data level: "" (structure), all, 10%, 1/5`)
	fs.StringVar(&c.restic, "restic", "", "restic binary (default: PATH)")
	fs.StringVar(&c.ssh, "ssh", "", "ssh binary for SFTP destinations (default: PATH)")
	fs.StringVar(&c.pgBin, "pg-bin", "", "directory with pg_restore (default: PATH)")
	fs.StringVar(&c.git, "git", "", "git binary (default: PATH)")
	fs.StringVar(&c.work, "work", "", "scratch directory (default: a temporary one)")
}

// open builds the repository from the kit. The password goes to a private temporary file, never argv.
func (c *common) open() (restic.Repo, *kit.Material, func()) {
	if c.kit == "" {
		die(64, "-kit is required")
	}
	m, err := kit.Load(c.kit)
	if err != nil {
		die(1, "%v", err)
	}
	dir, err := os.MkdirTemp("", "whombat-recovery-")
	if err != nil {
		die(1, "%v", err)
	}
	r, err := m.Repo(dir, c.restic, c.ssh, c.repoDir)
	if err != nil {
		_ = os.RemoveAll(dir)
		die(1, "%v", err)
	}
	return r, m, func() { _ = os.RemoveAll(dir) }
}

func key(m *kit.Material) []byte {
	k, err := manifest.ParseKey(m.ManifestKey)
	if err != nil {
		die(1, "kit: %v", err)
	}
	return k
}

func main() {
	if len(os.Args) < 2 {
		die(64, "usage: whombat-recovery list|verify|export|export-disk [flags]")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	var c common
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	c.flags(fs)
	out := fs.String("out", "", "output directory (export)")
	secrets := fs.Bool("include-secrets", false, "also export provider login homes, the master key and the servers' hub backup (its agents' CA key)")
	persist := fs.String("persist", "", "mounted appliance /persist (export-disk)")
	pgUser := fs.String("pg-user", "", "run the private PostgreSQL as this user (export-disk as root)")
	ignoreHead := fs.Bool("ignore-kit-head", false, "do not require the newest checkpoint recorded in the kit (export what the destination has)")
	asJSON := fs.Bool("json", false, "JSON output")
	_ = fs.Parse(os.Args[2:])

	switch os.Args[1] {
	case "list":
		repo, m, done := c.open()
		defer done()
		cps, chain, err := restore.List(ctx, repo, key(m), time.Now())
		if err != nil {
			die(1, "%v", err)
		}
		if *asJSON {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"checkpoints": len(cps), "chain": chain})
			return
		}
		for _, cp := range cps {
			fmt.Printf("%4d  %s  %s  %s\n", cp.Manifest.Seq, cp.Snapshot.ShortID, cp.Manifest.CreatedAt.Format(time.RFC3339), cp.Manifest.ID)
		}
		if len(chain.Unauthentic) > 0 {
			fmt.Printf("NOT AUTHENTIC (ignored): %v\n", chain.Unauthentic)
		}
		if len(chain.Gaps) > 0 {
			fmt.Printf("chain gaps: %v\n", chain.Gaps)
		}
	case "verify", "export":
		repo, m, done := c.open()
		defer done()
		work := c.work
		if work == "" {
			d, err := os.MkdirTemp("", "whombat-recovery-work-")
			if err != nil {
				die(1, "%v", err)
			}
			work = d
			defer os.RemoveAll(d)
		}
		ro := restore.Options{Repo: repo, Snapshot: c.snapshot, ManifestKey: key(m), CheckData: c.checkData,
			Bins: pgtool.Bins{Dir: c.pgBin}, Git: gitinv.Runner{Git: c.git}, Log: logf}
		if m.Head != nil && !*ignoreHead {
			// Detects a destination that withholds newer checkpoints (I-2).
			ro.ExpectHead = &restore.ExpectedHead{Seq: m.Head.Seq, ManifestSHA256: m.Head.ManifestSHA256}
		}
		if os.Args[1] == "verify" {
			ro.Root = filepath.Join(work, "root")
			rep, err := restore.Run(ctx, ro)
			report(rep, *asJSON)
			if err != nil || !rep.OK {
				die(1, "verification failed: %v %v", err, failed(rep))
			}
			return
		}
		if *out == "" {
			die(64, "-out is required")
		}
		res, err := export.FromRepository(ctx, export.Options{Restore: ro, Out: *out, IncludeSecrets: *secrets, Log: logf})
		if err != nil {
			die(1, "%v", err)
		}
		fmt.Printf("exported checkpoint %s to %s (%d git bundles); read %s\n", res.Report.CheckpointID, res.Out, len(res.Bundles),
			filepath.Join(res.Out, "README.txt"))
	case "export-disk":
		if *persist == "" || *out == "" {
			die(64, "-persist and -out are required")
		}
		work := c.work
		if work == "" {
			d, err := os.MkdirTemp("", "whombat-recovery-pg-")
			if err != nil {
				die(1, "%v", err)
			}
			work = d
			defer os.RemoveAll(d)
		}
		l, _ := net.Listen("tcp", "127.0.0.1:0")
		port := l.Addr().(*net.TCPAddr).Port
		l.Close()
		var runAs *syscall.Credential
		if *pgUser != "" {
			u, err := user.Lookup(*pgUser)
			if err != nil {
				die(1, "-pg-user: %v", err)
			}
			uid, _ := strconv.ParseUint(u.Uid, 10, 32)
			gid, _ := strconv.ParseUint(u.Gid, 10, 32)
			runAs = &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}
		} else if os.Geteuid() == 0 {
			die(64, "export-disk as root needs -pg-user (PostgreSQL does not run as root)")
		}
		if err := export.FromDisk(ctx, export.DiskOptions{Persist: *persist, Out: *out, Work: work, Bins: pgtool.Bins{Dir: c.pgBin},
			Git: gitinv.Runner{Git: c.git}, IncludeSecrets: *secrets, Port: port, RunAs: runAs, Log: logf}); err != nil {
			die(1, "%v", err)
		}
		fmt.Printf("exported the appliance disk to %s\n", *out)
	default:
		die(64, "unknown command %q", os.Args[1])
	}
}

func failed(rep *restore.Report) []string {
	if rep == nil {
		return nil
	}
	return rep.Failed()
}

func report(rep *restore.Report, asJSON bool) {
	if rep == nil {
		return
	}
	if asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(rep)
		return
	}
	fmt.Printf("checkpoint %s: ok=%v, restore+verify %.1fs, backup age %.0fs\n", rep.CheckpointID, rep.OK, rep.RTOSeconds, rep.BackupAgeSeconds)
}
