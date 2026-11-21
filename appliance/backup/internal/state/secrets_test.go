package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A value the service wrote since the last seal wins; a sealed credential is used otherwise; the empty
// placeholder the seal unit leaves for a secret never set counts as absent (it used to be read as the
// repository password, so a destination could never be configured through the API).
func TestSecretResolution(t *testing.T) {
	c := &Config{Persist: t.TempDir()}
	c.Defaults()
	creds := t.TempDir()
	t.Setenv("CREDENTIALS_DIRECTORY", creds)
	if err := os.WriteFile(filepath.Join(creds, "restic-password"), nil, 0o600); err != nil { // placeholder
		t.Fatal(err)
	}
	if p := c.RepositoryPasswordPath(); p != "" {
		t.Fatalf("empty placeholder used as the password: %s", p)
	}
	if err := os.WriteFile(filepath.Join(creds, "restic-password"), []byte("sealed\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if v, _ := c.ReadSecret(SecretRepositoryPassword); v != "sealed" {
		t.Fatalf("sealed credential not used: %q", v)
	}
	if err := c.WriteSecret(SecretRepositoryPassword, "fresh"); err != nil {
		t.Fatal(err)
	}
	if v, _ := c.ReadSecret(SecretRepositoryPassword); v != "fresh" {
		t.Fatalf("a newly written value must win over the sealed one: %q", v)
	}
	fi, err := os.Stat(c.SecretWritePath(SecretRepositoryPassword))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("secret file mode %v %v", fi.Mode(), err)
	}
	if err := c.WriteSecret(SecretRepositoryPassword, ""); err != nil {
		t.Fatal(err)
	}
	if v, _ := c.ReadSecret(SecretRepositoryPassword); v != "" {
		t.Fatalf("a cleared value falls back to the sealed one: %q", v)
	}
	_ = os.Remove(c.SecretWritePath(SecretRepositoryPassword)) // the seal unit took the plain file
	if v, _ := c.ReadSecret(SecretRepositoryPassword); v != "sealed" {
		t.Fatalf("after the seal: %q", v)
	}
	// A plain value that is a symlink is never followed.
	_ = os.Symlink(filepath.Join(creds, "restic-password"), c.SecretWritePath(SecretRESTPassword))
	if p := c.SecretPath(SecretRESTPassword); p != "" {
		t.Fatalf("followed a symlinked secret: %s", p)
	}
	if v, _ := c.ReadSecret(SecretS3Key); v != "" {
		t.Fatalf("unset secret read as %q", v)
	}
}

// Destinations written before BK-18 keep working; the status never shows a credential.
func TestDestinationKindsAndDisplay(t *testing.T) {
	c := &Config{Persist: t.TempDir()}
	c.Defaults()
	if err := WriteJSON(c.DestinationPath(), map[string]any{"kind": "restic-rest", "repository": "rest:https://b.example/a/",
		"restUser": "appliance", "repositoryId": "abc", "generation": 1}, 0o600); err != nil {
		t.Fatal(err)
	}
	d, err := LoadDestination(c)
	if err != nil || d.Kind != KindREST {
		t.Fatalf("%+v %v", d, err)
	}
	for _, tc := range []struct {
		d    Destination
		want string
	}{
		{Destination{Kind: KindS3, Repository: "s3:https://s3.example.com/bucket/box", S3AccessKeyID: "AKID"}, "https://s3.example.com/bucket/box"},
		{Destination{Kind: KindSFTP, Repository: "sftp:nas.local:/volume1/whombat", SFTPUser: "whombat"}, "whombat@nas.local:/volume1/whombat"},
		{Destination{Kind: KindSFTP, Repository: "sftp://nas:2222//srv/r", SFTPUser: "u"}, "u@nas:2222:/srv/r"},
		{Destination{Kind: KindDisk, Repository: "disk:"}, "Local disk WHOMBAT-BACKUP"},
	} {
		if got := tc.d.Display(); got != tc.want {
			t.Fatalf("%s: %q, want %q", tc.d.Repository, got, tc.want)
		}
		s := &Status{}
		d := tc.d
		d.RepositoryID, d.AppendOnly = "abc", "not-enforced"
		Derive(c, s, &d, time.Now())
		if err := s.Validate(); err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(s)
		if s.Destination.Kind != d.Kind || strings.Contains(string(b), "AKID") {
			t.Fatalf("status %s", b)
		}
	}
	for repo, kind := range map[string]string{"rest:https://x/": KindREST, "s3:https://x/b": KindS3,
		"sftp:h:/p": KindSFTP, "disk:": KindDisk, "disk:/x": KindLocal, "/srv/restic": KindLocal} {
		if got := KindOf(repo); got != kind {
			t.Fatalf("%s: %s", repo, got)
		}
	}
}
