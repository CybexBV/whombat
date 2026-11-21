package itest

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/pkg/sshkey"
)

// Local destination servers for the BK-18/BK-19 tests, on the backup workstream's ports (5850–5899):
// an OpenSSH sshd run as the test user (SFTP through internal-sftp) and a MinIO server (S3).
//
// Environment: WB_SSHD (sshd binary; default the nixpkgs openssh from backup/scripts/test-tools.sh),
// WB_MINIO (minio binary). Missing tools skip the test with the reason.

// BlockPort finds a free port in the workstream's block.
func BlockPort(t testing.TB) int {
	t.Helper()
	for p := 5850; p < 5900; p++ {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			l.Close()
			return p
		}
	}
	t.Fatal("no free port in 5850-5899")
	return 0
}

func home() string { h, _ := os.UserHomeDir(); return h }

// SSHD is one sshd.
type SSHD struct {
	Port     int
	User     string
	Dir      string
	HostKey  sshkey.PublicKey
	bin, cfg string
	cmd      *exec.Cmd
}

// NeedSSHD returns the sshd binary or skips.
func NeedSSHD(t testing.TB) string {
	bin := lookFirst("WB_SSHD", filepath.Join(home(), ".cache/wb-tmp/bk-openssh/bin/sshd"), "/usr/sbin/sshd")
	if bin == "" {
		t.Skip("missing tools: sshd (WB_SSHD, see backup/scripts/test-tools.sh)")
	}
	return bin
}

// StartSSHD starts sshd on 127.0.0.1 accepting authorizedKey for the current user, SFTP only.
func StartSSHD(t testing.TB, authorizedKey string) *SSHD {
	t.Helper()
	bin := NeedSSHD(t)
	u, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	s := &SSHD{Port: BlockPort(t), User: u.Username, Dir: t.TempDir(), bin: bin}
	s.NewHostKey(t)
	s.Authorize(t, authorizedKey)
	s.Start(t)
	return s
}

// NewHostKey gives the server a new host key (takes effect at the next Start).
func (s *SSHD) NewHostKey(t testing.TB) {
	k, err := sshkey.Generate()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Dir, "host_ed25519"), sshkey.MarshalPrivate(k, "host"), 0o600); err != nil {
		t.Fatal(err)
	}
	s.HostKey = sshkey.Ed25519Public(k.Public().(ed25519.PublicKey))
}

// Authorize replaces authorized_keys.
func (s *SSHD) Authorize(t testing.TB, keys ...string) {
	if err := os.WriteFile(filepath.Join(s.Dir, "authorized_keys"), []byte(strings.Join(keys, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// Start (re)starts the server.
func (s *SSHD) Start(t testing.TB) {
	t.Helper()
	s.Stop()
	s.cfg = filepath.Join(s.Dir, "sshd_config")
	conf := fmt.Sprintf(`Port %d
ListenAddress 127.0.0.1
HostKey %s
PidFile none
AuthorizedKeysFile %s
StrictModes no
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers %s
Subsystem sftp internal-sftp
LogLevel VERBOSE
`, s.Port, filepath.Join(s.Dir, "host_ed25519"), filepath.Join(s.Dir, "authorized_keys"), s.User)
	if err := os.WriteFile(s.cfg, []byte(conf), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(s.bin, "-D", "-e", "-f", s.cfg)
	logf, _ := os.OpenFile(filepath.Join(s.Dir, "sshd.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	s.cmd = cmd
	t.Cleanup(s.Stop)
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", s.Port), time.Second); err == nil {
			c.Close()
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	log, _ := os.ReadFile(filepath.Join(s.Dir, "sshd.log"))
	t.Fatalf("sshd didn't start: %s", log)
}

// Stop stops the server.
func (s *SSHD) Stop() {
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		_, _ = s.cmd.Process.Wait()
		s.cmd = nil
	}
}

// Log is the server's log.
func (s *SSHD) Log() string { b, _ := os.ReadFile(filepath.Join(s.Dir, "sshd.log")); return string(b) }

// Repo is the repository for a directory on the server.
func (s *SSHD) Repo(dir string) string {
	return fmt.Sprintf("sftp://127.0.0.1:%d/%s", s.Port, dir) // dir is absolute: "//abs"
}

// Minio is one MinIO server.
type Minio struct {
	URL, User, Password string
}

// StartMinio starts MinIO on a data directory.
func StartMinio(t testing.TB) *Minio {
	t.Helper()
	bin := lookFirst("WB_MINIO", filepath.Join(home(), ".cache/wb-tmp/bk-minio/bin/minio"), "minio")
	if bin == "" {
		t.Skip("missing tools: minio (WB_MINIO, see backup/scripts/test-tools.sh)")
	}
	port, console := BlockPort(t), 0
	l, _ := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port)) // hold it while picking the console port
	console = BlockPort(t)
	l.Close()
	m := &Minio{URL: fmt.Sprintf("http://127.0.0.1:%d", port), User: "whombat-bk-test", Password: Rand(16)}
	dir := t.TempDir()
	cmd := exec.Command(bin, "server", filepath.Join(dir, "data"), "--quiet", "--address", fmt.Sprintf("127.0.0.1:%d", port),
		"--console-address", fmt.Sprintf("127.0.0.1:%d", console))
	cmd.Env = append(os.Environ(), "MINIO_ROOT_USER="+m.User, "MINIO_ROOT_PASSWORD="+m.Password,
		"MINIO_BROWSER=off", "MINIO_UPDATE=off", "HOME="+dir)
	logf, _ := os.Create(filepath.Join(dir, "minio.log"))
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for ctx.Err() == nil {
		resp, err := http.Get(m.URL + "/minio/health/live")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return m
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	log, _ := os.ReadFile(filepath.Join(dir, "minio.log"))
	t.Fatalf("minio didn't start: %s", log)
	return nil
}
