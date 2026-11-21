package hub

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"rackoon/internal/hub/store"
	"rackoon/internal/netaddrs"
	"rackoon/internal/proto"
)

// rawPost sends a body as it is (a backup upload).
func (c *client) rawPost(path string, body []byte) (int, map[string]any) {
	c.t.Helper()
	r, _ := http.NewRequest(http.MethodPost, c.e.ui.URL+path, bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/gzip")
	resp, err := c.c.Do(r)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// backupEntries reads a backup's entries.
func backupEntries(t *testing.T, b []byte) map[string][]byte {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	out := map[string][]byte{}
	for {
		hd, err := tr.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		out[hd.Name], _ = io.ReadAll(tr)
	}
}

// writeBackupEntries packs entries as a backup.
func writeBackupEntries(t *testing.T, entries map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, n := range slices.Sorted(func(yield func(string) bool) {
		for k := range entries {
			if !yield(k) {
				return
			}
		}
	}) {
		tw.WriteHeader(&tar.Header{Name: n, Mode: 0o600, Size: int64(len(entries[n]))})
		tw.Write(entries[n])
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func hubInfo(t *testing.T, svc *client) map[string]any {
	t.Helper()
	var hub map[string]any
	svc.json(http.MethodGet, "/api/v1/hub", nil, 200, &hub)
	return hub
}

func TestRestoreThroughTheAPI(t *testing.T) {
	ctx := context.Background()
	// The hub the backup comes from: two servers, its agents at .160.
	src := headlessEnv(t, func(c *Config) { c.AgentURL = "wss://10.100.1.160:8443" })
	ssvc := src.service("pe_1|John")
	src.enroll(ssvc, "granite", "Production")
	src.enroll(ssvc, "basalt", "")
	code, backup, _ := ssvc.req(http.MethodGet, "/api/v1/hub/backup", nil, nil)
	if code != 200 {
		t.Fatalf("backup: %d", code)
	}
	entries := backupEntries(t, backup)
	var man BackupManifest
	if err := json.Unmarshal(entries["manifest.json"], &man); err != nil || man.AgentURL != "wss://10.100.1.160:8443" ||
		man.CASHA256 != src.h.ca.Pin {
		t.Fatalf("manifest %+v %v", man, err)
	}
	for _, n := range listenerFiles {
		if _, ok := entries[n]; ok {
			t.Errorf("the backup carries %s", n)
		}
	}

	// The hub it goes to: empty, at .158.
	dir := t.TempDir()
	tweak := func(c *Config) {
		c.DataDir, c.ServiceTokenFile = dir, filepath.Join(dir, "service-token")
		c.AgentURL = "wss://10.100.1.158:8443"
	}
	dst := headlessEnv(t, tweak)
	svc := dst.service("pe_1|John")
	token := dst.serviceToken()
	listenerBefore, _ := os.ReadFile(filepath.Join(dir, "agent-listener.crt"))

	// Refusals: not a backup, a newer hub's, its own, and a hub with servers.
	if code, b := svc.rawPost("/api/v1/hub/restore", []byte("not a backup")); code != 400 || b["code"] != "bad_backup" {
		t.Errorf("garbage: %d %v", code, b)
	}
	newer := map[string][]byte{}
	for k, v := range entries {
		newer[k] = v
	}
	newer["manifest.json"], _ = json.Marshal(BackupManifest{Format: 1, Schema: store.SchemaVersion() + 1})
	if code, b := svc.rawPost("/api/v1/hub/restore", writeBackupEntries(t, newer)); code != 400 || b["code"] != "newer_schema" {
		t.Errorf("newer: %d %v", code, b)
	}
	noCA := map[string][]byte{"manifest.json": entries["manifest.json"], "hub.db": entries["hub.db"]}
	if code, b := svc.rawPost("/api/v1/hub/restore", writeBackupEntries(t, noCA)); code != 400 || b["code"] != "bad_backup" {
		t.Errorf("no CA: %d %v", code, b)
	}
	_, own, _ := svc.req(http.MethodGet, "/api/v1/hub/backup", nil, nil)
	if code, b := svc.rawPost("/api/v1/hub/restore", own); code != 409 || b["code"] != "same_hub" {
		t.Errorf("own backup: %d %v", code, b)
	}
	if code, b := ssvc.rawPost("/api/v1/hub/restore", own); code != 409 || b["code"] != "hub_not_empty" {
		t.Errorf("into a hub with servers: %d %v", code, b)
	}
	if m, _ := filepath.Glob(filepath.Join(dir, ".restore*")); len(m) != 0 {
		t.Errorf("refusals left %v", m)
	}
	select {
	case <-dst.h.stopCh:
		t.Fatal("a refused restore stopped the hub")
	default:
	}

	// Accepted: staged, answered, and the hub stops.
	code, b := svc.rawPost("/api/v1/hub/restore", backup)
	if code != 202 || b["ca_sha256"] != src.h.ca.Pin || b["servers"] != float64(2) || b["agent_url"] != "wss://10.100.1.160:8443" {
		t.Fatalf("restore: %d %v", code, b)
	}
	fi, err := os.Stat(filepath.Join(dir, stagedRestoreFile))
	if err != nil || fi.Mode().Perm() != 0o600 || fi.Size() != int64(len(backup)) {
		t.Fatalf("staged file %v %v", fi, err)
	}
	if code, b := svc.rawPost("/api/v1/hub/restore", backup); code != 409 || b["code"] != "restore_pending" {
		t.Errorf("second restore: %d %v", code, b)
	}
	select {
	case <-dst.h.stopCh:
	case <-time.After(2 * time.Second):
		t.Fatal("the hub did not stop within 2 s")
	}
	if recs := dst.audit("hub.restore_staged"); len(recs) != 1 || recs[0].Details["servers"] != "2" {
		t.Errorf("audit %s", fmtRecs(recs))
	}
	dst.stop()

	// The next start applies it.
	dst2 := headlessEnv(t, tweak)
	if dst2.h.CAPin() != src.h.ca.Pin {
		t.Fatal("the CA was not restored")
	}
	for _, id := range []string{"granite", "basalt"} {
		if _, err := dst2.h.store.GetServer(ctx, id); err != nil {
			t.Errorf("%s: %v", id, err)
		}
	}
	if dst2.serviceToken() != token {
		t.Error("the service token changed")
	}
	svc2 := dst2.service("pe_1|John")
	hub := hubInfo(t, svc2)
	if hub["restored_at"] == nil || hub["agent_url"] != "wss://10.100.1.158:8443" || hub["agent_url_previous"] != "wss://10.100.1.160:8443" ||
		hub["agent_url_changed_at"] == nil || hub["restore_error"] != nil || hub["servers"] != float64(2) {
		t.Fatalf("hub = %v", hub)
	}
	// The listener is this box's, issued by the restored CA for this address.
	listener, _ := os.ReadFile(filepath.Join(dir, "agent-listener.crt"))
	srcListener, _ := os.ReadFile(filepath.Join(src.h.cfg.DataDir, "agent-listener.crt"))
	if bytes.Equal(listener, listenerBefore) || bytes.Equal(listener, srcListener) {
		t.Fatal("the listener certificate was not made again")
	}
	blk, _ := pem.Decode(listener)
	leaf, _ := x509.ParseCertificate(blk.Bytes)
	if leaf == nil || leaf.CheckSignatureFrom(src.h.ca.Cert) != nil || leaf.VerifyHostname("10.100.1.158") != nil {
		t.Fatal("the listener certificate is not the restored CA's for this address")
	}
	for _, pat := range []string{"hub.db.pre-restore-*.bak", "ca.key.pre-restore-*.bak", "agent-listener.key.pre-restore-*.bak"} {
		if m, _ := filepath.Glob(filepath.Join(dir, pat)); len(m) != 1 {
			t.Errorf("%s: %v", pat, m)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, stagedRestoreFile)); !os.IsNotExist(err) {
		t.Error("the staged file is still there")
	}
	if recs := dst2.audit("hub.restored"); len(recs) != 1 || recs[0].Details["ca_sha256"] != src.h.ca.Pin {
		t.Errorf("audit %s", fmtRecs(recs))
	}
	if recs := dst2.audit("hub.address_changed"); len(recs) != 1 || recs[0].Details["from"] != "wss://10.100.1.160:8443" {
		t.Errorf("audit %s", fmtRecs(recs))
	}
}

func TestStagedRestoreThatFails(t *testing.T) {
	dir := t.TempDir()
	tweak := func(c *Config) { c.DataDir, c.ServiceTokenFile = dir, filepath.Join(dir, "service-token") }
	e := headlessEnv(t, tweak)
	e.enroll(e.service("pe_1|John"), "granite", "")
	pin := e.h.CAPin()
	e.stop()
	if err := os.WriteFile(filepath.Join(dir, stagedRestoreFile), []byte("not a backup"), 0o600); err != nil {
		t.Fatal(err)
	}
	e2 := headlessEnv(t, tweak)
	if e2.h.CAPin() != pin {
		t.Fatal("the CA changed")
	}
	if _, err := e2.h.store.GetServer(context.Background(), "granite"); err != nil {
		t.Fatal("the data from before is gone")
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "restore-failed-*.tar.gz")); len(m) != 1 {
		t.Fatalf("failed file %v", m)
	}
	if _, err := os.Stat(filepath.Join(dir, stagedRestoreFile)); !os.IsNotExist(err) {
		t.Error("the staged file is still there")
	}
	re, _ := hubInfo(t, e2.service("pe_1|John"))["restore_error"].(map[string]any)
	if re["code"] != "bad_backup" || re["at"] == nil {
		t.Fatalf("restore_error = %v", re)
	}
	if recs := e2.audit("hub.restore_failed"); len(recs) != 1 || recs[0].Code != "bad_backup" {
		t.Errorf("audit %s", fmtRecs(recs))
	}
	// It stays known across a restart.
	e2.stop()
	e3 := headlessEnv(t, tweak)
	if hubInfo(t, e3.service("pe_1|John"))["restore_error"] == nil {
		t.Error("restore_error forgotten at the next start")
	}
}

// TestPlainTarBackup: the box's checkpoints take a plain tar (hub.tar,
// which restic can dedup): it holds the same files with the same modes as
// the gzipped download, the API stages it as restore-staged.tar and the
// next start applies it; zeros after its end are a tar's padding, anything
// else is refused.
func TestPlainTarBackup(t *testing.T) {
	ctx := context.Background()
	src := headlessEnv(t, func(c *Config) { c.AgentURL = "wss://10.100.1.160:8443" })
	ssvc := src.service("pe_1|John")
	src.enroll(ssvc, "granite", "")
	var plain bytes.Buffer
	if err := BackupOffline(ctx, src.h.cfg.DataDir, &plain, false); err != nil {
		t.Fatal(err)
	}
	if isGzip(plain.Bytes()) {
		t.Fatal("the checkpoint's backup is gzipped")
	}
	tr := tar.NewReader(bytes.NewReader(plain.Bytes()))
	var names []string
	for {
		hd, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if hd.Mode != 0o600 || hd.Typeflag != tar.TypeReg || hd.Uid != 0 || hd.Gid != 0 {
			t.Errorf("%s: mode %o type %c owner %d:%d", hd.Name, hd.Mode, hd.Typeflag, hd.Uid, hd.Gid)
		}
		names = append(names, hd.Name)
	}
	if !slices.Equal(names, []string{"manifest.json", "hub.db", "ca.crt", "ca.key"}) {
		t.Errorf("entries %v", names)
	}
	var gz bytes.Buffer
	if err := BackupOffline(ctx, src.h.cfg.DataDir, &gz, true); err != nil || !isGzip(gz.Bytes()) {
		t.Fatalf("gzipped: %v", err)
	}
	if e := backupEntries(t, gz.Bytes()); len(e) != 4 || len(e["hub.db"]) == 0 {
		t.Errorf("gzipped entries %v", e)
	}
	// The CLI's restore takes both.
	for _, b := range [][]byte{plain.Bytes(), gz.Bytes()} {
		if _, err := Restore(ctx, t.TempDir(), bytes.NewReader(b), false); err != nil {
			t.Fatal(err)
		}
	}

	dir := t.TempDir()
	tweak := func(c *Config) { c.DataDir, c.ServiceTokenFile = dir, filepath.Join(dir, "service-token") }
	dst := headlessEnv(t, tweak)
	svc := dst.service("pe_1|John")
	trailing := append(slices.Clone(plain.Bytes()), "and more"...)
	if code, b := svc.rawPost("/api/v1/hub/restore", trailing); code != 400 || b["code"] != "bad_backup" {
		t.Errorf("something after the archive: %d %v", code, b)
	}
	padded := append(slices.Clone(plain.Bytes()), make([]byte, 9216)...)
	// A backup staged before under the other name never comes back.
	os.WriteFile(filepath.Join(dir, stagedRestoreFile), []byte("older"), 0o600)
	if code, b := svc.rawPost("/api/v1/hub/restore", padded); code != 202 || b["ca_sha256"] != src.h.ca.Pin {
		t.Fatalf("restore: %d %v", code, b)
	}
	if fi, err := os.Stat(filepath.Join(dir, stagedRestoreTar)); err != nil || fi.Mode().Perm() != 0o600 || fi.Size() != int64(len(padded)) {
		t.Fatalf("staged %v %v", fi, err)
	}
	if exists(filepath.Join(dir, stagedRestoreFile)) {
		t.Error("the older staged backup is still there")
	}
	select {
	case <-dst.h.stopCh:
	case <-time.After(2 * time.Second):
		t.Fatal("the hub did not stop within 2 s")
	}
	dst.stop()
	dst2 := headlessEnv(t, tweak)
	if dst2.h.CAPin() != src.h.ca.Pin {
		t.Fatal("the plain tar wasn't restored")
	}
	if _, err := dst2.h.store.GetServer(ctx, "granite"); err != nil {
		t.Error(err)
	}
	if exists(filepath.Join(dir, stagedRestoreTar)) {
		t.Error("the staged file is still there")
	}
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// TestStagedNames: the appliance may stage a backup as restore-staged.tar
// or .tar.gz, whatever it holds; with both there the newer is applied and
// the older dropped, and a plain tar that fails is kept as
// restore-failed-<time>.tar.
func TestStagedNames(t *testing.T) {
	ctx := context.Background()
	src := headlessEnv(t, nil)
	src.enroll(src.service("pe_1|John"), "granite", "")
	var plain bytes.Buffer
	if err := BackupOffline(ctx, src.h.cfg.DataDir, &plain, false); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	tweak := func(c *Config) { c.DataDir, c.ServiceTokenFile = dir, filepath.Join(dir, "service-token") }
	e := headlessEnv(t, tweak)
	pin := e.h.CAPin()
	e.stop()
	// A plain tar under the gzip name (an appliance that stages every
	// backup as restore-staged.tar.gz), with an older broken one beside it.
	old := time.Now().Add(-time.Hour)
	os.WriteFile(filepath.Join(dir, stagedRestoreTar), []byte("not a backup"), 0o600)
	os.Chtimes(filepath.Join(dir, stagedRestoreTar), old, old)
	os.WriteFile(filepath.Join(dir, stagedRestoreFile), plain.Bytes(), 0o600)
	e2 := headlessEnv(t, tweak)
	if e2.h.CAPin() != src.h.CAPin() || e2.h.CAPin() == pin {
		t.Fatal("the newer staged backup wasn't applied")
	}
	for _, n := range stagedNames {
		if exists(filepath.Join(dir, n)) {
			t.Errorf("%s is still there", n)
		}
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "restore-failed-*")); len(m) != 0 {
		t.Errorf("failed files %v", m)
	}
	e2.stop()
	os.WriteFile(filepath.Join(dir, stagedRestoreTar), []byte("not a backup"), 0o600)
	e3 := headlessEnv(t, tweak)
	if e3.h.CAPin() != src.h.CAPin() {
		t.Fatal("a broken staged backup changed the hub")
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "restore-failed-*.tar")); len(m) != 1 {
		t.Errorf("failed files %v", m)
	}
}

// newerCert issues a client certificate for the agent's key later than
// the one the hub stored (the agent renewed after the backup).
func newerCert(t *testing.T, e *env, a *fakeAgent, at time.Time) (tls.Certificate, string) {
	t.Helper()
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: a.id}}, a.key)
	if err != nil {
		t.Fatal(err)
	}
	iss, err := e.h.ca.SignClient(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}), a.id, at)
	if err != nil {
		t.Fatal(err)
	}
	kb, _ := x509.MarshalPKCS8PrivateKey(a.key)
	c, err := tls.X509KeyPair(iss.PEM, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kb}))
	if err != nil {
		t.Fatal(err)
	}
	return c, iss.Serial
}

func TestAdoptionAfterRestore(t *testing.T) {
	ctx := context.Background()
	e, admin := adminEnv(t, nil)
	a := e.enroll(admin, "granite", "")
	stored, _ := e.h.store.GetServer(ctx, "granite")
	var serial string
	a.cert, serial = newerCert(t, e, a, time.Now().Add(time.Minute))

	// Not restored: the normal rule.
	if code, _ := a.dial(proto.Hello{MachineID: "m-granite"}); code != 403 {
		t.Fatalf("not restored: %d", code)
	}
	// Restored 13 days ago: another machine is refused, its own adopted.
	at := time.Now().Add(-13 * 24 * time.Hour)
	e.h.restoredAt.Store(&at)
	if _, err := a.dial(proto.Hello{MachineID: "m-other"}); err == nil {
		t.Fatal("another machine adopted the certificate")
	}
	if s, _ := e.h.store.GetServer(ctx, "granite"); s.CertSerial != stored.CertSerial {
		t.Fatal("a refused adoption changed the serial")
	}
	a.ack = proto.HelloAck{} // dial keeps the last answer's fields
	if code, err := a.dial(proto.Hello{MachineID: "m-granite"}); code != 101 {
		t.Fatalf("adoption: %d %v", code, err)
	}
	s, _ := e.h.store.GetServer(ctx, "granite")
	if s.CertSerial != serial || !s.CertNotAfter.After(stored.CertNotAfter) {
		t.Fatalf("serial %s (want %s)", s.CertSerial, serial)
	}
	recs := e.audit("agent.certificate_adopted")
	if len(recs) != 2 || fmtRecs(recs) != "agent.certificate_adopted/ok/, agent.certificate_adopted/denied/machine_id_mismatch" {
		t.Fatalf("audit %s", fmtRecs(recs))
	}
	if recs[0].Details["previous_serial"] != stored.CertSerial {
		t.Errorf("audit details %v", recs[0].Details)
	}
	a.sess.Close()
	// After 14 days, the normal rule again.
	at = time.Now().Add(-15 * 24 * time.Hour)
	e.h.restoredAt.Store(&at)
	a.cert, _ = newerCert(t, e, a, time.Now().Add(2*time.Minute))
	if code, _ := a.dial(proto.Hello{MachineID: "m-granite"}); code != 403 {
		t.Fatalf("after 14 days: %d", code)
	}
}

func TestHubAddresses(t *testing.T) {
	ctx := context.Background()
	var mu sync.Mutex
	pfx := netip.MustParsePrefix
	ifs := []netaddrs.Interface{
		{Name: "lo", Up: true, Loopback: true, Prefixes: []netip.Prefix{pfx("127.0.0.1/8"), pfx("::1/128")}},
		{Name: "enp1s0", Up: true, Prefixes: []netip.Prefix{pfx("10.100.1.158/24"), pfx("fe80::1/64"), pfx("fd00::5/64")}},
		{Name: "vmbr0", Up: true, Prefixes: []netip.Prefix{pfx("192.168.5.2/24")}},
		{Name: "docker0", Up: true, Prefixes: []netip.Prefix{pfx("172.17.0.1/16")}},
		{Name: "wbc0", Up: true, Prefixes: []netip.Prefix{pfx("10.200.0.1/24")}},
		{Name: "incusbr0", Up: true, Prefixes: []netip.Prefix{pfx("10.201.0.1/24")}},
		{Name: "tailscale0", Up: true, Prefixes: []netip.Prefix{pfx("100.64.0.3/32")}},
		{Name: "enp2s0", Up: false, Prefixes: []netip.Prefix{pfx("10.100.2.9/24")}},
	}
	e, admin := adminEnv(t, func(c *Config) {
		c.AgentURL = "wss://hosts.example:8443"
		c.AgentListen = ":8443"
		c.Interfaces = func() ([]netaddrs.Interface, error) {
			mu.Lock()
			defer mu.Unlock()
			return slices.Clone(ifs), nil
		}
	})
	want := []string{"wss://hosts.example:8443", "wss://10.100.1.158:8443", "wss://192.168.5.2:8443", "wss://[fd00::5]:8443"}
	if got := e.h.hubAddrs(ctx); !slices.Equal(got, want) {
		t.Fatalf("addrs = %v", got)
	}
	a := e.enroll(admin, "granite", "")
	if code, err := a.dial(proto.Hello{MachineID: "m-granite"}); code != 101 {
		t.Fatal(code, err)
	}
	if !slices.Equal(a.ack.Addrs, want) {
		t.Fatalf("hello_ack addrs = %v", a.ack.Addrs)
	}
	// The hub answers hello before it records the connection: a change sent
	// in between would reach nobody.
	waitFor(t, "the connection recorded", 5*time.Second, func() bool {
		ids, _ := e.h.connectedServers()
		return len(ids) == 1
	})
	// Unchanged: nothing is sent.
	e.h.refreshAddrs(ctx)
	// A new address: every agent hears it once.
	mu.Lock()
	ifs[1].Prefixes = []netip.Prefix{pfx("10.100.1.160/24")}
	mu.Unlock()
	e.h.refreshAddrs(ctx)
	e.h.refreshAddrs(ctx)
	want = []string{"wss://hosts.example:8443", "wss://10.100.1.160:8443", "wss://192.168.5.2:8443"}
	waitFor(t, "hub_addrs", 5*time.Second, func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		return len(a.hubAddrs) > 0
	})
	a.mu.Lock()
	got := a.hubAddrs
	a.mu.Unlock()
	if len(got) != 1 || !slices.Equal(got[0], want) {
		t.Fatalf("hub_addrs = %v", got)
	}
}

func TestAgentURLChangeIsRemembered(t *testing.T) {
	ctx := context.Background()
	lan := "10.100.1.160"
	var mu sync.Mutex
	lanAddress = func() (string, error) { mu.Lock(); defer mu.Unlock(); return lan, nil }
	t.Cleanup(func() { lanAddress = defaultRouteAddr })
	dir := t.TempDir()
	tweak := func(c *Config) {
		c.DataDir, c.ServiceTokenFile = dir, filepath.Join(dir, "service-token")
		c.AgentURL, c.AgentListen = "auto", ":8443"
	}
	e := headlessEnv(t, tweak)
	hub := hubInfo(t, e.service("pe_1|John"))
	if hub["agent_url"] != "wss://10.100.1.160:8443" || hub["agent_url_previous"] != nil || hub["agent_url_changed_at"] != nil {
		t.Fatalf("first start: %v", hub)
	}
	e.stop()
	// The box got another address while it was off.
	mu.Lock()
	lan = "10.100.1.158"
	mu.Unlock()
	e2 := headlessEnv(t, tweak)
	hub = hubInfo(t, e2.service("pe_1|John"))
	if hub["agent_url"] != "wss://10.100.1.158:8443" || hub["agent_url_previous"] != "wss://10.100.1.160:8443" || hub["agent_url_changed_at"] == nil {
		t.Fatalf("after the change: %v", hub)
	}
	// It stays until the next change, also across restarts.
	e2.stop()
	e3 := headlessEnv(t, tweak)
	if hub = hubInfo(t, e3.service("pe_1|John")); hub["agent_url_previous"] != "wss://10.100.1.160:8443" {
		t.Fatalf("after a restart: %v", hub)
	}
	// A change while it runs is noticed by the address check.
	mu.Lock()
	lan = "10.100.1.170"
	mu.Unlock()
	e3.h.lan = lanURL{}
	e3.h.refreshAddrs(ctx)
	if hub = hubInfo(t, e3.service("pe_1|John")); hub["agent_url"] != "wss://10.100.1.170:8443" || hub["agent_url_previous"] != "wss://10.100.1.158:8443" {
		t.Fatalf("while running: %v", hub)
	}
}

func TestInstallBackupUndo(t *testing.T) {
	ctx := context.Background()
	src := headlessEnv(t, nil)
	var buf bytes.Buffer
	if err := src.h.Backup(ctx, &buf); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	before := map[string]string{"hub.db": "old db", "hub.db-wal": "old wal", "ca.crt": "old ca", "ca.key": "old key",
		"agent-listener.crt": "old listener"}
	for n, v := range before {
		os.WriteFile(filepath.Join(dir, n), []byte(v), 0o600)
	}
	x, err := extractBackup(ctx, bytes.NewReader(buf.Bytes()), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer x.close()
	undo, err := installBackup(ctx, dir, x, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "ca.crt")); string(b) == "old ca" {
		t.Fatal("not installed")
	}
	undo()
	for n, v := range before {
		if b, err := os.ReadFile(filepath.Join(dir, n)); string(b) != v {
			t.Errorf("%s = %q %v", n, b, err)
		}
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "*.bak")); len(m) != 0 {
		t.Errorf("left %v", m)
	}
	if _, err := os.Stat(filepath.Join(dir, "agent-listener.key")); !os.IsNotExist(err) {
		t.Error("undo made a file that wasn't there")
	}
}
