package hub

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/proto"
)

func TestWindowsDownloads(t *testing.T) {
	for _, ok := range []string{"whombat-agent-windows-amd64.exe", "whombat-agent-windows-arm64.exe"} {
		if !downloadable(ok) {
			t.Errorf("%s refused", ok)
		}
	}
	for _, bad := range []string{"whombat-agent-windows-amd64", "whombat-agent-windows-386.exe", "whombat-agent-linux-amd64.exe"} {
		if downloadable(bad) {
			t.Errorf("%s served", bad)
		}
	}
	if got := agentFileName("windows", "arm64"); got != "whombat-agent-windows-arm64.exe" {
		t.Errorf("windows build name %q", got)
	}
}

func TestUpdateBuildWindows(t *testing.T) {
	m := &agentManifest{Version: updBuild, Key: "k1"}
	m.Files = map[string]manifestFile{
		"whombat-agent-windows-amd64.exe": {OS: "windows", Arch: "amd64"},
		"whombat-agent-windows-arm64.exe": {Arch: "arm64"}, // mislabelled: not a Windows build
	}
	rep := func(arch string) *proto.Report {
		r := &proto.Report{}
		r.Agent.OS, r.Agent.Arch, r.Agent.Version, r.Agent.UpdateKey, r.Policy.Update = "windows", arch, updOld, "k1", true
		return r
	}
	if name, _, ok := m.build(rep("amd64")); !ok || name != "whombat-agent-windows-amd64.exe" {
		t.Errorf("amd64: %s %v", name, ok)
	}
	st := &model.ServerState{ID: "pc", Connected: true, Report: rep("arm64")}
	if code, _ := updateReason(st, m); code != updNoBuild {
		t.Errorf("a PC without its build: %q", code)
	}
	// A manifest of a hub from before Windows builds: no build, nothing sent.
	old := &agentManifest{Version: updBuild, Key: "k1", Files: map[string]manifestFile{"whombat-agent-linux-amd64": {Arch: "amd64"}}}
	if code, _ := updateReason(&model.ServerState{ID: "pc", Connected: true, Report: rep("amd64")}, old); code != updNoBuild {
		t.Errorf("an old manifest: %q", code)
	}
}

func TestHeadlessWindowsInstallLine(t *testing.T) {
	lanAddress = func() (string, error) { return "127.0.0.1", nil }
	t.Cleanup(func() { lanAddress = defaultRouteAddr })
	dist := t.TempDir()
	e := headlessEnv(t, func(c *Config) { c.AgentURLAuto, c.AgentListen, c.AgentDist = true, "0.0.0.0:4743", dist })
	svc := e.service("pe_1|John")

	// No Windows build yet: no Windows line, the rest as before.
	var en map[string]any
	svc.json(http.MethodPost, "/api/v1/enrollments", nil, 201, &en)
	if _, ok := en["install_command_windows"]; ok || en["install_command"] == "" {
		t.Fatalf("without a Windows build: %v", en)
	}

	os.WriteFile(filepath.Join(dist, agentFileName("windows", "amd64")), []byte("windows build"), 0o644)
	svc.json(http.MethodPost, "/api/v1/enrollments", map[string]any{"control": "watch"}, 201, &en)
	line, _ := en["install_command_windows"].(string)
	token := en["token"].(string)
	for _, s := range []string{"$u='https://127.0.0.1:4743'", "-Hub 'wss://127.0.0.1:4743'", "-Token '" + token + "'",
		"-Control 'watch'", "/install.ps1", "SkipCertificateCheck"} {
		if !strings.Contains(line, s) {
			t.Errorf("the line lacks %q:\n%s", s, line)
		}
	}
	if en["uninstall_command_windows"] != WindowsUninstallLine {
		t.Errorf("uninstall line %v", en["uninstall_command_windows"])
	}

	// install.ps1 from the agent listener is the script whose SHA-256 the
	// line carries, with the authority's pin and the build's SHA-256.
	resp, err := e.agentHTTP(nil).Get(e.agent.URL + "/install.ps1")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	sum := sha256.Sum256(b)
	if !strings.Contains(line, "$s='"+hex.EncodeToString(sum[:])+"'") {
		t.Errorf("the line doesn't carry install.ps1's SHA-256")
	}
	script := string(b)
	for _, s := range []string{"$CASHA256 = '" + e.h.ca.Pin + "'",
		"AMD64 = '" + fileSHA256(filepath.Join(dist, agentFileName("windows", "amd64"))) + "'", "ARM64 = ''"} {
		if !strings.Contains(script, s) {
			t.Errorf("install.ps1 lacks %q", s)
		}
	}
	for i, r := range script {
		if r > 127 || r == '\r' {
			t.Fatalf("install.ps1 has %q at %d: keep it plain ASCII with LF", r, i)
		}
	}
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/plain") {
		t.Errorf("content type %q", resp.Header.Get("Content-Type"))
	}

	// The build downloads from the same listener.
	resp, err = e.agentHTTP(nil).Get(e.agent.URL + "/download/" + agentFileName("windows", "amd64"))
	if err != nil {
		t.Fatal(err)
	}
	b, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(b) != "windows build" {
		t.Fatalf("download: %d %q", resp.StatusCode, b)
	}
}

// Windows 10's PowerShell has no TLS 1.3: the agent listener takes 1.2,
// with forward-secret AEAD suites only.
func TestAgentListenerTLS12(t *testing.T) {
	lanAddress = func() (string, error) { return "127.0.0.1", nil }
	t.Cleanup(func() { lanAddress = defaultRouteAddr })
	e := headlessEnv(t, func(c *Config) { c.AgentURLAuto, c.AgentListen = true, "0.0.0.0:4743" })
	host := strings.TrimPrefix(e.agent.URL, "https://")
	c, err := tls.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}, "tcp", host, &tls.Config{RootCAs: e.h.ca.Pool(), ServerName: "127.0.0.1", MaxVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatal(err)
	}
	st := c.ConnectionState()
	c.Close()
	if st.Version != tls.VersionTLS12 || !strings.Contains(tls.CipherSuiteName(st.CipherSuite), "ECDHE_ECDSA") {
		t.Errorf("TLS %x with %s", st.Version, tls.CipherSuiteName(st.CipherSuite))
	}
	cbc := &tls.Config{RootCAs: e.h.ca.Pool(), ServerName: "127.0.0.1", MaxVersion: tls.VersionTLS12,
		CipherSuites: []uint16{tls.TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA}}
	if c, err := tls.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}, "tcp", host, cbc); err == nil {
		c.Close()
		t.Error("a CBC suite was accepted")
	}
}

func TestWindowsLineQuotes(t *testing.T) {
	line := windowsLine("https://pc.example.com:8443", "wss://pc.example.com:8443", "ab", "to'ken", "")
	if !strings.Contains(line, "-Token 'to''ken'") || strings.Contains(line, "-Control") {
		t.Errorf("line %s", line)
	}
}
