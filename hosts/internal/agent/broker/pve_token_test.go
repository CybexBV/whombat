package broker

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// fakePveum answers pveum like PVE 8.4 (or older without
// Sys.AccessNetwork) and records the commands.
type fakePveum struct {
	calls   [][]string
	roles   map[string][]string
	network bool   // this version knows Sys.AccessNetwork
	failOn  string // a command prefix that fails
	failMsg string
	tokens  int
}

var pveVMAdminPrivs = []string{"Datastore.AllocateSpace", "Datastore.Audit", "Pool.Allocate", "SDN.Use", "Sys.Audit", "Sys.Console", "Sys.Syslog",
	"VM.Allocate", "VM.Audit", "VM.Backup", "VM.Clone", "VM.Config.CDROM", "VM.Config.CPU", "VM.Config.Cloudinit", "VM.Config.Disk",
	"VM.Config.HWType", "VM.Config.Memory", "VM.Config.Network", "VM.Config.Options", "VM.Console", "VM.GuestAgent.Audit",
	"VM.GuestAgent.FileRead", "VM.GuestAgent.FileWrite", "VM.GuestAgent.FileSystemMgmt", "VM.GuestAgent.Unrestricted",
	"VM.Migrate", "VM.Monitor", "VM.PowerMgmt", "VM.Snapshot", "VM.Snapshot.Rollback"}

func newFakePveum(network bool) *fakePveum {
	admin := append([]string{"Datastore.Allocate", "Datastore.AllocateTemplate", "Group.Allocate", "Mapping.Audit", "Permissions.Modify",
		"Pool.Audit", "Realm.Allocate", "SDN.Allocate", "SDN.Audit", "Sys.Modify", "Sys.PowerMgmt", "User.Modify", "VM.Replicate"}, pveVMAdminPrivs...)
	if network {
		admin = append(admin, "Sys.AccessNetwork")
	}
	vmAdmin := append([]string(nil), pveVMAdminPrivs...)
	return &fakePveum{network: network, roles: map[string][]string{"Administrator": admin, "PVEVMAdmin": append(vmAdmin, "VM.Replicate"), "PVEAuditor": {"VM.Audit", "Sys.Audit"}}}
}

func (p *fakePveum) run(ctx context.Context, argv ...string) ([]byte, error) {
	p.calls = append(p.calls, argv)
	cmd := strings.Join(argv, " ")
	if p.failOn != "" && strings.HasPrefix(cmd, p.failOn) {
		return nil, errors.New("pveum: " + p.failMsg)
	}
	switch {
	case cmd == "pveum role list --output-format json":
		var out []map[string]any
		for id, privs := range p.roles {
			out = append(out, map[string]any{"roleid": id, "privs": strings.Join(privs, ","), "special": 0})
		}
		return json.Marshal(out)
	case strings.HasPrefix(cmd, "pveum role add ") || strings.HasPrefix(cmd, "pveum role modify "):
		p.roles[argv[3]] = strings.Split(argv[5], ",")
	case strings.HasPrefix(cmd, "pveum user token add "):
		p.tokens++
		return json.Marshal(map[string]any{"full-tokenid": argv[4] + "!" + argv[5], "info": map[string]any{"privsep": "0"},
			"value": "11111111-2222-3333-4444-55555555555" + string(rune('0'+p.tokens))})
	}
	return nil, nil
}

func (p *fakePveum) commands() []string {
	var out []string
	for _, c := range p.calls {
		out = append(out, strings.Join(c, " "))
	}
	return out
}

func newTokenManage(t *testing.T, p *fakePveum) *pveManage {
	return &pveManage{node: "pve1", baseURL: "https://127.0.0.1:8006/api2/json", tokenFile: filepath.Join(t.TempDir(), "etc", "pve-manage-token"),
		run: p.run, isNode: func() bool { return true }, now: time.Now, newAPI: newPVEAPI}
}

func TestManageRolePrivs(t *testing.T) {
	known := map[string]bool{}
	for _, p := range newFakePveum(true).roles["Administrator"] {
		known[p] = true
	}
	got := manageRolePrivs(pveVMAdminPrivs, known)
	for _, p := range []string{"VM.Console", "VM.Monitor", "VM.GuestAgent.Unrestricted", "VM.GuestAgent.FileRead", "Sys.Modify", "Sys.AccessNetwork", "Permissions.Modify"} {
		for _, g := range got {
			if g == p {
				t.Fatalf("%s granted: %v", p, got)
			}
		}
	}
	for _, p := range []string{"VM.GuestAgent.Audit", "VM.Config.Disk", "VM.Allocate", "Datastore.AllocateTemplate", "SDN.Audit", "Pool.Audit", "Sys.Audit"} {
		found := false
		for _, g := range got {
			found = found || g == p
		}
		if !found {
			t.Fatalf("%s missing: %v", p, got)
		}
	}
	// Privileges this version does not know are left out.
	delete(known, "SDN.Audit")
	for _, g := range manageRolePrivs(pveVMAdminPrivs, known) {
		if g == "SDN.Audit" {
			t.Fatal("unknown privilege granted")
		}
	}
}

func TestPVEManageTokenProvision(t *testing.T) {
	p := newFakePveum(true)
	m := newTokenManage(t, p)
	did, err := m.apply(context.Background(), true)
	if err != nil || did != "created" {
		t.Fatalf("apply: %q %v", did, err)
	}
	privs := strings.Join(manageRolePrivs(p.roles["PVEVMAdmin"], toSet(p.roles["Administrator"])), ",")
	want := []string{
		"pveum role list --output-format json",
		"pveum role add WhombatManage --privs " + privs,
		"pveum user add whombat-manage@pve --comment Whombat agent (manage)",
		"pveum acl modify / --users whombat-manage@pve --roles WhombatManage",
		"pveum role add WhombatNetwork --privs Sys.AccessNetwork",
		"pveum acl modify /nodes/pve1 --users whombat-manage@pve --roles WhombatNetwork",
		"pveum user token remove whombat-manage@pve agent-pve1",
		"pveum user token add whombat-manage@pve agent-pve1 --privsep 0 --comment Whombat agent (manage) on pve1 --output-format json",
	}
	if got := p.commands(); !reflect.DeepEqual(got, want) {
		t.Fatalf("commands\n got %q\nwant %q", got, want)
	}
	st, err := os.Stat(m.tokenFile)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("token file %v %v", st, err)
	}
	b, _ := os.ReadFile(m.tokenFile)
	if string(b) != "whombat-manage@pve!agent-pve1=11111111-2222-3333-4444-555555555551\n" {
		t.Fatalf("token file %q", b)
	}

	// Again (reload): the role is brought up to date, the token stays.
	p.calls = nil
	p.roles["PVEVMAdmin"] = append(p.roles["PVEVMAdmin"], "VM.Snapshot.New")
	p.roles["Administrator"] = append(p.roles["Administrator"], "VM.Snapshot.New")
	did, err = m.apply(context.Background(), true)
	if err != nil || did != "" {
		t.Fatalf("second apply: %q %v", did, err)
	}
	got := p.commands()
	if len(got) != 6 || !strings.HasPrefix(got[1], "pveum role modify WhombatManage --privs ") || !strings.Contains(got[1], "VM.Snapshot.New") ||
		got[4] != "pveum role modify WhombatNetwork --privs Sys.AccessNetwork" || p.tokens != 1 {
		t.Fatalf("second apply commands %q", got)
	}

	// Off: the token and its file go; user and roles stay.
	p.calls = nil
	did, err = m.apply(context.Background(), false)
	if err != nil || did != "removed" {
		t.Fatalf("off: %q %v", did, err)
	}
	if got := p.commands(); !reflect.DeepEqual(got, []string{"pveum user token remove whombat-manage@pve agent-pve1"}) {
		t.Fatalf("off commands %q", got)
	}
	if _, err := os.Stat(m.tokenFile); !os.IsNotExist(err) {
		t.Fatal("token file kept")
	}
	// Off again: nothing to do.
	p.calls = nil
	if did, err = m.apply(context.Background(), false); err != nil || did != "" || len(p.calls) != 0 {
		t.Fatalf("off again: %q %v %q", did, err, p.commands())
	}
}

func toSet(list []string) map[string]bool {
	m := map[string]bool{}
	for _, v := range list {
		m[v] = true
	}
	return m
}

func TestPVEManageTokenOldPVE(t *testing.T) {
	p := newFakePveum(false)
	m := newTokenManage(t, p)
	if _, err := m.apply(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	for _, c := range p.commands() {
		if strings.Contains(c, "WhombatNetwork") || strings.Contains(c, "AccessNetwork") {
			t.Fatalf("network role on PVE without Sys.AccessNetwork: %q", c)
		}
	}
}

func TestPVEManageTokenFailures(t *testing.T) {
	p := newFakePveum(true)
	p.failOn, p.failMsg = "pveum acl modify /", "ipcc_send_rec[1] failed: Connection refused"
	m := newTokenManage(t, p)
	if _, err := m.apply(context.Background(), true); err == nil || !strings.Contains(err.Error(), "Connection refused") {
		t.Fatalf("apply: %v", err)
	}
	// Operations report the failure without retrying for a while.
	p.calls = nil
	_, err := m.client(context.Background())
	if code, msg := errCode(err, ""); code != CodePlatformError || !strings.Contains(msg, "Connection refused") || len(p.calls) != 0 {
		t.Fatalf("client: %v %q", err, p.commands())
	}
	// Then they try again, and it works.
	p.failOn = ""
	m.provAt = m.provAt.Add(-2 * pveProvisionRetry)
	if api, err := m.client(context.Background()); err != nil || api == nil || api.token != "whombat-manage@pve!agent-pve1=11111111-2222-3333-4444-555555555551" {
		t.Fatalf("retry: %v", err)
	}

	// Removal that PVE refuses keeps the file for the next attempt.
	p.failOn, p.failMsg = "pveum user token remove", "cfs-lock 'file-user_cfg' error: got lock request timeout"
	if _, err := m.apply(context.Background(), false); err == nil {
		t.Fatal("removal failure not reported")
	}
	if _, err := os.Stat(m.tokenFile); err != nil {
		t.Fatal("token file removed although the token was not")
	}
	// A token that is already gone in PVE: the file goes.
	p.failMsg = "no such token 'agent-pve1' for user 'whombat-manage@pve'"
	if did, err := m.apply(context.Background(), false); err != nil || did != "removed" {
		t.Fatalf("removal of a missing token: %q %v", did, err)
	}
}

func TestPVEManageNotANode(t *testing.T) {
	p := newFakePveum(true)
	m := newTokenManage(t, p)
	m.isNode = func() bool { return false }
	if did, err := m.apply(context.Background(), true); did != "" || err != nil || len(p.calls) != 0 {
		t.Fatalf("apply on a non-PVE host: %q %v %q", did, err, p.commands())
	}
	if _, err := m.client(context.Background()); err == nil {
		t.Fatal("client without a token on a non-PVE host")
	}
}

func TestReadManageToken(t *testing.T) {
	dir := t.TempDir()
	for content, ok := range map[string]bool{
		"whombat-manage@pve!agent-pve1=abc\n": true,
		"whombat@pve!agent-pve1=abc":          false, // the read-only token
		"whombat-manage@pve!agent-pve1=":      false,
		"whombat-manage@pve!agent-pve1":       false,
		"whombat-manage@pve!a b=c":            false,
	} {
		path := filepath.Join(dir, "tok")
		os.WriteFile(path, []byte(content), 0o600)
		if _, err := readManageToken(path); (err == nil) != ok {
			t.Errorf("%q: %v", content, err)
		}
	}
	if pveManageTokenID("pve 01.lan") != "agent-pve-01.lan" || pveManageTokenID("") != "agent" {
		t.Fatal("token id")
	}
}

func TestRunCommand(t *testing.T) {
	out, err := runCommand(context.Background(), "sh", "-c", "echo out; echo LC_ALL=$LC_ALL")
	if err != nil || string(out) != "out\nLC_ALL=C\n" {
		t.Fatalf("run: %q %v", out, err)
	}
	if _, err := runCommand(context.Background(), "sh", "-c", "echo progress; echo 'first problem' >&2; echo second >&2; exit 3"); err == nil || err.Error() != "sh: first problem" {
		t.Fatalf("failure: %v", err)
	}
}
