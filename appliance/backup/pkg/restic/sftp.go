package restic

import (
	"errors"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
)

// SFTP is the ssh invocation restic runs for an sftp: repository (restic -o sftp.command=…, BK-19). It
// is hardened so nothing on the machine changes what it does: no configuration files (-F none), no agent,
// only the given key, the server's host key checked strictly against the pinned one (and only that key
// type negotiated), no forwarding, no multiplexing, no proxy, no local command, batch mode (never a
// prompt). No secret is on this command line: the key is a file only the backup user (and root) can read.
type SFTP struct {
	SSH            string // ssh binary ("" = "ssh" on PATH)
	Host           string
	Port           int // 0 = 22
	User           string
	KeyFile        string // the box's private key (OpenSSH format, 0400/0600)
	KnownHostsFile string // one line: the pinned host key
	// HostKeyAlgorithms restricts negotiation to the pinned key's type ("" = ssh's default order).
	HostKeyAlgorithms string
	ConnectTimeout    int // seconds (0 = 20)
}

// Args is the full ssh argv (restic appends nothing: the subsystem is part of it).
func (s SFTP) Args() []string {
	bin := s.SSH
	if bin == "" {
		bin = "ssh"
	}
	port := s.Port
	if port == 0 {
		port = 22
	}
	timeout := s.ConnectTimeout
	if timeout == 0 {
		timeout = 20
	}
	a := []string{bin, "-F", "none",
		"-o", "BatchMode=yes",
		"-o", "IdentitiesOnly=yes",
		"-o", "IdentityAgent=none",
		"-o", "IdentityFile=" + s.KeyFile,
		"-o", "PasswordAuthentication=no",
		"-o", "KbdInteractiveAuthentication=no",
		"-o", "PubkeyAuthentication=yes",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "UserKnownHostsFile=" + s.KnownHostsFile,
		"-o", "GlobalKnownHostsFile=none",
		"-o", "UpdateHostKeys=no",
		"-o", "CheckHostIP=no",
		"-o", "VerifyHostKeyDNS=no",
		"-o", "HashKnownHosts=no",
		"-o", "ForwardAgent=no",
		"-o", "ForwardX11=no",
		"-o", "ClearAllForwardings=yes",
		"-o", "PermitLocalCommand=no",
		"-o", "ControlMaster=no",
		"-o", "ControlPath=none",
		"-o", "ProxyCommand=none",
		"-o", "ProxyJump=none",
		"-o", "LogLevel=ERROR",
		"-o", "ConnectTimeout=" + strconv.Itoa(timeout),
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=4",
	}
	if s.HostKeyAlgorithms != "" {
		a = append(a, "-o", "HostKeyAlgorithms="+s.HostKeyAlgorithms)
	}
	return append(a, "-p", strconv.Itoa(port), "-l", s.User, "-s", "--", s.Host, "sftp")
}

// Command is Args as the one string restic splits (its shell-like splitting, no shell involved). Every
// part is checked by Validate to contain no whitespace or quotes.
func (s SFTP) Command() string { return strings.Join(s.Args(), " ") }

var (
	sftpUserRe = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$`)
	hostRe     = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
	safePathRe = regexp.MustCompile(`^[^\s"'\\]+$`)
)

// Validate refuses anything that could change the command's meaning once split.
func (s SFTP) Validate() error {
	if !sftpUserRe.MatchString(s.User) {
		return errors.New("the SFTP user name may contain only letters, digits, '.', '_' and '-'")
	}
	if !ValidHost(s.Host) {
		return fmt.Errorf("%q is not a host name or address", s.Host)
	}
	if s.Port < 0 || s.Port > 65535 {
		return fmt.Errorf("port %d is out of range", s.Port)
	}
	for _, p := range []string{s.SSH, s.KeyFile, s.KnownHostsFile, s.HostKeyAlgorithms} {
		if p != "" && !safePathRe.MatchString(p) {
			return fmt.Errorf("%q can't be used on the ssh command line", p)
		}
	}
	if s.KeyFile == "" || s.KnownHostsFile == "" {
		return errors.New("an SFTP destination needs the box's key and the pinned host key")
	}
	return nil
}

// ValidHost accepts a DNS name or an IP address (never something ssh would read as an option).
func ValidHost(h string) bool {
	if net.ParseIP(h) != nil {
		return true
	}
	return hostRe.MatchString(h) && !strings.HasPrefix(h, "-")
}

// SFTPLocation is where an sftp: repository points.
type SFTPLocation struct {
	Host string
	Port int // 0 = default
	Path string
}

// ParseSFTP reads the two repository forms restic knows, without a user (the user is separate, BK-19):
// "sftp:host:/path" (or a relative "sftp:host:path") and "sftp://host[:port]/path" ("//path" absolute).
// IPv6 addresses need the URL form with brackets.
func ParseSFTP(repo string) (SFTPLocation, error) {
	var loc SFTPLocation
	switch {
	case strings.HasPrefix(repo, "sftp://"):
		rest := strings.TrimPrefix(repo, "sftp://")
		i := strings.Index(rest, "/")
		if i <= 0 {
			return loc, errors.New("an sftp:// repository needs a host and a path (sftp://host:port//absolute/path)")
		}
		hostport, path := rest[:i], rest[i+1:]
		host, port := hostport, ""
		if h, p, err := net.SplitHostPort(hostport); err == nil {
			host, port = h, p
		} else if strings.HasPrefix(hostport, "[") && strings.HasSuffix(hostport, "]") {
			host = hostport[1 : len(hostport)-1]
		}
		if port != "" {
			n, err := strconv.Atoi(port)
			if err != nil || n <= 0 || n > 65535 {
				return loc, fmt.Errorf("port %q is not a port number", port)
			}
			loc.Port = n
		}
		loc.Host, loc.Path = host, path
	case strings.HasPrefix(repo, "sftp:"):
		rest := strings.TrimPrefix(repo, "sftp:")
		i := strings.Index(rest, ":")
		if i <= 0 {
			return loc, errors.New("an sftp repository is sftp:host:/path (or sftp://host:port//path)")
		}
		loc.Host, loc.Path = rest[:i], rest[i+1:]
	default:
		return loc, errors.New("not an sftp repository")
	}
	if strings.Contains(repo, "@") {
		return loc, errors.New("put the SFTP user in its own field, not in the repository")
	}
	if !ValidHost(loc.Host) {
		return loc, fmt.Errorf("%q is not a host name or address", loc.Host)
	}
	if strings.TrimLeft(loc.Path, "/") == "" {
		return loc, errors.New("the SFTP repository needs a folder on the server (sftp:host:/path)")
	}
	if strings.ContainsAny(loc.Path, "\n\r\x00") {
		return loc, errors.New("the SFTP path contains control characters")
	}
	return loc, nil
}
