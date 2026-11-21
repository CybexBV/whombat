package daemon_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/clients"
	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/pkg/clientbundle"
	"github.com/CybexBV/whombat/appliance/release-tools/clientchannel"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// TestClientsInstallAndPush (MG-33): the runtime asks the manager to install Claude Code; the manager picks the
// bundle from the signed channel of the delegated clients role, installs it and pushes the status; a restarted
// runtime gets it again.
func TestClientsInstallAndPush(t *testing.T) {
	t.Parallel()
	base := "/dev/shm"
	if st, err := os.Stat(base); err != nil || !st.IsDir() {
		base = "/tmp"
	}
	root, err := os.MkdirTemp(base, "wbclients")
	if err != nil {
		t.Skip(err)
	}
	t.Cleanup(func() { _ = clientbundle.ForceRemove(root) })
	stateDir := filepath.Join(t.TempDir(), "clients-state")
	keys := filepath.Join(t.TempDir(), "channel-keys.json")
	h := startDaemon(t, map[string]any{"clients": map[string]any{"root": root, "stateDir": stateDir, "channelKeys": keys, "checkSec": 2}},
		func(w *testworld.World, _ *fakecontrol.Control, _ *config.Config) {
			if err := w.Repo.AddClientsRole(nil); err != nil {
				t.Fatal(err)
			}
			doc, _ := w.Repo.ClientChannelKeys()
			b, _ := json.Marshal(doc)
			os.WriteFile(keys, b, 0o644)
			src := filepath.Join(t.TempDir(), "claude")
			os.WriteFile(src, []byte("#!/bin/sh\necho claude\n"), 0o755)
			now := time.Now()
			built, err := clientchannel.Build(context.Background(), clientchannel.Input{Provider: "claude", Version: "2.1.290",
				Arch: clients.ArchOf(runtime.GOARCH), PublishedAt: now.Add(-time.Hour), TestedAt: now, FixturesDigest: "sha256:" + strings.Repeat("a", 64),
				// Not Anthropic's address: this test installs through the TUF target, with no network (the clients
				// package tests the download from Anthropic's site).
				Adapter: release.IntRange{Min: 1, Max: 1}, SourceURL: "https://example.invalid/claude-code-releases/2.1.290/linux-x64/claude",
				SourceFile: src, SourceFormat: "binary"}, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			if _, err := (&clientchannel.Publisher{Repo: w.Repo, Now: time.Now}).Publish([]clientchannel.Built{*built}, nil); err != nil {
				t.Fatal(err)
			}
			w.Runtime.SetAdapters(&local.RuntimeFactsClientAdapters{Claude: 1})
		})
	w := h.w
	sock := filepath.Join(filepath.Dir(w.P.HelperSock), "api.sock")
	hc := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", sock)
	}}}
	h.eventually("manager socket", func() bool { _, err := os.Stat(sock); return err == nil }, func() string { return sock })
	var status int
	h.eventually("install accepted", func() bool {
		resp, err := hc.Post("http://manager/v1/clients/install", "application/json", strings.NewReader(`{"v":1,"provider":"claude"}`))
		if err != nil {
			return false
		}
		resp.Body.Close()
		status = resp.StatusCode
		return status == http.StatusAccepted
	}, func() string { return fmt.Sprint(status) })
	installed := func() bool {
		c, _ := w.Runtime.Clients()
		return c != nil && c.Clients[0].State == local.LocalClientStateInstalled && c.Clients[0].Installed != nil &&
			c.Clients[0].Installed.Executable.Path == filepath.Join(root, "claude", "2.1.290", "claude")
	}
	detail := func() string { c, n := w.Runtime.Clients(); return fmt.Sprintf("%d pushes, last %+v", n, c) }
	h.eventually("claude installed and pushed", installed, detail)
	w.Runtime.Crash()
	if err := w.Runtime.Start(w.P.AdminSock); err != nil {
		t.Fatal(err)
	}
	h.eventually("clients pushed to the restarted runtime", installed, detail)
}
