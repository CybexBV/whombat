package itest

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/coverage"
)

// HubBackup is an archive shaped like `whombat-hosts backup`'s from before (gzipped: manifest.json, hub.db, the CA).
func HubBackup(db string) []byte {
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	_, _ = gz.Write(HubTar(db))
	_ = gz.Close()
	return b.Bytes()
}

// HubTar is the uncompressed archive `whombat-hosts backup` writes now (hub.tar).
func HubTar(db string) []byte {
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	for _, f := range [][2]string{
		{"manifest.json", `{"format":1,"hub_version":"test","schema":12,"created_at":"` + time.Now().UTC().Format(time.RFC3339) + `"}`},
		{"hub.db", "SQLite format 3\x00" + db},
		{"ca.crt", "the agents' CA"},
		{"ca.key", "the agents' CA key"},
	} {
		_ = tw.WriteHeader(&tar.Header{Name: f[0], Mode: 0o600, Size: int64(len(f[1])), ModTime: time.Now()})
		_, _ = tw.Write([]byte(f[1]))
	}
	_ = tw.Close()
	return b.Bytes()
}

// HostsService stands in for the hosts service's backup socket (BK-32; NixOS whombat-hosts-backup@): every
// connection writes a fresh hub backup to <persist>/hosts-backup/hub.tar.gz, as `whombat-hosts backup` does
// as the service's user, and answers "ok" — or Fail's answer, writing nothing.
type HostsService struct {
	Socket string
	Dir    string // the hosts source (coverage.Layout.HostsBackup)
	mu     sync.Mutex
	fail   string
	made   int
	last   []byte
	tar    bool
}

// WritesTar makes it write the uncompressed hub.tar, as the hosts service does now (else hub.tar.gz, as before).
func (h *HostsService) WritesTar() {
	h.mu.Lock()
	h.tar = true
	h.mu.Unlock()
}

// Failing makes the next backups fail with this answer ("" = succeed again).
func (h *HostsService) Failing(answer string) {
	h.mu.Lock()
	h.fail = answer
	h.mu.Unlock()
}

// Last is the newest backup it wrote, and how many it made.
func (h *HostsService) Last() ([]byte, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.last, h.made
}

func (h *HostsService) answer(c net.Conn) {
	defer c.Close()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.fail != "" {
		_, _ = c.Write([]byte(h.fail + "\n"))
		return
	}
	h.made++
	b, name := HubBackup(fmt.Sprintf("servers, backup %d", h.made)), coverage.HostsBackupFile
	if h.tar {
		b, name = HubTar(fmt.Sprintf("servers, backup %d", h.made)), coverage.HostsBackupTarFile
	}
	_ = os.MkdirAll(h.Dir, 0o700)
	tmp := filepath.Join(h.Dir, ".hub-tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		_, _ = fmt.Fprintf(c, "failed: %v\n", err)
		return
	}
	if err := os.Rename(tmp, filepath.Join(h.Dir, name)); err != nil {
		_, _ = fmt.Fprintf(c, "failed: %v\n", err)
		return
	}
	h.last = b
	_, _ = c.Write([]byte("ok\n"))
}

// WithHosts gives this world the hosts service: its backup becomes a source of every checkpoint (BK-31).
func (w *World) WithHosts() *HostsService {
	w.T.Helper()
	sock := filepath.Join(w.Dir, "hosts.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		w.T.Fatal(err)
	}
	w.T.Cleanup(func() { l.Close() })
	EnableHosts(w.Cfg, sock)
	h := &HostsService{Socket: sock, Dir: w.Cfg.Layout().HostsBackup()}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go h.answer(c)
		}
	}()
	return h
}

// EnableHosts configures the hosts service for cfg (the service's user is the test's), its data directory
// made as tmpfiles does on the appliance.
func EnableHosts(cfg *state.Config, socket string) {
	cfg.Hosts = &state.HostsConfig{BackupSocket: socket, UID: os.Getuid(), GID: os.Getgid()}
	cfg.Defaults()
	_ = os.MkdirAll(cfg.Layout().HostsData(), 0o710)
}
