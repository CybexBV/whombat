package restore

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
)

// HostsBackup is what CheckHostsBackup read from the hosts service's backup.
type HostsBackup struct {
	SHA256 string
	Size   int64
	// From its manifest.json (whombat-hosts' BackupManifest): the hub's version and database schema.
	HubVersion string `json:"hub_version"`
	Schema     int    `json:"schema"`
}

// CheckHostsBackup reads the hosts service's backup (`whombat-hosts backup`'s tar archive, uncompressed or, from a
// hosts service from before, gzipped) to its end: a tar archive holding manifest.json (a JSON object) and hub.db as
// regular files, and a gzipped one a complete gzip stream (its checksum checked). It returns the file's sha256 and
// size. It never follows a symlink. Whether the hub accepts it (its schema, its CA) is the hub's decision when it
// applies it (BK-34).
func CheckHostsBackup(path string) (*HostsBackup, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", filepath.Base(path))
	}
	h := sha256.New()
	cr := &countReader{r: io.TeeReader(f, h)}
	br := bufio.NewReader(cr)
	var archive io.Reader = br
	var gz *gzip.Reader
	if magic, _ := br.Peek(2); len(magic) == 2 && magic[0] == 0x1f && magic[1] == 0x8b {
		if gz, err = gzip.NewReader(br); err != nil {
			return nil, fmt.Errorf("not a gzip file: %w", err)
		}
		archive = gz
	}
	out := &HostsBackup{}
	seen := map[string]bool{}
	tr := tar.NewReader(archive)
	for {
		hd, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("the archive is damaged or incomplete: %w", err)
		}
		if hd.Typeflag != tar.TypeReg {
			continue
		}
		switch hd.Name {
		case "manifest.json":
			b, err := io.ReadAll(io.LimitReader(tr, 1<<20))
			if err != nil {
				return nil, fmt.Errorf("the archive is damaged or incomplete: %w", err)
			}
			if err := json.Unmarshal(b, out); err != nil {
				return nil, fmt.Errorf("its manifest.json: %w", err)
			}
		case "hub.db":
			if hd.Size == 0 {
				return nil, errors.New("its hub.db is empty")
			}
		}
		seen[hd.Name] = true
		if _, err := io.Copy(io.Discard, tr); err != nil {
			return nil, fmt.Errorf("the archive is damaged or incomplete: %w", err)
		}
	}
	// The rest of the stream: the tar's end blocks and, gzipped, the trailer whose checksum gzip checks at EOF.
	if _, err := io.Copy(io.Discard, archive); err != nil {
		return nil, fmt.Errorf("the archive is damaged or incomplete: %w", err)
	}
	for _, n := range []string{"manifest.json", "hub.db"} {
		if !seen[n] {
			return nil, fmt.Errorf("the archive has no %s", n)
		}
	}
	if _, err := io.Copy(io.Discard, br); err != nil { // anything after the archive is hashed too
		return nil, err
	}
	out.SHA256, out.Size = hex.EncodeToString(h.Sum(nil)), cr.n
	return out, nil
}

type countReader struct {
	r io.Reader
	n int64
}

func (c *countReader) Read(b []byte) (int, error) {
	n, err := c.r.Read(b)
	c.n += int64(n)
	return n, err
}

// verifyHosts is the `hosts` check: the restored archive is the one the manifest names and reads to its end.
func verifyHosts(root string, m *manifest.Manifest) (string, error) {
	want := m.Hosts.Backup
	got, err := CheckHostsBackup(filepath.Join(root, filepath.FromSlash(want.Path))) // one of the two paths (ValidatePaths)
	if err != nil {
		return "", err
	}
	if got.SHA256 != want.SHA256 || got.Size != want.Size {
		return "", fmt.Errorf("sha256 %s size %d, manifest %s size %d", got.SHA256, got.Size, want.SHA256, want.Size)
	}
	return fmt.Sprintf("the hosts service's backup: %d bytes, hub %s, schema %d", got.Size, got.HubVersion, got.Schema), nil
}
