package restic

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A copy from the main place (REST, with its user) to a bucket: each place's credentials reach restic only through its
// environment, the source is named with --from-repo/--from-password-file, and only the named snapshots are copied.
func TestCopyCarriesBothPlaces(t *testing.T) {
	bin, argvFile, envFile := fakeRestic(t, "", 0)
	src := Repo{Binary: bin, Repository: "rest:https://nas.example.com/box/", PasswordFile: "/pw",
		RESTUser: "box", RESTPassword: "rest-secret-value-xyz"}
	dst := Repo{Binary: bin, Repository: "s3:https://s3.example.com/bucket/box", PasswordFile: "/pw",
		S3AccessKeyID: "AKIDEXAMPLE", S3SecretAccessKey: "s3-secret-value-xyz", S3Region: "eu-central-1"}
	p, done, err := dst.Paired(src, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer done()
	if err := p.CopyFrom(context.Background(), "aaaa1111", "bbbb2222"); err != nil {
		t.Fatal(err)
	}
	argv, env := read(t, argvFile), read(t, envFile)
	for _, want := range []string{"copy\n--from-repo\nrest:https://nas.example.com/box/\n--from-password-file\n/pw\n",
		"aaaa1111\nbbbb2222\n"} {
		if !strings.Contains(argv, want) {
			t.Fatalf("argv lacks %q:\n%s", want, argv)
		}
	}
	for _, secret := range []string{"rest-secret-value-xyz", "s3-secret-value-xyz", "AKIDEXAMPLE"} {
		if strings.Contains(argv, secret) {
			t.Fatalf("%s on the command line", secret)
		}
	}
	for _, want := range []string{"RESTIC_REPOSITORY=s3:https://s3.example.com/bucket/box", "AWS_ACCESS_KEY_ID=AKIDEXAMPLE",
		"RESTIC_REST_USERNAME=box", "RESTIC_REST_PASSWORD=rest-secret-value-xyz"} {
		if !strings.Contains(env, want) {
			t.Fatalf("env lacks %s", want)
		}
	}
}

// The source's ssh command is the one -o sftp.command restic has (the target is a bucket).
func TestCopyFromSFTP(t *testing.T) {
	bin, argvFile, _ := fakeRestic(t, "", 0)
	src := Repo{Binary: bin, Repository: "sftp:nas.local:/backups/box", PasswordFile: "/pw",
		SFTP: &SFTP{SSH: "/nix/store/x-openssh/bin/ssh", Host: "nas.local", Port: 22, User: "whombat",
			KeyFile: "/run/credentials/k", KnownHostsFile: "/persist/backup/known_hosts", HostKeyAlgorithms: "ssh-ed25519"}}
	dst := Repo{Binary: bin, Repository: "/srv/copy", PasswordFile: "/pw"}
	p, done, err := dst.Paired(src, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer done()
	if err := p.CopyFrom(context.Background(), "aaaa1111"); err != nil {
		t.Fatal(err)
	}
	argv := read(t, argvFile)
	if !strings.Contains(argv, "sftp.command=/nix/store/x-openssh/bin/ssh -F none") {
		t.Fatalf("argv: %s", argv)
	}
}

// Two places that need different credentials of one kind can't be one copy: restic shares them.
func TestCopyRefusesTwoCredentialsOfOneKind(t *testing.T) {
	s3 := func(id, secret string) Repo {
		return Repo{Repository: "s3:https://s3.example.com/b/" + id, S3AccessKeyID: id, S3SecretAccessKey: secret}
	}
	sftp := Repo{Repository: "sftp:h:/p", SFTP: &SFTP{Host: "h"}}
	for name, c := range map[string]struct {
		src, dst Repo
		ok       bool
	}{
		"two keys":       {s3("A", "x"), s3("B", "y"), false},
		"the same key":   {s3("A", "x"), s3("A", "x"), true},
		"two sftp":       {sftp, sftp, false},
		"two rest users": {Repo{RESTUser: "a", RESTPassword: "p"}, Repo{RESTUser: "b", RESTPassword: "p"}, false},
		"rest to s3":     {Repo{RESTUser: "a", RESTPassword: "p"}, s3("A", "x"), true},
	} {
		_, done, err := c.dst.Paired(c.src, t.TempDir())
		done()
		if (err == nil) != c.ok || (err != nil && !errors.Is(err, ErrCopyCredentials)) {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

// A private CA of one place is added to the system's roots (--cacert replaces them for both), and goes when done.
func TestCopyJoinsCAs(t *testing.T) {
	dir := t.TempDir()
	sys, ca := filepath.Join(dir, "system.pem"), filepath.Join(dir, "nas-ca.pem")
	if err := os.WriteFile(sys, []byte("SYSTEM ROOTS\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ca, []byte("NAS CA\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SSL_CERT_FILE", sys)
	src := Repo{Repository: "rest:https://nas.example.com/box/", CACert: ca}
	p, done, err := Repo{Repository: "s3:https://s3.example.com/b/x"}.Paired(src, dir)
	if err != nil {
		t.Fatal(err)
	}
	bundle := read(t, p.CACert)
	if !strings.Contains(bundle, "SYSTEM ROOTS") || !strings.Contains(bundle, "NAS CA") {
		t.Fatalf("bundle: %q", bundle)
	}
	done()
	if _, err := os.Stat(p.CACert); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the bundle stayed: %v", err)
	}
}

// A failed copy's error never carries a credential of either place; a copy names at least one snapshot.
func TestCopyRedactsBothPlaces(t *testing.T) {
	bin, _, _ := fakeRestic(t, "Fatal: rest-secret-value-xyz s3-secret-value-xyz", 1)
	src := Repo{Binary: bin, Repository: "rest:https://nas.example.com/box/", PasswordFile: "/pw",
		RESTUser: "box", RESTPassword: "rest-secret-value-xyz"}
	dst := Repo{Binary: bin, Repository: "s3:https://s3.example.com/bucket/box", PasswordFile: "/pw",
		S3AccessKeyID: "AKIDEXAMPLE", S3SecretAccessKey: "s3-secret-value-xyz"}
	p, done, _ := dst.Paired(src, t.TempDir())
	defer done()
	err := p.CopyFrom(context.Background(), "aaaa1111")
	if err == nil || strings.Contains(err.Error(), "secret-value") {
		t.Fatalf("err: %v", err)
	}
	if err := p.CopyFrom(context.Background()); err == nil {
		t.Fatal("a copy without snapshots named would copy every one")
	}
}
