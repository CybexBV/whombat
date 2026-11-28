// Package restic wraps the restic binary (0.18) for the backup service and the recovery tool. Secrets
// never go on the command line: the repository password comes from a file (RESTIC_PASSWORD_FILE), REST
// credentials from RESTIC_REST_USERNAME / RESTIC_REST_PASSWORD and S3 credentials from AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY in the child's environment only (readable by the same user and root, never by
// other users: /proc/<pid>/environ is 0400), and the SFTP key is a file named on ssh's command line
// (BK-18, BK-19). restic's error output is redacted of every secret the Repo knows before it is returned.
package restic

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Errors classified from restic's exit codes (restic ≥ 0.17) and messages.
var (
	ErrNoRepository  = errors.New("repository does not exist")
	ErrWrongPassword = errors.New("wrong repository password (or no key found)")
	ErrLocked        = errors.New("repository is locked")
	ErrForbidden     = errors.New("destination refused the operation (forbidden)")
)

// Repo is one restic repository.
type Repo struct {
	Binary       string // default "restic"
	Repository   string // "rest:https://host:port/path/", "s3:https://host/bucket/path", "sftp:host:/path" (no credentials in any) or a local path
	PasswordFile string
	RESTUser     string
	RESTPassword string
	// S3 credentials (s3: repositories), passed in restic's environment only.
	S3AccessKeyID     string
	S3SecretAccessKey string
	S3Region          string
	// SFTP is the ssh invocation restic runs for sftp: repositories (-o sftp.command); nil for others.
	SFTP     *SFTP
	CacheDir string // default: restic's; "" + NoCache disables
	NoCache  bool
	CACert   string // optional --cacert for a private CA
	// RetryLock is how long restic waits for a lock another restic holds (`--retry-lock`): long for the timers' runs,
	// which nobody waits for; zero is InteractiveRetryLock, for the calls a person waits on.
	RetryLock time.Duration
	// PackSizeMB is restic's --pack-size for what it writes (0 = restic's 16 MiB).
	PackSizeMB int
	// CheckWithCache: `check` uses the cache (CacheDir) instead of a temporary one of its own, so the index and
	// trees already there aren't downloaded again; what it reads that isn't there is still read from the destination.
	CheckWithCache bool
	// From is the source of a copy (`Paired`): its credentials join this repository's in restic's environment.
	From *Repo
}

// How long restic waits for another restic's lock: a person waiting on a call (zero RetryLock) gets an answer soon,
// a timer's run outwaits a short NAS cleanup.
const (
	InteractiveRetryLock = 30 * time.Second
	TimerRetryLock       = 5 * time.Minute
)

// Error is a failed restic invocation.
type Error struct {
	Args   []string
	Code   int
	Stderr string
	Kind   error
}

func (e *Error) Error() string {
	msg := strings.TrimSpace(e.Stderr)
	if e.Code == -1 && msg == "" {
		msg = "restic could not be run"
	}
	if len(msg) > 600 {
		msg = msg[len(msg)-600:]
	}
	k := ""
	if e.Kind != nil {
		k = e.Kind.Error() + ": "
	}
	return fmt.Sprintf("restic %s: %sexit %d: %s", e.Args[0], k, e.Code, msg)
}

func (e *Error) Unwrap() error { return e.Kind }

func (r Repo) bin() string {
	if r.Binary != "" {
		return r.Binary
	}
	return "restic"
}

func (r Repo) env() []string {
	e := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		"TMPDIR=" + os.Getenv("TMPDIR"),
		"RESTIC_REPOSITORY=" + r.Repository,
		"RESTIC_PASSWORD_FILE=" + r.PasswordFile,
		"RESTIC_PROGRESS_FPS=0.016",
	}
	if r.RESTUser != "" {
		e = append(e, "RESTIC_REST_USERNAME="+r.RESTUser, "RESTIC_REST_PASSWORD="+r.RESTPassword)
	}
	if r.S3AccessKeyID != "" || r.S3SecretAccessKey != "" {
		// Exactly these credentials: no shared credentials file or instance metadata lookup (minio-go's
		// chain would otherwise try them when a variable is missing).
		e = append(e, "AWS_ACCESS_KEY_ID="+r.S3AccessKeyID, "AWS_SECRET_ACCESS_KEY="+r.S3SecretAccessKey,
			"AWS_SHARED_CREDENTIALS_FILE=/dev/null", "AWS_CONFIG_FILE=/dev/null")
		if r.S3Region != "" {
			e = append(e, "AWS_DEFAULT_REGION="+r.S3Region)
		}
	}
	if r.CacheDir != "" {
		e = append(e, "RESTIC_CACHE_DIR="+r.CacheDir)
	}
	return append(e, r.sourceEnv()...)
}

func (r Repo) args(a []string) []string {
	var pre []string
	if r.NoCache {
		pre = append(pre, "--no-cache")
	}
	if r.CACert != "" {
		pre = append(pre, "--cacert", r.CACert)
	}
	if r.SFTP != nil {
		pre = append(pre, "-o", "sftp.command="+r.SFTP.Command())
	}
	pre = append(pre, r.sourceArgs()...)
	wait := r.RetryLock
	if wait <= 0 {
		wait = InteractiveRetryLock
	}
	pre = append(pre, "--retry-lock", wait.String())
	if r.PackSizeMB > 0 {
		pre = append(pre, "--pack-size", strconv.Itoa(r.PackSizeMB))
	}
	return append(pre, a...)
}

// terminate is how a cancelled restic is stopped: SIGTERM lets it remove its lock from the repository (a killed one
// leaves it, and the next check, prune or backup then fails on it); WaitDelay kills it when it doesn't stop.
func terminate(cmd *exec.Cmd) func() error {
	return func() error { return cmd.Process.Signal(syscall.SIGTERM) }
}

// detached runs restic in a session of its own, without a controlling terminal: ssh (SFTP) can never
// prompt, and restic never makes ssh the terminal's foreground process group — which, when restic is
// stopped at a hopeless retry, left the console's shell in the background (reads failed with EIO).
func detached() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

// secrets are the values that must never appear in an error message.
func (r Repo) secrets() []string {
	var s []string
	vals := []string{r.RESTPassword, r.S3SecretAccessKey, r.S3AccessKeyID}
	if r.From != nil {
		vals = append(vals, r.From.RESTPassword, r.From.S3SecretAccessKey, r.From.S3AccessKeyID)
	}
	for _, v := range vals {
		if len(v) >= 4 {
			s = append(s, v)
		}
	}
	return s
}

// Redact replaces every secret the Repo knows in s.
func (r Repo) Redact(s string) string {
	for _, v := range r.secrets() {
		s = strings.ReplaceAll(s, v, "[redacted]")
	}
	return s
}

func classify(code int, stderr string) error {
	switch {
	case code == 10 || strings.Contains(stderr, "repository does not exist") || strings.Contains(stderr, "unable to open config file") ||
		strings.Contains(stderr, "The specified bucket does not exist") || strings.Contains(stderr, "NoSuchBucket"):
		return ErrNoRepository
	case code == 12 || strings.Contains(stderr, "wrong password"):
		return ErrWrongPassword
	case code == 11 || strings.Contains(stderr, "unable to create lock"):
		return ErrLocked
	case strings.Contains(stderr, "403") || strings.Contains(stderr, "Forbidden"):
		return ErrForbidden
	}
	return nil
}

// Run runs restic with args, writing stdout to out (if non-nil) and returning captured stdout otherwise.
// A failure restic would retry for many minutes but that can't heal (bad credentials, a missing bucket, a
// refused key) ends the run at once (BK-21).
func (r Repo) Run(ctx context.Context, out io.Writer, args ...string) ([]byte, error) {
	return r.run(ctx, out, false, args...)
}

// Unlock removes the repository's stale locks (`restic unlock`): those of a restic on this box that is gone (killed,
// or the power went), and those nobody refreshed for 30 minutes. A lock a running restic holds, here or on the NAS,
// stays.
func (r Repo) Unlock(ctx context.Context) error {
	_, err := r.once(ctx, nil, true, "unlock")
	return err
}

// unlocked runs a command that takes the repository's lock: stale locks removed first.
func (r Repo) unlocked(ctx context.Context, out io.Writer, args ...string) ([]byte, error) {
	_ = r.Unlock(ctx) // a destination that refuses it still runs the command, which then says what is wrong
	return r.Run(ctx, out, args...)
}

// run is Run; failFast also ends the run at restic's first retry of any error (an interactive check such
// as opening the repository: the caller retries later instead).
func (r Repo) run(ctx context.Context, out io.Writer, failFast bool, args ...string) ([]byte, error) {
	b, err := r.once(ctx, out, failFast, args...)
	if errors.Is(err, ErrLocked) && ctx.Err() == nil {
		// Locked past the wait: most often a lock left by a restic that was killed. Its stale locks go, and one more try.
		if uerr := r.Unlock(ctx); uerr == nil {
			if bw, ok := out.(*bytes.Buffer); ok {
				bw.Reset()
			}
			b, err = r.once(ctx, out, failFast, args...)
		}
	}
	return b, err
}

func (r Repo) once(ctx context.Context, out io.Writer, failFast bool, args ...string) ([]byte, error) {
	full := r.args(args)
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(cctx, r.bin(), full...)
	cmd.Env = r.env()
	cmd.SysProcAttr = detached()
	cmd.Cancel = terminate(cmd)
	cmd.WaitDelay = 10 * time.Second
	var buf bytes.Buffer
	if out != nil {
		cmd.Stdout = out
	} else {
		cmd.Stdout = &buf
	}
	errw := &retryWatch{failFast: failFast, stop: cancel}
	cmd.Stderr = errw
	err := cmd.Run()
	if err != nil {
		code := -1
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		}
		stderr := errw.String()
		if errw.gaveUp() {
			return buf.Bytes(), &Error{Args: args, Code: code, Stderr: r.Redact(stderr), Kind: classify(code, stderr)}
		}
		if ctx.Err() != nil {
			return buf.Bytes(), fmt.Errorf("restic %s: %w", args[0], ctx.Err())
		}
		return buf.Bytes(), &Error{Args: args, Code: code, Stderr: r.Redact(stderr), Kind: classify(code, stderr)}
	}
	return buf.Bytes(), nil
}

// permanent are causes restic retries (its backends retry every error for up to 15 minutes) that no
// retry heals.
var permanent = []string{
	"the specified bucket does not exist", "nosuchbucket",
	"the request signature we calculated does not match", "signaturedoesnotmatch",
	"the access key id you provided does not exist", "invalidaccesskeyid",
	"access denied", "accessdenied", "authorizationheadermalformed", "permanentredirect",
	"unexpected http response (401)", "unexpected http response (403)",
	"host key verification failed", "permission denied (publickey",
}

// retryWatch collects restic's stderr and stops the run at a retry that can't help.
type retryWatch struct {
	mu       sync.Mutex
	b        bytes.Buffer
	line     []byte
	failFast bool
	stop     func()
	stopped  bool
}

func (w *retryWatch) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.b.Write(p)
	for _, c := range p {
		if c != '\n' {
			w.line = append(w.line, c)
			continue
		}
		w.check(string(w.line))
		w.line = w.line[:0]
	}
	return len(p), nil
}

func (w *retryWatch) check(line string) {
	low := strings.ToLower(line)
	if w.stopped || !strings.Contains(low, "retrying after") {
		return
	}
	hit := w.failFast
	for _, p := range permanent {
		hit = hit || strings.Contains(low, p)
	}
	if hit {
		w.stopped = true
		w.stop()
	}
}

func (w *retryWatch) gaveUp() bool { w.mu.Lock(); defer w.mu.Unlock(); return w.stopped }

func (w *retryWatch) String() string { w.mu.Lock(); defer w.mu.Unlock(); return w.b.String() }

// Config is the repository's config file.
type Config struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
	// ChunkerPolynomial is how the repository cuts files into chunks: a copy made with the same one stays deduplicated.
	ChunkerPolynomial string `json:"chunker_polynomial"`
}

// Init creates the repository and returns its id.
func (r Repo) Init(ctx context.Context) (string, error) {
	if _, err := r.run(ctx, nil, true, "init", "--repository-version", "2"); err != nil {
		return "", err
	}
	c, err := r.Config(ctx)
	if err != nil {
		return "", err
	}
	return c.ID, nil
}

// Config reads (and so authenticates with the password) the repository config. It doesn't wait out
// restic's retries: a destination that doesn't answer now is reported now.
func (r Repo) Config(ctx context.Context) (*Config, error) {
	out, err := r.run(ctx, nil, true, "cat", "config", "--no-lock")
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(out, &c); err != nil {
		return nil, fmt.Errorf("restic config: %w", err)
	}
	return &c, nil
}

// BackupOptions for one snapshot.
type BackupOptions struct {
	Dir           string // working directory; paths are relative to it (stable snapshot trees)
	Paths         []string
	Tags          []string
	Host          string
	Time          time.Time
	ExcludeFile   string
	ExcludeCaches bool
	// ReadConcurrency is how many files restic reads at once (0 = restic's 2).
	ReadConcurrency int
	// IgnoreInode and IgnoreCtime make restic judge a file unchanged by its path, size and modification time alone:
	// for trees copied afresh each time (the copy driver keeps modification times, never inodes or ctimes), so an
	// unchanged file isn't read again.
	IgnoreInode bool
	IgnoreCtime bool
}

// Summary is restic's backup summary.
type Summary struct {
	SnapshotID          string  `json:"snapshot_id"`
	FilesNew            int64   `json:"files_new"`
	FilesChanged        int64   `json:"files_changed"`
	FilesUnmodified     int64   `json:"files_unmodified"`
	DataAdded           int64   `json:"data_added"`
	DataAddedPacked     int64   `json:"data_added_packed"`
	TotalFilesProcessed int64   `json:"total_files_processed"`
	TotalBytesProcessed int64   `json:"total_bytes_processed"`
	TotalDuration       float64 `json:"total_duration"`
}

// BackupError is a per-file error restic reported (the snapshot is still written, exit code 3).
type BackupError struct {
	Item  string `json:"item"`
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

// Backup creates one snapshot. Any per-file read error fails the backup (a checkpoint with holes is
// not a checkpoint) — the snapshot restic wrote anyway is reported in the error.
func (r Repo) Backup(ctx context.Context, o BackupOptions) (*Summary, error) {
	sum, err := r.backup(ctx, o)
	if errors.Is(err, ErrLocked) && ctx.Err() == nil {
		// Another restic's lock outlasted the wait, most often one left by a check or a prune that was killed: its
		// stale locks go, and one more try.
		if uerr := r.Unlock(ctx); uerr == nil {
			sum, err = r.backup(ctx, o)
		}
	}
	return sum, err
}

func (r Repo) backup(ctx context.Context, o BackupOptions) (*Summary, error) {
	args := []string{"backup", "--json", "--one-file-system"}
	for _, t := range o.Tags {
		args = append(args, "--tag", t)
	}
	if o.Host != "" {
		args = append(args, "--host", o.Host)
	}
	if !o.Time.IsZero() {
		args = append(args, "--time", o.Time.Local().Format("2006-01-02 15:04:05"))
	}
	if o.ExcludeFile != "" {
		args = append(args, "--exclude-file", o.ExcludeFile)
	}
	if o.ExcludeCaches {
		args = append(args, "--exclude-caches")
	}
	if o.ReadConcurrency > 0 {
		args = append(args, "--read-concurrency", strconv.Itoa(o.ReadConcurrency))
	}
	if o.IgnoreInode {
		args = append(args, "--ignore-inode")
	}
	if o.IgnoreCtime {
		args = append(args, "--ignore-ctime")
	}
	args = append(args, "--")
	args = append(args, o.Paths...)
	full := r.args(args)
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(cctx, r.bin(), full...)
	cmd.Env = r.env()
	cmd.SysProcAttr = detached()
	cmd.Cancel = terminate(cmd)
	cmd.Dir = o.Dir
	cmd.WaitDelay = 10 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	errb := &retryWatch{stop: cancel}
	cmd.Stderr = errb
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var sum *Summary
	var fileErrs []string
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		var probe struct {
			MessageType string `json:"message_type"`
		}
		if json.Unmarshal(line, &probe) != nil {
			continue
		}
		switch probe.MessageType {
		case "summary":
			var s Summary
			if json.Unmarshal(line, &s) == nil {
				sum = &s
			}
		case "error":
			var be BackupError
			if json.Unmarshal(line, &be) == nil {
				fileErrs = append(fileErrs, be.Item+": "+be.Error.Message)
			}
		}
	}
	werr := cmd.Wait()
	if werr != nil || len(fileErrs) > 0 {
		code := -1
		var ee *exec.ExitError
		if errors.As(werr, &ee) {
			code = ee.ExitCode()
		}
		if ctx.Err() != nil && !errb.gaveUp() {
			return sum, fmt.Errorf("restic backup: %w", ctx.Err())
		}
		msg := errb.String()
		if len(fileErrs) > 0 {
			n := len(fileErrs)
			if n > 5 {
				fileErrs = fileErrs[:5]
			}
			msg = fmt.Sprintf("%d unreadable item(s): %s; %s", n, strings.Join(fileErrs, "; "), msg)
		}
		return sum, &Error{Args: args, Code: code, Stderr: r.Redact(msg), Kind: classify(code, errb.String())}
	}
	if sum == nil || sum.SnapshotID == "" {
		return nil, fmt.Errorf("restic backup: no summary")
	}
	return sum, nil
}

// Snapshot is a restic snapshot.
type Snapshot struct {
	ID       string    `json:"id"`
	ShortID  string    `json:"short_id"`
	Time     time.Time `json:"time"`
	Tree     string    `json:"tree"`
	Paths    []string  `json:"paths"`
	Hostname string    `json:"hostname"`
	Tags     []string  `json:"tags"`
	// Summary is what `restic backup` recorded in the snapshot (restic 0.17 and later; nil before).
	Summary *SnapshotSummary `json:"summary,omitempty"`
}

// SnapshotSummary is the part of a snapshot's summary the list shows.
type SnapshotSummary struct {
	DataAdded           int64 `json:"data_added"`
	DataAddedPacked     int64 `json:"data_added_packed"`
	TotalBytesProcessed int64 `json:"total_bytes_processed"`
}

// Tag returns the value of the first tag with prefix.
func (s Snapshot) Tag(prefix string) string {
	for _, t := range s.Tags {
		if strings.HasPrefix(t, prefix) {
			return strings.TrimPrefix(t, prefix)
		}
	}
	return ""
}

// Snapshots lists snapshots (optionally filtered by tag).
func (r Repo) Snapshots(ctx context.Context, tag string) ([]Snapshot, error) {
	args := []string{"snapshots", "--json", "--no-lock"}
	if tag != "" {
		args = append(args, "--tag", tag)
	}
	out, err := r.Run(ctx, nil, args...)
	if err != nil {
		return nil, err
	}
	var s []Snapshot
	if err := json.Unmarshal(out, &s); err != nil {
		return nil, fmt.Errorf("restic snapshots: %w", err)
	}
	return s, nil
}

// Dump writes one file of a snapshot to w.
func (r Repo) Dump(ctx context.Context, snapshot, path string, w io.Writer) error {
	_, err := r.Run(ctx, w, "dump", "--no-lock", snapshot, "/"+strings.TrimPrefix(path, "/"))
	return err
}

// DumpBytes reads one (small) file of a snapshot.
func (r Repo) DumpBytes(ctx context.Context, snapshot, path string) ([]byte, error) {
	var b bytes.Buffer
	err := r.Dump(ctx, snapshot, path, &b)
	return b.Bytes(), err
}

// Restore restores a snapshot into target; verify re-reads every restored file against the repository.
func (r Repo) Restore(ctx context.Context, snapshot, target string, verify bool) error {
	args := []string{"restore", "--no-lock", snapshot, "--target", target}
	if verify {
		args = append(args, "--verify")
	}
	_, err := r.Run(ctx, io.Discard, args...)
	return err
}

// RestoreOnly restores the paths include names (each with everything below it) of a snapshot into target, without
// reading the files back (restic authenticates every blob it decrypts).
func (r Repo) RestoreOnly(ctx context.Context, snapshot, target string, include []string) error {
	args := []string{"restore", "--no-lock", snapshot, "--target", target}
	for _, p := range include {
		args = append(args, "--include", p)
	}
	_, err := r.Run(ctx, io.Discard, args...)
	return err
}

// Check runs `restic check`; readData "" = structure only, "all" = every pack, otherwise a subset
// ("10%", "1/5", "500M").
func (r Repo) Check(ctx context.Context, readData string) (string, error) {
	args := []string{"check"}
	if r.CheckWithCache && !r.NoCache {
		args = append(args, "--with-cache")
	}
	switch readData {
	case "":
	case "all":
		args = append(args, "--read-data")
	default:
		args = append(args, "--read-data-subset", readData)
	}
	var out bytes.Buffer
	_, err := r.unlocked(ctx, &out, args...)
	var re *Error
	if errors.As(err, &re) {
		re.Stderr = r.Redact(out.String()) + re.Stderr
	}
	return out.String(), err
}

// Copy copies snapshots (all when ids is empty) of the repository at from into r (`restic copy`), from opened with
// fromPasswordFile. Copied snapshots keep their tags, host and time; restic skips those already there.
func (r Repo) Copy(ctx context.Context, from, fromPasswordFile string, ids ...string) error {
	args := append([]string{"copy", "--from-repo", from, "--from-password-file", fromPasswordFile}, ids...)
	_, err := r.unlocked(ctx, io.Discard, args...)
	return err
}

// Forget removes the snapshots tagged tag that keep (restic's --keep-* flags) doesn't keep, across hosts and
// paths (a replacement's checkpoints have another host), and prunes what nothing names any more.
func (r Repo) Forget(ctx context.Context, tag string, keep []string) (string, error) {
	args := append([]string{"forget", "--tag", tag, "--group-by", "", "--prune"}, keep...)
	var out bytes.Buffer
	_, err := r.unlocked(ctx, &out, args...)
	return out.String(), err
}

// StoredSize is the size of the data the repository's snapshots reference as it is stored, compressed and
// deduplicated (`restic stats --mode raw-data`): what the space limit is measured against where the box can't
// list the destination's files itself.
func (r Repo) StoredSize(ctx context.Context) (int64, error) {
	out, err := r.Run(ctx, nil, "stats", "--mode", "raw-data", "--json", "--no-lock")
	if err != nil {
		return 0, err
	}
	var s struct {
		TotalSize int64 `json:"total_size"`
	}
	if err := json.Unmarshal(out, &s); err != nil {
		return 0, fmt.Errorf("restic stats: %w", err)
	}
	return s.TotalSize, nil
}
