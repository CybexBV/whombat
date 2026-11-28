package restic

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

// A private CA stays on its own place's connection: a REST source over https is reached through the relay, which trusts
// only the source's CA, and restic's --cacert is the target's alone. The relay goes when done.
func TestCopyKeepsEachCAToItsPlace(t *testing.T) {
	dir := t.TempDir()
	var gotPath, gotUser string
	nas := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser, _, _ = r.BasicAuth()
		gotPath = r.URL.Path
		_, _ = w.Write([]byte("config"))
	}))
	defer nas.Close()
	nasCA := writePEM(t, dir, "nas-ca.pem", nas.Certificate().Raw)
	src := Repo{Repository: "rest:" + nas.URL + "/box/", CACert: nasCA, RESTUser: "box", RESTPassword: "pw"}
	p, done, err := Repo{Repository: "s3:https://s3.example.com/b/x"}.Paired(src, dir)
	if err != nil {
		t.Fatal(err)
	}
	if p.CACert != "" || p.From.CACert != "" || !strings.HasPrefix(p.From.Repository, "rest:http+unix://") {
		t.Fatalf("the source's CA reached the copy's --cacert: %q, from %q %q", p.CACert, p.From.Repository, p.From.CACert)
	}
	sock := strings.TrimPrefix(p.From.Repository, "rest:http+unix://")
	sock, path, _ := strings.Cut(sock, ":")
	if path != "/box/" {
		t.Fatalf("the repository's path: %q", path)
	}
	if code := viaRelay(t, sock, "/box/config"); code != http.StatusOK || gotPath != "/box/config" || gotUser != "box" {
		t.Fatalf("through the relay: %d %q %q", code, gotPath, gotUser)
	}
	done()
	if _, err := os.Stat(sock); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the relay stayed: %v", err)
	}

	// A CA that didn't sign the place's certificate opens nothing, and neither do the system's roots alone.
	other := writePEM(t, dir, "other-ca.pem", selfSigned(t))
	for _, ca := range []string{other, ""} {
		src.CACert = ca
		target := Repo{Repository: "/srv/copy", CACert: nasCA}
		if ca == "" {
			target.CACert = other // the target's own authority never reaches the source
		}
		p, done, err := target.Paired(src, dir)
		if err != nil {
			t.Fatal(err)
		}
		sock, _, _ := strings.Cut(strings.TrimPrefix(p.From.Repository, "rest:http+unix://"), ":")
		if code := viaRelay(t, sock, "/box/config"); code != http.StatusBadGateway {
			t.Fatalf("CA %q: the place answered %d through another authority", ca, code)
		}
		if p.CACert != target.CACert {
			t.Fatalf("the target's --cacert: %q", p.CACert)
		}
		done()
	}
}

// What needs no relay keeps one authority per place too; an S3 source with an authority of its own can't be paired.
func TestCopyAuthorityWithoutRelay(t *testing.T) {
	sftp := Repo{Repository: "sftp:nas.local:/backups/box", SFTP: &SFTP{Host: "nas.local"}}
	p, done, err := Repo{Repository: "s3:https://s3.example.com/b/x", CACert: "/ca.pem"}.Paired(sftp, t.TempDir())
	if err != nil || p.CACert != "/ca.pem" || p.From.Repository != sftp.Repository {
		t.Fatalf("sftp source: %v %+v", err, p)
	}
	done()
	same := Repo{Repository: "rest:https://nas.example.com/box/", CACert: "/ca.pem"}
	if p, done, err := (Repo{Repository: "rest:https://nas.example.com/copy/", CACert: "/ca.pem"}).Paired(same, t.TempDir()); err != nil ||
		p.CACert != "/ca.pem" || p.From.Repository != same.Repository {
		t.Fatalf("one authority for both: %v %+v", err, p)
	} else {
		done()
	}
	s3 := Repo{Repository: "s3:https://minio.example.com/b/box", CACert: "/ca.pem", S3AccessKeyID: "A", S3SecretAccessKey: "x"}
	if _, done, err := (Repo{Repository: "s3:https://s3.example.com/b/x", S3AccessKeyID: "A", S3SecretAccessKey: "x"}).Paired(s3, t.TempDir()); !errors.Is(err, ErrCopyCredentials) {
		t.Fatalf("an S3 source's own authority would have reached the target: %v", err)
	} else {
		done()
	}
}

func writePEM(t *testing.T, dir, name string, der []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func selfSigned(t *testing.T) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "other"}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
		IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)}}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

// viaRelay asks the relay on sock for path as restic would, with restic's credentials, and answers the status.
func viaRelay(t *testing.T, sock, path string) int {
	t.Helper()
	hc := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}}}
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://relay"+path, nil)
	req.SetBasicAuth("box", "pw")
	resp, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode
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
