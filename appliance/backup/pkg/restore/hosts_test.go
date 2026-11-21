package restore

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
)

// hubBackup is an archive shaped like `whombat-hosts backup`'s from before (gzipped).
func hubBackup(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	_, _ = gz.Write(hubTar(t, entries))
	_ = gz.Close()
	return b.Bytes()
}

// hubTar is the uncompressed archive `whombat-hosts backup` writes now.
func hubTar(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	for _, name := range []string{"manifest.json", "hub.db", "ca.crt", "ca.key"} {
		body, ok := entries[name]
		if !ok {
			continue
		}
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write([]byte(body))
	}
	_ = tw.Close()
	return b.Bytes()
}

func goodHub(t *testing.T) []byte {
	return hubBackup(t, map[string]string{"manifest.json": `{"format":1,"hub_version":"0.9.0","schema":12}`,
		"hub.db": "SQLite format 3\x00…", "ca.crt": "cert", "ca.key": "key"})
}

func TestCheckHostsBackup(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, b []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	good := goodHub(t)
	got, err := CheckHostsBackup(write("good.tar.gz", good))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(good)
	if got.SHA256 != hex.EncodeToString(sum[:]) || got.Size != int64(len(good)) || got.Schema != 12 || got.HubVersion != "0.9.0" {
		t.Fatalf("read %+v", got)
	}
	entries := map[string]string{"manifest.json": `{"format":1,"hub_version":"0.10.0","schema":13}`, "hub.db": "SQLite format 3\x00…"}
	plain := hubTar(t, entries)
	if got, err := CheckHostsBackup(write("hub.tar", plain)); err != nil || got.Size != int64(len(plain)) || got.Schema != 13 {
		t.Fatalf("an uncompressed archive: %+v %v", got, err)
	}
	for name, b := range map[string][]byte{
		"tar truncated": plain[:700],
		"tar no db":     hubTar(t, map[string]string{"manifest.json": `{}`}),
		"truncated":     good[:len(good)-6],
		"not gzip":      []byte("hub.db"),
		"empty":         nil,
		"no database":   hubBackup(t, map[string]string{"manifest.json": `{}`}),
		"no manifest":   hubBackup(t, map[string]string{"hub.db": "x"}),
		"bad manifest":  hubBackup(t, map[string]string{"manifest.json": "{", "hub.db": "x"}),
	} {
		if _, err := CheckHostsBackup(write(strings.ReplaceAll(name, " ", "-"), b)); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
	// Never through a symlink.
	link := filepath.Join(dir, "link.tar.gz")
	if err := os.Symlink(filepath.Join(dir, "good.tar.gz"), link); err != nil {
		t.Fatal(err)
	}
	if _, err := CheckHostsBackup(link); err == nil {
		t.Fatal("followed a symlink")
	}
}

// The `hosts` check binds the restored archive to the signed manifest's hash and size.
func TestVerifyHosts(t *testing.T) {
	root := t.TempDir()
	good := goodHub(t)
	p := filepath.Join(root, filepath.FromSlash(manifest.HostsBackupPath))
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, good, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(good)
	m := &manifest.Manifest{Hosts: &manifest.Hosts{Backup: manifest.File{Path: manifest.HostsBackupPath,
		SHA256: hex.EncodeToString(sum[:]), Size: int64(len(good))}}}
	if _, err := verifyHosts(root, m); err != nil {
		t.Fatal(err)
	}
	other := hubBackup(t, map[string]string{"manifest.json": `{}`, "hub.db": "another hub"})
	if err := os.WriteFile(p, other, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyHosts(root, m); err == nil {
		t.Fatal("another archive than the manifest's passed")
	}
}
