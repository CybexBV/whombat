package hub

import (
	"crypto/sha256"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/proto"
)

func TestDownloadable(t *testing.T) {
	for _, ok := range []string{"whombat-agent-linux-amd64", "whombat-agent-linux-arm64", "whombat-agent-darwin-amd64",
		"whombat-agent-darwin-arm64", "whombat-helper-macos.zip", "whombat-helper-macos.json"} {
		if !downloadable(ok) {
			t.Errorf("%s refused", ok)
		}
	}
	for _, bad := range []string{"manifest.json", "whombat-agent-windows-amd64", "../whombat-agent-linux-amd64", "whombat-agent-darwin-riscv64"} {
		if downloadable(bad) {
			t.Errorf("%s served", bad)
		}
	}
}

func TestMacHelperBuild(t *testing.T) {
	dist := t.TempDir()
	h := &Hub{cfg: Config{AgentDist: dist}, log: slog.New(slog.DiscardHandler)}
	if _, _, _, ok := h.macHelper(); ok {
		t.Fatal("no helper in an empty dist")
	}
	zip := []byte("signed helper zip")
	sum := fmt.Sprintf("%x", sha256.Sum256(zip))
	os.WriteFile(filepath.Join(dist, helperZip), zip, 0o644)
	os.WriteFile(filepath.Join(dist, helperJSON), []byte(fmt.Sprintf(`{"version":"1.2.0","sha256":"%s","size":%d}`, sum, len(zip))), 0o644)
	if v, s, _, ok := h.macHelper(); !ok || v != "1.2.0" || s != sum {
		t.Fatalf("%q %q %v", v, s, ok)
	}
	// A zip that isn't the one described is not offered.
	os.WriteFile(filepath.Join(dist, helperZip), []byte("signed helper zap"), 0o644)
	later := time.Now().Add(time.Minute) // the digest cache goes by size and time
	os.Chtimes(filepath.Join(dist, helperZip), later, later)
	if _, _, _, ok := h.macHelper(); ok {
		t.Fatal("a mismatching zip is offered")
	}
}

func TestUpdateBuildByOS(t *testing.T) {
	m := &agentManifest{Version: updBuild, Key: "k1"}
	m.Files = map[string]manifestFile{
		"whombat-agent-linux-amd64":  {Arch: "amd64"},
		"whombat-agent-darwin-arm64": {OS: "darwin", Arch: "arm64"},
		"whombat-agent-darwin-amd64": {Arch: "amd64"}, // mislabelled: not a macOS build
	}
	rep := func(goos, arch string) *proto.Report {
		r := &proto.Report{}
		r.Agent.OS, r.Agent.Arch, r.Agent.Version, r.Agent.UpdateKey, r.Policy.Update = goos, arch, updOld, "k1", true
		return r
	}
	for _, c := range []struct {
		goos, arch, name string
		ok               bool
	}{
		{"", "", "whombat-agent-linux-amd64", true},
		{"", "arm64", "whombat-agent-linux-arm64", false},
		{"darwin", "arm64", "whombat-agent-darwin-arm64", true},
		{"darwin", "amd64", "whombat-agent-darwin-amd64", false},
	} {
		name, _, ok := m.build(rep(c.goos, c.arch))
		if name != c.name || ok != c.ok {
			t.Errorf("%s/%s: %s %v", c.goos, c.arch, name, ok)
		}
	}
	st := &model.ServerState{ID: "mac", Connected: true, Report: rep("darwin", "amd64")}
	if code, _ := updateReason(st, m); code != updNoBuild {
		t.Errorf("a Mac without its build: %q", code)
	}
	st.Report = rep("darwin", "arm64")
	if code, _ := updateReason(st, m); code != "" {
		t.Errorf("a Mac with its build: %q", code)
	}
	// Linux agents keep the old rule: the manifest's file is looked up when
	// the update is sent.
	st.Report = rep("", "arm64")
	if code, _ := updateReason(st, m); code != "" {
		t.Errorf("linux: %q", code)
	}
}
