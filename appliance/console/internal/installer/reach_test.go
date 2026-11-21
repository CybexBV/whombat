package installer

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func checkIDList(st State) string {
	var ids []string
	for _, c := range st.Preflight.Checks {
		ids = append(ids, c.ID)
	}
	return strings.Join(ids, ",")
}

// preflightFor posts the reach step's choice and waits for the checks it starts.
func (hs *harness) preflightFor(t *testing.T, body string) State {
	t.Helper()
	if code, out := hs.do("POST", "/api/preflight", body); code != http.StatusAccepted {
		t.Fatalf("preflight %s: %d %v", body, code, out)
	}
	waitFor(t, "the checks", func() bool { return hs.srv.State().Preflight.Status == "done" })
	return hs.srv.State()
}

// The reach checks follow the owner's choice (LNK-12): control and the relay for Link, the login server for Tailscale.
func TestReachChecks(t *testing.T) {
	f := newFake()
	f.reach["controlplane.tailscale.com"] = true
	f.reach["hs.example.com:8443"] = true
	f.reach["api.whombat.com"] = true
	f.reach["relay.whombat.com"] = false
	hs := newHarness(t, f)

	st := hs.preflightFor(t, `{"reach":{"link":false,"tailscale":true}}`)
	if checkIDList(st) != "uefi,cpu,memory,disk,network,reach-updates,reach-login" {
		t.Fatal(checkIDList(st))
	}
	if c := checks(st)["reach-login"]; c.Status != "ok" || c.Value != "controlplane.tailscale.com" {
		t.Fatalf("%+v", c)
	}
	// The owner's own login server, with its port.
	st = hs.preflightFor(t, `{"reach":{"link":false,"tailscale":true,"loginServer":"https://hs.example.com:8443/base"}}`)
	if c := checks(st)["reach-login"]; c.Status != "ok" || c.Value != "hs.example.com:8443" {
		t.Fatalf("%+v", c)
	}
	// "Check again" keeps the last choice.
	if st := hs.preflight(t); checks(st)["reach-login"].Value != "hs.example.com:8443" {
		t.Fatalf("%+v", st.Preflight.Checks)
	}
	// Both: the image's control and relay (the relay isn't reachable: a warning) and the login server.
	st = hs.preflightFor(t, `{"reach":{"link":true,"tailscale":true}}`)
	if checkIDList(st) != strings.Join(CheckIDs, ",") {
		t.Fatal(checkIDList(st))
	}
	c := checks(st)
	if c["reach-api"].Status != "ok" || c["reach-api"].Value != "api.whombat.com" ||
		c["reach-relay"].Status != "warn" || c["reach-relay"].Value != "relay.whombat.com" ||
		c["reach-login"].Value != "controlplane.tailscale.com" {
		t.Fatalf("%+v", c)
	}
	// A body without a choice: the default, Link in the image's environment.
	st = hs.preflightFor(t, `{}`)
	if checkIDList(st) != "uefi,cpu,memory,disk,network,reach-api,reach-updates,reach-relay" ||
		checks(st)["reach-api"].Value != "api.whombat.com" {
		t.Fatal(checkIDList(st), checks(st))
	}

	for body, want := range map[string]string{
		`{"reach":{"link":false,"tailscale":false}}`:                                        "reach",
		`{"reach":{"link":true,"tailscale":false,"loginServer":"https://a.example.com"}}`:   "reach",
		`{"reach":{"link":false,"tailscale":true,"loginServer":"http://a.example.com"}}`:    "reach",
		`{"reach":{"link":false,"tailscale":true,"loginServer":"https://a.example.com?x"}}`: "reach",
		`{"reach":{"link":false,"tailscale":true,"loginServer":"https://u@a.example.com"}}`: "reach",
		// No developer option any more (ONE-02): any environment is refused, the old one too.
		`{"reach":{"link":true,"tailscale":false},"environment":"dev"}`:  "environment",
		`{"reach":{"link":true,"tailscale":false},"environment":"prod"}`: "environment",
	} {
		if code, out := hs.do("POST", "/api/preflight", body); code != 400 || out["message"] != want {
			t.Errorf("%s: %d %v", body, code, out)
		}
	}
	if code, _ := hs.do("POST", "/api/preflight", `{"reach":`); code != 400 {
		t.Errorf("broken json: %d", code)
	}
	// A refused choice keeps the last one.
	if st := hs.preflight(t); checks(st)["reach-api"].Value != "api.whombat.com" {
		t.Fatalf("%+v", st.Preflight.Checks)
	}
}

// A community image has no Whombat Link: no choice by default, and Link is refused.
func TestCommunityReach(t *testing.T) {
	im := testImage
	im.Edition = "community"
	srv := New(t.Context(), im, "WHOMBAT-INSTALLER", newFake())
	srv.addrWait = 50 * time.Millisecond
	if srv.State().Edition != "community" {
		t.Fatal(srv.State())
	}
	if err := srv.StartPreflightFor(&ReachChoice{Link: true}, ""); err != ErrReach {
		t.Fatal(err)
	}
	if err := srv.StartPreflightFor(&ReachChoice{Tailscale: true}, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the checks", func() bool { return srv.State().Preflight.Status == "done" })
	if got := checkIDList(srv.State()); got != "uefi,cpu,memory,disk,network,reach-updates,reach-login" {
		t.Fatal(got)
	}
}

// The choice reaches whombat-install; an install without one (an older scripted install) gets Whombat Link.
func TestInstallReach(t *testing.T) {
	hs := newHarness(t, newFake())
	hs.preflight(t)
	for body, want := range map[string]string{
		`{"disk":"/dev/sda","confirm":"sda","reach":{"link":false,"tailscale":false}}`:                          "reach",
		`{"disk":"/dev/sda","confirm":"sda","reach":{"link":false,"tailscale":true,"loginServer":"ftp://x.y"}}`: "reach",
		`{"disk":"/dev/sda","confirm":"sda","reach":{"link":true,"tailscale":false},"environment":"dev"}`:       "environment",
	} {
		if code, out := hs.do("POST", "/api/install", body); code != 400 || out["message"] != want {
			t.Errorf("%s: %d %v", body, code, out)
		}
	}
	if len(hs.sys.jobs) != 0 {
		t.Fatal("a refused install ran")
	}
	body := `{"disk":"/dev/sda","confirm":"sda","reach":{"link":false,"tailscale":true,"loginServer":"https://hs.example.com"}}`
	if code, out := hs.do("POST", "/api/install", body); code != http.StatusAccepted {
		t.Fatal(code, out)
	}
	waitFor(t, "done", func() bool { return hs.srv.State().Install.Status == "done" })
	j := hs.sys.jobs[0]
	if j.Reach == nil || j.Reach.Link || !j.Reach.Tailscale || j.Reach.LoginServer != "https://hs.example.com" {
		t.Fatalf("%+v", j)
	}

	hs = newHarness(t, newFake())
	hs.preflight(t)
	if code, _ := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != http.StatusAccepted {
		t.Fatal(code)
	}
	waitFor(t, "done", func() bool { return hs.srv.State().Install.Status == "done" })
	// No choice in the request (an older scripted install): none is written; the owner chooses in the apps later.
	if j := hs.sys.jobs[0]; j.Reach != nil {
		t.Fatalf("%+v", j)
	}
}

func TestInstallArgsReach(t *testing.T) {
	for _, tc := range []struct {
		job  Job
		want string
	}{
		{Job{Disk: "/dev/sda"}, "--disk /dev/sda --yes-erase-disk"},
		{Job{Disk: "/dev/sda", Reach: &ReachChoice{Link: true}}, "--disk /dev/sda --yes-erase-disk --reach link"},
		{Job{Disk: "/dev/sda", Reach: &ReachChoice{Tailscale: true}}, "--disk /dev/sda --yes-erase-disk --reach tailscale"},
		{Job{Disk: "/dev/sda", Reach: &ReachChoice{Link: true, Tailscale: true, LoginServer: "https://hs.example.com"}},
			"--disk /dev/sda --yes-erase-disk --reach both --login-server https://hs.example.com"},
		{Job{Disk: "/dev/sda", WifiProfile: "/run/x/Home.psk", Reach: &ReachChoice{Tailscale: true, LoginServer: "https://hs.example.com:8443"}},
			"--disk /dev/sda --yes-erase-disk --wifi-profile /run/x/Home.psk --reach tailscale --login-server https://hs.example.com:8443"},
		// A choice of nothing writes nothing (the server refuses one before it gets here).
		{Job{Disk: "/dev/sda", Reach: &ReachChoice{}}, "--disk /dev/sda --yes-erase-disk"},
	} {
		if got := strings.Join(InstallArgs(nil, tc.job), " "); got != tc.want {
			t.Errorf("%+v:\n got %s\nwant %s", tc.job, got, tc.want)
		}
	}
}

func TestLoginHost(t *testing.T) {
	for in, want := range map[string]string{
		"":                               "controlplane.tailscale.com",
		"https://hs.example.com":         "hs.example.com",
		"https://hs.example.com/":        "hs.example.com",
		"https://hs.example.com:8443/x/": "hs.example.com:8443",
		"https://localhost":              "",
	} {
		if got := loginHost(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}
