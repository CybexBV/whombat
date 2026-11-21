package hub

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"text/template"

	agentpkg "rackoon/packaging/agent"
)

func init() {
	// Not in Go's built-in table; /etc/mime.types may lack it too.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

// staticHandler serves the single-page UI: files from --web-dir or the
// embedded build, index.html for client routes.
func (h *Hub) staticHandler() http.Handler {
	var fsys fs.FS
	switch {
	case h.cfg.WebDir != "":
		fsys = os.DirFS(h.cfg.WebDir)
	case h.cfg.WebFS != nil:
		fsys = h.cfg.WebFS
	}
	gz := &gzipCache{m: map[string][]byte{}}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if fsys == nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			if r.URL.Path != "/" {
				w.WriteHeader(http.StatusNotFound)
			}
			io.WriteString(w, noUIPage)
			return
		}
		p := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if p != "" && p != "index.html" {
			if st, err := fs.Stat(fsys, p); err == nil && !st.IsDir() {
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
					// Hashed, immutable bundles: served gzipped from memory.
					if acceptsGzip(r) && compressible(p) && r.Header.Get("Range") == "" {
						if z, ok := gz.get(fsys, p); ok {
							ct := mime.TypeByExtension(path.Ext(p))
							if ct == "" {
								ct = "application/octet-stream"
							}
							w.Header().Set("Content-Type", ct)
							w.Header().Set("Content-Encoding", "gzip")
							w.Header().Add("Vary", "Accept-Encoding")
							w.Header().Set("Content-Length", strconv.Itoa(len(z)))
							if r.Method != http.MethodHead {
								_, _ = w.Write(z)
							}
							return
						}
					}
				} else {
					w.Header().Set("Cache-Control", "no-cache")
				}
				http.ServeFileFS(w, r, fsys, p)
				return
			}
			if strings.Contains(path.Base(p), ".") && !strings.Contains(p, ":") {
				http.NotFound(w, r)
				return
			}
		}
		// Client route: index.html.
		b, err := fs.ReadFile(fsys, "index.html")
		if err != nil {
			http.Error(w, "index.html missing from the UI build", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(b)
	})
}

const noUIPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Whombat hosts service</title></head>
<body style="font-family: system-ui, sans-serif; background: #0e0f12; color: #e8e9ec; padding: 48px">
<h1>Whombat hosts service</h1>
<p>The hub is running, but this build has no web UI. Build the UI and either start the hub with
<code>--web-dir web/dist</code> or build the hub with <code>-tags embedweb</code>.</p>
<p>The API is at <code>/api/v1</code>.</p>
</body></html>
`

// agentArchs are the downloadable agent builds' architectures, for Linux
// and macOS.
var agentArchs = []string{"amd64", "arm64"}

// agentFileName is an agent build's file name ("whombat-agent-darwin-arm64").
func agentFileName(goos, arch string) string { return "whombat-agent-" + goos + "-" + arch }

func agentBinaryName(arch string) string { return agentFileName("linux", arch) }

// The macOS helper (Whombat Helper) in --agent-dist: the signed zip and its
// description {"version", "sha256", "size"}.
const (
	helperZip  = "whombat-helper-macos.zip"
	helperJSON = "whombat-helper-macos.json"
)

// downloadable lists the files /download/ serves from --agent-dist.
func downloadable(name string) bool {
	for _, a := range agentArchs {
		if name == agentFileName("linux", a) || name == agentFileName("darwin", a) {
			return true
		}
	}
	return name == helperZip || name == helperJSON
}

// macHelper is the helper build in --agent-dist: its version, the zip's
// SHA-256 and the Apple team that signed it ("" ad hoc), when the zip is
// there and matches its description (ok false: Macs install without the
// helper).
func (h *Hub) macHelper() (version, sum, team string, ok bool) {
	if h.cfg.AgentDist == "" {
		return "", "", "", false
	}
	b, err := os.ReadFile(filepath.Join(h.cfg.AgentDist, helperJSON))
	if err != nil || len(b) > 64<<10 {
		return "", "", "", false
	}
	var d struct {
		Version string `json:"version"`
		SHA256  string `json:"sha256"`
		Size    int64  `json:"size"`
		Team    string `json:"team"`
	}
	if json.Unmarshal(b, &d) != nil {
		return "", "", "", false
	}
	zip := filepath.Join(h.cfg.AgentDist, helperZip)
	st, err := os.Stat(zip)
	if err != nil || (d.Size > 0 && st.Size() != d.Size) {
		return "", "", "", false
	}
	sum = fileSHA256(zip)
	if sum == "" || !strings.EqualFold(sum, strings.TrimSpace(d.SHA256)) {
		h.log.Warn("the macOS helper's zip does not match its description; Macs install without it", "dir", h.cfg.AgentDist)
		return "", "", "", false
	}
	if !helperVersionRe.MatchString(d.Version) {
		d.Version = ""
	}
	if !helperTeamRe.MatchString(d.Team) {
		d.Team = ""
	}
	return d.Version, sum, d.Team, true
}

// helperTeamRe is an Apple team id.
var helperTeamRe = regexp.MustCompile(`^[A-Z0-9]{10}$`)

var helperVersionRe = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$`)

func (h *Hub) serveDownload(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !downloadable(name) || h.cfg.AgentDist == "" {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(filepath.Join(h.cfg.AgentDist, name))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	ctype := "application/octet-stream"
	switch path.Ext(name) {
	case ".zip":
		ctype = "application/zip"
	case ".json":
		ctype = "application/json"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, name, st.ModTime(), f)
}

// sumCache remembers file digests by path, size and modification time:
// install.sh is served to anyone and must not hash two 17 MB binaries per
// request.
var sumCache = struct {
	sync.Mutex
	m map[string]sumEntry
}{m: map[string]sumEntry{}}

type sumEntry struct {
	size int64
	mod  int64
	sum  string
}

func fileSHA256(p string) string {
	st, err := os.Stat(p)
	if err != nil {
		return ""
	}
	sumCache.Lock()
	if e, ok := sumCache.m[p]; ok && e.size == st.Size() && e.mod == st.ModTime().UnixNano() {
		sumCache.Unlock()
		return e.sum
	}
	sumCache.Unlock()
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	sum := sha256.New()
	if _, err := io.Copy(sum, f); err != nil {
		return ""
	}
	out := hex.EncodeToString(sum.Sum(nil))
	sumCache.Lock()
	sumCache.m[p] = sumEntry{size: st.Size(), mod: st.ModTime().UnixNano(), sum: out}
	sumCache.Unlock()
	return out
}

var safeHost = regexp.MustCompile(`^[A-Za-z0-9.\-:\[\]]+$`)

// agentPort is the agent listener's port.
func (h *Hub) agentPort() string {
	_, port, err := net.SplitHostPort(h.cfg.AgentListen)
	if err != nil || port == "" || port == "0" {
		port = "8443"
	}
	return port
}

// agentURL is the agents' hub URL: --agent-url, the LAN address of the
// default route (--agent-url auto), else derived from the request: the host
// it was sent to (the agent listener) or the public URL's host with the
// agent port (the UI). r nil and nothing configured: "".
func (h *Hub) agentURL(r *http.Request) (string, error) {
	switch {
	case h.cfg.AgentURL != "":
		return h.cfg.AgentURL, nil
	case h.cfg.AgentURLAuto:
		return h.lan.get(h.agentPort())
	case r == nil:
		// The agent listener's own address, when it names one.
		if host, _, err := net.SplitHostPort(h.cfg.AgentListen); err == nil && host != "" && host != "0.0.0.0" && host != "::" {
			return "wss://" + net.JoinHostPort(host, h.agentPort()), nil
		}
		return "", nil
	}
	host, port := r.Host, h.agentPort()
	if r.TLS != nil && r.Context().Value(agentListenerKey{}) != nil {
		if hh, pp, err := net.SplitHostPort(r.Host); err == nil {
			host, port = hh, pp
		}
	} else {
		if h.cfg.PublicURL != "" {
			if u, err := url.Parse(h.cfg.PublicURL); err == nil {
				host = u.Host
			}
		}
		if hh, _, err := net.SplitHostPort(host); err == nil {
			host = hh
		}
	}
	host = strings.Trim(host, "[]")
	if host == "" || !safeHost.MatchString(host) {
		return "", errors.New("bad host")
	}
	return "wss://" + net.JoinHostPort(host, port), nil
}

// agentListenerKey marks requests that arrived on the agent listener.
type agentListenerKey struct{}

// listenerPin is the agent listener certificate's public key pin in curl's
// --pinnedpubkey form ("sha256//<base64 of the SPKI's SHA-256>").
func (h *Hub) listenerPin() string {
	c := h.listenerCert.cur.Load()
	if c == nil || c.Leaf == nil {
		return ""
	}
	der, err := x509.MarshalPKIXPublicKey(c.Leaf.PublicKey)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(der)
	return "sha256//" + base64.StdEncoding.EncodeToString(sum[:])
}

// fetchCommand is how a host downloads from the hub: plain curl from the UI
// origin, or with the agent listener's key pinned (its certificate comes
// from the hub's private CA, so curl cannot verify it otherwise).
func fetchCommand(pin string) string {
	if pin == "" {
		return "curl -fsSL"
	}
	return "curl -fsSL --insecure --pinnedpubkey '" + pin + "'"
}

// installScript serves install.sh: from the UI origin (UI listener), or
// from the agent listener with its key pinned for the downloads.
func (h *Hub) installScript(viaAgent bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		agentURL, err := h.agentURL(r)
		if err != nil {
			http.Error(w, "bad host", http.StatusBadRequest)
			return
		}
		origin, pin := h.requestOrigin(r), ""
		if viaAgent {
			// Downloads come from the address the script was fetched from.
			hostport := r.Host
			if _, _, err := net.SplitHostPort(hostport); err != nil {
				hostport = net.JoinHostPort(strings.Trim(hostport, "[]"), "443")
			}
			origin, pin = "https://"+hostport, h.listenerPin()
		}
		if !h.writeInstallScript(w, origin, agentURL, pin) {
			http.Error(w, "bad host", http.StatusBadRequest)
		}
	}
}

// apiAgentInstallScript is GET /api/v1/agent-install.sh (admin, on the
// Unix socket headless): the script the agent listener serves at
// /install.sh, for the Whombat server to run over SSH (SI-02). Its
// downloads come from the agents' address with the listener's key pinned,
// not from the Host the request named.
func (h *Hub) apiAgentInstallScript(w http.ResponseWriter, r *http.Request, p *principal) error {
	base, err := h.agentInstallBase()
	if err != nil {
		return apiErr(http.StatusServiceUnavailable, "no_agent_url", "The hub does not know the address agents reach it at: "+err.Error()+".")
	}
	agentURL, _ := h.agentURL(nil)
	if !h.writeInstallScript(w, base, agentURL, h.listenerPin()) {
		return apiErr(http.StatusServiceUnavailable, "no_agent_url", "The agents' address is not usable: "+base+".")
	}
	return nil
}

// writeInstallScript fills in install.sh: downloads from origin (with the
// key pin, when not empty), agents dial agentURL. false: origin's host is
// not one to put in a script (nothing written).
func (h *Hub) writeInstallScript(w http.ResponseWriter, origin, agentURL, pin string) bool {
	u, err := url.Parse(origin)
	if err != nil || !safeHost.MatchString(u.Host) {
		return false
	}
	// Every key the script names is set: a missing one would print as
	// "<no value>", which the script would take for a checksum.
	data := map[string]string{"Origin": origin, "AgentURL": agentURL, "Pin": h.ca.Pin, "TLSPin": pin,
		"Fetch": fetchCommand(pin), "Unit": AgentUnit,
		"RC": agentpkg.RCService, "OpenRC": agentpkg.OpenRCService,
		"UnraidRC": strings.ReplaceAll(agentpkg.RCService, "/etc/whombat-agent", "/boot/config/plugins/whombat-agent"),
		"SumAMD64": "", "SumARM64": "", "SumDarwinAMD64": "", "SumDarwinARM64": "", "HelperSum": "", "HelperVersion": "", "HelperTeam": ""}
	if h.cfg.AgentDist != "" {
		data["SumAMD64"] = fileSHA256(filepath.Join(h.cfg.AgentDist, agentBinaryName("amd64")))
		data["SumARM64"] = fileSHA256(filepath.Join(h.cfg.AgentDist, agentBinaryName("arm64")))
		data["SumDarwinAMD64"] = fileSHA256(filepath.Join(h.cfg.AgentDist, agentFileName("darwin", "amd64")))
		data["SumDarwinARM64"] = fileSHA256(filepath.Join(h.cfg.AgentDist, agentFileName("darwin", "arm64")))
		if v, sum, team, ok := h.macHelper(); ok {
			data["HelperSum"], data["HelperVersion"], data["HelperTeam"] = sum, v, team
		}
	}
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := installTmpl.Execute(w, data); err != nil {
		h.log.Error("install.sh", "err", err)
	}
	return true
}

// AgentUnit is the systemd unit install.sh writes: the agent package's unit
// (packaging/agent/whombat-agent.service) with the binary in /usr/local/bin.
var AgentUnit = agentpkg.Unit("/usr/local/bin/whombat-agent")

var installTmpl = template.Must(template.New("install.sh").Parse(`#!/bin/sh
# Whombat agent installer, generated by Whombat's hosts service at {{.Origin}}.
# Usage: {{.Fetch}} {{.Origin}}/install.sh | sudo sh -s -- --token <token> [--control watch|operate|full]
# --token - reads the token from the first line of stdin.
# --control sets exactly what Whombat may do on this server: watch (read-only
#   checks), operate (also consoles and guest power) or full (every switch).
# --hub overrides the agent endpoint (e.g. wss://10.100.0.7:8443 for LAN).
# --download-base overrides the binary source, including staged file:// URLs.
# --sha256 gives the binary's checksum when the hub publishes none.
# Re-running upgrades an enrolled agent in place and keeps its identity; an
# agent that reports to another Whombat is left alone unless --force, which
# enrolls this server here with the token.
# --uninstall removes the agent (its identity is kept unless --purge; a
# Mac's stored screen password always goes).
# On a Mac (macOS 13 or later) the agent is a LaunchDaemon run from
# /Library/Application Support/Whombat/bin, and the installer adds Whombat
# Helper when the hub has it.
# The last line on stdout says what happened: "whombat-agent: added <server>",
# "whombat-agent: waiting <enrollment>" (an owner approves it in Whombat),
# "whombat-agent: kept <server>" or "whombat-agent: other-whombat" (exit 3).
set -eu

HUB_URL='{{.AgentURL}}'
CA_SHA256='{{.Pin}}'
DOWNLOAD_BASE='{{.Origin}}/download'
# The hub's agent listener has a certificate of the hub's own CA: downloads
# from it pin its key (the binary's checksum is checked as well).
TLS_PIN='{{.TLSPin}}'
SHA256_AMD64='{{.SumAMD64}}'
SHA256_ARM64='{{.SumARM64}}'
SHA256_DARWIN_AMD64='{{.SumDarwinAMD64}}'
SHA256_DARWIN_ARM64='{{.SumDarwinARM64}}'
# Whombat Helper for Macs (none: Macs install without it).
HELPER_SHA256='{{.HelperSum}}'
HELPER_VERSION='{{.HelperVersion}}'
HELPER_TEAM='{{.HelperTeam}}'

TOKEN=""
SUM_OVERRIDE=""
CONTROL=""
FORCE=0
UNINSTALL=0
PURGE=0
while [ $# -gt 0 ]; do
	case "$1" in
	--token)
		[ $# -ge 2 ] || { echo "install.sh: --token needs a value" >&2; exit 2; }
		TOKEN="$2"; shift 2 ;;
	--token=*) TOKEN="${1#--token=}"; shift ;;
	--control)
		[ $# -ge 2 ] || { echo "install.sh: --control needs a value" >&2; exit 2; }
		CONTROL="$2"; shift 2 ;;
	--control=*) CONTROL="${1#--control=}"; shift ;;
	--hub|--download-base|--sha256)
		[ $# -ge 2 ] || { echo "install.sh: $1 needs a value" >&2; exit 2; }
		case "$1" in --hub) HUB_URL=$2 ;; --download-base) DOWNLOAD_BASE=$2; TLS_PIN="" ;; --sha256) SUM_OVERRIDE=$2 ;; esac
		shift 2 ;;
	--force) FORCE=1; shift ;;
	--uninstall) UNINSTALL=1; shift ;;
	--purge) UNINSTALL=1; PURGE=1; shift ;;
	-h|--help) echo "usage: install.sh [--token TOKEN|-] [--control watch|operate|full] [--force] [--hub wss://HOST:PORT] [--download-base URL] [--sha256 HEX] | --uninstall [--purge]"; exit 0 ;;
	*) echo "install.sh: unknown argument: $1" >&2; exit 2 ;;
	esac
done
case "$CONTROL" in
""|watch|operate|full) ;;
*) echo "install.sh: --control must be watch, operate or full" >&2; exit 2 ;;
esac
[ "$(id -u)" -eq 0 ] || { echo "install.sh: run as root (sudo)" >&2; exit 1; }
if [ "$TOKEN" = - ]; then
	# The first line of stdin (after any line sudo -S read for itself).
	TOKEN=""
	IFS= read -r TOKEN || [ -n "$TOKEN" ] || { echo "install.sh: could not read the token from stdin" >&2; exit 2; }
	[ -n "$TOKEN" ] || { echo "install.sh: could not read the token from stdin" >&2; exit 2; }
fi
[ "$FORCE" = 0 ] || [ -n "$TOKEN" ] || { echo "install.sh: --force needs --token" >&2; exit 2; }
umask 077
CONFIG_DIR=/etc/whombat-agent
OS=linux
SHA256SUM=sha256sum
if [ "$(uname -s)" = Darwin ]; then
	OS=darwin
	SERVICE=launchd
	SHA256SUM="shasum -a 256"
elif [ -f /etc/unraid-version ] && [ -d /boot/config ]; then
	SERVICE=unraid
	CONFIG_DIR=/boot/config/plugins/whombat-agent
	[ -f /boot/config/go ] || { echo "install.sh: Unraid boot script is missing" >&2; exit 1; }
elif [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
	SERVICE=systemd
elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1 && command -v supervise-daemon >/dev/null 2>&1; then
	SERVICE=openrc
elif [ -d /etc/init.d ] && { command -v update-rc.d >/dev/null 2>&1 || command -v chkconfig >/dev/null 2>&1; }; then
	SERVICE=sysv
else
	echo "install.sh: unsupported init system; use whombat-agent run or supervise with your service manager" >&2
	exit 1
fi

# A Mac: the agent's LaunchDaemon, Whombat Helper and its LaunchAgent.
LAUNCHD_LABEL=com.whombat.agent
LAUNCHD_PLIST=/Library/LaunchDaemons/com.whombat.agent.plist
HELPER_DIR='/Library/Application Support/Whombat'
HELPER_APP="$HELPER_DIR/Whombat Helper.app"
HELPER_PLIST=/Library/LaunchAgents/com.whombat.helper.plist
# The agent's executable. On a Mac it lives where only root can write
# (Homebrew makes /usr/local/bin the person's own on Intel Macs, and a
# program of theirs could swap a root daemon there); /usr/local/bin keeps a
# link to it for the command line.
AGENT_DIR=/usr/local/bin
[ "$OS" != darwin ] || AGENT_DIR="$HELPER_DIR/bin"
AGENT_BIN="$AGENT_DIR/whombat-agent"

# gui_uids: the users with a desktop session (their loginwindow).
gui_uids() {
	ps -axo uid=,comm= 2>/dev/null | awk '/loginwindow$/ && $1 != 0 {print $1}' | sort -u
}

helper_remove() {
	for uid in $(gui_uids); do
		launchctl bootout "gui/$uid/com.whombat.helper" 2>/dev/null || true
	done
	rm -f "$HELPER_PLIST"
	rm -rf "$HELPER_APP" "$HELPER_APP.prev" "$HELPER_DIR/.new" "$HELPER_DIR/.update"
	# Its Accessibility permission goes with it (a later install starts afresh).
	tccutil reset Accessibility com.whombat.helper >/dev/null 2>&1 || true
}

# helper_requirement and helper_team: what macOS remembers a privacy
# permission by (an ad hoc build's code hash), and the signer's team ("" ad hoc).
helper_requirement() {
	codesign -d -r- "$1" 2>&1 | sed -n 's/^#* *designated => //p' | head -n 1
}
helper_team() {
	codesign -dv "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p' | head -n 1 | sed 's/^not set$//'
}

if [ "$UNINSTALL" = 1 ]; then
	echo "Removing the Whombat agent ($SERVICE) ..."
	case "$SERVICE" in
	systemd)
		systemctl disable --now whombat-agent.service 2>/dev/null || true
		rm -f /etc/systemd/system/whombat-agent.service
		systemctl daemon-reload ;;
	openrc)
		rc-service whombat-agent stop 2>/dev/null || true
		rc-update del whombat-agent default 2>/dev/null || true
		rm -f /etc/init.d/whombat-agent ;;
	sysv)
		/etc/init.d/whombat-agent stop 2>/dev/null || true
		if command -v update-rc.d >/dev/null 2>&1; then update-rc.d -f whombat-agent remove; else chkconfig --del whombat-agent || true; fi
		rm -f /etc/init.d/whombat-agent ;;
	unraid)
		[ -x /etc/rc.d/rc.whombat-agent ] && /etc/rc.d/rc.whombat-agent stop || true
		HOOK='/bin/sh /boot/config/plugins/whombat-agent/start.sh'
		if grep -Fx "$HOOK" /boot/config/go >/dev/null 2>&1; then
			grep -Fxv "$HOOK" /boot/config/go | grep -Fxv '# Whombat agent' > /boot/config/go.whombat-agent-tmp || true
			cat /boot/config/go.whombat-agent-tmp > /boot/config/go && rm -f /boot/config/go.whombat-agent-tmp
		fi
		rm -f /etc/rc.d/rc.whombat-agent ;;
	launchd)
		launchctl bootout "system/$LAUNCHD_LABEL" 2>/dev/null || true
		rm -f "$LAUNCHD_PLIST" /etc/newsyslog.d/whombat-agent.conf
		helper_remove
		rm -rf "$AGENT_DIR" /var/run/whombat-agent
		rmdir "$HELPER_DIR" 2>/dev/null || true ;;
	esac
	rm -f /usr/local/bin/whombat-agent /usr/local/bin/whombat-agent.prev /usr/local/bin/whombat-agent.new
	rm -rf /var/lib/whombat-agent
	# A Mac's screen account is its password: it never stays behind.
	rm -f "$CONFIG_DIR/screen.toml"
	if [ "$PURGE" = 1 ]; then
		[ "$SERVICE" != launchd ] || rm -f /var/log/whombat-agent.log /var/log/whombat-agent.log.*
		rm -rf "$CONFIG_DIR"
		echo "Agent and identity removed. Delete the server in Whombat to revoke its certificate."
	else
		echo "Agent removed; its identity stays in $CONFIG_DIR (--purge removes it). Delete the server in Whombat to revoke it."
	fi
	exit 0
fi
if [ -z "$TOKEN" ] && [ ! -f "$CONFIG_DIR/agent.crt" ]; then
	echo "install.sh: --token is required to enroll this host (an enrolled agent upgrades without one)" >&2; exit 2
fi

if [ "$OS" = darwin ]; then
	MACOS=$(sw_vers -productVersion 2>/dev/null || true)
	major=${MACOS%%.*}
	case "$major" in ''|*[!0-9]*) major=0 ;; esac
	if [ "$major" -lt 13 ]; then
		echo "install.sh: macOS 13 or later is needed${MACOS:+ (this Mac has $MACOS)}" >&2; exit 1
	fi
	case "$(uname -m)" in
	arm64) ARCH=arm64 ;;
	x86_64)
		ARCH=amd64
		# A shell under Rosetta says x86_64 on Apple silicon.
		[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" != 1 ] || ARCH=arm64 ;;
	*) echo "install.sh: unsupported architecture $(uname -m)" >&2; exit 1 ;;
	esac
	if [ "$ARCH" = arm64 ]; then SUM="$SHA256_DARWIN_ARM64"; else SUM="$SHA256_DARWIN_AMD64"; fi
else
case "$(uname -m)" in
	x86_64|amd64) ARCH=amd64; SUM="$SHA256_AMD64" ;;
	aarch64|arm64) ARCH=arm64; SUM="$SHA256_ARM64" ;;
	*) echo "install.sh: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
fi
[ -n "$SUM_OVERRIDE" ] && SUM="$SUM_OVERRIDE"

# "whombat-agent: os <system>" for Whombat's progress (SI-02): the platform
# when there is one, the distribution and the architecture.
os_line() {
	if [ "$OS" = darwin ]; then
		echo "whombat-agent: os macOS $MACOS · $ARCH"
		return 0
	fi
	pretty=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | head -n 1 | tr -d "\"'")
	[ -n "$pretty" ] || pretty=$(uname -s)
	plat=""
	if command -v pveversion >/dev/null 2>&1; then
		v=$(pveversion 2>/dev/null | sed -n 's|^pve-manager/\([0-9][0-9]*\.[0-9][0-9]*\).*|\1|p' | head -n 1)
		[ -z "$v" ] || plat="${plat}Proxmox VE $v · "
	fi
	if [ -f /etc/unraid-version ]; then
		v=$(sed -n 's/^version="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/unraid-version | head -n 1)
		[ -z "$v" ] || plat="${plat}Unraid $v · "
	fi
	if command -v incus >/dev/null 2>&1; then
		v=$(incus --version 2>/dev/null | sed -n 's/^\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)
		[ -z "$v" ] || plat="${plat}Incus $v · "
	fi
	echo "whombat-agent: os ${plat}${pretty} · $ARCH"
}

# The SHA-256 of the CA this server's agent trusts: of ca.crt, else
# agent.toml's ca_sha256.
current_ca() {
	pin=""
	if [ -f "$CONFIG_DIR/ca.crt" ] && command -v base64 >/dev/null 2>&1; then
		b64=$(awk '/-----BEGIN CERTIFICATE-----/{p=1; next} /-----END CERTIFICATE-----/{exit} p' "$CONFIG_DIR/ca.crt")
		if [ -n "$b64" ]; then
			pin=$(printf '%s\n' "$b64" | base64 -d 2>/dev/null | $SHA256SUM | cut -d' ' -f1)
		fi
	fi
	if [ -z "$pin" ]; then
		pin=$(sed -n "s/^[[:space:]]*ca_sha256[[:space:]]*=[[:space:]]*[\"']\([^\"']*\)[\"'].*/\1/p" "$CONFIG_DIR/agent.toml" 2>/dev/null | head -n 1)
	fi
	printf '%s' "$pin" | tr 'A-F' 'a-f' | tr -d ': '
}

# Before anything changes: an agent of this Whombat (the same CA) keeps its
# identity; an agent of another Whombat is left alone unless --force.
MODE=enroll
if [ -f "$CONFIG_DIR/agent.crt" ] && [ "$FORCE" = 0 ]; then
	if [ "$(current_ca)" = "$CA_SHA256" ]; then
		MODE=keep
	else
		os_line
		echo "install.sh: this server reports to another Whombat; remove its agent there first, or run this again with --force to move it here" >&2
		echo "whombat-agent: other-whombat"
		exit 3
	fi
fi
os_line

if [ -z "$SUM" ]; then
	echo "install.sh: the hub publishes no checksum for the agent binary; pass --sha256 <hex> of whombat-agent-$OS-$ARCH" >&2
	exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

# fetch URL FILE: a failed download says why in stable words.
fetch() {
	rc=0
	if command -v curl >/dev/null 2>&1; then
		if [ -n "$TLS_PIN" ]; then
			curl -fsSL --insecure --pinnedpubkey "$TLS_PIN" -o "$2" "$1" || rc=$?
		else
			curl -fsSL -o "$2" "$1" || rc=$?
		fi
		case "$rc" in
		0) return 0 ;;
		6|7|28|35) echo "install.sh: cannot reach $1" >&2 ;;
		*) echo "install.sh: download failed: $1 (curl exit $rc)" >&2 ;;
		esac
	elif command -v wget >/dev/null 2>&1; then
		if [ -n "$TLS_PIN" ]; then
			# wget cannot pin a key: the checksum below verifies the binary.
			wget -q --no-check-certificate -O "$2" "$1" 2>"$TMP/wget.err" || rc=$?
		else
			wget -qO "$2" "$1" 2>"$TMP/wget.err" || rc=$?
		fi
		[ "$rc" = 0 ] || cat "$TMP/wget.err" >&2
		# GNU wget: 4 network, 5 TLS; BusyBox wget exits 1 and says why.
		case "$rc" in
		0) return 0 ;;
		4|5) echo "install.sh: cannot reach $1" >&2 ;;
		*)
			if grep -qiE "can't connect|bad address|timed out|refused|no route to host|network is unreachable|resolve" "$TMP/wget.err"; then
				echo "install.sh: cannot reach $1" >&2
			else
				echo "install.sh: download failed: $1 (wget exit $rc)" >&2
			fi ;;
		esac
	else
		echo "install.sh: curl or wget is required" >&2
	fi
	exit 1
}

echo "Downloading whombat-agent ($ARCH) from $DOWNLOAD_BASE ..."
case "$DOWNLOAD_BASE" in
file://*)
	cp "${DOWNLOAD_BASE#file://}/whombat-agent-$OS-$ARCH" "$TMP/whombat-agent" ;;
*)
	fetch "$DOWNLOAD_BASE/whombat-agent-$OS-$ARCH" "$TMP/whombat-agent" ;;
esac
echo "$SUM  $TMP/whombat-agent" | $SHA256SUM -c - >/dev/null 2>&1 || { echo "install.sh: checksum mismatch" >&2; exit 1; }

# install_helper puts Whombat Helper in place (a Mac, when the hub has it):
# the signed app, root's, readable by the person whose session runs it, and
# its LaunchAgent for every desktop session.
install_helper() {
	if [ -z "$HELPER_SHA256" ]; then
		echo "The hub has no Whombat Helper; the Mac is added without it."
		return 0
	fi
	echo "Downloading Whombat Helper $HELPER_VERSION ..."
	case "$DOWNLOAD_BASE" in
	file://*) cp "${DOWNLOAD_BASE#file://}/whombat-helper-macos.zip" "$TMP/helper.zip" ;;
	*) fetch "$DOWNLOAD_BASE/whombat-helper-macos.zip" "$TMP/helper.zip" ;;
	esac
	echo "$HELPER_SHA256  $TMP/helper.zip" | $SHA256SUM -c - >/dev/null 2>&1 || { echo "install.sh: checksum mismatch (Whombat Helper)" >&2; exit 1; }
	mkdir -p "$HELPER_DIR"
	chown root:wheel "$HELPER_DIR"
	chmod 0755 "$HELPER_DIR"
	rm -rf "$HELPER_DIR/.new"
	mkdir "$HELPER_DIR/.new"
	ditto -x -k "$TMP/helper.zip" "$HELPER_DIR/.new" || { echo "install.sh: could not unpack Whombat Helper" >&2; exit 1; }
	new_app="$HELPER_DIR/.new/Whombat Helper.app"
	[ ! -L "$new_app" ] && [ -d "$new_app" ] && [ ! -L "$new_app/Contents/MacOS/WhombatHelper" ] && [ -f "$new_app/Contents/MacOS/WhombatHelper" ] &&
		[ -x "$new_app/Contents/MacOS/WhombatHelper" ] || { echo "install.sh: the Whombat Helper download holds no app" >&2; exit 1; }
	# The bundle the hub described, signed as built (the update checks the same).
	plist="$new_app/Contents/Info.plist"
	[ "$(plutil -extract CFBundleIdentifier raw -o - "$plist" 2>/dev/null)" = com.whombat.helper ] &&
		[ "$(plutil -extract CFBundleExecutable raw -o - "$plist" 2>/dev/null)" = WhombatHelper ] &&
		{ [ -z "$HELPER_VERSION" ] || [ "$(plutil -extract CFBundleShortVersionString raw -o - "$plist" 2>/dev/null)" = "$HELPER_VERSION" ]; } ||
		{ echo "install.sh: the Whombat Helper download isn't Whombat Helper $HELPER_VERSION" >&2; exit 1; }
	codesign --verify --deep --strict "$new_app" >/dev/null 2>&1 || { echo "install.sh: Whombat Helper's signature doesn't verify" >&2; exit 1; }
	if [ -n "$HELPER_TEAM" ] && [ "$(helper_team "$new_app")" != "$HELPER_TEAM" ]; then
		echo "install.sh: Whombat Helper isn't signed by the team the hub names" >&2; exit 1
	fi
	chown -R root:wheel "$HELPER_DIR/.new"
	chmod -R u+rwX,go+rX,go-w "$HELPER_DIR/.new"
	# macOS remembers Accessibility by the build it saw: a new ad hoc build, or
	# one by another signer, would show as switched on without having it, and
	# no entry to switch on would appear. Then the permission is reset, so the
	# new build shows up switched off. A build with the same requirement (the
	# same Developer ID team) keeps it.
	stale=0
	if [ -d "$HELPER_APP" ]; then
		old_req=$(helper_requirement "$HELPER_APP")
		old_team=$(helper_team "$HELPER_APP")
		new_req=$(helper_requirement "$HELPER_DIR/.new/Whombat Helper.app")
		new_team=$(helper_team "$HELPER_DIR/.new/Whombat Helper.app")
		if [ -z "$old_req" ] || [ "$old_req" != "$new_req" ]; then
			if [ -z "$new_team" ] || [ "$new_team" != "$old_team" ]; then stale=1; fi
		fi
	fi
	rm -rf "$HELPER_APP"
	mv "$HELPER_DIR/.new/Whombat Helper.app" "$HELPER_APP"
	rm -rf "$HELPER_DIR/.new"
	if [ "$stale" = 1 ]; then
		tccutil reset Accessibility com.whombat.helper >/dev/null 2>&1 || true
		echo "Whombat Helper is a new build to macOS: switch its Accessibility on again in System Settings → Privacy & Security → Accessibility."
	fi
	cat > "$HELPER_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.whombat.helper</string>
	<key>ProgramArguments</key>
	<array>
		<string>/Library/Application Support/Whombat/Whombat Helper.app/Contents/MacOS/WhombatHelper</string>
	</array>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
PLIST
	chown root:wheel "$HELPER_PLIST"
	chmod 0644 "$HELPER_PLIST"
}

# start_helper starts Whombat Helper in the session of whoever is at the
# screen (other sessions start it when they log in).
start_helper() {
	[ -f "$HELPER_PLIST" ] || return 0
	uid=$(stat -f %u /dev/console 2>/dev/null || echo 0)
	[ "$uid" != 0 ] || return 0
	launchctl bootout "gui/$uid/com.whombat.helper" 2>/dev/null || true
	i=0
	until launchctl bootstrap "gui/$uid" "$HELPER_PLIST" 2>/dev/null; do
		i=$((i+1))
		[ "$i" -lt 5 ] || { echo "Whombat Helper starts at the next login."; return 0; }
		sleep 1
	done
}

if [ "$OS" = darwin ]; then
	# Root's alone, all the way down: a folder someone else made there first
	# is taken back, a link in its place removed.
	for d in "$HELPER_DIR" "$AGENT_DIR"; do
		[ ! -L "$d" ] || rm -f "$d"
		mkdir -p "$d"
		chown root:wheel "$d"
		chmod 0755 "$d"
	done
	rm -f "$AGENT_BIN.new"
fi
install -m 0755 "$TMP/whombat-agent" "$AGENT_BIN.new"
mv -f "$AGENT_BIN.new" "$AGENT_BIN"
if [ "$OS" = darwin ]; then
	# The command line finds it in /usr/local/bin as before; an agent
	# installed there earlier gives way to the link.
	install -d -m 0755 /usr/local/bin
	rm -f /usr/local/bin/whombat-agent.prev /usr/local/bin/whombat-agent.new
	ln -sfn "$AGENT_BIN" /usr/local/bin/whombat-agent
fi
install -d -m 0700 "$CONFIG_DIR" /var/lib/whombat-agent

case "$SERVICE" in
systemd)
cat > /etc/systemd/system/whombat-agent.service <<'UNIT'
{{.Unit}}UNIT
systemctl daemon-reload
;;
openrc)
cat > /etc/init.d/whombat-agent <<'OPENRC'
{{.OpenRC}}OPENRC
chmod 0755 /etc/init.d/whombat-agent
;;
sysv)
cat > /etc/init.d/whombat-agent <<'RC'
{{.RC}}RC
chmod 0755 /etc/init.d/whombat-agent
;;
unraid)
# Unraid loads its OS into RAM, and the boot flash does not allow execution.
# Persist identity and the binary; keep the frequently written buffer in RAM.
cp "$TMP/whombat-agent" "$CONFIG_DIR/whombat-agent"
cat > "$CONFIG_DIR/rc.whombat-agent" <<'RC'
{{.UnraidRC}}RC
cat > "$CONFIG_DIR/start.sh" <<'START'
#!/bin/sh
set -eu
umask 077
BASE=/boot/config/plugins/whombat-agent
install -m 0755 "$BASE/whombat-agent" /usr/local/bin/whombat-agent.new
mv -f /usr/local/bin/whombat-agent.new /usr/local/bin/whombat-agent
install -m 0755 "$BASE/rc.whombat-agent" /etc/rc.d/rc.whombat-agent
install -d -m 0700 /var/lib/whombat-agent
/etc/rc.d/rc.whombat-agent start
START
;;
launchd)
cat > "$LAUNCHD_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.whombat.agent</string>
	<key>ProgramArguments</key>
	<array>
		<string>/Library/Application Support/Whombat/bin/whombat-agent</string>
		<string>run</string>
		<string>--config-dir</string>
		<string>/etc/whombat-agent</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>/var/log/whombat-agent.log</string>
	<key>StandardErrorPath</key>
	<string>/var/log/whombat-agent.log</string>
</dict>
</plist>
PLIST
chown root:wheel "$LAUNCHD_PLIST"
chmod 0644 "$LAUNCHD_PLIST"
# The log rotates at 10 MB, five kept.
mkdir -p /etc/newsyslog.d
cat > /etc/newsyslog.d/whombat-agent.conf <<'NEWSYSLOG'
# logfilename                 [owner:group]  mode  count  size(KB)  when  flags
/var/log/whombat-agent.log    root:wheel     640   5      10240     *     J
NEWSYSLOG
chmod 0644 /etc/newsyslog.d/whombat-agent.conf
install_helper
;;
esac

AGENT="$AGENT_BIN"
if [ "$MODE" = keep ] && [ -n "$TOKEN" ]; then
	# The same Whombat, but it may have removed this server (or let its
	# certificate expire): then the identity is dead, enroll again.
	STATE=$("$AGENT" whoami --check --hub "$HUB_URL" --config-dir "$CONFIG_DIR" 2>/dev/null | awk '{print $3}') || STATE=""
	if [ "$STATE" = removed ]; then
		echo "Whombat no longer knows this server's agent, so it enrolls again."
		MODE=enroll
		FORCE=1
	fi
fi
if [ "$MODE" = enroll ]; then
	echo "Enrolling with $HUB_URL ..."
	if [ "$FORCE" = 1 ]; then
		printf '%s\n' "$TOKEN" | "$AGENT" enroll --hub "$HUB_URL" --ca-sha256 "$CA_SHA256" --token - --config-dir "$CONFIG_DIR" --force
	else
		printf '%s\n' "$TOKEN" | "$AGENT" enroll --hub "$HUB_URL" --ca-sha256 "$CA_SHA256" --token - --config-dir "$CONFIG_DIR"
	fi
else
	echo "Keeping this server's Whombat identity and configuration."
	"$AGENT" hub "$HUB_URL" --config-dir "$CONFIG_DIR" --no-restart
fi
if [ -n "$CONTROL" ]; then
	"$AGENT" policy set "$CONTROL" --config-dir "$CONFIG_DIR" --no-reload
fi
SERVER_ID=$("$AGENT" whoami --config-dir "$CONFIG_DIR" | awk '{print $1}')

case "$SERVICE" in
systemd)
systemctl enable whombat-agent.service
systemctl restart whombat-agent.service
;;
openrc)
rc-update add whombat-agent default
rc-service whombat-agent restart
;;
sysv)
if command -v update-rc.d >/dev/null 2>&1; then
	update-rc.d whombat-agent defaults
else
	chkconfig --add whombat-agent
	chkconfig whombat-agent on
fi
/etc/init.d/whombat-agent restart
;;
unraid)
# Preserve the owner's boot commands. Add our hook only after enrollment.
HOOK='/bin/sh /boot/config/plugins/whombat-agent/start.sh'
if ! grep -Fx "$HOOK" /boot/config/go >/dev/null; then
	[ -f "$CONFIG_DIR/go.before-whombat-agent" ] || cp /boot/config/go "$CONFIG_DIR/go.before-whombat-agent"
	printf '\n# Whombat agent\n%s\n' "$HOOK" >> /boot/config/go
fi
# An upgrade must restart the worker; a repeated boot hook stays idempotent.
if [ -x /etc/rc.d/rc.whombat-agent ]; then /etc/rc.d/rc.whombat-agent stop; fi
/bin/sh "$CONFIG_DIR/start.sh"
;;
launchd)
# Loaded again so a changed LaunchDaemon takes effect; launchd may need a
# moment to let go of the old one.
launchctl enable "system/$LAUNCHD_LABEL" 2>/dev/null || true
launchctl bootout "system/$LAUNCHD_LABEL" 2>/dev/null || true
i=0
until launchctl bootstrap system "$LAUNCHD_PLIST" 2>/dev/null; do
	i=$((i+1))
	[ "$i" -lt 10 ] || { echo "install.sh: launchd did not start the agent" >&2; exit 1; }
	sleep 1
done
start_helper
;;
esac
echo "Whombat agent installed and running."
if [ "$MODE" = enroll ]; then
	echo "Added to Whombat as $SERVER_ID."
	echo "whombat-agent: added $SERVER_ID"
else
	echo "Updated the agent; this server stays in Whombat as $SERVER_ID."
	echo "whombat-agent: kept $SERVER_ID"
fi
`))

// compressible reports whether an asset is text worth gzipping.
func compressible(p string) bool {
	switch path.Ext(p) {
	case ".js", ".css", ".svg", ".json", ".html", ".txt", ".map", ".webmanifest":
		return true
	}
	return false
}

// gzipCache keeps gzipped copies of immutable assets.
type gzipCache struct {
	mu sync.Mutex
	m  map[string][]byte
}

func (c *gzipCache) get(fsys fs.FS, p string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if z, ok := c.m[p]; ok {
		return z, z != nil
	}
	b, err := fs.ReadFile(fsys, p)
	if err != nil || len(b) < gzipMinSize {
		c.m[p] = nil
		return nil, false
	}
	z := gzipBytes(b)
	if len(c.m) > 512 {
		c.m = map[string][]byte{}
	}
	c.m[p] = z
	return z, z != nil
}
