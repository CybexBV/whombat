package agent

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/proto"
)

type toggleCollector struct {
	mu  sync.Mutex
	got *Collectors
}

func (c *toggleCollector) Collect(context.Context) (*proto.Report, error) {
	return &proto.Report{}, nil
}
func (c *toggleCollector) Events() <-chan proto.Event { return nil }
func (c *toggleCollector) SetCollectors(cc Collectors) {
	c.mu.Lock()
	c.got = &cc
	c.mu.Unlock()
}

// Reload applies remote control and collector toggles, logs exactly what
// changed, and names settings that need a restart instead of claiming them.
func TestReloadLogsWhatChanged(t *testing.T) {
	dir := t.TempDir()
	write := func(s string) {
		if err := os.WriteFile(filepath.Join(dir, ConfigFileName), []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("hub = \"wss://a:8443\"\n[remote_control]\nconsole = false\n")
	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	rt := NewRuntime(cfg, "test", slog.New(slog.NewTextHandler(&logs, nil)))
	col := &toggleCollector{}
	rt.Collector = col

	if err := rt.Reload(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(logs.String(), "configuration reloaded: no changes") {
		t.Fatalf("unchanged reload logged: %s", logs.String())
	}

	logs.Reset()
	write("hub = \"wss://b:8443\"\n[remote_control]\nconsole = true\n[collectors]\ndocker = false\nimage_updates = false\n")
	if err := rt.Reload(); err != nil {
		t.Fatal(err)
	}
	out := logs.String()
	for _, want := range []string{"remote_control.console: false -> true", "collectors.docker: auto -> false",
		"collectors.image_updates: auto -> false", `need an agent restart`, `hub: \"wss://a:8443\" -> \"wss://b:8443\"`} {
		if !strings.Contains(out, want) {
			t.Errorf("log lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "power") {
		t.Errorf("unchanged setting logged:\n%s", out)
	}
	if c := rt.Config(); !c.RemoteControl.Console || c.Hub != "wss://a:8443" || c.Collectors.Docker == nil || *c.Collectors.Docker {
		t.Errorf("applied config: %+v", c)
	}
	col.mu.Lock()
	defer col.mu.Unlock()
	if col.got == nil || col.got.Docker == nil || *col.got.Docker || col.got.ImageUpdates == nil {
		t.Errorf("collector toggles not passed on: %+v", col.got)
	}
}

// applyBroker records the configurations the runtime hands to a broker
// that acts on them (the Proxmox VE manage token).
type applyBroker struct {
	fakeBroker
	got chan *Config
}

func (b *applyBroker) ApplyConfig(ctx context.Context, cfg *Config) { b.got <- cfg }

func TestReloadAppliesBrokerConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ConfigFileName)
	if err := os.WriteFile(path, []byte("hub = \"wss://a:8443\"\n[remote_control]\nmanage = false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PVE.ManageTokenFile != filepath.Join(dir, "pve-manage-token") {
		t.Fatalf("manage token file default %q", cfg.PVE.ManageTokenFile)
	}
	rt := NewRuntime(cfg, "test", slog.New(slog.NewTextHandler(io.Discard, nil)))
	rt.Collector = &toggleCollector{}
	b := &applyBroker{got: make(chan *Config, 1)}
	rt.Broker = b
	if err := os.WriteFile(path, []byte("hub = \"wss://a:8443\"\n[remote_control]\nmanage = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := rt.Reload(); err != nil {
		t.Fatal(err)
	}
	select {
	case c := <-b.got:
		if !c.RemoteControl.Manage {
			t.Fatal("broker got the old configuration")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("broker not told about the reload")
	}
}
