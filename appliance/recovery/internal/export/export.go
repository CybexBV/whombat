// Package export writes a verified checkpoint (or an appliance disk) out in open formats (BK-14): a
// PostgreSQL dump in custom format and as plain SQL, the files as they were, every repository's working
// tree and a git bundle of it, the signed manifest, the verification report and a readable README.
package export

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/pkg/coverage"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

// Options for an export from a backup repository.
type Options struct {
	Restore        restore.Options // Repo, Snapshot, ManifestKey, CheckData, Bins, Git; Root/DSN are set here
	Out            string
	IncludeSecrets bool // provider credential homes and the master key
	Log            func(format string, a ...any)
}

// Result of an export.
type Result struct {
	Report  *restore.Report
	Out     string
	Bundles []string
}

func (o Options) logf(format string, a ...any) {
	if o.Log != nil {
		o.Log(format, a...)
	}
}

// FromRepository verifies and exports one checkpoint.
func FromRepository(ctx context.Context, o Options) (*Result, error) {
	if ents, err := os.ReadDir(o.Out); err == nil && len(ents) > 0 {
		return nil, fmt.Errorf("output directory %s is not empty", o.Out)
	}
	if err := os.MkdirAll(o.Out, 0o700); err != nil {
		return nil, err
	}
	work := filepath.Join(o.Out, ".restore")
	ro := o.Restore
	ro.Root, ro.DSN, ro.Admin, ro.Log = work, "", nil, o.Log
	rep, err := restore.Run(ctx, ro)
	if err != nil {
		return &Result{Report: rep}, err
	}
	if hard := rep.Failed(); len(hard) > 0 {
		writeJSON(filepath.Join(o.Out, "verification.json"), rep)
		return &Result{Report: rep}, fmt.Errorf("verification failed (%s): export stopped; the report is in verification.json", strings.Join(hard, ", "))
	}
	m := rep.Manifest
	res := &Result{Report: rep, Out: o.Out}
	if err := layout(ctx, o, work, m, res); err != nil {
		return res, err
	}
	writeJSON(filepath.Join(o.Out, "verification.json"), rep)
	if err := os.RemoveAll(work); err != nil {
		return res, err
	}
	return res, writeReadme(o, m, rep, res)
}

// confined returns out/rel after checking that rel is a clean relative path and that no existing
// component below out is a symlink or a non-directory: whatever a manifest or a restored tree contains,
// the export writes only inside out (MA-21f, M-4).
func confined(out, rel string) (string, error) {
	rel = filepath.ToSlash(rel)
	if !manifest.ValidRelPath(rel) {
		return "", fmt.Errorf("%w: %q", manifest.ErrBadPath, rel)
	}
	full := filepath.Join(out, filepath.FromSlash(rel))
	if r, err := filepath.Rel(out, full); err != nil || r == ".." || strings.HasPrefix(r, "../") {
		return "", fmt.Errorf("%w: %q", manifest.ErrBadPath, rel)
	}
	cur := out
	segs := strings.Split(rel, "/")
	for i, seg := range segs {
		cur = filepath.Join(cur, seg)
		fi, err := os.Lstat(cur)
		if errors.Is(err, os.ErrNotExist) {
			break
		}
		if err != nil {
			return "", err
		}
		if fi.Mode()&os.ModeSymlink != 0 || (i < len(segs)-1 && !fi.IsDir()) {
			return "", fmt.Errorf("%w: %s is a symlink or not a directory", manifest.ErrBadPath, cur)
		}
	}
	return full, nil
}

func layout(ctx context.Context, o Options, work string, m *manifest.Manifest, res *Result) error {
	if err := m.ValidatePaths(); err != nil {
		return err
	}
	var mkErr error
	mk := func(p string) string {
		full, err := confined(o.Out, p)
		if err != nil {
			if mkErr == nil {
				mkErr = err
			}
			return filepath.Join(o.Out, ".refused")
		}
		_ = os.MkdirAll(filepath.Dir(full), 0o700)
		return full
	}
	// Manifest and signature.
	for src, dst := range map[string]string{manifest.ManifestPath: "manifest.json", manifest.SigPath: "manifest.sig"} {
		if err := os.Rename(filepath.Join(work, filepath.FromSlash(src)), mk(dst)); err != nil {
			return err
		}
	}
	// Database: custom format as restored, and plain SQL.
	dump := mk("database/whombat.pgdump")
	if mkErr != nil {
		return mkErr
	}
	if err := os.Rename(filepath.Join(work, filepath.FromSlash(manifest.DumpPath)), dump); err != nil {
		return err
	}
	o.logf("database: writing plain SQL")
	sqlOut := mk("database/whombat.sql")
	if mkErr != nil {
		return mkErr
	}
	if err := pgtool.ToSQL(ctx, o.Restore.Bins, dump, sqlOut); err != nil {
		return fmt.Errorf("plain SQL: %w", err)
	}
	// Git bundles, from the restored (relocated) repositories, before the trees move.
	ceiling := filepath.Join(work, manifest.FilesDir)
	for _, r := range m.Repos {
		if r.Kind == "worktree" {
			continue // its branch is in its repository's bundle
		}
		name := strings.TrimPrefix(r.Path, manifest.FilesDir+"/")
		out := mk("git-bundles/" + strings.TrimSuffix(name, ".git") + ".bundle")
		if mkErr != nil {
			return mkErr
		}
		ok, err := o.Restore.Git.Bundle(ctx, gitinv.Found{Dir: filepath.Join(work, filepath.FromSlash(r.Path)), Kind: r.Kind}, ceiling, out)
		if err != nil {
			return fmt.Errorf("bundle %s: %w", r.Path, err)
		}
		if ok {
			rel, _ := filepath.Rel(o.Out, out)
			res.Bundles = append(res.Bundles, rel)
		}
	}
	// Files: home (attachments), the Hermes homes, workspaces; credentials, secrets and the servers (hosts) only when
	// asked.
	for _, s := range m.Sources {
		src := filepath.Join(work, filepath.FromSlash(s.SnapshotPath))
		if _, err := os.Lstat(src); err != nil {
			continue
		}
		var dst string
		switch s.Name {
		case "workspaces":
			dst = "workspaces"
		case "credentials", "secrets":
			if !o.IncludeSecrets {
				continue
			}
			dst = "secrets/" + s.Name
		case "hosts":
			// The hosts service's backup holds the agents' CA key: whoever has it can pose as this hub to
			// every server's agent (BK-35).
			if !o.IncludeSecrets {
				continue
			}
			dst = "secrets/hosts"
		case "home":
			dst = "files/home"
		case "hermes":
			dst = "files/hermes"
		case "agent":
			// The agent's home (NX-465, NX-466): its own files and projects.
			dst = "files/agent"
		default:
			return fmt.Errorf("%w: source %q", manifest.ErrBadPath, s.Name)
		}
		target := mk(dst)
		if mkErr != nil {
			return mkErr
		}
		if err := os.Rename(src, target); err != nil {
			return err
		}
	}
	// Worktree/alternates metadata now points into .restore: point it at the export.
	maps := []gitinv.Mapping{{Old: filepath.Join(work, manifest.FilesDir, "workspaces"), New: filepath.Join(o.Out, "workspaces")},
		{Old: filepath.Join(work, manifest.FilesDir, "home"), New: filepath.Join(o.Out, "files", "home")}}
	_, _, err := gitinv.Relocate(o.Out, maps, o.Out)
	return err
}

func writeJSON(path string, v any) {
	b, _ := json.MarshalIndent(v, "", "  ")
	_ = os.WriteFile(path, append(b, '\n'), 0o600)
}

func writeReadme(o Options, m *manifest.Manifest, rep *restore.Report, res *Result) error {
	var b strings.Builder
	fmt.Fprintf(&b, "Whombat export\n==============\n\n")
	fmt.Fprintf(&b, "Appliance:        %s\n", m.ApplianceID)
	fmt.Fprintf(&b, "Checkpoint:       %s (seq %d), taken %s\n", m.ID, m.Seq, m.CreatedAt.Format(time.RFC3339))
	fmt.Fprintf(&b, "Consistency:      %s (writes paused %d ms)\n", m.Quiesce.Method, m.Quiesce.HeldMs)
	fmt.Fprintf(&b, "Schema version:   %d (%s), PostgreSQL %s\n", m.Database.SchemaVersion, m.Database.SchemaTag, m.Database.ServerVersion)
	fmt.Fprintf(&b, "Exported:         %s\n", time.Now().UTC().Format(time.RFC3339))
	fmt.Fprintf(&b, "Manifest sha256:  %s (signed by %s)\n\n", rep.ManifestSHA256, m.References.ManifestKey)
	b.WriteString("Verification (verification.json):\n")
	for _, c := range rep.Checks {
		st := "ok"
		if c.Skipped {
			st = "skipped"
		} else if !c.OK {
			st = "FAILED"
		}
		fmt.Fprintf(&b, "  %-14s %-8s %s\n", c.Name, st, c.Detail)
	}
	b.WriteString("\nContents\n--------\n")
	b.WriteString("  manifest.json, manifest.sig   the checkpoint manifest and its Ed25519 signature\n")
	b.WriteString("  database/whombat.pgdump       PostgreSQL custom-format dump (pg_restore -d <db> whombat.pgdump)\n")
	b.WriteString("  database/whombat.sql          the same as plain SQL (psql -f whombat.sql)\n")
	b.WriteString("  files/home/                   attachments (files/sha256/..) and other runtime files\n")
	b.WriteString("  files/hermes/                 the agent's Hermes home: memory, sessions in state.db and skills/\n")
	b.WriteString("  files/agent/                  the agent's home: its own files and projects\n")
	b.WriteString("  workspaces/                   every working tree as it was, with .git: unpushed commits,\n")
	b.WriteString("                                uncommitted changes and untracked files included\n")
	b.WriteString("  git-bundles/                  one git bundle per repository (git clone x.bundle)\n")
	if o.IncludeSecrets {
		b.WriteString("  secrets/credentials/          provider login homes (sign in again; tokens may have rotated)\n")
		b.WriteString("  secrets/secrets/              the master key that seals secrets inside the database. KEEP PRIVATE.\n")
	} else {
		b.WriteString("  (provider logins and the master key were left out; re-run with -include-secrets to include them)\n")
	}
	b.WriteString("\nTables (rows):\n")
	tables := append([]manifest.Table{}, m.Database.Tables...)
	sort.Slice(tables, func(i, j int) bool { return tables[i].Schema+tables[i].Name < tables[j].Schema+tables[j].Name })
	for _, t := range tables {
		fmt.Fprintf(&b, "  %s.%s: %d\n", t.Schema, t.Name, t.Rows)
	}
	b.WriteString("\nRepositories:\n")
	for _, r := range m.Repos {
		fmt.Fprintf(&b, "  %s [%s] head %s", strings.TrimPrefix(r.Path, "files/"), r.Kind, short(r.Head))
		if r.Branch != "" {
			fmt.Fprintf(&b, " on %s", r.Branch)
		}
		fmt.Fprintf(&b, ": %d unpushed, %d staged, %d modified, %d untracked\n", r.UnpushedCount, r.StagedCount, r.ModifiedCount, r.UntrackedCount)
	}
	b.WriteString("\nLeft out of every backup (see coverage): ")
	var out []string
	for _, c := range coverage.Classes(coverage.DefaultLayout()) {
		if !c.Covered {
			out = append(out, c.ID)
		}
	}
	b.WriteString(strings.Join(out, ", ") + ".\n")
	for _, s := range m.Sources {
		if len(s.Excluded) > 0 {
			fmt.Fprintf(&b, "Excluded as caches/transient in %s: %s\n", s.Name, strings.Join(s.Excluded, ", "))
		}
	}
	return os.WriteFile(filepath.Join(o.Out, "README.txt"), []byte(b.String()), 0o600)
}

func short(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}

// DiskOptions exports straight from an appliance's persistent volume (unlocked in the recovery environment
// with the customer's disk recovery passphrase) when no backup is usable.
type DiskOptions struct {
	Persist        string // mounted /persist (read-only is fine)
	Out            string
	Work           string // scratch space for a copy of the PostgreSQL data directory
	Bins           pgtool.Bins
	Git            gitinv.Runner
	IncludeSecrets bool
	Port           int
	// RunAs runs the private PostgreSQL as this user (required when the export runs as root, as in the
	// recovery environment: PostgreSQL refuses root). Work is handed to it.
	RunAs *syscall.Credential
	Log   func(format string, a ...any)
}

// privateConfig replaces the copied cluster's configuration: on the appliance postgresql.conf is a
// symlink into the Nix store (absent here) and authentication is peer-based for the appliance's users.
// The copy only listens on a private unix socket in Work, so local trust is all it needs.
func privateConfig(data string) error {
	for name, content := range map[string]string{
		"postgresql.conf":      "# whombat-recovery export: private copy, settings on the command line\n",
		"postgresql.auto.conf": "",
		"pg_hba.conf":          "local all all trust\n",
		"pg_ident.conf":        "",
	} {
		p := filepath.Join(data, name)
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			return err
		}
	}
	return nil
}

func chownTree(root string, uid, gid int) error {
	return filepath.WalkDir(root, func(p string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(p, uid, gid)
	})
}

// FromDisk copies the PostgreSQL data directory to Work, starts a private server on the copy (the original
// is never written), dumps it, and copies the file trees. No consistency across database and files is
// claimed beyond what the disk had at power-off.
func FromDisk(ctx context.Context, o DiskOptions) error {
	if ents, err := os.ReadDir(o.Out); err == nil && len(ents) > 0 {
		return fmt.Errorf("output directory %s is not empty", o.Out)
	}
	l := coverage.Layout{Persist: o.Persist}
	pgData := filepath.Join(o.Persist, "postgres", "17")
	if _, err := os.Stat(filepath.Join(pgData, "PG_VERSION")); err != nil {
		return fmt.Errorf("no PostgreSQL 17 data directory at %s: %w", pgData, err)
	}
	cl := &pgtool.Cluster{Bins: o.Bins, Dir: o.Work, Port: o.Port, User: "postgres", Cred: o.RunAs}
	if err := copyTree(pgData, filepath.Join(o.Work, "data")); err != nil {
		return fmt.Errorf("copy data directory: %w", err)
	}
	_ = os.Remove(filepath.Join(o.Work, "data", "postmaster.pid"))
	if err := privateConfig(filepath.Join(o.Work, "data")); err != nil {
		return fmt.Errorf("private configuration: %w", err)
	}
	_ = os.MkdirAll(filepath.Join(o.Work, "sock"), 0o700)
	if o.RunAs != nil {
		if err := chownTree(o.Work, int(o.RunAs.Uid), int(o.RunAs.Gid)); err != nil {
			return fmt.Errorf("hand the copy to the export user: %w", err)
		}
	}
	if err := cl.Start(ctx); err != nil {
		return err
	}
	defer cl.Stop()
	if err := os.MkdirAll(filepath.Join(o.Out, "database"), 0o700); err != nil {
		return err
	}
	dump := filepath.Join(o.Out, "database", "whombat.pgdump")
	snap, err := pgtool.Export(ctx, cl.DSN("whombat"))
	if err != nil {
		return err
	}
	_, _, err = pgtool.Dump(ctx, o.Bins, cl.DSN("whombat"), snap.ID, dump)
	snap.Close()
	if err != nil {
		return err
	}
	if err := pgtool.ToSQL(ctx, o.Bins, dump, filepath.Join(o.Out, "database", "whombat.sql")); err != nil {
		return err
	}
	for _, s := range l.Sources() {
		var dst string
		switch s.Name {
		case "workspaces":
			dst = "workspaces"
		case "credentials", "secrets":
			if !o.IncludeSecrets {
				continue
			}
			dst = filepath.Join("secrets", s.Name)
		default:
			dst = filepath.Join("files", s.Name)
		}
		if _, err := os.Lstat(s.Path); err != nil {
			continue
		}
		if err := copyTree(s.Path, filepath.Join(o.Out, dst)); err != nil {
			return err
		}
	}
	_, _, err = gitinv.Relocate(o.Out, []gitinv.Mapping{{Old: l.Workspaces(), New: filepath.Join(o.Out, "workspaces")},
		{Old: l.Home(), New: filepath.Join(o.Out, "files", "home")}}, o.Out)
	return err
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		out := filepath.Join(dst, rel)
		fi, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.IsDir():
			return os.MkdirAll(out, 0o700)
		case d.Type()&fs.ModeSymlink != 0:
			t, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(t, out)
		case d.Type().IsRegular():
			in, err := os.Open(p)
			if err != nil {
				return err
			}
			defer in.Close()
			f, err := os.OpenFile(out, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fi.Mode().Perm()|0o600)
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, in); err != nil {
				f.Close()
				return err
			}
			return f.Close()
		}
		return nil
	})
}
