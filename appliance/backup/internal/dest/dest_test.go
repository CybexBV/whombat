package dest

import (
	"context"
	"crypto/ed25519"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
	"github.com/CybexBV/whombat/appliance/backup/pkg/sshkey"
)

func TestValidate(t *testing.T) {
	ok := []Request{
		{Repository: "rest:https://b.example:8000/box/", RESTUser: "u", RESTPassword: "p"},
		{Repository: "s3:https://s3.example.com/bucket/box", S3AccessKeyID: "AKID", S3SecretAccessKey: "s", S3Region: "eu-central-1"},
		{Repository: "s3:http://127.0.0.1:9000/bucket", S3AccessKeyID: "AKID", S3SecretAccessKey: "s"},
		{Repository: "sftp:nas.local:/volume1/whombat", SFTPUser: "whombat"},
		{Repository: "sftp://nas:2222//srv", SFTPUser: "whombat", SFTPHostKey: "SHA256:" + strings.Repeat("A", 43)},
		{Repository: "disk:", AllowInit: true},
		{Repository: "/srv/restic", AllowLocal: true},
	}
	for _, r := range ok {
		if _, err := validate(r); err != nil {
			t.Fatalf("%+v: %v", r, err)
		}
	}
	bad := []Request{
		{Repository: ""},
		{Repository: "rest:https://u:p@b.example/box/"},
		{Repository: "rest:ftp://b.example/"},
		{Repository: "s3:https://s3.example.com/bucket"},                                       // no key
		{Repository: "s3:https://s3.example.com/", S3AccessKeyID: "A", S3SecretAccessKey: "s"}, // no bucket
		{Repository: "s3:https://s3.example.com/b", S3AccessKeyID: "A", S3SecretAccessKey: "s", S3Region: "EU Central"},
		{Repository: "s3:https://s3.example.com/b", S3AccessKeyID: "A", S3SecretAccessKey: "s", RESTUser: "u"},
		{Repository: "sftp:nas:/p"},                                     // no user
		{Repository: "sftp:nas:/p", SFTPUser: "a b"},                    // user with a space
		{Repository: "sftp:nas:/p", SFTPUser: "u", SFTPHostKey: "junk"}, // not a key
		{Repository: "sftp:nas:/p", SFTPUser: "u", CACert: "x"},
		{Repository: "sftp:nas:/p", SFTPUser: "u", S3AccessKeyID: "A"},
		{Repository: "disk:", RESTUser: "u"},
		{Repository: "/srv/restic"}, // local only from the console
		{Repository: "disk: "},
	}
	for _, r := range bad {
		_, err := validate(r)
		var ie *InputError
		if !errors.As(err, &ie) {
			t.Fatalf("%+v accepted (%v)", r, err)
		}
	}
}

func TestExplain(t *testing.T) {
	d := func(kind string) *state.Destination { return &state.Destination{Kind: kind} }
	for _, tc := range []struct {
		kind, stderr string
		want         string
	}{
		{state.KindS3, "Fatal: unable to open config file: Stat: The Access Key Id you provided does not exist in our records.", ReasonS3Auth},
		{state.KindS3, "Fatal: ... SignatureDoesNotMatch", ReasonS3Auth},
		{state.KindS3, "Fatal: ... NoSuchBucket: The specified bucket does not exist", ReasonS3NoBucket},
		{state.KindSFTP, "Host key verification failed.\nsubprocess ssh: exit status 255", ReasonSFTPHostKey},
		{state.KindSFTP, "whombat@nas: Permission denied (publickey).\nFatal: unable to start the sftp session", ReasonSFTPAuth},
		{state.KindSFTP, "ssh: connect to host nas port 22: Connection refused", ReasonUnreachable},
		{state.KindSFTP, "sftp: \"no such file\" (SSH_FX_NO_SUCH_FILE)", ReasonSFTPNoPath},
		{state.KindREST, "Fatal: unexpected HTTP response (401): 401 Unauthorized", ReasonRESTAuth},
		{state.KindREST, "dial tcp 10.0.0.9:8000: i/o timeout", ReasonUnreachable},
		{state.KindREST, "x509: certificate signed by unknown authority", ReasonTLS},
		{state.KindDisk, "disk absent", ReasonDiskAbsent},
	} {
		err := Explain(d(tc.kind), &restic.Error{Args: []string{"cat"}, Code: 1, Stderr: tc.stderr})
		var de *DestError
		if !errors.As(err, &de) || de.Reason != tc.want {
			t.Fatalf("%s %q: %v", tc.kind, tc.stderr, err)
		}
		if state.ASCII(de.Reason, 500) != de.Reason {
			t.Fatalf("reason isn't printable ASCII: %q", de.Reason)
		}
	}
}

// fakeTools: a restic that answers `cat config` (and records its environment) and an ssh-keyscan that
// prints the given host key line.
func fakeTools(t *testing.T, hostKeyLine string) (resticBin, sshBin, envFile string) {
	t.Helper()
	dir := t.TempDir()
	envFile = filepath.Join(dir, "env")
	resticBin = filepath.Join(dir, "restic")
	script := `#!/bin/sh
env > ` + envFile + `
for a in "$@"; do case "$a" in cat) echo '{"version":2,"id":"repo-1"}'; exit 0;; init) exit 0;; esac; done
exit 1
`
	if err := os.WriteFile(resticBin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	sshBin = filepath.Join(dir, "ssh")
	if err := os.WriteFile(filepath.Join(dir, "ssh-keyscan"), []byte("#!/bin/sh\necho '# nas:22 SSH-2.0-OpenSSH_10.0' >&2\necho 'nas "+hostKeyLine+"'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return resticBin, sshBin, envFile
}

func newConfig(t *testing.T, resticBin, sshBin string) *state.Config {
	c := &state.Config{ApplianceID: "apl-test", Persist: t.TempDir(), Restic: resticBin, SSH: sshBin, RuntimeUID: -1, ManagerUID: -1, BackupUID: -1}
	c.Defaults()
	return c
}

// S3: the secret is a 0600 secret file and in restic's environment, never in destination.json, the status
// or the answer; the kit carries it.
func TestConfigureS3KeepsTheSecretOutOfState(t *testing.T) {
	k, _ := sshkey.Generate()
	resticBin, sshBin, envFile := fakeTools(t, sshkey.Ed25519Public(k.Public().(ed25519.PublicKey)).String())
	c := newConfig(t, resticBin, sshBin)
	res, err := Configure(context.Background(), c, Request{Repository: "s3:https://s3.example.com/bucket/box",
		S3AccessKeyID: "AKIDEXAMPLE", S3SecretAccessKey: "very-secret-s3-key", S3Region: "eu-west-1"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Kind != state.KindS3 || res.AppendOnly != "not-enforced" || res.RepositoryID != "repo-1" {
		t.Fatalf("%+v", res.Destination)
	}
	env, _ := os.ReadFile(envFile)
	if !strings.Contains(string(env), "AWS_SECRET_ACCESS_KEY=very-secret-s3-key") {
		t.Fatal("restic didn't get the secret in its environment")
	}
	for _, f := range []string{c.DestinationPath(), c.StatusPath()} {
		b, _ := os.ReadFile(f)
		if strings.Contains(string(b), "very-secret-s3-key") {
			t.Fatalf("secret in %s", f)
		}
	}
	fi, err := os.Stat(c.SecretWritePath(state.SecretS3Key))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("secret file: %v %v", fi, err)
	}
	m, err := Material(c)
	if err != nil {
		t.Fatal(err)
	}
	if m.S3SecretAccessKey != "very-secret-s3-key" || m.S3AccessKeyID != "AKIDEXAMPLE" || m.S3Region != "eu-west-1" {
		t.Fatalf("kit %+v", m)
	}
	if left, _ := filepath.Glob(filepath.Join(c.SecretsDir(), ".staged-*")); len(left) != 0 {
		t.Fatalf("staging left behind: %v", left)
	}
}

// A destination that doesn't open leaves the working one (and its secrets) untouched.
func TestFailedConfigureKeepsThePreviousDestination(t *testing.T) {
	resticBin, sshBin, _ := fakeTools(t, "")
	c := newConfig(t, resticBin, sshBin)
	if _, err := Configure(context.Background(), c, Request{Repository: "s3:https://s3.example.com/bucket/box",
		S3AccessKeyID: "AKID1", S3SecretAccessKey: "first-secret"}); err != nil {
		t.Fatal(err)
	}
	failing := filepath.Join(t.TempDir(), "restic")
	_ = os.WriteFile(failing, []byte("#!/bin/sh\necho 'Fatal: ... SignatureDoesNotMatch second-secret' >&2\nexit 1\n"), 0o755)
	c.Restic = failing
	_, err := Configure(context.Background(), c, Request{Repository: "s3:https://s3.example.com/other/box",
		S3AccessKeyID: "AKID2", S3SecretAccessKey: "second-secret"})
	var de *DestError
	if !errors.As(err, &de) || de.Reason != ReasonS3Auth || strings.Contains(err.Error(), "second-secret") {
		t.Fatalf("%v", err)
	}
	d, _ := state.LoadDestination(c)
	if d.Repository != "s3:https://s3.example.com/bucket/box" || d.S3AccessKeyID != "AKID1" {
		t.Fatalf("destination replaced by a failed attempt: %+v", d)
	}
	if v, _ := c.ReadSecret(state.SecretS3Key); v != "first-secret" {
		t.Fatalf("secret replaced by a failed attempt: %q", v)
	}
}

// SFTP: the box's key is made once; trust on first use pins the scanned key and answers its fingerprint;
// a fingerprint the scanned key doesn't match is refused; the kit carries user, key and host key.
func TestConfigureSFTP(t *testing.T) {
	host, _ := sshkey.Generate()
	hostPub := sshkey.Ed25519Public(host.Public().(ed25519.PublicKey))
	resticBin, sshBin, _ := fakeTools(t, hostPub.String())
	c := newConfig(t, resticBin, sshBin)
	k1, err := PublicKey(c)
	if err != nil {
		t.Fatal(err)
	}
	k2, _ := PublicKey(c)
	if k1.PublicKey != k2.PublicKey || !strings.HasSuffix(k1.PublicKey, " whombat-backup@apl-test") {
		t.Fatalf("key not stable: %+v %+v", k1, k2)
	}
	fi, _ := os.Stat(c.SecretWritePath(state.SecretSSHKey))
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v", fi.Mode())
	}
	res, err := Configure(context.Background(), c, Request{Repository: "sftp:nas:/volume1/whombat", SFTPUser: "whombat"})
	if err != nil {
		t.Fatal(err)
	}
	if res.HostKeyFingerprint != hostPub.Fingerprint() || res.SFTPHostKey != hostPub.String() {
		t.Fatalf("pinned %+v", res.Destination)
	}
	known, _ := os.ReadFile(c.KnownHostsPath())
	if string(known) != "nas "+hostPub.String()+"\n" {
		t.Fatalf("known_hosts %q", known)
	}
	r := c.Repo(res.Destination)
	if r.SFTP == nil || r.SFTP.User != "whombat" || r.SFTP.HostKeyAlgorithms != "ssh-ed25519" || r.SFTP.KeyFile != c.SecretWritePath(state.SecretSSHKey) {
		t.Fatalf("%+v", r.SFTP)
	}
	m, err := Material(c)
	if err != nil {
		t.Fatal(err)
	}
	if m.SFTPUser != "whombat" || m.SFTPHostKey != hostPub.String() || !strings.Contains(m.SFTPPrivateKey, "OPENSSH PRIVATE KEY") {
		t.Fatalf("kit %+v", m)
	}
	// The owner compares fingerprints: a different one is refused before anything changes.
	other, _ := sshkey.Generate()
	_, err = Configure(context.Background(), c, Request{Repository: "sftp:nas:/volume1/other", SFTPUser: "whombat",
		SFTPHostKey: sshkey.Ed25519Public(other.Public().(ed25519.PublicKey)).Fingerprint()})
	var de *DestError
	if !errors.As(err, &de) || de.Reason != ReasonSFTPHostKey {
		t.Fatalf("%v", err)
	}
	// The same fingerprint is accepted; a full key line is pinned as given.
	if _, err := Configure(context.Background(), c, Request{Repository: "sftp:nas:/volume1/whombat", SFTPUser: "whombat",
		SFTPHostKey: hostPub.Fingerprint()}); err != nil {
		t.Fatal(err)
	}
	res, err = Configure(context.Background(), c, Request{Repository: "sftp://nas:2222//srv", SFTPUser: "whombat",
		SFTPHostKey: "nas " + hostPub.String() + " comment"})
	if err != nil {
		t.Fatal(err)
	}
	c.Repo(res.Destination)
	if known, _ := os.ReadFile(c.KnownHostsPath()); string(known) != "[nas]:2222 "+hostPub.String()+"\n" {
		t.Fatalf("known_hosts %q", known)
	}
}

// Disk: absent without allowInit is refused with the owner's reason; with allowInit the root helper's
// answer is awaited (here a stand-in that "formats" by making the directory).
func TestConfigureDisk(t *testing.T) {
	resticBin, sshBin, _ := fakeTools(t, "")
	c := newConfig(t, resticBin, sshBin)
	c.DiskInitTimeoutMs = 10_000
	_, err := Configure(context.Background(), c, Request{Repository: "disk:"})
	var de *DestError
	if !errors.As(err, &de) || !strings.Contains(de.Reason, "No disk labelled WHOMBAT-BACKUP") {
		t.Fatalf("%v", err)
	}
	done := make(chan error, 1)
	go func() { done <- standInHelper(c, true, "") }()
	res, err := Configure(context.Background(), c, Request{Repository: "disk:", AllowInit: true})
	if err != nil {
		t.Fatal(err)
	}
	if herr := <-done; herr != nil {
		t.Fatal(herr)
	}
	if res.Kind != state.KindDisk || c.Repo(res.Destination).Repository != c.DiskRepository() {
		t.Fatalf("%+v", res.Destination)
	}
	// The status says when the disk is gone, and stops saying it when it is back.
	if err := os.Rename(c.DiskMount, c.DiskMount+".away"); err != nil {
		t.Fatal(err)
	}
	RefreshPresence(c)
	st, _ := state.CurrentStatus(c)
	if st.State != state.StateFailing || st.LastFailure == nil || st.LastFailure.Reason != ReasonDiskAbsent {
		t.Fatalf("%+v", st)
	}
	_ = os.Rename(c.DiskMount+".away", c.DiskMount)
	RefreshPresence(c)
	st, _ = state.CurrentStatus(c)
	if st.State != state.StatePending {
		t.Fatalf("disk back: %s", st.State)
	}
	// The helper's refusal reaches the owner.
	_ = os.RemoveAll(c.DiskMount)
	go func() {
		done <- standInHelper(c, false, "More than one empty disk is attached (vdb, vdc): attach only the one meant for backups, then try again.")
	}()
	_, err = Configure(context.Background(), c, Request{Repository: "disk:", AllowInit: true})
	if !errors.As(err, &de) || !strings.HasPrefix(de.Reason, "More than one empty disk") {
		t.Fatalf("%v", err)
	}
	<-done
}

func standInHelper(c *state.Config, ok bool, msg string) error {
	req := filepath.Join(InitDir(c), "request.json")
	for i := 0; i < 400; i++ {
		b, err := os.ReadFile(req)
		if err == nil {
			var r InitRequest
			if err := jsonUnmarshal(b, &r); err != nil {
				return err
			}
			if ok {
				if err := os.MkdirAll(c.DiskMount, 0o755); err != nil {
					return err
				}
			}
			_ = os.Remove(req)
			return state.WriteJSON(filepath.Join(InitDir(c), "result.json"), InitResult{Nonce: r.Nonce, OK: ok, Message: msg}, 0o644)
		}
		sleep()
	}
	return errors.New("no request")
}
