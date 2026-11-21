package dest

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
	"github.com/CybexBV/whombat/appliance/backup/pkg/sshkey"
)

// SSHPublicKey is the box's key for SFTP destinations (the contract's BackupSshPublicKey, CT-142).
type SSHPublicKey struct {
	PublicKey   string `json:"publicKey"`   // one authorized_keys line
	Fingerprint string `json:"fingerprint"` // SHA256:…
}

// PublicKey returns the box's SFTP key, generating it on the first call (BK-19). The private key is a
// secret of the backup service (0600, sealed with the others); only the public half leaves the box.
func PublicKey(c *state.Config) (*SSHPublicKey, error) {
	priv, err := ensureSSHKey(c)
	if err != nil {
		return nil, err
	}
	pub := priv.Public().(ed25519.PublicKey)
	return &SSHPublicKey{PublicKey: sshkey.AuthorizedKey(pub, keyComment(c)),
		Fingerprint: sshkey.Ed25519Public(pub).Fingerprint()}, nil
}

func keyComment(c *state.Config) string {
	id := c.ApplianceID
	if id == "" {
		id = "appliance"
	}
	return "whombat-backup@" + id
}

// ensureSSHKey loads the box's key or makes one.
func ensureSSHKey(c *state.Config) (ed25519.PrivateKey, error) {
	text, err := c.ReadSecret(state.SecretSSHKey)
	if err != nil {
		return nil, err
	}
	if text != "" {
		return sshkey.ParsePrivate([]byte(text))
	}
	priv, err := sshkey.Generate()
	if err != nil {
		return nil, err
	}
	if err := c.WriteSecret(state.SecretSSHKey, string(sshkey.MarshalPrivate(priv, keyComment(c)))); err != nil {
		return nil, err
	}
	return priv, nil
}

// configureSFTP resolves the key and the pinned host key of an SFTP destination into the destination and
// the verification repository (staged: the pin and a kit's key are kept only when the repository opens).
func configureSFTP(ctx context.Context, c *state.Config, req Request, d *state.Destination, repo *restic.Repo, st *staged) error {
	loc, err := restic.ParseSFTP(req.Repository)
	if err != nil {
		return bad("%v", err)
	}
	d.SFTPUser = req.SFTPUser
	keyFile := ""
	if req.SFTPPrivateKey != "" { // a recovery kit's key (console adopt)
		if _, err := sshkey.ParsePrivate([]byte(req.SFTPPrivateKey)); err != nil {
			return bad("the kit's SFTP key: %v", err)
		}
		if keyFile, err = st.put(state.SecretSSHKey, strings.TrimSpace(req.SFTPPrivateKey)+"\n"); err != nil {
			return err
		}
	} else {
		if _, err := ensureSSHKey(c); err != nil {
			return err
		}
		keyFile = c.SecretPath(state.SecretSSHKey)
	}

	var pin sshkey.PublicKey
	given := strings.TrimSpace(req.SFTPHostKey)
	switch {
	case given != "" && !sshkey.IsFingerprint(given):
		if pin, err = sshkey.ParsePublicKey(given); err != nil {
			return bad("%v", err)
		}
	default: // trust on first use, or check the scanned key against the fingerprint the owner gave
		keys, err := ScanHostKeys(ctx, c.SSH, loc.Host, loc.Port)
		if err != nil {
			return &DestError{Reason: ReasonUnreachable, Err: err}
		}
		if given == "" {
			pin = keys[0]
			break
		}
		found := false
		var seen []string
		for _, k := range keys {
			seen = append(seen, k.Fingerprint())
			if sshkey.SameFingerprint(k.Fingerprint(), given) {
				pin, found = k, true
				break
			}
		}
		if !found {
			return &DestError{Reason: ReasonSFTPHostKey,
				Err: fmt.Errorf("host key mismatch: the server offers %s, expected %s", strings.Join(seen, ", "), given)}
		}
	}
	d.SFTPHostKey, d.SFTPHostKeyFingerprint = pin.String(), pin.Fingerprint()
	known := filepath.Join(st.dir, "known_hosts")
	if err := state.WriteFileAtomic(known, []byte(sshkey.KnownHostsLine(loc.Host, loc.Port, pin)), 0o600); err != nil {
		return err
	}
	repo.SFTP = &restic.SFTP{SSH: c.SSH, Host: loc.Host, Port: loc.Port, User: req.SFTPUser, KeyFile: keyFile,
		KnownHostsFile: known, HostKeyAlgorithms: pin.HostKeyAlgorithms()}
	if err := repo.SFTP.Validate(); err != nil {
		return bad("%v", err)
	}
	return nil
}

// ScanHostKeys asks the server for its host keys (ssh-keyscan, unauthenticated: trust on first use, the
// fingerprint is shown to the owner to compare) and answers them best type first.
func ScanHostKeys(ctx context.Context, ssh, host string, port int) ([]sshkey.PublicKey, error) {
	if !restic.ValidHost(host) {
		return nil, fmt.Errorf("%q is not a host name or address", host)
	}
	bin := "ssh-keyscan"
	if filepath.IsAbs(ssh) {
		bin = filepath.Join(filepath.Dir(ssh), "ssh-keyscan")
	}
	if port == 0 {
		port = 22
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "-T", "10", "-p", strconv.Itoa(port), "-t", "ed25519,ecdsa,rsa", host)
	cmd.Env = []string{"PATH=/nonexistent"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	runErr := cmd.Run()
	var keys []sshkey.PublicKey
	for _, line := range strings.Split(out.String(), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if k, err := sshkey.ParsePublicKey(line); err == nil {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		msg := strings.TrimSpace(errb.String())
		if runErr != nil && msg == "" {
			msg = runErr.Error()
		}
		if msg == "" {
			msg = "no answer"
		}
		return nil, fmt.Errorf("ssh-keyscan %s port %d: %s", host, port, msg)
	}
	for i := 1; i < len(keys); i++ { // best type first (stable)
		for j := i; j > 0 && sshkey.Rank(keys[j].Type) < sshkey.Rank(keys[j-1].Type); j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys, nil
}
