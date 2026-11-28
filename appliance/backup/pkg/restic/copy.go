package restic

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// ErrCopyCredentials: the two repositories of a copy need different credentials of the same kind. restic gives both
// the same environment (restic 0.18: `AWS_*` and `RESTIC_REST_*` apply to the source and the target alike, and `-o
// sftp.command` is one option for both), so two buckets with different keys, two REST servers with different users or
// two SFTP servers can't be one copy.
var ErrCopyCredentials = errors.New("the two places need different credentials of the same kind, which one restic copy can't hold")

// Paired is r as the target of a copy from src: the environment and options carry both repositories' credentials,
// and a private CA of either is added to the system's roots (restic's --cacert replaces them, and the other place
// most likely needs them). done removes what Paired wrote; call it when the copy ended.
func (r Repo) Paired(src Repo, tmpDir string) (paired Repo, done func(), err error) {
	done = func() {}
	s := src
	s.From = nil
	switch {
	case s.SFTP != nil && r.SFTP != nil:
		return r, done, ErrCopyCredentials
	case s.RESTUser != "" && r.RESTUser != "" && (s.RESTUser != r.RESTUser || s.RESTPassword != r.RESTPassword):
		return r, done, ErrCopyCredentials
	case s.hasS3() && r.hasS3() &&
		(s.S3AccessKeyID != r.S3AccessKeyID || s.S3SecretAccessKey != r.S3SecretAccessKey || s.S3Region != r.S3Region):
		return r, done, ErrCopyCredentials
	}
	p := r
	p.From = &s
	if s.CACert == "" && r.CACert == "" {
		return p, done, nil
	}
	dir, err := os.MkdirTemp(tmpDir, ".copy-ca-")
	if err != nil {
		return r, done, err
	}
	done = func() { _ = os.RemoveAll(dir) }
	var bundle []byte
	if sys := systemRoots(); sys != nil {
		bundle = append(bundle, sys...)
		bundle = append(bundle, '\n')
	}
	for _, f := range []string{s.CACert, r.CACert} {
		if f == "" {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			done()
			return r, func() {}, err
		}
		bundle = append(bundle, b...)
		bundle = append(bundle, '\n')
	}
	p.CACert = filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(p.CACert, bundle, 0o600); err != nil {
		done()
		return r, func() {}, err
	}
	return p, done, nil
}

func (r Repo) hasS3() bool { return r.S3AccessKeyID != "" || r.S3SecretAccessKey != "" }

// systemRoots reads the system's CA bundle (nil when there is none to read).
func systemRoots() []byte {
	for _, p := range []string{os.Getenv("SSL_CERT_FILE"), "/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/certs/ca-bundle.crt",
		"/etc/pki/tls/certs/ca-bundle.crt"} {
		if p == "" {
			continue
		}
		if b, err := os.ReadFile(p); err == nil && len(b) > 0 {
			return b
		}
	}
	return nil
}

// fromArgs are the source's flags of a copy or a chunker-parameter init.
func (r Repo) fromArgs() []string {
	return []string{"--from-repo", r.From.Repository, "--from-password-file", r.From.PasswordFile}
}

// CopyFrom copies the snapshots ids of r.From (set by Paired) into r (`restic copy`). Copied snapshots keep their
// tags, host and time; restic skips those already there. ids must name at least one snapshot: an empty list would
// copy every snapshot.
func (r Repo) CopyFrom(ctx context.Context, ids ...string) error {
	if r.From == nil {
		return errors.New("restic copy: no source repository")
	}
	if len(ids) == 0 {
		return errors.New("restic copy: no snapshots named")
	}
	args := append(append([]string{"copy"}, r.fromArgs()...), ids...)
	_, err := r.unlocked(ctx, io.Discard, args...)
	return err
}

// InitFrom creates r with the chunker parameters of r.From (set by Paired), so what restic copies is cut the same
// way and stays deduplicated, and returns its id.
func (r Repo) InitFrom(ctx context.Context) (string, error) {
	if r.From == nil {
		return "", errors.New("restic init: no source repository")
	}
	args := append([]string{"init", "--repository-version", "2", "--copy-chunker-params"}, r.fromArgs()...)
	if _, err := r.run(ctx, nil, true, args...); err != nil {
		return "", err
	}
	c, err := r.Config(ctx)
	if err != nil {
		return "", err
	}
	return c.ID, nil
}

// sourceEnv is what the source of a copy needs in restic's environment that the target doesn't set itself.
func (r Repo) sourceEnv() []string {
	s := r.From
	if s == nil {
		return nil
	}
	var e []string
	if r.RESTUser == "" && s.RESTUser != "" {
		e = append(e, "RESTIC_REST_USERNAME="+s.RESTUser, "RESTIC_REST_PASSWORD="+s.RESTPassword)
	}
	if !r.hasS3() && s.hasS3() {
		e = append(e, "AWS_ACCESS_KEY_ID="+s.S3AccessKeyID, "AWS_SECRET_ACCESS_KEY="+s.S3SecretAccessKey,
			"AWS_SHARED_CREDENTIALS_FILE=/dev/null", "AWS_CONFIG_FILE=/dev/null")
		if s.S3Region != "" {
			e = append(e, "AWS_DEFAULT_REGION="+s.S3Region)
		}
	}
	return e
}

// sourceArgs are the source's global options (its ssh command) the target doesn't set itself.
func (r Repo) sourceArgs() []string {
	if s := r.From; s != nil && s.SFTP != nil && r.SFTP == nil {
		return []string{"-o", "sftp.command=" + s.SFTP.Command()}
	}
	return nil
}
