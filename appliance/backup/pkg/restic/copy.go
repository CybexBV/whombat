package restic

import (
	"context"
	"errors"
	"io"
	"strings"
)

// ErrCopyCredentials: the two repositories of a copy need different credentials of the same kind. restic gives both
// the same environment (restic 0.18: `AWS_*` and `RESTIC_REST_*` apply to the source and the target alike, and `-o
// sftp.command` is one option for both), so two buckets with different keys, two REST servers with different users or
// two SFTP servers can't be one copy; nor can an S3 source over https whose certificate authority isn't the target's
// (restic's --cacert is one setting for both).
var ErrCopyCredentials = errors.New("the two places need different credentials of the same kind, which one restic copy can't hold")

// Paired is r as the target of a copy from src: the environment and options carry both repositories' credentials.
// Each place's certificate authority stays on its own connection: restic's --cacert is one setting for both
// repositories, so a REST source over https is reached through a relay on a socket of its own (relay.go) that trusts
// only the source's authority (its private CA, else the system's roots), and --cacert keeps the target's. done stops
// the relay and removes what Paired wrote; call it when the copy ended.
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
	switch {
	case s.CACert == r.CACert || !s.overTLS():
		// The same authority for both, or a source restic reaches without TLS (a disk, SFTP, plain http on the home
		// network): --cacert, when set, is the target's alone.
		s.CACert = ""
		return p, done, nil
	case strings.HasPrefix(s.Repository, "rest:"):
		repository, stop, err := startRelay(s, tmpDir)
		if err != nil {
			return r, done, err
		}
		s.Repository, s.CACert = repository, ""
		return p, stop, nil
	}
	// An S3 source over https whose authority differs from the target's: restic would trust one for both, and its
	// signatures name the host, so no relay can stand in for it.
	return r, done, ErrCopyCredentials
}

// overTLS: restic reaches the repository over https.
func (r Repo) overTLS() bool {
	return strings.HasPrefix(r.Repository, "rest:https://") || strings.HasPrefix(r.Repository, "s3:https://")
}

func (r Repo) hasS3() bool { return r.S3AccessKeyID != "" || r.S3SecretAccessKey != "" }

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
