package kit

import (
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/sshkey"
)

func material() *Material {
	return &Material{Kind: MaterialKind, ApplianceID: "a", Generation: 1, CreatedAt: time.Unix(1, 0).UTC(),
		Repository: "rest:https://backup.example/a/", RESTUser: "a", RESTPassword: "p", RepositoryPassword: "pw",
		RepositoryID: "id", ManifestKey: "ed25519:x"}
}

func TestKitChecksum(t *testing.T) {
	k := &Kit{Kind: KitKind, ApplianceID: "a", Backup: material()}
	k.Seal()
	b, _ := json.Marshal(k)
	m, err := Parse(b)
	if err != nil || m.RepositoryPassword != "pw" {
		t.Fatalf("parse: %v", err)
	}
	bad := strings.Replace(string(b), `"pw"`, `"pX"`, 1)
	if _, err := Parse([]byte(bad)); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("mistyped kit: %v", err)
	}
	k2 := &Kit{Kind: KitKind, ApplianceID: "a"}
	k2.Seal()
	b2, _ := json.Marshal(k2)
	if _, err := Parse(b2); err == nil {
		t.Fatal("kit without backup section accepted")
	}
}

func TestMaterialValidation(t *testing.T) {
	m := material()
	b, _ := json.Marshal(m)
	if _, err := Parse(b); err != nil {
		t.Fatal(err)
	}
	m.RepositoryPassword = ""
	if err := m.Validate(); err == nil {
		t.Fatal("missing password accepted")
	}
	m = material()
	m.Repository = "rest:https://u:p@backup.example/a/"
	if err := m.Validate(); err == nil {
		t.Fatal("credentials in URL accepted")
	}
}

// The kit alone reaches S3 and SFTP repositories: everything it takes must be in it.
func TestMaterialCompletenessPerKind(t *testing.T) {
	m := material()
	m.Repository, m.RESTUser, m.RESTPassword = "s3:https://s3.example.com/b/box", "", ""
	if err := m.Validate(); err == nil {
		t.Fatal("S3 kit without its key accepted")
	}
	m.S3AccessKeyID, m.S3SecretAccessKey = "AKID", "secret"
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	priv, _ := sshkey.Generate()
	host, _ := sshkey.Generate()
	m = material()
	m.Repository, m.RESTUser, m.RESTPassword = "sftp://nas:2222//srv/box", "", ""
	m.SFTPUser = "whombat"
	if err := m.Validate(); err == nil {
		t.Fatal("SFTP kit without key and host key accepted")
	}
	m.SFTPPrivateKey = string(sshkey.MarshalPrivate(priv, "c"))
	m.SFTPHostKey = sshkey.Ed25519Public(host.Public().(ed25519.PublicKey)).String()
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	r, err := m.Repo(dir, "restic", "/usr/bin/ssh", "")
	if err != nil {
		t.Fatal(err)
	}
	if r.SFTP == nil || r.SFTP.Port != 2222 || r.SFTP.User != "whombat" || r.PasswordFile != filepath.Join(dir, "pw") {
		t.Fatalf("%+v %+v", r, r.SFTP)
	}
	for _, f := range []string{"pw", "sftp-key", "known_hosts"} {
		fi, err := os.Stat(filepath.Join(dir, f))
		if err != nil || fi.Mode().Perm() != 0o600 {
			t.Fatalf("%s: %v %v", f, fi, err)
		}
	}
	known, _ := os.ReadFile(filepath.Join(dir, "known_hosts"))
	if string(known) != "[nas]:2222 "+m.SFTPHostKey+"\n" {
		t.Fatalf("known_hosts %q", known)
	}
	// A disk kit needs the mounted disk.
	m = material()
	m.Repository, m.RESTUser, m.RESTPassword = "disk:", "", ""
	if _, err := m.Repo(t.TempDir(), "restic", "", ""); err == nil || !strings.Contains(err.Error(), "-repo-dir") {
		t.Fatalf("%v", err)
	}
	mnt := t.TempDir()
	_ = os.MkdirAll(filepath.Join(mnt, "whombat", "repository"), 0o700)
	_ = os.WriteFile(filepath.Join(mnt, "whombat", "repository", "config"), []byte("x"), 0o600)
	r, err = m.Repo(t.TempDir(), "restic", "", mnt)
	if err != nil || r.Repository != filepath.Join(mnt, "whombat", "repository") {
		t.Fatalf("%v %s", err, r.Repository)
	}
}

// A Whombat that was brought back carries the earlier Whombats it brought back (BK-79): their keys and cut-offs go
// through a kit and come back as they were; a material without them (older kits) reads as before; malformed ones are
// refused.
func TestMaterialCarriesAdopted(t *testing.T) {
	pub := func() string {
		p, _, _ := ed25519.GenerateKey(nil)
		return manifest.EncodeKey(p)
	}
	sha := strings.Repeat("ab", 32)
	ok := func() Adopted {
		return Adopted{ApplianceID: "wb-8jvn-4kxq-6235", ManifestKey: pub(),
			Until: Until{CheckpointID: "ck-20261104T1107", Seq: 2, ManifestSHA256: sha, Known: []string{sha, strings.Repeat("cd", 32)}}}
	}
	m := material()
	m.ManifestKey = pub()
	m.Adopted = []Adopted{ok()}
	k := &Kit{Kind: KitKind, ApplianceID: "a", Backup: m}
	k.Seal()
	b, _ := json.Marshal(k)
	got, err := Parse(b)
	if err != nil || len(got.Adopted) != 1 || got.Adopted[0].ManifestKey != m.Adopted[0].ManifestKey ||
		got.Adopted[0].Until.Seq != 2 || len(got.Adopted[0].Until.Known) != 2 || got.Adopted[0].ApplianceID != "wb-8jvn-4kxq-6235" {
		t.Fatalf("round trip: %v %+v", err, got)
	}
	// An older material: no adopted field at all.
	old, _ := json.Marshal(material())
	if strings.Contains(string(old), "adopted") {
		t.Fatalf("an empty list is written: %s", old)
	}
	if got, err := Parse(old); err != nil || got.Adopted != nil {
		t.Fatalf("older material: %v %+v", err, got)
	}
	for name, change := range map[string]func(*Material){
		"bad key":        func(m *Material) { m.Adopted[0].ManifestKey = "ed25519:x" },
		"its own key":    func(m *Material) { m.Adopted[0].ManifestKey = m.ManifestKey },
		"the same twice": func(m *Material) { m.Adopted = append(m.Adopted, m.Adopted[0]) },
		"bad sha":        func(m *Material) { m.Adopted[0].Until.ManifestSHA256 = "restored" },
		"bad known":      func(m *Material) { m.Adopted[0].Until.Known = []string{"later"} },
		"no checkpoint":  func(m *Material) { m.Adopted[0].Until.CheckpointID = "" },
		"seq too high":   func(m *Material) { m.Adopted[0].Until.Seq = 1 << 53 },
		"bad appliance":  func(m *Material) { m.Adopted[0].ApplianceID = "wb 906x" },
		"too many known": func(m *Material) {
			m.Adopted[0].Until.Known = make([]string, MaxKnown+1)
			for i := range m.Adopted[0].Until.Known {
				m.Adopted[0].Until.Known[i] = sha
			}
		},
		"too many Whombats": func(m *Material) {
			for len(m.Adopted) <= MaxAdopted {
				m.Adopted = append(m.Adopted, ok())
			}
		},
	} {
		m := material()
		m.ManifestKey = pub()
		m.Adopted = []Adopted{ok()}
		change(m)
		if err := m.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
