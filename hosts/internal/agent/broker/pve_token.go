package broker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// The manage token (docs/MANAGE.md 2.2): a second API token, next to the
// collector's read-only one, with a role that can change guests but not
// the node, users or permissions.
const (
	pveManageUser  = "whombat-manage@pve"
	pveManageRole  = "WhombatManage"
	pveNetworkRole = "WhombatNetwork"
	// pveProvisionRetry: after a failed provisioning, operations report the
	// error for this long before the next attempt.
	pveProvisionRetry = time.Minute
	// pveTokenRejectedFor: a token PVE keeps refusing (revoked or deleted
	// there) is replaced after this long.
	pveTokenRejectedFor = time.Minute
)

// pveManageExtraPrivs are added to PVEVMAdmin's privileges: allocate disks
// and templates on storages, use and see bridges and SDN vnets, read the
// node, cluster and pool state the forms need, and migrate guests
// (PVEVMAdmin has VM.Migrate already; listed so the role keeps it).
var pveManageExtraPrivs = []string{"Datastore.AllocateSpace", "Datastore.AllocateTemplate", "Datastore.Audit",
	"SDN.Use", "SDN.Audit", "Sys.Audit", "Pool.Audit", "VM.Migrate"}

// manageRolePrivs is WhombatManage: PVEVMAdmin minus consoles, the QEMU
// monitor and guest agent commands (VM.GuestAgent.Audit stays), plus
// pveManageExtraPrivs, each only when this PVE version knows it.
func manageRolePrivs(vmAdmin []string, known map[string]bool) []string {
	set := map[string]bool{}
	for _, p := range vmAdmin {
		switch {
		case p == "VM.Console", p == "VM.Monitor":
		case strings.HasPrefix(p, "VM.GuestAgent.") && p != "VM.GuestAgent.Audit":
		default:
			set[p] = true
		}
	}
	for _, p := range pveManageExtraPrivs {
		if known[p] {
			set[p] = true
		}
	}
	out := make([]string, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// cmdRunner runs a command without a shell and returns its standard
// output; an error carries the first line of its error output. Tests
// replace it.
type cmdRunner func(ctx context.Context, argv ...string) ([]byte, error)

func runCommand(ctx context.Context, argv ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	name := argv[0]
	if _, err := exec.LookPath(name); err != nil && fileExists("/usr/sbin/"+name) {
		name = "/usr/sbin/" + name // PVE's tools, when the agent's PATH lacks sbin
	}
	cmd := exec.CommandContext(ctx, name, argv[1:]...)
	cmd.Env = append(baseEnv(), "LC_ALL=C")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("%s: timed out", argv[0])
		}
		msg := firstLine(stderr.String(), 300)
		if msg == "" {
			msg = err.Error()
		}
		out := stderr.String()
		if len(out) > 16<<10 {
			out = out[:16<<10]
		}
		return nil, &cmdError{name: argv[0], msg: msg, stderr: out}
	}
	return stdout.Bytes(), nil
}

// cmdError is a failed command: "<name>: <first line of its error
// output>", with the error output kept (up to 16 KiB) for callers that
// read more than the first line (pvesh's parameter errors).
type cmdError struct {
	name, msg, stderr string
}

func (e *cmdError) Error() string { return e.name + ": " + e.msg }

var manageTokenSanitize = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// pveManageTokenID is the token name: one per node ("agent-<node>"), as
// users and tokens are cluster-wide.
func pveManageTokenID(node string) string {
	if n := manageTokenSanitize.ReplaceAllString(node, "-"); n != "" {
		return "agent-" + n
	}
	return "agent"
}

// readManageToken reads the token file; only a token of pveManageUser
// counts.
func readManageToken(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	tok := strings.TrimSpace(string(b))
	id, secret, ok := strings.Cut(tok, "=")
	if !ok || secret == "" || !strings.HasPrefix(id, pveManageUser+"!") || strings.ContainsAny(tok, " \t\r\n") {
		return "", fmt.Errorf("%s: not a token of %s", path, pveManageUser)
	}
	return tok, nil
}

// ApplyConfig acts on the agent's configuration at start and after every
// reload: on a Proxmox VE node it provisions the manage token when
// [remote_control] manage is on and removes it when it is off. Failures
// are logged; manage operations report them until provisioning works.
func (b *Broker) ApplyConfig(ctx context.Context, cfg *agent.Config) {
	d, ok := b.drivers[proto.PlatformPVE].(*pveDriver)
	if !ok || cfg == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	did, err := d.mg.apply(ctx, cfg.RemoteControl.Manage)
	switch {
	case err != nil:
		b.log.Warn("Proxmox VE manage token", "err", err)
	case did != "":
		b.log.Info("Proxmox VE manage token "+did, "user", pveManageUser, "file", d.mg.tokenFile)
	}
}

// apply provisions (on) or removes (off) the manage token and reports
// what it did: "created", "removed" or "" (nothing to do, or the role and
// ACLs were brought up to date).
func (m *pveManage) apply(ctx context.Context, on bool) (string, error) {
	if !m.isNode() {
		return "", nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.api = nil // re-read the token file at the next operation
	if !on {
		removed, err := m.removeLocked(ctx)
		if removed {
			return "removed", err
		}
		return "", err
	}
	_, created, err := m.provisionLocked(ctx)
	if err != nil {
		m.provErr, m.provAt = err, m.now()
		return "", err
	}
	m.provErr = nil
	if created {
		return "created", nil
	}
	return "", nil
}

// provisionLocked brings the role, the user and its ACLs up to date and
// returns the token, creating it when the token file is missing or not
// ours. m.mu is held.
func (m *pveManage) provisionLocked(ctx context.Context) (tok string, created bool, err error) {
	defer func() {
		if err != nil {
			err = fmt.Errorf("provisioning %s: %w", pveManageUser, err)
		}
	}()
	out, err := m.run(ctx, "pveum", "role", "list", "--output-format", "json")
	if err != nil {
		return "", false, err
	}
	var roles []struct {
		RoleID string          `json:"roleid"`
		Privs  json.RawMessage `json:"privs"`
	}
	if err := json.Unmarshal(out, &roles); err != nil {
		return "", false, errors.New("pveum role list: unexpected output")
	}
	known, exists := map[string]bool{}, map[string]bool{}
	var vmAdmin []string
	for _, r := range roles {
		privs := rolePrivs(r.Privs)
		exists[r.RoleID] = true
		for _, p := range privs {
			known[p] = true
		}
		if r.RoleID == "PVEVMAdmin" {
			vmAdmin = privs
		}
	}
	if len(vmAdmin) == 0 {
		return "", false, errors.New("the built-in role PVEVMAdmin is missing")
	}
	if err := m.ensureRole(ctx, pveManageRole, manageRolePrivs(vmAdmin, known), exists[pveManageRole]); err != nil {
		return "", false, err
	}
	if _, err := m.run(ctx, "pveum", "user", "add", pveManageUser, "--comment", "Whombat agent (manage)"); err != nil && !strings.Contains(err.Error(), "already exists") {
		return "", false, err
	}
	if _, err := m.run(ctx, "pveum", "acl", "modify", "/", "--users", pveManageUser, "--roles", pveManageRole); err != nil {
		return "", false, err
	}
	// download-url needs Sys.AccessNetwork on the node (PVE 8.3+) instead
	// of Sys.Modify on /.
	if known["Sys.AccessNetwork"] {
		if err := m.ensureRole(ctx, pveNetworkRole, []string{"Sys.AccessNetwork"}, exists[pveNetworkRole]); err != nil {
			return "", false, err
		}
		if _, err := m.run(ctx, "pveum", "acl", "modify", "/nodes/"+m.node, "--users", pveManageUser, "--roles", pveNetworkRole); err != nil {
			return "", false, err
		}
	}
	if tok, err := readManageToken(m.tokenFile); err == nil {
		return tok, false, nil
	}
	tid := pveManageTokenID(m.node)
	_, _ = m.run(ctx, "pveum", "user", "token", "remove", pveManageUser, tid)
	out, err = m.run(ctx, "pveum", "user", "token", "add", pveManageUser, tid, "--privsep", "0",
		"--comment", "Whombat agent (manage) on "+m.node, "--output-format", "json")
	if err != nil {
		return "", false, err
	}
	var res struct {
		FullID string `json:"full-tokenid"`
		Value  string `json:"value"`
	}
	if err := json.Unmarshal(out, &res); err != nil || res.Value == "" {
		return "", false, errors.New("pveum user token add: unexpected output")
	}
	if res.FullID == "" {
		res.FullID = pveManageUser + "!" + tid
	}
	tok = res.FullID + "=" + res.Value
	if err := writeSecretFile(m.tokenFile, tok+"\n"); err != nil {
		return "", false, err
	}
	return tok, true, nil
}

// rolePrivs decodes a role's privileges: "A,B,C" (pveum) or a list.
func rolePrivs(raw json.RawMessage) []string {
	var list []string
	if json.Unmarshal(raw, &list) != nil {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return nil
		}
		list = strings.Split(s, ",")
	}
	out := list[:0]
	for _, p := range list {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func (m *pveManage) ensureRole(ctx context.Context, role string, privs []string, exists bool) error {
	verb := "add"
	if exists {
		verb = "modify" // --privs replaces the role's privileges
	}
	_, err := m.run(ctx, "pveum", "role", verb, role, "--privs", strings.Join(privs, ","))
	return err
}

// removeLocked removes the token and its file. The file stays when PVE
// could not remove the token (the next start or reload tries again).
func (m *pveManage) removeLocked(ctx context.Context) (bool, error) {
	if _, err := os.Stat(m.tokenFile); err != nil {
		return false, nil
	}
	if _, err := m.run(ctx, "pveum", "user", "token", "remove", pveManageUser, pveManageTokenID(m.node)); err != nil {
		if msg := err.Error(); !strings.Contains(msg, "no such token") && !strings.Contains(msg, "does not exist") && !strings.Contains(msg, "no such user") {
			return false, fmt.Errorf("removing the token of %s: %w", pveManageUser, err)
		}
	}
	if err := os.Remove(m.tokenFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	return true, nil
}

// writeSecretFile writes a file readable by root only, atomically.
func writeSecretFile(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// client returns the API client with the manage token, provisioning the
// token when its file is missing (at most every pveProvisionRetry).
func (m *pveManage) client(ctx context.Context) (*pveAPI, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.api != nil {
		return m.api, nil
	}
	tok, err := readManageToken(m.tokenFile)
	if err != nil {
		if !m.isNode() {
			return nil, codeErr(CodePlatformError, "this host is not a Proxmox VE node (pveum not found)")
		}
		if m.provErr != nil && m.now().Sub(m.provAt) < pveProvisionRetry {
			return nil, codeErr(CodePlatformError, "the agent's Proxmox VE manage token is not available: "+m.provErr.Error())
		}
		if tok, _, err = m.provisionLocked(ctx); err != nil {
			m.provErr, m.provAt = err, m.now()
			return nil, codeErr(CodePlatformError, "the agent's Proxmox VE manage token is not available: "+err.Error())
		}
		m.provErr = nil
	}
	api, err := m.newAPI(m.baseURL, tok)
	if err != nil {
		return nil, codeErr(CodePlatformError, err.Error())
	}
	m.api = api
	return api, nil
}

// rejected handles a 401 for api: the token file is read again at the next
// operation, and when PVE keeps refusing the token for
// pveTokenRejectedFor it is removed so that a new one is provisioned.
func (m *pveManage) rejected(api *pveAPI) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	if m.rejectedAt.IsZero() {
		m.rejectedAt = now
	}
	if m.api == api {
		m.api = nil
	}
	if now.Sub(m.rejectedAt) >= pveTokenRejectedFor {
		_ = os.Remove(m.tokenFile)
		m.rejectedAt = time.Time{}
	}
}

// accepted clears the 401 tracking after a successful call.
func (m *pveManage) accepted() {
	m.mu.Lock()
	m.rejectedAt = time.Time{}
	m.mu.Unlock()
}
