package broker

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// Unraid's side of the backup places: the shares, made and changed with
// emcmd and the very form fields Unraid's own pages post to emhttp
// (webgui ShareEdit.page "Add Share", SecuritySMB.page and
// SecurityNFS.page), and the containers' dockerMan templates and
// autostart, so they show in Unraid's Docker page and start with the
// array.

const (
	unraidSharesCfgDir = "/boot/config/shares"
	unraidPoolsCfgDir  = "/boot/config/pools"
	unraidUserShares   = "/mnt/user"
	// placeNFSOptions are the options of a Proxmox VE server's NFS rule
	// (vzdump writes as root).
	placeNFSOptions = "(sec=sys,rw,no_root_squash)"
)

// emcmdForm encodes form fields in order, like the page's form post.
func emcmdForm(fields [][2]string) string {
	parts := make([]string, 0, len(fields))
	for _, f := range fields {
		parts = append(parts, f[0]+"="+url.QueryEscape(f[1]))
	}
	return strings.Join(parts, "&")
}

// emcmd posts one form to emhttp.
func (m *placeManager) emcmd(ctx context.Context, what string, fields [][2]string) error {
	bin, err := m.unraid.bin("emcmd")
	if err != nil {
		return err
	}
	cctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	out, err := runQuiet(cctx, m.unraid.env, bin, emcmdForm(fields))
	if err != nil {
		msg := firstLine(out, 200)
		if msg == "" {
			msg = err.Error()
		}
		return codeErr(CodePlatformError, "Unraid didn’t "+what+": "+msg)
	}
	return nil
}

// shareConfig reads a share's configuration (nil: no such share).
func (m *placeManager) shareConfig(name string) map[string]string {
	b, err := os.ReadFile(m.unraid.path(filepath.Join(unraidSharesCfgDir, name+".cfg")))
	if err != nil {
		return nil
	}
	return parseFlatINI(b)
}

// waitFor polls cond until it holds or the wait ends.
func (m *placeManager) waitFor(ctx context.Context, d time.Duration, cond func() bool) bool {
	end := m.now().Add(d)
	for {
		if cond() {
			return true
		}
		if m.now().After(end) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(m.unraid.interval(time.Second)):
		}
	}
}

// newShareStorage is where a new share keeps its files: the array, or on
// a server without an array (pools only, as the page decides) its first
// pool.
func (m *placeManager) newShareStorage() (useCache, pool string) {
	v, _ := m.unraid.varINI()
	if n, err := strconv.Atoi(v["SYS_ARRAY_SLOTS"]); err == nil && n <= 2 {
		ents, _ := os.ReadDir(m.unraid.path(unraidPoolsCfgDir))
		var pools []string
		for _, e := range ents {
			if name, ok := strings.CutSuffix(e.Name(), ".cfg"); ok && !e.IsDir() {
				pools = append(pools, name)
			}
		}
		sort.Strings(pools)
		if len(pools) > 0 {
			return "only", pools[0]
		}
	}
	return "no", ""
}

// ensureShare makes the share when it is missing, keeps it off SMB, and
// either off NFS (nfsClients nil) or exported over NFS, private, to at
// least those addresses. It returns the share's folder.
func (m *placeManager) ensureShare(ctx context.Context, name, comment string, nfsClients []string) (string, error) {
	cfg := m.shareConfig(name)
	if cfg == nil {
		useCache, pool := m.newShareStorage()
		// ShareEdit.page's form, as prepareEdit() leaves it for a new share.
		err := m.emcmd(ctx, "make the share "+name, [][2]string{
			{"shareNameOrig", ""}, {"shareUseCache", useCache}, {"shareCachePool2", ""}, {"shareAllocator", "highwater"},
			{"shareSplitLevel", ""}, {"shareInclude", ""}, {"shareExclude", ""}, {"shareName", name},
			{"shareComment", comment}, {"shareFloor", ""}, {"shareCachePool", pool}, {"shareCOW", "auto"},
			{"cmdEditShare", "Add Share"},
		})
		if err != nil {
			return "", err
		}
		if !m.waitFor(ctx, 30*time.Second, func() bool { return m.shareConfig(name) != nil }) {
			return "", codeErr(CodePlatformError, "Unraid didn’t make the share "+name+".")
		}
		cfg = m.shareConfig(name)
	}
	if cfg["shareExport"] != "-" {
		// SecuritySMB.page: not exported over SMB.
		sec := cfg["shareSecurity"]
		if sec == "" {
			sec = "private"
		}
		caseSens := cfg["shareCaseSensitive"]
		if caseSens == "" {
			caseSens = "auto"
		}
		if err := m.emcmd(ctx, "stop sharing "+name+" over SMB", [][2]string{{"shareName", name}, {"shareExport", "-"},
			{"shareVolsizelimit", ""}, {"shareCaseSensitive", caseSens}, {"shareSecurity", sec}, {"changeShareSecurity", "Apply"}}); err != nil {
			return "", err
		}
	}
	nfsExport, nfsSec := cfg["shareExportNFS"], cfg["shareSecurityNFS"]
	if nfsClients == nil {
		if nfsExport != "" && nfsExport != "-" {
			if nfsSec == "" {
				nfsSec = "public"
			}
			if err := m.emcmd(ctx, "stop sharing "+name+" over NFS", [][2]string{{"shareName", name}, {"shareExportNFS", "-"},
				{"shareSecurityNFS", nfsSec}, {"changeShareSecurityNFS", "Apply"}}); err != nil {
				return "", err
			}
		}
	} else {
		// SecurityNFS.page: exported, private, then the rules (one per
		// host, separated by spaces).
		if nfsExport != "e" || nfsSec != "private" {
			if err := m.emcmd(ctx, "share "+name+" over NFS", [][2]string{{"shareName", name}, {"shareExportNFS", "e"},
				{"shareSecurityNFS", "private"}, {"changeShareSecurityNFS", "Apply"}}); err != nil {
				return "", err
			}
		}
		rules, changed := mergeNFSRules(cfg["shareHostListNFS"], nfsClients)
		if changed {
			if err := m.emcmd(ctx, "let the server reach "+name+" over NFS", [][2]string{{"shareName", name},
				{"shareHostListNFS", rules}, {"changeShareAccessNFS", "Apply"}}); err != nil {
				return "", err
			}
		}
	}
	dir := filepath.Join(unraidUserShares, name)
	if !m.waitFor(ctx, 30*time.Second, func() bool { st, err := os.Stat(m.unraid.path(dir)); return err == nil && st.IsDir() }) {
		if err := m.filesystem().mkdirAll(ctx, m.unraid.path(dir), 0o777); err != nil {
			return "", placeFSError("make the share’s folder", err)
		}
	}
	return dir, nil
}

// mergeNFSRules adds a rule for every client that has none; the rules
// already there stay as they are.
func mergeNFSRules(list string, clients []string) (string, bool) {
	rules := strings.Fields(list)
	have := map[string]bool{}
	for _, r := range rules {
		host, _, _ := strings.Cut(r, "(")
		have[host] = true
	}
	changed := false
	for _, c := range clients {
		if !have[c] {
			rules = append(rules, c+placeNFSOptions)
			have[c] = true
			changed = true
		}
	}
	return strings.Join(rules, " "), changed
}

// validNFSClients checks the NFS clients: IPv4 addresses of hosts.
func validNFSClients(clients []string) ([]string, error) {
	if len(clients) == 0 || len(clients) > proto.PlaceNFSClientsMax {
		return nil, invalidField("clients", fmt.Sprintf("Give 1 to %d addresses of the server.", proto.PlaceNFSClientsMax))
	}
	var out []string
	seen := map[string]bool{}
	for _, c := range clients {
		ip := net.ParseIP(c)
		if ip == nil || ip.To4() == nil || ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() {
			return nil, invalidField("clients", c+" isn’t an IPv4 address of a server.")
		}
		s := ip.To4().String()
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out, nil
}

// nfsShare makes or updates an NFS share for another server's backups.
func (m *placeManager) nfsShare(ctx context.Context, req *proto.PlaceRequest) (proto.PlaceResult, error) {
	if !m.isUnraid() {
		return proto.PlaceResult{}, &placeUnsupported{reason: proto.PlaceNotUnraid}
	}
	if !proto.PlaceShareRe.MatchString(req.Name) || req.Name == proto.PlaceShareName {
		return proto.PlaceResult{}, invalidField("name", "The share is called whombat-… (lower-case letters, digits and dashes).")
	}
	clients, err := validNFSClients(req.Clients)
	if err != nil {
		return proto.PlaceResult{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.unraidStarted() {
		return proto.PlaceResult{}, &placeUnsupported{reason: proto.PlaceArrayStopped}
	}
	if v, _ := m.unraid.varINI(); !strings.EqualFold(v["shareNFSEnabled"], "yes") {
		return proto.PlaceResult{}, &placeUnsupported{reason: proto.PlaceNFSOff}
	}
	dir, err := m.ensureShare(ctx, req.Name, "Whombat: backups of another server", clients)
	if err != nil {
		return proto.PlaceResult{}, err
	}
	return proto.PlaceResult{Export: dir, Addresses: m.addresses()}, nil
}

// ---- dockerMan templates -------------------------------------------------------------

func (m *placeManager) templatePath(name string) string {
	return m.unraid.path(filepath.Join(unraidTemplatesDir, "my-"+name+".xml"))
}

// unraidTemplate writes the container's dockerMan template (what Unraid's
// Docker page edits and recreates it from) and puts it on the autostart
// list.
func (m *placeManager) unraidTemplate(ctx context.Context, name string, spec containerSpec, port int) error {
	fsys := m.filesystem()
	if err := fsys.mkdirAll(ctx, filepath.Dir(m.templatePath(name)), 0o755); err != nil {
		return placeFSError("write the Unraid template", err)
	}
	if err := fsys.writeFile(ctx, m.templatePath(name), []byte(dockerManTemplate(name, spec, port, m.now())), 0o644); err != nil {
		return placeFSError("write the Unraid template", err)
	}
	return m.unraid.setAutostart(name, true)
}

// unraidForget removes the template and the autostart line.
func (m *placeManager) unraidForget(ctx context.Context, name string) error {
	if err := m.filesystem().remove(ctx, m.templatePath(name)); err != nil {
		return placeFSError("remove the Unraid template", err)
	}
	if err := m.unraid.setAutostart(name, false); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// dockerManTemplate is a dockerMan user template (Container version 2)
// that makes the same container: its labels, entry point, restart policy
// and tmpfs in ExtraParams, the arguments in PostArgs, the port, folders
// and variables as Config entries.
func dockerManTemplate(name string, spec containerSpec, port int, now time.Time) string {
	esc := func(s string) string {
		var b strings.Builder
		_ = xml.EscapeText(&b, []byte(s))
		return b.String()
	}
	repo, _, _ := strings.Cut(spec.Image, "@")
	extra := []string{"--restart=" + spec.HostConfig.RestartPolicy.Name}
	post := spec.Cmd
	if len(spec.Entrypoint) > 0 {
		extra = append(extra, "--entrypoint="+spec.Entrypoint[0])
		post = append(append([]string{}, spec.Entrypoint[1:]...), spec.Cmd...)
	}
	if spec.User != "" {
		extra = append(extra, "--user="+spec.User)
	}
	for _, dst := range sortedKeys(spec.HostConfig.Tmpfs) {
		extra = append(extra, "--tmpfs="+dst+":"+spec.HostConfig.Tmpfs[dst])
	}
	for _, k := range sortedKeys(spec.Labels) {
		if k == "net.unraid.docker.managed" {
			continue // dockerMan sets it itself
		}
		extra = append(extra, "--label="+k+"="+spec.Labels[k])
	}
	network := spec.HostConfig.NetworkMode
	if network == "" {
		network = "bridge"
	}
	var cfg []string
	if port > 0 {
		cfg = append(cfg, fmt.Sprintf(`  <Config Name="Port" Target="8000" Default="%d" Mode="tcp" Description="Where Whombat sends its backups." Type="Port" Display="always" Required="true" Mask="false">%d</Config>`, port, port))
	}
	for i, bind := range spec.HostConfig.Binds {
		parts := strings.Split(bind, ":")
		mode := "rw"
		if len(parts) > 2 {
			mode = parts[2]
		}
		label := "Folder " + strconv.Itoa(i+1)
		switch {
		case parts[1] == "/data/"+proto.PlaceKitUser:
			label = "Locked details"
		case strings.HasPrefix(parts[1], "/data/"):
			label = "Backups"
		case parts[1] == "/state":
			label = "Settings"
		case strings.HasPrefix(parts[1], "/auth/"):
			label = "Users"
		}
		cfg = append(cfg, fmt.Sprintf(`  <Config Name="%s" Target="%s" Default="" Mode="%s" Description="" Type="Path" Display="always" Required="true" Mask="false">%s</Config>`,
			esc(label), esc(parts[1]), esc(mode), esc(parts[0])))
	}
	for _, e := range spec.Env {
		k, v, _ := strings.Cut(e, "=")
		cfg = append(cfg, fmt.Sprintf(`  <Config Name="%s" Target="%s" Default="%s" Mode="" Description="" Type="Variable" Display="advanced" Required="false" Mask="false">%s</Config>`,
			esc(k), esc(k), esc(v), esc(v)))
	}
	overview := "Keeps a Whombat’s backups. Whombat set it up: it only adds backups and never deletes them."
	if spec.Labels[placeLabelRole] == "cleanup" {
		overview = "Clears a Whombat’s old backups once a week. Whombat set it up."
	}
	lines := []string{
		`<?xml version="1.0"?>`,
		`<Container version="2">`,
		"  <Name>" + esc(name) + "</Name>",
		"  <Repository>" + esc(spec.Image) + "</Repository>",
		"  <Registry>https://hub.docker.com/r/" + esc(repo) + "</Registry>",
		"  <Network>" + esc(network) + "</Network>",
		"  <MyIP/>",
		"  <Shell>sh</Shell>",
		"  <Privileged>false</Privileged>",
		"  <Support/>",
		"  <Project>https://restic.net</Project>",
		"  <Overview>" + esc(overview) + "</Overview>",
		"  <Category>Backup:</Category>",
		"  <WebUI/>",
		"  <TemplateURL/>",
		"  <Icon/>",
		"  <ExtraParams>" + esc(strings.Join(extra, " ")) + "</ExtraParams>",
		"  <PostArgs>" + esc(strings.Join(post, " ")) + "</PostArgs>",
		"  <CPUset/>",
		"  <DateInstalled>" + strconv.FormatInt(now.Unix(), 10) + "</DateInstalled>",
		"  <DonateText/>",
		"  <DonateLink/>",
		"  <Requires/>",
	}
	lines = append(lines, cfg...)
	lines = append(lines, "</Container>", "")
	return strings.Join(lines, "\n")
}
